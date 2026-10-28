// P14 验证：分布式下若房间归属已被其他实例夺走，本实例在下一回合应触发 fence-out
// 并中止本地循环、保留共享存储（不覆盖新主人的数据）。
import { Room } from './room.js';
import { createStorage } from './storage.js';
import { createState } from '../src/engine/game.js';

const mockIo: any = { to: () => ({ emit: () => {} }) };

// 模拟"归属在另一实例"的总线
const fakeBus: any = {
  distributed: true,
  getOwner: async () => 'inst-B', // 当前 owner 是别人
  claimOwner: async () => true,
  releaseOwner: async () => {},
  publish: () => {},
  subscribe: () => {},
  close: async () => {},
};

async function main() {
  const storage = await createStorage();
  const r = new Room('fen1', mockIo, storage, fakeBus, 'inst-A');
  (r as any).state = createState(['chef', 'vampire'], 1, 'free');
  await (r as any).persist();
  const ok = await r.recover();
  if (!ok) throw new Error('recover failed');

  // 等待异步 runLoop 跑到首个 runRound 触发 fence 校验并中止循环
  for (let i = 0; i < 40; i++) {
    if ((r as any).aborted) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  if (!(r as any).fencedOut) throw new Error('fence-out 未触发');
  if (!(r as any).aborted) throw new Error('fence 未中止本地循环');

  // 关键：被夺权时不应删除共享存储（归新主人）
  const stillThere = await storage.load('room:fen1');
  if (stillThere == null) throw new Error('fence-out 误删了共享存储');

  console.log('P14 脑裂隔离令牌: PASS (归属被夺后中止本地循环并保留存储)');
  process.exit(0);
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
