-- Online-Modus (Multiplayer via GitHub, siehe docs/roadmap-multiplayer.md):
-- eine Zeile mit allen Einstellungen (Token, Username, Disclaimer-Zustimmung).
CREATE TABLE IF NOT EXISTS online_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
