// #18 Phase2 前端账号模块：本地存 token/账号，封装注册/登录/登出/查询。
// 与后端 /api/* 同源（dev 下经 Vite 代理到 :3000）。
const TOKEN_KEY = 'ls_auth_token';
const ACCOUNT_KEY = 'ls_auth_account';

function safeGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } }
function safeDel(k: string) { try { localStorage.removeItem(k); } catch { /* 忽略 */ } }

export function getToken(): string | null { return safeGet(TOKEN_KEY); }
export function getAccount(): any | null {
  const a = safeGet(ACCOUNT_KEY);
  if (!a) return null;
  try { return JSON.parse(a); } catch { return null; }
}
export function setAuth(token: string, account: any) { safeSet(TOKEN_KEY, token); safeSet(ACCOUNT_KEY, JSON.stringify(account)); }
export function clearAuth() { safeDel(TOKEN_KEY); safeDel(ACCOUNT_KEY); }

async function postJson(url: string, body: any): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('请求失败 ' + r.status));
  return data;
}

export async function register(username: string, password: string): Promise<{ token: string; account: any }> {
  return postJson('/api/register', { username, password });
}
export async function login(username: string, password: string): Promise<{ token: string; account: any }> {
  return postJson('/api/login', { username, password });
}
export async function logout(): Promise<void> {
  const t = getToken();
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (t || '') },
      body: JSON.stringify({ token: t }),
    });
  } catch { /* 忽略网络错误，本地清除即可 */ }
  clearAuth();
}
export async function fetchMe(): Promise<{ account: any; profile: any; favorites?: any[]; bookmarks?: any[]; stats?: any } | null> {
  const t = getToken();
  if (!t) return null;
  try {
    const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) { clearAuth(); return null; }
    return await r.json();
  } catch { return null; }
}

// #18 Phase3：以下接口需登录态；未登录（游客）直接 resolve 为空，不抛错（前端据此降级为不展示）。
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t } : { 'Content-Type': 'application/json' };
}
async function apiReq(url: string, method: string, body?: any): Promise<any> {
  const opt: any = { method, headers: authHeaders() };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('请求失败 ' + r.status));
  return data;
}
export function updatePrefs(prefs: Record<string, any>): Promise<any> { return apiReq('/api/me/prefs', 'PATCH', prefs); }
export function toggleFavorite(heroId: string, favorited: boolean): Promise<any> {
  return apiReq('/api/me/favorites', 'POST', { heroId, favorited });
}
export function addBookmark(roomCode: string, name?: string): Promise<any> {
  return apiReq('/api/me/bookmarks', 'POST', { roomCode, name });
}
export function removeBookmark(id: string): Promise<any> { return apiReq('/api/me/bookmarks/' + encodeURIComponent(id), 'DELETE'); }
export function getStats(): Promise<any> { return apiReq('/api/me/stats', 'GET'); }
export function getReplays(limit = 20): Promise<any> { return apiReq('/api/me/replays?limit=' + limit, 'GET'); }
export function getReplay(id: string): Promise<any> { return apiReq('/api/replays/' + encodeURIComponent(id), 'GET'); }
