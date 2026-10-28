// #18 Phase2 认证集成测试（SQLite 内存）：注册/登录/会话/查询/登出 全链路。
// 运行：npm run test:auth（已自动设 DATABASE_URL=sqlite::memory: + --experimental-sqlite）。
// 若持久层未启用（无 DATABASE_URL）→ 自动跳过，不报错（与 npm test 默认模式一致）。
import { configureDb, initDb, getDb, dbEnabled } from './db/index.js';
import { initCache } from './cache/index.js';
import { register, login, getAccountById, getProfile } from './accounts.js';
import { createSession, getSessionAccountId, deleteSession } from './sessions.js';

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}

async function main() {
  configureDb();
  await initDb();
  await initCache();
  if (!dbEnabled()) { console.log('auth-test: 持久层未启用，跳过'); process.exit(0); }
  const db = getDb();

  // 注册
  const acc = await register('alice_01', 'secret123');
  ok(!!acc.id, 'register 返回 id');
  ok(acc.username === 'alice_01', 'username 正确');
  ok(acc.displayName === 'alice_01', '默认 displayName=username');

  // 重复用户名被拒
  let dup = false; try { await register('alice_01', 'x'); } catch { dup = true; }
  ok(dup, '重复用户名被拒');

  // 短用户名被拒
  let badUser = false; try { await register('ab', 'x12345'); } catch { badUser = true; }
  ok(badUser, '短用户名被拒');

  // 短密码被拒
  let badPw = false; try { await register('bob_02', '123'); } catch { badPw = true; }
  ok(badPw, '短密码被拒');

  // 错误密码登录被拒
  let wrong = false; try { await login('alice_01', 'wrong'); } catch { wrong = true; }
  ok(wrong, '错误密码登录被拒');

  // 正确登录
  const acc2 = await login('alice_01', 'secret123');
  ok(acc2.id === acc.id, 'login 返回同一账号');

  // 会话签发 + 持久化到 DB
  const token = await createSession(acc.id);
  ok(typeof token === 'string' && token.length > 0, 'createSession 返回 token');
  const srows = await db.query('SELECT * FROM sessions WHERE token=$1', [token]);
  ok(srows.length === 1, 'session 持久化到 DB');

  // 会话校验还原 accountId
  const aid = await getSessionAccountId(token);
  ok(aid === acc.id, 'getSessionAccountId 还原 accountId');

  // 账号查询 + 档案
  const me = await getAccountById(acc.id);
  ok(!!me && me.username === 'alice_01', 'getAccountById');
  const prof = await getProfile(acc.id);
  ok(prof && typeof prof === 'object' && prof.prefs && typeof prof.prefs === 'object', 'getProfile 返回对象');

  // 登出后令牌失效
  await deleteSession(token);
  const after = await getSessionAccountId(token);
  ok(after === null, 'deleteSession 后令牌失效');

  console.log(`\nauth-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('auth-test error:', e); process.exit(1); });
