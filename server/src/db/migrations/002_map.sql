-- Weltkarte (einmalig generiert, Terrain als Zeichenkette) und
-- platzierte Gebäude-Instanzen mit Koordinaten.

CREATE TABLE world_map (
  id     int PRIMARY KEY CHECK (id = 1),
  seed   bigint NOT NULL,
  width  int NOT NULL,
  height int NOT NULL,
  tiles  text NOT NULL
);

CREATE TABLE building_instances (
  id           bigint PRIMARY KEY,
  building_id  text NOT NULL,
  x            int NOT NULL,
  y            int NOT NULL,
  done_at_tick bigint NOT NULL
);
