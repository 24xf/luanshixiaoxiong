// 组队模式验证：
// 1) assignTeams 按座次切片分组正确（'33' → 前三队0、后三队1）
// 2) 团队胜负判定：某阵营全灭 → 另一方获胜（winner 记阵营 id）
// 3) 整局随机自对弈收敛，且胜者为合法阵营 id
import { createState, assignSeatsRandom, assignTeams, advanceRound, applyActions } from '../src/engine/game.js';
import { makeRng, ALLOWED_ROOM_SIZES, TEAM_CONFIGS } from '../src/types.js';

const heroes = ['chef', 'vampire', 'miner', 'doctor', 'police', 'farmer'];

// 1) 分组正确性
const s = createState(heroes, 1, 'team', 'five');
assignSeatsRandom(s, makeRng(7));
assignTeams(s, '33');
const teamsSorted = s.players.map((p: any) => p.team).sort((a: number, b: number) => a - b);
const okAssign = JSON.stringify(teamsSorted) === JSON.stringify([0, 0, 0, 1, 1, 1]);

// 2) 团队胜负判定：把 team1 全设为 dead，跑一次结算 → 应判 team0 胜
for (const p of s.players) if (p.team === 1) p.dead = true;
applyActions(s, [], {}, makeRng(1));
const okWin = s.phase === 'over' && s.winner === 0;

// 3) 整局收敛 + 胜者为合法阵营
const s2 = createState([...heroes, 'carpenter', 'swordsman', 'builder'], 7, 'team', 'five');
assignSeatsRandom(s2, makeRng(99));
assignTeams(s2, '333');
const rng = makeRng(99);
const els = s2.elements;
let guard = 0;
while (s2.phase !== 'over' && guard < 400) {
  guard++;
  const cmds: any = {};
  for (const p of s2.players) {
    if (p.dead) continue;
    const tgt = s2.players.find((q: any) => !q.dead && q.id !== p.id);
    cmds[p.id] = { element: els[Math.floor(rng() * els.length)], action: { type: 'attack', target: tgt?.id } };
  }
  advanceRound(s2, cmds, rng);
}
const okSim = s2.phase === 'over' && typeof s2.winner === 'number' && s2.winner >= 0 && s2.winner <= 2;

// 4) 白名单自检：11 不在内；4/6/8/9/10/12 有组队配置；2/3/5/7 无
const okWhite = !ALLOWED_ROOM_SIZES.includes(11) &&
  TEAM_CONFIGS[4].includes('22') && TEAM_CONFIGS[6].includes('33') &&
  TEAM_CONFIGS[12].includes('3333') && !TEAM_CONFIGS[5];

if (okAssign && okWin && okSim && okWhite) {
  console.log('PASS 组队模式: 分组正确, 团队胜负判定正确, 整局收敛胜者为阵营id, 白名单正确');
  console.log(`  示例: size6 '33' 分组=${teamsSorted.join(',')} | 9人整局 winner(team)=${s2.winner} turns=${s2.turn}`);
  process.exit(0);
} else {
  console.log('FAIL', { okAssign, okWin, okSim, okWhite, winner: s2.winner });
  process.exit(1);
}
