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
import { configuredProviders } from './llmRouter';

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

/**
 * Recherche via le premier fournisseur configuré qui expose une API de
 * recherche (OmniRoute) et renvoie des résultats. L'URL qui fonctionne est
 * mémorisée ; un endpoint sans recherche n'est retenté qu'au bout de 6 h.
 */
export async function searchWeb(config: OmnirouteConfig, query: string): Promise<SearchResultItem[] | null> {
  const store = await loadSupport();
  for (const provider of configuredProviders(config)) {
    const results = await searchWithProvider(provider, query, store);
    if (results && results.length > 0) return results;
  }
  return null;
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
