// 崩溃一致性恢复测试（#1）：不依赖 Redis，用内存存储模拟"进程崩溃→重启重建房间"。
// 流程：房间 A 跑几回合并持久化 → 销毁 A（模拟崩溃）→ 房间 B 从同一存储 recover → 断言状态/成员/英雄序恢复，且能继续跑完（AI 托管驱动）。
import { Room } from './room.js';
import type { Storage } from './storage.js';

class MemStorage implements Storage {
  m = new Map<string, string>();
  async save(id: string, data: string) { this.m.set(id, data); }
  async load(id: string) { return this.m.get(id) ?? null; }
  async del(id: string) { this.m.delete(id); }
  async keys(p: string) { return [...this.m.keys()].filter((k) => k.startsWith(p)); }
}

function fakeIo(): any {
  return { to: () => ({ emit: () => {} }), engine: { clientsCount: 0 } };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const storage = new MemStorage();
  const io = fakeIo();

  // --- 实例 1：房间 A 运行并持久化 ---
  const A = new Room('r1', io, storage);
  A.addMember('chef');
  A.addMember('vampire');
  if (!A.startGame()) throw new Error('startGame 失败');
  await sleep(1500); // 跑若干回合，触发多次 persist

  const saved = storage.m.get('room:r1');
  if (!saved) throw new Error('未检测到持久化数据');
  const parsed = JSON.parse(saved);
  console.log(`[recovery-test] A 持久化: turn=${parsed.state.turn} members=${parsed.members.length} heroIds=${parsed.heroIds.length}`);
  if (parsed.members.length !== 2) throw new Error('持久化成员数错误');
  if (parsed.heroIds.length !== 2) throw new Error('持久化英雄序错误');

  // --- 模拟崩溃：kill -9 不会执行 destroy，存储保留。这里仅中止 A 的循环（不删存储）---
  (A as any).aborted = true;
  (A as any).running = false;
  await sleep(100);

  // --- 实例 2：从存储恢复 ---
  const B = new Room('r1', io, storage);
  const ok = await B.recover();
  if (!ok) throw new Error('recover 返回 false');
  if ((B as any).members.size !== 2) throw new Error('恢复后成员数错误');
  if ((B as any).heroIds.length !== 2) throw new Error('恢复后英雄序错误');
  const turnAfter = (B as any).state.turn;
  console.log(`[recovery-test] B 恢复: turn=${turnAfter} running=${(B as any).running}`);

  // --- 断言：无客户端时，AI 托管驱动游戏跑到结束 ---
  // 注：托管 AI 现已会建工事/用技能（#14），bot-only 对局节奏接近自对弈（约 60 回合），
  // 故时限放宽到 60s（旧 20s 仅因旧 AI 只平A、屠戮过快）。
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await sleep(500);
    if ((B as any).state && (B as any).state.phase === 'over') break;
  }
  const phase = (B as any).state?.phase;
  if (phase !== 'over') { B.destroy(); throw new Error(`恢复后游戏未在时限内结束（phase=${phase}），疑似调度阻塞`); }
  console.log(`[recovery-test] B 恢复后由 AI 托管跑完，winner=${(B as any).state.winner}`);
  B.destroy();
  console.log('[recovery-test] ✅ 通过：崩溃一致性恢复 + AI 托管续跑 均正常');
}

// ---- #11 回归：已结束房间恢复后需安排销毁 + 重连历史字段恢复 ----
async function overRecoverTest() {
  const storage = new MemStorage();
  const io = fakeIo();

  const C = new Room('r2', io, storage);
  C.addMember('miner');
  C.addMember('swordsman');
  if (!C.startGame()) throw new Error('startGame(C) 失败');
  await sleep(800);
  // 先写入上回合历史，确保 persist 包含它们（#11 要恢复这些字段）
  (C as any).lastThrows = { 0: '数', 1: '物' };
  (C as any).lastResults = { 0: 'win', 1: 'lose' };
  await (C as any).persist();
  // 模拟房间已在 gameOver 后、destroy 前崩溃：状态为 over 但仍留在存储
  (C as any).state.phase = 'over';
  (C as any).state.winner = 0;
  await (C as any).persist();
  (C as any).aborted = true;
  (C as any).running = false;
  await sleep(100);

  const D = new Room('r2', io, storage);
  const ok = await D.recover();
  if (!ok) throw new Error('#11 over-room recover 返回 false');
  if ((D as any).running !== false) throw new Error('#11 已结束房间 running 应为 false');
  // 关键：恢复后必须安排销毁，否则成僵尸房间常驻内存/存储
  if (!(D as any).ttlTimer) throw new Error('#11 已结束房间恢复后未安排销毁（ttlTimer 为空）→ 僵尸房间');
  // 重连历史字段必须恢复，否则客户端首回合无上回合出拳/输赢
  if (JSON.stringify((D as any).lastThrows) !== JSON.stringify({ 0: '数', 1: '物' })) throw new Error('#11 重连历史 lastThrows 未恢复');
  if (JSON.stringify((D as any).lastResults) !== JSON.stringify({ 0: 'win', 1: 'lose' })) throw new Error('#11 重连历史 lastResults 未恢复');
  console.log('[recovery-test] #11 已结束房间: running=false, 已安排销毁, 历史字段已恢复');
  (D as any).cancelDestroy();
  (D as any).destroy();
}

(async () => {
  try {
    await main();
    await overRecoverTest();
    console.log('[recovery-test] ✅ 全部通过：崩溃一致性恢复 + AI 托管续跑 + #11 已结束房间清理/历史恢复');
    process.exit(0);
  } catch (e) { console.error('[recovery-test] ❌', e); process.exit(1); }
})();
