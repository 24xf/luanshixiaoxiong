// 压力 / 内存泄露 / 防开挂 测试：批量房间并发 + 断线 + 非法输入 + 洪水，观察服务器内存与 rooms 回落。
// 用法：先启服务器 `DEBUG=1 PORT=3002 npx tsx server/index.ts`，再 `SERVER_URL=http://localhost:3002 npx tsx server/stress-test.ts`
import { io, Socket } from 'socket.io-client';
import * as fs from 'fs';
import type { Action, Element, StateSnapshot } from './protocol.js';

const URL = process.env.SERVER_URL || 'http://localhost:3001';
const SERVER_LOG = process.env.SERVER_LOG || '/tmp/luanshi_server.log';
const BATCHES = Number(process.env.BATCHES || 3);
const ROOMS_PER_BATCH = Number(process.env.ROOMS_PER_BATCH || 30);
const PLAYERS = Number(process.env.PLAYERS || 6);

const ELS: Element[] = ['数', '物', '化', '生', '计'];
const HERO_POOL = ['chef', 'vampire', 'miner', 'doctor', 'police', 'farmer', 'carpenter', 'swordsman', 'builder', 'blacksmith', 'merchant', 'gambler'];
const rand = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function once<T = any>(s: Socket, ev: string, timeout = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ev}`)), timeout);
    s.once(ev, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function emitAck<T = any>(s: Socket, ev: string, msg: any, timeout = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ack ${ev}`)), timeout);
    s.emit(ev, msg, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function pickTarget(snap: StateSnapshot, pid: number): number | null {
  const others = snap.players.filter((p) => !p.dead && p.id !== pid);
  if (others.length === 0) return null;
  others.sort((a, b) => {
    const ta = a.hp + (a.fortFar?.hp || 0) + (a.fortNear?.hp || 0);
    const tb = b.hp + (b.fortFar?.hp || 0) + (b.fortNear?.hp || 0);
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
  return others[0].id;
}
function pickAction(snap: StateSnapshot, pid: number, heroId: string): Action {
  const target = pickTarget(snap, pid);
  if (target == null) return { type: 'pass' };
  const me = snap.players[pid];
  const tgt = snap.players[target];
  const tgtHasFort = !!(tgt.fortFar && tgt.fortFar.hp > 0) || !!(tgt.fortNear && tgt.fortNear.hp > 0);
  if (me.charge >= 2) return { type: 'attack', target };
  if (heroId === 'builder' && tgtHasFort) return { type: 'skill', skillId: '拆迁大队', target };
  if (heroId === 'miner' && tgtHasFort) return { type: 'skill', skillId: '地道战', target };
  if (heroId === 'doctor') return { type: 'skill', skillId: '麻醉', target };
  if (heroId === 'police') return { type: 'skill', skillId: '逮捕', target };
  return { type: 'attack', target };
}
interface Bot { s: Socket; token: string; roomId: string; pid: number; heroId: string; snaps: StateSnapshot[]; over: any; }
function wireBot(bot: Bot, s: Socket) {
  s.on('roundStart', () => s.emit('submitThrow', { token: bot.token, roomId: bot.roomId, element: rand(ELS) }));
  s.on('actionPhase', (d: any) => {
    if (d.winners.includes(bot.pid) && bot.snaps.length > 0) {
      const snap = bot.snaps[bot.snaps.length - 1];
      s.emit('submitAction', { token: bot.token, roomId: bot.roomId, action: pickAction(snap, bot.pid, bot.heroId) });
    }
  });
  s.on('state', (d: any) => { if (d && d.snapshot) bot.snaps.push(d.snapshot); });
  s.on('gameOver', (d: any) => { bot.over = d; });
}

async function playRoom(label: string, n: number, hack: boolean): Promise<void> {
  const roomIdHolder: { v: string | null } = { v: null };
  const bots: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    await once(s, 'connect');
    const heroId = HERO_POOL[i % HERO_POOL.length];
    const ack: any = i === 0
      ? await emitAck(s, 'createRoom', { name: `p${i}` })
      : await emitAck(s, 'joinRoom', { roomId: roomIdHolder.v!, name: `p${i}` });
    if (ack.error) { console.log(`[${label}] 加入失败: ${ack.error}`); s.close(); continue; }
    roomIdHolder.v = ack.roomId;
    // 房主(0号)建房后立即把人数上限设为本次压测人数（默认 10，需显式提升到 12）
    if (i === 0) {
      const cfg: any = await emitAck(s, 'setConfig', { token: ack.token, roomId: ack.roomId, playerCount: PLAYERS });
      if (cfg && cfg.error) console.log(`[${label}] setConfig 失败: ${cfg.error}`);
    }
    // 建/加入后必须单独 chooseHero（createRoom/joinRoom 不接收 heroId）
    const ch: any = await emitAck(s, 'chooseHero', { token: ack.token, roomId: ack.roomId, heroId });
    if (ch.error) { console.log(`[${label}] 选英雄失败(${heroId}): ${ch.error}`); }
    const bot: Bot = { s, token: ack.token, roomId: ack.roomId, pid: ack.playerId, heroId, snaps: [], over: null };
    bots.push(bot);
    wireBot(bot, s);
  }
  const roomId = roomIdHolder.v!;
  const sg: any = await emitAck(bots[0].s, 'startGame', { roomId });
  if (sg && sg.error) console.log(`[${label}] startGame 失败: ${sg.error}`);

  // 防开挂探测：游戏进行中发送非法/伪造 token/洪水（应被静默拒绝且不崩溃）
  if (hack) {
    const tok = bots[0].token;
    try {
      bots[0].s.emit('submitAction', { token: tok, roomId, action: { type: 'skill', skillId: 'FAKE_SKILL' } });
      bots[0].s.emit('submitAction', { token: tok, roomId, action: { type: 'build' } });
      bots[0].s.emit('submitAction', { token: tok, roomId, action: { type: 'ATTACK_HACK' } });
      bots[0].s.emit('submitThrow', { token: 'forge-token-12345', roomId, element: '数' }); // 伪造 token
      for (let k = 0; k < 300; k++) bots[0].s.emit('submitThrow', { token: tok, roomId, element: rand(ELS) }); // 洪水
    } catch { /* ignore */ }
  }

  const deadline = Date.now() + 140000;
  while (Date.now() < deadline) {
    if (bots.some((b) => b.over)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const winner = bots.find((b) => b.over)?.over?.winner ?? null;
  for (const b of bots) if (b.s && !b.s.disconnected) b.s.close();
  console.log(`[${label}] 结束 胜者=${winner} 回合=${bots[0].snaps.length}`);
}

function analyzeLeak(peakRooms: number) {
  if (!fs.existsSync(SERVER_LOG)) { console.log('[leak] 无日志，跳过自动判定'); return; }
  // 服务器结构化日志为单行 JSON，metrics 行形如 {"event":"metrics","rooms":90,"heapUsedMB":123.4,...}
  const lines = fs.readFileSync(SERVER_LOG, 'utf8').split('\n').filter((l) => l.includes('"event":"metrics"'));
  const samples: { rooms: number; heap: number }[] = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (typeof o.rooms === 'number' && typeof o.heapUsedMB === 'number') samples.push({ rooms: o.rooms, heap: o.heapUsedMB });
    } catch { /* 忽略非 JSON 行 */ }
  }
  if (samples.length < 3) { console.log('[leak] 采样不足，跳过'); return; }
  const last = samples.slice(-5);
  const minLastRooms = Math.min(...last.map((s) => s.rooms));
  const maxHeap = Math.max(...samples.map((s) => s.heap));
  const lastHeap = samples[samples.length - 1].heap;
  console.log(`[leak] 采样=${samples.length} 末5批rooms=${last.map((s) => s.rooms).join(',')} 峰值heap=${maxHeap}MB 末heap=${lastHeap}MB`);
  if (minLastRooms <= peakRooms * 0.3 && lastHeap < maxHeap * 1.3) console.log('[leak] ✅ 未见明显泄漏：rooms 已回落、堆内存未持续上涨');
  else console.log('[leak] ⚠️ 疑似泄漏：rooms 未回落或堆内存持续上涨，需排查');
}

// 结束时拉 /health 打印服务器基准报告(响应时间分位 + 等效QPS)
async function printBench() {
  try {
    const r = await fetch(`${URL}/health`);
    const j: any = await r.json();
    const b = j.bench || {};
    console.log('[bench] 服务器基准:');
    console.log(`  累计处理意图=${b.count}  等效吞吐=${b.tps} 意图/秒`);
    console.log(`  单意图响应(ms): 平均=${b.avgMs}  p50=${b.p50Ms}  p95=${b.p95Ms}  p99=${b.p99Ms}  最大=${b.maxMs}`);
  } catch (e) {
    console.log('[bench] 无法连接 /health:', (e as Error).message);
  }
}

async function main() {
  console.log(`压测: URL=${URL} batches=${BATCHES} rooms/批=${ROOMS_PER_BATCH} players=${PLAYERS}`);
  for (let b = 0; b < BATCHES; b++) {
    console.log(`--- 批次 ${b} ---`);
    const jobs: Promise<void>[] = [];
    for (let r = 0; r < ROOMS_PER_BATCH; r++) jobs.push(playRoom(`B${b}-R${r}`, PLAYERS, r === 0));
    await Promise.all(jobs);
    console.log(`--- 批次 ${b} 完成，等待销毁宽限 ---`);
    await new Promise((r) => setTimeout(r, 35000));
  }
  analyzeLeak(ROOMS_PER_BATCH);
  await printBench();
  console.log('STRESS TEST COMPLETE');
  process.exit(0);
}
main().catch((e) => { console.error('压测异常:', e); process.exit(1); });
