-- Ausrichtung (Drehung) platzierter Gebäude: 0 = Standard, 1/2/3 = 90°-Schritte.
ALTER TABLE building_instances ADD COLUMN IF NOT EXISTS rot smallint NOT NULL DEFAULT 0;
