// GitHub-Schreibpfad für den Insel-Upload (M1): Fork sicherstellen → Branch
// auf den Stand von central/main setzen → Dateien committen → PR öffnen.
// Die validierende Action im zentralen Repo merged automatisch.

const API = 'https://api.github.com';

async function gh(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'idlevolution', ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(d.message || `GitHub ${method} ${path}: ${res.status}`); err.status = res.status; throw err; }
  return d;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lädt Dateien als PR ins zentrale Repo hoch.
 * @param files [{path, content}] — Inhalte als Strings
 * @returns {prUrl}
 */
export async function publishFiles(token, user, centralRepo, files) {
  const [cOwner, cName] = centralRepo.split('/');
  const own = user === cOwner; // Repo-Inhaber pusht direkt (eigenes Repo forken geht nicht)
  const writeRepo = own ? centralRepo : `${user}/${cName}`;
  const branch = `island-${user.toLowerCase()}`;

  if (!own) {
    // Fork sicherstellen (idempotent, Anlage ist asynchron) und mit upstream synchen
    await gh(token, 'POST', `/repos/${centralRepo}/forks`, {}).catch((e) => { if (e.status !== 202) throw e; });
    for (let i = 0; i < 10; i++) {
      try { await gh(token, 'GET', `/repos/${writeRepo}`); break; }
      catch { await sleep(2000); if (i === 9) throw new Error('Fork wurde nicht rechtzeitig erstellt'); }
    }
    await gh(token, 'POST', `/repos/${writeRepo}/merge-upstream`, { branch: 'main' }).catch(() => {});
  }

  // Branch exakt auf central/main (bzw. Fork-main nach Sync) setzen
  const baseSha = (await gh(token, 'GET', `/repos/${writeRepo}/git/ref/heads/main`)).object.sha;
  try {
    await gh(token, 'POST', `/repos/${writeRepo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch {
    await gh(token, 'PATCH', `/repos/${writeRepo}/git/refs/heads/${branch}`, { sha: baseSha, force: true });
  }

  // Dateien committen (Contents-API; bei bestehender Datei ist deren sha nötig)
  for (const f of files) {
    const cur = await gh(token, 'GET', `/repos/${writeRepo}/contents/${f.path}?ref=${branch}`).catch(() => null);
    await gh(token, 'PUT', `/repos/${writeRepo}/contents/${f.path}`, {
      message: `Insel-Update: ${user}`, content: b64(f.content), branch,
      ...(cur?.sha ? { sha: cur.sha } : {}),
    });
  }

  // PR öffnen (existiert schon einer für den Branch, wird er durch die Commits aktualisiert)
  const head = own ? branch : `${user}:${branch}`;
  try {
    const pr = await gh(token, 'POST', `/repos/${centralRepo}/pulls`, {
      title: `Insel: ${user}`, head, base: 'main',
      body: 'Automatischer Insel-Upload aus Idlevolution.',
    });
    return { prUrl: pr.html_url };
  } catch (e) {
    const list = await gh(token, 'GET', `/repos/${centralRepo}/pulls?state=open&head=${own ? cOwner : user}:${branch}`).catch(() => []);
    if (list?.[0]) return { prUrl: list[0].html_url };
    throw e;
  }
}
