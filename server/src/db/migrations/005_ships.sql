-- Schiffe (Stufe 4 der KI-Spieler-Roadmap): auf dem geteilten Ozean unterwegs,
-- daher als Teil der Welt gespeichert. Additiv.
ALTER TABLE world ADD COLUMN IF NOT EXISTS ships jsonb NOT NULL DEFAULT '[]'::jsonb;
