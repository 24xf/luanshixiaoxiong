import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';
import { fortWithName } from './util.js';

// 建筑工人：拆迁大队无视溢出重创目标工事；楼盘每轮若未受击则自愈+2。
class BuilderStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      拆迁大队(ctx) {
        const t = ctx.target;
        if (!t) return;
        ctx.applyFortDamage(ctx.state, t.id, this.def.params.demoDmg);
        ctx.log(`${ctx.self.name} 拆迁大队 → ${t.name} 工事${this.def.params.demoDmg}伤(无视溢出)`);
      },
    };
  }
  onUpkeep(ctx) {
    const self = ctx.self, s = ctx.state;
    const b = fortWithName(self, '楼盘');
    if (!s.suddenDeath && b && b.hp > 0 && self.lastRoundAttacked !== s.turn)
      b.hp = Math.min(b.maxHp, b.hp + 2);
  }
}
registerStrategy('builder', BuilderStrategy);
