// B1+B2+B3 回归：三个影响真实对局的硬 bug 修复锁。
//   B1 猝死触发（联网服路径补 suddenDeath 判断 + 伤害翻倍）
//   B2 元素暴走生效（runRound 收拳消费 forceRandomNext，E3 不再线上无效/泄漏）
//   B3 农夫车道修好（applyDamageLanes 顺序吸收全部 lanes，三路防御真正生效）
import { Room } from './room.js';
import { createStorage } from './storage.js';
import { getBus } from './bus.js';
import { createState, assignSeatsRandom, advanceRound } from '../src/engine/game.js';
import { applyDamage } from '../src/engine/damage.js';
import { makeFort } from '../src/types.js';
import { EVENTS } from '../src/engine/events.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeIo() {
  const cap: Record<string, any> = {};
  const inst: any = { to: () => ({ emit: (ev: string, data: any) => { cap[ev] = data; } }), _cap: cap };
  return inst;
}
async function setup(heroIds: string[]) {
  const io = fakeIo();
  const storage = await createStorage();
  const bus = await getBus();
  const room: any = new Room('b123_' + Math.random().toString(36).slice(2, 7), io as any, storage, bus, 'test-inst');
  heroIds.forEach((h) => room.addMember(h, h));
  room.state = createState(heroIds, 12345, 'free', 'five');
  assignSeatsRandom(room.state, () => 0.5);
  (room as any).heroIds = heroIds;
  (room as any).running = true;
  return { room: room as any, io: io as any };
}

async function main() {
  // ---------------- B1 猝死触发 ----------------
  console.log('[b1b2b3-test] B1 猝死触发（联网服路径）');
  {
    // 用高血目标隔离"翻倍"语义：剑客剑仙被动追加半伤，猝死时连"基础+追加"一起翻倍 → 总伤恰为 2x。
    const runOne = async (turn: number) => {
      const { room } = await setup(['farmer', 'swordsman']);
      room.sandbox = true;
      room.state.turn = turn;
      room.state.players[0].hp = 100; room.state.players[0].maxHp = 100; // 高血便于观测精确掉血
      const tFarmer = room.members.get(0).token;
      const tSword = room.members.get(1).token;
      const p = room.runRound();
      await tick(50); // 等待 actionWait 建立
      room.onAction(tFarmer, 0, { type: 'pass' });
      room.onAction(tSword, 1, { type: 'attack', target: 0 }); // 剑客攻农夫
      await p;
      return room;
    };
    const low = await runOne(5);
    const high = await runOne(201);
    const dropLow = 100 - low.state.players[0].hp;
    const dropHigh = 100 - high.state.players[0].hp;
    check('#B1a 低回合不猝死', low.state.suddenDeath === false);
    check('#B1b 高回合进入猝死', high.state.suddenDeath === true);
    check('#B1c 猝死总伤恰为 2x（含剑仙追加翻倍）', dropHigh === 2 * dropLow && dropLow > 0);
    check('#B1d 交叉校验：低回合掉 9（6基础+剑仙3）', dropLow === 9);
    check('#B1e 交叉校验：高回合掉 18（12基础+剑仙6）', dropHigh === 18);
    low.destroy(); high.destroy();
  }

  // ---------------- B2 元素暴走生效 ----------------
  console.log('[b1b2b3-test] B2 元素暴走（forceRandomNext 消费复位）');
  {
    // 联网服路径：设 forceRandomNext，跑一回合，标记应被消费复位（否则 E3 线上无效+永久泄漏）。
    const { room } = await setup(['doctor', 'swordsman']);
    room.state.forceRandomNext = true;
    const p = room.runRound();
    await tick(1500); // 离线成员由 AI 托管兜底，约 800ms 后结束
    await p;
    check('#B2a 收拳后 forceRandomNext 被消费复位', room.state.forceRandomNext === false);
    room.destroy();
  }
  {
    // 引擎路径（advanceRound）同样消费：直接调引擎，标记应复位。
    const s: any = createState(['doctor', 'swordsman'], 999, 'free', 'five');
    s.forceRandomNext = true;
    const cmds = { 0: { element: '数', action: { type: 'pass' } }, 1: { element: '物', action: { type: 'pass' } } };
    advanceRound(s, cmds, () => 0.5);
    check('#B2b advanceRound 消费 forceRandomNext', s.forceRandomNext === false);
  }
  {
    // 负向：初始无标记，跑完仍无标记，不被误置。
    const { room } = await setup(['doctor', 'swordsman']);
    const p = room.runRound();
    await tick(1500);
    await p;
    check('#B2c 初始无标记保持 false', room.state.forceRandomNext === false);
    room.destroy();
  }
  {
    // 事件本体：E3(元素暴走) apply 即置位 forceRandomNext，由 B2 路径在下一回合收拳消费。
    const s: any = createState(['doctor', 'swordsman'], 1, 'free', 'five');
    const e3: any = EVENTS.find((e: any) => e.id === 'E3');
    e3.apply(s, () => 0.5, () => {});
    check('#B2e E3.apply 置位 forceRandomNext', s.forceRandomNext === true);
  }

  // ---------------- B3 农夫车道修好 ----------------
  console.log('[b1b2b3-test] B3 农夫车道（顺序吸收全部 lanes）');
  function farmerWith(lanes: any[]) { return { id: 0, dead: false, hp: 10, maxHp: 10, fortFar: null, fortNear: null, lanes }; }
  {
    // 三路全建（far5/near5 x3），吃 100 伤：顺序吸收后本体仅剩 3 溢出（旧实现只处理 lanes[0] 会漏给本体 45）。
    const f = farmerWith([
      { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) },
      { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) },
      { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) },
    ]);
    const state: any = { players: [f] };
    applyDamage(state, 0, 100, {});
    check('#B3a 三路顺序吸收：本体仅受 3 溢出（hp=7）', f.hp === 7);
    check('#B3a 三路远/近位全部清空', f.lanes.every((l: any) => l.far.hp === 0 && l.near.hp === 0));
  }
  {
    // 单路吸收小伤：lane0 far5/near5，吃 8 伤 → 远位清空、近位剩 2，本体不露（hp=10）。
    const f = farmerWith([
      { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) },
      { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) },
      { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) },
    ]);
    const state: any = { players: [f] };
    applyDamage(state, 0, 8, {});
    check('#B3b 单路吸收小伤：本体不受伤（hp=10）', f.hp === 10);
    check('#B3b 远位清空、近位剩 2', f.lanes[0].far.hp === 0 && f.lanes[0].near.hp === 2);
    check('#B3b 其余两路未被动', f.lanes[1].far.hp === 5 && f.lanes[1].near.hp === 5 && f.lanes[2].far.hp === 5);
  }
  {
    // 空车道（初始未建造）：伤害直击本体，无回归（6 伤 → hp=4）。
    const f = farmerWith([
      { far: null, near: null },
      { far: null, near: null },
      { far: null, near: null },
    ]);
    const state: any = { players: [f] };
    applyDamage(state, 0, 6, {});
    check('#B3c 空车道直击本体（hp=4，无回归）', f.hp === 4);
  }
  {
    // 中途：lane0 已清空、lane1 完好，吃 20 伤 → 经 lane1 吸收后本体只受少量（验证溢出跨路传导+减半）。
    const f = farmerWith([
      { far: makeFort({ name: '稻草人', hp: 0 }), near: makeFort({ name: '粮食', hp: 0 }) }, // 已清空
      { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) },
      { far: makeFort({ name: '稻草人', hp: 5 }), near: makeFort({ name: '粮食', hp: 5 }) },
    ]);
    const state: any = { players: [f] };
    applyDamage(state, 0, 20, {});
    // lane0 已空跳过；lane1: far5→rem15, near5→overflow=floor(10/2)=5, rem5; lane2: far5→rem0(剩0? 5>=5 rem0), 停。
    // 实际：lane1 far 20>=5 rem15 far0; near 15>=5 overflow=floor(10/2)=5 rem5; lane2 far 5>=5 rem0 far0; near 0<5 near.hp=5 rem0.
    // → 本体 0 伤，hp=10。
    check('#B3d 跨路传导：lane0 空→lane1/2 吸收，本体 0 伤（hp=10）', f.hp === 10);
    check('#B3d lane1 far 清空/near 剩0', f.lanes[1].far.hp === 0 && f.lanes[1].near.hp === 0);
    check('#B3d lane2 far 清空/near 完好', f.lanes[2].far.hp === 0 && f.lanes[2].near.hp === 5);
  }

  console.log(`\n[b1b2b3-test] 结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('[b1b2b3-test] ❌', e); process.exit(1); });
