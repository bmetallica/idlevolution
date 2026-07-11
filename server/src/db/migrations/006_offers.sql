-- Handels-Angebote (Stufe 5 der KI-Spieler-Roadmap): Teil der geteilten Welt. Additiv.
ALTER TABLE world ADD COLUMN IF NOT EXISTS offers jsonb NOT NULL DEFAULT '[]'::jsonb;
