async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const fetchContent = () => fetch('/api/content').then(json);
export const fetchState = () => fetch('/api/state').then(json);
export const fetchMap = () => fetch('/api/map').then(json);

export const build = (buildingId, x, y, rot = 0) =>
  fetch('/api/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buildingId, x, y, rot }),
  }).then(json);

export const demolishInstance = (instanceId) =>
  fetch('/api/demolish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId }),
  }).then(json);

export const setWorkers = (buildingId, delta) =>
  fetch('/api/workers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buildingId, delta }),
  }).then(json);

export const setRoad = (tiles, on) =>
  fetch('/api/road', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tiles, on }),
  }).then(json);

export const setDeco = (tiles, type, on) =>
  fetch('/api/deco', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tiles, type, on }),
  }).then(json);

export const askAssist = (question) =>
  fetch('/api/assist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  }).then(json);

export const fetchPlayers = () => fetch('/api/players').then(json);
export const sendShip = (toIsland, resourceId, amount) =>
  fetch('/api/ship', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toIsland, resourceId, amount }),
  }).then(json);
export const attack = (targetIsland, soldiers) =>
  fetch('/api/attack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetIsland, soldiers }),
  }).then(json);
export const enableAi = () => fetch('/api/players/enable', { method: 'POST' }).then(json);
export const disableAi = (playerId) =>
  fetch('/api/players/disable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId }),
  }).then(json);

export const fetchMarket = () => fetch('/api/market').then(json);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(json);
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packId }),
  }).then(json);

export const rotateInstance = (instanceId) =>
  fetch('/api/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId }),
  }).then(json);
