// 总线 + 房间归属注册表原语测试（#2 基础）：验证 claimOwner/getOwner/releaseOwner 的
// 单实例独占 + 同实例刷新 + 释放后再认领，以及 pub/sub 跨"实例"投递（横向扩展转发基石）。
import { LocalBus, RedisBus } from './bus.js';
import { log } from './log.js';

async function main() {
  const b: any = new LocalBus();

  // --- 归属注册表 ---
  if (!(await b.claimOwner('r1', 'A', 1000))) throw new Error('A 首次认领失败');
  if ((await b.getOwner('r1')) !== 'A') throw new Error('owner 应为 A');
  // 其他实例在被 A 持有期间不能认领
  if (await b.claimOwner('r1', 'B', 1000)) throw new Error('B 不应在 A 持有期间认领');
  // 同实例刷新 TTL 应成功
  if (!(await b.claimOwner('r1', 'A', 1000))) throw new Error('A 刷新 TTL 失败');
  await b.releaseOwner('r1');
  if ((await b.getOwner('r1')) !== null) throw new Error('释放后 owner 应清空');
  if (!(await b.claimOwner('r1', 'B', 1000))) throw new Error('B 释放后应能认领');

  // --- pub/sub 投递 ---
  let got: any = null;
  b.subscribe('intent:all', (m: any) => { got = m; });
  b.publish('intent:all', { kind: 'throw', roomId: 'r1', token: 'x' });
  await new Promise((r) => setTimeout(r, 50));
  if (!got || got.kind !== 'throw' || got.roomId !== 'r1') throw new Error('pub/sub 投递失败');

  // --- #12 回归：RedisBus.publish 底层抛错时必须记录日志，而非静默吞掉（否则横向扩展丢意图无感知）---
  let errLogged = false;
  const origError = (log as any).error;
  (log as any).error = (..._a: any[]) => { errLogged = true; };
  const fakePub: any = {
    publish: () => { throw new Error('redis down'); },
    set: async () => 'OK', get: async () => null, del: async () => {},
  };
  const fakeSub: any = { on: () => {}, subscribe: async () => {} };
  const rb: any = new RedisBus(fakePub, fakeSub);
  rb.publish('intent:all', { kind: 'throw' }); // 不应抛异常（内部已捕获）
  (log as any).error = origError;
  if (!errLogged) throw new Error('#12 RedisBus.publish 失败未记录日志（静默吞掉）');

  console.log('[bus-test] ✅ 通过：归属注册表单实例独占/刷新/释放 + pub/sub 转发 + #12 失败记日志 均正常');
}
main().catch((e) => { console.error('[bus-test] ❌', e); process.exit(1); });
