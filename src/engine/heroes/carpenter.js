import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';
import { fortWithName, weakestEnemy } from './util.js';

// 木匠：修理友方工事；机关立箭塔（附加攻击，每回合结束自动打最弱敌）；木工台每回合免费自修。
// 注：箭塔「每回合结束自动攻击」已实现；箭塔依附工事（无工事则停摆）为 Phase0 简化。
class CarpenterStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      修理(ctx) {
        const t = ctx.target || ctx.self;
        const f = t.fortNear || t.fortFar;
        if (f) { f.hp = Math.min(f.maxHp, f.hp + this.def.params.repair); ctx.log(`${ctx.self.name} 修理 → ${f.name} +${this.def.params.repair}血`); }
      },
      机关(ctx) {
        const self = ctx.self;
        const towers = self.towers || 0;
        self.towers = towers + 1; // 先加一座箭塔
        const t = ctx.target;
        if (t) {
          // 射击：用当前全部箭塔攻击指定目标（每塔 1 伤）
          for (let i = 0; i < self.towers; i++) ctx.dealDamage(t.id, 1, { isSkill: true });
          ctx.log(`${self.name} 机关（箭塔+1，射击 ${t.name} ${self.towers} 伤）`);
        } else {
          ctx.log(`${self.name} 机关（箭塔+1，无目标不射击）`);
        }
      },
    };
  }
  atkBonus(p) { return p.towers || 0; }
  onUpkeep(ctx) {
    const self = ctx.self, s = ctx.state;
    const bench = fortWithName(self, '木工台');
    if (!s.suddenDeath && bench && bench.hp > 0) bench.hp = Math.min(bench.maxHp, bench.hp + 3);
    if (!s.suddenDeath && self.towers > 0) {
      const hasFort = (self.fortNear && self.fortNear.hp > 0) || (self.fortFar && self.fortFar.hp > 0);
      if (hasFort) {
        for (let i = 0; i < self.towers; i++) {
          const e = weakestEnemy(s, self.id);
          if (e) ctx.dealDamage(e.id, 1, { isSkill: true });
        }
      }
    }
  }
}
registerStrategy('carpenter', CarpenterStrategy);
