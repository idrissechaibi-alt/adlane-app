// Recherche web pour les questions sur des faits du jour (score en direct,
// statistiques, résultat final, calendrier).
//
// Un modèle ne cherche sur le web que si la requête le lui demande : un bac à
// sable l'active de lui-même, l'app ne le faisait pas. Deux mécanismes :
// - OmniRoute expose une API de recherche (POST /v1/search) : l'app cherche
//   elle-même et transmet les résultats au modèle, qui répond à partir de
//   données réelles, quel que soit le modèle choisi par la rotation ;
// - FreeLLMAPI active la recherche Google sur les modèles Gemini quand la
//   requête contient l'outil `google_search` (voir llmRouter.callRoute).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { OmnirouteConfig } from '../types';
import { fetchWithTimeout } from './httpTimeout';
import { LlmRoute, callRoute, configuredProviders } from './llmRouter';

const SEARCH_SUPPORT_KEY = '@web_search_support';
const SEARCH_TIMEOUT_MS = 15000;
/** Revérification d'un endpoint qui ne répondait pas à la recherche. */
const UNSUPPORTED_RECHECK_MS = 6 * 3_600_000;
const MAX_CONTEXT_CHARS = 4000;

interface SearchSupport {
  /** URL de recherche qui a fonctionné, ou null si aucune. */
  url: string | null;
  checkedAt: string;
}

let support: Record<string, SearchSupport> | null = null;

async function loadSupport(): Promise<Record<string, SearchSupport>> {
  if (support) return support;
  try {
    const raw = await AsyncStorage.getItem(SEARCH_SUPPORT_KEY);
    support = raw ? JSON.parse(raw) : {};
  } catch {
    support = {};
  }
  return support!;
}

async function saveSupport(): Promise<void> {
  try {
    await AsyncStorage.setItem(SEARCH_SUPPORT_KEY, JSON.stringify(support ?? {}));
  } catch {
    // best-effort
  }
}

function trimEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

/** URLs de recherche possibles d'un endpoint OpenAI-compatible (…/v1). */
function candidateSearchUrls(endpoint: string): string[] {
  const base = trimEndpoint(endpoint);
  const origin = base.replace(/\/v1$/, '');
  return Array.from(new Set([`${base}/search`, `${origin}/api/v1/search`]));
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
}

async function postSearch(url: string, apiKey: string, query: string): Promise<SearchResultItem[] | null> {
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        query: query.slice(0, 500),
        max_results: 6,
        search_type: 'web',
        time_range: 'day',
        content: { snippet: true },
      }),
    },
    SEARCH_TIMEOUT_MS
  );
  if (!response.ok) return null;
  const data = await response.json();
  if (!Array.isArray(data?.results)) return null;
  return data.results
    .map((r: any) => ({
      title: String(r?.title ?? ''),
      url: String(r?.url ?? ''),
      snippet: String(r?.snippet ?? ''),
      publishedAt: r?.published_at ?? null,
    }))
    .filter((r: SearchResultItem) => r.snippet || r.title);
}

async function searchWithProvider(
  provider: { endpoint: string; apiKey: string },
  query: string,
  store: Record<string, SearchSupport>
): Promise<SearchResultItem[] | null> {
  const key = trimEndpoint(provider.endpoint);
  const known = store[key];
  if (known && known.url === null && Date.now() - Date.parse(known.checkedAt) < UNSUPPORTED_RECHECK_MS) return null;

  const urls = known?.url ? [known.url] : candidateSearchUrls(provider.endpoint);
  for (const url of urls) {
    try {
      const results = await postSearch(url, provider.apiKey, query);
      if (results) {
        store[key] = { url, checkedAt: new Date().toISOString() };
        await saveSupport();
        return results;
      }
    } catch {
      // URL suivante
    }
  }
  store[key] = { url: null, checkedAt: new Date().toISOString() };
  await saveSupport();
  return null;
}

// ---------- Recherche Google via un modèle Gemini (FreeLLMAPI) ----------

const GEMINI_MODELS_KEY = '@gemini_search_models';
const GEMINI_MODELS_TTL_MS = 24 * 3_600_000;
const GOOGLE_SEARCH_TOOL = { type: 'function', function: { name: 'google_search', parameters: {} } };

/** Premier modèle Gemini exposé par chaque fournisseur (liste /models, en cache 24 h). */
async function geminiRoutes(config: OmnirouteConfig): Promise<LlmRoute[]> {
  let cache: Record<string, { model: string | null; at: string }> = {};
  try {
    const raw = await AsyncStorage.getItem(GEMINI_MODELS_KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
  let touched = false;
  const routes: LlmRoute[] = [];
  for (const provider of configuredProviders(config)) {
    const key = trimEndpoint(provider.endpoint);
    let entry = cache[key];
    if (!entry || Date.now() - Date.parse(entry.at) > GEMINI_MODELS_TTL_MS) {
      let model: string | null = null;
      try {
        const response = await fetchWithTimeout(
          `${key}/models`,
          { headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {} },
          10000
        );
        if (response.ok) {
          const data = await response.json();
          const ids: string[] = (data.data ?? []).map((m: any) => String(m.id ?? ''));
          model = ids.find((id) => /gemini/i.test(id) && /flash/i.test(id)) ?? ids.find((id) => /gemini/i.test(id)) ?? null;
        }
      } catch {
        model = null;
      }
      entry = { model, at: new Date().toISOString() };
      cache[key] = entry;
      touched = true;
    }
    if (entry.model) routes.push({ providerName: provider.name, endpoint: key, apiKey: provider.apiKey, model: entry.model });
  }
  if (touched) {
    try {
      await AsyncStorage.setItem(GEMINI_MODELS_KEY, JSON.stringify(cache));
    } catch {
      // best-effort
    }
  }
  return routes;
}

/** Recherche Google native de Gemini (outil google_search de FreeLLMAPI). */
async function geminiGroundedSearch(config: OmnirouteConfig, query: string): Promise<SearchResultItem[] | null> {
  for (const route of await geminiRoutes(config)) {
    try {
      const content = await callRoute(
        route,
        'Tu fais une recherche Google et tu rapportes uniquement ce que tu trouves, avec les sources. Aucune invention.',
        `Recherche sur le web : ${query}\nDonne les faits trouvés (chiffres, scores, minutes, horaires), en citant les sources.`,
        30000,
        [GOOGLE_SEARCH_TOOL]
      );
      if (content.trim()) return [{ title: `Recherche Google (${route.model})`, url: '', snippet: content.slice(0, 3000) }];
    } catch {
      // fournisseur suivant
    }
  }
  return null;
}

// ---------- Secours gratuit sans clé : DuckDuckGo ----------

function decodeHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function duckDuckGoSearch(query: string): Promise<SearchResultItem[] | null> {
  try {
    const response = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' } },
      SEARCH_TIMEOUT_MS
    );
    if (!response.ok) return null;
    const html = await response.text();
    const results: SearchResultItem[] = [];
    const blocks = html.split('class="result__body"').slice(1);
    for (const block of blocks.slice(0, 6)) {
      const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      if (!link) continue;
      let url = link[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      results.push({ title: decodeHtml(link[2]), url, snippet: snippet ? decodeHtml(snippet[1]) : '' });
    }
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

/**
 * Recherche web, sources essayées dans l'ordre : API de recherche OmniRoute,
 * recherche Google de Gemini (FreeLLMAPI), puis DuckDuckGo (gratuit, sans
 * clé). Indépendante du modèle qui répondra ensuite : c'est ce qui donne
 * internet à TOUS les modèles.
 */
export async function searchWeb(config: OmnirouteConfig, query: string): Promise<SearchResultItem[] | null> {
  const store = await loadSupport();
  for (const provider of configuredProviders(config)) {
    const results = await searchWithProvider(provider, query, store);
    if (results && results.length > 0) {
      await recordSearchSource(`recherche ${provider.name}`);
      return results;
    }
  }
  const gemini = await geminiGroundedSearch(config, query);
  if (gemini) {
    await recordSearchSource('Google via Gemini (FreeLLMAPI)');
    return gemini;
  }
  const ddg = await duckDuckGoSearch(query);
  if (ddg) await recordSearchSource('DuckDuckGo');
  return ddg;
}

const LAST_SEARCH_SOURCE_KEY = '@last_search_source';

async function recordSearchSource(source: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_SEARCH_SOURCE_KEY, JSON.stringify({ source, at: new Date().toISOString() }));
  } catch {
    // best-effort
  }
}

/** Dernière source de recherche qui a renvoyé des résultats (moins de 24 h), ou null. */
export async function getRecentSearchSource(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_SEARCH_SOURCE_KEY);
    const entry = raw ? JSON.parse(raw) : null;
    if (!entry || Date.now() - Date.parse(entry.at) > 24 * 3_600_000) return null;
    return entry.source;
  } catch {
    return null;
  }
}

/** Lance une recherche de test et renvoie la source qui a répondu, ou null. */
export async function probeAnySearch(config: OmnirouteConfig): Promise<string | null> {
  const results = await searchWeb(config, 'football live scores today').catch(() => null);
  return results ? getRecentSearchSource() : null;
}

/** Contenu texte d'une page web : lecture OmniRoute (/v1/web/fetch), sinon Jina Reader. */
export async function fetchPage(config: OmnirouteConfig, url: string): Promise<string | null> {
  for (const provider of configuredProviders(config)) {
    const base = trimEndpoint(provider.endpoint);
    const origin = base.replace(/\/v1$/, '');
    for (const fetchUrl of [`${base}/web/fetch`, `${origin}/api/v1/web/fetch`]) {
      try {
        const response = await fetchWithTimeout(
          fetchUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
            },
            body: JSON.stringify({ url, format: 'markdown' }),
          },
          SEARCH_TIMEOUT_MS
        );
        if (!response.ok) continue;
        const data = await response.json();
        const text = [data?.content, data?.markdown, data?.text, data?.data?.content, data?.data?.markdown].find(
          (v) => typeof v === 'string' && v.trim()
        );
        if (text) return text.slice(0, 8000);
      } catch {
        // URL suivante
      }
    }
  }
  try {
    const response = await fetchWithTimeout(`https://r.jina.ai/${url}`, {}, SEARCH_TIMEOUT_MS);
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim() ? text.slice(0, 8000) : null;
  } catch {
    return null;
  }
}

/** Résultats de recherche mis en forme pour être transmis à un modèle. */
export function formatSearchContext(query: string, results: SearchResultItem[]): string {
  const lines = [
    `Résultats d'une recherche web faite à l'instant (${new Date().toISOString()}) pour « ${query} » :`,
    ...results.map(
      (r, i) => `${i + 1}. ${r.title}${r.publishedAt ? ` (${r.publishedAt})` : ''} — ${r.snippet} [${r.url}]`
    ),
  ];
  return lines.join('\n').slice(0, MAX_CONTEXT_CHARS);
}

/** Endpoints configurés dont l'API de recherche a déjà fonctionné. */
export async function getWorkingSearchProviders(config: OmnirouteConfig): Promise<string[]> {
  const store = await loadSupport();
  return configuredProviders(config)
    .filter((p) => Boolean(store[trimEndpoint(p.endpoint)]?.url))
    .map((p) => p.name);
}

/** Teste tout de suite la recherche de chaque fournisseur (bouton, diagnostic). */
export async function probeSearchProviders(config: OmnirouteConfig): Promise<string[]> {
  const store = await loadSupport();
  for (const provider of configuredProviders(config)) {
    delete store[trimEndpoint(provider.endpoint)];
    await searchWithProvider(provider, 'football live scores today', store);
  }
  return getWorkingSearchProviders(config);
}
