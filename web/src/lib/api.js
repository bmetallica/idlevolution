async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// E: Optionaler GAME_TOKEN — ist der Server damit gestartet, hinterlegt man den
// Token einmalig via localStorage.setItem('gameToken', '…'); alle Schreib-Calls
// senden ihn dann als x-game-token mit. Ohne Token-Betrieb: kein Header, alles frei.
function headers() {
  const h = { 'content-type': 'application/json' };
  try { const t = localStorage.getItem('gameToken'); if (t) h['x-game-token'] = t; } catch {}
  return h;
}

export const fetchContent = () => fetch('/api/content').then(json);
export const fetchState = () => fetch('/api/state').then(json);
export const fetchFrame = () => fetch('/api/frame').then(json); // state + players gebündelt
export const fetchMap = () => fetch('/api/map').then(json);

export const build = (buildingId, x, y, rot = 0) =>
  fetch('/api/build', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ buildingId, x, y, rot }),
  }).then(json);

export const demolishInstance = (instanceId) =>
  fetch('/api/demolish', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ instanceId }),
  }).then(json);

export const setWorkers = (buildingId, delta) =>
  fetch('/api/workers', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ buildingId, delta }),
  }).then(json);

export const setRoad = (tiles, on) =>
  fetch('/api/road', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ tiles, on }),
  }).then(json);

export const setDeco = (tiles, type, on) =>
  fetch('/api/deco', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ tiles, type, on }),
  }).then(json);

export const askAssist = (question) =>
  fetch('/api/assist', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ question }),
  }).then(json);

// E: Berater-Streaming (SSE) — ruft onToken je Textstück; wirft bei Fehler-Event.
export async function askAssistStream(question, onToken) {
  const res = await fetch('/api/assist/stream', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ question }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let j = null;
      try { j = JSON.parse(data); } catch { continue; }
      if (j?.error) throw new Error(j.error);
      if (j?.t) onToken(j.t);
    }
  }
}

export const fetchPlayers = () => fetch('/api/players').then(json);
export const sendShip = (toIsland, resourceId, amount) =>
  fetch('/api/ship', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ toIsland, resourceId, amount }),
  }).then(json);
export const attack = (targetIsland, soldiers) =>
  fetch('/api/attack', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ targetIsland, soldiers }),
  }).then(json);
export const cancelAttack = (targetPlayer) =>
  fetch('/api/attack/cancel', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ targetPlayer }),
  }).then(json);
export const enableAi = () => post('/api/players/enable');
export const disableAi = (playerId) =>
  fetch('/api/players/disable', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ playerId }),
  }).then(json);

export const fetchMarket = () => fetch('/api/market').then(json);
const post = (url, body) => fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) }).then(json);
export const createOffer = (giveRes, giveAmt, wantRes, wantAmt) => post('/api/market/offer', { giveRes, giveAmt, wantRes, wantAmt });
export const acceptOffer = (offerId) => post('/api/market/accept', { offerId });
export const cancelOffer = (offerId) => post('/api/market/cancel', { offerId });

export const fetchAiLog = () => fetch('/api/ai-log').then(json);

// Online-Modus (Multiplayer über GitHub)
export const onlineStatus = () => fetch('/api/online/status').then(json);
export const onlineConnect = () => post('/api/online/connect');
export const onlineDisconnect = () => post('/api/online/disconnect');
export const onlineAcceptDisclaimer = () => post('/api/online/disclaimer');
export const onlinePublish = () => post('/api/online/publish');
export const onlineSync = () => post('/api/online/sync');
export const onlineNeighbors = () => fetch('/api/online/neighbors').then(json);
export const onlineIsland = (owner) => fetch(`/api/online/island/${encodeURIComponent(owner)}`).then(json);
export const onlineAdopt = (owner) => post('/api/online/adopt', { owner });
export const onlinePreview = () => fetch('/api/online/preview').then(json);
export const onlineUnpublish = () => post('/api/online/unpublish');
export const onlineTrade = () => fetch('/api/online/trade').then(json);
export const onlineTradeOffer = (giveRes, giveAmt, wantRes, wantAmt) => post('/api/online/trade/offer', { giveRes, giveAmt, wantRes, wantAmt });
export const onlineTradeCancel = (offerId) => post('/api/online/trade/cancel', { offerId });
export const onlineTradeAccept = (offerOwner, offerId) => post('/api/online/trade/accept', { offerOwner, offerId });

export const disablePack = (packId) =>
  fetch('/api/pack/disable', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ packId }),
  }).then(json);

export const rotateInstance = (instanceId) =>
  fetch('/api/rotate', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ instanceId }),
  }).then(json);

export const advanceEpoch = () => post('/api/advance');
export const autoWorkers = () => post('/api/workers/auto');
export const claimQuest = (questId) => post('/api/quests/claim', { questId });
export const generateQuests = () => post('/api/quests/generate');

export const moveInstance = (instanceId, x, y) =>
  fetch('/api/move', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ instanceId, x, y }),
  }).then(json);
