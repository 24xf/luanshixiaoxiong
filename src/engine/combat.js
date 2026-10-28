// 受 hook 控制的伤害管线（同步）：在现有 applyDamage 外面包一层英雄钩子。
// 英雄策略通过 ctx 拿到引擎原语（不 import 本文件，避免循环依赖）。
//
// 通用效果令牌（写在 ctx 可写字段，由英雄钩子修改，绝不写英雄 id 特判）：
//   redirect / reflectTo  -> 伤害转移给他人
//   negate                -> 完全抵消
//   dmgMult               -> 伤害倍率
//   bonusHits             -> 额外追加伤害 [{targetId, amount, opts}]
import {
  applyDamage, applyFortDamage, applyStatus, hasStatus, clearStatus,
  resolveDuel, resolveDuelLoop,
  addResource, getResource, transferResource, addItem, removeItem, hasItem,
} from './effects.js';
import { getStrategy } from './heroes/registry.js';
import { ELEMENTS } from '../types.js';

const helpers = {
  applyDamage, applyFortDamage, applyStatus, hasStatus, clearStatus,
  resolveDuel, resolveDuelLoop,
  addResource, getResource, transferResource, addItem, removeItem, hasItem,
};

// 主伤害入口（基础攻击与技能伤害都走这里，以便吸血/剑仙/乾坤大挪移等通用效果生效）。
// opts: { sourceId, isBasic, isSkill, element, ignoreFort, skillId, rng, log }
export function dealDamage(state, targetId, amount, opts = {}) {
  const target = state.players[targetId];
  if (!target || target.dead || amount <= 0) return { applied: 0 };
  const log = opts.log || ((m) => state.log.push(m));
  const rng = opts.rng || Math.random;
  const sourceId = opts.sourceId ?? null;

  // 警车关押：被关者本回合免疫所有伤害（通用规则，与目标英雄无关）
  if (hasStatus(target, 'jailed')) { log(`${target.name} 被关警车，免疫`); return { applied: 0 }; }

  const ctx = {
    state, self: target, sourceId, targetId, amount,
    isBasic: !!opts.isBasic, isSkill: !!opts.isSkill,
    element: opts.element ?? null, ignoreFort: !!opts.ignoreFort, skillId: opts.skillId ?? null,
    rng, log,
    // 可写控制字段（英雄钩子修改这些来影响结算）
    redirect: null, negate: false, reflectTo: null, dmgMult: 1, bonusHits: [],
    hitHero: false,
    // 注入的引擎原语 + 侧猜拳 + 受 hook 伤害入口
    ...helpers,
    duel: () => resolveDuelLoop(rng, log),
    dealDamage: (tid, amt, o = {}) => dealDamage(state, tid, amt, { rng, log, sourceId, ...o }),
    getStrategy,
    ELEMENTS,
  };

  // 1) 受击前：反射/转移/减伤/免疫/侧猜拳（忍者遁术/古堡已由 applyDamage 处理；此处处理英雄级）
  const tStrat = getStrategy(target.heroId);
  if (tStrat && tStrat.onBeforeDamage) tStrat.onBeforeDamage(ctx);
  if (ctx.negate) { log(`${target.name} 抵消了伤害`); return { applied: 0, negated: true }; }

  let finalId = targetId;
  if (ctx.redirect != null) finalId = ctx.redirect;
  else if (ctx.reflectTo != null) finalId = ctx.reflectTo;
  const ft = state.players[finalId];
  if (!ft || ft.dead) return { applied: 0 };

  // #B4 重定向/反射后，受害者钩子必须用「最终受害者」的策略，而非原目标策略。
  // 否则原目标把伤害转走后，最终受害者(ft)的自身钩子(铁匠锻造炉毁获铁/律师辩护等)不触发，
  // 反而错用原目标的受害者钩子。当前无英雄触发 redirect/reflectTo(潜伏雷)，但未来加英雄必爆。
  const fStrat = getStrategy(ft.heroId);

  const fortBefore = { far: ft.fortFar?.hp ?? 0, near: ft.fortNear?.hp ?? 0 };
  const hpBefore = ft.hp;
  const dealt = Math.max(0, Math.round(ctx.amount * ctx.dmgMult));
  applyDamage(state, finalId, dealt, { isBasic: ctx.isBasic, isSkill: ctx.isSkill, sourceId, ignoreFort: ctx.ignoreFort });
  ctx.hitHero = ft.hp < hpBefore; // 仅当本体掉血才算"命中英雄本体"
  const applied = hpBefore - ft.hp;
  // 工事被击打 → 记录本回合受击（楼盘自愈/农夫等据此判断）
  if ((ft.fortFar?.hp ?? 0) < fortBefore.far || (ft.fortNear?.hp ?? 0) < fortBefore.near) ft.lastRoundAttacked = state.turn;

  // 工事被摧毁 → 触发 onFortDestroyed（铁匠锻造炉毁获精铁等）。用最终受害者策略 fStrat（#B4）。
  if (fStrat && fStrat.onFortDestroyed) {
    if (fortBefore.far > 0 && (ft.fortFar?.hp ?? 0) <= 0) fStrat.onFortDestroyed({ ...ctx, self: ft, destroyed: 'fortFar' });
    if (fortBefore.near > 0 && (ft.fortNear?.hp ?? 0) <= 0) fStrat.onFortDestroyed({ ...ctx, self: ft, destroyed: 'fortNear' });
  }

  // 2) 造成伤害后：吸血/剑仙/打狗棒法等（来源英雄）
  if (sourceId != null) {
    const src = state.players[sourceId];
    const sStrat = src && getStrategy(src.heroId);
    if (sStrat && sStrat.onDealDamage) {
      const c2 = { ...ctx, self: src, target: ft, amount: applied, hitHero: ctx.hitHero, bonusHits: [], sub: opts.sub ?? null };
      sStrat.onDealDamage(c2);
      for (const bh of c2.bonusHits) {
        const bht = state.players[bh.targetId];
        if (bht && !bht.dead) applyDamage(state, bh.targetId, bh.amount, { ...bh.opts, isBasic: false, sourceId, noBonus: true });
      }
    }
  }

  // 3) 受击后：律师辩护等（最终受害者英雄，用 fStrat —— #B4）
  if (fStrat && fStrat.onAfterDamage) fStrat.onAfterDamage({ ...ctx, self: ft });

  return { applied };
}
