// #18 Phase3 持久化写入服务：战绩统计 / 完整事件流回放 / 英雄收藏 / 房间码书签 / 玩家偏好。
// 所有函数均对“持久层未启用”安全降级（直接返回空/跳过），不抛错、不阻断游戏。
// SQL 方言无关：占位符统一 $1..；INSERT 前先 DELETE 规避“已存在”冲突（sqlite/pg 均可）。
import { randomUUID } from 'crypto';
import { getDb, dbEnabled } from './db/index.js';

export interface MatchPlayer {
  accountId: string | null;
  heroId: string | null;
  result: 'win' | 'loss' | 'draw';
}
export interface RecordMatchInput {
  roomCode: string;
  mode: string;        // 'free' | 'team'
  winner: any;         // free 模式 = 获胜者 pid(number)；team 模式 = 获胜阵营 id(number)；平局 = null
  players: MatchPlayer[];
  durationRounds: number;
  stream: any[];       // 完整事件流：每回合 { turn, throws, results, winners, events, actions, log }
}

// ---------- 战绩 + 回放 ----------
export async function recordMatch(input: RecordMatchInput): Promise<void> {
  if (!dbEnabled()) return;
  const db = getDb();
  const now = Date.now();

  // 累计战绩（仅统计已登录玩家）
  for (const p of input.players) {
    if (!p.accountId) continue;
    const rows = await db.query('SELECT * FROM stats WHERE account_id=$1', [p.accountId]);
    const s = rows[0] || { games_played: 0, wins: 0, losses: 0, draws: 0, hero_usage: '{}' };
    const games = (s.games_played || 0) + 1;
    const wins = (s.wins || 0) + (p.result === 'win' ? 1 : 0);
    const losses = (s.losses || 0) + (p.result === 'loss' ? 1 : 0);
    const draws = (s.draws || 0) + (p.result === 'draw' ? 1 : 0);
    const hu = JSON.parse(s.hero_usage || '{}');
    if (p.heroId) hu[p.heroId] = (hu[p.heroId] || 0) + 1;
    const huJson = JSON.stringify(hu);
    if (rows[0]) {
      await db.run('UPDATE stats SET games_played=$1, wins=$2, losses=$3, draws=$4, hero_usage=$5, updated_at=$6 WHERE account_id=$7',
        [games, wins, losses, draws, huJson, now, p.accountId]);
    } else {
      await db.run('INSERT INTO stats(account_id, games_played, wins, losses, draws, hero_usage, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [p.accountId, games, wins, losses, draws, huJson, now]);
    }
  }

  // 回放：每个参与账号各存一行（含完整事件流），无登录玩家则存一行 account_id=null 作为兜底记录。
  const accIds = input.players.map((p) => p.accountId).filter(Boolean) as string[];
  const ids = accIds.length ? accIds : [null];
  const playersJson = JSON.stringify(input.players.map((p) => ({ accountId: p.accountId, heroId: p.heroId, result: p.result })));
  const eventsJson = JSON.stringify({ mode: input.mode, winner: input.winner, durationRounds: input.durationRounds, stream: input.stream });
  for (const aid of ids) {
    const id = randomUUID();
    await db.run('INSERT INTO replays(id, room_code, account_id, created_at, duration_rounds, players, events, result, mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, input.roomCode, aid, now, input.durationRounds, playersJson, eventsJson, String(input.winner ?? ''), input.mode ?? 'free']);
  }
}

export async function getStats(accountId: string): Promise<any | null> {
  if (!dbEnabled()) return null;
  const db = getDb();
  const rows = await db.query('SELECT * FROM stats WHERE account_id=$1', [accountId]);
  return rows[0] || null;
}

export async function listReplays(accountId: string, limit = 20): Promise<any[]> {
  if (!dbEnabled()) return [];
  const db = getDb();
  const rows = await db.query('SELECT id, room_code, created_at, duration_rounds, result, players, mode FROM replays WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2',
    [accountId, limit]);
  return rows;
}

export async function getReplay(id: string): Promise<any | null> {
  if (!dbEnabled()) return null;
  const db = getDb();
  const rows = await db.query('SELECT * FROM replays WHERE id=$1', [id]);
  return rows[0] || null;
}

// ---------- 英雄收藏（复用 unlocks 表：本项目无“解锁玩法”，该表即“收藏英雄”集合）----------
export async function setFavorite(accountId: string, heroId: string, favorited: boolean): Promise<void> {
  if (!dbEnabled()) return;
  const db = getDb();
  if (favorited) {
    const now = Date.now();
    await db.run('DELETE FROM unlocks WHERE account_id=$1 AND hero_id=$2', [accountId, heroId]);
    await db.run('INSERT INTO unlocks(account_id, hero_id, unlocked_at) VALUES($1,$2,$3)', [accountId, heroId, now]);
  } else {
    await db.run('DELETE FROM unlocks WHERE account_id=$1 AND hero_id=$2', [accountId, heroId]);
  }
}

export async function listFavorites(accountId: string): Promise<string[]> {
  if (!dbEnabled()) return [];
  const db = getDb();
  const rows = await db.query('SELECT hero_id FROM unlocks WHERE account_id=$1', [accountId]);
  return rows.map((r: any) => r.hero_id);
}

// ---------- 房间码书签（收藏 + 快速重连）----------
export async function addBookmark(accountId: string, roomCode: string, name?: string | null): Promise<string | null> {
  if (!dbEnabled()) return null;
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  await db.run('INSERT INTO room_bookmarks(id, account_id, room_code, name, created_at) VALUES($1,$2,$3,$4,$5)',
    [id, accountId, roomCode, name || null, now]);
  return id;
}

export async function listBookmarks(accountId: string): Promise<any[]> {
  if (!dbEnabled()) return [];
  const db = getDb();
  const rows = await db.query('SELECT id, room_code, name, created_at FROM room_bookmarks WHERE account_id=$1 ORDER BY created_at DESC', [accountId]);
  return rows;
}

export async function removeBookmark(accountId: string, id: string): Promise<boolean> {
  if (!dbEnabled()) return false;
  const db = getDb();
  const r = await db.run('DELETE FROM room_bookmarks WHERE id=$1 AND account_id=$2', [id, accountId]);
  return (r.changes ?? 0) > 0;
}

// ---------- 玩家偏好（profiles.prefs JSON 合并写入）----------
export async function updatePrefs(accountId: string, partial: Record<string, any>): Promise<Record<string, any>> {
  if (!dbEnabled()) return {};
  const db = getDb();
  const rows = await db.query('SELECT prefs FROM profiles WHERE account_id=$1', [accountId]);
  let prefs: Record<string, any> = {};
  if (rows[0]) { try { prefs = JSON.parse(rows[0].prefs || '{}'); } catch { prefs = {}; } }
  prefs = { ...prefs, ...partial };
  const now = Date.now();
  if (rows[0]) await db.run('UPDATE profiles SET prefs=$1, updated_at=$2 WHERE account_id=$3', [JSON.stringify(prefs), now, accountId]);
  else await db.run('INSERT INTO profiles(account_id, prefs, updated_at) VALUES($1,$2,$3)', [accountId, JSON.stringify(prefs), now]);
  return prefs;
}

export async function getPrefs(accountId: string): Promise<Record<string, any>> {
  if (!dbEnabled()) return {};
  const db = getDb();
  const rows = await db.query('SELECT prefs FROM profiles WHERE account_id=$1', [accountId]);
  if (!rows[0]) return {};
  try { return JSON.parse(rows[0].prefs || '{}'); } catch { return {}; }
}
