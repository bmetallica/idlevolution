-- Mehr-Insel-Welt (Stufe 0 der KI-Spieler-Roadmap, docs/roadmap-ki-spieler.md).
-- Geteilte Weltkarte + Spieler-Wirtschaften als JSONB. Additiv: die Alt-Tabellen
-- (game_state, resource_stock, buildings_built, building_instances, world_map)
-- bleiben für die einmalige Boot-Migration bestehender Stände erhalten.

CREATE TABLE IF NOT EXISTS world (
  id      int PRIMARY KEY CHECK (id = 1),
  seed    bigint NOT NULL,
  width   int NOT NULL,
  height  int NOT NULL,
  tiles   text NOT NULL,
  islands jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{id,x,y,w,h,spawn}]
  version int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id         int PRIMARY KEY,           -- 0 = Mensch, 1..4 = KI
  kind       text NOT NULL,             -- 'human' | 'ai'
  name       text NOT NULL,
  island_id  int NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  economy    jsonb NOT NULL,            -- Ressourcen, Gebäude, Instanzen, Bevölkerung, Epoche, roads, ...
  plan       jsonb,                     -- KI-Strategie (Stufe 2)
  updated_at timestamptz NOT NULL DEFAULT now()
);
