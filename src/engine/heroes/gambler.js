import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';

// 赌徒：高风险高回报的决斗型英雄。
//   孤注一掷：与选定敌人单独猜拳，赢则重创对方(无视工事)，输则自身受伤。
//   老千：稳定中等伤害偷袭敌人，但出手时自身也受轻微反噬（鲁莽代价）。
// 全部走通用原语(ctx.dealDamage / ctx.resolveDuelLoop)，不依赖任何其它英雄状态，纯自包含。
class GamblerStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      孤注一掷(ctx) {
        const t = ctx.target;
        if (!t) { ctx.log(`${ctx.self.name} 孤注一掷：需选目标`); return; }
        const r = ctx.resolveDuelLoop(ctx.rng, ctx.log); // 'a'=赌徒胜 'b'=对方胜 'tie'=平重猜
        if (r === 'tie') { ctx.log(`${ctx.self.name} 孤注一掷 平局重猜`); return; }
        if (r === 'a') {
          ctx.dealDamage(t.id, this.def.params.allInWin, { isSkill: true, ignoreFort: true });
          ctx.log(`${ctx.self.name} 孤注一掷胜 → ${t.name} 本体${this.def.params.allInWin}伤`);
        } else {
          ctx.dealDamage(ctx.pid, this.def.params.allInLose, { isSkill: true });
          ctx.log(`${ctx.self.name} 孤注一掷负 → 自身${this.def.params.allInLose}伤`);
        }
      },
      老千(ctx) {
        const t = ctx.target;
        if (!t) { ctx.log(`${ctx.self.name} 老千：需选目标`); return; }
        ctx.dealDamage(t.id, this.def.params.cheatDmg, { isSkill: true });
        ctx.dealDamage(ctx.pid, this.def.params.cheatSelf, { isSkill: true });
        ctx.log(`${ctx.self.name} 老千 → ${t.name} ${this.def.params.cheatDmg}伤，自身反噬${this.def.params.cheatSelf}`);
      },
    };
  }
}
registerStrategy('gambler', GamblerStrategy);
