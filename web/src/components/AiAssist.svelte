<script>
  import { createEventDispatcher, tick } from 'svelte';
  import { askAssist } from '../lib/api.js';

  const dispatch = createEventDispatcher();
  let question = '';
  let messages = []; // { role: 'user'|'ai'|'error', text }
  let busy = false;
  let scroller;

  const suggestions = [
    'Warum verliere ich gerade Bevölkerung?',
    'Was sollte ich als Nächstes bauen?',
    'Wie erreiche ich die nächste Epoche?',
    'Wo fehlen mir Arbeiter?',
  ];

  async function send(q) {
    const text = (q ?? question).trim();
    if (!text || busy) return;
    messages = [...messages, { role: 'user', text }];
    question = '';
    busy = true;
    await scrollDown();
    try {
      const r = await askAssist(text);
      messages = [...messages, { role: 'ai', text: r.answer || '(keine Antwort erhalten)' }];
    } catch (e) {
      messages = [...messages, { role: 'error', text: e.message }];
    }
    busy = false;
    await scrollDown();
  }
  async function scrollDown() { await tick(); if (scroller) scroller.scrollTop = scroller.scrollHeight; }
  function onKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
</script>

<div class="rounded-lg border border-indigo-800 bg-stone-900/95 backdrop-blur shadow-xl flex flex-col max-h-[70vh]">
  <div class="flex items-center gap-2 px-3 py-2 border-b border-stone-800">
    <span class="text-sm font-semibold text-indigo-200">🧑‍🏫 Berater</span>
    <span class="text-[10px] text-stone-500">fragt die lokale KI zu deinem Spielstand</span>
    <button class="ml-auto text-stone-500 hover:text-stone-200" on:click={() => dispatch('close')} title="Schließen">✕</button>
  </div>

  <div class="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-sm" bind:this={scroller}>
    {#if messages.length === 0}
      <p class="text-xs text-stone-500">Stelle eine Frage zu deiner Siedlung — die KI antwortet anhand der aktuellen Spieldaten.</p>
      <div class="flex flex-col gap-1.5 mt-2">
        {#each suggestions as s}
          <button class="text-left text-xs text-indigo-300 bg-stone-800/70 hover:bg-stone-800 border border-stone-700 rounded px-2 py-1.5" on:click={() => send(s)}>{s}</button>
        {/each}
      </div>
    {/if}
    {#each messages as m}
      {#if m.role === 'user'}
        <div class="flex justify-end"><div class="bg-indigo-800/70 text-indigo-50 rounded-lg rounded-br-sm px-3 py-1.5 max-w-[85%]">{m.text}</div></div>
      {:else if m.role === 'ai'}
        <div class="flex justify-start"><div class="bg-stone-800 text-stone-200 rounded-lg rounded-bl-sm px-3 py-1.5 max-w-[90%] leading-relaxed whitespace-pre-wrap">{m.text}</div></div>
      {:else}
        <div class="text-xs text-red-300">⚠ {m.text}</div>
      {/if}
    {/each}
    {#if busy}<div class="text-xs text-stone-500 animate-pulse">Berater denkt nach…</div>{/if}
  </div>

  <div class="p-2 border-t border-stone-800 flex gap-2">
    <textarea
      class="flex-1 resize-none bg-stone-950 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-100 focus:border-indigo-600 outline-none"
      rows="1"
      placeholder="Frage stellen… (Enter senden)"
      bind:value={question}
      on:keydown={onKey}
      disabled={busy}
    ></textarea>
    <button
      class="shrink-0 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded px-3 text-sm text-white"
      on:click={() => send()}
      disabled={busy || !question.trim()}
    >Senden</button>
  </div>
</div>
