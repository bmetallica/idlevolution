# Roadmap: KI-Mit-/Gegenspieler auf gemeinsamer Karte

> Status: **Entwurf / geplant** · Letzte Aktualisierung: 2026-07-10
> Dieses Dokument beschreibt die geplante Erweiterung von Idlevolution um
> zuschaltbare KI-Spieler mit eigenen Inseln auf einer gemeinsamen Weltkarte,
> inklusive späterer Ausbaustufen für Schiffe, Handel und Krieg.

## Vision

Der Spieler kann über die UI **1–4 KI-Spieler** zuschalten. Jeder KI-Spieler
besitzt eine **eigene Insel auf derselben Weltkarte**; man kann per Kamera zu
den Nachbarinseln fahren, sie ansehen und (ab späteren Stufen) mit ihnen
interagieren. Die KI-Spieler entwickeln ihre Inseln autonom weiter — angetrieben
vom lokalen LLM (Gemma), das einmal am Tag (nach der nächtlichen
Content-Generierung) die Strategie festlegt, während ein deterministischer
Executor die Insel Tick für Tick tatsächlich spielt.

## Kernprinzip: Stratege (LLM) + Taktiker (Executor)

Das schwierigste Problem — *„ein KI-Spieler muss die vollen Möglichkeiten eines
ganzen Tages an Ticks nutzen können, nicht nur ein Gebäude pro Tag bauen"* —
wird durch eine Zweiteilung gelöst:

- **LLM = Stratege (1×/Tag):** legt die *Absicht* fest — Baureihenfolge,
  Prioritäten, Politik-Regeln, Persönlichkeit. Keine Mikro-Steuerung, keine
  Tick-Nummern.
- **Deterministischer Executor = Taktiker (jeden Tick):** ein regelbasierter Bot,
  der die Absicht abarbeitet — baut das nächste Gebäude der Warteschlange,
  *sobald es leistbar ist*, weist Arbeiter zu, sichert die Nahrung. Nutzt exakt
  dieselbe `runTick`-Engine und dieselben Operationen (`startBuild`,
  `assignWorkers`, `setRoad`, `demolish`) wie der menschliche Spieler.

**Der Trick für „ein ganzer Tag an Ticks":** Die KI-Insel bekommt keinen
Sonder-Batch. Sie ist ein **vollwertiger Spielstand, der bei jedem Server-Tick
mitläuft** — genau wie die Insel des Menschen. Sie wächst also in Echtzeit mit.
Beispiele wie „Tick 0 Holzfäller, Tick 25 etwas mit dem Holz" ergeben sich
**von selbst** aus dem Ressourcenaufbau — es müssen keine Tick-Nummern
hardcodiert werden, nur Reihenfolge + Bedingungen (z. B. „baue Sägewerk, sobald
≥ 20 Bretter"). Der LLM justiert täglich nur die Strategie neu.

## Getroffene Entscheidungen (fixiert)

1. **Gemeinsame Karte:** alle Inseln liegen auf *einer* Weltkarte; Navigation
   durch Kamera-Schwenk über den Ozean.
2. **KI-Inseln ticken kontinuierlich mit** (nicht als nächtlicher Batch) — sie
   sollen als sichtbare Nachbarn leben. Der LLM justiert täglich die Strategie.
3. **Welt einmalig für alle Inseln erzeugen:** feste Welt mit reservierten
   Insel-Plätzen für Mensch + bis zu 4 KI. Positionen sind stabil; Zuschalten
   aktiviert einen reservierten Platz, ohne bestehende Inseln neu zu würfeln.
4. **Nachbarinseln immer sichtbar** (kein Fog of War; optional als spätere Idee).
5. **Bauen nur im eigenen Territorium.** Auf fremden Inseln kann der Spieler
   nicht bauen — außer er hat in der Kriegs-Ausbaustufe eine Insel **übernommen**
   (dann wird sie sein Territorium).

## Architektur: gemeinsame Welt, getrennte Wirtschaft

Heute existiert **ein** globaler `state` (die Insel des Menschen). Der Umbau
trennt in geteilte Welt und pro-Spieler-Wirtschaft:

| Heute | Künftig |
|---|---|
| 1 globaler `state` | `world` (geteilt) + `economies[playerId]` (getrennt) |
| 1 Insel | 1 Weltkarte mit N reservierten Insel-Regionen + Ozean |
| `instances[]` global | `instances[]` mit `owner`-Feld; Territoriums-Map (Feld → Besitzer) |
| Tick tickt `state` | Tick-Schleife tickt **jede aktive** Wirtschaft (gescoped) |
| `/api/state` | `/api/world`, `/api/economy?player=N` |
| DB: ein Spielstand | `world` + `players`-Tabelle (kind, name, islandId, economy-JSON, plan-JSON) |
| Registry (Content) | **bleibt geteilt** — alle nutzen dieselben Gebäude/Ressourcen/Epochen, auch die nächtlich generierten |

### Datenmodell (Skizze)

```
world = {
  map,                 // eine große Karte (Ozean + N Insel-Regionen)
  mapVersion,
  instances[],         // jede { id, buildingId, x, y, rot, owner, ... }
  roads,               // pro Besitzer (Set je Spieler oder mit owner-Wert)
  placed, cleared,     // Deko wie bisher
  territory,           // Feld → islandId/owner (für Bau-Beschränkung + Wachstum)
  islands[],           // { id, owner, region {x,y,w,h}, spawn, active }
}
economies[playerId] = {
  kind: 'human' | 'ai',
  name, islandId,
  epochId, population, satisfaction,
  resources{}, buildings{ id: { count, workers } }, housing,
  plan,                // nur KI: aktuelle Strategie (siehe unten)
}
```

`runTick(registry, economy, world, game)` läuft pro Spieler und rechnet nur mit
dessen Gebäuden/Ressourcen — die bestehende Engine-Logik wird lediglich „auf
einen Spieler gescoped". Bauen prüft zusätzlich `world.territory` (eigenes Feld?).

### Rendering: prozeduraler Ozean + Bake pro Insel

Die gesamte Welt in *ein* Offscreen-Canvas zu backen skaliert nicht (ein
einzelnes Canvas würde dreistellige MB). Ansatz, der zur bestehenden Struktur
passt:

- **Ozean bleibt prozedural** (ist ohnehin schon der animierte Hintergrund —
  kein Backen nötig).
- **Jede Insel** wird in ihr **eigenes, kleines** Offscreen-Canvas gebacken und
  an ihrer Weltposition geblittet; es werden nur **sichtbare** Inseln gezeichnet
  (Viewport-Culling existiert bereits).
- Minimap zeigt die **ganze Welt**; Klick springt zur Insel.

(Alternative: generisches Chunk-Tiling — mehr Aufwand, erst nötig, wenn einzelne
Inseln sehr groß werden.)

### Inselwachstum

Beim Epochenaufstieg wächst eine Insel nur in ihre **eigene reservierte Region**
(bis zu einer Grenze), nicht in den Ozean zwischen den Inseln. Die alte
„ganze Welt wächst"-Logik entfällt im Mehrspieler-Kontext.

## Der KI-Zug im Detail

### Täglicher LLM-Output (Plan)

Einmal pro Tag, nach der Content-Generierung, je KI-Spieler: Ist-Zustand
exportieren (wie Advisor/Exporter) → LLM → **Zug**:

```json
{
  "strategy": "Werkzeug für den Bronzezeit-Aufstieg sichern",
  "buildQueue": [
    { "buildingId": "lumberjack", "count": 2, "priority": 1 },
    { "buildingId": "sawmill",    "count": 1, "priority": 2 },
    { "buildingId": "toolmaker",  "count": 1, "condition": { "resource": "planks", "min": 20 } }
  ],
  "policies": {
    "foodSafetyMargin": 0.2,
    "staffing": ["food", "needs", "surplus"],
    "roadBuilding": true,
    "aggression": 0.3
  },
  "chronicle": "König Baldur baut seine Schmieden aus."
}
```

- **Validierung** wie beim Content-Import: unleistbare/ungültige Aktionen werden
  verworfen, kein Crash. Fällt der LLM aus → Executor läuft mit letztem Plan
  weiter.
- **Transparenz:** eigenes Zug-Protokoll (analog `ai-log`) + Chronicle je
  KI-Spieler.

### Executor-Politik (jeden Tick, deterministisch)

- **Nahrungs-Sicherheit zuerst:** hält die Produktion über dem Bedarf
  (nutzt die bereits vorhandene Anti-Kollaps-Logik).
- **Bau-Warteschlange abarbeiten:** höchste Priorität, deren Bedingung erfüllt
  und die leistbar + platzierbar ist → bauen (Auto-Platzierung).
- **Auto-Arbeiter:** freie Arbeiter zuweisen nach Priorität (Nahrung →
  Bedürfnisse → Überschuss), nutzt vorhandene Mangel-Logik.
- **Optional Straßen** zwischen neuen Gebäuden.

### Auto-Platzierung (neues Teilsystem, Stufe 1)

Der Teil, den beim Menschen der Klick erledigt. Für ein Gebäude ein gültiges
Feld finden:
1. Kandidatenfelder im **eigenen Territorium** nach `canPlace(footprint)` filtern
   (passendes Terrain/Adjazenz).
2. Nach Heuristik scoren: nahe an Straßen, nahe an benötigten Inputs/Produzenten,
   kompakt am bestehenden Cluster.
3. Bestes Feld wählen; nichts frei → überspringen (Insel voll / wächst später).

## Roadmap in Stufen

### Stufe 0 — Multi-Insel-Welt *(Enabler)*
- World-Gen: eine Karte mit N reservierten Insel-Regionen + Ozean-Puffer;
  Territoriums-Map.
- State-Split: `world` + `economies[player]`; `runTick` pro Spieler.
- Persistenz-Migration: heutiger Einzelstand → Welt mit Spieler 0 auf Insel 0.
- Rendering-Umbau: Ozean prozedural, Bake pro Insel + Culling.
- API/UI: `/api/world`, `/api/economy?player=N`; „KI zuschalten (1–4)" aktiviert
  reservierte Plätze; Minimap = ganze Welt mit Insel-Sprung; Bau nur im eigenen
  Territorium.
- **Risiko:** hoch (Persistenz, Tick, API, Client, Rendering). Muss Single-Player
  unverändert lassen.
- *Ergebnis:* Mehrere Inseln auf einer Karte, zwischen denen man fährt
  (KI-Inseln noch „tot").

### Stufe 1 — KI-Executor *(macht KI-Inseln lebendig)*
- Deterministischer Per-Tick-Executor aus Plan (Bau-Warteschlange + Politik).
- Auto-Platzierung, Auto-Arbeiter, Nahrungs-Sicherheit.
- Default-Politik → KI spielt vernünftig **ohne** LLM. Löst „ganzer Tag an Ticks".
- **Testbar:** Executor ist rein → Simulation über N Ticks, Asserts.

### Stufe 2 — Täglicher LLM-Stratege
- 1×/Tag je KI-Spieler: Export → LLM → Zug (Plan). Validierung + Fallback.
- Persönlichkeiten/Schwierigkeit über Politik-Knöpfe. Zug-Protokoll + Chronicle.

### Stufe 3 — Ansehen & Vergleich *(UI)*
- Zwischen Inseln fahren, KI-Inseln read-only betrachten, Stats/Chronik/
  „was hat er heute gebaut", Rangliste.

### Stufe 4 — Schiffe & Transport
- Häfen (Wasser-Adjazenz), Schiffs-Entität mit Ladung, Seeweg über den Ozean der
  **bestehenden** Karte (keine separate Weltansicht nötig), Reisezeit, Übergabe
  von Ressourcen zwischen Wirtschaften.

### Stufe 5 — Handelssystem
- Angebote/Verträge (Mensch↔KI, KI↔KI): „verkaufe X für Y", annehmen, Schiffe
  liefern. Preise nach Angebot/Nachfrage, Reputation. KI handelt im Tageszug;
  faire Angebote nimmt der Executor auch sofort per Regel an.

### Stufe 6 — Kriegssystem ✅ *(umgesetzt 2026-07-12)*
- **Militär als Content** (base-military-Pack): ⚔️ Soldaten (Ressource),
  🛡️ Kaserne (bildet aus, +25 Lager je Kaserne), 🗼 Wehrturm
  (`meta.military.defense` — datengetrieben, auch KI-Packs können eigene
  Wehranlagen erfinden).
- **Kampf** (`engine/war.js`): Angriff per Kriegsschiff (rotes Segel, Ziel
  braucht keinen Hafen); bei Ankunft Angriffskraft (Soldaten) gegen
  Verteidigung (Soldaten + Anlagen + 5 % Miliz), ±15 % Kriegsglück.
  Niederlage kostet die Truppe; der Verteidiger verliert anteilig Soldaten.
- **Eroberung**: Sieg überträgt Territorium (`state.regions` — canPlace prüft
  mehrere Regionen), Gebäude (unbemannt), Straßen/Deko und die halbe
  Bevölkerung; Überlebende garnisonieren. Der Besiegte ist raus
  (⚔️-erobert-Anzeige), sein Insel-Platz zählt nicht als frei.
- **Verteidigung der KI**: Executor baut ab 40 Einwohnern eine Kaserne und je
  80 Einwohner einen Wehrturm (sofort greifend, ohne LLM).
- **UI**: ⚔️/🛡️-Stärken in der 🌍-Rangliste, Angriffs-Formular (ab Hafen +
  Soldaten), 📜 Kriegs-Protokoll (world.warLog, Migration 008).
- **Bewusst v1**: Die KI greift NICHT von sich aus an (nur Verteidigung) —
  Vergeltung nach Persönlichkeit/`aggression` im Tageszug ist der nächste
  Ausbau, wenn sich das Grundsystem im Spiel bewährt. 5 Kriegs-Tests
  (63 gesamt), Ende-zu-Ende-Simulation gegen die echte Registry verifiziert.

## Querschnitts-Überlegungen

- **Zeit-Asymmetrie (Mensch = Echtzeit, KI = Tageszug):** gelöst durch
  kontinuierliches Mit-Ticken der KI-Inseln (Executor). Für Handel/Krieg
  zusätzlich **sofort greifende Regeln** (Executor nimmt faire Trades an /
  verteidigt sofort); der LLM „überdenkt" es im nächsten Tageszug.
- **Fairness/Schwierigkeit:** gleiche Engine, gleiches Balancing, gleicher Start.
  Schwierigkeit über Executor-Aggressivität/Politik, nicht über Cheat-Ressourcen
  (optionaler Handicap-Modus denkbar).
- **LLM-Kosten:** 4 KI × 1 Call/Tag = vernachlässigbar, nach der Content-Gen.
- **Performance:** N+1 Wirtschaften pro Tick — `runTick` ist billig; Rendering
  über Bake-pro-Insel + Culling begrenzt.
- **Testing:** Executor & `runTick`-pro-Spieler sind rein → deterministische
  Simulations-Tests (KI baut sinnvoll, hungert nicht, respektiert Territorium).

## Offene Ideen für später (nicht fixiert)

- Fog of War / Inseln erst per Schiff „entdecken".
- Diplomatie/Bündnisse zwischen KI-Spielern.
- Sichtbare Persönlichkeiten/Fraktionen mit eigenem Baustil.
- Handicap-/Schwierigkeitsstufen.

## Nächster konkreter Schritt

**Stufe 0** umsetzen (Multi-Insel-Welt-Fundament), streng darauf achtend, dass
der bestehende Single-Player-Ablauf unverändert weiterläuft (Migration:
heutiger Stand → Spieler 0, Insel 0).
