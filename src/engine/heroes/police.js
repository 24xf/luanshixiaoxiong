import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';
import { fortWithName } from './util.js';

// 警察：逮捕限制目标本回合行动（有警车则关押→免疫一切伤害）；开罚单令目标工事违章2回合。
class PoliceStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      逮捕(ctx) {
        const t = ctx.target;
        if (!t) return;
        ctx.applyStatus(t, { type: 'arrested', turns: 1, source: ctx.pid });
        if (fortWithName(t, '警车')) ctx.applyStatus(t, { type: 'jailed', turns: 1, source: ctx.pid });
        ctx.log(`${ctx.self.name} 逮捕 ${t.name}`);
      },
      开罚单(ctx) {
        const t = ctx.target;
        if (!t) return;
        ctx.applyStatus(t, { type: 'fortDisabled', turns: 2, source: ctx.pid });
        ctx.log(`${ctx.self.name} 开罚单 ${t.name} 工事作废2回合`);
      },
    };
  }
}
registerStrategy('police', PoliceStrategy);
