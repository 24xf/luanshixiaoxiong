// 分座次（战前准备）验证：
// 1) 座次是 1..N 的一个排列（不重不漏）
// 2) 同种子确定性一致（崩溃恢复可复现）
// 3) 与进房顺序不同（确实被打乱了）
import { createState, assignSeatsRandom } from '../src/engine/game.js';
import { makeRng } from '../src/types.js';

const heroes = ['chef', 'vampire', 'miner', 'doctor', 'police', 'farmer', 'carpenter', 'swordsman'];
const N = heroes.length;

function seatsOf(seed: number) {
  const s: any = createState(heroes, 1, 'free', 'five');
  assignSeatsRandom(s, makeRng(seed));
  return s.players.map((p: any) => p.seat);
}

// 1) 排列性
const a = seatsOf(42).slice().sort((x: number, y: number) => x - y);
const expect = Array.from({ length: N }, (_, i) => i + 1);
const isPerm = JSON.stringify(a) === JSON.stringify(expect);

// 2) 确定性
const b = seatsOf(42);
const c = seatsOf(42);
const det = JSON.stringify(b) === JSON.stringify(c);

// 3) 至少在一些种子下被打乱（不与进房顺序全等）
let shuffledSomewhere = false;
for (let sd = 1; sd <= 20; sd++) {
  const s = seatsOf(sd);
  if (s.some((v: number, i: number) => v !== i + 1)) { shuffledSomewhere = true; break; }
}

if (isPerm && det && shuffledSomewhere) {
  console.log('PASS: 座次=1..N排列, 同种子确定性一致, 且确实打乱了进房顺序');
  console.log('  示例(种子42):', seatsOf(42).join(','));
  process.exit(0);
} else {
  console.log('FAIL', { isPerm, det, shuffledSomewhere });
  process.exit(1);
}
