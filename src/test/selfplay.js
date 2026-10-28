// AI 自对弈压力测试：跑 N 局，验证无崩溃/死循环/负血/异常终局
import { makeRng } from '../types.js';
import { createState, advanceRound } from '../engine/game.js';
import { decideAll } from '../ai/bot.js';
import { FIRST_BATCH } from '../engine/heroes/index.js';

const N = Number(process.argv[2] || 200);
const useRandom = process.argv.includes('--random');
const MAX_TURNS = 500;

// 从第一批英雄里随机选 n 个（不重复）
function randomHeroSet(rng, n) {
  const pool = [...FIRST_BATCH];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

let crashes = 0, timeouts = 0, negatives = 0, anomalies = 0;
const winners = {};

for (let game = 0; game < N; game++) {
  const seed = useRandom ? ((Date.now() ^ (game * 2654435761)) >>> 0) : (game * 2654435761) >>> 0;
  const rng = makeRng(seed);
  const n = 3 + Math.floor(rng() * 6); // 3~8 人
  const heroIds = randomHeroSet(rng, n);
  let state;
  try {
    state = createState(heroIds, seed, 'free');
    for (let t = 0; t < MAX_TURNS; t++) {
      const cmds = decideAll(state, rng);
      advanceRound(state, cmds, rng);
      // 负血检查
      for (const p of state.players) {
        if (!p.dead && p.hp < 0) negatives++;
      }
      if (state.phase === 'over') break;
    }
  } catch (e) {
    crashes++;
    if (crashes <= 3) console.error(`Game ${game} CRASH:`, e.message);
    continue;
  }
  if (state.phase !== 'over') { timeouts++; if (timeouts <= 3) console.error(`Game ${game} TIMEOUT (turn ${state.turn})`); }
  // 终局异常：应恰好 1 人存活（乱斗），除非平局(0)
  const alive = state.players.filter((p) => !p.dead);
  if (state.phase === 'over' && alive.length > 1) { anomalies++; if (anomalies <= 3) console.error(`Game ${game} ANOMALY alive=${alive.length}`); }
  if (state.winner != null) winners[state.players[state.winner].heroId] = (winners[state.players[state.winner].heroId] || 0) + 1;
}

console.log('=== 自对弈报告 ===');
console.log('局数:', N);
console.log('崩溃:', crashes);
console.log('超时(>'+MAX_TURNS+'回合):', timeouts);
console.log('负血计数:', negatives);
console.log('终局异常:', anomalies);
console.log('英雄胜场分布:', winners);
const ok = crashes === 0 && negatives === 0 && anomalies === 0;
console.log(ok ? '✅ 全部通过' : '❌ 存在问题，见上方');
process.exit(ok ? 0 : 1);
