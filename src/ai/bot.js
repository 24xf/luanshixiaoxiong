// AI 策略（Phase0 启发式，产出与真人同构的 Command）
import { randInt } from '../types.js';
import { effectiveAtk } from '../engine/heroes/index.js';
import { skillTarget } from '../engine/heroes/index.js';

// 各英雄招牌技能 + 触发概率（托管时积极用技能，而非只平A）
// 概率取合理区间：技能是英雄核心强度，但也不能全变"蓄力/技能怪"导致对局长期僵持无法收敛。
// onAction 会二次校验，非法目标自动降级为 pass。
const SIGNATURE = {
  doctor: { id: '麻醉', prob: 0.55 },
  police: { id: '逮捕', prob: 0.5 },
  chef: { id: '小菜一碟', prob: 0.45 },
  builder: { id: '拆迁大队', prob: 0.45 },
  miner: { id: '地道战', prob: 0.45 },
  merchant: { id: '贿赂', prob: 0.4 },
  swordsman: { id: '乾坤大挪移', prob: 0.45 },
  vampire: { id: '吸血', prob: 0.45 },
  carpenter: { id: '重建', prob: 0.4 },
  blacksmith: { id: '铸剑', prob: 0.3 },
  farmer: { id: '播种', prob: 0.45 },
};

// 选一个攻击目标：存活且非自己，集火最弱（英雄血量为主、工事血量折算）
function chooseTarget(state, pid) {
  let best = null, bestScore = Infinity;
  for (const p of state.players) {
    if (p.dead || p.id === pid) continue;
    const fortHp = (p.fortFar ? p.fortFar.hp : 0) + (p.fortNear ? p.fortNear.hp : 0);
    // 英雄本体权重高，工事折算 0.5：优先打残血/无工事目标，形成集火收敛
    const score = p.hp + fortHp * 0.5;
    if (score < bestScore) { bestScore = score; best = p.id; }
  }
  return best;
}

// 循环猜拳克制判定：元素 a 是否赢元素 b（基于本局元素集的循环顺序）
function beats(a, b, els) {
  const i = els.indexOf(a), j = els.indexOf(b);
  if (i < 0 || j < 0 || a === b) return false;
  const m = Math.floor((els.length - 1) / 2);
  const d = (j - i + els.length) % els.length;
  return d >= 1 && d <= m;
}

// 基于敌人近期出拳预测，选能赢最多的元素（无历史则随机）
function pickWinningElement(state, pid, rng) {
  const els = state.elements || ['数', '物', '化', '生', '计'];
  const enemyThrows = [];
  for (const p of state.players) {
    if (p.dead || p.id === pid) continue;
    const t = state.lastThrows && state.lastThrows[p.id];
    if (t && els.includes(t)) enemyThrows.push(t);
  }
  if (enemyThrows.length === 0) return els[randInt(rng, els.length)];
  let best = null, bestWins = -1;
  for (const e of els) {
    let wins = 0;
    for (const t of enemyThrows) if (beats(e, t, els)) wins++;
    if (wins > bestWins) { bestWins = wins; best = e; }
  }
  return best || els[randInt(rng, els.length)];
}

// 技能目标：依技能目标类型决定（enemy→最弱敌；ally/self→自身；none→null）
function skillTargetFor(heroId, skillId, pid, enemyTarget) {
  const t = skillTarget(heroId, skillId);
  if (t === 'self' || t === 'none') return null;
  if (t === 'ally') return pid;
  return enemyTarget; // enemy
}

// 为单个玩家决策
export function decide(state, pid, rng) {
  const p = state.players[pid];
  if (p.dead) return null;
  const element = pickWinningElement(state, pid, rng);
  const target = chooseTarget(state, pid);
  if (!target) return { element, action: { type: 'charge' } };

  const r = rng();
  const sig = SIGNATURE[p.heroId];
  if (sig) {
    const tgt = skillTargetFor(p.heroId, sig.id, pid, target);
    if (r < sig.prob) return { element, action: { type: 'skill', skillId: sig.id, target: tgt } };
  }

  // 无工事则优先建造（加快成型）；其余以"直击为主、蓄力为辅"，避免长期僵持无法收敛。
  const hasFort = p.fortFar || p.fortNear;
  if (!hasFort && r < 0.8) return { element, action: { type: 'build' } };
  if (r < 0.9) return { element, action: { type: 'charge', target } };
  return { element, action: { type: 'attack', target } };
}

// 为所有存活玩家生成 commands
export function decideAll(state, rng) {
  const cmds = {};
  for (const p of state.players) {
    if (p.dead) continue;
    cmds[p.id] = decide(state, p.id, rng);
  }
  return cmds;
}
