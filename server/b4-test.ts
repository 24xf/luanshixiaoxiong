// B4 回归：重定向/反射后受害者钩子用错策略（潜伏雷）。
// 直接对 dealDamage 做单元级断言：构造"原目标 onBeforeDamage 设 redirect→另一玩家"，
// 验证最终受害者(ft)的 onFortDestroyed / onAfterDamage 触发，而原目标的不触发。
import { registerStrategy, getStrategy, makePlayer } from '../src/engine/heroes/registry.js';
import { dealDamage } from '../src/engine/combat.js';
import { makeFort } from '../src/types.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// 记录各受害者钩子触发时 self.id（用于判定"谁的钩子生效"）。
const fired: Record<'after' | 'fort', number[]> = { after: [], fort: [] };

// 原目标英雄（覆盖 'blacksmith'）：受击时把伤害 redirect 给玩家 1。
// 自身不带任何受害者钩子，因此若 bug 仍在，fired 将为空（原目标钩子不触发、最终受害者钩子也没用上）。
class RedirectHero {
  def: any;
  constructor(def: any) { this.def = def; }
  onBeforeDamage(ctx: any) { ctx.redirect = 1; }
}
registerStrategy('blacksmith', RedirectHero);

// 最终受害者英雄（覆盖 'merchant'）：受害者钩子记录 self.id。
class VictimHero {
  def: any;
  constructor(def: any) { this.def = def; }
  onAfterDamage(ctx: any) { fired.after.push(ctx.self.id); }
  onFortDestroyed(ctx: any) { fired.fort.push(ctx.self.id); }
}
registerStrategy('merchant', VictimHero);

function main() {
  console.log('[b4-test] B4 重定向后钩子策略归属');
  // 健全性：覆盖确实生效（否则测试无意义）。
  check('#B4x 测试策略已覆盖 blacksmith/merchant', !!getStrategy('blacksmith') && !!getStrategy('merchant'));

  // 极简 state：玩家0=受击者(会把伤害转给1)，玩家1=最终受害者(带工事)。
  const p0: any = makePlayer('blacksmith', 0, 0);
  const p1: any = makePlayer('merchant', 1, 1);
  p1.fortFar = makeFort({ name: '锻造炉', hp: 3 });
  const state: any = { players: [p0, p1], log: [] as string[], turn: 1 };

  // 攻击玩家0（10 点），其 onBeforeDamage 把伤害 redirect 到玩家1。
  dealDamage(state, 0, 10, { sourceId: null });

  // 重定向证明：原目标(玩家0)自己未受击（伤害被转走），最终受害者(玩家1)工事被毁。
  check('#B4y 原目标(玩家0)未受击（伤害被转走）', p0.hp === p0.maxHp);
  check('#B4z 最终受害者(玩家1)远位工事被毁', (p1.fortFar?.hp ?? 0) <= 0);

  // 核心断言：重定向后，受害者钩子应绑定最终受害者(玩家1)，而非原目标(玩家0)。
  check('#B4a 重定向后最终受害者 onAfterDamage 触发(且非原目标)', fired.after.includes(1) && !fired.after.includes(0));
  check('#B4b 重定向后最终受害者 onFortDestroyed 触发(且非原目标)', fired.fort.includes(1) && !fired.fort.includes(0));

  // 对照：无重定向时，受害者钩子应绑定被攻击者自身（行为不变）。
  // 注意：players 数组按索引访问，单玩家放在索引 0；玩家 id 仍为 2（钩子里 self.id 取 id）。
  const p2: any = makePlayer('merchant', 2, 2);
  p2.fortFar = makeFort({ name: '锻造炉', hp: 3 });
  const s2: any = { players: [p2], log: [] as string[], turn: 1 };
  dealDamage(s2, 0, 10, { sourceId: null });
  check('#B4c 无重定向时受害者钩子绑定自身', fired.after.includes(2) && (p2.fortFar?.hp ?? 0) <= 0);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}
main();
