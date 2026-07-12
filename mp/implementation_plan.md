# PoC: Asynchroner Multiplayer via GitHub (Phase 1)

Dieses Dokument beschreibt die konkrete technische Umsetzung des ersten Meilensteins für die Online-Erweiterung. Phase 1 fokussiert sich auf die Authentifizierung, die Identität und das sichere Hochladen der Insel in ein Community-Repository.

## User Review Required
> [!IMPORTANT]
> **GitHub Repository:** Du musst auf deinem Account ein neues, öffentliches Repository erstellen (z.B. `idlevolution-world`), das als globale Datenbank dient.
> **GitHub OAuth App:** Du musst in deinen GitHub Developer Settings eine neue "OAuth App" erstellen (Callback-URL `http://localhost:8420`), um eine `Client ID` zu erhalten.

## Open Questions
> [!WARNING]
> Sollen wir für diesen ersten Schritt (Phase 1) *nur* den Login, den Export der Insel und die GitHub Action bauen? Oder möchtest du direkt auch das *Herunterladen* und Anzeigen der fremden Inseln im UI (Phase 2) mit in diesen Sprint aufnehmen?

## Proposed Changes

### 1. Spieler-Identität (GitHub Login)
Da das Spiel bisher keine Spielernamen kennt, schlagen wir zwei Fliegen mit einer Klappe: Der GitHub-Login liefert uns automatisch den weltweit eindeutigen GitHub-Namen (Username) des Spielers. Dieser Name wird als "Player ID" für alle Online-Aktionen verwendet, es muss also kein eigenes Profilsystem gebaut werden.

#### [NEW] web/src/lib/githubAuth.js
- Implementierung des GitHub OAuth-Flows.
- Speichern des generierten GitHub-Tokens und des GitHub-Usernames im `localStorage` des Browsers.

#### [MODIFY] web/src/components/ (z.B. InfoPanel.svelte)
- Hinzufügen eines "Mit GitHub verbinden" / "Online gehen" Buttons.
- Anzeige des Spieler-Avatars und GitHub-Namens nach erfolgreichem Login.

### 2. Export-API (Insel hochladen)
Das Spiel benötigt eine Logik, um den aktuellen Zustand via GitHub-API als Datei-Update in das zentrale Repo zu pushen. Wir nutzen dafür direkte API-Aufrufe (Octokit/fetch) aus dem Client oder Backend.

#### [NEW] server/src/online/exporter.js
- Sammelt die relevanten Spieldaten (Gebäude-Platzierungen, Ressourcen).
- **Grafik-Fix:** friert die lokalen Farb-Hashes (`hashStr(def.id)`) ein und schreibt sie in die `meta.art` der JSON-Ausgabe.
- Nutzt den GitHub-Token des Nutzers, um einen neuen Commit oder Pull-Request im Repo `idlevolution-world` unter dem Pfad `islands/<github-username>/state.json` zu erstellen.

### 3. Serverseitige Sicherheit (Die GitHub Action)
Dein Vorschlag ist brillant: Wir verlagern die Prüfung auf Schadcode direkt in das GitHub-Repo! Wenn ein Spieler seine Insel als Pull Request hochlädt, läuft automatisch ein Bot darüber, bevor die Daten für andere sichtbar in den `main` Branch gemerged werden.

#### [NEW] .github/workflows/validate-island.yml (für das idlevolution-world Repo)
Ein Skript, das bei jedem Pull Request ausgeführt wird:
1. **Pfad-Prüfung:** Blockiert den Upload sofort, wenn Nutzer A versucht, Dateien im Ordner `islands/NutzerB/` zu ändern.
2. **Schema-Validierung:** Führt das JSON-Schema aus. Enthält die Datei z.B. ungültige Felder oder ausführbaren JavaScript-Code (`<script>`), wird der PR sofort abgelehnt.
3. **Prompt Injection Scanner:** Ein kleines Node.js-Skript in der Action durchsucht alle Textfelder nach verdächtigen LLM-Befehlen ("ignore", "system").
Schlägt ein Test fehl, schließt der Bot den PR – Schadcode erreicht so niemals die Rechner der anderen Spieler.

## Verification Plan

### Manual Verification
1. Einrichten der OAuth-App auf GitHub und Eintragen der Keys.
2. Im Browser auf "Mit GitHub verbinden" klicken und prüfen, ob der Name übernommen wird.
3. Auf "Insel hochladen" klicken und im Ziel-Repository prüfen, ob der Commit ankommt und die GitHub Action (Sicherheitsprüfung) erfolgreich (grün) durchläuft.
