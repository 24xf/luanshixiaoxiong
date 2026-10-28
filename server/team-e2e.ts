// 组队模式 · 服务器联通路烟测（不跑完整对局，发动机层 team-test 已验证收敛）：
// 1) 6人房 startGame({mode:'team',teamConfig:'33'}) → gameStart 快照座次分组 = [0,0,0,1,1,1]
// 2) 6人房 startGame({mode:'team',teamConfig:'43'}) → 非法配置应被拒绝（err）
import { io, Socket } from 'socket.io-client';

const URL = process.env.SERVER_URL || 'http://localhost:3001';
const HERO_POOL = ['chef', 'vampire', 'miner', 'doctor', 'police', 'farmer'];

function emitAck(s: Socket, ev: string, msg: any): Promise<any> {
  return new Promise((res) => s.emit(ev, msg, (ack: any) => res(ack)));
}

async function makeRoom(n: number): Promise<{ sockets: Socket[]; roomId: string }> {
  const sockets: Socket[] = [];
  let roomId: string | null = null;
  for (let i = 0; i < n; i++) {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((res) => s.once('connect', () => res()));
    const heroId = HERO_POOL[i % HERO_POOL.length];
    const ack: any = i === 0 ? await emitAck(s, 'createRoom', { heroId }) : await emitAck(s, 'joinRoom', { roomId: roomId!, heroId });
    if (i === 0) roomId = ack.roomId;
    sockets.push(s);
  }
  return { sockets, roomId: roomId! };
}

async function main() {
  // ---- 房间A：合法 '33' ----
  const A = await makeRoom(6);
  let gsSnap: any = null;
  A.sockets[0].once('gameStart', (d: any) => { gsSnap = d.snapshot; });
  const okA = (await emitAck(A.sockets[0], 'startGame', { roomId: A.roomId, mode: 'team', teamConfig: '33' }))?.ok;
  await new Promise((r) => setTimeout(r, 200));
  const teamsA = gsSnap ? gsSnap.players.map((p: any) => p.team).sort((a: number, b: number) => a - b) : null;
  const okTeams = JSON.stringify(teamsA) === JSON.stringify([0, 0, 0, 1, 1, 1]);

  // ---- 房间B：非法 '43'（4+3≠6）应被拒绝 ----
  const B = await makeRoom(6);
  const badAck = await emitAck(B.sockets[0], 'startGame', { roomId: B.roomId, mode: 'team', teamConfig: '43' });
  const okReject = !!badAck?.error;

  A.sockets.forEach((s) => s.close());
  B.sockets.forEach((s) => s.close());

  if (okA && okTeams && okReject) {
    console.log('PASS 组队联通路烟: 合法33分组正确, 非法43被拒');
    console.log(`  A.teams=${teamsA} | B.reject=${okReject}`);
    process.exit(0);
  } else {
    console.log('FAIL', { okA, okTeams, teamsA, okReject, badAck });
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
