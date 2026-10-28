// 五元双克积分制猜拳（净胜即赢 B 规则）
import { beatsOfSet } from '../types.js';

// 计算每个人得分：自己克的人数 - 克自己的人数
// throws: 数组，元素为元素 id；elements: 元素集合
// 返回 [{player, element, score}]
export function scoreRps(throwsArr, elements) {
  const beats = beatsOfSet(elements);
  const idxOf = (e) => elements.indexOf(e); // 元素 id -> 索引（beats 需索引）
  const n = throwsArr.length;
  const counts = {};
  for (const e of elements) counts[e] = 0;
  for (const e of throwsArr) counts[e]++;

  return throwsArr.map((e, i) => {
    const ai = idxOf(e);
    let score = 0;
    for (const other of elements) {
      if (other === e) continue;
      const bi = idxOf(other);
      if (beats(ai, bi)) score += counts[other];
      else if (beats(bi, ai)) score -= counts[other];
    }
    return { player: i, element: e, score };
  });
}

// 赢家 = 得分 > 0（B 规则）。重猜 = 无人 > 0（等价于全员 0 分）
export function resolveRps(throwsArr, elements) {
  const scores = scoreRps(throwsArr, elements);
  const maxScore = Math.max(...scores.map((s) => s.score));
  const redraw = maxScore <= 0; // 净胜即赢：无人净胜 => 重猜
  const winners = redraw ? [] : scores.filter((s) => s.score > 0).map((s) => s.player);
  return { scores, winners, redraw };
}
