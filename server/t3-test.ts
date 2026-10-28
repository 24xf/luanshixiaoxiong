// T3 回归：#13 事件状态快照 + roundResult events；#14 AI 托管复用 bot 放技能。
import { Room } from './room.js';
import { createStorage } from './storage.js';
import { getBus } from './bus.js';
import { createState, assignSeatsRandom } from '../src/engine/game.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// 假 io：捕获所有 emit 的最后一个载荷，便于检查 roundResult 结构
function fakeIo() {
  const cap: Record<string, any> = {};
  const inst: any = {
    to: () => ({ emit: (ev: string, data: any) => { cap[ev] = data; } }),
    _cap: cap,
  };
  return inst;
}

async function setup(heroIds: string[]) {
  const io = fakeIo();
  const storage = await createStorage();
  const bus = await getBus();
  const room: any = new Room('t3_' + Math.random().toString(36).slice(2, 7), io as any, storage, bus, 'test-inst');
  heroIds.forEach((h) => room.addMember(h, h));
  // 手动建状态，避免 startGame 自动跑 runLoop（我们只想定向测试）
  room.state = createState(heroIds, 12345, 'free', 'five');
  assignSeatsRandom(room.state, () => 0.5);
  (room as any).heroIds = heroIds;
  (room as any).running = true;
  return { room: room as any, io: io as any };
}

async function main() {
  console.log('[t3-test] #13 事件状态快照 / roundResult events');
  {
    const { room } = await setup(['doctor', 'swordsman']);
    room.state.forceRandomNext = true;
    room.state.skipActionsThisRound = true;
    room.state.mirrorPair = [0, 1];
    room.state.pendingEvent = 'E3';
    room.state.players[0].statuses.push({ type: 'jailed', turns: 1 });
    room.state.players[1].statuses.push({ type: 'fortDisabled', turns: 2 });
    const snap = room.snapshot();
    check('#13a snapshot.forceRandomNext 透传', snap.forceRandomNext === true);
    check('#13a snapshot.skipActionsThisRound 透传', snap.skipActionsThisRound === true);
    check('#13a snapshot.mirrorPair 透传', JSON.stringify(snap.mirrorPair) === '[0,1]');
    check('#13a snapshot.pendingEvent 透传', snap.pendingEvent === 'E3');
    check('#13a 玩家 jailed 透传', snap.players[0].jailed === true);
    check('#13a 玩家 fortDisabled 透传', snap.players[1].fortDisabled === true);
    check('#13a 反向：另一玩家无状态为 false', snap.players[1].jailed === false && snap.players[0].fortDisabled === false);
    room.destroy();
  }
  {
    const { room, io } = await setup(['doctor', 'swordsman']);
    room.state.forceRandomNext = true;
    room.state.mirrorPair = [0, 1];
    room.state.players[1].statuses.push({ type: 'jailed', turns: 1 });
    const p = room.runRound().catch(() => {});
    await new Promise((r) => setTimeout(r, 250)); // roundResult 在 action 阶段之前已发
    const rr = io._cap['roundResult'];
    check('#13b roundResult 携带 events 块', !!rr && !!rr.events);
    check('#13b events.forceRandomNext 字段存在(布尔)', !!rr && typeof rr.events.forceRandomNext === 'boolean');
    check('#13b 本回合收拳已消费 forceRandomNext → roundResult 为 false（不再永久泄漏）', !!rr && rr.events.forceRandomNext === false);
    check('#13b events.mirrorPair', !!rr && JSON.stringify(rr.events.mirrorPair) === '[0,1]');
    check('#13b events.jailed 含 pid1', !!rr && Array.isArray(rr.events.jailed) && rr.events.jailed.includes(1));
    check('#13b events.fortDisabled 为数组', !!rr && Array.isArray(rr.events.fortDisabled));
    check('#13b events 含 4 个顶层标志', !!rr && ['forceRandomNext','skipActionsThisRound','mirrorPair','pendingEvent'].every((k) => k in rr.events));
    room.destroy();
    await p;
  }

  console.log('[t3-test] #14 AI 托管复用 bot 放技能');
  {
    const { room } = await setup(['doctor', 'swordsman']);
    const acts: any[] = [];
    for (let i = 0; i < 50; i++) acts.push(room.aiAction(0));
    check('#14 aiAction 全部为合法行动类型', acts.every((a) => ['attack', 'charge', 'build', 'skill', 'pass'].includes(a.type)));
    check('#14 医生托管会使用技能(麻醉)', acts.some((a) => a.type === 'skill' && a.skillId === '麻醉'));
    check('#14 技能带合法目标 pid', acts.filter((a) => a.type === 'skill').every((a) => typeof a.target === 'number'));
    // 兜底：敌人全灭不应抛错，返回合法类型
    room.state.players[1].dead = true;
    const fb = room.aiAction(0);
    check('#14 无敌人时不抛错且返回合法类型', ['attack', 'charge', 'build', 'skill', 'pass'].includes(fb.type));
    room.destroy();
  }

  console.log(`\n[t3-test] 结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('[t3-test] ❌', e); process.exit(1); });
