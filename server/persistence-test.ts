// #18 Phase3 持久化集成测试：真实 SQLite（:memory:）跑通战绩/回放/收藏/书签/偏好 全链路。
// 运行：DATABASE_URL=sqlite::memory: npx tsx server/persistence-test.ts  （npm run test:db 已串联）
import { configureDb, initDb, dbEnabled } from './db/index.js';
import { initCache } from './cache/index.js';
import { register } from './accounts.js';
import { createSession } from './sessions.js';
import {
  recordMatch, getStats, listReplays, getReplay,
  setFavorite, listFavorites, addBookmark, listBookmarks, removeBookmark,
  updatePrefs, getPrefs,
} from './persistence.js';
import { handleApi } from './api.js';

let pass = 0, fail = 0;
function ok(cond: any, msg: string) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a: any, b: any, msg: string) { ok(a === b, `${msg} (得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`); }

// 最小 HTTP 模拟（handleApi 用 readBody 读流，这里同步喂数据）
function mockReqRes(method: string, url: string, body?: any, token?: string) {
  const req: any = {
    method, url,
    headers: token ? { authorization: 'Bearer ' + token } : {},
    on(evt: string, cb: (d?: any) => void) {
      if (evt === 'data' && body != null) cb(JSON.stringify(body));
      if (evt === 'end') cb();
    },
    destroy() {},
  };
  const res: any = { _code: 0, _body: '', headersSent: false,
    writeHead(c: number) { this._code = c; },
    end(s?: string) { this._body += (s || ''); },
  };
  return { req, res };
}
async function callApi(method: string, url: string, body?: any, token?: string) {
  const { req, res } = mockReqRes(method, url, body, token);
  await handleApi(req, res);
  let json: any = null; try { json = JSON.parse(res._body); } catch { /* ignore */ }
  return { code: res._code, json };
}

async function main() {
  configureDb();
  await initCache();
  await initDb();
  if (!dbEnabled()) { console.log('persistence-test: 持久层未启用，跳过'); process.exit(0); }

  // ---- 注册两个账号 ----
  const a1 = await register('persist_a1', 'pw123456');
  const a2 = await register('persist_a2', 'pw123456');
  ok(a1 && a1.id, '注册 a1 成功');
  ok(a2 && a2.id, '注册 a2 成功');
  const t1 = await createSession(a1.id);
  ok(typeof t1 === 'string' && t1.length > 0, 'a1 会话签发');

  // ---- 一局：a1 胜(剑客) / 游客负 ----
  await recordMatch({
    roomCode: 'ROOM11', mode: 'free', winner: 0,
    players: [
      { accountId: a1.id, heroId: 'swordsman', result: 'win' },
      { accountId: null, heroId: 'miner', result: 'loss' },
    ],
    durationRounds: 12,
    stream: [{ turn: 1, throws: { 0: '数' }, results: { 0: 'win' }, winners: [0], events: {}, actions: { 0: { type: 'attack' } }, log: ['a 攻击 b'] }],
  });
  const s1 = await getStats(a1.id);
  eq(s1.games_played, 1, 'a1 场次=1');
  eq(s1.wins, 1, 'a1 胜=1');
  eq(s1.losses, 0, 'a1 负=0');
  const hu = JSON.parse(s1.hero_usage || '{}');
  eq(hu.swordsman, 1, 'a1 剑客使用次数=1');
  const reps = await listReplays(a1.id, 10);
  eq(reps.length, 1, 'a1 回放行数=1');
  ok(reps[0].room_code === 'ROOM11', '回放 room_code 正确');
  const full = await getReplay(reps[0].id);
  ok(full && JSON.parse(full.events).stream.length === 1, '回放 events.stream 含 1 回合');
  // 游客对局不应产生游客自己的回放行（account_id=null 兜底一行）
  const allReps = await listReplays(a1.id, 10);
  eq(allReps.length, 1, '仅 a1 一行（无游客行）');

  // ---- 第二局：a1 平局 / a2 平局 ----
  await recordMatch({
    roomCode: 'ROOM12', mode: 'free', winner: null,
    players: [
      { accountId: a1.id, heroId: 'swordsman', result: 'draw' },
      { accountId: a2.id, heroId: 'miner', result: 'draw' },
    ],
    durationRounds: 8, stream: [],
  });
  const s1b = await getStats(a1.id);
  eq(s1b.games_played, 2, 'a1 场次累计=2');
  eq(s1b.draws, 1, 'a1 平局=1');
  const s2 = await getStats(a2.id);
  eq(s2.games_played, 1, 'a2 场次=1');
  eq(s2.draws, 1, 'a2 平局=1');

  // ---- 组队模式胜负归属 ----
  await recordMatch({
    roomCode: 'ROOM13', mode: 'team', winner: 0,
    players: [
      { accountId: a1.id, heroId: 'swordsman', result: 'win' },   // team 0 → 胜
      { accountId: a2.id, heroId: 'miner', result: 'loss' },       // team 1 → 负
    ],
    durationRounds: 5, stream: [],
  });
  const s1c = await getStats(a1.id);
  eq(s1c.wins, 2, 'a1 组队胜累计=2');
  const s2b = await getStats(a2.id);
  eq(s2b.losses, 1, 'a2 组队负=1');

  // ---- 收藏（unlocks 表复用）----
  await setFavorite(a1.id, 'swordsman', true);
  await setFavorite(a1.id, 'miner', true);
  let favs = await listFavorites(a1.id);
  ok(favs.includes('swordsman') && favs.includes('miner'), '收藏含 swordsman+miner');
  await setFavorite(a1.id, 'miner', false);
  favs = await listFavorites(a1.id);
  ok(favs.includes('swordsman') && !favs.includes('miner'), '取消收藏 miner 后只剩 swordsman');

  // ---- 房间码书签 ----
  const bmid = await addBookmark(a1.id, 'ROOM11', '老友房');
  ok(typeof bmid === 'string', '书签创建返回 id');
  let bms = await listBookmarks(a1.id);
  eq(bms.length, 1, '书签数=1');
  eq(bms[0].room_code, 'ROOM11', '书签 room_code 正确');
  const removed = await removeBookmark(a1.id, bmid!);
  ok(removed === true, '书签删除成功');
  bms = await listBookmarks(a1.id);
  eq(bms.length, 0, '书签删除后为空');

  // ---- 玩家偏好 ----
  const prefs = await updatePrefs(a1.id, { lastHero: 'swordsman', theme: 'dark' });
  eq(prefs.lastHero, 'swordsman', 'prefs.lastHero 写入');
  const gp = await getPrefs(a1.id);
  eq(gp.theme, 'dark', 'getPrefs 读回 theme');

  // ---- 经 handleApi 的 HTTP 路径（核心新增路由）----
  const me = await callApi('GET', '/api/me', undefined, t1);
  eq(me.code, 200, 'GET /api/me 200');
  ok(Array.isArray(me.json.favorites) && me.json.favorites.includes('swordsman'), '/api/me 返回收藏');
  ok(Array.isArray(me.json.bookmarks), '/api/me 返回书签数组');
  ok(me.json.stats && me.json.stats.wins === 2, '/api/me 返回战绩(wins=2)');

  const prefsApi = await callApi('PATCH', '/api/me/prefs', { lastHero: 'miner' }, t1);
  eq(prefsApi.code, 200, 'PATCH /api/me/prefs 200');
  eq(prefsApi.json.prefs.lastHero, 'miner', 'PATCH prefs 生效');

  const bmApi = await callApi('POST', '/api/me/bookmarks', { roomCode: 'ZZZ999', name: '测试' }, t1);
  eq(bmApi.code, 200, 'POST /api/me/bookmarks 200');
  eq(bmApi.json.bookmarks.length, 1, '书签列表含新项');

  const repsApi = await callApi('GET', '/api/me/replays?limit=5', undefined, t1);
  eq(repsApi.code, 200, 'GET /api/me/replays 200');
  ok(repsApi.json.replays.length >= 3, '回放列表 ≥3 条');

  const noAuth = await callApi('GET', '/api/me/stats');
  eq(noAuth.code, 401, '无 token 访问受保护接口 → 401');

  const disApi = await callApi('GET', '/api/me/bookmarks', undefined, 'bogus-token');
  eq(disApi.code, 401, '无效 token → 401');

  console.log(`\npersistence-test: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('persistence-test 异常:', e); process.exit(1); });
