// B5+B6+O6+O2+O7 回归：
//  B5 镜像结界限一切主动行动（结界内只可互攻/互放技能，建造/蓄力/对第三方技能均拦截）
//  B6 逮捕压制 upkeep 产出（被逮捕者本回合不触发 onUpkeep）
//  O6 麻醉者出拳由系统随机决定（服务器路径与引擎路径统一）
//  O2 持久化日志截断（长局 payload 不膨胀）
//  O7 游戏已开始时禁止增删成员（防开挂灰区）
import { createState, applyActions } from '../src/engine/game.js';
import { hasStatus } from '../src/engine/effects.js';
import { Room } from './room.js';
import { createStorage } from './storage.js';
import { getBus } from './bus.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

async function setup(heroIds: string[]) {
  const io: any = { to: () => ({ emit: () => {} }) };
  const storage = await createStorage();
  const bus = await getBus();
  const room: any = new Room('b56_' + Math.random().toString(36).slice(2, 7), io as any, storage, bus, 'test-inst');
  heroIds.forEach((h) => room.addMember(h, h));
  room.state = createState(heroIds, 12345, 'free', 'five');
  (room as any).heroIds = heroIds;
  (room as any).running = true;
  return room as any;
}

async function main() {
  console.log('[b5b6-test] B5 镜像结界 / B6 逮捕 / O6 麻醉 / O2 日志 / O7 成员');

  // ---------------- B5 镜像结界 ----------------
  {
    const s: any = createState(['doctor', 'swordsman', 'police'], 1, 'free', 'five');
    s.mirrorPair = [0, 1];
    applyActions(s, [0, 1, 2], { 0: { type: 'attack', target: 1 }, 1: { type: 'pass' }, 2: { type: 'pass' } }, () => 0.5);
    // 攻击被允许执行（剑客默认带葫芦工事，3 点攻击被挡，本体未必掉血——故以攻击日志证明"走通了 doAttack"）
    check('#B5a 结界内 attack(other) 允许：产生攻击日志', s.log.some((m: string) => m.includes('攻击') && m.includes(s.players[1].name)));
  }
  {
    const s: any = createState(['doctor', 'swordsman', 'police'], 1, 'free', 'five');
    s.mirrorPair = [0, 1];
    const b2 = s.players[2].hp;
    applyActions(s, [0, 1, 2], { 0: { type: 'attack', target: 2 }, 1: { type: 'pass' }, 2: { type: 'pass' } }, () => 0.5);
    check('#B5b 结界内 attack(第三方) 拦截：玩家2 不受伤+记日志', s.players[2].hp === b2 && s.log.some((m: string) => m.includes('受镜像结界限制')));
  }
  {
    const s: any = createState(['doctor', 'swordsman', 'police'], 1, 'free', 'five');
    s.mirrorPair = [0, 1];
    applyActions(s, [0, 1, 2], { 0: { type: 'build' }, 1: { type: 'pass' }, 2: { type: 'pass' } }, () => 0.5);
    check('#B5c 结界内 build 拦截：未建工事+记日志', !s.players[0].fortFar && !s.players[0].fortNear && s.log.some((m: string) => m.includes('受镜像结界限制')));
  }
  {
    const s: any = createState(['doctor', 'swordsman', 'police'], 1, 'free', 'five');
    s.mirrorPair = [0, 1];
    applyActions(s, [0, 1, 2], { 0: { type: 'skill', skillId: '麻醉', target: 1 }, 1: { type: 'pass' }, 2: { type: 'pass' } }, () => 0.5);
    check('#B5d 结界内 skill(other) 允许：玩家1 被麻醉', hasStatus(s.players[1], 'anaesthetized'));
  }
  {
    const s: any = createState(['doctor', 'swordsman', 'police'], 1, 'free', 'five');
    s.mirrorPair = [0, 1];
    applyActions(s, [0, 1, 2], { 0: { type: 'skill', skillId: '麻醉', target: 2 }, 1: { type: 'pass' }, 2: { type: 'pass' } }, () => 0.5);
    check('#B5e 结界内 skill(第三方) 拦截：玩家2 未被麻醉+记日志', !hasStatus(s.players[2], 'anaesthetized') && s.log.some((m: string) => m.includes('受镜像结界限制')));
  }

  // ---------------- B6 逮捕压制 upkeep ----------------
  {
    const s: any = createState(['miner', 'miner'], 1, 'free', 'five');
    s.players[0].statuses.push({ type: 'arrested', turns: 1 });
    const ore0 = s.players[0].resources.ore || 0;
    const ore1 = s.players[1].resources.ore || 0;
    applyActions(s, [0, 1], { 0: { type: 'pass' }, 1: { type: 'pass' } }, () => 0.5);
    check('#B6a 被逮捕矿工不产出(ore 不变)', (s.players[0].resources.ore || 0) === ore0);
    check('#B6b 正常矿工产出(ore +2)', (s.players[1].resources.ore || 0) === ore1 + 2);
  }

  // ---------------- O6 麻醉者出拳系统随机（服务器路径）----------------
  {
    const room = await setup(['doctor', 'swordsman']);
    room.sandbox = false;
    room.state.players[0].statuses.push({ type: 'anaesthetized', turns: 1 });
    room.state.players[1].statuses.push({ type: 'anaesthetized', turns: 1 });
    const alive = room.state.players.filter((p: any) => !p.dead);
    const throws: string[] = await room.collectThrows(alive);
    check('#O6a 被麻醉者出拳为合法随机元素', throws.length === 2 && throws.every((t: string) => room.elements.includes(t)));
    room.destroy();
  }

  // ---------------- O2 持久化日志截断 ----------------
  {
    const io: any = { to: () => ({ emit: () => {} }) };
    const storage = await createStorage();
    const bus = await getBus();
    const room: any = new Room('o2_' + Math.random().toString(36).slice(2, 7), io, storage, bus, 'test-inst');
    room.state = createState(['doctor', 'swordsman'], 1, 'free', 'five');
    room.state.log = Array.from({ length: 500 }, (_, i) => 'L' + i);
    await room.persist();
    const raw = await storage.load('room:' + room.id);
    const obj = JSON.parse(raw as string);
    check('#O2a persist 日志截断≤200', obj.state.log.length <= 200 && obj.state.log.length > 0);
    room.destroy();
  }

  // ---------------- O7 成员增删校验 ----------------
  {
    const io: any = { to: () => ({ emit: () => {} }) };
    const storage = await createStorage();
    const bus = await getBus();
    const r0: any = new Room('o7_' + Math.random().toString(36).slice(2, 7), io, storage, bus, 'test-inst');
    // 未开始（state 为空）：允许加成员 / 移除机器人
    const add1 = r0.addMember('doctor');
    check('#O7a 未开始时允许加成员', !(add1 as any).error);
    const addBot: any = r0.addBot('swordsman');
    check('#O7b 未开始时允许移除机器人', (r0.removeMember(r0.members.get(0).token, addBot.pid) as any).ok === true);
    // 模拟开战（state 非空）
    r0.state = createState(['doctor'], 1, 'free', 'five');
    check('#O7c 游戏开始后禁止加入', (r0.addMember('police') as any).error != null);
    check('#O7d 游戏开始后禁止移除', (r0.removeMember(r0.members.get(0).token, 0) as any).error != null);
    r0.destroy();
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}
main();
