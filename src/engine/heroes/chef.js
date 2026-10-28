import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';

// 厨师：送菜永久加伤；献鱼与对方单独猜拳，赢则重创目标、若击杀自身也受创。
class ChefStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      小菜一碟(ctx) {
        const t = ctx.target;
        if (!t) return;
        t.dmgBonus += this.def.params.dishBonus;
        ctx.log(`${ctx.self.name} 小菜一碟 → ${t.name} 伤害永久+${this.def.params.dishBonus}`);
      },
      献鱼(ctx) {
        const t = ctx.target;
        if (!t) { ctx.log(`${ctx.self.name} 献鱼：需选目标`); return; }
        const r = ctx.resolveDuelLoop(ctx.rng, ctx.log); // 'a'=厨师胜 'b'=对方胜 'tie'=平重猜
        if (r === 'tie') { ctx.log(`${ctx.self.name} 献鱼 平局重猜`); return; }
        if (r === 'a') {
          ctx.dealDamage(t.id, this.def.params.fishWin, { isSkill: true, ignoreFort: true });
          if (t.dead) ctx.dealDamage(ctx.pid, this.def.params.fishLose, { isSkill: true });
          ctx.log(`${ctx.self.name} 献鱼胜 → ${t.name} 本体${this.def.params.fishWin}伤${t.dead ? `，自身${this.def.params.fishLose}` : ''}`);
        } else {
          ctx.dealDamage(ctx.pid, this.def.params.fishLose, { isSkill: true });
          ctx.log(`${ctx.self.name} 献鱼负 → 自身${this.def.params.fishLose}伤`);
        }
      },
    };
  }
}
registerStrategy('chef', ChefStrategy);
