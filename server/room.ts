// 房间：一个房间 = 一局游戏。服务器权威，状态机驱动"先收拳→公布赢家→再收行动"。
// 断线重连：成员离线不踢出，其未提交由系统随机补拳/跳过；重连带 token 恢复，数据来自持久化层。
// 内存安全：房间结束/销毁时从 rooms Map 删除自身 + 释放挂起 Promise 与大对象，避免泄漏。
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { createState, applyActions, assignSeatsRandom, assignTeams, SUDDEN_DEATH_TURN } from '../src/engine/game.js';
import { resolveRps } from '../src/engine/rps.js';
import { decide } from '../src/ai/bot.js';
import { onRedrawTie, resolvePendingEvent } from '../src/engine/events.js';
import { elementsOf, ALLOWED_ROOM_SIZES, TEAM_CONFIGS } from '../src/types.js';
import { randomThrow } from '../src/engine/duel.js';
import { getHeroData, listHeroes, skillTarget } from '../src/engine/heroes/index.js';
import { hasStatus } from '../src/engine/effects.js';
import { Storage } from './storage.js';
import { log } from './log.js';
import { dbEnabled } from './db/index.js'; // #18 Phase3：持久层开关
import { recordMatch } from './persistence.js'; // #18 Phase3：战绩/回放写入
import type { Action, Element, PlayerView, StateSnapshot } from './protocol.js';

interface Member {
  pid: number;
  heroId: string | null;
  token: string;
  socketId: string | null;
  online: boolean;
  name: string;
  isBot: boolean;
  ready: boolean;
  accountId?: string | null; // #18 Phase2：登录态（游客为 null），供 Phase3 写战绩/解锁
}

interface ThrowWait {
  needed: Set<number>;
  collected: Map<number, string>;
  alive: any[];
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ActionWait {
  needed: Set<number>;
  resolved: Map<number, Action>;   // 已确定的行动（真实提交或 AI 托管）
  hostTimers: Map<number, ReturnType<typeof setTimeout>>; // 每赢家托管计时器（destroy 必须清理，否则泄漏）
  finish: () => void;
  timer: ReturnType<typeof setTimeout>; // 硬上限兜底
}

const THROW_TIMEOUT = 15000;      // 猜拳阶段时长（客户端同步倒计时，≥15s）
const HOST_TIMEOUT = 15000;       // 赢家在线但未提交 → 15s 后自动 AI 托管
const OFFLINE_HOST_DELAY = 800;   // 离线赢家 → 短延迟后 AI 托管（避免全员干等）
const ACTION_HARD_CAP = 20000;    // 行动阶段兜底硬上限，防任何极端情况下永久阻塞
const TURN_GAP = Number(process.env.TURN_GAP || 400); // 回合之间的小间隔，便于客户端渲染（压测时可调大以降低客户端负载，不改任何规则/技能）
// 真人长局内存防线（均为纯内存策略，不改任何游戏规则/技能效果）：
// ① REPLAY_MAX_SNAPS：replayMode='all' 时只保留最近 N 回合的棋盘快照（更旧回合丢 snap 只留事件流，
//    播放器对无 snap 条目自动降级纯文字）→ 单房回放内存有硬上界，超长真人局不再随回合无界增长。
// ② IDLE_ROOM_TTL：运行中的房间全员离线后启动空转计时器，到期无人重连则 destroy + 清持久化键；
//    任一成员重连（reconnect 入口调 cancelDestroy）即取消。默认 10 分钟。
//    注：普通模式全员离线仍由 AI 托管续跑（既有行为），TTL 仅兜底"托管也推不完/沙盒无限等结算"的僵尸房。
const REPLAY_MAX_SNAPS = Math.max(1, Number(process.env.REPLAY_MAX_SNAPS || 300));
const IDLE_ROOM_TTL = Math.max(5000, Number(process.env.IDLE_ROOM_TTL || 10 * 60 * 1000));

export class Room {
  id: string;
  private io: Server;
  private storage: Storage;
  private bus: any;            // 横向扩展：归属注册表（脑裂防护用）
  private instanceId: string;
  private distributed: boolean;
  private state: any;
  private heroIds: string[] = [];
  private elementSet: string = 'five';
  private elements: string[] = elementsOf('five');
  private members = new Map<number, Member>();
  private rngState: number;    // 可序列化 RNG 内部状态（崩溃恢复/录像确定性）
  private rng: () => number;
  private running = false;
  private throwWait: ThrowWait | null = null;
  private actionWait: ActionWait | null = null;
  private actionDeadline = 0; // O3 行动阶段截止时刻（重连玩家据此补倒计时）
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private wins: Record<number, number> = {};                 // 本局胜场（积分）
  private lastThrows: Record<number, string> = {};           // 最近一回合各人出拳
  private lastResults: Record<number, 'win' | 'lose'> = {};  // 最近一回合各人输赢
  private paused = false;
  private resumeWait: (() => void) | null = null;
  private aborted = false;
  private replayLog: any[] = [];          // #18 Phase3：完整事件流回放（仅非沙盒记录）
  private replayMeta: any = null;          // 开局时初始化（roomCode/mode/elementSet/startedAt）
  private replayPrevLogLen = 0;            // 上一回合末 state.log 长度，用于增量捕获本回合日志
  // 容量优化开关（env REPLAY_MODE）：all=每回合存完整棋盘快照(现状/最占内存)；final=只存回合事件流不存快照；
  // off=不存回放。默认 all，保持 Phase4 回放功能不变。仅影响内存与录制保真度，绝不改变任何游戏规则/技能效果。
  private replayMode: 'all' | 'final' | 'off' = (process.env.REPLAY_MODE === 'final' || process.env.REPLAY_MODE === 'off') ? process.env.REPLAY_MODE : 'all';
  private fencedOut = false;   // 被其他实例夺权 → 中止本地循环
  private keepStorage = false; // fence-out 时保留存储归新主人
  sandbox = false;            // 测试沙盒：无猜拳 + 一人操控全部英雄（public 供入口读取）
  config = { playerCount: 10, teamStr: '' as string | null, fightMode: 'open' as 'open' | 'secret' };
  onDestroyed?: () => void;

  constructor(id: string, io: Server, storage: Storage, bus?: any, instanceId?: string, elementSet: string = 'five') {
    this.id = id;
    this.io = io;
    this.storage = storage;
    this.bus = bus;
    this.instanceId = instanceId ?? '';
    this.elementSet = elementSet;
    this.elements = elementsOf(elementSet);
    this.distributed = !!(bus && bus.distributed);
    // 可序列化 RNG（mulberry32）：状态存于 rngState，恢复时还原即可续接随机序列
    this.rngState = (Math.floor(Math.random() * 1e9)) >>> 0;
    this.rng = () => {
      this.rngState = (this.rngState + 0x6d2b79f5) | 0;
      let a = this.rngState; a |= 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  setSandbox(b: boolean) { this.sandbox = !!b; }
  setConfig(cfg: { playerCount?: number; teamStr?: string | null; fightMode?: 'open' | 'secret' }) {
    if (this.state) return; // 开战后不可改
    if (cfg.playerCount != null && cfg.playerCount >= 2 && cfg.playerCount <= 12) this.config.playerCount = cfg.playerCount;
    if (cfg.teamStr !== undefined) this.config.teamStr = cfg.teamStr || null;
    if (cfg.fightMode === 'open' || cfg.fightMode === 'secret') this.config.fightMode = cfg.fightMode;
    this.emitRoomState();
  }

  // ---------- 成员管理 ----------
  addMember(heroId: string | null = null, name?: string, isBot = false, accountId: string | null = null): { pid: number; token: string } | { error: string } {
    if (this.state) return { error: '游戏已开始，无法加入' }; // O7 防开挂：开战后禁止中途加入（会破坏座次/状态索引一致性）
    const newSize = this.members.size + 1;
    if (newSize > (this.sandbox ? 12 : this.config.playerCount)) return { error: `房间人数上限为 ${this.config.playerCount} 人` };
    if (newSize > 12) return { error: '房间人数已满（最多12人）' };
    const pid = this.members.size;
    const token = randomUUID();
    const heroName = heroId ? (getHeroData(heroId)?.name ?? heroId) : null;
    this.members.set(pid, { pid, heroId: heroId ?? null, token, socketId: null, online: false, name: name || heroName || ('玩家' + pid), isBot, ready: !!heroId, accountId: accountId ?? null });
    return { pid, token };
  }
  // 房主加机器人：未指定英雄则挑一个未被占用的（保证英雄唯一）
  // 普通模式禁相同英雄；沙盒模式允许多个相同英雄（测试用）
  addBot(heroId?: string | null): { pid: number; token: string } | { error: string } {
    const hid = heroId || this.pickFreeHero();
    if (!hid) return { error: '英雄已全部被占用' };
    if (!getHeroData(hid)) return { error: '未知英雄' };
    // 普通模式：禁止出现相同英雄
    if (!this.sandbox) {
      const used = new Set([...this.members.values()].map((m) => m.heroId).filter(Boolean));
      if (used.has(hid)) return { error: '该英雄已被占用' };
    }
    const r = this.addMember(hid, getHeroData(hid)?.name ?? hid, true);
    this.emitRoomState();
    return r;
  }
  // 挑选一个尚未被任何成员占用的英雄
  pickFreeHero(): string | null {
    const used = new Set([...this.members.values()].map((m) => m.heroId).filter(Boolean) as string[]);
    const free = (listHeroes() || []).map((h: any) => h.id).filter((id: string) => !used.has(id));
    if (!free.length) return null;
    return free[Math.floor(this.rng() * free.length)];
  }
  // 房内改元素集（仅开局前），广播给全员
  setElement(set: string): boolean {
    if (this.state) return false;
    if (!['five', 'three'].includes(set)) return false;
    this.elementSet = set;
    this.elements = elementsOf(set);
    this.emitRoomState();
    return true;
  }
  // 房内选英雄（开局前），强制唯一
  chooseHero(token: string, heroId: string): { ok: true } | { error: string } {
    const m = this.memberByToken(token);
    if (!m) return { error: 'token 无效' };
    if (!getHeroData(heroId)) return { error: '未知英雄' };
    for (const o of this.members.values()) {
      if (o.pid !== m.pid && o.heroId === heroId) return { error: '该英雄已被占用' };
    }
    m.heroId = heroId; m.ready = true; m.name = getHeroData(heroId)?.name ?? m.name;
    this.emitRoomState();
    return { ok: true };
  }
  // 房主移除成员（选错机器人可取消）；只允许移除机器人（或自己），并重建索引保持 pid 连续
  removeMember(token: string, pid: number): { ok: true } | { error: string } {
    if (this.state) return { error: '游戏已开始，无法移除成员' }; // O7 防开挂：开战后禁止移除（重建索引会破坏 state.players 对应关系）
    const me = this.memberByToken(token);
    if (!me) return { error: 'token 无效' };
    const target = this.members.get(pid);
    if (!target) return { error: '成员不存在' };
    if (!target.isBot && me.pid !== pid) return { error: '只能移除机器人' };
    const rest = [...this.members.values()].filter((m) => m.pid !== pid);
    this.members.clear();
    rest.forEach((m, i) => { m.pid = i; this.members.set(i, m); });
    this.emitRoomState();
    return { ok: true };
  }
  private emitRoomState() {
    if (this.state) return; // 游戏已开始，不再发房间状态
    const members = [...this.members.values()].map((m) => ({ pid: m.pid, heroId: m.heroId, name: m.name, isBot: m.isBot, online: m.online }));
    const chosen = members.filter((m) => m.heroId).length;
    this.emit('roomState', { roomId: this.id, hostPid: 0, elementSet: this.elementSet, sandbox: this.sandbox, members, canStart: this.sandbox ? chosen >= 1 : chosen >= 2, playerCount: this.config.playerCount, teamStr: this.config.teamStr, fightMode: this.config.fightMode });
  }
  roomState() {
    const members = [...this.members.values()].map((m) => ({ pid: m.pid, heroId: m.heroId, name: m.name, isBot: m.isBot, online: m.online }));
    const chosen = members.filter((m) => m.heroId).length;
    return { roomId: this.id, hostPid: 0, elementSet: this.elementSet, sandbox: this.sandbox, members, canStart: this.sandbox ? chosen >= 1 : chosen >= 2, playerCount: this.config.playerCount, teamStr: this.config.teamStr, fightMode: this.config.fightMode };
  }
  memberByToken(token: string): Member | undefined {
    for (const m of this.members.values()) if (m.token === token) return m;
    return undefined;
  }
  attachSocket(token: string, socketId: string): Member | undefined {
    const m = this.memberByToken(token);
    if (!m) return undefined;
    m.socketId = socketId;
    m.online = true;
    // 空转兜底保险：运行中有人回来即取消 IDLE_ROOM_TTL 计时器（运行期 ttlTimer 仅此一个用途，
    // 结束后的宽限期计时由 reconnect 入口的 cancelDestroy 处理，行为不变）。
    if (this.running) this.cancelDestroy();
    if (this.state) this.emit('memberStatus', { pid: m.pid, online: true });
    // 重连回来若正处于行动阶段且轮到他、托管计时器还在跑 → 取消计时器，让他用真实意图行动
    if (this.actionWait && this.actionWait.needed.has(m.pid) && !this.actionWait.resolved.has(m.pid)) {
      const ht = this.actionWait.hostTimers.get(m.pid);
      if (ht) { clearTimeout(ht); this.actionWait.hostTimers.delete(m.pid); }
    }
    return m;
  }
  detachSocket(socketId: string) {
    for (const m of this.members.values()) {
      if (m.socketId === socketId) {
        m.online = false; m.socketId = null;
        if (this.state) this.emit('memberStatus', { pid: m.pid, online: false });
        // 出拳阶段掉线：立即用随机拳补齐，避免傻等整段超时（全员离线则直接结束收拳）
        if (this.throwWait && this.throwWait.needed.has(m.pid) && !this.throwWait.collected.has(m.pid)) {
          const tw = this.throwWait;
          tw.collected.set(m.pid, randomThrow(this.rng, this.elements));
          if ([...tw.needed].every((id) => tw.collected.has(id))) tw.resolve();
        }
      }
    }
    // 全员离线的清理策略（重连入口会 cancelDestroy，任何人回来即取消）：
    // - 未运行（大厅/已结束宽限期）：短延迟 15s 销毁，防泄漏（既有行为）；
    // - 运行中：不打断 AI 托管续跑（既有行为），但挂 IDLE_ROOM_TTL 空转兜底——
    //   沙盒房无托管计时器会无限等结算、极端僵持局也可能推不完，到期无人回来则销毁并清持久化键。
    if (!this.aborted && [...this.members.values()].every((x) => !x.online)) {
      if (!this.running) this.scheduleDestroy(15000);
      else this.scheduleDestroy(IDLE_ROOM_TTL);
    }
  }
  memberList() {
    return [...this.members.values()].map((m) => ({ pid: m.pid, heroId: m.heroId, name: m.name, isBot: m.isBot, online: m.online }));
  }

  // ---------- 开局 ----------
  // opts.mode: 'free'（乱斗，默认）| 'team'（组队）
  // opts.teamConfig: 组队配置字符串（如 '33'/'222'），仅 team 模式需要
  startGame(opts: { mode?: string; teamConfig?: string } = {}): boolean {
    if (![...this.members.values()].every((m) => m.heroId)) return false; // 还有人没选英雄
    const size = this.members.size;
    if (this.running || this.aborted) return false;
    // 沙盒：1..12 人即可，固定乱斗；普通：人数白名单（含禁11人）
    if (this.sandbox) {
      if (size < 1 || size > 12) return false;
    } else if (!ALLOWED_ROOM_SIZES.includes(size)) return false;
    const mode = this.sandbox ? 'free' : (opts.mode === 'team' ? 'team' : 'free');
    const teamConfig = opts.teamConfig;
    if (mode === 'team') {
      const cfgs = TEAM_CONFIGS[size];
      if (!cfgs || !teamConfig || !cfgs.includes(teamConfig)) return false; // 该人数不支持此组队配置
    }
    this.heroIds = [...this.members.values()].map((m) => m.heroId as string);
    this.wins = {}; for (const m of this.members.values()) this.wins[m.pid] = 0;
    this.lastThrows = {}; this.lastResults = {};
    this.state = createState(this.heroIds, Math.floor(this.rng() * 1e9), mode, this.elementSet);
    assignSeatsRandom(this.state, this.rng); // 战前准备：随机分座次（整局固定）
    if (mode === 'team' && teamConfig) assignTeams(this.state, teamConfig); // 按座次切片分队
    this.running = true;
    if (!this.sandbox) {
      // #18 Phase3：初始化回放元数据（沙盒为测试用途，不记录回放/战绩）
      this.replayMeta = { roomCode: this.id, mode: this.state.mode, elementSet: this.elementSet, startedAt: Date.now() };
      this.replayLog = [];
      this.replayPrevLogLen = 0;
    }
    this.emit('gameStart', { snapshot: this.snapshot() });
    this.runLoop().catch((e) => console.error(`[room ${this.id}] runLoop error`, e));
    return true;
  }

  private async runLoop() {
    while (this.running && !this.aborted && this.state.phase !== 'over') {
      if (this.paused) await this.waitResume();
      await this.runRound();
      if (this.state.phase === 'over' || this.aborted) break;
      if (this.paused) await this.waitResume();
      await new Promise((r) => setTimeout(r, TURN_GAP));
      if (this.aborted) break;
    }
    if (this.aborted) return; // 被销毁，不做收尾（destroy 已清理）
    // 游戏结束
    this.emit('gameOver', { winner: this.state.winner, snapshot: this.snapshot() });
    await this.persist();
    // #18 Phase3：写入战绩统计 + 完整事件流回放（沙盒不记录）；失败仅记日志，不影响房间销毁。
    if (!this.sandbox) {
      try { await this.recordMatchResult(); } catch (e) { log.error('record_match_fail', { room: this.id, err: (e as Error).message }); }
    }
    this.running = false;
    // 缓存泄漏防护：结束后给宽限期，期间可重连观战；全员离线则提前清理
    const allOffline = [...this.members.values()].every((m) => !m.online);
    this.scheduleDestroy(allOffline ? 30000 : 5 * 60 * 1000);
  }

  private async runRound() {
    // P14 脑裂防护：分布式下每回合校验仍归属本实例；被夺权则中止，交出新主人
    if (this.distributed && await this.checkFence()) { this.aborted = true; this.running = false; this.yieldToOwner(); return; }
    const alive = this.state.players.filter((p: any) => !p.dead);
    const roundTurn = this.state.turn; // 本回合编号（applyActions 末尾会自增，需先捕获）

    // #B1 猝死：超过阈值回合进入猝死（伤害翻倍、工事不再自愈），保证对局必然收敛。
    // 引擎路径 advanceRound 已在 game.js 同源处理；此处为联网服路径补同等判断（此前遗漏 → 线上永不猝死）。
    if (this.state.turn > SUDDEN_DEATH_TURN) this.state.suddenDeath = true;

    // ---- 阶段一：猜拳（含重猜循环）----（沙盒模式跳过：无猜拳，全员皆为行动者）
    let redraws = 0;
    let winnersPids: number[] = [];
    let finalThrows: string[] = [];
    let finalRes: any = null;
    if (this.sandbox) {
      winnersPids = alive.map((p: any) => p.id);
      finalThrows = alive.map(() => '—'); // 沙盒无出拳
    } else {
      while (redraws < 6) {
        let throws = await this.collectThrows(alive);
        if (this.aborted) return;
        // #B2 元素暴走：上一回合 E3(元素暴走) 抽中后设下的标记，作用于"本回合"首次收拳 → 全员强制随机元素，
        // 随后立即消费（置 false），使客户端"元素暴走"横幅仅出现在抽中该事件的回合（roundResult 发出前已复位，不泄漏）。
        // 重猜本就全员随机，故 redraws>0 无需再处理。
        // 此前 collectThrows 从不读该标记、且 runRound 从不复位 → E3 在线上完全无效且标记永久泄漏。
        if (this.state.forceRandomNext && redraws === 0) {
          throws = alive.map(() => randomThrow(this.rng, this.elements));
          this.state.forceRandomNext = false;
        }
        finalThrows = throws;
        const res = resolveRps(throws, this.elements);
        if (!res.redraw) {
          finalRes = res;
          winnersPids = res.winners.map((i: number) => alive[i].id);
          break;
        }
        // 重猜：抽定随机事件（只抽一次，内容待分出胜负后才公布）
        const log = (m: string) => this.state.log.push(m);
        onRedrawTie(this.state, this.rng);
        if (this.state.pendingEvent != null) {
          this.emit('eventAnnounce', { turn: this.state.turn });
          log('平局！接下来会有随机事件');
        }
        redraws++;
      }
      // 重猜后分出胜负 → 公布具体内容并执行（只触发一次）
      if (this.state.pendingEvent != null) {
        const log = (m: string) => this.state.log.push(m);
        const ev = resolvePendingEvent(this.state, this.rng, log);
        if (ev) this.emit('eventReveal', { id: ev.id, name: ev.name, turn: this.state.turn });
      }
    }
    winnersPids = winnersPids.filter((id: number) => !hasStatus(this.state.players[id], 'anaesthetized'));

    // 本回合结算广播：每个人出了什么、输赢、积分
    const throwMap: Record<number, string> = {};
    const resultMap: Record<number, 'win' | 'lose'> = {};
    alive.forEach((p: any, i: number) => {
      throwMap[p.id] = finalThrows[i] ?? '?';
      resultMap[p.id] = (finalRes && finalRes.winners.includes(i)) ? 'win' : 'lose';
    });
    // 沙盒模式：全员行动，结算横幅展示为"全员行动"
    if (this.sandbox) alive.forEach((p: any) => { throwMap[p.id] = '—'; resultMap[p.id] = 'win'; });
    this.lastThrows = throwMap;
    this.lastResults = resultMap;
    for (const id of winnersPids) this.wins[id] = (this.wins[id] || 0) + 1;
    // 事件/环境效果快照：在 applyActions 之前取，客户端据此显示提示条（含被跳过的太平轮休）。
    const jailedPids = this.state.players.filter((p: any) => hasStatus(p, 'jailed')).map((p: any) => p.id);
    const fortDisabledPids = this.state.players.filter((p: any) => hasStatus(p, 'fortDisabled')).map((p: any) => p.id);
    const roundEvents = {
      forceRandomNext: !!this.state.forceRandomNext,
      skipActionsThisRound: !!this.state.skipActionsThisRound,
      mirrorPair: this.state.mirrorPair || null,
      pendingEvent: this.state.pendingEvent ?? null,
      lastEvent: this.state.lastEvent ?? null,
      jailed: jailedPids,
      fortDisabled: fortDisabledPids,
    };
    this.emit('roundResult', {
      turn: this.state.turn, throws: throwMap, results: resultMap, winners: winnersPids,
      events: roundEvents,
    });

    // ---- 阶段二：行动（先公布赢家，赢家再提交行动）----
    let actions = new Map<number, Action>();
    if (winnersPids.length > 0 && !this.state.skipActionsThisRound) {
      this.emit('winners', { winners: winnersPids });
      this.actionDeadline = Date.now() + HOST_TIMEOUT; // O3 记录行动阶段截止时刻
      this.emit('actionPhase', { winners: winnersPids, snapshot: this.snapshot(), deadline: this.actionDeadline });
      actions = await this.collectActions(winnersPids);
      if (this.aborted) return;
    }

    // ---- 结算（纯引擎，服务器权威）----
    // lastRoundWon（驱动 upkeep 产出）的归属已收敛到 applyActions 单一真相源（与 advanceRound 一致，#10 修复），
    // 此处不再手动设置，避免两套逻辑漂移。沙盒模式通过 opts.sandbox 传递。
    const actionObj: any = {};
    for (const [k, v] of actions) actionObj[k] = v;
    if (process.env.DEBUG) { const sumHp = this.state.players.reduce((s:number,p:any)=>s+p.hp,0); const aliveC = this.state.players.filter((p:any)=>!p.dead).length; console.log(`[room ${this.id}] T${this.state.turn} W=${winnersPids.length} A=${actions.size} R=${redraws} alive=${aliveC} sumHp=${sumHp}`); }
    applyActions(this.state, winnersPids, actionObj, this.rng, { sandbox: this.sandbox });

    // #18 Phase3：捕获本回合完整事件流（仅非沙盒的真实对局记录回放）
    if (!this.sandbox && this.replayMode !== 'off') {
      // Phase4 回放播放器：每回合额外存一份棋盘快照（结算后状态），供前端可视化逐步回放。
      // 旧回放(无 snap 字段)在播放器里自动退化成纯文字事件流。快照为只读视图，不改任何游戏规则。
      // 容量优化：replayMode='final' 时只存回合事件流(无快照)，'off' 时整段跳过——大幅降低单房常驻内存。
      const entry: any = {
        turn: roundTurn,
        throws: throwMap, results: resultMap, winners: winnersPids,
        events: roundEvents,
        actions: actionObj,
        log: this.state.log.slice(this.replayPrevLogLen),
      };
      if (this.replayMode === 'all') entry.snap = this.snapshot();
      this.replayLog.push(entry);
      // 滑动窗口硬上界：只保留最近 REPLAY_MAX_SNAPS 回合的棋盘快照，更旧回合丢 snap 只留事件流
      // （事件流很小；播放器对无 snap 条目自动降级纯文字回放）。O(1) 摊销，超长真人局单房内存有硬上界。
      if (this.replayMode === 'all' && this.replayLog.length > REPLAY_MAX_SNAPS) {
        const old = this.replayLog[this.replayLog.length - 1 - REPLAY_MAX_SNAPS];
        if (old && old.snap) delete old.snap;
      }
      this.replayPrevLogLen = this.state.log.length;
    }

    await this.persist();
    this.emit('state', { snapshot: this.snapshot(), log: this.state.log.slice(-12), turn: this.state.turn });
  }

  // ---------- 收拳 ----------
  private collectThrows(alive: any[]): Promise<string[]> {
    return new Promise((resolve) => {
      // 通知客户端本轮开始收拳（每次重猜重发，客户端需重新提交）
      this.emit('roundStart', { turn: this.state.turn, alive: alive.map((p: any) => p.id), deadline: Date.now() + THROW_TIMEOUT });
      const needed = new Set(alive.map((p: any) => p.id));
      const collected = new Map<number, string>();
      // 离线成员由系统随机补拳（"系统判定随机猜拳"）；O6 被麻醉者同样走随机拳，
      // 与引擎路径 advanceRound 语义统一（麻醉=失去自主出拳能力），主动提交将被忽略。
      for (const p of alive) {
        const m = this.members.get(p.id);
        if (!m || !m.online || hasStatus(p, 'anaesthetized')) collected.set(p.id, randomThrow(this.rng, this.elements));
      }
      const check = () => {
        if (needed.size === 0 || [...needed].every((id) => collected.has(id))) finish();
      };
      const finish = () => {
        if (this.throwWait) { clearTimeout(this.throwWait.timer); this.throwWait = null; }
        resolve(alive.map((p: any) => collected.get(p.id) ?? randomThrow(this.rng)));
      };
      const timer = setTimeout(finish, THROW_TIMEOUT);
      this.throwWait = { needed, collected, alive, resolve: finish, timer };
      check(); // 若全是离线，立即结束
    });
  }
  onThrow(token: string, element: Element) {
    if (typeof element !== 'string') return;
    const m = this.memberByToken(token);
    if (!m || !this.throwWait) return;
    const w = this.throwWait;
    if (!w.needed.has(m.pid) || w.collected.has(m.pid)) return;
    // O6 被麻醉者出拳由系统随机决定，忽略其主动提交（与引擎路径一致）
    const pl = this.state.players[m.pid];
    if (pl && hasStatus(pl, 'anaesthetized')) return;
    if (!this.elements.includes(element as any)) return; // 防开挂：非法元素直接忽略
    w.collected.set(m.pid, element);
    if ([...w.needed].every((id) => w.collected.has(id))) w.resolve();
  }

  // ---------- 收行动（含挂机自动 AI 托管）----------
  private collectActions(winners: number[]): Promise<Map<number, Action>> {
    return new Promise((resolve) => {
      const resolved = new Map<number, Action>();
      const hostTimers = new Map<number, ReturnType<typeof setTimeout>>();
      const isOffline = (id: number) => { const m = this.members.get(id); return !m || !m.online; };
      const tryFinish = () => { if (winners.length === 0 || winners.every((id) => resolved.has(id))) finish(); };
      // 托管：到时未提交则执行动作。沙盒模式默认"跳过"（由测试者显式操控）；普通模式用保守 AI。
      const host = (id: number, delay: number) => {
        const t = setTimeout(() => {
          if (!resolved.has(id)) {
            const act: Action = this.sandbox ? { type: 'pass' } : this.aiAction(id);
            resolved.set(id, act);
            log.info('ai_host', { room: this.id, pid: id, sandbox: this.sandbox, reason: this.sandbox ? 'sandbox_timeout' : (isOffline(id) ? 'offline' : 'timeout') });
            tryFinish();
          }
        }, delay);
        hostTimers.set(id, t);
      };
      for (const id of winners) {
        // 沙盒模式：不挂自动托管计时器，无限等待房主显式「结算」提交（避免误自动推进）；
        // 普通模式：在线赢家 15s 超时 / 离线赢家短延迟 后由保守 AI 托管。
        if (this.sandbox) continue;
        host(id, isOffline(id) ? OFFLINE_HOST_DELAY : HOST_TIMEOUT);
      }
      const finish = () => {
        if (this.actionWait) {
          clearTimeout(this.actionWait.timer);
          for (const t of hostTimers.values()) clearTimeout(t);
          this.actionWait = null;
        }
        resolve(resolved);
      };
      const timer = setTimeout(finish, ACTION_HARD_CAP); // 兜底硬上限，绝不允许永久阻塞
      this.actionWait = { needed: new Set(winners), resolved, hostTimers, finish, timer };
      tryFinish(); // winners 为空时立即结束
    });
  }
  onAction(token: string, playerId: number | undefined, action: Action) {
    const m = this.memberByToken(token);
    if (!m || !this.actionWait) return;
    // 运行时 schema 校验（防畸形输入/开挂）
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return;
    if (action.target != null && typeof action.target !== 'number') return;
    if (action.skillId != null && typeof action.skillId !== 'string') return;
    const w = this.actionWait;
    // 操控对象：显式 playerId 优先，否则默认 token 持有者自己
    const pid = (typeof playerId === 'number') ? playerId : m.pid;
    const actor = this.members.get(pid);
    if (!actor) return;
    if (!w.needed.has(pid) || w.resolved.has(pid)) return;
    // 普通模式：只能操控自己；沙盒模式：同一 socket 可操控任意英雄（测试用）
    if (!this.sandbox && actor.token !== token) return;
    // 防开挂：只接受合法行动类型
    if (!['attack', 'charge', 'build', 'skill', 'pass'].includes(action.type)) return;

    // 逐项校验；非法行动按 pass 解析（照常结束等待，避免回合卡死 15s），合法行动照常生效
    let legal = true;
    if (action.type === 'attack') {
      const t = action.target != null ? this.state.players[action.target] : null;
      if (!t || t.dead || action.target === pid) legal = false;
    } else if (action.type === 'skill') {
      const tgt = skillTarget(actor.heroId, action.skillId);
      if (!tgt) legal = false;
      else if (tgt === 'none') { if (action.target != null) legal = false; }
      else if (tgt === 'enemy') {
        const t = action.target != null ? this.state.players[action.target] : null;
        if (!t || t.dead || action.target === pid) legal = false;
      } else { // ally / self：可为自身或任意存活玩家（乱斗下无队友区分）
        const t = action.target != null ? this.state.players[action.target] : null;
        if (!t || t.dead) legal = false;
      }
    } else if (action.type === 'build') {
      const hero = getHeroData(actor.heroId);
      const p = this.state.players[pid];
      if (p.lanes && p.lanes.length) {
        if (p.lanes.every((l: any) => l.far && l.far.hp > 0)) legal = false; // 远位(稻草人)全满
      } else if (hero?.fort) {
        // 远近位都"存在且存活"才算满；任一槽被摧毁(或空缺)都允许重建
        const farAlive = p.fortFar && p.fortFar.hp > 0;
        const nearAlive = p.fortNear && p.fortNear.hp > 0;
        if (p.fortFar && p.fortNear && farAlive && nearAlive) legal = false;
      } else legal = false;
    } else if (action.type === 'charge') {
      const ch = this.state.players[pid].charge;
      if (typeof ch !== 'number' || ch < 0 || ch > 4) legal = false;
    }

    // 玩家真实提交 → 取消其托管计时器，改用真实意图
    const ht = w.hostTimers.get(pid); if (ht) { clearTimeout(ht); w.hostTimers.delete(pid); }
    // 非法行动按 pass 处理（避免 15s 卡死），合法行动照常
    w.resolved.set(pid, legal ? action : { type: 'pass' });
    log.debug('onAction', { room: this.id, pid, act: action.type, legal, sandbox: this.sandbox });
    if (w.needed.size > 0 && [...w.needed].every((id) => w.resolved.has(id))) w.finish();
  }
  // 挂机托管 AI：复用与自对弈同构的 bot 决策（含技能：麻醉/逮捕/建造/地道战等），
  // 异常或决策为空时回退到保守攻击/蓄力，避免傻等或自杀式攻击。
  // 注：onAction 会对返回的 action 再次校验，非法目标会自动降级为 pass，安全。
  private aiAction(pid: number): Action {
    const me: any = this.state.players[pid];
    if (!me || me.dead) return { type: 'pass' };
    try {
      const d: any = decide(this.state, pid, this.rng);
      if (d && d.action && typeof d.action.type === 'string') {
        log.info('ai_action', { room: this.id, pid, act: d.action.type });
        return d.action;
      }
    } catch (e) { log.warn('ai_action_fail', { room: this.id, pid, err: (e as Error).message }); }
    // 兜底：保守攻击/蓄力（复用原启发式）
    const enemies: any[] = this.state.players.filter((p: any) => !p.dead && p.id !== pid);
    if (enemies.length === 0) return (me.charge ?? 0) < 4 ? { type: 'charge' } : { type: 'pass' };
    const reflect = (e: any) => (e.fortFar?.effect === 'reflect_first') || (e.fortNear?.effect === 'reflect_first');
    let best: any = null, bestScore = Infinity;
    for (const e of enemies) {
      let score = e.hp;
      const fortHp = (e.fortFar?.hp || 0) + (e.fortNear?.hp || 0);
      score += fortHp * 0.6;
      if (reflect(e) && me.hp <= 3) score += 100;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best && reflect(best) && me.hp <= 3) return (me.charge ?? 0) < 4 ? { type: 'charge' } : { type: 'pass' };
    if (best) return { type: 'attack', target: best.id };
    return (me.charge ?? 0) < 4 ? { type: 'charge' } : { type: 'pass' };
  }

  // 沙盒模式：把全部成员重新挂到当前 socket（单人测试者重连后仍能操控所有英雄）
  private reattachAll(token: string) {
    const m = this.memberByToken(token);
    if (!m) return;
    for (const x of this.members.values()) {
      x.socketId = m.socketId; x.online = !!m.socketId;
      if (this.state) this.emit('memberStatus', { pid: x.pid, online: true });
    }
  }

  // ---------- 重连 ----------
  reconnect(token: string) {
    const m = this.memberByToken(token);
    if (!m) return null;
    if (this.sandbox) this.reattachAll(token); // 重连即夺回全部英雄控制权
    return {
      playerId: m.pid,
      snapshot: this.snapshot(),
      sandbox: this.sandbox,
      phase: this.throwWait ? 'rps' : this.actionWait ? 'action' : 'idle',
      awaitingYou: (this.throwWait?.needed.has(m.pid) && !this.throwWait.collected.has(m.pid)) ||
                   (this.actionWait?.needed.has(m.pid) && !this.actionWait.resolved.has(m.pid)),
      winners: this.actionWait ? [...this.actionWait.needed] : [],
      round: { throws: this.lastThrows, results: this.lastResults },
      deadline: this.actionWait ? this.actionDeadline : null, // O3 重连玩家据此补行动阶段倒计时
    };
  }

  // ---------- 暂停 / 继续 ----------
  pause(): boolean {
    if (!this.running || this.aborted || this.paused) return false;
    this.paused = true;
    this.emit('paused', { roomId: this.id });
    return true;
  }
  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    const r = this.resumeWait; this.resumeWait = null;
    this.emit('resumed', { roomId: this.id });
    if (r) r();
    return true;
  }
  private waitResume(): Promise<void> { return new Promise((res) => { this.resumeWait = res; }); }

  // ---------- 工具 ----------
  private emit(event: string, data: any) { this.io.to(`room:${this.id}`).emit(event, data); }
  isValidElement(x: any): boolean { return typeof x === 'string' && this.elements.includes(x); }

  private snapshot(): StateSnapshot {
    const players: PlayerView[] = this.state.players.map((p: any) => {
      const m = this.members.get(p.id);
      return {
        id: p.id,
        heroId: p.heroId,
        name: p.name,
        seat: p.seat,
        team: p.team,
        hp: p.hp,
        maxHp: p.maxHp,
        online: m ? m.online : false,
        dead: p.dead,
        isBot: m ? !!m.isBot : false,
        charge: p.charge,
        fortFar: p.fortFar ? { name: p.fortFar.name, hp: p.fortFar.hp, maxHp: p.fortFar.maxHp } : null,
        fortNear: p.fortNear ? { name: p.fortNear.name, hp: p.fortNear.hp, maxHp: p.fortNear.maxHp } : null,
        lanes: p.lanes ? p.lanes.map((l: any) => ({
          far: l.far ? { name: l.far.name, hp: l.far.hp, maxHp: l.far.maxHp } : null,
          near: l.near ? { name: l.near.name, hp: l.near.hp, maxHp: l.near.maxHp } : null,
        })) : null,
        resources: p.resources || {},
        anaesthetized: (p.statuses.find((s: any) => s.type === 'anaesthetized')?.turns) || 0,
        arrested: hasStatus(p, 'arrested'),
        fortDisabled: hasStatus(p, 'fortDisabled'),
        jailed: hasStatus(p, 'jailed'),
        wins: this.wins[p.id] ?? 0,
        throwEl: this.lastThrows[p.id] ?? null,
        result: this.lastResults[p.id] ?? null,
      };
    });
    return {
      turn: this.state.turn,
      phase: this.state.phase,
      mode: this.state.mode,
      winner: this.state.winner,
      suddenDeath: this.state.suddenDeath,
      lastEvent: this.state.lastEvent,
      forceRandomNext: !!this.state.forceRandomNext,
      skipActionsThisRound: !!this.state.skipActionsThisRound,
      mirrorPair: this.state.mirrorPair || null,
      pendingEvent: this.state.pendingEvent ?? null,
      elements: this.elements,
      paused: this.paused,
      players,
    };
  }

  // #18 Phase3：游戏结束时写战绩统计 + 完整事件流回放。
  // 胜负判定：乱斗模式 winner 为获胜者 pid；组队模式 winner 为获胜阵营 id；平局(null)记双方为 draw。
  private async recordMatchResult() {
    if (!dbEnabled()) return;
    const winner = this.state.winner;
    const mode = this.state.mode;
    const players: any[] = [...this.members.values()].map((m) => {
      const pstate: any = this.state.players[m.pid];
      const team = pstate ? (pstate.team ?? null) : null;
      let result: 'win' | 'loss' | 'draw';
      if (winner == null) result = 'draw';
      else if (mode === 'team') result = (team != null && team === winner) ? 'win' : 'loss';
      else result = (m.pid === winner) ? 'win' : 'loss';
      return { accountId: m.accountId ?? null, heroId: m.heroId, result };
    });
    try {
      await recordMatch({
        roomCode: this.id, mode, winner,
        players,
        durationRounds: Math.max(0, this.state.turn - 1),
        stream: this.replayLog,
      });
    } catch (e) { log.error('record_match_fail', { room: this.id, err: (e as Error).message }); }
  }

  // 每回合持久化：存引擎状态 + 成员(含 token) + 英雄序，供"进程崩溃后启动恢复"重建房间。
  private async persist() {
    if (this.fencedOut) return; // 被夺权：不写存储，避免覆盖新主人的数据
    try {
      // O2 持久化日志截断：长局 state.log 无上限增长 → 每回合全量序列化 payload 膨胀，
      // 崩溃恢复 JSON.parse 变重。存最近 200 条即可（日志仅为展示历史，截断不影响对局）。
      // 用切片副本，绝不改动运行中的 this.state.log。
      const LOG_CAP = 200;
      const stateForSave = this.state.log.length > LOG_CAP
        ? { ...this.state, log: this.state.log.slice(-LOG_CAP) }
        : this.state;
      const payload = JSON.stringify({
        v: 2,
        state: stateForSave,
        members: [...this.members.values()],
        heroIds: this.heroIds,
        wins: this.wins,
        rngState: this.rngState, // P9：携带 RNG 内部状态，恢复后续接随机序列
        lastThrows: this.lastThrows,   // #11：重连首回合可见上回合出拳
        lastResults: this.lastResults, // #11：重连首回合可见上回合输赢
        config: this.config,           // #11：恢复房间配置（人数/组队/明战暗战）
      });
      await this.storage.save('room:' + this.id, payload);
    } catch (e) { log.error('persist_fail', { room: this.id, err: (e as Error).message }); }
  }
  // 崩溃一致性恢复：从存储重建房间（成员/token/状态），未结束则恢复 runLoop 继续推进。
  async recover(): Promise<boolean> {
    try {
      const raw = await this.storage.load('room:' + this.id);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      if (!obj || !obj.state) return false;
      this.state = obj.state;
      if (typeof obj.rngState === 'number') this.rngState = obj.rngState >>> 0; // P9 还原 RNG 状态，续接随机序列
      this.elements = (this.state.elements && this.state.elements.length) ? this.state.elements : elementsOf('five'); // 恢复本局元素集（五/三元）
      this.elementSet = (this.state.elementSet) || 'five';
      this.heroIds = obj.heroIds && obj.heroIds.length ? obj.heroIds : this.state.players.map((p: any) => p.heroId);
      this.wins = (obj.wins && typeof obj.wins === 'object') ? obj.wins : {};
      this.members = new Map();
      const memArr: any[] = obj.members || [];
      for (const m of memArr) this.members.set(m.pid, { pid: m.pid, heroId: m.heroId ?? null, token: m.token, socketId: null, online: false, name: m.name || (m.heroId ? getHeroData(m.heroId)?.name ?? m.heroId : '玩家' + m.pid), isBot: !!m.isBot, ready: !!m.heroId, accountId: (m as any).accountId ?? null });
      // 旧格式只有 state 时，用 state.players 重建成员（token 重新生成，旧 token 失效需重连校验）
      if (this.members.size === 0) {
        for (const p of this.state.players) this.members.set(p.id, { pid: p.id, heroId: p.heroId, token: randomUUID(), socketId: null, online: false, name: getHeroData(p.heroId)?.name ?? p.heroId, isBot: false, ready: true });
      }
      this.running = this.state.phase !== 'over';
      // #11：恢复上回合出拳/输赢与房间配置，避免重连首回合"白屏/无历史"。
      this.lastThrows = (obj.lastThrows && typeof obj.lastThrows === 'object') ? obj.lastThrows : {};
      this.lastResults = (obj.lastResults && typeof obj.lastResults === 'object') ? obj.lastResults : {};
      if (obj.config && typeof obj.config === 'object') this.config = obj.config;
      if (this.running) {
        // 离线成员由系统随机补拳 / AI 托管自动推进；真人重连后自动接管
        this.runLoop().catch((e) => log.error('runLoop_error', { room: this.id, err: (e as Error).message }));
        log.info('room_recovered', { room: this.id, turn: this.state.turn, players: this.members.size });
      } else {
        // #11：已结束的房间恢复后仍需安排销毁，否则成僵尸房间常驻内存/存储（原只设 running=false → 永不清理）。
        // 给 5 分钟宽限，期间可重连观战/复盘，超时后 destroy 清理存储。
        log.info('room_recovered_over', { room: this.id, turn: this.state.turn, winner: this.state.winner });
        this.scheduleDestroy(5 * 60 * 1000);
      }
      return true;
    } catch (e) { log.error('recover_fail', { room: this.id, err: (e as Error).message }); return false; }
  }

  private scheduleDestroy(ms: number) {
    if (this.aborted) return;
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = setTimeout(() => this.destroy(), ms);
  }
  cancelDestroy() { if (this.ttlTimer) { clearTimeout(this.ttlTimer); this.ttlTimer = null; } }
  // P14 脑裂防护：返回 true 表示已不属于本实例，应立即停止本地推进
  private async checkFence(): Promise<boolean> {
    if (!this.distributed || this.fencedOut || !this.bus) return this.fencedOut;
    try {
      const owner = await this.bus.getOwner(this.id);
      if (owner && owner !== this.instanceId) {
        this.fencedOut = true;
        log.warn('fence_out', { room: this.id, owner, self: this.instanceId });
        return true;
      }
    } catch { /* 忽略总线错误 */ }
    return false;
  }
  // 被夺权：停止本地循环、保留共享存储（归新主人），仅从本地 rooms 移除
  private yieldToOwner() {
    this.keepStorage = true;
    this.destroy();
  }
  destroy() {
    if (this.aborted) return; // 幂等：避免重复销毁
    this.aborted = true;
    this.running = false;
    // 释放暂停等待（若有），避免协程泄漏
    if (this.resumeWait) { const r = this.resumeWait; this.resumeWait = null; try { r(); } catch { /* ignore */ } }
    // 释放所有挂起的等待（让 runLoop 从 await 退出，避免协程与 Room 泄漏）
    if (this.throwWait) { clearTimeout(this.throwWait.timer); const finish = this.throwWait.resolve; this.throwWait = null; try { finish(); } catch { /* ignore */ } }
    if (this.actionWait) {
      clearTimeout(this.actionWait.timer);
      for (const t of this.actionWait.hostTimers.values()) clearTimeout(t); // 关键：清理托管计时器，否则泄漏
      const finish = this.actionWait.finish; this.actionWait = null; try { finish(); } catch { /* ignore */ }
    }
    if (this.ttlTimer) { clearTimeout(this.ttlTimer); this.ttlTimer = null; }
    // 释放大对象引用，便于 GC
    this.state = null;
    this.members.clear();
    this.heroIds = [];
    if (!this.keepStorage) this.storage.del('room:' + this.id).catch(() => {});
    this.onDestroyed?.(); // 从 rooms Map 删除，防止 Map 无限增长
  }
}
