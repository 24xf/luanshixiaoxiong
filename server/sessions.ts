// #18 Phase2 会话服务：令牌签发/校验/注销。
// 存储：缓存（Redis 生产 / 内存本地）为主，DB sessions 表为辅（跨实例/重启后仍能校验）。
// 缓存命中即返回；未命中回退 DB（并重新回填缓存）；过期行顺手清理。
import { randomUUID } from 'crypto';
import { getCache } from './cache/index.js';
import { getDb, dbEnabled } from './db/index.js';
import { log } from './log.js';

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 天（秒）

export async function createSession(accountId: string): Promise<string> {
  // 足够长的随机串，抗猜测。
  const token = randomUUID() + randomUUID().replace(/-/g, '');
  const expires = Date.now() + SESSION_TTL * 1000;
  getCache().set('sess:' + token, accountId, SESSION_TTL);
  if (dbEnabled()) {
    try {
      await getDb().run('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ($1,$2,$3,$4)',
        [token, accountId, Date.now(), expires]);
    } catch (e) {
      log.warn('session_persist_fail', { err: (e as Error).message });
    }
  }
  return token;
}

export async function getSessionAccountId(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const c = getCache();
  const cached = await c.get('sess:' + token);
  if (cached) return cached;
  if (!dbEnabled()) return null;
  try {
    const rows = await getDb().query('SELECT account_id, expires_at FROM sessions WHERE token=$1', [token]);
    if (!rows.length) return null;
    if (rows[0].expires_at > Date.now()) {
      const aid = rows[0].account_id;
      c.set('sess:' + token, aid, Math.max(1, Math.floor((rows[0].expires_at - Date.now()) / 1000)));
      return aid;
    }
    // 过期：清理脏数据
    await getDb().run('DELETE FROM sessions WHERE token=$1', [token]);
  } catch (e) {
    log.warn('session_lookup_fail', { err: (e as Error).message });
  }
  return null;
}

export async function deleteSession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  getCache().del('sess:' + token);
  if (dbEnabled()) {
    try { await getDb().run('DELETE FROM sessions WHERE token=$1', [token]); } catch { /* 忽略 */ }
  }
}
