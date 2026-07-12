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
- ✅ Live verifiziert (PR #6, von der Action validiert + gemerged): echte Insel
  im Repo — 72×72, 237 Gebäude, 373 Straßen, 110 genamespacete Instanzen,
  packs.json mit 18 Gebäuden / 13 Ressourcen / 3 Epochen inkl. eingefrorener
  Farben; index.json zeigt „Insel von bmetallica" (Pop 540)
- ✅ Bugfixes dabei: Engine-Feld heißt `counted` (nicht `done`); Epochen-
  Pattern im Schema um Bindestrich erweitert (genamespacete Epochen-IDs);
  Rerun-Falle dokumentiert (pull_request_target checkt den main-Stand vom
  Event-Zeitpunkt aus — Fixes brauchen ein frisches Event, kein Rerun)
- ⬜ Cross-Account-Test des Fork-Pfads (braucht zweiten GitHub-Account —
  Owner-Pfad ist verifiziert, Fork-Pfad ist implementiert aber ungetestet)

## M2 — Nachbarn entdecken & besuchen — ERLEDIGT

- ✅ `server/src/online/sync.js`: index.json + Inseln/Packs tokenlos laden
  (raw.githubusercontent, Größen-Limits), isolierte Ablage `data/online/<user>/`
  (wird NIE in die eigene Registry gemischt), verwaiste Kopien werden entfernt
- ✅ `server/src/online/validate.js`: strikte Re-Validierung + Whitelist-
  Sanitisierung aller Downloads (unbekannte Felder verworfen, Texte gekappt,
  Farben/Seeds regex-geprüft) — Verteidigung in der Tiefe, der Action wird
  nicht blind vertraut
- ✅ Sync-Trigger: nächtlich (run-nightly nach dem Publish) + 🔄-Knopf im
  🌍-Panel; funktioniert tokenlos auch OHNE GitHub-Login
- ✅ Online-Inseln-Liste im 🌍-Panel (Name, Epoche, Bevölkerung)
- ✅ „Besuchen": read-only-Render in IsoMap (fremde Karte+Instanzen, defIndex
  aus deren packs.json mit eingefrorenen Farben, `_owner` → InfoPanel
  schreibgeschützt), Kopf-Banner mit ⬅ Zurück; eigenes HUD ausgeblendet
- ✅ Stale-Handling: defekte Inseln werden übersprungen (Warnung im Log)
- ✅ Willkommensinsel (`islands/idlevolution-demo/`) als erster Nachbar für
  jeden neuen Online-Spieler (inkl. Beispiel-Pack)
- ✅ E2E verifiziert (Playwright): Sync → Panel → Besuchen → Render → Banner
- ✅ packs.json-Schema auch Action-seitig strikt prüfen (mit M3 nachgezogen:
  Stück-Limits, ID-Regex, Größen-Limit je Definition)

## M3 — Handel — ERLEDIGT

- ✅ `online/trade.js`: deterministischer Zwei-Dateien-Handshake —
  `offers.json` (Angebote + Abschluss-**Tombstones** `closed`) und
  `accepts.json` (Konditionen eingefroren). Treuhand lokal bei Einstellen
  und Annehmen; Handels-Aktionen lösen sofort ein Auto-Publish aus
- ✅ Abwicklung beim Sync (settleTrades, rein & getestet): Anbieter bucht die
  Bezahlung des **frühesten** Accepts und schreibt den Tombstone; Annehmer
  löst Tombstones auf (winner=ich → Ware · sonst/storniert → Erstattung);
  Anbieter verschwunden → Erstattung nach 14 Tagen; Tombstones werden nach
  14 Tagen ausgedünnt. **6 Unit-Tests** (Treuhand, Doppel-Annahme, Storno,
  Timeout, keine Doppel-Buchung)
- ✅ UI: „🌐 Online-Angebote" im 🪙-Markt-Panel — fremde Angebote annehmen,
  eigene per 🌐-Button einstellen/zurückziehen, ⏳-Status für schwebende
  Handshakes; unbekannte Waren erst nach ✨-Übernahme annehmbar
- ✅ Preisberater: **deterministisch** statt LLM (⚖️/🟢/🔴 nach baseValue-
  Verhältnis) — bewusste Änderung: gleiche Aussagekraft, aber **null**
  Prompt-Injection-Fläche (fremde Texte erreichen nie ein LLM)
- ✅ Action-Validierung für offers/accepts/packs (Stück-Limits, ID-Regex,
  owner-Bindung) — schließt auch den offenen M2-Punkt
- ✅ Live-Test am echten Repo: Angebot (50 Holz → 20 Stein) → Auto-Publish →
  Accept der Willkommensinsel → Sync → +20 Stein + Tombstone publiziert

## M4 — Content-Austausch — ERLEDIGT

- ✅ „✨ Übernehmen" in der Besuchen-Ansicht: `online/adopt.js` macht aus der
  gesäuberten lokalen Kopie ein normales Content-Pack unter
  `data/content/generated/online-<owner>.json` → lädt wie ein KI-Pack und ist
  in der 🤖-Zentrale **deaktivierbar** (Instanzen werden sauber entfernt)
- ✅ Fremde Epochen werden NICHT übernommen — Gebäude/Ressourcen werden auf die
  eigene Epoche mit gleicher/nächstkleinerer Ordnung gemappt
- ✅ Erneute Validierung: Whitelist-Sanitisierung (validate.js) + das normale
  Pack-Schema des Spiels beim Laden (ajv)
- ✅ Spiel-Schemas gelockert: IDs dürfen `-` enthalten und bis 80 Zeichen lang
  sein (nötig für genamespacete `gh-<user>--`-IDs; für die eigene KI harmlos)
- ✅ E2E verifiziert (Playwright): Besuchen → ✨ Übernehmen → Muschelsammler
  der Willkommensinsel in der eigenen Registry, eingefrorene Farben intakt;
  52 Server-Tests grün

## M5 — Betrieb & Politur — ERLEDIGT

- ✅ Pruning: Inseln > 90 Tage ohne Update fallen aus dem Index (Dateien
  bleiben; der nächste Upload bringt sie zurück)
- ✅ `blocklist.json` (Moderation durch Repo-Inhaber) — wirkt im Index-Builder
  UND client-seitig beim Sync (Verteidigung in der Tiefe)
- ✅ Quoten Action-seitig: 512 KB/Datei, 2 MB/Ordner, Stück-Limits je Dateityp
- ✅ „🚪 Offline gehen": eigene Dateien per Lösch-PR entfernt, nächtliche
  Veröffentlichung gestoppt (publishEnabled); erneute Freigabe über den
  Disclaimer-Dialog. Lösch-PRs werden von der Action akzeptiert
- ✅ „Was wird veröffentlicht?"-Vorschau im Disclaimer-Dialog (Karte, Gebäude,
  Straßen, KI-Baupläne, GitHub-Name)
- ✅ Doku: README des Spiels (Online-Kapitel) + README des Online-Repos
  (Regeln, Handel, Moderation, Pruning)

---

*Stand: 2026-07-12 — **ALLE Meilensteine (M0–M5) umgesetzt und live
verifiziert.** Einziger offener Punkt: der Cross-Account-Test des Fork-Pfads
(braucht einen zweiten GitHub-Account; der Owner-Pfad ist vollständig
verifiziert, der Fork-Pfad implementiert). Der komplette Handels-Loop wurde
live am echten Repo durchgespielt: Angebot → Auto-Publish → Accept →
Sync-Abwicklung (+20 Stein) → Tombstone. Ebenso „Offline gehen" (Lösch-PR,
Index-Entfernung) und erneute Freigabe.*
