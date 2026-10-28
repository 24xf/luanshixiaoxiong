// 英雄技能 · 单元验证（仅引擎层，不依赖联网服）
// 1) 逐个英雄技能效果断言；2) 全英雄自对弈冒烟，确认不崩溃且必然收敛。
// 验证对象为插件架构（src/engine/heroes/）：英雄数据在 heroes.json，行为在各策略类。
import { createState, advanceRound, assignSeatsRandom, applyActions } from '../src/engine/game.js';
import { HEROES, applySkill, effectiveAtk } from '../src/engine/heroes/index.js';
import { hasStatus } from '../src/engine/effects.js';
import { makeRng } from '../src/types.js';

let fails = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`  FAIL ${name}`); fails++; }
}

function freshState(heroIds: string[]) {
  const s = createState(heroIds, 12345, 'free', 'five');
  assignSeatsRandom(s, makeRng(1));
  return s;
}
function useSkill(state: any, pid: number, skillId: string, tid?: number, sub?: string) {
  applySkill({ state, pid, skillId, tid, sub, rng: makeRng(7), log: (m: string) => state.log.push(m) });
}

// ---- 技能效果断言 ----
{
  const s = freshState(['chef', 'vampire']);
  useSkill(s, 0, '小菜一碟', 1);
  check('chef.小菜一碟 → 目标dmgBonus+1', s.players[1].dmgBonus === 1);

  const s2 = freshState(['doctor', 'miner']);
  useSkill(s2, 0, '麻醉', 1);
  check('doctor.麻醉 → 目标被麻醉(status)', hasStatus(s2.players[1], 'anaesthetized'));

  const s3 = freshState(['police', 'builder']);
  useSkill(s3, 0, '逮捕', 1);
  check('police.逮捕 → 目标arrested(status)', hasStatus(s3.players[1], 'arrested'));
  useSkill(s3, 0, '开罚单', 1);
  check('police.开罚单 → 目标fortDisabled(status)', hasStatus(s3.players[1], 'fortDisabled'));

  const s4 = freshState(['farmer', 'chef']);
  // 先毁一个近位（模拟粮食被摧毁），再播种验证重建
  const farmerP = s4.players[0];
  if (farmerP.lanes && farmerP.lanes[0]) farmerP.lanes[0].near = null;
  const before = farmerP.lanes ? farmerP.lanes.filter((l: any) => l.near && l.near.hp > 0).length : 0;
  useSkill(s4, 0, '播种');
  const after = farmerP.lanes ? farmerP.lanes.filter((l: any) => l.near && l.near.hp > 0).length : 0;
  check('farmer.播种 → 近位粮食+1（车道模型）', after === before + 1);
  const ab = s4.players[0].atkBonus;
  useSkill(s4, 0, '粒粒皆辛苦');
  check('farmer.粒粒皆辛苦 → atkBonus+1', s4.players[0].atkBonus === ab + 1);

  const s5 = freshState(['miner', 'doctor']);
  check('miner.初始矿石=2', (s5.players[0].resources.ore || 0) === 2);

  const s6 = freshState(['miner', 'vampire']);
  s6.players[0].fortNear = { name: '爆裂矿车', hp: 6, maxHp: 6, effect: null, reflectUsed: false, bonus: {} };
  const hp0 = s6.players[1].hp;
  useSkill(s6, 0, '地道战', 1);
  // 矿车数1 → 地道战伤害=3
  check('miner.地道战 → 目标本体受伤(绕工事)', s6.players[1].hp === hp0 - 3);

  const s7 = freshState(['builder', 'police']);
  s7.players[1].fortNear = { name: '警车', hp: 8, maxHp: 8, effect: null, reflectUsed: false, bonus: {} };
  const fhp0 = s7.players[1].fortNear.hp;
  useSkill(s7, 0, '拆迁大队', 1);
  check('builder.拆迁大队 → 目标工事受伤', s7.players[1].fortNear.hp < fhp0);

  const s8 = freshState(['carpenter', 'chef']);
  const ea8 = effectiveAtk(s8.players[0], s8);
  useSkill(s8, 0, '机关');
  check('carpenter.机关 → effectiveAtk+1（箭塔）', effectiveAtk(s8.players[0], s8) === ea8 + 1);

  // 新原语：铁匠铸剑（物品流转）+ 商人贿赂（货币经济）
  const s9 = freshState(['blacksmith', 'chef']);
  useSkill(s9, 0, '铸剑', 1);
  check('blacksmith.铸剑 → 目标获得剑(攻击2)', !!s9.players[1].items.sword && s9.players[1].items.sword.atk === 2);
  check('blacksmith.铸剑 → 执剑人攻击含剑攻(3+2=5)', effectiveAtk(s9.players[1], s9) === 5);

  const s10 = freshState(['merchant', 'chef']);
  const g0 = s10.players[0].resources.gold || 0;
  useSkill(s10, 0, '贿赂', 1, 'buff');
  check('merchant.贿赂(buff) → 攻击+1且花6金', s10.players[0].atkBonus === 1 && (s10.players[0].resources.gold || 0) === g0 - 6);
}

// ---- #10 回归：lastRoundWon 归属收敛到 applyActions 单一真相源 ----
// 修复前 advanceRound（自对弈/测试路径）从不设该标志，导致 upkeep（矿工产矿等）在测试里永不触发。
{
  const s = freshState(['miner', 'vampire']);
  const miner = s.players[0];
  const oreBefore = (miner.resources.ore || 0);
  // 直接驱动结算：miner 为赢家、选择 pass —— 普通模式仍应产出（与服务器一致）
  applyActions(s, [0], { 0: { type: 'pass' } } as any, makeRng(3));
  check('#10 applyActions：赢家 lastRoundWon=true', miner.lastRoundWon === true);
  check('#10 applyActions：矿工赢家产矿 ore+2', (miner.resources.ore || 0) === oreBefore + 2);
  check('#10 applyActions：非赢家 lastRoundWon=false', s.players[1].lastRoundWon === false);

  // 端到端：advanceRound（自对弈走的正是它）也必须正确设 lastRoundWon
  const s2 = freshState(['miner', 'vampire']);
  const m2 = s2.players[0];
  const oreB2 = (m2.resources.ore || 0);
  // 五元：数 克 物 → miner 出'数'、vampire 出'物'，miner 胜
  const cmds: any = { 0: { element: '数', action: { type: 'pass' } }, 1: { element: '物', action: { type: 'pass' } } };
  advanceRound(s2, cmds, makeRng(9));
  check('#10 advanceRound：矿工赢家 lastRoundWon=true', m2.lastRoundWon === true);
  check('#10 advanceRound：矿工赢家产矿 ore+2', (m2.resources.ore || 0) === oreB2 + 2);
}

// ---- 自对弈冒烟：全英雄各一局，确认不崩溃且收敛 ----
{
  const ids = Object.keys(HEROES);
  let okGames = 0;
  const ELS = ['数', '物', '化', '生', '计'];
  for (let g = 0; g < 30; g++) {
    const s = createState(ids, 1000 + g, 'free', 'five');
    assignSeatsRandom(s, makeRng(1000 + g));
    let guard = 0;
    while (s.phase !== 'over' && guard < 600) {
      const cmds: any = {};
      for (const p of s.players) {
        if (p.dead) continue;
        const enemy = s.players.find((q: any) => !q.dead && q.id !== p.id);
        cmds[p.id] = {
          element: ELS[(p.id + s.turn) % 5],
          action: { type: 'attack', target: enemy ? enemy.id : p.id },
        };
      }
      advanceRound(s, cmds, makeRng(5000 + g * 10 + guard));
      guard++;
    }
    if (s.phase === 'over') okGames++;
  }
  check(`自对弈冒烟 30局收敛 (${okGames}/30)`, okGames === 30);
}

if (fails === 0) { console.log('PASS 英雄技能: 全部技能效果正确, 自对弈收敛'); process.exit(0); }
else { console.log(`FAIL ${fails} 项`); process.exit(1); }
