import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';

// 矿工：下井(加固/升级工事)+地道战(绕工事攻击)；每猜拳赢的回合获得(2+矿车数)矿石。
// 爆裂矿车：每有一个，每胜回额外+1矿且地道战伤害+1
// 注意：towerCount 不放在 skills getter 里用 this 调用，避免闭包绑定问题
function towerCount(p) {
  return ((p.fortFar && p.fortFar.name === '爆裂矿车' && p.fortFar.hp > 0) ? 1 : 0) +
         ((p.fortNear && p.fortNear.name === '爆裂矿车' && p.fortNear.hp > 0) ? 1 : 0);
}
class MinerStrategy extends BaseHeroStrategy {
  get skills() {
    return {
      下井(ctx) {
        const ops = (ctx.sub && ctx.sub.ops) || [];
        if (!ops.length) { ctx.log(`${ctx.self.name} 下井：未指定操作`); return; }
        for (const o of ops) {
          if (!o || o.target == null || !o.layer || !o.op) continue;
          if (ctx.getResource(ctx.self, 'ore') < (o.op === 1 ? 1 : 3)) { ctx.log(`${ctx.self.name} 下井：矿石不足`); continue; }
          const t = ctx.state.players[o.target];
          if (!t || t.dead) continue;
          const fort = t[o.layer];
          if (!fort || fort.hp <= 0) continue;
          if (o.op === 1) { // 加固：+3血
            fort.hp += 3;
            ctx.addResource(ctx.self, 'ore', -1);
            ctx.log(`${ctx.self.name} 加固 → ${t.name}·${fort.name} +3血`);
          } else if (o.op === 2) { // 升级：+5血上限，该英雄后续建同名工事永久+5（每个矿工最多一次）
            if (ctx.self.minerUpgradedOnce) { ctx.log(`${ctx.self.name} 升级 → 已升级过，不可重复升级`); continue; }
            if (fort.upgraded) { ctx.log(`${ctx.self.name} 升级 → ${t.name}·${fort.name} 已升级过，不可重复升级`); continue; }
            fort.hp += 5; fort.maxHp += 5; fort.upgraded = true;
            ctx.self.minerUpgradedOnce = true;
            const bn = t.fortBonus || {};
            bn[fort.name] = (bn[fort.name] || 0) + 5;
            t.fortBonus = bn;
            ctx.addResource(ctx.self, 'ore', -3);
            ctx.log(`${ctx.self.name} 升级 → ${t.name}·${fort.name} +5血(上限${fort.maxHp},后续建${fort.name}+5)`);
          }
        }
      },
      地道战(ctx) {
        const t = ctx.target;
        if (!t) return;
        const cnt = towerCount(ctx.self);
        const dmg = 2 + cnt;
        ctx.dealDamage(t.id, dmg, { isBasic: true, ignoreFort: true });
        ctx.log(`${ctx.self.name} 地道战 → ${t.name} ${dmg}伤(绕工事,矿车数=${cnt})`);
      },
    };
  }
  // 防开挂：下井消费的 sub.ops 只能操作"自己"的工事，且结构必须合法。
  // 返回 false 时引擎将整次技能按 no-op 处理——不改变技能对合法输入的任何行为，也不改规则。
  validateSub(ctx) {
    if (ctx.skillId !== '下井') return true; // 仅下井消费 sub
    const ops = (ctx.sub && ctx.sub.ops) || [];
    if (!Array.isArray(ops)) return false;
    for (const o of ops) {
      if (!o || typeof o !== 'object') return false;
      if (typeof o.target !== 'number') return false;
      if (o.target !== ctx.self.id) return false;                 // 只能加固/升级自己的工事
      if (o.layer !== 'fortFar' && o.layer !== 'fortNear') return false;
      if (o.op !== 1 && o.op !== 2) return false;
    }
    return true;
  }
  onUpkeep(ctx) {
    const self = ctx.self;
    if (self.lastRoundWon && !ctx.state.suddenDeath) {
      const cnt = towerCount(self);
      ctx.addResource(self, 'ore', 2 + cnt);
      ctx.log(`${self.name} 采矿+${2 + cnt}(胜场+2${cnt > 0 ? ',矿车+'+cnt : ''})`);
    }
  }
}
registerStrategy('miner', MinerStrategy);
