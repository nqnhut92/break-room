-- Daily per-room leaderboard, its durable event ledger, guest->character transfers,
-- 24-hour room chat and a small operations status table.
-- room_id is deliberately not restricted to br-1/br-2 so test rooms work.

CREATE TABLE daily_scores (
  room_id text NOT NULL CHECK (length(room_id) BETWEEN 1 AND 24),
  day date NOT NULL,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 3 AND 80),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 40),
  score_tenths bigint NOT NULL DEFAULT 0,
  breaks integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, day, actor_id)
);
CREATE INDEX daily_scores_rank ON daily_scores (room_id, day, score_tenths DESC);
CREATE INDEX daily_scores_day ON daily_scores (day);

-- One row per applied queue event. The primary key is the dedupe: a retry after a
-- committed-but-unacknowledged batch finds its events here and applies nothing.
CREATE TABLE score_events (
  room_id text NOT NULL,
  event_id text NOT NULL,   -- '<queue run id>:<sequence>', unique within a room's queue incarnation
  day date NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, event_id)
);
CREATE INDEX score_events_day ON score_events (day);

CREATE TABLE score_transfers (
  room_id text NOT NULL,
  day date NOT NULL,
  guest_actor_id text NOT NULL,
  character_actor_id text NOT NULL,
  transferred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, day, guest_actor_id)
);
CREATE INDEX score_transfers_day ON score_transfers (day);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY,
  room_id text NOT NULL CHECK (length(room_id) BETWEEN 1 AND 24),
  -- Internal sender reference for idempotency only (never sent to clients, never a secret).
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 3 AND 80),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 8 AND 64),
  character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
  sender_name text NOT NULL CHECK (length(sender_name) BETWEEN 1 AND 40),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 400),
  -- Server clock, milliseconds since the epoch: the history cursor is (at_ms, id).
  at_ms bigint NOT NULL,
  UNIQUE (room_id, actor_id, client_id)
);
CREATE INDEX chat_messages_room_time ON chat_messages (room_id, at_ms DESC, id DESC);
CREATE INDEX chat_messages_at ON chat_messages (at_ms);

CREATE TABLE ops_status (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
