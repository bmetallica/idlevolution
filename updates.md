# Updates — Verbesserungen & Ergänzungen

Stand: 2026-07-29. Vollständige Projektdurchsicht mit Schwerpunkt auf der Abstimmung
zwischen Spiel und **lokaler KI** (llama-swap auf `192.168.66.225:8080`).

Alle Befunde unten sind am laufenden System verifiziert — keine Vermutungen.
Vorgänger-Dokument: `opti.md` (Roadmap v1 + v2, vollständig umgesetzt). Dieses
Dokument setzt dort auf und wiederholt nichts daraus.

---

## 0. Sofort behoben (in diesem Durchgang)

Die nächtliche Generierung war **seit dem 24.07. tot** — fünf Nächte in Folge ohne
neuen Inhalt. Ursache und Behebung:

| # | Befund | Ursache | Status |
|---|--------|---------|--------|
| 0.1 | Jede Nacht `Token-Budget erschöpft, bevor Content kam` | `LLM_CTX=32768`, das Modell `gemma4-12b` bietet real nur **16384**. `max_tokens: 12288` wurde serverseitig still auf den Rest gekappt; das Reasoning-Modell verbrauchte alle verbleibenden ~4500 Tokens im `<think>`-Block und lieferte **nie** `content`. | ✅ behoben |
| 0.2 | Fehlschlag riss die *ganze* Nacht mit | `runNightly()` warf sofort — KI-Planung, Tagesziele, Kriegs-Auflösung und Online-Sync standen dahinter und liefen fünf Nächte gar nicht. | ✅ behoben |
| 0.3 | `Tagesziele übersprungen: operation was aborted due to timeout` | API-Timeout von 120 s für `/api/quests/generate`; der LLM-Aufruf dahinter braucht auf der lokalen GPU regelmäßig 2–4 min. | ✅ behoben |
| 0.4 | Prompt wuchs unbegrenzt mit dem Spielstand | Der Export enthielt volle Kosten-/Produktionstabellen für **alle** 65 Gebäude und 41 Ressourcen — auch für Epochen, an die niemand mehr anbaut. Genau an der Grenze 43 KB → 44,5 KB kippte es. | ✅ behoben |

**Was geändert wurde**

- `generator.js`: `discoverContext()` erfragt das **echte** `n_ctx` beim Server
  (überlanger Prompt → llama.cpp nennt `n_ctx` im Fehlertext, kostet keine GPU-Zeit)
  und cached es je Modell. `max_tokens` wird daraus abgeleitet: `n_ctx − Prompt − Reserve`.
- Reasoning ist für JSON-Generierung standardmäßig **aus**
  (`chat_template_kwargs: {enable_thinking: false}`) — die Grammatik erzwingt die
  Struktur ohnehin. Über `LLM_THINKING=true` wieder einschaltbar.
- Bleibt `content` trotzdem leer, wird JSON aus `reasoning_content` gerettet,
  statt die Nacht zu verlieren.
- Ein zu großer Prompt scheitert jetzt **mit Zahlen** (`~11875 von 16384 Tokens belegt`)
  statt mit dem irreführenden Rat „LLM_MAX_TOKENS erhöhen" — der genau das Gegenteil bewirkt hätte.
- `exporter.js`: Detailtiefe nach Relevanz (aktuelle ± benachbarte Epochen voll,
  ältere nur `id`/`epoch`) plus hartes Token-Budget mit stufenweiser Verengung.
  **Alle IDs bleiben erhalten**, die Duplikat-Sperre verliert nichts.
- `run-nightly.js`: Generierungsfehler wird protokolliert, der Rest der Nacht läuft
  weiter; der Fehler fliegt erst am Ende nach oben (Scheduler-Alarm bleibt).

**Messung vorher/nachher**

| | vorher | nachher |
|---|---|---|
| Export | 9032 Tokens | **5428 Tokens** (−40 %) |
| Nacht-Prompt gesamt | ~12 200 Tokens | ~7 600 Tokens |
| Ausgabebudget bei 16k Kontext | ~4 500 (komplett im Reasoning verbraucht) | ~8 700 (voll für JSON) |
| Ergebnis | `finish_reason: length`, `content` leer | `finish_reason: stop`, Pack **accepted** |

Live verifiziert: `+3 Gebäude, +1 Ressource, 0 abgelehnt`, dazu KI-Planung,
Tagesziele, Online-Publish und -Sync — alles in einem Lauf. Testsuite 94/94 grün
(2 neue Testdateien: `llm-budget.test.js`, `nightly-resilience.test.js`).

---

## 1. Referenz: die lokale KI, ausgemessen

Diese Werte waren nirgends dokumentiert und sind die Ursache von 0.1. Am 2026-07-29
direkt am Server gemessen — **vor jeder Modellwahl hier nachsehen**:

| Modell | echtes `n_ctx` | Rolle laut Server | Eignung |
|--------|---------------|-------------------|---------|
| `gemma4-12b` | **16 384** | Vision, resident | aktuell im Einsatz; reicht jetzt, wenig Reserve |
| `gemma4-26b` | **32 768** | Gemma 4 26B-A4B (MoE, 4B aktiv) | **beste Wahl fürs Nightly** — mehr Qualität, kaum langsamer |
| `qwen3-14b` | 32 768 | Agenten-/Tool-Modell, resident | guter Chat-/Strategist-Kandidat |
| `qwen3.6-27b` | **49 152** | Reasoning/Planung | maximale Reserve, dafür Modellwechsel nötig |
| `nomic-embed-text` | — | Embeddings, permanent | ungenutzt → siehe 2.3 |

Weitere gemessene Eigenschaften:

- `chat_template_kwargs: {enable_thinking: false}` wird sauber unterstützt und ist
  **der wirksamste Hebel**: 138 → 10 Completion-Tokens, 16,9 s → 0,3 s bei gleichem Ergebnis.
  `reasoning_effort: "none"` und `thinking: false` wirken **nicht**.
- `response_format: json_schema` funktioniert (die Format-Kaskade greift auf Stufe 1).
- `/tokenize` und `/props` sind über llama-swap **nicht** erreichbar (kein Modell-Routing) —
  deshalb die Zeichen-Heuristik (≈ 3,1 Zeichen/Token, gemessen 3,30 → bewusst pessimistisch).
- Prompt-Prefix-Caching greift praktisch nicht (`cached_tokens: 0–1`).

---

## 2. LLM-Pipeline — die größten verbleibenden Hebel

### 2.1 Nightly auf `gemma4-26b` umstellen *(klein, hoher Nutzen)*
`gemma4-12b` läuft jetzt, hat aber bei 16k nur noch ~8,7k Tokens Luft. Wächst der
Spielstand weiter, verengt das Export-Budget automatisch die Detailtiefe — die KI
sieht dann weniger von ihrer eigenen Welt. `gemma4-26b` verdoppelt den Kontext bei
nur 4B aktiven Parametern (MoE).
→ `LLM_MODEL_NIGHTLY=gemma4-26b` in `.env`, `LLM_MODEL_CHAT=gemma4-12b` belassen.
Der Weg ist bereits verdrahtet und getestet, es fehlt nur die Entscheidung.
**Vorher prüfen:** ob llama-swap dafür ein residentes Modell verdrängt.

### 2.2 i18n-Felder tolerant einlesen statt ablehnen *(klein, hoher Nutzen)*
Häufigste *strukturelle* Ablehnung in der Historie: **10×** `description must be object` —
das Modell schreibt `description: "Text"` statt `{de: "Text"}`. Solange die
json_schema-Stufe greift, passiert das nicht; fällt die Kaskade auf `none` zurück,
kostet es das ganze Pack.
→ Im Importer normalisieren: String → `{de: String}` (analog für `name`, `title`).
Eine Zeile Coercion ersetzt eine ganze Ablehnungsklasse.

### 2.3 Semantische Dubletten-Sperre über Embeddings *(mittel, hoher Nutzen)*
Die Silhouetten-Verteilung der 55 generierten Gebäude ist deutlich schief:
`workshop` 12×, `tower` 11×, `house` 9×, `smelter` 7× — gegenüber `market`, `harbor`,
`sawmill` je 1×. Die Themen-Rotation (`D4`) mildert das, verhindert es aber nicht:
Namen wie *Archivtresor*, *Sicherheitsvault* und *Quanten-Speicherzentrum* sind
faktisch dasselbe Gebäude.
→ Der Server hostet `nomic-embed-text` **permanent und ungenutzt**. Beim Import die
Einbettung von `name + description` gegen die bestehenden Gebäude prüfen und bei
Kosinus-Ähnlichkeit > ~0,9 ablehnen (Grund wandert über `recentRejections` zurück
in den nächsten Prompt). Das ist die einzige Maßnahme, die *inhaltliche* statt nur
*struktureller* Dubletten trifft.

### 2.4 Epochen-Duplikate an der Quelle unterbinden *(klein)*
Mit **16 Nennungen** die absolute Spitze der Ablehnungsgründe
(`Epoche 'X' existiert bereits` + `order N ist bereits vergeben`). Die Verbotsliste
im Prompt reicht offenbar nicht.
→ Zwei Möglichkeiten, am besten kombiniert:
  1. `epochs` nur dann überhaupt ins Schema aufnehmen, wenn der Aufstieg wirklich
     nah ist — sonst das Feld weglassen. Was nicht im Schema steht, kann die
     Grammatik nicht erzeugen.
  2. `order` serverseitig erzwingen (`letzte + 1`) statt es vom Modell zu erfragen.

### 2.5 `meta.art.shape` in der Grammatik als `enum` führen *(sehr klein)*
Im Schema steht `shape: {type: 'string'}`, der Prompt zählt die 16 erlaubten
Silhouetten nur im Fließtext auf. Ergebnis: 3 Gebäude tragen `shape: "production"` —
eine *Kategorie*, keine Silhouette. Der Client fängt das ab (`classifyByFunction`),
aber die bewusste Gestaltungsentscheidung geht verloren.
→ Enum ins Schema. Kostet nichts und eliminiert die Fehlklasse an der Quelle.

### 2.6 Wiederholversuch bei totem LLM-Server *(klein)*
Der Cron feuert um 03:00 genau einmal. Ist der LLM-Server in dem Moment offline
oder lädt gerade ein anderes Modell, ist die Nacht verloren — der Watchdog
(`ai-worker.heartbeat`) merkt davon nichts, weil der Scheduler ja lebt.
→ 2–3 Versuche mit wachsendem Abstand (z. B. +20 / +60 min) und ein
`/healthz`-Vorabcheck gegen `LLM_BASE_URL`.

### 2.7 Temperatur je Rolle *(sehr klein)*
`LLM_TEMPERATURE=0.7` gilt für alles. Für die Chronik ist das richtig, für ein
JSON-Pack mit harten Zahlenregeln ist es unnötig riskant (der Advisor nutzt bereits
0.4, Quests dagegen 0.7).
→ Generierung auf 0.4–0.5, Chronik-Text ggf. separat. Erwartbar weniger
Zahlen-Ausreißer und weniger Balancer-Clamps.

---

## 3. Content-Qualität

### 3.1 Ablehnungsquote sichtbar machen
Historie: **18 accepted / 14 rejected / 8 error** — nur ~45 % der Läufe liefern
sauber. Das ist ohne DB-Abfrage nirgends erkennbar.
→ Kleine Kennzahl im KI-Center (`/api/ai/runs` liefert die Daten bereits):
Erfolgsquote der letzten 14 Tage + häufigster Ablehnungsgrund. Macht Regressionen
wie 0.1 am **ersten** Tag sichtbar statt am fünften.

### 3.2 Ereignisse werden erzeugt, aber selten
`events` sind vollständig implementiert (Schema, Tick, UI), der Prompt erlaubt 0–2
pro Pack — in den letzten Packs kam faktisch keines. Das Feld steht am Ende einer
langen Aufzählung und wird bei knappem Budget als Erstes fallengelassen.
→ Ereignisse in eigenen, sehr kurzen Aufruf auslegen (kleines Chat-Modell, wenige
hundert Tokens) statt sie im großen Pack mitzuführen.

### 3.3 Chronik ist der stärkste, am wenigsten genutzte Teil
Jedes Pack liefert eine `chronicle` — narrativ oft gut. Sie erscheint einmal und
verschwindet. → Chronik-Archiv als durchblätterbare „Geschichte der Insel"
(Daten liegen in `ai_runs` bereits vor).

---

## 4. Spielmechanik

### 4.1 Tagesziele bleiben unter dem Maximum *(verifiziert)*
`MAX_QUESTS = 3`, im Lauf von heute Nacht kamen **2**. Ursache: Der Wohnraum ist
voll (1000/1000), damit fällt jedes `population`-Ziel in `validateQuests()` durch
(`amount <= cur → continue`). Die Route akzeptiert ab 2 Zielen als „llm" und füllt
nicht auf; `fallbackQuests()` behandelt genau diesen Fall korrekt (Wohngebäude statt
Bevölkerung), wird aber nicht mehr aufgerufen.
→ Nach `validateQuests()` mit `fallbackQuests()` auf `MAX_QUESTS` auffüllen, statt
bei ≥2 aufzuhören.

### 4.2 Wohnraum-Deckel als Sackgasse
Derselbe Befund von der Spielerseite: Bevölkerung 1000/1000, Nahrung reichlich,
270 freie Arbeiter — das Spiel gibt aber keinen sichtbaren Hinweis, dass jetzt
Wohnraum der einzige Engpass ist. Nur der Berater sagt es, wenn man fragt.
→ Engpass-Hinweis in der Kopfleiste („Wohnraum voll — Wachstum gestoppt").

---

## 5. Betrieb & Beobachtbarkeit

### 5.1 Der Watchdog überwacht den falschen Zustand
`ai-worker.heartbeat` beweist nur, dass der *Scheduler-Prozess* lebt. Genau das war
in allen fünf Ausfallnächten der Fall — der Container galt durchgehend als `healthy`.
→ Zusätzlich das **Ergebnis** der letzten Nacht bewerten: liegt der letzte
`accepted`-Lauf > 48 h zurück, ist etwas kaputt, egal wie munter der Prozess ist.

### 5.2 Keine Benachrichtigung bei Fehlschlag
Fünf verlorene Nächte fielen nur beim manuellen Log-Lesen auf.
→ Kurze Meldung ins Spiel (Chronik-Eintrag „Die Baumeister ruhten heute Nacht") —
in der Spielwelt sichtbar, ohne externe Dienste.

### 5.3 `data/rejected/` und `data/exports/` wachsen unbegrenzt
14 bzw. 25 Dateien, niemand räumt auf. → Aufbewahrung auf ~30 Tage begrenzen.

---

## 6. Code & Tests

### 6.1 `App.svelte` (1070 Zeilen) und `IsoMap.svelte` (1001 Zeilen)
Zusammen 58 % des Clients. Kein akutes Problem, aber die Stelle, an der die
nächste Änderung am teuersten wird. → Bei nächster Gelegenheit Panels herauslösen.

### 6.2 Testabdeckung der LLM-Pipeline
Vor diesem Durchgang war der Pfad, der fünf Nächte kostete, komplett ungetestet —
alle Tests stubbten `fetch` mit einer *erfolgreichen* Antwort. Jetzt abgedeckt
(Budget, Kontext-Erkennung, `reasoning_content`, Nacht-Resilienz).
→ Als Prinzip festhalten: Für jeden LLM-Aufruf auch den **Fehlerpfad** testen.

---

## 7. Bewusst nicht empfohlen

- **Größeres Modell als `gemma4-26b` fürs Nightly.** `qwen3.6-27b` hat 48k Kontext,
  erzwingt aber einen Modellwechsel und bringt für ein Pack von ~1100 Tokens
  Ausgabe keinen erkennbaren Qualitätsgewinn.
- **`LLM_THINKING=true` fürs Nightly.** Genau das war die Ursache von 0.1. Die
  Struktur kommt aus der Grammatik, die Sorgfalt aus den Prompt-Regeln und dem
  Validator — nicht aus dem `<think>`-Block.
- **Cloud-LLM als Rückfallebene.** Widerspricht dem Kern des Projekts
  (vollständig lokal, keine externe Abhängigkeit).
- **Export-Budget deutlich über 6000 Tokens.** Es ist die Sicherung, die 0.4
  überhaupt erst abgefangen hat.

---

## Vorschlag zur Reihenfolge

| Priorität | Punkte | Warum |
|-----------|--------|-------|
| **A — sofort** | 2.1, 2.2, 4.1 | je ein kleiner Eingriff, alle drei mit sofort messbarem Effekt |
| **B — kurzfristig** | 2.4, 2.5, 2.7, 5.1, 5.3 | schließen die verbleibenden Ausfall- und Ablehnungsklassen |
| **C — mittelfristig** | 2.3, 2.6, 3.1, 3.2 | heben die *inhaltliche* Qualität der KI-Nächte |
| **D — wenn Zeit ist** | 3.3, 4.2, 5.2, 6.1 | Politur und Komfort |
