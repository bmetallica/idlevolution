<script>
  import { onMount, createEventDispatcher } from 'svelte';
  import { fetchAiLog, disablePack } from '../lib/api.js';

  export let packs = [];

  const dispatch = createEventDispatcher();
  let runs = [];
  let loading = true;
  let tab = 'chronik';
  let busy = null;

  onMount(async () => {
    try { runs = await fetchAiLog(); } catch {}
    loading = false;
  });

  // Die Chronik entsteht aus den Packs — gescheiterte Nächte hinterließen dort
  // eine unsichtbare Lücke (fünf verlorene Nächte fielen erst beim Log-Lesen auf).
  // Deshalb werden Fehlschläge als eigener Eintrag eingemischt.
  $: chronicle = [
    ...packs.filter((p) => p.chronicle?.de).map((p) => ({ id: p.id, date: p.createdAt, text: p.chronicle.de, failed: false })),
    ...runs
      .filter((r) => r.status === 'error')
      .map((r) => ({
        id: `run-${r.id}`,
        date: r.started_at,
        text: 'Die Baumeister ruhten in dieser Nacht — es entstanden keine neuen Pläne.',
        failed: true,
        error: r.error,
      })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  // Archiv: nach Monaten gruppiert, damit die Geschichte der Insel auch nach
  // Monaten noch durchblätterbar bleibt statt zu einer endlosen Liste zu werden.
  $: chronicleMonths = (() => {
    const out = [];
    for (const e of chronicle) {
      const d = new Date(e.date);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      let g = out[out.length - 1];
      if (!g || g.key !== key) {
        g = { key, label: d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }), entries: [] };
        out.push(g);
      }
      g.entries.push(e);
    }
    return out;
  })();
  $: aiPacks = packs.filter((p) => p.source === 'ai').slice().reverse();

  // C4: Nightly-Telemetrie — Akzeptanz-Quote, letzter Lauf, Clamp-Notizen.
  // Macht auch einen still gestorbenen ai-worker sofort sichtbar (> 26 h kein Lauf).
  $: telemetry = (() => {
    if (!runs.length) return null;
    const ageH = (Date.now() - new Date(runs[0].started_at).getTime()) / 3600000;
    const ok = runs.filter((r) => r.status === 'accepted' || r.status === 'partial').length;
    const clamps = runs.flatMap((r) => r.accepted?.notes || []).slice(0, 3);
    // Ein lebendiger Prozess ist noch kein gesunder Lauf: Der Watchdog war in
    // allen fünf Ausfallnächten "healthy". Deshalb zusätzlich das ERGEBNIS
    // bewerten — wann kam zuletzt tatsächlich Inhalt an?
    const lastOk = runs.find((r) => r.status === 'accepted' || r.status === 'partial');
    const okAgeH = lastOk ? (Date.now() - new Date(lastOk.started_at).getTime()) / 3600000 : Infinity;
    // Häufigster Ablehnungsgrund — zeigt, woran die KI systematisch scheitert
    const counts = {};
    for (const r of runs) for (const rej of r.rejected || []) {
      const key = String(rej.reason || rej.type || rej).replace(/'[^']*'/g, "'…'").replace(/\d+/g, 'N');
      counts[key] = (counts[key] || 0) + 1;
    }
    const topReason = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || null;
    return {
      ageH: Math.round(ageH * 10) / 10,
      ok, total: runs.length,
      stale: ageH > 26,
      okAgeH: Math.round(okAgeH),
      starving: okAgeH > 48, // seit über 2 Tagen kein Inhalt — unabhängig vom Prozess
      clamps,
      topReason,
    };
  })();

  const fmt = (d) => { try { return new Date(d).toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const fmtDay = (d) => { try { return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' }); } catch { return ''; } };
  const statusColor = (s) => (s === 'accepted' ? 'text-emerald-300' : s === 'partial' ? 'text-amber-300' : s === 'rejected' ? 'text-red-300' : 'text-stone-400');
  const countAcc = (a) => (a ? (a.buildings?.length || 0) + (a.resources?.length || 0) + (a.epochs?.length || 0) : 0);

  async function onDisable(id) {
    if (busy) return;
    if (!confirm(`Pack „${id}" deaktivieren? Zugehörige Gebäude werden aus der Siedlung entfernt.`)) return;
    busy = id;
    try {
      const r = await disablePack(id);
      dispatch('changed', { msg: `Pack deaktiviert – ${r.removedInstances || 0} Gebäude entfernt`, ok: true });
    } catch (e) {
      dispatch('changed', { msg: e.message, ok: false });
    }
    busy = null;
  }
</script>

<div class="rounded-lg border border-stone-800 bg-stone-900/95 backdrop-blur shadow-xl flex flex-col max-h-[78vh]">
  <div class="flex items-center gap-1 px-2 pt-2">
    {#each [['chronik', '📜 Chronik'], ['runs', '🤖 Läufe'], ['packs', '🧩 Inhalte']] as [key, lbl]}
      <button class="text-xs px-2.5 py-1 rounded-t {tab === key ? 'bg-stone-800 text-amber-200' : 'text-stone-400 hover:text-stone-200'}" on:click={() => (tab = key)}>{lbl}</button>
    {/each}
    <button class="ml-auto text-stone-500 hover:text-stone-200 px-1" on:click={() => dispatch('close')} title="Schließen">✕</button>
  </div>

  <div class="p-3 overflow-y-auto text-sm">
    {#if tab === 'chronik'}
      {#if chronicle.length === 0}
        <p class="text-xs text-stone-600 italic">Noch keine Einträge. Jede Nacht analysiert die KI die Siedlung, erweitert das Spiel und schreibt hier ihren Bericht.</p>
      {:else}
        <div class="text-[10px] text-stone-600 mb-2">
          {chronicle.length} Einträge über {chronicleMonths.length} Monat{chronicleMonths.length === 1 ? '' : 'e'}
        </div>
        <div class="space-y-4">
          {#each chronicleMonths as m (m.key)}
            <section>
              <h3 class="sticky top-0 z-10 -mx-3 px-3 py-1 bg-stone-900/95 backdrop-blur text-[10px] uppercase tracking-widest text-amber-300/70 border-b border-stone-800">
                {m.label} <span class="text-stone-600 normal-case tracking-normal">· {m.entries.length}</span>
              </h3>
              <div class="space-y-3 mt-2">
                {#each m.entries as e (e.id)}
                  <div class="border-l-2 {e.failed ? 'border-stone-700' : 'border-amber-900'} pl-3">
                    <div class="text-[10px] text-stone-600 font-mono">{fmtDay(e.date)}</div>
                    <p class="text-xs {e.failed ? 'text-stone-500 italic' : 'text-stone-300'} leading-relaxed">{e.text}</p>
                    {#if e.failed && e.error}
                      <div class="text-[10px] text-red-400/70 mt-0.5 font-mono">⚠ {e.error}</div>
                    {/if}
                  </div>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {/if}

    {:else if tab === 'runs'}
      {#if loading}
        <p class="text-xs text-stone-500">Lade Protokoll…</p>
      {:else if runs.length === 0}
        <p class="text-xs text-stone-600 italic">Noch keine KI-Läufe protokolliert.</p>
      {:else}
        {#if telemetry}
          <div class="mb-2 rounded border {telemetry.stale || telemetry.starving ? 'border-red-800 bg-red-950/30' : 'border-stone-800 bg-stone-950/60'} px-2 py-1.5 text-[11px]">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="{telemetry.stale ? 'text-red-300' : 'text-stone-300'}">
                {telemetry.stale ? '🔴' : '🟢'} letzter Lauf vor <b>{telemetry.ageH} h</b>
              </span>
              <span class="text-stone-400">· Quote: <b class="{telemetry.ok / telemetry.total >= 0.7 ? 'text-emerald-300' : 'text-amber-300'}">{Math.round((telemetry.ok / telemetry.total) * 100)} %</b> akzeptiert ({telemetry.ok}/{telemetry.total})</span>
            </div>
            {#if telemetry.starving}
              <div class="text-red-300 mt-0.5">
                ⚠ seit <b>{telemetry.okAgeH} h</b> kein Inhalt angekommen — die Läufe starten, liefern aber nichts.
              </div>
            {/if}
            {#if telemetry.stale}
              <div class="text-red-300/90 mt-0.5">ai-worker prüfen: <code>docker compose ps ai-worker</code></div>
            {/if}
            {#if telemetry.topReason}
              <div class="text-stone-500 mt-0.5" title="Woran die KI am häufigsten scheitert">
                ✖ häufigster Ablehnungsgrund ({telemetry.topReason[1]}×): {telemetry.topReason[0]}
              </div>
            {/if}
            {#if telemetry.clamps.length}
              <div class="text-stone-500 mt-0.5" title="Werte, die der Balancer zuletzt gekappt hat">✂ {telemetry.clamps[0]}</div>
            {/if}
          </div>
        {/if}
        <div class="space-y-2">
          {#each runs as r (r.id)}
            <div class="rounded border border-stone-800 bg-stone-950/50 p-2">
              <div class="flex items-center justify-between">
                <span class="text-[10px] text-stone-500 font-mono">{fmt(r.started_at)}</span>
                <span class="text-xs font-semibold {statusColor(r.status)}">{r.status}</span>
              </div>
              {#if r.accepted && countAcc(r.accepted) > 0}
                <div class="text-[11px] text-emerald-300/90 mt-1">
                  + {[...(r.accepted.buildings || []), ...(r.accepted.resources || []), ...(r.accepted.epochs || [])].join(', ')}
                </div>
              {/if}
              {#if r.rejected?.length}
                <ul class="text-[10px] text-red-300/80 mt-1 list-disc list-inside space-y-0.5">
                  {#each r.rejected.slice(0, 4) as rej}<li>{rej.reason || rej.type || rej}</li>{/each}
                  {#if r.rejected.length > 4}<li class="text-stone-500">… {r.rejected.length - 4} weitere</li>{/if}
                </ul>
              {/if}
              {#if r.error}<div class="text-[10px] text-red-400 mt-1">⚠ {r.error}</div>{/if}
            </div>
          {/each}
        </div>
      {/if}

    {:else if tab === 'packs'}
      {#if aiPacks.length === 0}
        <p class="text-xs text-stone-600 italic">Noch keine KI-Inhalte generiert.</p>
      {:else}
        <p class="text-[10px] text-stone-500 mb-2">Ein Pack deaktivieren entfernt seine Inhalte (und zugehörige Gebäude) wieder.</p>
        <div class="space-y-2">
          {#each aiPacks as p (p.id)}
            <div class="rounded border border-stone-800 bg-stone-950/50 p-2 flex items-center gap-2">
              <div class="min-w-0 flex-1">
                <div class="text-[11px] text-stone-300 font-mono truncate">{p.id}</div>
                <div class="text-[10px] text-stone-600">{fmt(p.createdAt)}{#if p.model} · {p.model}{/if}</div>
              </div>
              <button
                class="shrink-0 text-[10px] bg-red-900/60 hover:bg-red-800 border border-red-800 rounded px-2 py-1 text-red-100 disabled:opacity-50"
                on:click={() => onDisable(p.id)}
                disabled={busy === p.id}
              >
                {busy === p.id ? '…' : 'deaktivieren'}
              </button>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
