// #18 Phase2 账号服务：argon2id 密码哈希 + 注册/登录/档案。
// 依赖 Phase1 的持久层（db 抽象）与缓存（cache 抽象）。
// 设计要点：
//  - 持久层未启用（DATABASE_URL 未设）→ 抛 AuthDisabledError，调用方转 503，游戏照常（游客模式）。
//  - 密码用 @node-rs/argon2 默认 argon2id 哈希，verify 失败一律按“凭证错误”，不泄露用户名是否存在。
//  - 注册同时建 profiles/stats 默认行，供 Phase3 写战绩。
import { randomUUID } from 'crypto';
import * as argon2 from '@node-rs/argon2';
import { getDb, dbEnabled } from './db/index.js';
import { log } from './log.js';

export class AuthError extends Error {
  code: string;
  constructor(msg: string, code = 'auth_error') { super(msg); this.code = code; }
}
export class AuthDisabledError extends AuthError {
  constructor() { super('账号系统未启用（服务器未配置数据库）', 'disabled'); }
}

function requireDb() {
  if (!dbEnabled()) throw new AuthDisabledError();
  return getDb();
}

// 用户名：3-20 位中英文/数字/下划线（覆盖“老友昵称”场景，又防注入/过长）。
const USERNAME_RE = /^[一-龥a-zA-Z0-9_]{3,20}$/;

export interface Account {
  id: string;
  username: string;
  displayName: string;
  createdAt: number;
  lastLoginAt: number | null;
}
export interface Profile { displayName: string; prefs: any; }

export async function register(username: string, password: string): Promise<Account> {
  const db = requireDb();
  username = (username || '').trim();
  if (!USERNAME_RE.test(username)) throw new AuthError('用户名需为 3-20 位中英文/数字/下划线', 'bad_username');
  if (!password || password.length < 6 || password.length > 64) throw new AuthError('密码需为 6-64 位', 'bad_password');
  const ex = await db.query('SELECT id FROM accounts WHERE username=$1', [username]);
  if (ex.length) throw new AuthError('用户名已被占用', 'username_taken');
  const hash = await argon2.hash(password);
  const id = randomUUID();
  const now = Date.now();
  await db.run('INSERT INTO accounts (id, username, password_hash, display_name, created_at, last_login_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, username, hash, username, now, now]);
  await db.run('INSERT INTO profiles (account_id, prefs, updated_at) VALUES ($1,$2,$3)', [id, '{}', now]);
  await db.run('INSERT INTO stats (account_id, updated_at) VALUES ($1,$2)', [id, now]);
  log.info('account_register', { id, username });
  return { id, username, displayName: username, createdAt: now, lastLoginAt: now };
}

export async function login(username: string, password: string): Promise<Account> {
  const db = requireDb();
  username = (username || '').trim();
  const rows = await db.query('SELECT * FROM accounts WHERE username=$1', [username]);
  // 凭证错误统一口径，不暴露用户名是否存在（防用户枚举）。
  if (!rows.length) throw new AuthError('用户名或密码错误', 'invalid_credentials');
  const acc = rows[0];
  let ok = false;
  try { ok = await argon2.verify(acc.password_hash, password); } catch { ok = false; }
  if (!ok) throw new AuthError('用户名或密码错误', 'invalid_credentials');
  const now = Date.now();
  await db.run('UPDATE accounts SET last_login_at=$1 WHERE id=$2', [now, acc.id]);
  return { id: acc.id, username: acc.username, displayName: acc.display_name || acc.username, createdAt: acc.created_at, lastLoginAt: now };
}

export async function getAccountById(id: string): Promise<Account | null> {
  if (!dbEnabled()) return null;
  const rows = await getDb().query('SELECT * FROM accounts WHERE id=$1', [id]);
  if (!rows.length) return null;
  const acc = rows[0];
  return { id: acc.id, username: acc.username, displayName: acc.display_name || acc.username, createdAt: acc.created_at, lastLoginAt: acc.last_login_at };
}

export async function getProfile(accountId: string): Promise<Profile> {
  const db = requireDb();
  let prefs: any = {};
  const rows = await db.query('SELECT prefs FROM profiles WHERE account_id=$1', [accountId]);
  if (rows.length) { try { prefs = JSON.parse(rows[0].prefs || '{}'); } catch { prefs = {}; } }
  const acc = await getAccountById(accountId);
  return { displayName: acc?.displayName || '', prefs };
}

export async function updateProfile(accountId: string, displayName?: string, prefs?: any): Promise<void> {
  const db = requireDb();
  if (displayName !== undefined) {
    const dn = (displayName || '').trim().slice(0, 20);
    await db.run('UPDATE accounts SET display_name=$1 WHERE id=$2', [dn || null, accountId]);
  }
  if (prefs !== undefined) {
    await db.run('UPDATE profiles SET prefs=$1, updated_at=$2 WHERE account_id=$3', [JSON.stringify(prefs || {}), Date.now(), accountId]);
  }
}
