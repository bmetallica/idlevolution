# Konzept: Asynchrone Multiplayer-Erweiterung für Idlevolution

Dieses Dokument beleuchtet die technische Machbarkeit und mögliche Architektur für dein Vorhaben, eine asynchrone Multiplayer-Komponente (Handel, Inseln besuchen) in das von einer lokalen KI gesteuerte Aufbauspiel *Idlevolution* zu integrieren.

## 1. Machbarkeit & Grundidee
Das Konzept des "asynchronen Multiplayers" (Daily Sync) passt **hervorragend** zur Kernmechanik von Idlevolution. Da das Spiel bereits darauf ausgelegt ist, dass nachts im Hintergrund KI-Berechnungen und Updates stattfinden, fügt sich ein nächtlicher Server-Sync nahtlos in diesen Rhythmus ein. 
Die Idee, dass Spieler die durch ihre individuelle KI geschaffenen Inhalte miteinander tauschen können, wertet das Spiel massiv auf.

## 2. Der "Server" (GitHub OAuth vs. Cloud-Datenbank)

Ursprünglich hatten wir einen klassischen BaaS (wie Supabase) favorisiert. Deine neue Idee, ein **eigenes GitHub Repo** für den Online-Austausch zu nutzen und den Login direkt über das Spiel-UI via GitHub OAuth abzuwickeln, ist jedoch ein brillanter Twist!

### Der GitHub OAuth-Ansatz (Empfohlen für Community-Fokus)
- **Die Mechanik:** Es gibt ein zentrales, von dir verwaltetes GitHub-Repository (z.B. `idlevolution-world`).
- **Der Login:** Spieler, die den Online-Modus aktivieren wollen, klicken im UI auf "Mit GitHub verbinden". Über einen standardisierten OAuth-Flow autorisieren sie das Spiel, in ihrem Namen Commits im Ziel-Repository zu machen.
- **Vorteile:** 
  - Du brauchst absolut keinen eigenen Server, keine Datenbank und hast keine Hosting-Kosten.
  - Jeder Upload eines Spielers ist kryptografisch an seinen echten GitHub-Account gebunden (Verhinderung von Spam und Anonymität).
  - Versionierung: Die Insel-Historie jedes Spielers ist nativ über Git nachvollziehbar.
- **Die Einschränkung (Schreibschutz):** Da die Spieler (bzw. deren Tokens) Schreibrechte im Repo brauchen, könnten sie theoretisch über die GitHub API auch Dateien anderer überschreiben. Da wir aber den Login an den GitHub-User binden, lässt sich das serverseitig absichern: Du konfigurierst in dem zentralen Repo eine *GitHub Action* (CI/CD), die jeden Commit oder Pull-Request automatisch ablehnt, wenn `User_X` versucht, Dateien im Ordner `islands/User_Y/` zu ändern. So erzwingen wir den Schreibschutz rein über GitHub-Bordmittel!

---

## 3. Die technische Umsetzung im Detail

Um das Feature sauber umzusetzen, müssen wir tiefer in die Logik eintauchen. Hier sind die von dir angesprochenen, komplexeren Aspekte beleuchtet:

### A. Der "Online-Modus" & Globale Content-Synchronisation
Sobald ein Spieler auf "Insel freigeben" klickt, passiert Folgendes:
1. **Der Upload:** Die eigene Inselstruktur und die eigenen KI-Packs werden in das GitHub-Repo (z.B. in den Pfad `islands/<github-username>/`) gepusht.
2. **Der Download (Content-Sync):** Um die Weltkarte oder fremde Inseln überhaupt rendern zu können, muss das Spiel *alle* relevanten fremden Content-Packs aus dem Repo herunterladen.
3. **Isolierte Speicherung:** Diese fremden Packs sollten in einem getrennten lokalen Bereich (z.B. `data/content/shared/`) abgelegt werden. Sie dienen zunächst nur als "Lese-Kopie" für das Rendering fremder Inseln, damit das *eigene* Gameplay und Balancing noch nicht beeinflusst wird.

### B. Grafik-Synchronisation & Das Farb-Hash-Problem
Die Engine (in `sprites.js`) zeichnet Gebäude prozedural. Farben (Wand, Dach, Akzente) werden standardmäßig aus einem Hash der Gebäude-ID (`hashStr(def.id)`) generiert.
**Das Problem:** Wenn wir zur Vermeidung von Content-Kollisionen die ID eines KI-Gebäudes beim Upload in das Repo umschreiben (z.B. von `"copper_mine"` zu `"username_copper_mine"`), ändert sich der Hash! Das Gebäude hätte auf dem Rechner von Spieler A plötzlich eine völlig andere Farbe.
**Die Lösung:** Beim Upload in das GitHub-Repo muss dein Export-Skript den aktuell sichtbaren Hash-Farbwert "einfrieren" und explizit als String in das JSON schreiben (in `meta.art.wall` und `meta.art.accent`). So wird die Grafik beim Herunterladen exakt reproduziert, selbst wenn die ID umbenannt wird. (Zudem sollte in `building.schema.json` das Feld `meta.art` strikt typisiert werden).

### C. Das Content-Kollisions-Problem
Da das Spiel stark auf IDs basiert (z.B. `"id": "copper_ingot"`), besteht hohe Kollisionsgefahr.
**Die Lösung:** Beim Upload in das GitHub-Repo schreibt das Export-Skript des Spielers alle IDs dynamisch um und setzt den GitHub-Namen als Präfix (z.B. `"id": "username_copper_ingot"`). Dadurch ist ein global eindeutiger Namespace garantiert.

### D. KI-gesteuerte Wechselkurse (Der "KI-Händler")
Deine Idee, den Handelspreis durch die lokale KI angleichen zu lassen, löst ein massives Balancing-Problem! 
**Ablauf des "Smart Trades" mit asymmetrischen Preisen:**
1. **Angebot:** Spieler B verlangt 100 Holz für 50 "KI-Ressource-X" und stellt das Angebot ins Repo.
2. **KI-Bewertung (Spieler A):** Die lokale KI von A analysiert den Wert von "KI-Ressource-X" anhand des eigenen Ökosystems (Herstellungskosten, Nutzen) und bestimmt: *Für unsere Insel ist das eigentlich 150 Holz wert.*
3. **Asymmetrischer Handel:** Wenn A annimmt, zahlt A 150 Holz. B erhält bei seinem Sync aber nur die 100 Holz, die er ursprünglich gefordert hat. Die 50 Holz Differenz werden vom System als "Wechselgebühr" absorbiert.

### E. Sicherheit & Schutz vor Schadcode (Malware/Injection)
Da die Spieler beim Online-Modus Daten von fremden Rechnern herunterladen, ist Sicherheit kritisch.
1. **Striktes JSON-Only:** Die Daten dürfen ausschließlich als reiner Text (JSON) ausgetauscht werden.
2. **Aggressive Schema-Validierung:** Bevor dein Spiel ein heruntergeladenes Paket verarbeitet, muss es durch `ajv` laufen. Jedes Feld, das nicht im Schema definiert ist, wird sofort gelöscht.
3. **Schutz vor "Prompt Injection":** Da die lokale KI von A die Daten von B liest, könnte ein Angreifer versuchen, LLM-Befehle zu verstecken. Wir nutzen:
   - *Feld-spezifische Validierung:* Technische Felder (IDs, `shape`) per Regex strikt prüfen.
   - *Daten-Sparsamkeit:* Die KI bekommt für die Preisberechnung nur die *Zahlenwerte* (baseValue, category) des fremden Items zu sehen, aber **nicht** die freigeschriebenen Story-Texte (`chronicle`).
   - *Prompt-Kapselung:* Alle unvermeidbaren Fremdtexte (Item-Name) werden im Prompt in `<untrusted_data>` Delimiter gekapselt.

---

## 4. Fazit & Roadmap

Die Entscheidung für einen GitHub-OAuth-Ansatz ist unkonventionell, aber fantastisch für ein Open-Source und KI-getriebenes Spiel. Es verlagert das "Hosting" komplett auf GitHub, kostet 0€ und die echten GitHub-Namen bringen ein Community-Gefühl rein.

**Empfohlene nächste Schritte für einen Proof-of-Concept:**
1. **GitHub-App anlegen:** Eine OAuth App in deinem GitHub-Account erstellen (für die Client-ID).
2. **OAuth-Integration (Svelte):** Einen "Login mit GitHub"-Button im UI bauen, der den Token generiert.
3. **Export-Logik (Backend):** Ein Skript schreiben, das den aktuellen Inselstatus als JSON über die GitHub-REST-API als direkten Datei-Commit (im Namen des Nutzers) in ein zentrales Repo (`idlevolution-world`) pusht.
