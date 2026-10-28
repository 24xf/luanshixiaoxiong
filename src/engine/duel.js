// duelRps 元机制：两个英雄（或英雄与系统）单独猜拳判定
// 使用 5 元素；平局处理由各技能自行定义（调用方决定）；不耗行动权；单次不可递归。
import { ELEMENTS, randInt } from '../types.js';
import { resolveRps } from './rps.js';

// 随机出拳（系统/AI 用）
export function randomThrow(rng, elements = ELEMENTS.K5) {
  return elements[randInt(rng, elements.length)];
}

// 1v1 判定：返回 'a' | 'b' | 'tie'
// aThrow/bThrow 为元素 id；elements 为元素集（默认 K5）
export function duelRps(aThrow, bThrow, elements = ELEMENTS.K5) {
  const res = resolveRps([aThrow, bThrow], elements);
  if (res.redraw) return 'tie'; // 两人同元素 => 平
  // winners 非空
  return res.winners[0] === 0 ? 'a' : 'b';
}
