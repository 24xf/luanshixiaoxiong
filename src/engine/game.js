// 回合状态机：createState + advanceRound
// 纯函数：state + commands + rng -> 新 state（原地修改，无 I/O）
//
// 英雄相关逻辑已下放到插件架构（src/engine/heroes/）：
//   - 玩家创建 / 攻击力 / 技能 / 回合维护 分别走 registry 的 makePlayer / effectiveAtk / applySkill / runUpkeep
//   - 伤害统一走 combat.js 的 dealDamage（触发各英雄钩子）
//   - 逮捕/麻醉/关押/工事违章 等统一用通用状态 statuses，本文件不再写任何英雄 id 特判
import { elementsOf, shuffle } from '../types.js';
import { resolveRps } from './rps.js';
import { chargeDamage, MAX_CHARGE } from './charge.js';
import { buildFort } from './fort.js';
import { makeFort } from '../types.js';
import { makePlayer, effectiveAtk, applySkill, getHeroData, runUpkeep } from './heroes/index.js';
import { dealDamage } from './combat.js';
import { hasStatus } from './effects.js';
import { onRedrawTie, resolvePendingEvent } from './events.js';
import { randomThrow } from './duel.js';

export function createState(heroIds, seed = 12345, mode = 'free', elementSet = 'five') {
  const players = heroIds.map((hid, i) => makePlayer(hid, i, i));
  return {
    seed,
    mode, // 'free' 乱斗（默认）
    elementSet, // 'five' 五元 / 'three' 三元（石头剪刀布）
    elements: elementsOf(elementSet),
    pendingEvent: null, // 平局抽定但尚未公布的随机事件（只触发一次）
    turn: 1,
    players,
    phase: 'rps',
    winner: null,
    lastEvent: null,
    suddenDeath: false, // 超时进入猝死：伤害翻倍、工事不再自愈
    // 回合临时标志
    roundDamageBonus: 0,
    chargeInterestDouble: false,
    mirrorPair: null,
    skipActionsThisRound: false,
    forceRandomNext: false,
    log: [],
  };
}

// 战前准备：随机分配座次（整局固定）。服务器权威调用。
export function assignSeatsRandom(state, rng) {
  const ids = state.players.map((p) => p.id);
  const order = shuffle(rng, ids);
  order.forEach((id, idx) => { state.players[id].seat = idx + 1; });
}

// 战前准备：按组队配置分配阵营（整局固定）。config 如 '33'/'222'/'3333'。
export function assignTeams(state, configStr) {
  const sizes = String(configStr).split('').map(Number);
  const ordered = [...state.players].sort((a, b) => a.seat - b.seat);
  let idx = 0;
  sizes.forEach((sz, teamId) => {
    for (let k = 0; k < sz; k++) { if (ordered[idx]) ordered[idx].team = teamId; idx++; }
  });
}

export const SUDDEN_DEATH_TURN = 200; // 超过此回合进入猝死，保证对局收敛（导出供 server/room.ts 同源复用，#B1 修复）

function alivePlayers(state) {
  return state.players.filter((p) => !p.dead);
}

function doAttack(state, pid, tid, charge, rng, sub) {
  const p = state.players[pid];
  const t = state.players[tid];
  if (!t || t.dead) return;
  const base = effectiveAtk(p, state);
  let dmg;
  if (charge > 0) {
    dmg = chargeDamage(base, charge);
    if (state.chargeInterestDouble) dmg *= 2;
  } else {
    dmg = base;
  }
  if (state.suddenDeath) dmg *= 2; // 猝死：伤害翻倍
  dmg += state.roundDamageBonus;
  // 冰箱：被麻醉角色额外受伤（通用近似；更精确应为仅医生+冰箱，Phase0 简化）
  if (hasStatus(t, 'anaesthetized')) dmg += 1;
  // 所有伤害走 dealDamage（触发吸血/剑仙/乾坤等钩子 + 警车免疫）
  dealDamage(state, tid, dmg, { isBasic: true, sourceId: pid, rng, sub, log: (m) => state.log.push(m) });
  state.log.push(`${p.name} 攻击 ${t.name} ${dmg}伤`);
}

// commands: { [pid]: { element, action } }  action={type, target?, skillId?, sub?}
export function advanceRound(state, commands, rng) {
  const log = (m) => state.log.push(m);
  // 1. 重置回合标志
  state.roundDamageBonus = 0;
  state.chargeInterestDouble = false;
  state.mirrorPair = null;
  if (state.turn > SUDDEN_DEATH_TURN) state.suddenDeath = true;
  let skipActions = state.skipActionsThisRound;
  state.skipActionsThisRound = false;

  // 2. 猜拳（含重猜循环）
  let redraws = 0;
  let winners = [];
  let announced = false;
  while (redraws < 6) {
    const alive = alivePlayers(state);
    const throws = alive.map((p) => {
      if (hasStatus(p, 'anaesthetized')) return randomThrow(rng, state.elements);
      // #B2 元素暴走：标记生效的回合，首次收拳即强制全员随机元素，并立即消费（置 false）。
      // 这样 E3 在上一回合重猜时抽中、设置的标记，会作用于"下一回合"的全部收拳（含重猜），名副其实。
      if (state.forceRandomNext) { state.forceRandomNext = false; return randomThrow(rng, state.elements); }
      if (redraws > 0) return randomThrow(rng, state.elements);
      return commands[p.id].element;
    });
    const res = resolveRps(throws, state.elements);
    if (!res.redraw) {
      winners = res.winners.map((wi) => alive[wi].id);
      break;
    }
    // 重猜：抽定随机事件（只抽一次，内容待分出胜负后公布）
    onRedrawTie(state, rng);
    if (state.pendingEvent != null && !announced) { log('平局！接下来会有随机事件'); announced = true; }
    redraws++;
    if (skipActions) break;
  }
  // 重猜结束分出胜负 → 公布并执行挂起事件（只触发一次）
  if (state.pendingEvent != null) resolvePendingEvent(state, rng, log);
  state.forceRandomNext = false;

  // 麻醉者不能成为赢家（下回合不参与猜拳）
  winners = winners.filter((id) => !hasStatus(state.players[id], 'anaesthetized'));

  // 组装 actions（仅赢家需要）
  const actions = {};
  for (const id of winners) actions[id] = commands[id] ? commands[id].action : null;

  applyActions(state, winners, actions, rng);
}

// 单个赢家行动解析（被 advanceRound 与联网服共用）
function resolveAction(state, p, act, rng, log) {
  // 镜像结界限制（B5：限一切主动行动，结界内只可互攻/互放技能）
  // 仅允许：对结界对手 attack / 对结界对手 skill / pass；建造·蓄力·对自身或第三方的技能一律拦截。
  if (state.mirrorPair && state.mirrorPair.includes(p.id)) {
    const other = state.mirrorPair.find((x) => x !== p.id);
    const allowed =
      (act.type === 'attack' && act.target === other) ||
      (act.type === 'skill' && act.target === other) ||
      act.type === 'pass';
    if (!allowed) { log(`${p.name} 受镜像结界限制，仅可与结界对手互攻/互放技能`); return; }
  }
  switch (act.type) {
    case 'attack': doAttack(state, p.id, act.target, p.charge, rng, act.sub); p.charge = 0; break;
    case 'charge':
      if (p.charge >= MAX_CHARGE) { doAttack(state, p.id, act.target, p.charge, rng, act.sub); p.charge = 0; }
      else p.charge = Math.min(MAX_CHARGE, p.charge + 1);
      break;
    case 'build':
      // 工事违章（开罚单）期间不可新建
      if (hasStatus(p, 'fortDisabled')) { log(`${p.name} 工事违章，本回合不可新建`); break; }
      // 农夫：远位(稻草人)按车道模型补位
      if (p.lanes && p.lanes.length) {
        const empty = p.lanes.findIndex((l) => !l.far || l.far.hp <= 0);
        if (empty < 0) { log(`${p.name} 远位(稻草人)已满`); break; }
        p.lanes[empty].far = makeFort(getHeroData(p.heroId).lanes.far);
        log(`${p.name} 建造稻草人(远位${empty + 1})`);
        break;
      }
      // 其余英雄（含剑客重建被毁葫芦）：优先填补被摧毁槽位，否则传送带新建
      {
        const proto = getHeroData(p.heroId)?.fort;
        if (proto) {
          const f = buildFort(p, proto);
          // 升级加成：该英雄若对该工事名有永久建造加成(下井升级累计)，加到新建/重建的工事上
          // → 升级过的建筑血量上限永久提高
          if (f && f.name === proto.name && p.fortBonus && p.fortBonus[proto.name]) {
            const bonus = p.fortBonus[proto.name];
            f.maxHp += bonus;
            f.hp += bonus;
            log(`${p.name} 建造 ${proto.name} → 受升级加成+${bonus}血(上限${f.maxHp})`);
          }
        }
      }
      break;
    case 'skill':
      applySkill({ state, pid: p.id, skillId: act.skillId, tid: act.target, sub: act.sub, rng, log });
      break;
    case 'pass':
    default: break;
  }
}

// 结算阶段：按座次应用赢家行动 + 回合维护 + 胜负判定
// opts.sandbox: 沙盒模式下"回合以操作计"，仅真正提交非 pass 行动(在 actions 中存在且非 pass)的英雄算本回合赢家。
export function applyActions(state, winners, actions, rng, opts = {}) {
  const log = (m) => state.log.push(m);

  // —— lastRoundWon 单一归属源（#10 修复）——
  // 修复前 advanceRound（引擎自对弈/测试路径）从不设该标志，而联网服 runRound 手动设，
  // 导致所有回归测试里 upkeep（矿工产矿/ builder 等产出）永不触发，测试平衡结论与真实服不一致。
  // 现收敛到本函数：advanceRound 与 runRound 共用，两路语义一致，成为唯一真相源。
  // 普通模式：所有 rps 赢家都算"赢了这一回合"——即便选择 pass，本回合仍产出（与服务器一致）。
  // 沙盒模式：仅真正提交非 pass 行动的英雄算赢家，才触发其 upkeep 产出（结算谁谁产）。
  for (const p of state.players) p.lastRoundWon = false;
  for (const id of winners) {
    const p = state.players[id];
    if (!p) continue;
    if (opts.sandbox) {
      const act = actions[id];
      if (act && act.type && act.type !== 'pass') p.lastRoundWon = true;
    } else {
      p.lastRoundWon = true;
    }
  }

  const skip = state.skipActionsThisRound;

  // 3. 行动（按座次从小到大 = seat 升序）
  if (!skip && winners.length > 0) {
    const ordered = winners
      .map((id) => state.players[id])
      .sort((a, b) => a.seat - b.seat);
    for (const p of ordered) {
      if (p.dead) continue;
      if (hasStatus(p, 'arrested')) { log(`${p.name} 被逮捕，本回合不能行动`); continue; }
      const act = actions[p.id];
      if (!act) continue;
      resolveAction(state, p, act, rng, log);
    }
  }

  // 4. 回合维护：统一交给各英雄策略 onUpkeep（ carpenter/builder/farmer/铁匠/商人 等个性化逻辑已迁入策略）
  runUpkeep(state, rng);

  // 5. 胜负判定
  const alive = alivePlayers(state);
  if (state.mode === 'team') {
    // 组队战：存活者同属一个阵营 → 该阵营获胜（winner 记阵营 id）
    const teams = new Set(alive.map((p) => p.team));
    if (teams.size <= 1) {
      state.phase = 'over';
      state.winner = alive.length > 0 ? alive[0].team : null;
    }
  } else {
    // 乱斗战：仅剩 1 人
    if (alive.length <= 1) {
      state.phase = 'over';
      state.winner = alive.length === 1 ? alive[0].id : null;
    }
  }

  // 回合级事件标志消费后复位（关键：服务器路径直接调用 applyActions，
  // 不经过 advanceRound 的重置逻辑，若不在此复位，E9 等事件会永久生效）。
  // 注：forceRandomNext 不在本处复位——联网服 runRound 在收拳阶段消费后即复位（早于 roundResult 发出），
  // 使客户端"元素暴走"横幅仅出现在抽中该事件的回合，不会泄漏到后续回合。
  state.roundDamageBonus = 0;
  state.chargeInterestDouble = false;
  state.mirrorPair = null;
  state.skipActionsThisRound = false;

  state.turn++;
}
