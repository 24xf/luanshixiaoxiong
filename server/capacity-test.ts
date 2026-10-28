// 容量压测：真实满员长连接(每房 PLAYERS 条 websocket)，把房间数顶到上限。
// 同时支持单实例上限探测 与 多实例乘法(房间数=实例数×每实例房)——通过 SERVER_URLS 逗号列表控制。
// 监控各实例 /health 的 rooms/heap/cpu/intent延迟/tps，统计峰值房间数、单房内存估算、聚合吞吐。
// 客户端不累积快照(只在 actionPhase 用当回合快照决策)，防止客户端自身 OOM。
//
// 多进程客户端(WORKERS>1)：单个 Node 事件循环扛不住 >1.2万条连接的机器人逻辑(实测 ~1963 房时客户端 CPU 打满、
// /health fetch 全部失败——服务器其实没崩)。设 WORKERS=N 后：master 进程只做 /health 监控与结果聚合(轻量)，
// 建房+机器人回合逻辑分摊到 N 个 fork 出的 worker 子进程(各自独立事件循环、吃满多核)，经 IPC 上报结果。
//
// 用法示例：
//   单实例上限(单进程客户端):  SERVER_URLS=http://localhost:3001 ROOMS=400 PLAYERS=12 npx tsx server/capacity-test.ts
//   2000房(4 worker 分摊):     SERVER_URLS=http://localhost:3005 ROOMS=2000 PLAYERS_MIN=2 PLAYERS_MAX=12 WORKERS=4 npx tsx server/capacity-test.ts
//   多实例乘法(3实例各200):    SERVER_URLS=http://localhost:3201,http://localhost:3202,http://localhost:3203 ROOMS=600 PLAYERS=12 WORKERS=3 npx tsx server/capacity-test.ts
import { io, Socket } from 'socket.io-client';
import { fork, type ChildProcess } from 'node:child_process';

const SERVER_URLS = (process.env.SERVER_URLS || 'http://localhost:3001').split(',').map((s) => s.trim()).filter(Boolean);
const TOTAL_ROOMS = Number(process.env.ROOMS || 90);
const PLAYERS = Number(process.env.PLAYERS || 12);
// 每房人数可固定(PLAYERS)或范围随机(PLAYERS_MIN..PLAYERS_MAX，更贴近真实匹配)。设了范围则每房独立随机。
// 普通模式合法人数白名单(与 src/types.ts ALLOWED_ROOM_SIZES 一致，含禁11人)——随机人数只从白名单里取，避免被规则判"人数不支持"。
const ALLOWED_SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12];
const PLAYERS_MIN = process.env.PLAYERS_MIN ? Number(process.env.PLAYERS_MIN) : 0;
const PLAYERS_MAX = process.env.PLAYERS_MAX ? Number(process.env.PLAYERS_MAX) : 0;
const RANGE_MODE = PLAYERS_MIN > 0 && PLAYERS_MAX >= PLAYERS_MIN;
const RANGE_POOL = ALLOWED_SIZES.filter((n) => n >= PLAYERS_MIN && n <= PLAYERS_MAX);
const roomPlayers = () => RANGE_MODE ? (RANGE_POOL[Math.floor(Math.random() * RANGE_POOL.length)] || PLAYERS_MAX) : PLAYERS;
const HOLD_MS = Number(process.env.HOLD_MS || 120000);
const BATCH = Number(process.env.BATCH || 25);       // 并发建房数（控制客户端连接风暴）
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 5000);
const CONNECT_TIMEOUT = Number(process.env.CONNECT_TIMEOUT || 20000);  // socket 握手超时（冲高房间数时握手会排队，需调大）
const BATCH_GAP = Number(process.env.BATCH_GAP || 400);                // 建房批次间隔（冲高时调大以缓解握手风暴）
// 多进程客户端：WORKERS>1 时 master 只监控，worker 承担连接与机器人逻辑
const WORKERS = Math.max(1, Number(process.env.WORKERS || 1));
const IS_WORKER = process.env.CAP_ROLE === 'worker';
const WORKER_ID = Number(process.env.WORKER_ID || 0);
const ROOM_OFFSET = Number(process.env.ROOM_OFFSET || 0);  // worker 的房间编号偏移(仅日志用)

const ELS = ['数', '物', '化', '生', '计'];
const HERO_POOL = ['chef', 'vampire', 'miner', 'doctor', 'police', 'farmer', 'carpenter', 'swordsman', 'builder', 'blacksmith', 'merchant', 'gambler'];
const rand = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function once<T = any>(s: Socket, ev: string, timeout = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ev}`)), timeout);
    s.once(ev, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function emitAck<T = any>(s: Socket, ev: string, msg: any, timeout = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ack ${ev}`)), timeout);
    s.emit(ev, msg, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function pickTarget(snap: any, pid: number): number | null {
  const others = snap.players.filter((p: any) => !p.dead && p.id !== pid);
  if (others.length === 0) return null;
  others.sort((a: any, b: any) => {
    const ta = a.hp + (a.fortFar?.hp || 0) + (a.fortNear?.hp || 0);
    const tb = b.hp + (b.fortFar?.hp || 0) + (b.fortNear?.hp || 0);
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
  return others[0].id;
}
function pickAction(snap: any, pid: number, heroId: string): any {
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

interface Bot { s: Socket; token: string; roomId: string; pid: number; heroId: string; over: boolean; }
function wireBot(bot: Bot) {
  bot.s.on('roundStart', () => bot.s.emit('submitThrow', { token: bot.token, roomId: bot.roomId, element: rand(ELS) }));
  bot.s.on('actionPhase', (d: any) => {
    // 仅在自己是赢家、且本回合带快照时，用当回合快照决策(不缓存历史，避免客户端OOM)
    if (d && Array.isArray(d.winners) && d.winners.includes(bot.pid) && d.snapshot) {
      bot.s.emit('submitAction', { token: bot.token, roomId: bot.roomId, action: pickAction(d.snapshot, bot.pid, bot.heroId) });
    }
  });
  bot.s.on('gameOver', () => { bot.over = true; });
}

async function createRoomOn(url: string, idx: number): Promise<{ ok: boolean; url: string; players: number }> {
  const bots: Bot[] = [];
  const np = roomPlayers();   // 本房人数（固定或范围随机）
  try {
    for (let i = 0; i < np; i++) {
      const s = io(url, { transports: ['websocket'], forceNew: true, timeout: CONNECT_TIMEOUT, reconnection: false });
      await once(s, 'connect', CONNECT_TIMEOUT);
      const heroId = HERO_POOL[i % HERO_POOL.length];
      const ack: any = i === 0
        ? await emitAck(s, 'createRoom', { name: `p${i}` })
        : await emitAck(s, 'joinRoom', { roomId: (bots[0] as any).roomId, name: `p${i}` });
      if (ack.error) { console.log(`  [房${idx}] 加入失败: ${ack.error}`); s.close(); return { ok: false, url, players: 0 }; }
      if (i === 0) {
        const cfg: any = await emitAck(s, 'setConfig', { token: ack.token, roomId: ack.roomId, playerCount: np });
        if (cfg && cfg.error) console.log(`  [房${idx}] setConfig 失败: ${cfg.error}`);
      }
      const ch: any = await emitAck(s, 'chooseHero', { token: ack.token, roomId: ack.roomId, heroId });
      if (ch.error) console.log(`  [房${idx}] 选英雄失败(${heroId}): ${ch.error}`);
      const bot: Bot = { s, token: ack.token, roomId: ack.roomId, pid: ack.playerId, heroId, over: false };
      bots.push(bot);
      wireBot(bot);
    }
    const sg: any = await emitAck(bots[0].s, 'startGame', { roomId: (bots[0] as any).roomId });
    if (sg && sg.error) console.log(`  [房${idx}] startGame 失败: ${sg.error}`);
    return { ok: true, url, players: np };
  } catch (e: any) {
    console.log(`  [房${idx}] 异常: ${e?.message || e}`);
    return { ok: false, url, players: 0 };
  }
}

// 建房主循环（单进程模式与 worker 模式共用）：按房间序号 round-robin 分配到各实例
async function buildRooms(total: number, offset: number): Promise<{ created: number; failed: number; totalConns: number }> {
  let created = 0, failed = 0, totalConns = 0;
  for (let start = 0; start < total; start += BATCH) {
    const slice = Math.min(BATCH, total - start);
    const jobs: Promise<{ ok: boolean; url: string; players: number }>[] = [];
    for (let k = 0; k < slice; k++) {
      const idx = offset + start + k;
      const url = SERVER_URLS[idx % SERVER_URLS.length];
      jobs.push(createRoomOn(url, idx));
    }
    const results = await Promise.all(jobs);
    for (const r of results) { if (r.ok) { created++; totalConns += r.players; } else failed++; }
    if (start + slice < total) {
      // 轻微节奏控制，避免客户端 socket 瞬间暴增；同时让已建房进入运行态
      await new Promise((r) => setTimeout(r, BATCH_GAP));
    }
  }
  return { created, failed, totalConns };
}

interface ServerStat {
  url: string;
  baselineHeap: number | null;
  peakRooms: number;
  peakHeap: number;
  peakTps: number;
  minLatency: number;   // 取各采样 p50 的最小值
  maxLatency: number;   // 取各采样 p99 的最大值
  finalIntentCount: number;
  roomsNow: number;
}
const stats: ServerStat[] = SERVER_URLS.map((u) => ({
  url: u, baselineHeap: null, peakRooms: 0, peakHeap: 0, peakTps: 0, minLatency: Infinity, maxLatency: 0, finalIntentCount: 0, roomsNow: 0,
}));

async function sampleServers() {
  await Promise.all(stats.map(async (st) => {
    try {
      const r = await fetch(`${st.url}/health`);
      const j: any = await r.json();
      const heap = j.heapUsedMB as number;
      const rooms = j.rooms as number;
      const tps = (j.bench?.tps as number) || 0;
      const p50 = (j.bench?.p50Ms as number) || 0;
      const p99 = (j.bench?.p99Ms as number) || 0;
      if (st.baselineHeap == null) st.baselineHeap = heap;
      st.peakRooms = Math.max(st.peakRooms, rooms);
      st.peakHeap = Math.max(st.peakHeap, heap);
      st.peakTps = Math.max(st.peakTps, tps);
      st.minLatency = Math.min(st.minLatency, p50);
      st.maxLatency = Math.max(st.maxLatency, p99);
      st.finalIntentCount = (j.bench?.count as number) || 0;
      st.roomsNow = rooms;
    } catch (e: any) {
      console.log(`  [monitor ${st.url}] 读取失败: ${e?.message || e}`);
    }
  }));
}

function printReport(created: number, failed: number, totalConns: number) {
  const avgPlayers = created > 0 ? (totalConns / created).toFixed(1) : '0';
  console.log('\n========== 容量压测报告 ==========');
  console.log(`目标房间=${TOTAL_ROOMS} 成功建房=${created} 失败=${failed} 每房=${RANGE_MODE ? `${PLAYERS_MIN}~${PLAYERS_MAX}随机(均${avgPlayers})` : PLAYERS} 真实连接 总连接=${totalConns} 客户端进程=${WORKERS}`);
  let totalPeakRooms = 0, totalPeakHeap = 0, totalBaseHeap = 0, totalPeakTps = 0, totalIntent = 0;
  let worstLatency = 0, bestLatency = Infinity;
  for (const st of stats) {
    totalPeakRooms += st.peakRooms;
    totalPeakHeap += st.peakHeap;
    totalBaseHeap += st.baselineHeap || 0;
    totalPeakTps += st.peakTps;
    totalIntent += st.finalIntentCount;
    worstLatency = Math.max(worstLatency, st.maxLatency);
    bestLatency = Math.min(bestLatency, st.minLatency);
    const perRoom = st.peakRooms > 0 ? ((st.peakHeap - (st.baselineHeap || 0)) / st.peakRooms) : 0;
    console.log(`- 实例 ${st.url}: 峰值房间=${st.peakRooms} 峰值堆=${st.peakHeap}MB(基线${st.baselineHeap}MB) 估算单房=${perRoom.toFixed(2)}MB 峰值吞吐=${st.peakTps}意图/秒 延迟p50min=${st.minLatency}ms p99max=${st.maxLatency}ms 累计意图=${st.finalIntentCount}`);
  }
  const aggPerRoom = totalPeakRooms > 0 ? ((totalPeakHeap - totalBaseHeap) / totalPeakRooms) : 0;
  console.log('---- 聚合 ----');
  console.log(`总峰值房间=${totalPeakRooms} 总峰值堆=${totalPeakHeap}MB(基线${totalBaseHeap}MB) 估算单房内存=${aggPerRoom.toFixed(2)}MB`);
  console.log(`总峰值吞吐=${totalPeakTps}意图/秒 累计意图=${totalIntent} 延迟区间 p50min=${bestLatency === Infinity ? 0 : bestLatency}ms ~ p99max=${worstLatency}ms`);
  console.log('==================================');
  console.log('CAPACITY TEST COMPLETE');
}

// ---------- worker 入口：只建房+跑机器人，不做监控；结果经 IPC 上报 ----------
async function workerMain() {
  const res = await buildRooms(TOTAL_ROOMS, ROOM_OFFSET);
  console.log(`[worker${WORKER_ID}] 建房完成: 成功=${res.created} 失败=${res.failed} 连接=${res.totalConns}`);
  if (process.send) process.send({ type: 'built', ...res });
  // 建完后保持连接（机器人继续对局），到 HOLD_MS 后退出释放所有 socket
  await new Promise((r) => setTimeout(r, HOLD_MS));
  if (process.send) process.send({ type: 'done' });
  process.exit(0);
}

// ---------- master 入口(WORKERS>1)：fork N 个 worker 分摊连接，本进程只监控 ----------
async function masterMain() {
  const playersDesc = RANGE_MODE ? `${PLAYERS_MIN}~${PLAYERS_MAX}随机` : `${PLAYERS}`;
  console.log(`容量压测(多进程客户端): workers=${WORKERS} 目标房间=${TOTAL_ROOMS} 每房人数=${playersDesc} 监控时长=${HOLD_MS}ms 每worker并发建房=${Math.max(5, Math.floor(BATCH / WORKERS))}`);
  console.log(`实例: ${SERVER_URLS.join(' | ')}`);

  let created = 0, failed = 0, totalConns = 0;
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  const perWorkerBatch = Math.max(5, Math.floor(BATCH / WORKERS));
  const base = Math.floor(TOTAL_ROOMS / WORKERS);
  const rem = TOTAL_ROOMS % WORKERS;
  let offset = 0;
  for (let w = 0; w < WORKERS; w++) {
    const share = base + (w < rem ? 1 : 0);
    if (share === 0) continue;
    // fork 继承 tsx 的 execArgv(loader)，可直接跑本 .ts 文件；IPC 通道回传结果
    const child = fork(process.argv[1], [], {
      env: {
        ...process.env,
        CAP_ROLE: 'worker', WORKER_ID: String(w),
        ROOMS: String(share), ROOM_OFFSET: String(offset), BATCH: String(perWorkerBatch),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    offset += share;
    children.push(child);
    // worker 日志加前缀转发（失败详情可见），丢弃海量正常输出防 master 阻塞
    child.stdout?.on('data', (b: Buffer) => {
      const t = b.toString().trim();
      if (t) for (const line of t.split('\n')) console.log(`[w${w}] ${line}`);
    });
    child.stderr?.on('data', (b: Buffer) => {
      const t = b.toString().trim();
      if (t) console.log(`[w${w}!] ${t.slice(0, 500)}`);
    });
    child.on('message', (m: any) => {
      if (m && m.type === 'built') { created += m.created; failed += m.failed; totalConns += m.totalConns; }
    });
    exits.push(new Promise<void>((resolve) => child.on('exit', (code) => {
      if (code !== 0) console.log(`[w${w}] 异常退出 code=${code}`);
      resolve();
    })));
  }

  // 监控循环：workers 存活期间持续采样 /health（master 事件循环极轻，fetch 不会被饿死）
  let alive = children.length;
  for (const p of exits) p.then(() => { alive--; });
  let sampleNo = 0;
  while (alive > 0) {
    await sampleServers();
    sampleNo++;
    const totalNow = stats.reduce((s, x) => s + x.roomsNow, 0);
    const totalPeak = stats.reduce((s, x) => s + x.peakRooms, 0);
    const totalHeap = stats.reduce((s, x) => s + x.peakHeap, 0);
    const totalBase = stats.reduce((s, x) => s + (x.baselineHeap || 0), 0);
    const perRoom = totalPeak > 0 ? ((totalHeap - totalBase) / totalPeak) : 0;
    console.log(`[采样${sampleNo}] 当前总房间=${totalNow} 峰值总房间=${totalPeak} 峰值堆=${totalHeap}MB 估算单房内存=${perRoom.toFixed(2)}MB 建房=${created}/${TOTAL_ROOMS} workers存活=${alive}`);
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
  await Promise.all(exits);
  await sampleServers();
  printReport(created, failed, totalConns);
  process.exit(0);
}

// ---------- 单进程入口（向后兼容：WORKERS=1 时行为与旧版一致） ----------
async function main() {
  const playersDesc = RANGE_MODE ? `${PLAYERS_MIN}~${PLAYERS_MAX}随机` : `${PLAYERS}`;
  console.log(`容量压测: 实例数=${SERVER_URLS.length} 目标房间=${TOTAL_ROOMS} 每房人数=${playersDesc} 监控时长=${HOLD_MS}ms 并发建房=${BATCH}`);
  console.log(`实例: ${SERVER_URLS.join(' | ')}`);

  const { created, failed, totalConns } = await buildRooms(TOTAL_ROOMS, 0);
  const avgPlayers = created > 0 ? (totalConns / created).toFixed(1) : '0';
  console.log(`建房完成: 成功=${created} 失败=${failed} 总连接数=${totalConns} 平均每房=${avgPlayers}人`);

  // 监控阶段：周期拉各实例 /health，捕捉峰值
  const deadline = Date.now() + HOLD_MS;
  let sampleNo = 0;
  while (Date.now() < deadline) {
    await sampleServers();
    sampleNo++;
    const totalNow = stats.reduce((s, x) => s + x.roomsNow, 0);
    const totalPeak = stats.reduce((s, x) => s + x.peakRooms, 0);
    const totalHeap = stats.reduce((s, x) => s + x.peakHeap, 0);
    const totalBase = stats.reduce((s, x) => s + (x.baselineHeap || 0), 0);
    const perRoom = totalPeak > 0 ? ((totalHeap - totalBase) / totalPeak) : 0;
    console.log(`[采样${sampleNo}] 当前总房间=${totalNow} 峰值总房间=${totalPeak} 峰值堆=${totalHeap}MB 估算单房内存=${perRoom.toFixed(2)}MB`);
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
  await sampleServers();
  printReport(created, failed, totalConns);
  process.exit(0);
}

const entry = IS_WORKER ? workerMain : (WORKERS > 1 ? masterMain : main);
entry().catch((e) => { console.error('容量压测异常:', e); process.exit(1); });
