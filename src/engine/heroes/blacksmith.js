import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';
import { fortWithName } from './util.js';

// 铁匠：铸剑/重铸/断剑（剑为可在英雄间流转的物品，执剑人攻击+剑攻击，通用规则在 effectiveAtk 处理）；
// 锻甲为友方永久+血量与上限；锻造炉每回合产铁、被毁获铁。
class BlacksmithStrategy extends BaseHeroStrategy {
  get skills() {
    const P = this.def.params;
    return {
      铸剑(ctx) {
        const self = ctx.self;
        if (ctx.getResource(self, 'blackIron') < 2) { ctx.log(`${self.name} 铸剑：精铁不足`); return; }
        ctx.addResource(self, 'blackIron', -2);
        const rec = ctx.target || self;
        rec.items.sword = { atk: P.swordAtk, recasts: 0 };
        ctx.log(`${self.name} 铸剑 → ${rec.name} 得剑(攻击${P.swordAtk})`);
      },
      重铸(ctx) {
        const self = ctx.self;
        const rec = (ctx.target && ctx.target.items.sword) ? ctx.target : (self.items.sword ? self : null);
        if (!rec || !rec.items.sword) { ctx.log(`${self.name} 重铸：无剑`); return; }
        if (rec.items.sword.recasts >= P.recastMax) { ctx.log(`${self.name} 重铸：已达上限`); return; }
        if (ctx.getResource(self, 'blackIron') < P.recastCost) { ctx.log(`${self.name} 重铸：精铁不足`); return; }
        ctx.addResource(self, 'blackIron', -P.recastCost);
        rec.items.sword.atk += 1; rec.items.sword.recasts += 1;
        ctx.log(`${self.name} 重铸 → ${rec.name} 剑攻击${rec.items.sword.atk}`);
      },
      断剑(ctx) {
        const rec = (ctx.target && ctx.target.items.sword) ? ctx.target : (ctx.self.items.sword ? ctx.self : null);
        if (!rec || !rec.items.sword) return;
        rec.items.sword.atk = P.breakSwordAtk;
        ctx.log(`${ctx.self.name} 断剑 → ${rec.name} 剑攻击${rec.items.sword.atk}`);
      },
      锻甲(ctx) {
        const self = ctx.self;
        const P = this.def.params;
        if (ctx.getResource(self, 'blackIron') < P.armorIron) { ctx.log(`${self.name} 锻甲：精铁不足`); return; }
        ctx.addResource(self, 'blackIron', -P.armorIron);
        const rec = ctx.target || self;
        rec.maxHp += P.armorHp; rec.hp += P.armorHp;
        ctx.log(`${self.name} 锻甲 → ${rec.name} 永久+${P.armorHp}生命上限`);
      },
    };
  }
  onUpkeep(ctx) {
    const self = ctx.self;
    const f = fortWithName(self, '锻造炉');
    if (f && f.hp > 0) ctx.addResource(self, 'blackIron', 1);
  }
  onFortDestroyed(ctx) {
    const f = ctx.self[ctx.destroyed];
    if (f && f.name === '锻造炉') {
      ctx.addResource(ctx.self, 'blackIron', 4);
      ctx.log(`${ctx.self.name} 锻造炉被毁 → +4精铁`);
    }
  }
}
registerStrategy('blacksmith', BlacksmithStrategy);
