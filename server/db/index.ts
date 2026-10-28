// 持久层统一抽象：PostgreSQL(生产) / SQLite(本地开发测试，Node 内置 node:sqlite) / 未启用(游客模式)。
// 设计要点：
//  - 占位符统一用 $1,$2...（pg 原生支持；sqlite 分支改写为 ?）。
//  - JSON 统一存 TEXT、时间戳用 INTEGER，最大化两方言可移植。
//  - 未设置 DATABASE_URL → 完全禁用，保持现有行为零回归（游客可玩、不持久化）。
//  - SQLite 通过“动态 import('node:sqlite')”隔离，避免无 --experimental-sqlite 时模块不存在导致崩溃。
//  - 初始化失败不致命：返回 null，游戏照常运行（仅无持久化）。
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { log } from '../log.js';
import { runMigrations } from './migrate.js';

export type Dialect = 'disabled' | 'postgres' | 'sqlite';

export interface DbConfig { dialect: Dialect; dsn: string; enabled: boolean; }

let config: DbConfig | null = null;
export function configureDb(): DbConfig {
  if (config) return config;
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) { config = { dialect: 'disabled', dsn: '', enabled: false }; return config; }
  if (/^postgres(ql)?:\/\//i.test(url)) config = { dialect: 'postgres', dsn: url, enabled: true };
  else if (/^sqlite(:\/\/)?/i.test(url) || /\.(db|sqlite|sqlite3)$/i.test(url)) {
    let p = url;
    if (/^sqlite:\/\//i.test(p)) p = p.slice('sqlite://'.length);
    else if (/^sqlite:/i.test(p)) p = p.slice('sqlite:'.length);
    config = { dialect: 'sqlite', dsn: p || ':memory:', enabled: true };
  } else { config = { dialect: 'disabled', dsn: '', enabled: false }; }
  return config;
}

export interface Db {
  dialect: Dialect;
  query(sql: string, params?: any[]): Promise<any[]>;
  run(sql: string, params?: any[]): Promise<{ changes: number; lastId: any }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isOpen(): boolean;
}

let active: Db | null = null;
let initPromise: Promise<Db | null> | null = null;

export function dbEnabled(): boolean { return active !== null; }
export function dbDialect(): Dialect { return active ? active.dialect : configureDb().dialect; }
export function getDb(): Db { if (!active) throw new Error('数据库未初始化或未启用'); return active; }

export async function initDb(): Promise<Db | null> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = configureDb();
    if (!cfg.enabled) {
      log.info('db', { status: 'disabled', note: '未设置 DATABASE_URL，持久层关闭（游客模式）' });
      return null;
    }
    try {
      const db = cfg.dialect === 'postgres' ? await createPg(cfg.dsn) : await createSqlite(cfg.dsn);
      await runMigrations(db, cfg.dialect);
      active = db;
      log.info('db', { status: 'ready', dialect: cfg.dialect });
      return db;
    } catch (e) {
      log.error('db_init_fail', { dialect: cfg.dialect, err: (e as Error).message });
      active = null;
      return null;
    }
  })();
  return initPromise;
}

async function createPg(dsn: string): Promise<Db> {
  const { Pool } = await import('pg');
  const pool: any = new Pool({ connectionString: dsn });
  await pool.query('SELECT 1');
  const impl: Db = {
    dialect: 'postgres',
    async query(sql, params = []) { const r = await pool.query(sql, params); return r.rows; },
    async run(sql, params = []) { const r = await pool.query(sql, params); return { changes: r.rowCount ?? 0, lastId: undefined }; },
    async exec(sql) { await pool.query(sql); },
    async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const out = await fn(impl); await client.query('COMMIT'); return out; }
      catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    },
    async close() { await pool.end(); },
    isOpen: () => !pool.ended,
  };
  return impl;
}

async function createSqlite(dsn: string): Promise<Db> {
  if (dsn !== ':memory:') mkdirSync(dirname(dsn), { recursive: true });
  const sqliteSpec = 'node:sqlite';
  const { DatabaseSync } = (await import(sqliteSpec)) as any;
  const conn: any = new DatabaseSync(dsn);
  conn.exec('PRAGMA foreign_keys = ON;');
  const impl: Db = {
    dialect: 'sqlite',
    async query(sql, params = []) { const stmt = conn.prepare(sql.replace(/\$\d+/g, '?')); return stmt.all(...params); },
    async run(sql, params = []) { const stmt = conn.prepare(sql.replace(/\$\d+/g, '?')); const r = stmt.run(...params); return { changes: r.changes, lastId: r.lastInsertRowid }; },
    async exec(sql) { conn.exec(sql); },
    async transaction(fn) {
      conn.exec('BEGIN');
      try { const out = await fn(impl); conn.exec('COMMIT'); return out; }
      catch (e) { conn.exec('ROLLBACK'); throw e; }
    },
    async close() { conn.close(); },
    isOpen: () => true,
  };
  return impl;
}
