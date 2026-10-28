// #18 Phase 1 集成测试：端到端验证持久层抽象 + 迁移 + 缓存。
// 运行方式：
//  - 默认（无 DATABASE_URL）：configureDb 判定 disabled → 直接跳过（不影响现有 npm test）。
//  - 本地真实验证：npm run test:db （设 DATABASE_URL=sqlite::memory: + --experimental-sqlite）。
//  - 生产验证：DATABASE_URL=postgres://... npm run test:db
import { configureDb, initDb } from './index.js';
import { initCache } from '../cache/index.js';

function assert(cond: any, msg: string): void {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

async function main(): Promise<void> {
  const cfg = configureDb();
  if (cfg.dialect === 'disabled') {
    console.log('[db-test] DATABASE_URL 未设置 → 持久层禁用，跳过集成测试');
    process.exit(0);
  }
  console.log('[db-test] dialect =', cfg.dialect);

  const db = await initDb();
  assert(db, 'initDb 应返回非 null 的 Db 实例');

  // 账号写入 / 查询
  const id = 'u_' + Date.now();
  const username = 'alice_' + id;
  await db!.run(
    'INSERT INTO accounts (id, username, password_hash, display_name, created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, username, 'hash', 'Alice', Date.now()],
  );
  const rows = await db!.query('SELECT id, username FROM accounts WHERE username = $1', [username]);
  assert(rows.length === 1 && rows[0].id === id, '账号插入/查询应返回 1 行且 id 匹配');

  // 回放表（JSON TEXT 列）写入 / 查询
  await db!.run(
    'INSERT INTO replays (id, created_at, players, events, result) VALUES ($1,$2,$3,$4,$5)',
    ['r_' + id, Date.now(), '[]', '[{"t":1}]', 'null'],
  );
  const rp = await db!.query('SELECT id FROM replays WHERE id = $1', ['r_' + id]);
  assert(rp.length === 1, '回放记录应写入并可查');

  // 缓存 set/get/del
  const c = await initCache();
  await c.set('k', 'v', 30);
  assert((await c.get('k')) === 'v', '缓存 set/get 应一致');
  await c.del('k');
  assert((await c.get('k')) === null, '缓存 del 后应为 null');

  console.log('[db-test] 集成测试通过 (' + cfg.dialect + ')');
  await db!.close();
  process.exit(0);
}

main().catch((e) => { console.error('[db-test] 异常:', e); process.exit(1); });
