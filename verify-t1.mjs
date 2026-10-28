// T1 安全修复单元断言：直接调 applySkill（绕过 room 层校验），验证引擎级防开挂生效。
import { createState, assignSeatsRandom, assignTeams } from './src/engine/game.js';
import { applySkill, getHeroData } from './src/engine/heroes/index.js';
import { buildFort } from './src/engine/fort.js';
import { makeRng } from './src/types.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log('  ok  ' + name); pass++; }
  else { console.log('  FAIL ' + name + ' ' + extra); fail++; }
}

// === #8: 商人 贿赂→win，组队模式 winner 必须写"阵营 id" ===
const s = createState(['merchant', 'chef', 'vampire', 'doctor', 'police', 'farmer'], 12345, 'team', 'five');
assignSeatsRandom(s, makeRng(3));
assignTeams(s, '33');
const m = s.players.find((p) => p.heroId === 'merchant');
m.resources.gold = 100;
const teamBefore = m.team;
applySkill({ state: s, pid: m.id, skillId: '贿赂', sub: 'win', rng: makeRng(7), log: (x) => s.log.push(x) });
check('#8 组队: phase=over', s.phase === 'over', `phase=${s.phase}`);
check('#8 组队: winner=阵营id(非玩家id)', s.winner === teamBefore && s.winner !== m.id,
  `winner=${s.winner} team=${teamBefore} pid=${m.id}`);

// === #8b: 自由模式 winner 仍写"玩家 id"（原行为保持） ===
const s2 = createState(['merchant', 'chef'], 999, 'free', 'five');
assignSeatsRandom(s2, makeRng(2));
const m2 = s2.players[0];
m2.resources.gold = 100;
applySkill({ state: s2, pid: m2.id, skillId: '贿赂', sub: 'win', rng: makeRng(7), log: (x) => s2.log.push(x) });
check('#8b 自由: winner=玩家id', s2.winner === m2.id, `winner=${s2.winner} pid=${m2.id}`);

// === #7: 矿工下井越权（绕过 room 校验直调引擎）必须被拦 ===
const s3 = createState(['miner', 'swordsman'], 555, 'free', 'five');
assignSeatsRandom(s3, makeRng(1));
const miner = s3.players[0];
const enemy = s3.players[1];
miner.fortNear = buildFort(miner, getHeroData('miner').fort);
miner.resources.ore = 10;
const log3 = (x) => s3.log.push(x);
// 越权：升级敌人工事
applySkill({ state: s3, pid: miner.id, skillId: '下井', sub: { ops: [{ target: enemy.id, layer: 'fortNear', op: 2 }] }, rng: makeRng(7), log: log3 });
check('#7 越权升级敌人: 敌人工事不变', enemy.fortNear.maxHp === getHeroData('swordsman').fort.hp, `maxHp=${enemy.fortNear.maxHp}`);
check('#7 越权升级敌人: 矿石不扣', miner.resources.ore === 10, `ore=${miner.resources.ore}`);
// 合法：升级自己工事应成功
applySkill({ state: s3, pid: miner.id, skillId: '下井', sub: { ops: [{ target: miner.id, layer: 'fortNear', op: 2 }] }, rng: makeRng(7), log: log3 });
check('#7 合法升级自己: 上限+5', miner.fortNear.maxHp === getHeroData('miner').fort.hp + 5, `maxHp=${miner.fortNear.maxHp}`);
check('#7 合法升级自己: 矿石扣3', miner.resources.ore === 7, `ore=${miner.resources.ore}`);
// 合法：第二次升级应被拒（每个矿工最多一次）
applySkill({ state: s3, pid: miner.id, skillId: '下井', sub: { ops: [{ target: miner.id, layer: 'fortNear', op: 2 }] }, rng: makeRng(7), log: log3 });
check('#7 升级限一次: 第二次被拒(上限不变)', miner.fortNear.maxHp === getHeroData('miner').fort.hp + 5, `maxHp=${miner.fortNear.maxHp}`);
check('#7 升级限一次: 第二次被拒(矿石不扣)', miner.resources.ore === 7, `ore=${miner.resources.ore}`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
