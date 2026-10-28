// O1 回归：AI 托管决策增强
//  - 选能赢的元素（基于敌人近期出拳预测）
//  - 招牌技能高概率触发（托管不再是弱鸡）
import { decide } from '../src/ai/bot.js';
import { createState } from '../src/engine/game.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// 与 bot.js 内部 beats 同构的判定（基于本局元素集循环顺序）
function beats(a: string, b: string, els: string[]): boolean {
  const i = els.indexOf(a), j = els.indexOf(b);
  if (i < 0 || j < 0 || a === b) return false;
  const m = Math.floor((els.length - 1) / 2);
  const d = (j - i + els.length) % els.length;
  return d >= 1 && d <= m;
}

// 确定性但逐次变化的 rng（LCG）
function lcg(seed: number) {
  let x = seed >>> 0;
  return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
}

function main() {
  console.log('[bot-test] O1 AI 托管决策增强');

  // ---------------- O1a 医生高概率放麻醉 ----------------
  {
    const s: any = createState(['doctor', 'swordsman'], 1, 'free', 'five');
    let skillCount = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const rng = lcg(i + 1);
      const d: any = decide(s, 0, rng);
      if (d && d.action && d.action.type === 'skill' && d.action.skillId === '麻醉') skillCount++;
    }
    check('#O1a 医生麻醉触发率≥40%', skillCount / n >= 0.4);
  }

  // ---------------- O1b 选能赢的元素 ----------------
  {
    const s: any = createState(['doctor', 'swordsman'], 1, 'free', 'five');
    s.lastThrows = { 0: '数', 1: '数' }; // 敌人近期都出'数'
    const rng = lcg(42);
    const d: any = decide(s, 0, rng);
    check('#O1b 所选元素能赢多数敌人出拳', !!d && typeof d.element === 'string' && beats(d.element, '数', s.elements));
  }

  // ---------------- O1c 决策结构合法（含目标指向敌人）----------------
  {
    const s: any = createState(['doctor', 'swordsman'], 1, 'free', 'five');
    const d: any = decide(s, 0, lcg(7));
    const valid = d && typeof d.element === 'string' && d.action && typeof d.action.type === 'string' &&
      (d.action.target == null || typeof d.action.target === 'number');
    check('#O1c 决策结构合法', valid);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}
main();
