// Socket.IO 网关 + 房间管理器（服务器权威，客户端只发"意图"）。
// 生产就绪能力：
//  - 崩溃一致性恢复：每回合状态存 Redis，启动时扫描 room:* 重建房间继续跑。
//  - 横向扩展：实例归属注册表(roomowner:<id> TTL 心跳) + Redis 总线转发 + socket.io redis 适配器扇出。
//  - 挂机托管：由 room.ts 在行动阶段 15s 未提交自动 AI 接管。
//  - 防开挂：schema 校验 + token 绑定 + 速率限制 + 引擎二次校验。
//  - 可观测：/health 端点 + CPU/内存采样 + 结构化 JSON 日志。
import { Server } from 'socket.io';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { readFile, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname, normalize } from 'path';
import { Room } from './room.js';
import { createStorage } from './storage.js';
import { getSharedRedis, newRedisConn } from './redis-shared.js';
import { getBus } from './bus.js';
import { log } from './log.js';
import { benchRecord, benchTick, benchReport } from './bench.js';
import { listHeroes, reloadHeroesOverride } from '../src/engine/heroes/index.js';
import { ELEMENT_SETS, DEFAULT_ELEMENT_SET } from './protocol.js';
import type { CreateRoomMsg, JoinRoomMsg, SubmitThrowMsg, SubmitActionMsg, ReconnectMsg, StartGameMsg, Action, ChooseHeroMsg, RemoveMemberMsg, PauseMsg, ResumeMsg } from './protocol.js';
import { initDb, dbEnabled, dbDialect } from './db/index.js'; // #18 持久层（DATABASE_URL 未设则禁用）
import { initCache } from './cache/index.js'; // #18 缓存（REDIS_URL 未设则内存降级）
import { handleApi } from './api.js'; // #18 Phase2 HTTP 账号接口
import { getSessionAccountId } from './sessions.js'; // #18 Phase2 会话校验

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const DIST_DIR = join(PUBLIC_DIR, 'dist');
// 前端经 Vite 构建后落在 public/dist；若存在则优先托管构建产物，否则回退到 public/ 源码目录。
const SERVE_DIR = existsSync(join(DIST_DIR, 'index.html')) ? DIST_DIR : PUBLIC_DIR;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
// 英雄元数据（供前端选英雄 / 渲染技能按钮，不含数值参数）
const HERO_META = listHeroes().map((d: any) => ({
  id: d.id, name: d.name, maxHp: d.maxHp, atk: d.atk,
  fort: d.fort?.name ?? null, lanes: d.lanes || null, skills: Array.isArray(d.skills) ? d.skills : [],
}));

const PORT = Number(process.env.PORT || 3001);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 1000);
const MAX_SUBMITS_PER_SEC = Number(process.env.MAX_SUBMITS_PER_SEC || 50);
const INSTANCE_ID = randomUUID().slice(0, 8);
const OWNER_TTL = Number(process.env.OWNER_TTL_MS || 30000); // 房间归属 TTL，心跳半周期刷新

const sharedRedis = await getSharedRedis();
const storage = await createStorage();
const bus = await getBus();

// #18 持久层 + 缓存：两者失败均不致命，游戏照常运行（仅无持久化）。
// DATABASE_URL 未设置 → 持久层禁用（游客模式）；REDIS_URL 未设置 → 缓存降级内存。
await initCache();
await initDb();

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' }, pingTimeout: 20000 });

// #18 Phase2 Socket 鉴权：从 handshake.auth.token（或 query.token）还原 accountId，挂到 socket.data。
// 游客（无 token / token 无效）一律放行：accountId=null，仍可进房游玩（只是不持久化）。绝不因鉴权失败断开连接（保稳）。
io.use(async (socket, next) => {
  try {
    const a = (socket.handshake.auth && (socket.handshake.auth as any).token)
      || (socket.handshake.query && socket.handshake.query.token);
    (socket.data as any).accountId = await getSessionAccountId(typeof a === 'string' ? a : null);
  } catch {
    (socket.data as any).accountId = null;
  }
  next();
});

// 跨实例事件扇出：所有实例的客户端都收得到本房间广播（横向扩展关键）
if (sharedRedis) {
  const pub = await newRedisConn();
  const sub = await newRedisConn();
  if (pub && sub) {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    io.adapter(createAdapter(pub, sub));
    log.info('adapter', { type: 'redis', note: '跨实例事件扇出已启用' });
  }
}

const rooms = new Map<string, Room>();
const submitCounters = new Map<string, { count: number; ts: number }>();
const pendingReplies = new Map<string, (res: any) => void>(); // 跨实例 reconnect 回传

// ---------- 校验（防畸形 / 开挂）----------
function validAction(a: any): a is Action {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.type !== 'string') return false;
  if (!['attack', 'charge', 'build', 'skill', 'pass'].includes(a.type)) return false;
  if (a.target != null && typeof a.target !== 'number') return false;
  if (a.skillId != null && typeof a.skillId !== 'string') return false;
  return true;
}
function checkRate(socketId: string): boolean {
  const now = Date.now();
  const c = submitCounters.get(socketId);
  if (!c || now - c.ts > 1000) { submitCounters.set(socketId, { count: 1, ts: now }); return true; }
  c.count++;
  if (c.count > MAX_SUBMITS_PER_SEC) { submitCounters.delete(socketId); return false; }
  return true;
}

// 计时包装：测量单个意图的完整服务器逻辑处理耗时(纯计算，不含网络往返)
function timedIntent(label: string, fn: () => void) {
  const t0 = process.hrtime.bigint();
  try { fn(); }
  finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    benchRecord(ms);
  }
}

// ---------- 房间归属 + 路由 ----------
function getOrCreateRoom(id?: string, elementSet: string = DEFAULT_ELEMENT_SET): Room {
  if (id && rooms.has(id)) return rooms.get(id)!;
  const rid = id || randomUUID().slice(0, 8);
  const room = new Room(rid, io, storage, bus, INSTANCE_ID, elementSet);
  room.onDestroyed = () => { rooms.delete(rid); bus.releaseOwner(rid).catch(() => {}); };
  rooms.set(rid, room);
  bus.claimOwner(rid, INSTANCE_ID, OWNER_TTL).catch(() => {}); // 声明归属（异步，失败可重认）
  return room;
}

// 路由一个"客户端意图"：本实例有房间→本地处理；否则查归属→转发总线 / 认领恢复。
function routeIntent(
  roomId: string,
  applyLocal: (room: Room) => void,
  forwardKind: string,
  forwardPayload: Record<string, unknown>,
) {
  if (rooms.has(roomId)) { applyLocal(rooms.get(roomId)!); return; }
  bus.getOwner(roomId).then(async (owner) => {
    if (owner === INSTANCE_ID) {
      const r = getOrCreateRoom(roomId);
      if (await r.recover()) { applyLocal(r); return; }
    }
    if (owner) { bus.publish('intent:all', { kind: forwardKind, roomId, ...forwardPayload }); return; }
    if (await bus.claimOwner(roomId, INSTANCE_ID, OWNER_TTL)) {
      const r = getOrCreateRoom(roomId);
      if (await r.recover()) { applyLocal(r); return; }
    }
    bus.publish('intent:all', { kind: forwardKind, roomId, ...forwardPayload });
  }).catch((e) => log.warn('route_intent_fail', { roomId, kind: forwardKind, err: (e as Error).message }));
}

// 跨实例意图消费（仅本实例拥有的房间才处理）
bus.subscribe('intent:all', (msg: any) => {
  if (!msg || !msg.roomId) return;
  const room = rooms.get(msg.roomId);
  if (!room) return; // 不是本实例的房间
  const m = room.memberByToken(msg.token);
  if (!m) {
    if (msg.kind === 'reconnect') bus.publish(msg.replyChannel, { corrId: msg.corrId, result: { error: 'token 无效' } });
    return;
  }
  if (msg.kind === 'throw') timedIntent('throw', () => room.onThrow(msg.token, msg.element));
  else if (msg.kind === 'action') timedIntent('action', () => room.onAction(msg.token, msg.playerId, msg.action));
  else if (msg.kind === 'reconnect') bus.publish(msg.replyChannel, { corrId: msg.corrId, result: room.reconnect(msg.token) });
});
// 本实例发起的跨实例 reconnect 回传
bus.subscribe('reply:' + INSTANCE_ID, (msg: any) => {
  if (msg && msg.corrId) { const r = pendingReplies.get(msg.corrId); if (r) { pendingReplies.delete(msg.corrId); r(msg.result); } }
});

io.on('connection', (socket) => {
  // 创建房间（始终本地）：进房后再选英雄
  socket.on('createRoom', (msg: CreateRoomMsg, cb) => {
    if (!msg || typeof msg !== 'object') return cb?.({ error: '非法请求' });
    if (rooms.size >= MAX_ROOMS) return cb?.({ error: '服务器房间数已达上限，请稍后再试' });
    const set = msg.elementSet && ELEMENT_SETS[msg.elementSet] ? msg.elementSet : DEFAULT_ELEMENT_SET;
    const room = getOrCreateRoom(undefined, set);
    room.setSandbox(!!msg.sandbox);
    const accountId = (socket.data as any).accountId ?? null; // #18 Phase2：登录态透传到房间成员
    const res = room.addMember(null, msg.name, false, accountId);
    if ('error' in res) return cb?.({ error: res.error });
    const { pid, token } = res;
    socket.join(`room:${room.id}`);
    room.attachSocket(token, socket.id);
    cb?.({ roomId: room.id, playerId: pid, token, isHost: pid === 0, state: room.roomState() });
    io.to(`room:${room.id}`).emit('roomState', room.roomState());
  });

  // 加入房间（始终本地）：进房后再选英雄
  socket.on('joinRoom', (msg: JoinRoomMsg, cb) => {
    if (!msg || typeof msg.roomId !== 'string') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId) || getOrCreateRoom(msg.roomId);
    const accountId = (socket.data as any).accountId ?? null; // #18 Phase2：登录态透传到房间成员
    const res = room.addMember(null, msg.name, false, accountId);
    if ('error' in res) return cb?.({ error: res.error });
    const { pid, token } = res;
    socket.join(`room:${room.id}`);
    room.attachSocket(token, socket.id);
    cb?.({ roomId: room.id, playerId: pid, token, isHost: pid === 0, state: room.roomState() });
    io.to(`room:${room.id}`).emit('roomState', room.roomState());
  });

  // 房内选英雄（强制唯一）
  socket.on('chooseHero', (msg: ChooseHeroMsg, cb) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string' || typeof msg.heroId !== 'string') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId);
    if (!room) return cb?.({ error: '房间不存在' });
    const res = room.chooseHero(msg.token, msg.heroId);
    if ('error' in res) return cb?.({ error: res.error });
    cb?.(res);
    io.to(`room:${room.id}`).emit('roomState', room.roomState());
  });

  // 房主移除成员（选错机器人可取消）
  socket.on('removeMember', (msg: RemoveMemberMsg, cb) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string' || typeof msg.pid !== 'number') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId);
    if (!room) return cb?.({ error: '房间不存在' });
    const res = room.removeMember(msg.token, msg.pid);
    if ('error' in res) return cb?.({ error: res.error });
    cb?.(res);
    io.to(`room:${room.id}`).emit('roomState', room.roomState());
  });

  // 房内改元素集（房主，开局前）
  socket.on('setElement', (msg: any, cb) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string' || typeof msg.elementSet !== 'string') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId);
    if (!room) return cb?.({ error: '房间不存在' });
    const ok = room.setElement(msg.elementSet);
    cb?.({ ok });
    if (ok) io.to(`room:${room.id}`).emit('roomState', room.roomState());
  });

  // 游戏配置（房主，开局前）: 玩家人数 / 分队 / 明暗斗
  socket.on('setConfig', (msg: any, cb) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId);
    if (!room) return cb?.({ error: '房间不存在' });
    room.setConfig({ playerCount: msg.playerCount, teamStr: msg.teamStr, fightMode: msg.fightMode });
    cb?.({ ok: true });
  });

  // 暂停 / 继续（任意玩家可发起；下一回合边界生效）
  socket.on('pause', (msg: PauseMsg, cb) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId);
    if (!room) return cb?.({ error: '房间不存在' });
    cb?.({ ok: room.pause() });
  });
  socket.on('resume', (msg: ResumeMsg, cb) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId);
    if (!room) return cb?.({ error: '房间不存在' });
    cb?.({ ok: room.resume() });
  });

  socket.on('startGame', (msg: StartGameMsg, cb) => {
    if (!msg || typeof msg.roomId !== 'string') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId);
    if (!room) return cb?.({ error: '房间不存在' });
    const ok = room.startGame({ mode: msg.mode, teamConfig: msg.teamConfig });
    if (!ok) return cb?.({ error: '还有人没选英雄 / 人数不支持 / 组队配置非法 / 已开始' });
    cb?.({ ok: true });
  });

  // 提交猜拳元素（schema + 速率 + token 绑定；非本地则跨实例转发）
  socket.on('submitThrow', (msg: SubmitThrowMsg) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string' || typeof msg.element !== 'string') return;
    const room = rooms.get(msg.roomId);
    if (room && !room.isValidElement(msg.element)) return; // 本地房间按本局元素集校验
    // O5 限流：超限仅丢弃本次请求（记日志），不再直接断开连接——避免误杀正常玩家/重连抖动。
    if (!checkRate(socket.id)) { log.warn('rate_limit', { socket: socket.id, type: 'throw' }); return; }
    const { token, roomId, element } = msg;
    routeIntent(roomId, (room) => {
      const m = room.memberByToken(token);
      if (!m || m.socketId !== socket.id) { log.warn('throw_reject', { room: roomId, reason: 'token/socket 不匹配' }); return; }
      timedIntent('throw', () => room.onThrow(token, element));
    }, 'throw', { token, element });
  });

  // 提交行动意图（同上）
  socket.on('submitAction', (msg: SubmitActionMsg) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string' || !validAction(msg.action)) return;
    // O5 限流：超限仅丢弃本次请求（记日志），不再直接断开连接。
    if (!checkRate(socket.id)) { log.warn('rate_limit', { socket: socket.id, type: 'action' }); return; }
    const { token, roomId, action } = msg;
    const playerId = typeof msg.playerId === 'number' ? msg.playerId : undefined;
    routeIntent(roomId, (room) => {
      const m = room.memberByToken(token);
      if (!m || m.socketId !== socket.id) { log.warn('action_reject', { room: roomId, reason: 'token/socket 不匹配' }); return; }
      timedIntent('action', () => room.onAction(token, playerId, action));
    }, 'action', { token, action, playerId });
  });

  // 断线重连（需回传快照 → 跨实例用 corrId+replyChannel 回传）
  socket.on('reconnect', (msg: ReconnectMsg, cb) => {
    if (!msg || typeof msg.token !== 'string' || typeof msg.roomId !== 'string') return cb?.({ error: '非法请求' });
    const { token, roomId } = msg;
    const doLocal = (room: Room) => {
      const m = room.attachSocket(token, socket.id);
      if (!m) return { error: 'token 无效' };
      socket.join(`room:${room.id}`);
      room.cancelDestroy();
      return room.reconnect(token);
    };
    if (rooms.has(roomId)) return cb?.(doLocal(rooms.get(roomId)!));
    bus.getOwner(roomId).then(async (owner) => {
      if (owner === INSTANCE_ID) {
        const r = getOrCreateRoom(roomId);
        if (await r.recover()) return cb?.(doLocal(r));
        return cb?.({ error: '房间不存在' });
      }
      if (!owner && await bus.claimOwner(roomId, INSTANCE_ID, OWNER_TTL)) {
        const r = getOrCreateRoom(roomId);
        if (await r.recover()) return cb?.(doLocal(r));
      }
      // 转发到其他实例并等待回传
      const corrId = randomUUID();
      const p = new Promise<any>((res) => {
        pendingReplies.set(corrId, res);
        setTimeout(() => { pendingReplies.delete(corrId); res({ error: 'reconnect 超时' }); }, 5000);
      });
      bus.publish('intent:all', { kind: 'reconnect', roomId, token, corrId, replyChannel: 'reply:' + INSTANCE_ID });
      cb?.(await p);
    }).catch(() => cb?.({ error: 'reconnect 失败' }));
  });

  socket.on('disconnect', () => {
    submitCounters.delete(socket.id);
    for (const room of rooms.values()) room.detachSocket(socket.id);
  });

  // 英雄元数据（前端选英雄 / 渲染技能按钮用，不含数值参数）
  socket.on('listHeroes', (cb) => { cb?.(HERO_META); });

  // 补一个成员：
  //  - 普通模式：离线机器人 → 系统随机补拳 + 赢家阶段 AI 托管，便于单人自测。
  //  - 沙盒模式：挂到房主 socket → 由测试者直接操控（无猜拳、一人控全场）。
  socket.on('addBot', (msg: any, cb) => {
    if (!msg || typeof msg.roomId !== 'string') return cb?.({ error: '非法请求' });
    const room = rooms.get(msg.roomId);
    if (!room) return cb?.({ error: '房间不存在' });
    const res = room.addBot(msg.heroId || null);
    if ('error' in res) return cb?.({ error: res.error });
    if (room.sandbox && 'token' in res) room.attachSocket((res as any).token, socket.id); // 沙盒：测试英雄由房主操控
    io.to(`room:${room.id}`).emit('roomState', room.roomState());
    cb?.({ ok: true, state: room.roomState() });
  });
});

// ---------- 启动恢复（崩溃一致性）----------
async function recoverAtStartup() {
  try {
    const keys = await storage.keys('room:');
    let owned = 0;
    for (const k of keys) {
      const id = k.startsWith('room:') ? k.slice('room:'.length) : k;
      const got = await bus.claimOwner(id, INSTANCE_ID, OWNER_TTL);
      if (!got) continue; // 其他实例已认领
      const room = getOrCreateRoom(id);
      if (await room.recover()) owned++;
    }
    log.info('startup_recovery', { scanned: keys.length, recovered: owned, instance: INSTANCE_ID });
  } catch (e) { log.error('startup_recovery_fail', { err: (e as Error).message }); }
}
recoverAtStartup();

// 归属心跳：周期刷新本实例所有房间的 TTL（防脑裂 / 让宕机实例的房间可被其他实例接管）
setInterval(() => {
  for (const id of rooms.keys()) bus.claimOwner(id, INSTANCE_ID, OWNER_TTL).catch(() => {});
}, Math.floor(OWNER_TTL / 2));

// ---------- 可观测：CPU 采样 + 结构化指标 + /health ----------
let cpuPrev = process.cpuUsage();
let cpuPercent = 0;
setInterval(() => {
  const u = process.cpuUsage(cpuPrev);
  cpuPrev = process.cpuUsage();
  cpuPercent = ((u.user + u.system) / 1e6) * 100; // 1s 窗口内单核占用百分比
}, 1000);

setInterval(() => {
  const mu = process.memoryUsage();
  benchTick();
  const b = benchReport();
  log.info('metrics', { instance: INSTANCE_ID, distributed: bus.distributed, rooms: rooms.size, sockets: io.engine.clientsCount, heapUsedMB: +(mu.heapUsed / 1048576).toFixed(1), cpuPercent: +cpuPercent.toFixed(1), intentCount: b.count, intentAvgMs: b.avgMs, intentP95Ms: b.p95Ms, intentP99Ms: b.p99Ms, intentTps: b.tps });
}, Number(process.env.METRICS_INTERVAL_MS || 5000));

httpServer.on('request', async (req, res) => {
  // #18 Phase2：账号 HTTP 接口优先处理；返回 true 表示已处理（含错误响应）。
  if (await handleApi(req, res)) return;
  if (req.url === '/metrics') {
    const mu = process.memoryUsage();
    const b = benchReport();
    const lines = [
      '# HELP luanshi_rooms Active rooms on this instance',
      '# TYPE luanshi_rooms gauge',
      `luanshi_rooms ${rooms.size}`,
      '# HELP luanshi_sockets Open client sockets',
      '# TYPE luanshi_sockets gauge',
      `luanshi_sockets ${io.engine.clientsCount}`,
      '# HELP luanshi_distributed Whether running in distributed (Redis) mode',
      '# TYPE luanshi_distributed gauge',
      `luanshi_distributed ${bus.distributed ? 1 : 0}`,
      '# HELP luanshi_intent_total Total intents processed (cumulative)',
      '# TYPE luanshi_intent_total counter',
      `luanshi_intent_total ${b.count}`,
      '# HELP luanshi_intent_latency_ms Server intent handling latency in ms',
      '# TYPE luanshi_intent_latency_ms gauge',
      `luanshi_intent_latency_ms_avg ${b.avgMs}`,
      `luanshi_intent_latency_ms_p50 ${b.p50Ms}`,
      `luanshi_intent_latency_ms_p95 ${b.p95Ms}`,
      `luanshi_intent_latency_ms_p99 ${b.p99Ms}`,
      `luanshi_intent_latency_ms_max ${b.maxMs}`,
      '# HELP luanshi_intent_tps Intents per second (recent window)',
      '# TYPE luanshi_intent_tps gauge',
      `luanshi_intent_tps ${b.tps}`,
      '# HELP luanshi_heap_used_bytes Process heap used bytes',
      '# TYPE luanshi_heap_used_bytes gauge',
      `luanshi_heap_used_bytes ${mu.heapUsed}`,
      '# HELP luanshi_cpu_percent Process CPU usage percent (single core, 1s window)',
      '# TYPE luanshi_cpu_percent gauge',
      `luanshi_cpu_percent ${cpuPercent.toFixed(2)}`,
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(lines.join('\n') + '\n');
    return;
  }
  if (req.url === '/health') {
    const mu = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', instance: INSTANCE_ID, distributed: bus.distributed,
      uptimeSec: Math.floor(process.uptime()), rooms: rooms.size, sockets: io.engine.clientsCount,
      heapUsedMB: +(mu.heapUsed / 1048576).toFixed(1), rssMB: +(mu.rss / 1048576).toFixed(1),
      cpuPercent: +cpuPercent.toFixed(1), redis: !!sharedRedis, ts: Date.now(),
      db: dbEnabled() ? { dialect: dbDialect(), ok: true } : { enabled: false },
      bench: benchReport(),
    }));
    return;
  }
  // 静态文件托管（前端页面）：路径穿越防护 + 默认 index.html
  // 跳过 Socket.IO 自有路径（/socket.io/*），避免与引擎响应冲突导致进程崩溃
  if (req.url && req.url.startsWith('/socket.io/')) return;
  if (res.headersSent) return;
  let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(SERVE_DIR, pathname));
  if (!filePath.startsWith(SERVE_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  readFile(filePath, (err, data) => {
    if (res.headersSent) return;
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// 进程退出：打印最终基准摘要 + 释放 Redis / 总线资源
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try { benchTick(); log.info('bench_summary', benchReport()); } catch { /* 忽略 */ }
    Promise.all([storage.quit?.() ?? Promise.resolve(), bus.close()]).finally(() => process.exit(0));
  });
}

// P8 英雄数值热更新：修改 heroes.override.json 后向进程发 SIGHUP 即可，无需重启（仅影响新房间）
process.on('SIGHUP', () => { try { reloadHeroesOverride(); } catch { /* 忽略 */ } });

httpServer.listen(PORT, () => {
  log.info('server_start', { port: PORT, instance: INSTANCE_ID, redis: !!sharedRedis, distributed: bus.distributed, maxRooms: MAX_ROOMS, rateLimit: `${MAX_SUBMITS_PER_SEC}/s`, replayMode: process.env.REPLAY_MODE || 'all' });
});
