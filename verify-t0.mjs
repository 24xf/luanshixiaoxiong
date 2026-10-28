import { EVENTS } from './src/engine/events.js';
import { makePlayer, applySkill } from './src/engine/heroes/index.js';
import { applyDamage } from './src/engine/damage.js';
import { makeFort } from './src/types.js';

let pass = 0, fail = 0;
function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

// #1 事件 E10 点石成金 → 真加金币到 resources.gold
{
  const st = { players: [ makePlayer('chef', 0, 0) ], log: [] };
  st.players[0].resources = { gold: 0 };
  EVENTS.find(e => e.id === 'E10').apply(st, Math.random, (m) => st.log.push(m));
  assert('#1 E10 加金币', st.players[0].resources.gold === 5, `gold=${st.players[0].resources.gold}`);
}

// #2 厨师 小菜一碟 改 ally 后真正生效（之前 target=null 是 no-op）
{
  const st = { players: [ makePlayer('chef', 0, 0), makePlayer('swordsman', 1, 1) ], log: [] };
  applySkill({ state: st, pid: 0, skillId: '小菜一碟', tid: 1, rng: Math.random, log: (m) => st.log.push(m) });
  assert('#2 小菜一碟 ally 生效', st.players[1].dmgBonus === 1, `dmgBonus=${st.players[1].dmgBonus}`);
}

// #3 铁匠 重铸/断剑 现在可达
{
  const st = { players: [ makePlayer('blacksmith', 0, 0), makePlayer('swordsman', 1, 1) ], log: [] };
  st.players[0].resources = { blackIron: 10 };
  st.players[1].items.sword = { atk: 2, recasts: 0 };
  applySkill({ state: st, pid: 0, skillId: '重铸', tid: 1, rng: Math.random, log: (m) => st.log.push(m) });
  assert('#3 重铸可达', st.players[1].items.sword.atk === 3 && st.players[1].items.sword.recasts === 1,
    `atk=${st.players[1].items.sword?.atk} recasts=${st.players[1].items.sword?.recasts}`);
  applySkill({ state: st, pid: 0, skillId: '断剑', tid: 1, rng: Math.random, log: (m) => st.log.push(m) });
  assert('#3 断剑可达', st.players[1].items.sword.atk === -1, `atk=${st.players[1].items.sword?.atk}`);
}

// #4 农夫车道吸收：far 被破后溢出继续打 near，不再吞伤
{
  const st = { players: [ makePlayer('farmer', 0, 0) ], log: [] };
  st.players[0].lanes[0] = { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) };
  applyDamage(st, 0, 8, {}); // 8 点：far(5) 破，near(5) 剩 2，本体不伤
  const lane = st.players[0].lanes[0];
  assert('#4 车道不吞伤', lane.far.hp === 0 && lane.near.hp === 2 && st.players[0].hp === 10,
    `far=${lane.far.hp} near=${lane.near.hp} hp=${st.players[0].hp}`);
  // 再补 12 点：本路 near(剩2) 清空，溢出 floor((12-2)/2)=5 打本体
  applyDamage(st, 0, 12, {});
  assert('#4 清空一路后剩余直击本体', st.players[0].hp === 5, `hp=${st.players[0].hp}`);
}

// #6 商人 贿赂→buyfort：自身工事已满时不应扣金币也不覆盖
{
  const st = { players: [ makePlayer('merchant', 0, 0), makePlayer('miner', 1, 1) ], log: [] };
  st.players[0].resources = { gold: 10 };
  st.players[0].fortFar = makeFort({ name: '商店', hp: 7 });
  st.players[0].fortNear = makeFort({ name: '商店', hp: 7 }); // 双槽满
  st.players[1].fortFar = makeFort({ name: '爆裂矿车', hp: 6 }); // 敌人有工事可买
  applySkill({ state: st, pid: 0, skillId: '贿赂', sub: 'buyfort', tid: 1, rng: Math.random, log: (m) => st.log.push(m) });
  const me = st.players[0];
  assert('#6 双槽满不扣金币不覆盖',
    me.resources.gold === 10 && me.fortFar.name === '商店' && me.fortNear.name === '商店',
    `gold=${me.resources.gold} far=${me.fortFar?.name} near=${me.fortNear?.name}`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
