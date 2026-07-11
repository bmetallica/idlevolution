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
export const enableAi = () => fetch('/api/players/enable', { method: 'POST' }).then(json);
export const disableAi = (playerId) =>
  fetch('/api/players/disable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId }),
  }).then(json);

export const fetchAiLog = () => fetch('/api/ai-log').then(json);

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
