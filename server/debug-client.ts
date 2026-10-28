// 单房间调试：每 10 回合打印一次全场面面观，定位为何打不死。
import { io, Socket } from 'socket.io-client';
import type { Element, StateSnapshot } from './protocol.js';

const URL = process.env.SERVER_URL || 'http://localhost:3002';
const ELS: Element[] = ['数', '物', '化', '生', '计'];
const HERO_POOL = ['chef', 'vampire', 'miner', 'doctor', 'police', 'farmer', 'carpenter', 'swordsman', 'builder'];
const rand = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
function once<T = any>(s: Socket, ev: string, t = 8000) { return new Promise<T>((res, rej) => { const x = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.once(ev, (d: T) => { clearTimeout(x); res(d); }); }); }
function emitAck<T = any>(s: Socket, ev: string, m: any, t = 8000) { return new Promise<T>((res, rej) => { const x = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.emit(ev, m, (d: T) => { clearTimeout(x); res(d); }); }); }

function pickTarget(snap: StateSnapshot, pid: number): number | null {
  const o = snap.players.filter((p) => !p.dead && p.id !== pid);
  if (!o.length) return null;
  o.sort((a, b) => { const ta = a.hp + (a.fortFar?.hp || 0) + (a.fortNear?.hp || 0); const tb = b.hp + (b.fortNear?.hp || 0) + (b.fortFar?.hp || 0); return ta !== tb ? ta - tb : a.id - b.id; });
  return o[0].id;
}
function act(snap: StateSnapshot, pid: number, hero: string) {
  const t = pickTarget(snap, pid); if (t == null) return { type: 'pass' } as any;
  const me = snap.players[pid]; const tg = snap.players[t];
  const hasFort = !!(tg.fortFar && tg.fortFar.hp > 0) || !!(tg.fortNear && tg.fortNear.hp > 0);
  if (me.charge >= 2) return { type: 'attack', target: t };
  if (hero === 'builder' && hasFort) return { type: 'skill', skillId: '拆迁大队', target: t };
  if (hero === 'miner' && hasFort) return { type: 'skill', skillId: '地道战', target: t };
  if (hero === 'doctor') return { type: 'skill', skillId: '麻醉', target: t };
  if (hero === 'police') return { type: 'skill', skillId: '逮捕', target: t };
  return { type: 'attack', target: t };
}

async function main() {
  const n = 6; const bots: any[] = []; let roomId = '';
  for (let i = 0; i < n; i++) {
    const s = io(URL, { transports: ['websocket'], forceNew: true }); await once(s, 'connect');
    const hero = HERO_POOL[i % HERO_POOL.length];
    const ack: any = i === 0 ? await emitAck(s, 'createRoom', { heroId: hero }) : await emitAck(s, 'joinRoom', { roomId, heroId: hero });
    roomId = ack.roomId; const b = { s, token: ack.token, pid: ack.playerId, hero, snaps: [] as any[] }; bots.push(b);
    s.on('roundStart', () => s.emit('submitThrow', { token: b.token, roomId, element: rand(ELS) }));
    s.on('actionPhase', (d: any) => { if (d.winners.includes(b.pid) && b.snaps.length) s.emit('submitAction', { token: b.token, roomId, action: act(b.snaps[b.snaps.length - 1], b.pid, b.hero) }); });
    s.on('state', (d: any) => { if (d?.snapshot) b.snaps.push(d.snapshot); });
  }
  await emitAck(bots[0].s, 'startGame', { roomId });
  let last = 0;
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const snap = bots[0].snaps[bots[0].snaps.length - 1]; if (!snap) continue;
    if (snap.turn - last >= 10) {
      last = snap.turn;
      const line = snap.players.map((p: any) => `${p.heroId}:${p.hp}${p.fortFar ? '(F' + p.fortFar.hp + ')' : ''}${p.fortNear ? '(N' + p.fortNear.hp + ')' : ''}${p.dead ? 'X' : ''}`).join(' ');
      console.log(`T${snap.turn} alive=${snap.players.filter((p: any) => !p.dead).length} | ${line}`);
    }
    if ((bots[0] as any)._over) { console.log('GAME OVER winner=', (bots[0] as any)._over.winner); break; }
  }
  bots.forEach((b) => b.s.close());
}
main().catch((e) => { console.error(e); process.exit(1); });
