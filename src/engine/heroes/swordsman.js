import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';

// 剑客：葫芦是防御工事（不提供攻击加成）；剑仙命中英雄后追加一次半伤。
class SwordsmanStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      剑仙(ctx) { ctx.log(`${ctx.self.name} 剑仙（被动：命中英雄后追加半伤）`); },
    };
  }
  atkBonus(p) { return 0; }
  onDealDamage(ctx) {
    if (ctx.hitHero && ctx.target) {
      // 追加目标：默认原目标；可由行动的 sub.ft 指定任意存活英雄（剑仙可自由选择追加打谁）
      let ftId = ctx.target.id;
      if (ctx.sub && typeof ctx.sub.ft === 'number') {
        const ft = ctx.state.players[ctx.sub.ft];
        if (ft && !ft.dead) ftId = ft.id;
      }
      const extra = Math.floor(ctx.amount / 2);
      ctx.bonusHits.push({ targetId: ftId, amount: extra, opts: { isBasic: true, sourceId: ctx.sourceId } });
      ctx.log(`${ctx.self.name} 剑仙追加${extra}伤 → ${ctx.state.players[ftId].name}`);
    }
  }
}
registerStrategy('swordsman', SwordsmanStrategy);
