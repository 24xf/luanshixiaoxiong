import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';

// 吸血鬼：攻击英雄本体时吸回等量血（攻击工事不吸血，由 dealDamage 仅在本体掉血时触发）。
class VampireStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      吸血(ctx) { ctx.log(`${ctx.self.name} 吸血（被动：攻击本体时回血）`); },
    };
  }
  onDealDamage(ctx) {
    if (ctx.hitHero) {
      const self = ctx.self;
      const before = self.hp;
      self.hp = Math.min(self.maxHp, self.hp + ctx.amount);
      if (self.hp > before) ctx.log(`${self.name} 吸血 +${self.hp - before}`);
    }
  }
}
registerStrategy('vampire', VampireStrategy);
