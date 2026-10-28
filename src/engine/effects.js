// 通用效果原语（叶子模块，不依赖 registry，避免循环依赖）
// 英雄策略只调用这里的函数 + 经 ctx 注入的 dealDamage；绝不写英雄 id 特判。
import { applyDamage as _applyDamage, applyFortDamage as _applyFortDamage } from './damage.js';
import { randomThrow } from './duel.js';
import { ELEMENTS } from '../types.js';

export const applyDamage = _applyDamage;
export const applyFortDamage = _applyFortDamage;

// ---------- 通用状态 statuses[]（解耦"麻醉/逮捕/开罚单/关押/沉默/免疫"等）----------
// status: { type, turns, source?, flag? }  turns<=0 表示永久（本局）
export function applyStatus(player, status) {
  const i = player.statuses.findIndex((s) => s.type === status.type && (status.source == null || s.source === status.source));
  if (i >= 0) {
    // 同来源刷新时长（取较大）
    player.statuses[i].turns = Math.max(player.statuses[i].turns, status.turns || 0);
    if (status.flag) player.statuses[i].flag = status.flag;
  } else {
    player.statuses.push({ type: status.type, turns: status.turns || 0, source: status.source ?? null, flag: status.flag ?? null });
  }
}
export function hasStatus(player, type, flag) {
  return player.statuses.some((s) => s.type === type && (flag == null || s.flag === flag));
}
export function clearStatus(player, type, source) {
  player.statuses = player.statuses.filter((s) => !(s.type === type && (source == null || s.source === source)));
}
// 回合边界衰减（upkeep 调用）；turns<=0 永久保留
export function tickStatuses(player) {
  player.statuses = player.statuses.filter((s) => {
    if (s.turns > 0) { s.turns -= 1; return s.turns > 0; }
    return true;
  });
}

// ---------- 1v1 判定（侧猜拳）：双方随机出拳，返回 'a' | 'b' | 'tie' ----------
export function resolveDuel(rng, log, elements = ELEMENTS.K5) {
  const a = randomThrow(rng, elements);
  const b = randomThrow(rng, elements);
  const ka = elements.indexOf(a), kb = elements.indexOf(b);
  const m = Math.floor((elements.length - 1) / 2);
  const d = (kb - ka + elements.length) % elements.length;
  if (a === b) return 'tie';
  return d >= 1 && d <= m ? 'a' : 'b';
}

// 重复侧猜拳直到非平（上限 n 次）
export function resolveDuelLoop(rng, log, elements, n = 6) {
  for (let i = 0; i < n; i++) {
    const r = resolveDuel(rng, log, elements);
    if (r !== 'tie') return r;
  }
  return 'tie';
}

// ---------- 资源 / 物品（矿工矿石、商人金币、铁匠精铁、炼金元素等；可被小偷偷取）----------
export function addResource(player, key, n) {
  player.resources[key] = (player.resources[key] || 0) + n;
  return player.resources[key];
}
export function getResource(player, key) {
  return player.resources[key] || 0;
}
export function transferResource(from, to, key, n) {
  const have = from.resources[key] || 0;
  const take = Math.min(have, n);
  from.resources[key] = have - take;
  to.resources[key] = (to.resources[key] || 0) + take;
  return take;
}
export function addItem(player, key, item) {
  player.items[key] = item;
}
export function removeItem(player, key) {
  const it = player.items[key];
  delete player.items[key];
  return it;
}
export function hasItem(player, key) {
  return Object.prototype.hasOwnProperty.call(player.items, key);
}
