// 英雄策略基类：所有生命周期钩子默认 no-op。
// 子类只覆盖自己需要的钩子，永不写其它英雄的 id 特判。
//
// 钩子一览（ctx 由各调用点注入）：
//   atkBonus(p, state)            -> 返回额外攻击加成（除基础/atkBonus/dmgBonus 与通用剑加成之外）
//   skills                       -> { 技能名: (ctx) => void }，由 useSkill 按 skillId 分发
//   useSkill(ctx)                -> 默认按 skillId 调 skills[skillId]，未实现则记日志
//   onBeforeRound(p, ctx)        -> 回合开始（收拳前）
//   onRpsCollect(p, ctx)         -> 收拳阶段
//   onRpsResolved(p, ctx)        -> 猜拳结果公布后
//   onTurnEnd(p, ctx)            -> 行动结算后、胜负判定前
//   onUpkeep(ctx)                -> 回合维护（upkeep）：自回血/自愈/产出等
//   onBeforeDamage(ctx)          -> 受击前（可 negate/redirect/reflect/dmgMult）
//   onDealDamage(ctx)            -> 造成伤害后（来源英雄：吸血/剑仙/打狗棒法等）
//   onAfterDamage(ctx)           -> 受击后（目标英雄：辩护等）
//   onFortDestroyed(ctx)         -> 自身某层工事被摧毁
//   onDeath(ctx)                 -> 死亡时

export class BaseHeroStrategy {
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
  }

  atkBonus(p, state) { return 0; }

  get skills() { return {}; }

  useSkill(ctx) {
    const fn = this.skills[ctx.skillId];
    if (fn) fn.call(this, ctx);
    else ctx.log(`[未实现技能] ${ctx.skillId}`);
  }

  onBeforeRound(p, ctx) {}
  onRpsCollect(p, ctx) {}
  onRpsResolved(p, ctx) {}
  onTurnEnd(p, ctx) {}
  onUpkeep(ctx) {}
  onBeforeDamage(ctx) {}
  onDealDamage(ctx) {}
  onAfterDamage(ctx) {}
  onFortDestroyed(ctx) {}
  onDeath(ctx) {}
}
