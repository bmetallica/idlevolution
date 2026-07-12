-- Stufe 6 (Kriegssystem): Kriegs-Protokoll lebt in der Welt (geteilte Sicht).
ALTER TABLE world ADD COLUMN IF NOT EXISTS warlog jsonb NOT NULL DEFAULT '[]'::jsonb;
