// 真人长局内存防线测试：
// A. replayLog 滑动窗口（REPLAY_MAX_SNAPS）：总回合数超过窗口后，仅最近 N 条保留 snap 快照，
//    更旧条目只留事件流（turn/throws/actions/log 仍在）→ 单房内存有硬上界。
// B. 空转房 TTL（IDLE_ROOM_TTL）：运行中的房间全员离线 → 到期自动 destroy + 清持久化键；
//    有人重连（attachSocket）→ 计时器取消，房间存活。
// 两者均为纯内存策略，不改任何游戏规则/技能效果。
process.env.REPLAY_MAX_SNAPS = '3';   // 窗口调小便于测试
process.env.IDLE_ROOM_TTL = '5000';   // TTL 调短便于测试（生产默认 10 分钟）
process.env.REPLAY_MODE = 'all';

import type { Storage } from './storage.js';

class MemStorage implements Storage {
  m = new Map<string, string>();
  async save(id: string, data: string) { this.m.set(id, data); }
  async load(id: string) { return this.m.get(id) ?? null; }
  async del(id: string) { this.m.delete(id); }
  async keys(p: string) { return [...this.m.keys()].filter((k) => k.startsWith(p)); }
}
function fakeIo(): any { return { to: () => ({ emit: () => {} }), engine: { clientsCount: 0 } }; }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
let pass = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { console.error(`[memcap-test] ❌ ${msg}`); process.exit(1); }
  pass++; console.log(`[memcap-test] ✅ ${msg}`);
}

async function main() {
  // 动态导入：确保上面的 env 在 room.ts 模块级常量求值之前生效
  const { Room } = await import('./room.js');

  // ---------- A. replayLog 滑动窗口 ----------
  {
    const storage = new MemStorage();
    const room = new Room('mem-a', fakeIo(), storage);
    const t0 = (room.addMember('chef') as any).token;
    const t1 = (room.addMember('vampire') as any).token;
    const t2 = (room.addMember('miner') as any).token;
    room.attachSocket(t0, 's0');
    room.attachSocket(t1, 's1');
    room.attachSocket(t2, 's2');
    if (!room.startGame()) throw new Error('startGame 失败');
    // 全员离线 → AI 托管快速推进（离线托管延迟 800ms/回合）
    room.detachSocket('s0');
    room.detachSocket('s1');
    room.detachSocket('s2');
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await sleep(500);
      const st: any = (room as any).state;
      if (!st || st.phase === 'over') break;
      if ((room as any).replayLog.length >= 7) break; // 攒够窗口外样本即可，无需打完
    }
    const rl: any[] = (room as any).replayLog;
    ok(rl.length > 3, `总回合数超过窗口（entries=${rl.length} > 3）`);
    const withSnap = rl.filter((e) => e.snap).length;
    ok(withSnap <= 3, `snap 快照数被窗口限制（withSnap=${withSnap} ≤ 3）`);
    // 最近 3 条必须有 snap（回放播放器仍可视化最近窗口）
    const recent = rl.slice(-Math.min(3, rl.length));
    ok(recent.every((e) => !!e.snap), '最近窗口内条目全部保留 snap');
    // 窗口外最旧条目：snap 被丢，但事件流字段完整（可降级纯文字回放）
    const oldest = rl[0];
    ok(!oldest.snap, '窗口外最旧条目 snap 已释放');
    ok(typeof oldest.turn === 'number' && oldest.throws && oldest.log !== undefined, '窗口外条目事件流字段完整（turn/throws/log）');
    room.destroy();
  }

  // ---------- B1. 空转房 TTL：全员离线到期自动销毁 + 清持久化 ----------
  {
    const storage = new MemStorage();
    const room = new Room('mem-b1', fakeIo(), storage);
    room.setSandbox(true); // 沙盒房无托管计时器，无限等结算——正是僵尸房场景
    const t0 = (room.addMember('chef') as any).token;
    room.attachSocket(t0, 's0');
    let destroyed = false;
    room.onDestroyed = () => { destroyed = true; };
    if (!room.startGame()) throw new Error('sandbox startGame 失败');
    await sleep(300);
    room.detachSocket('s0'); // 全员离线 → 启动 5s TTL
    await sleep(7000);
    ok(destroyed, '沙盒僵尸房：全员离线 5s TTL 到期自动销毁');
    ok((storage.m.get('room:mem-b1') ?? null) === null, '销毁时持久化键已清除（Redis 不留垃圾）');
  }

  // ---------- B2. 空转房 TTL：有人重连则取消，房间存活 ----------
  {
    const storage = new MemStorage();
    const room = new Room('mem-b2', fakeIo(), storage);
    room.setSandbox(true);
    const t0 = (room.addMember('chef') as any).token;
    room.attachSocket(t0, 's0');
    let destroyed = false;
    room.onDestroyed = () => { destroyed = true; };
    if (!room.startGame()) throw new Error('sandbox startGame 失败');
    await sleep(300);
    room.detachSocket('s0');       // 启动 TTL
    await sleep(2000);
    room.attachSocket(t0, 's0b');  // TTL 到期前重连 → 应取消计时器
    await sleep(5000);             // 越过原 TTL 时刻
    ok(!destroyed, '重连取消 TTL：越过原到期时刻房间仍存活');
    room.destroy();
  }

  console.log(`[memcap-test] 全部通过（${pass} 断言）`);
}
main().catch((e) => { console.error('[memcap-test] ❌', e); process.exit(1); });
