// 英雄注册表 + 数据驱动入口（插件架构核心）。
//
// 设计原则（用户硬要求）：
//   1) 英雄数据（hp/atk/fort/技能名/数值参数）全部在 heroes.json 里配置；
//   2) 新增英雄 = 写一个策略类文件 + 在 heroes.json 加一条 + 在 index.js 加一行 import；
//      绝不修改其它英雄的代码，也绝不修改引擎。
//   3) 英雄之间解耦：所有跨英雄交互走 effects.js 的通用状态(statuses)/令牌(flag)，
//      策略类里绝不写其它英雄的 id 特判。
//
// 循环依赖说明：本文件 import dealDamage（来自 combat.js），combat.js 又 import getStrategy（本文件）。
// 二者都只在「运行时函数调用」中使用，模块求值期不调用，ES 模块 live binding 可安全处理。

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeFort, ELEMENTS } from '../../types.js';
import { dealDamage } from '../combat.js';
import {
  applyDamage, applyFortDamage, applyStatus, hasStatus, clearStatus, tickStatuses,
  resolveDuel, resolveDuelLoop,
  addResource, getResource, transferResource, addItem, removeItem, hasItem,
} from '../effects.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadHeroes() {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'heroes.json'), 'utf8'));
  } catch (e) {
    console.error('[heroes] 读取 heroes.json 失败:', e.message);
    return {};
  }
}
const HERO_DATA = loadHeroes();
const strategies = new Map();

// 统一英雄上下文里的通用原语包（技能 ctx 与 upkeep ctx 共用），避免各策略重复 import。
// dealDamage 默认以 pid 为来源；upkeep 场景下 pid 即 self.id。
function heroHelpers(state, pid, rng, log) {
  return {
    applyDamage, applyFortDamage, applyStatus, hasStatus, clearStatus, tickStatuses,
    resolveDuel, resolveDuelLoop,
    addResource, getResource, transferResource, addItem, removeItem, hasItem,
    dealDamage: (tid2, amt, o = {}) => dealDamage(state, tid2, amt, { rng, log, sourceId: pid, ...o }),
    getStrategy,
    ELEMENTS,
  };
}

// 策略类在各自文件里调用本函数完成自注册（注册发生在模块求值期，此时 HERO_DATA 已就绪）。
export function registerStrategy(heroId, StrategyClass) {
  const def = HERO_DATA[heroId];
  if (!def) { console.warn(`[heroes] 注册 ${heroId} 但 heroes.json 无对应数据，跳过`); return; }
  if (strategies.has(heroId)) console.warn(`[heroes] 重复注册 ${heroId}`);
  strategies.set(heroId, new StrategyClass(def));
}

export function getStrategy(heroId) { return strategies.get(heroId) || null; }
export function getHeroData(heroId) { return HERO_DATA[heroId] || null; }
export function listHeroes() { return Object.values(HERO_DATA); }

// 技能名列表（供服务器校验 / 前端按钮）
export function skillNames(heroId) {
  const def = HERO_DATA[heroId];
  if (!def || !def.skills) return [];
  return def.skills.map((s) => (typeof s === 'string' ? s : s.name));
}
// 某技能的目标类型：'enemy' | 'ally' | 'self' | 'none'
export function skillTarget(heroId, skillId) {
  const def = HERO_DATA[heroId];
  if (!def || !def.skills) return null;
  const s = def.skills.find((x) => (typeof x === 'string' ? x : x.name) === skillId);
  if (!s) return null;
  return typeof s === 'string' ? 'enemy' : (s.target || 'enemy');
}

// 兼容导出：旧代码用 HEROES[id].name / Object.keys(HEROES)
export const HEROES = HERO_DATA;
export const FIRST_BATCH = Object.keys(HERO_DATA);

// P8 英雄数值热更新：读取 heroes.override.json 深合并（原地改 HERO_DATA，已构造的策略实例共享同一 def 引用 → 新房间即时生效），不停服。
export function reloadHeroesOverride(file) {
  const f = file || join(process.cwd(), 'heroes.override.json');
  try {
    const ov = JSON.parse(readFileSync(f, 'utf8'));
    let n = 0;
    for (const id of Object.keys(ov)) {
      if (HERO_DATA[id]) { Object.assign(HERO_DATA[id], ov[id]); n++; }
    }
    if (n) console.log(`[heroes] SIGHUP 热更新 ${n} 个英雄（仅影响新房间）`);
    return n;
  } catch { return 0; }
}

export function makePlayer(heroId, seat, id) {
  const def = getHeroData(heroId);
  if (!def) throw new Error(`未知英雄: ${heroId}`);
  const p = {
    id, heroId, name: def.name, seat, team: -1,
    maxHp: def.maxHp, hp: def.maxHp, atk: def.atk,
    atkBonus: 0, dmgBonus: 0,
    fortFar: null, fortNear: null, charge: 0,
    dead: false,
    foods: [], gourds: 0, lastRoundAttacked: -1,
    resources: {}, items: {}, statuses: [],
    towers: 0, armorForged: false,
    lanes: null,
    lastRoundWon: false, fortBonus: {},
  };
  // 剑客开局自带 2 个葫芦（占满远/近两位）
  if (heroId === 'swordsman') {
    p.fortNear = makeFort({ name: '葫芦', hp: 5 });
    p.fortFar = makeFort({ name: '葫芦', hp: 5 });
    p.gourds = 2;
  }
  // 农夫：三远位(稻草人) + 三近位(粮食)，一一对应成 3 路，开局为空（需玩家自行建造/播种建造/播种）
  if (heroId === 'farmer' && def.lanes) {
    const L = def.lanes;
    p.lanes = [];
    for (let i = 0; i < (L.count || 3); i++) {
      p.lanes.push({ far: null, near: null });
    }
  }
  // 铁匠初始精铁 / 商人初始金币（资源层统一走 resources）
  if (heroId === 'blacksmith') addResource(p, 'blackIron', def.params.startIron || 5);
  if (heroId === 'merchant') addResource(p, 'gold', def.params.startGold || 10);
  // 矿工初始矿石
  if (heroId === 'miner') addResource(p, 'ore', def.params.startOre || 2);
  return p;
}

// 总攻击力：基础 + 永久加成 + 通用物品(剑) + 英雄自定义加成
export function effectiveAtk(p, state) {
  let a = p.atk + p.atkBonus + p.dmgBonus;
  if (p.items && p.items.sword) a += p.items.sword.atk; // 执剑人伤害 = 基础 + 剑攻击（通用规则）
  const strat = getStrategy(p.heroId);
  if (strat && strat.atkBonus) a += strat.atkBonus(p, state) || 0;
  return a;
}

// 技能入口：组装统一 skill ctx（含全部通用原语 + dealDamage + 本英雄参数），交给策略分发。
export function applySkill(ctx) {
  const { state, pid, skillId, tid, rng, log } = ctx;
  const p = state.players[pid];
  if (!p) return;
  const strat = getStrategy(p.heroId);
  if (!strat) { log(`[未知英雄策略] ${p.heroId}`); return; }
  const sctx = {
    state, pid, skillId, tid, sub: ctx.sub ?? null,
    self: p,
    target: tid != null ? state.players[tid] : null,
    rng, log,
    ...heroHelpers(state, pid, rng, log),
    params: strat.def.params || {},
  };
  // 防开挂：若策略提供 validateSub（技能消费 sub 载荷时有越权风险），先做结构/越权校验。
  // 校验不通过 → 整次技能按 no-op 处理；合法输入行为完全不变（不改规则、不改技能）。
  if (typeof strat.validateSub === 'function' && !strat.validateSub(sctx)) {
    log(`[防开挂] ${p.name} 技能「${skillId}」sub 非法，已忽略`);
    return;
  }
  strat.useSkill(sctx);
}

// 回合维护：逐玩家调用策略 onUpkeep（自回血/自愈/产出/箭塔自动攻击），再衰减通用状态，最后复位临时标记。
export function runUpkeep(state, rng) {
  const log = (m) => state.log.push(m);
  const r = rng || Math.random;
  for (const p of state.players) {
    if (p.dead) continue;
    // #B6 逮捕压制产出：被警察逮捕者本回合完全失去行动能力，不触发任何 onUpkeep（产出+自愈均压制）。
    // 通用状态衰减(tickStatuses)与 lastRoundAttacked 复位照常，仅跳过英雄个性化维护。
    if (!hasStatus(p, 'arrested')) {
      const strat = getStrategy(p.heroId);
      if (strat && strat.onUpkeep) strat.onUpkeep({ state, self: p, log, ...heroHelpers(state, p.id, r, log) });
    } else {
      log(`${p.name} 被逮捕，本回合产出被压制`);
    }
    tickStatuses(p);
    p.lastRoundAttacked = -1;
  }
}
