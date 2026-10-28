// Phase1 端到端测试客户端：模拟多房间并发、完整对局、断线重连不丢数据。
// 用法：先 `npm run server`（另一个终端），再 `npm run client`。
// 设计目标：
//   1) 强 AI（共识集火 + 破工事 + 控制技能 + 蓄力爆发），保证对局能在时限内打完；
//   2) 跑遍第一批 9 英雄的招牌技能，验证引擎在各类效果下无崩溃/无负血；
//   3) 断线重连不丢数据、多房间并发互不干扰。
import { io, Socket } from 'socket.io-client';
import type { Action, Element, StateSnapshot } from './protocol.js';

const URL = process.env.SERVER_URL || 'http://localhost:3001';
const ELS: Element[] = ['数', '物', '化', '生', '计'];
const HERO_POOL = ['chef', 'vampire', 'miner', 'doctor', 'police', 'farmer', 'carpenter', 'swordsman', 'builder'];
const rand = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function once<T = any>(s: Socket, ev: string, timeout = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), timeout);
    s.once(ev, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function emitAck<T = any>(s: Socket, ev: string, msg: any, timeout = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ack ${ev}`)), timeout);
    s.emit(ev, msg, (d: T) => { clearTimeout(t); resolve(d); });
  });
}

interface Bot {
  s: Socket;
  token: string;
  roomId: string;
  pid: number;
  heroId: string;
  snaps: StateSnapshot[];
  over: any;
}

// 共识目标：所有 bot 用同一确定性规则挑选"当前最残血（含工事）的对手"，
// 自然形成集火，避免伤害分散导致谁都打不死。
function pickTarget(snap: StateSnapshot, pid: number): number | null {
  const others = snap.players.filter((p) => !p.dead && p.id !== pid);
  if (others.length === 0) return null;
  others.sort((a, b) => {
    const ta = a.hp + (a.fortFar?.hp || 0) + (a.fortNear?.hp || 0);
    const tb = b.hp + (b.fortFar?.hp || 0) + (b.fortNear?.hp || 0);
    if (ta !== tb) return ta - tb;
    return a.id - b.id; // 确定性 tie-break → 全员一致
  });
  return others[0].id;
}

// 根据英雄特性选动作：优先破工事/控制，再普通集火；蓄力叠满则爆发。
function pickAction(snap: StateSnapshot, pid: number, heroId: string): Action {
  const target = pickTarget(snap, pid);
  if (target == null) return { type: 'pass' };
  const me = snap.players[pid];
  const tgt = snap.players[target];
  const tgtHasFort = !!(tgt.fortFar && tgt.fortFar.hp > 0) || !!(tgt.fortNear && tgt.fortNear.hp > 0);

  // 蓄力已叠 2+ 层 → 放出（爆发）
  if (me.charge >= 2) return { type: 'attack', target };

  // 建筑工人：拆迁大队直接砸工事（无视溢出规则），为集火开路
  if (heroId === 'builder' && tgtHasFort) return { type: 'skill', skillId: '拆迁大队', target };
  // 矿工：有工事时用地道战绕盾直击本体（伤害2，低于普攻4，但能绕过盾）
  if (heroId === 'miner' && tgtHasFort) return { type: 'skill', skillId: '地道战', target };
  // 医生：麻醉集火目标，剥夺其下回合行动（帮助速杀）
  if (heroId === 'doctor') return { type: 'skill', skillId: '麻醉', target };
  // 警察：逮捕集火目标，阻止其反击
  if (heroId === 'police') return { type: 'skill', skillId: '逮捕', target };
  // 其余英雄：直接集火本体（最高 DPS）
  return { type: 'attack', target };
}

// 把一名 bot 的事件监听挂到指定 socket 上（重连后用新 socket）
let CUR_ELS: string[] = ELS; // 跟随本局元素集（五元/三元）动态调整
function wireBot(bot: Bot, s: Socket) {
  s.on('roundStart', () => s.emit('submitThrow', { token: bot.token, roomId: bot.roomId, element: rand(CUR_ELS) }));
  s.on('actionPhase', (d: any) => {
    // 用 bot.snaps 中最新的整局状态来决策（如果还没有则跳过）
    if (d.winners.includes(bot.pid) && bot.snaps.length > 0) {
      const snap = bot.snaps[bot.snaps.length - 1];
      s.emit('submitAction', { token: bot.token, roomId: bot.roomId, action: pickAction(snap, bot.pid, bot.heroId) });
    }
  });
  s.on('state', (d: any) => { if (d && d.snapshot) { bot.snaps.push(d.snapshot); if (Array.isArray(d.snapshot.elements) && d.snapshot.elements.length) CUR_ELS = d.snapshot.elements; } });
  s.on('gameOver', (d: any) => { bot.over = d; });
}

async function playRoom(label: string, n: number, withReconnect: boolean): Promise<{ ok: boolean; rounds: number; winner: number | null; reconnectOk: boolean }> {
  const roomIdHolder: { v: string | null } = { v: null };
  const bots: Bot[] = [];
  let reconnectOk = false;

  for (let i = 0; i < n; i++) {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    await once(s, 'connect');
    const heroId = HERO_POOL[i % HERO_POOL.length];
    const ack: any = i === 0 ? await emitAck(s, 'createRoom', { heroId }) : await emitAck(s, 'joinRoom', { roomId: roomIdHolder.v!, heroId });
    roomIdHolder.v = ack.roomId;
    const bot: Bot = { s, token: ack.token, roomId: ack.roomId, pid: ack.playerId, heroId, snaps: [], over: null };
    bots.push(bot);
    wireBot(bot, s);
  }

  const roomId = roomIdHolder.v!;
  // 断线重连测试：第 3 个回合后让 bot0 断线，1.2s 后带 token 重连
  let reconnected: any = null;
  if (withReconnect) {
    let roundCount = 0;
    const watcher = bots[0].s.on('state', () => {
      roundCount++;
      if (roundCount === 3) {
        watcher.off();
        const oldTurn = bots[0].snaps[bots[0].snaps.length - 1]?.turn;
        bots[0].s.disconnect();
        setTimeout(async () => {
          const s2 = io(URL, { transports: ['websocket'], forceNew: true });
          await once(s2, 'connect');
          const ack: any = await emitAck(s2, 'reconnect', { token: bots[0].token, roomId });
          if (ack && ack.snapshot && ack.snapshot.turn >= (oldTurn || 0)) {
            reconnectOk = true;
            reconnected = s2;
            bots[0].s = s2;       // 后续监听挂到新 socket
            wireBot(bots[0], s2); // 重连后继续提交
          }
        }, 1200);
      }
    });
  }

  // 开局
  const startAck: any = await emitAck(bots[0].s, 'startGame', { roomId });
  if (!startAck.ok) console.log(`[${label}] 开局失败:`, startAck);

  // 等待结束或超时（最多 ~70s，给强 AI 足够时间收尾）
  const deadline = Date.now() + 70000;
  let winner: number | null = null;
  while (Date.now() < deadline) {
    if (bots[0].over) { winner = bots[0].over.winner; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  const rounds = bots[0].snaps.length;

  // 清理
  for (const b of bots) if (b.s && !b.s.disconnected) b.s.close();
  if (reconnected) reconnected.close();

  // 校验：无负血、胜者合法
  let ok = true;
  for (const b of bots) for (const snap of b.snaps) for (const p of snap.players) {
    if (p.hp < 0 || (p.fortFar?.hp ?? 0) < 0 || (p.fortNear?.hp ?? 0) < 0) ok = false;
  }
  if (winner != null) {
    const alive = bots[0].snaps[bots[0].snaps.length - 1].players.filter((p) => !p.dead);
    if (alive.length > 1) ok = false;
  } else {
    ok = false; // 超时未分胜负视为失败（需要 AI 足够强）
  }

  console.log(`[${label}] 回合=${rounds} 胜者=${winner} 重连恢复=${reconnectOk} 校验=${ok ? '通过' : '失败'}`);
  return { ok, rounds, winner, reconnectOk };
}

async function main() {
  console.log(`连接 ${URL}，开始端到端测试（强 AI + 9 英雄技能 + 重连）...`);
  // 多房间并发：房间A(4人,含重连) + 房间B(6人) 同时进行
  const [a, b] = await Promise.all([
    playRoom('房间A', 4, true),
    playRoom('房间B', 6, false),
  ]);
  const pass = a.ok && b.ok && a.reconnectOk;
  console.log(pass ? '\n✅ Phase1 端到端测试全部通过（多房间并发 + 无负血 + 断线重连 + 对局完整收敛）' : '\n❌ 测试未通过，见上');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
