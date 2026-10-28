// 核心类型与工具（纯数据，无 I/O）
// GameState / Player / Fort 的形状定义 + 种子化 RNG

// ---- 元素集（参数化，专家模式可换 elementSet）----
export const ELEMENTS = {
  K3: ['石头', '剪刀', '布'],
  K5: ['数', '物', '化', '生', '计'],
  K7: ['金', '木', '水', '火', '土', '风', '雷'],
  K9: ['数', '物', '化', '生', '计', '语', '英', '史', '政'],
};

// 命名别名（对局配置用 'five' / 'three' 选择五元或三元正则竞赛图积分制）
export const ELEMENT_SETS = {
  three: ELEMENTS.K3,
  five: ELEMENTS.K5,
  seven: ELEMENTS.K7,
  nine: ELEMENTS.K9,
};
export const DEFAULT_ELEMENT_SET = 'five';
export function elementsOf(setName) {
  return ELEMENT_SETS[setName] || ELEMENTS.K5;
}

// ---- 房间人数 / 组队配置白名单 ----
// 支持 2~12 人，但 11 人不支持；所有人数都支持乱斗（free）。
// 组队（team）仅下列人数+配置可用；配置字符串如 '33' = 两队各3人，'222' = 三队各2人。
export const ALLOWED_ROOM_SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12];
/** @type {Record<number, string[]>} */
export const TEAM_CONFIGS = {
  4: ['22'],
  6: ['222', '33'],
  8: ['2222', '44'],
  9: ['333'],
  10: ['55'],
  12: ['3333', '444', '66'],
};
export function isValidRoomSize(n) { return ALLOWED_ROOM_SIZES.includes(n); }
export function teamConfigsFor(n) { return TEAM_CONFIGS[n] || null; }

// 正则竞赛图：元素 i 克 i+1..i+m (mod K)，m = floor((K-1)/2)
export function makeBeats(K, m) {
  const beats = (a, b) => {
    const ai = a, bi = b;
    let d = (bi - ai + K) % K;
    return d >= 1 && d <= m;
  };
  return beats;
}

// 预建常用 beats
const beatsCache = {};
export function beatsOf(K) {
  if (!beatsCache[K]) beatsCache[K] = makeBeats(K, Math.floor((K - 1) / 2));
  return beatsCache[K];
}
export function beatsOfSet(elements) {
  return beatsOf(elements.length);
}

// ---- 种子化 RNG（mulberry32），保证确定性/可复现/可审计 ----
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randInt(rng, n) {
  return Math.floor(rng() * n);
}
export function pick(rng, arr) {
  return arr[randInt(rng, arr.length)];
}
export function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Fort 工厂 ----
export function makeFort(proto) {
  return {
    name: proto.name,
    hp: proto.hp,
    maxHp: proto.hp,
    effect: proto.effect || null, // 'reflect_first' | 'halve' | null
    reflectUsed: false,
    upgraded: false, // 矿工下井"升级"每工事最多一次
    bonus: proto.bonus || {}, // 各类附加数值（如 +atk, +ore, +dmg...）
  };
}
