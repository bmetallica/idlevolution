# Multiplayer-Roadmap — Fortschritt

Detaillierte Arbeits-Checkliste für den asynchronen GitHub-Multiplayer.
Konzept, Architektur-Begründungen und Sicherheitsmodell: siehe
[`roadmap-multiplayer.md`](roadmap-multiplayer.md). Online-Speicher:
[bmetallica/idlevolution-online](https://github.com/bmetallica/idlevolution-online).

**Legende:** ✅ erledigt & verifiziert · 🔄 in Arbeit · ⬜ offen

---

## Vorarbeiten (Konzept & zentrales Repo)

- ✅ Konzept aus `mp/` überarbeitet (4 Korrekturen: Fork+PR statt Direkt-Commit,
  Device Flow statt Callback-OAuth, Token in Postgres statt localStorage,
  Festpreis-Handshake statt asymmetrischer LLM-Preise)
- ✅ Zentrales Repo angelegt und Grundgerüst gepusht
  (README mit Regeln + Haftungsausschluss, `schema/island.schema.json`,
  `scripts/validate.mjs` (dependency-frei), `scripts/build-index.mjs`)
- ✅ GitHub Action `validate-island.yml`: Pfad-Schutz (PR-Autor = Ordner, auch
  gelöschte/umbenannte Dateien), Dateinamen-Whitelist, 512 KB/Datei,
  2 MB/Ordner, JSON-Parse, island.json-Strukturprüfung inkl. owner-Spoofing-
  Abwehr, Auto-Merge, Index-Aufbau im selben Lauf
- ✅ GITHUB_TOKEN-Falle behoben (Action-Pushes triggern keine Folge-Workflows
  → Index wird im Validierungs-Lauf gebaut; `build-index.yml` nur Fallback:
  Cron täglich + manuell + direkte Owner-Pushes)
- ✅ Live-Tests: PR #1 (Schritte manuell nachgefahren), PR #2/#3 (Action
  validiert + merged selbstständig, 14–21 s), Negativtests (fremder Ordner,
  owner-Spoofing, unbekannte Felder ⇒ abgelehnt), tokenloses Lesen über
  raw.githubusercontent.com (Achtung: ~5 Min CDN-Cache)
- ✅ OAuth App registriert („Enable Device Flow", Client-ID
  `Ov23lih2yPEXcAEKwEc3` — öffentlich, kein Secret)

## M0 — Fundament (Login, Einstellungen, Disclaimer) — ERLEDIGT

- ✅ Migration 007: Tabelle `online_settings` (eine Zeile, jsonb; Token bleibt
  ausschließlich serverseitig)
- ✅ `server/src/online/auth.js`: Device Flow (startDeviceFlow, pollToken mit
  authorization_pending/slow_down, fetchGithubUser), loadOnline/saveOnline
- ✅ `server/src/routes/online.js`: `/api/online/connect|status|disclaimer|disconnect`,
  serverseitiger Poll-Loop bis Token/Expiry
- ✅ `config.js`: `online.clientId` (ONLINE_CLIENT_ID) + `online.repo` (ONLINE_REPO)
- ✅ `OnlineSection.svelte` im 🌍-Nachbarn-Panel: Verbinden (User-Code +
  github.com/login/device), Status mit Avatar, Trennen
- ✅ **Disclaimer-Dialog** „auf eigene Gefahr / keine Haftung / Daten öffentlich /
  Widerruf" — Pflicht vor der ersten Freigabe, versioniert (Textänderung
  erzwingt erneute Zustimmung), Zustimmung mit Zeitstempel in der DB
- ✅ Live verifiziert: Login als `bmetallica` durchgeführt, Disclaimer akzeptiert

## M1 — Insel veröffentlichen — ERLEDIGT

- ✅ `server/src/online/exporter.js`:
  - ✅ Region-Ausschnitt der Weltkarte (relative Koordinaten, nur eigene Insel)
  - ✅ nur fertige Gebäude (`counted`), Straßen relativ
  - ✅ ID-Namespacing `gh-<user>--` für KI-Pack-Content (Basis-IDs bleiben —
    die teilen alle Spiele); rekursives Rewriting inkl. Objekt-Schlüssel
    (cost/inputs/outputs sind nach Ressourcen-IDs geschlüsselt)
  - ✅ Sprite-Farben eingefroren (wall/roof/accent/seed mit der ORIGINAL-ID
    berechnet und in `meta.art` geschrieben; `paletteFor()` im Client
    respektiert die Overrides inkl. `seed`)
  - ✅ packs.json: alle aktiven KI-Packs (Gebäude, Ressourcen, Epochen)
- ✅ `server/src/online/github.js`: Fork sicherstellen (idempotent, Poll bis
  verfügbar, merge-upstream-Sync) → Branch force auf main → Dateien per
  Contents-API → PR öffnen/wiederverwenden; Repo-Inhaber pusht direkt
  (eigenes Repo ist nicht forkbar)
- ✅ `POST /api/online/publish`: Guards (verbunden + Disclaimer), 512-KB-Check,
  lastPublish in Status; UI-Button „Insel jetzt veröffentlichen" mit
  Ergebnis/Zeitpunkt/PR-Link
- ✅ Nächtlicher Upload: Hook in `run-nightly.js` nach der Content-Generierung
  (überspringt sauber, wenn nicht verbunden/freigegeben)
- ✅ Live verifiziert: echte Insel (237 Gebäude, 72×72) als PR hochgeladen;
  Bugfix dabei: Engine-Feld heißt `counted`, nicht `done`
- ⬜ Cross-Account-Test des Fork-Pfads (braucht zweiten GitHub-Account —
  Owner-Pfad ist verifiziert, Fork-Pfad ist implementiert aber ungetestet)

## M2 — Nachbarn entdecken & besuchen — OFFEN

- ⬜ `server/src/online/sync.js`: index.json + gewählte Inseln/Packs tokenlos
  laden (raw.githubusercontent), ajv-Validierung gegen dasselbe Schema
  (Verteidigung in der Tiefe), isolierte Ablage `data/online/<user>/`
- ⬜ Sync-Trigger: täglich (ai-worker) + manueller „Aktualisieren"-Knopf
- ⬜ 🌐-Bereich: Liste der Online-Inseln (Name, Epoche, Bevölkerung, zuletzt
  aktiv), eigener Eintrag markiert
- ⬜ „Besuchen": read-only-Render in IsoMap (Karte+Instanzen des Nachbarn,
  eigener defIndex aus dessen packs.json, `_owner` gesetzt → InfoPanel ist
  bereits schreibgeschützt), Zurück-Knopf
- ⬜ Sicherheits-Härtung: packs.json-Schema auch Action-seitig strikt prüfen
  (bisher nur JSON+Größe), Längen-/Regex-Grenzen beim Import
- ⬜ Stale-Handling: Inseln mit defekten/fehlenden Dateien überspringen

## M3 — Handel — OFFEN

- ⬜ `offers.json` (eigene Angebote, Treuhand lokal) + `accepts.json`
  (Handshake) im eigenen Ordner; Schema + Action-Validierung
- ⬜ Abwicklung beim Sync: Anbieter sieht Accept → bucht Gegenseite, entfernt
  Angebot; Doppel-Annahme: früherer Timestamp gewinnt, Rest wird erstattet
- ⬜ UI: „🌐 Online-Angebote" im 🪙-Markt-Panel (neben lokalen KI-Angeboten)
- ⬜ LLM-Preisberater: bewertet fremde Ressourcen (nur Zahlen/Kategorien,
  `<untrusted_data>`-Kapselung, Chroniken nie im Prompt)

## M4 — Content-Austausch — OFFEN

- ⬜ „Inhalte übernehmen": fremdes Pack explizit in die eigene Registry
  importieren (bleibt genamespaced, erneute Validierung, Balance-Grenzen
  wie beim nächtlichen KI-Import)
- ⬜ Deaktivierbar wie KI-Packs heute (Instanzen werden sauber entfernt)
- ⬜ UI in der Besuchen-Ansicht / 🤖-Zentrale

## M5 — Betrieb & Politur — OFFEN

- ⬜ Pruning: Inseln > 90 Tage ohne Update aus dem Index
- ⬜ `blocklist.json` (Moderation durch Repo-Inhaber; Clients ignorieren
  geblockte Ordner)
- ⬜ Quoten je Ordner Action-seitig verschärfen
- ⬜ „Offline gehen": eigene Daten per PR aus dem Repo entfernen
- ⬜ „Was wird veröffentlicht?"-Vorschau vor dem ersten Upload
- ⬜ Doku in beiden READMEs

---

*Stand: 2026-07-12. Dieses Dokument wird mit jedem Meilenstein fortgeschrieben.*
