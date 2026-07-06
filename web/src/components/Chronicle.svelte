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

  $: chronicle = packs.filter((p) => p.chronicle?.de).map((p) => ({ id: p.id, date: p.createdAt, text: p.chronicle.de })).reverse();
  $: aiPacks = packs.filter((p) => p.source === 'ai').slice().reverse();

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
        <div class="space-y-3">
          {#each chronicle as e (e.id)}
            <div class="border-l-2 border-amber-900 pl-3">
              <div class="text-[10px] text-stone-600 font-mono">{fmtDay(e.date)}</div>
              <p class="text-xs text-stone-300 leading-relaxed">{e.text}</p>
            </div>
          {/each}
        </div>
      {/if}

    {:else if tab === 'runs'}
      {#if loading}
        <p class="text-xs text-stone-500">Lade Protokoll…</p>
      {:else if runs.length === 0}
        <p class="text-xs text-stone-600 italic">Noch keine KI-Läufe protokolliert.</p>
      {:else}
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
