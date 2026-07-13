# Optimierungen, Verbesserungen & Änderungen

Vollständige Projekt-Durchsicht vom 2026-07-13. Sortiert nach Wirkung; jede
Position mit Aufwand (S/M/L) und Fundstelle. Grundlage sind Code-Lektüre aller
Module **und echte Betriebsdaten** (ai_runs: 7 akzeptiert, 10 abgelehnt,
2 Fehler — **>50 % Ausschuss** ist der größte Hebel).

**Legende:** 🔴 wichtig · 🟡 lohnend · 🟢 nice-to-have — Aufwand S(<1h) M(~½Tag) L(>1Tag)

---

## 1. Lokales LLM — Nächtlicher Content-Generator *(größter Hebel)*

Die Ablehnungsanalyse zeigt drei konkrete Fehlerklassen:
`Epoche 'medieval_age' existiert bereits` (5×!), `braucht 'wool', das niemand
produziert`, `JSON-Parse-Fehler an Position 2768`. Daraus folgt:

- 🔴 **S — Reparatur-Runde statt Wegwerfen:** Scheitert Parse/Struktur/Referenzen,
  wird heute die ganze Nacht verworfen. Stattdessen EINEN zweiten LLM-Call machen:
  „Dein Pack wurde abgelehnt, Gründe: […]. Korrigiere NUR diese Punkte, gib das
  vollständige Pack erneut aus." Ein 12B-Modell repariert konkrete Fehler
  zuverlässig — das allein dürfte die Akzeptanzrate von ~50 % auf >80 % heben.
  (`run-nightly.js`: bei status rejected/Parse-Fehler → `generatePack` mit
  Fehler-Feedback erneut; max. 1 Retry.)
- 🔴 **S — Verbots-/Bestandsliste an den ANFANG des User-Prompts:** Die kritische
  Information „diese Epochen/IDs existieren bereits" steckt heute als letzter
  Eintrag in `gaps[]` — tief im JSON vergraben. Kleine Modelle gewichten
  Prompt-Anfang und -Ende stärker. Kompakte Kopfzeile in `buildMessages()`:
  `VERBOTEN (existiert bereits): epochs=[…], resources=[…], buildings=[…]`.
  (`exporter.js`/`generator.js`)
- 🔴 **M — Export-Format straffen (Token-Diät):** `JSON.stringify(exportData, null, 1)`
  verschwendet ~30 % Tokens für Einrückung; jede Ressource trägt volle
  `producers`/`consumers`-Arrays; Beschreibungen wachsen mit jedem Pack. Bei
  32k Kontext ist das heute ok, skaliert aber schlecht (Content wächst jede
  Nacht!). Kompakt serialisieren (eine Zeile je Item, Zahlen gerundet, keine
  Beschreibungen), alte Epochen nur als Zusammenfassung („bronze_age: 8 Gebäude,
  5 Ressourcen, abgeschlossen"). Ziel: Export < 4k Tokens, stabil über Monate.
- 🟡 **S — ID-Muster in die Grammatik:** `llmPackSchema()` erzwingt Struktur, aber
  keine ID-Form. `pattern: "^[a-z][a-z0-9_]{1,40}$"` bei allen `id`-Feldern
  eliminiert eine Fehlerklasse an der Quelle (llama.cpp-Grammatik kann einfache
  Patterns). Fallback bleibt der Validator.
- 🟡 **S — Clamp-Notizen in die Feedback-Schleife:** `recentRejections` enthält
  nur Ablehnungen. Die `notes` (gekappte Werte, z.B. „baseValue 5000 → 1000")
  sagen dem Modell, WO seine Zahlenintuition daneben liegt — mitgeben.
  (`exporter.js`: auch `accepted.notes` der letzten Läufe exportieren.)
- 🟡 **S — Militär-Wissen in den Prompt:** Der Generator kennt `meta.military.defense`
  nicht — das LLM kann keine epochengerechten Wehranlagen erfinden (Palisade →
  Steinmauer → Festung wäre thematisch perfekt). Eine Zeile im System-Prompt +
  Feld im Grammatik-Schema + Balance-Grenze (defense ≤ 15 × epochenOrder+1).
- 🟡 **M — Zwei-Phasen-Generierung (Kreativ → Strikt):** Heute ein Call mit
  temperature 0.7 für Idee UND JSON. Besser: Phase 1 „Was fehlt dem Spiel?
  3 Ideen skizzieren" (temp 0.8, Freitext, billig), Phase 2 „Setze Idee X als
  Pack um" (temp 0.2, Grammatik). Kleinere Modelle liefern deutlich
  konsistentere Zahlen bei niedriger Temperatur; Kreativität bleibt erhalten.
- 🟢 **S — `extractJSON` robuster:** Häufige Kleinfehler (trailing comma,
  `\n` in Strings) vor dem Parse reparieren (Regex-Pass), statt den Lauf zu
  verlieren. Ergänzt die Reparatur-Runde.
- 🟢 **S — Fehlgeschlagene Läufe differenzieren:** `finish_reason==='length'`
  wird erkannt, aber nicht automatisch mit halbiertem Export erneut versucht.

## 2. Lokales LLM — Strategist, Advisor, Prompt-Sicherheit

- 🔴 **S — Prompt-Injection-Pfad über Online-Inhalte schließen:** Übernommene
  Nachbar-Packs (M4) landen in der Registry — deren `name.de`/`description.de`
  fließen ungekapselt in **Generator-Export, Strategist-Snapshot und
  Advisor-Snapshot**. Die 60/240-Zeichen-Kappung (validate.js) begrenzt das
  Risiko, aber ein Nachbar könnte Anweisungen in Gebäudenamen verstecken.
  Fix: Beim `adopt` Beschreibungen fremder Packs NICHT übernehmen (nur Namen)
  und in allen drei Snapshots Texte aus Packs mit `origin: github:*` durch die
  ID ersetzen — die LLM-Rollen brauchen fremde Prosa nicht. (`adopt.js`,
  `exporter.js`, `strategist.js`, `advisor.js`)
- 🟡 **S — Strategist kennt Krieg & Handel nicht:** Der Snapshot enthält weder
  eigene Armee/Verteidigung noch Bedrohungen (offene Kriegserklärungen gegen
  die Insel) noch Marktlage. Minimal ergänzen: `militaer: {armee, verteidigung,
  bedrohungen:[…]}` — dann kann der Plan Kasernen/Türme priorisieren, wenn der
  Mensch aufrüstet. `politik.aggression` wird erhoben, aber nie genutzt →
  entweder dokumentiert „reserviert" oder (Option, User-Entscheid!) vorsichtig
  aktivieren: aggression > 0.7 UND Armee > 2× Verteidigung des schwächsten
  Nachbarn → Raubzug-Erklärung im Tageszug.
- 🟡 **S — Plan-Fehlschläge sichtbar machen:** `/api/players/plan` schluckt
  Fehler (`.catch(() => {})`) — wenn Gemma eine Nacht lang Müll liefert, plant
  die KI still mit dem alten Plan weiter. Fehler je Spieler in `ai_runs` oder
  Log schreiben; 🌍-Panel könnte „Plan von gestern" markieren. (`game.js:377`)
- 🟡 **S — Advisor kennt die neuen Systeme nicht:** Snapshot ohne Soldaten/
  Verteidigung, Schiffe, Marktangebote, Online-Status — Fragen wie „warum
  verliere ich Soldaten?" kann er nicht beantworten. Kompakte Felder ergänzen;
  System-Prompt um 2 Regeln (Raubzug-Mechanik, Miliz) erweitern.
- 🟢 **S — Advisor-Timeout & Kosten:** `chatCompletion` erlaubt 600 s und
  `LLM_MAX_TOKENS=12288` auch für den Berater — für 4-Sätze-Antworten reichen
  1024 Tokens/60 s. Separate, kleinere Limits für advisor/strategist sparen
  GPU-Zeit, wenn llama-swap parallel die Nacht-Generierung fährt.
- 🟢 **M — LLM-Aufrufe entzerren:** Nightly macht sequenziell Content-Gen +
  4 Strategen-Calls + (früher) mehr — bei einem Single-GPU-llama-Server richtig.
  Aber `/api/assist` (Berater) kann parallel dazu eintreffen und blockiert
  minutenlang. Kleine Warteschlange/Mutex um `chatCompletion` mit Priorität
  (Berater vor Batch) würde die UX nachts retten.

## 3. Balance & Spielmechanik

- 🔴 **S — KI darf ihre Armee nicht verkaufen:** `aiPostOffer`/`aiConsiderTrade`
  schließen nur `food` aus — `soldiers` (category `special`) kann als
  Überschuss angeboten oder als Bezahlung akzeptiert werden. Ebenso listet das
  Verschiffen-/Markt-Formular des Menschen Soldaten als Ware. Kategorie
  `special` überall vom Handel ausnehmen (Online-Handel `lootable()` macht es
  bereits vor). (`trade.js`, `App.svelte` Ressourcen-Selects)
- 🟡 **S — Wehrturm arbeitslos machen:** Der Turm kostet 1 Arbeiter, tut aber
  nichts Produktives — die KI-`staffable`-Logik und Spieler zahlen dauerhaft
  Workforce für einen passiven Bonus. `workers: 0` wäre konsistenter
  (Verteidigungswert ist die Miete). (`06-military.json`)
- 🟡 **S — Raubzug-Mindestrisiko:** `LOOT_MAX_SHARE 0.25` + Tragkraft sind gut,
  aber ein Angriff mit 1 Soldat gegen eine leere Insel kostet fast nichts —
  Spam-Erklärungen (je 1 Soldat) fluten das Protokoll. Mindesttruppe (z.B. 5)
  oder Abklingzeit je Ziel (1 Erklärung/Nacht existiert schon — reicht evtl.).
- 🟡 **M — Offline-Fairness beim Raubzug:** Wird der Server tagelang nicht
  gestartet, feuert `/api/war/resolve` nie (ai-worker down) und Erklärungen
  bleiben offen; die Treuhand-Soldaten des Menschen sind gebunden. Fallback:
  beim Boot Erklärungen älter als 36 h automatisch auflösen oder erstatten.
  (`index.js` Boot-Sequenz)
- 🟢 **S — Miliz skaliert hart linear:** 5 % der Bevölkerung macht große
  Inseln fast unplünderbar (540 Ew. = 27 Basis-Verteidigung vs. Kasernen-Cap
  25/Gebäude). Gewollt? Sonst Miliz deckeln (z.B. max 20) oder logarithmisch.
- 🟢 **S — `soldiers` als nicht lagerbar für baseStorage markieren:** Soldaten
  zählen gegen die allgemeine Lagerkapazität (baseStorage 200) mit — thematisch
  schief; `storable:false` + nur Kasernen-storage als Obergrenze prüfen.

## 4. Engine & Performance

- 🟡 **S — Welt nur bei Änderung speichern:** `saveWorld` schreibt alle 12 Ticks
  (~1×/min) die kompletten 83 KB `tiles` + islands + ships + offers + logs in
  Postgres, auch wenn sich nichts geändert hat. Dirty-Flag (Version/Ships/Offers/
  Decls verglichen) spart >90 % dieser Writes. (`index.js`, `players.js`)
- 🟡 **S — Persistenz-Reihenfolge crashfest:** Im Tick-Loop wird `savePlayer`
  je Spieler awaited; stirbt der Prozess mittendrin, sind Spieler und Welt
  inkonsistent (z.B. Schiff ausgeliefert, Fracht aber doppelt/gar nicht).
  Eine Transaktion um „alle Spieler + Welt" je Persist-Zyklus. (`index.js`)
- 🟢 **S — Offline-Aufholung deckeln pro Boot:** `offlineCapHours 24` ×
  5 Spieler × 17280 Ticks läuft beim Start sequenziell — nach langem Stillstand
  blockiert der Boot spürbar. In Blöcken ticken + Fortschritt loggen, oder
  Cap pro Boot (z.B. 6 h) mit Rest im Hintergrund.
- 🟢 **S — `/api/players` schlankt ab:** liefert bei jedem Poll ALLE Instanzen
  aller Inseln (Positions-Rohdaten). Ein `since`/ETag oder die Trennung
  „Instanzen nur bei mapVersion-Wechsel" spart Bandbreite auf Mobile.
- 🟢 **S — NPC-`spotsByRole` cachen:** wird pro Sim-Step (20 fps) über alle
  ~600 Instanzen gerechnet; memoisieren auf Instanz-Signatur. Messbar erst
  bei vielen Inseln, aber billig zu haben. (`npc.js`)

## 5. Online-Multiplayer (Rest-Punkte)

- 🔴 **S — GitHub-Token verschlüsseln oder Rechte minimieren:** Der Token liegt
  im Klartext in `online_settings` (Roadmap sah „at-rest verschlüsselt" vor).
  Minimalfix: mit AI_IMPORT_TOKEN als Schlüssel (AES-GCM) verschlüsseln —
  schützt Backups/DB-Dumps. (`online/auth.js`)
- 🟡 **S — Accept-/Offer-Aufräumen:** `closed`-Tombstones verfallen nach 14
  Tagen, aber eigene `offers` leben ewig, wenn niemand annimmt — TTL (z.B. 30
  Tage, dann Auto-Storno + Erstattung) verhindert Karteileichen im Repo.
- 🟡 **M — Cross-Account-Test:** Fork-PR-Pfad (`publishFiles` als Nicht-Owner)
  ist implementiert, aber ungetestet — braucht einen zweiten GitHub-Account.
  Sobald verfügbar: kompletter Loop (publish → Action → sync → trade).
- 🟢 **S — `island.json` um Chronik ergänzen:** Schema erlaubt `chronicle`,
  der Exporter füllt es nie — die letzte KI-Chronik wäre eine schöne Visitenkarte
  der Insel im Online-Index. (`online/exporter.js`)
- 🟢 **S — Sync-Intervall im Spiel anzeigen:** „zuletzt synchronisiert vor X"
  im 🌍-Panel, damit klar ist, wie frisch die Online-Daten sind.

## 6. Client & UX

- 🟡 **S — Polling konsolidieren:** `pollState` + `loadPlayers` + `loadMarket`
  laufen als getrennte Fetches; ein gebündelter `/api/frame`-Endpoint (state +
  players-Delta) halbiert Requests — auf Mobile (PWA, Akku) relevant.
- 🟡 **S — EpochBanner auf Mobile:** ist komplett ausgeblendet — Epochen-
  Fortschritt/Aufstieg ist auf dem Handy unsichtbar. Kompakte Variante ins
  ☰-Menü oder als Badge an der Materialleiste.
- 🟢 **S — PWA-PNG-Icons:** Nur SVG-Icon; ältere Android-Launcher rendern es
  nicht. Einmalig 192/512-PNGs generieren (braucht sharp/rsvg lokal).
- 🟢 **S — Kriegs-UI-Feinheiten:** Kriegserklärungen zeigen kein „wann ist
  Nacht?" (AI_CRON) — Countdown „Schlacht in ~X h" nimmt Ratlosigkeit.
- 🟢 **S — Bau-Abbruch auf Desktop vereinheitlichen:** ESC bricht Bau ab,
  aber nicht Straßen-/Deko-Modus in allen Pfaden gleich; kurze Prüfung.
- 🟢 **M — Onboarding:** Erstspieler sehen 40+ Buttons ohne Erklärung. Ein
  5-Schritte-Tutorial-Overlay (Hütte bauen → Arbeiter → Straße → Epoche)
  aus dem bestehenden Content generierbar.

## 7. Code-Hygiene, Doku, CI

- 🟡 **S — `.env.example` vervollständigen:** `ONLINE_CLIENT_ID`/`ONLINE_REPO`
  fehlen (README erwähnt sie). Wer das Repo zieht, findet die Variablen nicht.
- 🟡 **S — CI einrichten:** Kein GitHub-Workflow im Hauptrepo — `npm test`
  (64 Tests, ~1 s) + `npm run build` auf Push kostet nichts und fängt
  Regressionen vor dem Deploy.
- 🟢 **S — Doku-Dopplung auflösen:** `docs/roadmap-multiplayer.md` (Konzept) und
  `docs/multiplayer_roadmap.md` (Checkliste) sind leicht zu verwechseln —
  umbenennen (`multiplayer-konzept.md` / `multiplayer-status.md`) oder mergen.
  README-Testzahl („52 Unit-Tests") auf 64 aktualisieren; `mp/`-Ordner ist
  durch die Roadmap ersetzt → löschen oder als `docs/archive/` markieren.
- 🟢 **M — Testlücken schließen:** Ungetestet sind `online/github.js` (Fork/PR,
  mockbar via fetch-Stub), `ai/executor.js` (nur indirekt), `online/sync.js`
  (fetch-Mock) und die Reparatur-Pfade in `importer.js` (`dropCollisions`,
  `ensureEpochNeeds`). Gerade der Executor hätte Regressionsschutz verdient —
  er steuert 4 Wirtschaften.
- 🟢 **S — `data/online/` in Backup aufnehmen:** `backup.sh` sichert content +
  DB; die Online-Kopien sind reproduzierbar (Sync), aber `online_settings`
  (Token, Disclaimer-Zeitstempel) hängt an der DB — prüfen, dass die
  DB-Sicherung sie erfasst (sollte via pg_dump passieren — verifizieren).

## 8. Bewusst NICHT vorgeschlagen

- **WebGL-Renderer:** Canvas-2D mit Per-Insel-Bakes reicht nachweislich
  (30 fps-Deckel, Culling); ein Wechsel wäre Risiko ohne Not.
- **Anti-Cheat im Online-Modus:** ohne Server sinnlos (dokumentiert).
- **Echtzeit-Multiplayer:** widerspricht dem Idle-/Daily-Sync-Konzept.
- **LLM-Preisberater im Online-Handel:** bewusst deterministisch
  (Injection-Fläche null) — so lassen.

---

## Roadmap

**Phase 1 — LLM-Ausschuss halbieren** *(Kapitel 1)*
- [x] Verbotsliste (existierende IDs) kompakt an den Anfang des User-Prompts
- [x] Reparatur-Runde: abgelehntes Pack + Fehlerliste einmal ans LLM zurück
- [x] `extractJSON` robuster (trailing commas, Steuerzeichen)
- [x] ID-Pattern in die LLM-Grammatik (Format-Kaskade fängt Inkompatibilität)
- [x] Export-Token-Diät (kompaktes JSON) + Clamp-Notizen in die Feedback-Schleife
- [x] Militär-Wissen in Prompt/Schema + Balance-Grenze für `defense`

**Phase 2 — Sicherheit & Balance** *(Kapitel 2+3+5)*
- [x] Soldaten (`special`) vom Handel ausschließen (KI, Markt, Verschiffen, Online)
- [x] Injection-Pfad schließen: Online-Pack-Texte erreichen keine LLM-Prompts
- [x] GitHub-Token at-rest verschlüsseln (AES-GCM, Schlüssel aus AI_IMPORT_TOKEN)
- [x] Wehrturm ohne Arbeiter; Raubzug-Mindesttruppe
- [x] Kriegs-Fallback beim Boot (Erklärungen > 36 h auflösen)

**Phase 3 — Repo-Außenwirkung** *(Kapitel 7)*
- [x] `.env.example` vervollständigen (ONLINE_*)
- [x] CI-Workflow (Tests + Web-Build auf Push)
- [x] README-Zahlen/Verweise aktualisieren

**Phase 4 — Engine-Robustheit** *(Kapitel 4)*
- [x] saveWorld nur bei Änderung (Dirty-Signatur)
- [x] Persist-Zyklus als Transaktion (Spieler + Welt atomar)

**Phase 5 — LLM-Kontext & UX-Feinschliff** *(Kapitel 2+6)*
- [x] Strategist-Snapshot: Armee/Verteidigung/Bedrohungen; Plan-Fehler loggen
- [x] Advisor-Snapshot: Militär/Schiffe/Markt + Regeln im System-Prompt
- [x] Advisor mit kleinem Token-/Zeitbudget
- [ ] EpochBanner-Ersatz auf Mobile; Polling bündeln *(separat, nach Bedarf)*

**Später/optional:** Zwei-Phasen-Generierung, LLM-Warteschlange mit Priorität,
Onboarding, PNG-Icons, Cross-Account-Test (blockiert durch zweiten Account),
`aggression` aktivieren (User-Entscheid).

---

## Zweiter Durchgang (2026-07-13) — weitere Funde, alle gefixt

- [x] 🔴 **Shutdown speicherte die Welt nicht** — Schiffe/Angebote/Kriegs-
  erklärungen der letzten ≤ 60 s gingen bei jedem Stop verloren (`index.js`:
  shutdown sicherte nur Spieler). → `saveWorld` ergänzt.
- [x] 🔴 **Treuhand-Verlust-Fenster in 6 Routen** — Markt/Schiff/Krieg buchen
  erst beim Spieler ab und legen die Ware dann in der Welt ab; die Saves waren
  getrennt → Crash dazwischen frisst die Treuhand. → `persistHumanWorld()`
  (eine Transaktion) in allen 6 Routen.
- [x] 🟡 **Instanz-ID-Kollision Mensch ↔ KI** — beide zählen ab 1; das Ketten-
  Overlay (`instances.find(id)`) erwischte beim Klick auf ein KI-Gebäude das
  gleichnamige eigene. → KI-Instanz-IDs namespaced (`p<id>-<n>`).
- [x] 🟡 **Polling lief im Hintergrund-Tab weiter** (state 2 s + players/market
  3 s — Akku/PWA) und der Markt wurde auch bei geschlossenem Panel gepollt.
  → `visibilitychange`-Pause + sofortiges Auffrischen beim Zurückkehren;
  Markt nur bei offenem Panel.
- [x] 🟡 **Offline-Aufholung ohne KI-Züge** — KI-Inseln produzierten beim
  Nachholen, bauten aber nie (Executor lief nicht) → nach langem Stillstand
  fallen sie unfair zurück. → Aufholung in 60-Tick-Blöcken mit Executor-Zug.
- [x] 🟡 **Inselwachstum verfiel bei Offline-Epochenaufstieg** — `epoch_advance`-
  Events der Aufholung wurden nur gezählt, nie verarbeitet. → Boot-Loop zieht
  `growIslandRegion` nach.

Geprüft und in Ordnung: `/api/build` ohne Sofort-Save (Design: Tick-Loop
persistiert ≤ 1 min, nur Spieler-Daten betroffen), acceptOffer-Guards vor
Abbuchung, Publish-Reentranz beim Sync (wirft kontrolliert), Schiffs-Uhr nach
Offline-Sprung (Lieferung im ersten Live-Tick).

---

## Runde 3 — Gesamtspiel-Review (2026-07-13, max. Tiefe)

Nach den zwei Wirtschafts-Vorfällen (unerfüllbare needs `90b82bf`, Multiplikator-
Regression `80b1ae7`) das ganze Spiel neu durchdacht: Kernschleife, Engine-
Mechanik, LLM-Rollen, Client, Betrieb. **Vier neue Befunde sind am Code
verifiziert** (keine Spekulation); der Rest ist Design-Weiterdenken.

### 9. Neue verifizierte Befunde

- 🔴 **S/M — Produktion ignoriert die echte Bevölkerung** (`tick.js:54`):
  `eff = min(1, b.workers/needWorkers)` nutzt die ZUGEWIESENEN Arbeiter —
  nirgends wird gegen die tatsächliche workforce geprüft. Seit Zuweisungen
  bei Schwund bewusst erhalten bleiben, produziert eine Insel nach einem
  Bevölkerungseinbruch (Raubzug! Hunger!) einfach auf altem Niveau weiter —
  Verluste sind wirtschaftlich folgenlos, Überzuweisung ist ein Exploit.
  Fix: globaler Besetzungsfaktor `min(1, workforce/assignedTotal)` multiplikativ
  auf `eff` (in Deltas UND flows/rates, damit die Anzeige stimmt). Damit werden
  Raubzug-Verluste spürbar und heilen sich beim Nachwachsen von selbst.
- 🔴 **M — HiDPI/Retina-Blur** (`IsoMap.svelte resize()`): Canvas wird in
  CSS-Pixeln aufgezogen (`canvas.width = clientWidth`), `devicePixelRatio`
  wird nie berücksichtigt → auf praktisch jedem Smartphone (DPR 2–3) und
  Retina-Desktop rendert das ganze Spiel weichgezeichnet. Fix: physisch
  `width×dpr`, logisch weiterzeichnen via `ctx.setTransform(dpr,…)`;
  Sprite-/Insel-Bakes in DPR backen (Speicher-Abwägung: Bakes ×dpr² —
  ggf. dpr auf 2 deckeln). Pointer-Mathe bleibt in CSS-px.
- 🟡 **M — Toter Contenttyp `events`**: Schema, Loader und Registry führen
  `events` vollständig mit — **keine einzige Engine-Zeile verarbeitet sie**.
  Entweder streichen oder (empfohlen) als Mini-Event-Engine beleben:
  zeitlich begrenzte, harmlose Modifikatoren („Sturm: −15 % Holz für 2 h",
  „Erntefest: +10 % Zufriedenheit"), 1–2 pro Tag, seeded-deterministisch,
  Toast + Chronik-Eintrag. Gibt der Nacht-KI eine **gefahrlose** neue
  Spielwiese (temporär ⇒ kein Dauerschaden; Balancer-Deckel ±20 %, ≤ 1 Tag).
- 🟡 **S — Log-Spam**: Fastify loggt jeden Request auf info — /api/state
  alle 2 s + /api/players alle 3 s = Dauerrauschen, wächst unbegrenzt
  (Docker-Log). Fix: `disableRequestLogging: true` + gezielte Fehler-Logs
  (Fehler/5xx weiterhin loggen), optional Docker-log-rotate in compose.

### 10. Spieldesign — Kernschleife

- 🔴 **M — Epochen-Aufstieg als Spieler-Entscheidung:** Der Auto-Aufstieg
  hat den Nacht-Vorfall erst scharf gemacht (neue needs + neuer Multiplikator
  ohne Zutun um 3 Uhr nachts). Stattdessen: Bedingungen erfüllt → Banner-CTA
  „Aufstieg bereit!" mit **Vorschau** (neue Bedürfnisse inkl. ✓/⚠ aus
  chainWorkerCost gegen die eigene Produktion, neuer Multiplikator, neue
  Gebäude) → bewusster Klick. KI-Spieler steigen weiter automatisch
  (Executor-Stabilitäts-Gate existiert). Engine: advance nur markieren,
  `POST /api/advance` führt aus.
- 🔴 **M — Offline-Bericht („Während du weg warst"):** Beim ersten Poll nach
  Abwesenheit ein Digest: Δ Bevölkerung/Epoche, Kämpfe (warLog), Handels-
  Abschlüsse, Schiffs-Ankünfte, LLM-Nachtchronik. Server sammelt beim Boot
  ohnehin Offline-Events — sie verpuffen nur. DER klassische Idle-Moment,
  aktuell komplett stumm.
- 🟡 **M — Arbeiter-Management-Panel:** Die Engine arbeitet pro Gebäude-TYP —
  nur die UI dafür fehlt (aktuell nur ±1 im InfoPanel je angeklicktem
  Gebäude). Panel mit Typ-Zeilen (zugewiesen/max, ±, Balken), Button
  „Auto-verteilen" (autoAssignWorkers ist exportiert!), 📌-Pin für die
  Nahrungskette, Warn-Badge „unbesetzt" auf der Karte.
- 🟡 **S — Hunger-Härte proportional:** `popDeclineRate` wirkt binär voll ab
  dem ersten fehlenden Krümel Nahrung. Proportional zu `unmet/foodNeed`
  skalieren — kleine Defizite = leichter Schwund statt Maximal-Sterberate.
- 🟡 **S/M — Verlaufs-Graphen:** Client-Ringpuffer (Pop, Zufriedenheit,
  Nahrungs-Netto) + Canvas-Sparklines im Panel. Trends sichtbar machen,
  BEVOR sie kippen — die Todesspirale war 8 h lang unsichtbar.
- 🟢 **M/L — LLM-Tagesziele (Quests):** Nightly generiert 3 messbare Ziele
  („Baue 2 Wehrtürme", „Erreiche 700 Einwohner", „Lagere 200 Stahl") mit
  kleinen, balancer-gedeckelten Belohnungen; Validierung rein mechanisch
  (aus State ableitbar). Nutzt die lokale KI erstmals für GAMEPLAY-Richtung
  statt nur Content — passt perfekt zum Projektkern.
- 🟢 **M — Sound-Layer:** komplett stumm heute. WebAudio, synthetisiert
  (keine Assets): Bau-Thud, Münze, Meeresrauschen, Nacht-Grillen; Mute
  persistiert. Größter Atmosphäre-Gewinn pro Zeile Code.

### 11. Engine-Robustheit v2

- 🟡 **M — Sandbox „Post-Advance":** Der Import simuliert 1000 Ticks im
  IST-Zustand — der Multiplikator-0.3-Fehler lag aber in der NÄCHSTEN
  Epoche. Zusätzliche Sandbox-Variante: Klon mit `epochId = neueEpoche`,
  1000 Ticks, Ablehnung wenn Bevölkerung > 50 % fällt. Fängt ganze Klassen
  unbekannter Mechanik-Fallen, nicht nur die zwei bekannten.
- 🟡 **S/M — Topologische Produktionsreihenfolge:** Ketten-Durchsatz hängt
  heute von der Einfüge-Reihenfolge in `state.buildings` ab (Verbraucher vor
  Produzent = 1 Tick Versatz + Null-Puffer-Flackern). Einmal pro Registry-
  Reload topologisch sortieren (Produzenten zuerst), Engine iteriert die
  sortierte Liste.
- 🟢 **M — Ökonomie-Langlauftest:** 10k-Tick-Test mit geskriptetem Standard-
  Aufbau, Assert `pop_end ≥ pop_start` & keine Ressource NaN/∞ — dauerhaftes
  Frühwarnsystem gegen künftige Spiralen (CI-tauglich, Engine ist rein).
- 🟢 **S — `npm run balance:report`:** das heutige Diagnose-Skript
  (Kettenkosten aller needs, Multiplikator-Kette, Deckungs-Check) als
  dauerhaftes Werkzeug einchecken.

### 12. LLM v2

- 🟡 **S — Modell-Routing pro Rolle:** llama-swap hostet mehrere Modelle
  (gesehen: Qwen2.5-Omni, devstral, …). `LLM_MODEL_NIGHTLY` (groß, Qualität,
  Latenz egal) vs. `LLM_MODEL_CHAT` (klein, schnell für Advisor/Strategist).
  Drei Callsites + zwei Env-Variablen.
- 🟡 **S — Nightly-Telemetrie im 🤖-Panel:** Acceptance-Quote, letzte
  Clamps/Reparatur-Runden, „letzter Lauf vor X h" (ai_runs liegt bereit) —
  macht auch einen still gestorbenen ai-worker sofort sichtbar.
- 🟢 **S — Themen-Rotation gegen Content-Monotonie:** Prompt rotiert Fokus
  (Kultur → Militär → Luxus → Infrastruktur → Kuriosum) nach Wochentag/
  Pack-Zähler; verhindert die x-te Werkstatt-Variante.
- 🟢 **M — Advisor-Streaming (SSE):** Antwort tokenweise ins Panel statt
  30-s-Blackbox.
- *(weiter offen aus Runde 1–2: Zwei-Phasen-Generierung, LLM-Queue mit
  Priorität, `aggression` aktivieren = User-Entscheid.)*

### 13. Client & Betrieb

- 🟡 **S — `scripts/deploy.sh`:** build web → compose build/up (app,
  ai-worker) → dist kopieren → healthz-Gate. Der manuelle Vierschritt ist
  fehleranfällig (heute mehrfach am falschen cwd gescheitert).
- 🟡 **S — ai-worker-Watchdog:** compose-healthcheck + „letzter Nightly"-
  Status (siehe Telemetrie) — aktuell stirbt der Scheduler lautlos.
- 🟢 **S — /healthz ausbauen:** uptime, aktive Spieler, letzter Nightly-
  Status, Welt-Tick — eine Zeile für Monitoring.
- 🟢 **S — Optionaler `GAME_TOKEN`:** schreibende Spiel-API absicherbar,
  falls je ein Port ins Internet zeigt (Standard: aus, LAN bleibt frei).
- 🟢 **S — README-Verweis auf opti.md** + Doku-Dopplung Multiplayer auflösen
  (aus Runde 1 weiter offen).

### Gesamt-Roadmap v2

**Phase A — Korrektheit sofort:** Besetzungsfaktor (9) · HiDPI (9) ·
Log-Spam (9) · deploy.sh (13)
**Phase B — Spielgefühl:** Epochen-Entscheidung (10) · Offline-Bericht (10) ·
Arbeiter-Panel (10) · Hunger proportional (10)
**Phase C — Absicherung:** Post-Advance-Sandbox (11) · Langlauftest (11) ·
balance:report (11) · Watchdog + Telemetrie (12/13)
**Phase D — Lebendigkeit:** Event-Engine (9) · Sparklines (10) · Sound (10) ·
Themen-Rotation + Modell-Routing (12)
**Phase E — Kür:** Quests (10) · Advisor-SSE (12) · Onboarding · PNG-Icons ·
EpochBanner-Mobile · /api/frame-Bündelung · GAME_TOKEN
**Blockiert/extern:** Cross-Account-Test (2. GitHub-Account) ·
`aggression` (User-Entscheid)
