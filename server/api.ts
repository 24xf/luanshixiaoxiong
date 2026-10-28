// #18 Phase2 HTTP 接口：注册/登录/登出/查询当前账号。
// 同源部署（后端同时托管前端与 /api），无 CORS 问题；Vite dev 已把 /api 代理到后端。
// 鉴权：Bearer <token>（Authorization 头）或 ?token= 查询参数（便于本地测试）。
import { IncomingMessage, ServerResponse } from 'http';
import { register, login, getAccountById, getProfile, AuthError, AuthDisabledError } from './accounts.js';
import { createSession, getSessionAccountId, deleteSession } from './sessions.js';
import { dbEnabled } from './db/index.js';
import {
  getStats, listReplays, getReplay,
  setFavorite, listFavorites,
  addBookmark, listBookmarks, removeBookmark,
  updatePrefs,
} from './persistence.js';

function sendJson(res: ServerResponse, code: number, obj: any) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    const to = setTimeout(() => resolve({}), 5000);
    req.on('data', (c: any) => {
      data += c;
      if (data.length > 1_000_000) { req.destroy(); resolve({}); }
    });
    req.on('end', () => { clearTimeout(to); try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => { clearTimeout(to); resolve({}); });
  });
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (h && typeof h === 'string' && h.startsWith('Bearer ')) {
    const t = h.slice(7).trim();
    if (t) return t;
  }
  const q = (req.url || '').split('?')[1];
  if (q) { const m = q.match(/[?&]token=([^&]+)/); if (m) return decodeURIComponent(m[1]); }
  return null;
}

// 鉴权助手：返回 accountId，未登录则直接回 401 并返回 null（调用方据此 return）。
async function requireAuth(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const token = bearer(req);
  const aid = await getSessionAccountId(token);
  if (!aid) { sendJson(res, 401, { error: '未登录或会话已过期' }); return null; }
  return aid;
}

// 返回 true 表示已处理（无论成败）；false 表示不是 /api 请求，交给后续静态文件逻辑。
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const raw = (req.url || '').split('?')[0];
  if (!raw.startsWith('/api/')) return false;
  try {
    if (raw === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      const acc = await register(b.username, b.password);
      const token = await createSession(acc.id);
      sendJson(res, 200, { token, account: acc });
      return true;
    }
    if (raw === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const acc = await login(b.username, b.password);
      const token = await createSession(acc.id);
      sendJson(res, 200, { token, account: acc });
      return true;
    }
    if (raw === '/api/logout' && req.method === 'POST') {
      const token = bearer(req) || (await readBody(req)).token;
      await deleteSession(token);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (raw === '/api/me' && req.method === 'GET') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const token = bearer(req);
      const aid = await getSessionAccountId(token);
      if (!aid) { sendJson(res, 401, { error: '未登录或会话已过期' }); return true; }
      const acc = await getAccountById(aid);
      if (!acc) { sendJson(res, 401, { error: '账号不存在' }); return true; }
      const profile = await getProfile(aid);
      // #18 Phase3：附带收藏英雄与房间书签，减少前端请求数
      const favorites = await listFavorites(aid);
      const bookmarks = await listBookmarks(aid);
      const stats = await getStats(aid);
      sendJson(res, 200, { account: acc, profile, favorites, bookmarks, stats });
      return true;
    }
    // ---------- #18 Phase3：玩家偏好 ----------
    if (raw === '/api/me/prefs' && req.method === 'PATCH') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      const b = await readBody(req);
      if (!b || typeof b !== 'object') { sendJson(res, 400, { error: '非法请求体' }); return true; }
      const prefs = await updatePrefs(aid, b);
      sendJson(res, 200, { ok: true, prefs });
      return true;
    }
    // ---------- #18 Phase3：英雄收藏（unlocks 表作收藏集合）----------
    if (raw === '/api/me/favorites' && req.method === 'GET') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      sendJson(res, 200, { favorites: await listFavorites(aid) });
      return true;
    }
    if (raw === '/api/me/favorites' && req.method === 'POST') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      const b = await readBody(req);
      if (typeof b.heroId !== 'string') { sendJson(res, 400, { error: 'heroId 必填' }); return true; }
      await setFavorite(aid, b.heroId, b.favorited !== false);
      sendJson(res, 200, { ok: true, favorites: await listFavorites(aid) });
      return true;
    }
    if (raw.startsWith('/api/me/favorites/') && req.method === 'DELETE') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      const heroId = decodeURIComponent(raw.slice('/api/me/favorites/'.length));
      await setFavorite(aid, heroId, false);
      sendJson(res, 200, { ok: true, favorites: await listFavorites(aid) });
      return true;
    }
    // ---------- #18 Phase3：房间码书签 ----------
    if (raw === '/api/me/bookmarks' && req.method === 'GET') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      sendJson(res, 200, { bookmarks: await listBookmarks(aid) });
      return true;
    }
    if (raw === '/api/me/bookmarks' && req.method === 'POST') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      const b = await readBody(req);
      if (typeof b.roomCode !== 'string' || !b.roomCode) { sendJson(res, 400, { error: 'roomCode 必填' }); return true; }
      const id = await addBookmark(aid, b.roomCode.toUpperCase(), b.name ?? null);
      sendJson(res, 200, { ok: true, id, bookmarks: await listBookmarks(aid) });
      return true;
    }
    if (raw.startsWith('/api/me/bookmarks/') && req.method === 'DELETE') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      const id = decodeURIComponent(raw.slice('/api/me/bookmarks/'.length));
      const ok = await removeBookmark(aid, id);
      sendJson(res, ok ? 200 : 404, { ok });
      return true;
    }
    // ---------- #18 Phase3：战绩与回放 ----------
    if (raw === '/api/me/stats' && req.method === 'GET') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      sendJson(res, 200, { stats: await getStats(aid) });
      return true;
    }
    if (raw === '/api/me/replays' && req.method === 'GET') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const aid = await requireAuth(req, res); if (aid === null) return true;
      const limit = Math.min(100, Math.max(1, parseInt((req.url || '').split('limit=')[1] || '20') || 20));
      sendJson(res, 200, { replays: await listReplays(aid, limit) });
      return true;
    }
    if (raw.startsWith('/api/replays/') && req.method === 'GET') {
      if (!dbEnabled()) { sendJson(res, 503, { error: '账号系统未启用（服务器未配置数据库）' }); return true; }
      const id = decodeURIComponent(raw.slice('/api/replays/'.length));
      const rep = await getReplay(id);
      if (!rep) { sendJson(res, 404, { error: '回放不存在' }); return true; }
      sendJson(res, 200, { replay: rep });
      return true;
    }
    sendJson(res, 404, { error: '未知接口' });
    return true;
  } catch (e: any) {
    if (e instanceof AuthDisabledError) { sendJson(res, 503, { error: e.message }); return true; }
    if (e instanceof AuthError) { sendJson(res, 400, { error: e.message, code: e.code }); return true; }
    sendJson(res, 500, { error: '服务器错误' });
    return true;
  }
}
