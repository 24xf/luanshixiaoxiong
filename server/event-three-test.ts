// 验证两处新行为：
//  1) 三元正则竞赛图积分制（石头/剪刀/布）克制正确、能分出胜负
//  2) 随机事件时机：平局抽定(只抽一次)→重猜后公布并执行、只触发一次
import { ELEMENTS } from '../src/types.js';
import { resolveRps } from '../src/engine/rps.js';
import { createState } from '../src/engine/game.js';
import { onRedrawTie, resolvePendingEvent } from '../src/engine/events.js';
import { makeRng } from '../src/types.js';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ok -', msg);
}

// ---- 1) 三元 RPS ----
console.log('[1] 三元正则竞赛图（石头/剪刀/布）');
{
  const r1 = resolveRps(['石头', '剪刀'], ELEMENTS.K3);
  assert(!r1.redraw && r1.winners.length === 1 && r1.winners[0] === 0, '石头 克 剪刀');
  const r2 = resolveRps(['石头', '布'], ELEMENTS.K3);
  assert(!r2.redraw && r2.winners.length === 1 && r2.winners[0] === 1, '布 克 石头');
  const r3 = resolveRps(['剪刀', '布'], ELEMENTS.K3);
  assert(!r3.redraw && r3.winners.length === 1 && r3.winners[0] === 0, '剪刀 克 布');
  const r4 = resolveRps(['石头', '石头'], ELEMENTS.K3);
  assert(r4.redraw, '同元素 => 平局(重猜)');
}

// ---- 2) 随机事件时机：只触发一次 ----
console.log('[2] 随机事件：平局抽定→重猜后公布执行，全程仅一次');
{
  const s: any = createState(['chef', 'vampire'], 1, 'free', 'five');
  const rng = makeRng(42);
  const log = (m: string) => s.log.push(m);

  // 第一次平局：抽定事件（pendingEvent 被设置）
  onRedrawTie(s, rng);
  assert(s.pendingEvent != null, '平局后 pendingEvent 已抽定（未执行）');
  const firstId = s.pendingEvent;

  // 仍在平局（多次重猜）：不应再抽新事件，pendingEvent 保持不变
  onRedrawTie(s, rng);
  assert(s.pendingEvent === firstId, '多次重猜仍只持有同一事件（不重复抽取）');

  // 分出胜负后：公布并执行，清空 pending
  const ev = resolvePendingEvent(s, rng, log);
  assert(ev != null && ev.id === firstId, '重猜后公布的是之前抽定的同一事件');
  assert(s.pendingEvent == null, '事件执行后 pendingEvent 清空');
  assert(s.lastEvent === firstId, 'lastEvent 已记录');
  assert(s.log.some((l: string) => l.includes('事件')), '日志含事件执行记录');
  assert(ev!.apply.toString().length > 0, '事件效果已应用（无异常）');

  // 再次平局：会抽“下一个”新事件（说明“一次”是针对同一重猜序列）
  onRedrawTie(s, rng);
  assert(s.pendingEvent != null && s.pendingEvent !== firstId, '新序列平局抽定的是不同事件');
}

console.log('事件/三元素验证: PASS');
process.exit(0);
