import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';

// 医生：麻醉任意英雄，下回合不参与猜拳、被动失效（通用状态 anaesthetized，turns=2 以跨过一次完整回合）。
// 冰箱对被麻醉者+1伤的通用规则在 game.js 的 doAttack 中处理。
class DoctorStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      麻醉(ctx) {
        const t = ctx.target;
        if (!t) return;
        ctx.applyStatus(t, { type: 'anaesthetized', turns: 2, source: ctx.pid });
        ctx.log(`${ctx.self.name} 麻醉 ${t.name}（下回合不能猜拳/被动失效）`);
      },
    };
  }
}
registerStrategy('doctor', DoctorStrategy);
