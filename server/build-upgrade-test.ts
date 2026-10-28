// 聚焦测试：摧毁后重建 + 矿工升级限一次
import { createState, assignSeatsRandom } from '../src/engine/game.js';
import { applySkill } from '../src/engine/heroes/index.js';
import { buildFort } from '../src/engine/fort.js';
import { makeRng } from '../src/types.js';
import { getHeroData } from '../src/engine/heroes/index.js';

let fails = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`  FAIL ${name}`); fails++; }
}

const s: any = createState(['miner', 'swordsman'], 12345, 'free', 'five');
assignSeatsRandom(s, makeRng(1));
const miner = s.players[0];
const enemy = s.players[1];
const rng = makeRng(7);
const log = (m: string) => s.log.push(m);

// 1) 摧毁敌人近位工事后重建
const proto = getHeroData('swordsman').fort;
enemy.fortNear.hp = 0; // 模拟被摧毁
check('前置: 近位工事已摧毁(hp=0)', enemy.fortNear.hp <= 0);
buildFort(enemy, proto);
check('重建: 近位工事恢复满血', enemy.fortNear.hp === enemy.fortNear.maxHp && enemy.fortNear.hp > 0);
check('重建: 远位未被误覆盖(仍存活)', enemy.fortFar && enemy.fortFar.hp > 0);

// 2) 矿工下井: 升级"自己"的工事两次, 第二次应被拒（每个矿工最多一次）
miner.resources.ore = 10;
// 先给自己建一个近位工事作为升级目标（开局矿工工事位为空，需建造）
miner.fortNear = buildFort(miner, getHeroData('miner').fort);
const mProto = getHeroData('miner').fort;
const ops1 = [{ target: miner.id, layer: 'fortNear', op: 2 }];
applySkill({ state: s, pid: miner.id, skillId: '下井', sub: { ops: ops1 }, rng, log });
const afterUpMax = miner.fortNear.maxHp;
check('升级1: 上限+5', afterUpMax === (mProto.hp + 5));
const oreAfter1 = miner.resources.ore;
const ops2 = [{ target: miner.id, layer: 'fortNear', op: 2 }];
applySkill({ state: s, pid: miner.id, skillId: '下井', sub: { ops: ops2 }, rng, log });
check('升级2: 上限不再增加(限一次)', miner.fortNear.maxHp === afterUpMax);
check('升级2: 矿石不再扣(被拒)', miner.resources.ore === oreAfter1);
check('升级2: fortNear.upgraded=true', miner.fortNear.upgraded === true);

// 2b) 防开挂: 越权升级"敌人工事"必须被拒（矿石不扣、敌人工事不变）
const enemyMaxBefore = enemy.fortNear.maxHp;
const oreBeforeHack = miner.resources.ore;
const opsHack = [{ target: enemy.id, layer: 'fortNear', op: 2 }];
applySkill({ state: s, pid: miner.id, skillId: '下井', sub: { ops: opsHack }, rng, log });
check('防开挂: 越权升级敌人被拒(敌人上限不变)', enemy.fortNear.maxHp === enemyMaxBefore);
check('防开挂: 越权升级敌人被拒(矿石不扣)', miner.resources.ore === oreBeforeHack);

// 3) 加固不限次数(对比验证): 加固+3不封顶(可超过上限), 仍可执行
const hpBefore = miner.fortNear.hp;
const ops3 = [{ target: miner.id, layer: 'fortNear', op: 1 }];
applySkill({ state: s, pid: miner.id, skillId: '下井', sub: { ops: ops3 }, rng, log });
check('加固: 仍可无限次(+3血, 不封顶)', miner.fortNear.hp === hpBefore + 3);

console.log(fails === 0 ? '\nPASS 建造/升级聚焦测试' : `\nFAIL ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
