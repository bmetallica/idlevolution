<script>
  // Online-Modus (M0): GitHub-Verbindung per Device Flow + Disclaimer.
  // Sitzt unten im 🌍-Nachbarn-Panel. Der Token bleibt immer auf dem Server.
  import { onMount, onDestroy } from 'svelte';
  import { onlineStatus, onlineConnect, onlineDisconnect, onlineAcceptDisclaimer, onlinePublish } from '../lib/api.js';

  let st = null; // /api/online/status
  let busy = false;
  let showDisclaimer = false;
  let timer = 0;
  let publishMsg = null; // { ok, text }

  async function refresh() {
    try { st = await onlineStatus(); } catch {}
    // Während der Code-Eingabe schneller pollen, sonst gar nicht
    clearTimeout(timer);
    if (st?.pending) timer = setTimeout(refresh, 3000);
  }
  async function connect() {
    if (busy) return; busy = true;
    try { await onlineConnect(); await refresh(); } catch {}
    busy = false;
  }
  async function disconnect() {
    if (busy) return; busy = true;
    try { await onlineDisconnect(); await refresh(); } catch {}
    busy = false;
  }
  async function acceptDisclaimer() {
    if (busy) return; busy = true;
    try { await onlineAcceptDisclaimer(); showDisclaimer = false; await refresh(); } catch {}
    busy = false;
  }
  async function publish() {
    if (busy) return; busy = true; publishMsg = null;
    try {
      const r = await onlinePublish();
      publishMsg = r.ok
        ? { ok: true, text: `✓ Hochgeladen (${r.instances} Gebäude) — die Prüfung im Repo merged automatisch.` }
        : { ok: false, text: r.error || 'Fehlgeschlagen' };
      await refresh();
    } catch (e) { publishMsg = { ok: false, text: e.message }; }
    busy = false;
  }

  onMount(refresh);
  onDestroy(() => clearTimeout(timer));
</script>

<div class="mt-2.5 pt-2 border-t border-stone-800">
  <div class="text-[11px] text-stone-400 mb-1">🌐 Online-Modus <span class="text-stone-600">(Beta)</span></div>

  {#if !st}
    <p class="text-[11px] text-stone-500">Lade…</p>
  {:else if st.connected}
    <div class="flex items-center gap-2 text-sm">
      {#if st.avatarUrl}<img src={st.avatarUrl} alt="" class="w-5 h-5 rounded-full" />{/if}
      <span class="text-stone-200">{st.username}</span>
      <button class="ml-auto text-[11px] text-stone-500 hover:text-red-300" on:click={disconnect} disabled={busy}>trennen</button>
    </div>
    {#if st.disclaimerAccepted}
      <button class="mt-1.5 w-full rounded bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 px-3 py-1.5 text-sm text-white" on:click={publish} disabled={busy}>
        {busy ? '⏳ Lade hoch…' : '🏝️ Insel jetzt veröffentlichen'}
      </button>
      {#if publishMsg}
        <p class="mt-1 text-[11px] {publishMsg.ok ? 'text-emerald-400/90' : 'text-red-400'}">{publishMsg.text}</p>
      {/if}
      {#if st.lastPublish}
        <p class="mt-0.5 text-[11px] text-stone-500">
          Zuletzt: {new Date(st.lastPublish.at).toLocaleString('de-DE')} · {st.lastPublish.instances} Gebäude
          {#if st.lastPublish.prUrl}· <a class="text-sky-400 underline" href={st.lastPublish.prUrl} target="_blank" rel="noopener noreferrer">PR</a>{/if}
        </p>
      {/if}
    {:else}
      <button class="mt-1.5 w-full rounded bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 px-3 py-1.5 text-sm text-white" on:click={() => (showDisclaimer = true)} disabled={busy}>
        🏝️ Insel online freigeben…
      </button>
    {/if}
  {:else if st.pending}
    <div class="rounded border border-sky-800 bg-sky-950/40 px-2 py-2 text-center">
      <div class="text-[11px] text-stone-400">Diesen Code auf GitHub eingeben:</div>
      <div class="font-mono text-lg tracking-widest text-sky-200 my-1 select-all">{st.pending.userCode}</div>
      <a class="text-[11px] text-sky-400 underline" href={st.pending.verificationUri} target="_blank" rel="noopener noreferrer">{st.pending.verificationUri}</a>
      <div class="text-[11px] text-stone-500 mt-1 animate-pulse">Warte auf Bestätigung…</div>
    </div>
  {:else}
    {#if st.error}<p class="text-[11px] text-red-400 mb-1">⚠ {st.error}</p>{/if}
    <button class="w-full rounded bg-stone-800 hover:bg-stone-700 border border-stone-600 disabled:opacity-50 px-3 py-1.5 text-sm text-stone-100" on:click={connect} disabled={busy}>
      🐙 Mit GitHub verbinden
    </button>
    <p class="mt-1 text-[11px] text-stone-600">Optional: Insel veröffentlichen, Nachbarn besuchen, handeln.</p>
  {/if}
</div>

<!-- Disclaimer: Pflicht-Dialog vor der ersten Freigabe -->
{#if showDisclaimer}
  <div class="fixed inset-0 z-[110] bg-black/70 grid place-items-center p-4">
    <div class="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-lg border border-amber-700 bg-stone-900 shadow-2xl p-4">
      <h3 class="text-sm font-semibold text-amber-200">🌐 Insel online freigeben — auf eigene Gefahr</h3>
      <div class="mt-2 space-y-2 text-xs text-stone-300 leading-relaxed">
        <p>Du bist dabei, deine Insel im öffentlichen Community-Repository <b>{st?.repo}</b> auf GitHub zu veröffentlichen. Damit gilt:</p>
        <ul class="list-disc pl-4 space-y-1.5">
          <li>Dein <b>GitHub-Name</b>, deine Insel (Karte, Gebäude, Epoche, Chronik) und deine KI-generierten Inhalte werden <b>öffentlich</b> sichtbar und über die Git-Historie dauerhaft nachvollziehbar.</li>
          <li>Der Online-Modus lädt <b>Inhalte fremder Spieler</b> auf deinen Rechner. Sie werden automatisiert geprüft, eine Prüfung durch Menschen findet <b>nicht</b> statt. <b>Es wird keine Gewähr für Fremdinhalte übernommen.</b></li>
          <li>Die Nutzung erfolgt <b>auf eigene Gefahr</b>. Für Schäden jeglicher Art — insbesondere durch heruntergeladene Inhalte, Datenverlust oder Fehlverhalten Dritter — wird <b>keine Haftung</b> übernommen, soweit gesetzlich zulässig.</li>
          <li>Es besteht kein Anspruch auf Verfügbarkeit des Dienstes. Es gelten zusätzlich die Nutzungsbedingungen von GitHub.</li>
          <li>Du kannst deine Freigabe jederzeit beenden („Offline gehen" entfernt deine Daten aus dem Repository; Kopien in der Git-Historie und bei anderen Spielern können bestehen bleiben).</li>
        </ul>
      </div>
      <div class="flex gap-2 mt-4">
        <button class="flex-1 rounded bg-stone-800 hover:bg-stone-700 px-3 py-2 text-sm text-stone-200" on:click={() => (showDisclaimer = false)}>Abbrechen</button>
        <button class="flex-1 rounded bg-emerald-700 hover:bg-emerald-600 px-3 py-2 text-sm text-white" on:click={acceptDisclaimer} disabled={busy}>Ich verstehe und stimme zu</button>
      </div>
    </div>
  </div>
{/if}
