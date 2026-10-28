import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';
import { makeFort } from '../../types.js';

// 农夫：三远位(稻草人)+三近位(粮食)一一对应成 3 路；打掉任意一路两层后才可攻击本体。
// 播种=在近位补种粮食；粒粒皆辛苦=永久+1攻。
class FarmerStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      播种(ctx) {
        const self = ctx.self;
        const lanes = self.lanes;
        if (!lanes) { ctx.log(`${self.name} 无田可种`); return; }
        const empty = lanes.findIndex((l) => !l.near || l.near.hp <= 0);
        if (empty < 0) { ctx.log(`${self.name} 近位(粮食)已满`); return; }
        lanes[empty].near = makeFort(this.def.lanes.near);
        ctx.log(`${self.name} 播种（近位${empty + 1}种下粮食）`);
      },
      粒粒皆辛苦(ctx) {
        ctx.self.atkBonus = Math.min(6, ctx.self.atkBonus + 1);
        ctx.log(`${ctx.self.name} 粒粒皆辛苦（永久+1攻）`);
      },
    };
  }
}
registerStrategy('farmer', FarmerStrategy);
