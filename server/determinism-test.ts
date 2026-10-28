// P9 验证：RNG 内部状态可被持久化并在恢复后续接随机序列（支持可靠录像/回放）。
import { Room } from './room.js';
import { createStorage } from './storage.js';
import { LocalBus } from './bus.js';
import { createState } from '../src/engine/game.js';

const mockIo: any = { to: () => ({ emit: () => {} }) };

// 与 room.ts 内联的 mulberry32 完全一致的参考实现
function refRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = a; x |= 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const storage = await createStorage();
  const bus = new LocalBus();
  const SEED = 987654321 >>> 0;

  // 房间 A：手动置入状态与 RNG 状态，持久化（phase=over 避免恢复时触发后台循环）
  const A = new Room('det1', mockIo, storage, bus, 'inst-A');
  (A as any).state = createState(['chef', 'vampire'], 111, 'free');
  (A as any).state.phase = 'over';
  (A as any).rngState = SEED;
  await (A as any).persist();

  const raw = await storage.load('room:det1');
  const obj = JSON.parse(raw as string);
  if (obj.rngState !== SEED) throw new Error('persist 未存 rngState');

  // 房间 B：从存储恢复
  const B = new Room('det1', mockIo, storage, bus, 'inst-A');
  const ok = await B.recover();
  if (!ok) throw new Error('recover 失败');
  if ((B as any).rngState !== SEED) throw new Error('recover 未还原 rngState: ' + (B as any).rngState);

  // 恢复后随机序列必须与参考实现一致（即从 SEED 续接）
  const ref = refRng(SEED);
  for (let i = 0; i < 5; i++) {
    const got = (B as any).rng();
    const exp = ref();
    if (got !== exp) throw new Error(`恢复后随机序列不一致 @${i}: got=${got} exp=${exp}`);
  }

  console.log('P9 确定性 RNG 持久化/恢复: PASS (rngState 续接随机序列一致)');
  (B as any).aborted = true;
  (B as any).destroy();
  process.exit(0);
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
