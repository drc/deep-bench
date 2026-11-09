-- Deep Bench — D1 schema
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- one drive per player per day; UNIQUE constraint enforces it
CREATE TABLE IF NOT EXISTS games (
  player_id TEXT NOT NULL REFERENCES players(id),
  game_date TEXT NOT NULL,
  status TEXT NOT NULL,             -- active | kick | done
  yards INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,              -- JSON drive state from lib/game.js
  PRIMARY KEY (player_id, game_date)
);

-- normalised play-by-play rows (tier/yardage analysis, future leaderboards)
CREATE TABLE IF NOT EXISTS answers (
  player_id TEXT NOT NULL,
  game_date TEXT NOT NULL,
  play INTEGER NOT NULL,
  qid TEXT NOT NULL,
  answer TEXT,
  tier TEXT,
  yards INTEGER,
  source TEXT,
  PRIMARY KEY (player_id, game_date, play)
);

-- snapshot of each day's shared question set, frozen on first request
CREATE TABLE IF NOT EXISTS daily_picks (
  game_date TEXT PRIMARY KEY,
  qids TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- jev-router verdict cache (replaces KV; one resource fewer to set up)
CREATE TABLE IF NOT EXISTS verdicts (
  cache_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_date ON games (game_date);
