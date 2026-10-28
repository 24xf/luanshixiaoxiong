import { BaseHeroStrategy } from './base.js';
import { registerStrategy } from './registry.js';
import { fortWithName } from './util.js';

// 商人：金币货币自成体系。贿赂(子选项①~⑤)，强买强卖(塞钱+本回合限制行动，Phase0 近似为 arrested)。
// sub 选项由调用方传入（UI/协议需支持 action.sub）。
class MerchantStrategy extends BaseHeroStrategy {
  get skills() {
    const P = this.def.params;
    return {
      贿赂(ctx) {
        const self = ctx.self;
        const sub = ctx.sub || 'buff';
        const gold = () => ctx.getResource(self, 'gold');
        const spend = (n) => ctx.addResource(self, 'gold', -n);
        if (sub === 'buff') {
          if (gold() < P.buffCost) { ctx.log(`${self.name} 贿赂：金币不足`); return; }
          spend(P.buffCost); self.atkBonus += 1; ctx.log(`${self.name} 贿赂 → 本局攻击+1`);
        } else if (sub === 'heal') {
          if (gold() < P.healCost) { ctx.log(`${self.name} 贿赂：金币不足`); return; }
          spend(P.healCost); self.hp = Math.min(self.maxHp, self.hp + 1); ctx.log(`${self.name} 贿赂 → 回1血`);
        } else if (sub === 'clean') {
          if (gold() < P.cleanCost) { ctx.log(`${self.name} 贿赂：金币不足`); return; }
          spend(P.cleanCost);
          for (const t of ['anaesthetized', 'arrested', 'fortDisabled', 'jailed']) ctx.clearStatus(self, t);
          ctx.log(`${self.name} 贿赂 → 清除负面效果`);
        } else if (sub === 'buyfort') {
          const t = ctx.target;
          if (!t) { ctx.log(`${self.name} 贿赂：需选目标`); return; }
          const src = t.fortFar || t.fortNear;
          if (!src) { ctx.log(`${self.name} 贿赂：目标无工事`); return; }
          if (self.fortFar && self.fortNear) { ctx.log(`${self.name} 贿赂：自身工事已满`); return; }
          if (gold() < P.buyFortCost) { ctx.log(`${self.name} 贿赂：金币不足`); return; }
          spend(P.buyFortCost);
          if (t.fortFar === src) t.fortFar = null; else t.fortNear = null;
          if (!self.fortFar) self.fortFar = src; else self.fortNear = src; // 放到远位前方（Phase0：就近落位）
          ctx.log(`${self.name} 贿赂 → 买下 ${t.name} 的${src.name}`);
        } else if (sub === 'win') {
          if (gold() < P.winCost) { ctx.log(`${self.name} 贿赂：金币不足（需${P.winCost}）`); return; }
          spend(P.winCost);
          // 组队模式 winner 记"阵营 id"，与正常胜负判定(game.js)语义一致；自由模式记"玩家 id"。
          // 不改变「直接获胜」的技能效果，仅修正写入值以免客户端语义错乱。
          ctx.state.phase = 'over';
          ctx.state.winner = ctx.state.mode === 'team' ? self.team : self.id;
          ctx.log(`${self.name} 贿赂 → 直接获胜！`);
        } else {
          ctx.log(`${self.name} 贿赂：未知选项 ${sub}`);
        }
      },
      强买强卖(ctx) {
        const self = ctx.self, t = ctx.target;
        if (!t) { ctx.log(`${self.name} 强买强卖：需选目标`); return; }
        ctx.transferResource(self, t, 'gold', Math.min(ctx.getResource(self, 'gold'), P.shoveGold));
        // Phase0 近似：限制目标本回合行动（精确语义应为「仅不能攻击/对商人用技能」，待协议支持细粒度 flag）
        ctx.applyStatus(t, { type: 'arrested', turns: 1, source: self.id });
        ctx.log(`${self.name} 强买强卖 → ${t.name} 塞${P.shoveGold}金，本回合被限制行动`);
      },
    };
  }
  onUpkeep(ctx) {
    const self = ctx.self;
    const shop = fortWithName(self, '商店');
    if (shop && shop.hp > 0) { ctx.addResource(self, 'gold', 2); ctx.log(`${self.name} 商店 → +2金`); }
  }
}
registerStrategy('merchant', MerchantStrategy);
