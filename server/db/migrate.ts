// 迁移运行器：按方言读取对应 .sql 并执行，已执行的版本记入 _luanshi_migrations 表，避免重复执行。
import { readFileSync } from 'fs';
import type { Db, Dialect } from './index.js';

// 已知迁移版本（顺序）。新增迁移在此追加，文件名须与版本号一致。
const VERSIONS = ['001_init', '002_mode'];

export async function runMigrations(db: Db, dialect: Dialect): Promise<void> {
  await db.exec(
    dialect === 'sqlite'
      ? 'CREATE TABLE IF NOT EXISTS _luanshi_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
      : 'CREATE TABLE IF NOT EXISTS _luanshi_migrations (version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)',
  );
  const rows = await db.query('SELECT version FROM _luanshi_migrations');
  const applied = new Set(rows.map((r: any) => String(r.version)));
  for (const v of VERSIONS) {
    if (applied.has(v)) continue;
    const sql = readFileSync(new URL(`./migrations/${dialect}/${v}.sql`, import.meta.url), 'utf8');
    if (dialect === 'sqlite') {
      await db.exec(sql); // node:sqlite 的 exec 原生支持多语句
    } else {
      for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
        await db.exec(stmt);
      }
    }
    await db.run('INSERT INTO _luanshi_migrations (version, applied_at) VALUES ($1, $2)', [v, Date.now()]);
  }
}
