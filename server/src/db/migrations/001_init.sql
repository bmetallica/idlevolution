-- Dynamischer Spielzustand. Content-Definitionen leben als JSON in DATA_DIR,
-- der Zustand referenziert sie nur über String-IDs.

CREATE TABLE game_state (
  id            int PRIMARY KEY CHECK (id = 1),
  current_epoch text NOT NULL,
  tick          bigint NOT NULL DEFAULT 0,
  population    numeric NOT NULL DEFAULT 0,
  last_tick_at  timestamptz NOT NULL DEFAULT now(),
  extra         jsonb NOT NULL DEFAULT '{}'::jsonb  -- z.B. Bau-Warteschlange
);

CREATE TABLE resource_stock (
  resource_id text PRIMARY KEY,
  amount      numeric NOT NULL DEFAULT 0
);

CREATE TABLE buildings_built (
  building_id      text PRIMARY KEY,
  count            int NOT NULL DEFAULT 0,
  workers_assigned int NOT NULL DEFAULT 0
);

-- Registry/Audit aller importierten Content-Packs (Quelle der Wahrheit bleiben die Dateien)
CREATE TABLE content_packs (
  id          text PRIMARY KEY,
  source      text NOT NULL,             -- 'human' | 'ai'
  status      text NOT NULL,             -- 'active' | 'rejected'
  file_path   text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL
);

-- Protokoll jedes nächtlichen KI-Laufs (Nachvollziehbarkeit + Feedback-Schleife)
CREATE TABLE ai_runs (
  id           serial PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL,            -- 'accepted' | 'partial' | 'rejected' | 'error'
  export       jsonb,
  raw_response jsonb,
  accepted     jsonb,
  rejected     jsonb,
  error        text
);

CREATE TABLE event_log (
  id      serial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  type    text NOT NULL,                 -- 'build' | 'epoch_advance' | 'ai_import' | ...
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
