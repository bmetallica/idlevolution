# Roadmap: Asynchroner Multiplayer über GitHub

Stand 2026-07-12. Ersetzt das Vorkonzept in `mp/` (dort erarbeitete Ideen sind
eingeflossen, zentrale Punkte wurden aber korrigiert — siehe Abschnitt 2).
Online-Speicher: **github.com/bmetallica/idlevolution-online** (existiert,
Grundgerüst liegt drin, Kern-Pipeline ist real getestet — Abschnitt 7).

## 1. Ziel & Prinzipien

Spieler können ihre Insel **freiwillig** online freigeben, die Inseln anderer
besuchen, mit ihnen handeln und (später) deren KI-generierte Inhalte
übernehmen. Dabei gilt:

1. **Asynchron** („Daily Sync"): kein Live-Server, kein Realtime. Der Abgleich
   passiert nächtlich (im ai-worker-Rhythmus) plus manuell per Knopf.
2. **0 € Betriebskosten**: GitHub ist Speicher, Auth-Anbieter und Prüf-Instanz
   (Actions). Kein eigener Server, keine Datenbank in der Cloud.
3. **Opt-in mit Haftungsausschluss**: Ohne expliziten „Online gehen"-Schritt
   inkl. Disclaimer-Dialog verlässt kein Byte den eigenen Rechner.
4. **Identität = GitHub-Account**: global eindeutig, spamresistent, kein
   eigenes Profilsystem nötig.
5. **Fremddaten sind grundsätzlich feindlich**: strikte Validierung auf beiden
   Seiten (Action beim Upload, ajv beim Download), Prompt-Injection-Schutz,
   Fremd-Content strikt isoliert vom eigenen Spielstand.

## 2. Korrekturen am mp/-Vorkonzept

Das Vorkonzept war eine gute Basis, hatte aber vier Punkte, die so nicht
funktionieren bzw. riskant sind:

| # | Vorkonzept | Problem | Korrektur |
|---|-----------|---------|-----------|
| 1 | Spieler committen mit ihrem Token **direkt** ins zentrale Repo | Dafür bräuchte jeder Spieler Collaborator-/Schreibrechte im zentralen Repo — die gibt man Unbekannten nie; die „Action lehnt ab"-Idee greift bei Direkt-Commits auf `main` zu spät (Daten wären schon drin) | **Fork → PR → Action validiert → Auto-Merge.** Spieler schreiben nur in ihren eigenen Fork; ins zentrale Repo gelangt nichts ungeprüft |
| 2 | OAuth App mit Callback `http://localhost:8420` | Bricht für jeden, der das Spiel unter anderem Host/Port betreibt; Authorization-Code-Flow braucht zudem ein Client-Secret, das in einem Open-Source-Spiel nicht geheim bleibt | **GitHub Device Flow**: nur eine öffentliche Client-ID nötig, kein Secret, keine Callback-URL. Spieler tippt einen Code auf github.com/login/device ein — funktioniert bei jedem Setup |
| 3 | Token im `localStorage` des Browsers | XSS-anfällig, und der Sync soll nachts serverseitig laufen (Browser evtl. zu) | Token liegt **serverseitig in Postgres** (neue Migration); alle GitHub-Aufrufe macht der Fastify-Server |
| 4 | Asymmetrische LLM-Preise, Differenz wird „absorbiert" | Ohne vertrauenswürdigen Server kann keine Seite die Buchung der anderen erzwingen — das Konstrukt suggeriert eine Konsistenz, die es nicht gibt | **V1: einfache Festpreis-Angebote** mit Zwei-Dateien-Handshake; die lokale LLM wird **Preis-Berater** („für dich günstig/teuer"), nicht Buchhalter. Asymmetrik später als Option |

Übernommen aus dem Vorkonzept (gut durchdacht): ID-Namespacing per
Username-Präfix, Einfrieren der prozeduralen Sprite-Farben beim Export,
Striktes-JSON-only + aggressive Schema-Validierung, Prompt-Injection-Regeln
(nur Zahlen ans LLM, `<untrusted_data>`-Kapselung), isolierte Ablage fremder
Packs.

## 3. Architektur

```
Spiel A (Fastify)                     GitHub                        Spiel B
─────────────────                ────────────────                ─────────────
exporter.js  ──Fork+Commit+PR──▶ idlevolution-online ◀──PR──────  exporter.js
                                  ├ Action: validieren
                                  ├ Action: auto-merge
                                  └ Action: index.json bauen
sync.js      ◀──raw (ohne Token)── main-Branch ──raw───────────▶  sync.js
```

- **Schreiben** (nur eigene Daten): Spiel forkt das zentrale Repo einmalig,
  committet nach `islands/<github-user>/…` in den Fork, öffnet einen PR.
  Die Action prüft (Pfad-Schutz: PR-Autor = Ordnername, Schema, Limits) und
  merged automatisch. Scope `public_repo` genügt.
- **Lesen** (alle Daten): tokenlos über `raw.githubusercontent.com` —
  erst `index.json` (eine Datei, von der Action gepflegt), dann gezielt die
  Inseln, die der Spieler ansehen will. Keine API-Rate-Limit-Probleme.

### Datenlayout im zentralen Repo (liegt bereits so im Grundgerüst)

```
index.json                      # von der Action gepflegter Einstiegspunkt
schema/island.schema.json       # v1-Schema (strict, additionalProperties:false)
scripts/validate.mjs            # dependency-freier Validator (Action-seitig)
scripts/build-index.mjs         # Index-Builder
setup/…                         # Workflows (bis workflow-Scope erteilt ist)
islands/<user>/island.json      # Insel: Region-Karte, Instanzen, Straßen, Epoche, Chronik
islands/<user>/packs.json       # (M1) eigene KI-Packs, IDs genamespaced, Farben eingefroren
islands/<user>/offers.json      # (M3) offene Handelsangebote
islands/<user>/accepts.json     # (M3) angenommene fremde Angebote (Handshake)
```

### Export-Transformationen (server/src/online/exporter.js)

1. **Karten-Ausschnitt**: nur die eigene Insel-Region (nicht die 288er-Welt),
   Koordinaten relativ zur Region.
2. **ID-Namespacing**: jede eigene Content-ID `x` → `gh-<user>--x` in
   packs.json und in den Instanz-Referenzen. Kollisonsfrei, Rückrichtung
   eindeutig.
3. **Farben einfrieren**: sprites.js färbt prozedural aus `hashStr(def.id)` —
   nach dem Umbenennen wären die Farben anders. Der Exporter berechnet die
   aktuellen Wand-/Dach-/Akzentfarben und schreibt sie explizit in `meta.art`.
4. **Daten-Diät**: keine Ressourcenstände im Detail, keine Konfiguration,
   niemals `.env`/Tokens. Nur was zum Rendern + Handeln nötig ist.

### Import/Sync (server/src/online/sync.js)

1. `index.json` laden → Liste „Online-Nachbarn".
2. Gewählte Inseln + Packs laden → **ajv-Validierung mit demselben Schema**
   (Verteidigung in der Tiefe: der Action nicht blind vertrauen).
3. Ablage isoliert unter `data/online/<user>/` — wird NIE in die eigene
   Content-Registry gemischt. Fremde Packs dienen nur dem Rendern fremder
   Inseln (eigene Ladepfade, eigener defIndex beim Besuchen).
4. Übernahme fremder Inhalte ins eigene Spiel nur explizit (M4).

### Anzeige im Spiel

Fremde Inseln werden **read-only** gerendert — die heutige Infrastruktur passt
exakt: der Mehr-Insel-Renderer (per-Insel-Bakes) plus der `_owner`-Mechanismus
im InfoPanel („Gehört X — nur ansehen", keine Steuerung). V1 als „Besuchen"-
Ansicht (IsoMap bekommt Karte+Instanzen des Nachbarn, Zurück-Knopf), NICHT als
Einbettung in die eigene Weltkarte (Koordinaten-/Wachstums-Konflikte).

## 4. Handel (M3) — bewusst einfach

- **Anbieten**: eigenes `offers.json` (`[{id, give:{rid,amt}, want:{rid,amt}}]`),
  Ware wird lokal treuhänderisch abgezogen (wie beim bestehenden Markt).
- **Annehmen**: Annehmer schreibt den Angebots-Verweis in SEIN `accepts.json`
  und zahlt lokal. Beim nächsten Sync sieht der Anbieter den Accept, bucht die
  Gegenseite und entfernt das Angebot. Bei Doppel-Annahme gewinnt der frühere
  Timestamp im gemergten Stand; die anderen erhalten beim Sync die Erstattung.
- **LLM-Preisberater**: bewertet fremde (unbekannte) Ressourcen anhand von
  baseValue/Kategorie/eigener Wirtschaft. Bekommt ausschließlich Zahlen und
  IDs zu sehen, Fremdtexte nur `<untrusted_data>`-gekapselt, Chroniken nie.
- **Ehrlichkeit**: Ohne Server ist Cheaten (lokalen Stand editieren) ohnehin
  möglich — gilt schon heute im Singleplayer. Kein Anti-Cheat-Theater.

## 5. Sicherheit & Haftung

**Bedrohungsmodell**: bösartige JSON-Dateien (Überschreiben fremder Daten,
übergroße Dateien, Schema-Missbrauch, versteckte LLM-Instruktionen).

- **Action-seitig** (getestet): Pfad-Schutz (PR-Autor = Ordner, auch für
  gelöschte/umbenannte Dateien), Dateinamen-Whitelist, 512 KB/Datei,
  2 MB/Ordner, JSON-Parse, Strukturprüfung von island.json inkl.
  `owner == PR-Autor` (Spoofing-Schutz), unbekannte Felder ⇒ Ablehnung.
  Die Action checkt IMMER nur main-Code aus; PR-Inhalte werden nie ausgeführt.
- **Client-seitig**: identische Prüfungen via ajv beim Download; Längen- und
  Regex-Grenzen für alles, was gerendert wird; Fremdtexte werden nur als Text
  gerendert (Svelte escapt ohnehin); Fremd-Content isoliert in `data/online/`.
- **LLM-seitig**: Zahlen statt Texte, Delimiter-Kapselung, Chronik-Texte
  fließen nie in Prompts der eigenen KI.
- **Moderation** (M5): `blocklist.json` im zentralen Repo (Repo-Inhaber pflegt
  sie); geblockte Ordner fliegen aus dem Index, Clients ignorieren sie.

### Disclaimer-Dialog „Insel online freigeben" (Pflicht vor dem ersten Upload)

> **🌐 Insel online freigeben — auf eigene Gefahr**
>
> Du bist dabei, deine Insel im öffentlichen Community-Repository
> `idlevolution-online` auf GitHub zu veröffentlichen. Damit gilt:
>
> - Dein **GitHub-Name**, deine Insel (Karte, Gebäude, Epoche, Chronik) und
>   deine KI-generierten Inhalte werden **öffentlich** sichtbar und über die
>   Git-Historie dauerhaft nachvollziehbar.
> - Der Online-Modus lädt **Inhalte fremder Spieler** auf deinen Rechner.
>   Sie werden automatisiert geprüft, eine Prüfung durch Menschen findet
>   **nicht** statt. **Es wird keine Gewähr für Fremdinhalte übernommen.**
> - Die Nutzung erfolgt **auf eigene Gefahr**. Für Schäden jeglicher Art —
>   insbesondere durch heruntergeladene Inhalte, Datenverlust oder Fehlverhalten
>   Dritter — wird **keine Haftung** übernommen, soweit gesetzlich zulässig.
> - Es besteht kein Anspruch auf Verfügbarkeit des Dienstes. Es gelten
>   zusätzlich die Nutzungsbedingungen von GitHub.
> - Du kannst deine Freigabe jederzeit beenden („Offline gehen" entfernt
>   deine Daten per PR aus dem Repository; Kopien in der Git-Historie und bei
>   anderen Spielern können bestehen bleiben).
>
> [Abbrechen] [Ich verstehe und stimme zu — Insel freigeben]

Zustimmung wird mit Zeitstempel lokal (DB) gespeichert; bei Textänderung wird
erneut gefragt.

## 6. Meilensteine

### M0 — Fundament (Login, Einstellungen, Repo scharf schalten)
- GitHub **Device Flow** in `server/src/online/auth.js` (Client-ID einer vom
  Repo-Inhaber angelegten OAuth App, Scope `public_repo`; Poll-Loop serverseitig).
- Migration 007: `online_settings` (Token verschlüsselt/at-rest, Username,
  Disclaimer-Zustimmung, Sync-Zeitpunkte, enabled-Flag).
- 🌐-Panel im Client: „Mit GitHub verbinden" (zeigt User-Code + Link),
  Verbindungsstatus, **Disclaimer-Dialog** (Text oben), „Offline gehen".
- Zentrales Repo: Workflows aus `setup/` nach `.github/workflows/`
  (braucht einmalig `gh auth refresh -s workflow` durch den Repo-Inhaber),
  Branch-Protection für `main` (nur via PR).
- **Test**: Cross-Account-PR (zweiter GitHub-Account), Action lehnt fremde
  Pfade ab / merged eigene automatisch.

### M1 — Insel veröffentlichen
- `server/src/online/exporter.js`: Region-Export, ID-Namespacing,
  Farb-Einfrieren, packs.json; Fork sicherstellen, Commit in Fork
  (git-data-API: Blob→Tree→Commit→Ref), PR öffnen; Status/Fehler ins 🌐-Panel.
- Upload-Trigger: manuell + nächtlich nach der Content-Generierung
  (ai-worker-Hook), nur bei Änderungen.
- **Test**: Insel dieses Servers landet validiert im zentralen Repo;
  erneuter Upload aktualisiert statt dupliziert.

### M2 — Nachbarn entdecken & besuchen
- `server/src/online/sync.js`: index.json + gewählte Inseln/Packs tokenlos
  laden, ajv-validieren, isoliert speichern; täglicher Sync + Knopf.
- 🌐-Panel: Insel-Liste (Name, Epoche, Bevölkerung, Chronik, zuletzt aktiv),
  „Besuchen" → read-only-Render in IsoMap (fremder defIndex aus deren Packs,
  `_owner` gesetzt → InfoPanel bereits schreibgeschützt), Zurück-Knopf.
- **Test**: Zweitinstanz des Spiels (anderer Account) sieht und besucht die
  Insel der Erstinstanz mit korrekten Farben/Formen.

### M3 — Handel
- offers.json/accepts.json + Handshake-Logik in sync.js; Lieferung/Buchung
  beim Sync (UI: „Schiff kommt mit dem nächsten Sync" — Idle-gerecht).
- LLM-Preisberater (nur Zahlen, `<untrusted_data>`), Anzeige im Markt-Panel
  („🌐 Online-Angebote" neben den lokalen KI-Angeboten).
- **Test**: Angebot ↔ Annahme über zwei Accounts, Erstattung bei Doppel-Annahme.

### M4 — Content-Austausch (der eigentliche Clou)
- „Inhalte übernehmen": fremdes Pack explizit in die eigene Registry
  importieren (genamespaced, erneut validiert, als Pack deaktivierbar wie
  KI-Packs heute). Eigene Balance-Prüfung (baseValue-Grenzen) beim Import.
- **Test**: fremdes Gebäude baubar, Sprite-Farben identisch zur Quell-Insel,
  Pack deaktivieren entfernt Instanzen sauber (bestehende Mechanik).

### M5 — Betrieb & Politur
- Pruning (Inseln > 90 Tage ohne Update aus dem Index), blocklist.json,
  Quoten je Ordner (Action), Doku im README beider Repos, „Was wird
  veröffentlicht?"-Vorschau vor dem ersten Upload.

## 7. Machbarkeits-Test (2026-07-12, real durchgeführt)

Am echten Repo `bmetallica/idlevolution-online` verifiziert:

- ✅ Grundgerüst gepusht (Schema, Validator, Index-Builder, README, Workflows in `setup/`).
- ✅ PR #1 mit Beispiel-Insel: Pfad-Schutz, Schema-Prüfung, Squash-Merge —
  alle Action-Schritte 1:1 als Kommandos nachgefahren (identisch zur yml).
- ✅ Validator lehnt ab: fremden Ordner, `owner`-Spoofing, unbekannte Felder,
  Übergrößen (lokal getestet).
- ✅ index.json nach Merge neu gebaut; **tokenloses Lesen** über
  `raw.githubusercontent.com` funktioniert.
- ⚠️ Offen: (a) Workflows scharf schalten — der lokale Token hat keinen
  `workflow`-Scope (`gh auth refresh -h github.com -s workflow`, dann
  `setup/*.yml` → `.github/workflows/`); (b) Cross-Account-Test (zweiter
  GitHub-Account nötig) — insbesondere Fork-PR-Verhalten der Action;
  (c) OAuth App für den Device Flow anlegen (Developer Settings → OAuth Apps
  → „Enable Device Flow", Client-ID in die Spiel-Konfiguration).

## 8. Bewusst NICHT geplant

- Kein Realtime/WebSocket-Multiplayer, keine gemeinsame Live-Weltkarte.
- Kein Anti-Cheat (sinnfrei ohne Server, Koop-Idle-Kontext).
- Kein Krieg/PvP online (lokal Stufe 6, online konzeptionell ungeklärt).
- Keine zentrale Accountverwaltung außerhalb GitHubs.
