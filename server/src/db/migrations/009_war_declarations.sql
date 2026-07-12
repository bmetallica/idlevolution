-- Kriegssystem v2: Kämpfe laufen im Tages-/KI-Rhythmus. Erklärungen werden
-- tagsüber gesammelt (öffentlich sichtbar) und nachts aufgelöst.
ALTER TABLE world ADD COLUMN IF NOT EXISTS wardecls jsonb NOT NULL DEFAULT '[]'::jsonb;
