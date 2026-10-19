// Accès au dépôt GitHub pour le serveur (restauration, battement de cœur, boîte de réception du téléphone).
// Mêmes réglages et même jeton que la sauvegarde de l'app (src/core/gitAutoSync.ts).
import { getGitHubSyncConfig, getGitHubToken } from '../src/core/gitAutoSync';

async function ctx() {
  const config = await getGitHubSyncConfig();
  const token = await getGitHubToken();
  if (!token) throw new Error('jeton GitHub absent : importe la configuration du téléphone (voir server/README.md)');
  return { config, token, base: `https://api.github.com/repos/${config.repoOwner}/${config.repoName}/contents` };
}

const headers = (token: string, raw = false) => ({
  Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
});

async function call(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function repoText(path: string): Promise<string | null> {
  const { config, token, base } = await ctx();
  const r = await call(`${base}/${path}?ref=${encodeURIComponent(config.branch)}`, { headers: headers(token, true) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} sur ${path}`);
  return r.text();
}

export async function repoList(dir: string): Promise<Array<{ name: string; path: string; sha: string; type: string }>> {
  const { config, token, base } = await ctx();
  const r = await call(`${base}/${dir}?ref=${encodeURIComponent(config.branch)}`, { headers: headers(token) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`GitHub ${r.status} sur ${dir}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

async function shaOf(path: string): Promise<string | null> {
  const { config, token, base } = await ctx();
  const r = await call(`${base}/${path}?ref=${encodeURIComponent(config.branch)}`, { headers: headers(token) });
  if (!r.ok) return null;
  return (await r.json())?.sha ?? null;
}

export async function repoPut(path: string, text: string, message: string): Promise<boolean> {
  const { config, token, base } = await ctx();
  for (let attempt = 0; attempt < 3; attempt++) {
    const sha = await shaOf(path);
    const r = await call(`${base}/${path}`, {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: config.branch, message, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha ? { sha } : {}) }),
    });
    if (r.ok) return true;
    if (r.status !== 409 && r.status !== 422) return false;
  }
  return false;
}

export async function repoDelete(path: string, sha: string, message: string): Promise<boolean> {
  const { config, token, base } = await ctx();
  const r = await call(`${base}/${path}`, {
    method: 'DELETE',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: config.branch, message, sha }),
  });
  return r.ok;
}
