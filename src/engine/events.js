// 随机事件（平局重猜时触发）。环境效果，默认不被单体技能抵消。
import { applyDamage, applyFortDamage } from './damage.js';
import { makeFort, randInt, shuffle } from '../types.js';

export const EVENTS = [
  { id: 'E1', name: '天降陨石', weight: 1, minPlayers: 2, apply: (s, rng, log) => {
      const alive = s.players.filter(p => !p.dead);
      const t = alive[randInt(rng, alive.length)];
      if (t.fortFar && t.fortFar.hp > 0) applyFortDamage(s, t.id, 5);
      else if (t.fortNear && t.fortNear.hp > 0) applyFortDamage(s, t.id, 5);
      else applyDamage(s, t.id, 3, { isBasic: false, ignoreFort: true });
      log('事件·天降陨石');
    } },
  { id: 'E2', name: '五谷丰登', weight: 1, minPlayers: 2, apply: (s, rng, log) => {
      for (const p of s.players) if (!p.dead) p.hp = Math.min(p.maxHp, p.hp + 2);
      log('事件·五谷丰登（全员+2血）');
    } },
  { id: 'E3', name: '元素暴走', weight: 1, minPlayers: 6, apply: (s, rng, log) => {
      s.forceRandomNext = true; log('事件·元素暴走（下轮全员随机元素）');
    } },
  { id: 'E4', name: '座次洗牌', weight: 1, minPlayers: 2, apply: (s, rng, log) => {
      const alive = s.players.filter(p => !p.dead);
      const a = alive[randInt(rng, alive.length)], b = alive[randInt(rng, alive.length)];
      if (a !== b) { const tmp = a.seat; a.seat = b.seat; b.seat = tmp; }
      log('事件·座次洗牌');
    } },
  { id: 'E5', name: '军火快递', weight: 1, minPlayers: 2, apply: (s, rng, log) => {
      const alive = s.players.filter(p => !p.dead);
      const t = alive[randInt(rng, alive.length)];
      t.fortFar = makeFort({ name: '木箱', hp: 4 });
      log('事件·军火快递（随机获得木箱工事）');
    } },
  { id: 'E6', name: '暴击诅咒', weight: 1, minPlayers: 2, apply: (s, rng, log) => {
      s.roundDamageBonus = 2; log('事件·暴击诅咒（本回合攻击+2）');
    } },
  { id: 'E7', name: '赌徒的祝福', weight: 1, minPlayers: 6, apply: (s, rng, log) => {
      s.chargeInterestDouble = true; log('事件·赌徒的祝福（蓄力利息翻倍）');
    } },
  { id: 'E8', name: '镜像结界', weight: 1, minPlayers: 6, apply: (s, rng, log) => {
      const alive = shuffle(rng, s.players.filter(p => !p.dead));
      if (alive.length >= 2) s.mirrorPair = [alive[0].id, alive[1].id];
      log('事件·镜像结界（两人仅可互攻）');
    } },
  { id: 'E9', name: '太平轮休', weight: 1, minPlayers: 2, apply: (s, rng, log) => {
      s.skipActionsThisRound = true; log('事件·太平轮休（本重猜回合无人行动）');
    } },
  { id: 'E10', name: '点石成金', weight: 1, minPlayers: 2, apply: (s, rng, log) => {
      const alive = s.players.filter(p => !p.dead);
      const t = alive[randInt(rng, alive.length)];
      t.resources.gold = (t.resources.gold || 0) + 5; log('事件·点石成金（随机+5金）');
    } },
];

// 加权抽取（避开上一次事件；按人数过滤）
export function drawEvent(state, rng) {
  const pool = EVENTS.filter(e => e.minPlayers <= state.players.filter(p => !p.dead).length && e.id !== state.lastEvent);
  if (pool.length === 0) return null;
  const total = pool.reduce((s, e) => s + e.weight, 0);
  let x = rng() * total;
  for (const e of pool) { x -= e.weight; if (x <= 0) return e; }
  return pool[pool.length - 1];
}

// 平局（重猜）时调用：若当前没有挂起事件，抽一个确定性事件标记为 pendingEvent。
// 注意：只"抽定"不"执行"、不剧透内容——内容在重猜分出胜负后才公布并执行。
export function onRedrawTie(state, rng) {
  if (state.pendingEvent == null) {
    const e = drawEvent(state, rng);
    if (e) state.pendingEvent = e.id;
  }
}

// 重猜后分出胜负时调用：若有挂起事件，公布具体内容并执行其效果，随后清除。
// 无论经历多少次重猜，事件只触发一次（pendingEvent 一旦消费即清空）。
export function resolvePendingEvent(state, rng, log) {
  if (state.pendingEvent == null) return null;
  const id = state.pendingEvent;
  state.pendingEvent = null;
  const e = EVENTS.find((x) => x.id === id);
  if (!e) return null;
  state.lastEvent = e.id;
  e.apply(state, rng, log);
  return e;
}
