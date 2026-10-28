-- #18 持久层初始 schema（PostgreSQL 方言）
-- 账号 / 会话 / 档案(偏好) / 战绩 / 英雄解锁收藏 / 房间码收藏 / 对局回放(完整事件流)
-- JSON 统一存为 TEXT（应用层序列化），时间戳用 INTEGER（unix ms），最大化与 SQLite 可移植。

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS profiles (
  account_id TEXT PRIMARY KEY,
  prefs TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS stats (
  account_id TEXT PRIMARY KEY,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  hero_usage TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS unlocks (
  account_id TEXT NOT NULL,
  hero_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, hero_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS room_bookmarks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  room_code TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS replays (
  id TEXT PRIMARY KEY,
  room_code TEXT,
  account_id TEXT,
  created_at INTEGER NOT NULL,
  duration_rounds INTEGER,
  players TEXT NOT NULL DEFAULT '[]',
  events TEXT NOT NULL,
  result TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
