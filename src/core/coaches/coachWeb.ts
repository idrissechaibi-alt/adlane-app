// Sources web d'un match pour l'entraîneur de la ligue : recherche Google (Gemini) si la clé est liée, Perplexity si configuré et sous
// son quota, et la recherche web de l'app (OmniRoute / Google via Gemini / DuckDuckGo). Tout est facultatif : une source muette
// ne bloque jamais l'avis. Ce que le web rapporte reste secondaire face aux compositions officielles et aux données du dossier.

import * as SecureStore from 'expo-secure-store';
import type { OmnirouteConfig } from '../../types';
import { fetchGoogleSearchContext } from '../gemini';
import { fetchMatchContext } from '../perplexity';
import { searchWeb, formatSearchContext } from '../webSearch';
import { getAPIConfig, getQuotaUsage, incrementRequestCount } from '../../api/multiAPIManager';

const GEMINI_KEY_STORAGE = 'app-adlane.gemini-api-key';
const TTL_MS = 20 * 60_000;
const MAX_TEXT = 5000;
const MAX_SOURCES = 12;

export interface WebSource {
  title: string;
  url: string;
}

export interface MatchWebContext {
  text: string;
  sources: WebSource[];
  /** Moteurs de recherche qui ont répondu. */
  engines: string[];
}

const cache = new Map<string, { at: number; ctx: MatchWebContext }>();

const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> => new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); }); });

/** Recherches web sur le match (20 minutes de cache). Contexte vide si aucune source n'a répondu. */
export async function gatherMatchWebContext(homeTeam: string, awayTeam: string, config: OmnirouteConfig): Promise<MatchWebContext> {
  const key = `${homeTeam}|${awayTeam}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ctx;

  const parts: string[] = [];
  const sources: WebSource[] = [];
  const engines: string[] = [];

  const geminiKey = await SecureStore.getItemAsync(GEMINI_KEY_STORAGE).catch(() => null);
  const apiConfig = await getAPIConfig().catch(() => null);
  let perplexityOk = false;
  if (apiConfig?.perplexity) {
    const quota = await getQuotaUsage('perplexity', apiConfig).catch(() => null);
    perplexityOk = !quota || quota.used < quota.limit;
  }

  const [google, perplexity, general, preview] = await Promise.all([
    geminiKey ? within(fetchGoogleSearchContext(homeTeam, awayTeam, geminiKey), 30_000) : Promise.resolve(null),
    perplexityOk && apiConfig ? within(fetchMatchContext(homeTeam, awayTeam, apiConfig.perplexity).then((r) => { void incrementRequestCount('perplexity'); return r; }), 25_000) : Promise.resolve(null),
    within(searchWeb(config, `${homeTeam} ${awayTeam} avant-match analyse tactique compositions probables blessés suspendus`), 25_000),
    within(searchWeb(config, `${homeTeam} vs ${awayTeam} match preview team news injuries`), 25_000),
  ]);

  if (google?.contextText) {
    parts.push(`Recherche Google (Gemini) :\n${google.contextText}`);
    sources.push(...google.sources.map((s) => ({ title: s.title, url: s.url })));
    engines.push('Google (Gemini)');
  }
  if (perplexity?.contextText) {
    parts.push(`Recherche Perplexity :\n${perplexity.contextText}`);
    sources.push(...perplexity.sources.map((s) => ({ title: s.title, url: s.url })));
    engines.push('Perplexity');
  }
  for (const [label, results] of [[`${homeTeam} ${awayTeam} analyse`, general], [`${homeTeam} vs ${awayTeam} preview`, preview]] as const) {
    if (results?.length) {
      parts.push(formatSearchContext(label, results.slice(0, 5)));
      sources.push(...results.slice(0, 5).map((r) => ({ title: r.title, url: r.url })));
      if (!engines.includes('Recherche web de l\'app')) engines.push('Recherche web de l\'app');
    }
  }

  const seen = new Set<string>();
  const unique = sources.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, MAX_SOURCES);
  const ctx: MatchWebContext = { text: parts.join('\n\n').slice(0, MAX_TEXT), sources: unique, engines };
  // Un résultat vide n'est pas gardé longtemps : la recherche est retentée au prochain passage.
  cache.set(key, { at: ctx.text ? Date.now() : Date.now() - TTL_MS + 3 * 60_000, ctx });
  if (cache.size > 60) cache.delete(cache.keys().next().value as string);
  return ctx;
}
