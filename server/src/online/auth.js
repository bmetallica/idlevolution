// GitHub Device Flow (M0 der Multiplayer-Roadmap, docs/roadmap-multiplayer.md).
// Kein Client-Secret, keine Callback-URL: Der Server holt einen User-Code,
// der Spieler tippt ihn auf github.com/login/device ein, der Server pollt bis
// GitHub den Token herausgibt. Alle GitHub-Aufrufe passieren serverseitig.

const GH = 'https://github.com';
const API = 'https://api.github.com';
const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

/** Startet den Device Flow → {device_code, user_code, verification_uri, interval, expires_in} */
export async function startDeviceFlow(clientId) {
  const res = await fetch(`${GH}/login/device/code`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ client_id: clientId, scope: 'public_repo' }),
  });
  const d = await res.json();
  if (!d.device_code) throw new Error(`Device Flow fehlgeschlagen: ${d.error_description || d.error || res.status}`);
  return d;
}

/** Fragt EINMAL nach dem Token → {token} | {pending} | {slowDown} | Error bei endgültigem Fehlschlag. */
export async function pollToken(clientId, deviceCode) {
  const res = await fetch(`${GH}/login/oauth/access_token`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({
      client_id: clientId, device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const d = await res.json();
  if (d.access_token) return { token: d.access_token };
  if (d.error === 'authorization_pending') return { pending: true };
  if (d.error === 'slow_down') return { slowDown: true };
  throw new Error(d.error_description || d.error || 'Token-Abruf fehlgeschlagen');
}

/** Liefert den GitHub-Login zum Token (verifiziert den Token gleich mit). */
export async function fetchGithubUser(token) {
  const res = await fetch(`${API}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'idlevolution' },
  });
  if (!res.ok) throw new Error(`GitHub /user: ${res.status}`);
  const d = await res.json();
  return { login: d.login, avatarUrl: d.avatar_url };
}

// ── Einstellungen (eine Zeile in online_settings) ──
export async function loadOnline(pool) {
  const { rows } = await pool.query('SELECT data FROM online_settings WHERE id = 1');
  return rows[0]?.data || {};
}
export async function saveOnline(pool, data) {
  await pool.query(
    `INSERT INTO online_settings (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
    [data]
  );
}
