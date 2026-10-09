// Routeur multi-fournisseurs pour toutes les requêtes IA (compatibles OpenAI).
//
// Fournisseurs : le principal (FreeLLMAPI/Omniroute, Paramètres), les
// fournisseurs supplémentaires ajoutés dans Paramètres, et le pool gratuit
// (Groq/OpenRouter/Cerebras) dès qu'une clé y est renseignée. Chaque couple
// fournisseur + modèle est une "route".
//
// Stratégie : chaque appel réel mesure la durée et le succès de sa route.
// Les routes sont classées par fiabilité × rapidité, et les appels tournent
// (round-robin) entre les 3 meilleures pour répartir la charge sur les quotas
// gratuits, puis retombent sur les autres dans l'ordre du classement. Une
// route qui échoue 3 fois d'affilée est mise de côté 10 minutes (essayée en
// tout dernier recours seulement).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LlmProvider, OmnirouteConfig } from '../types';
import { fetchWithTimeout } from './httpTimeout';
import { getConfiguredFreeLLMProviders } from './freeLLMProviders';

export interface LlmRoute {
  providerName: string;
  endpoint: string;
  apiKey: string;
  model: string;
}

interface RouteStats {
  ok: number;
  fail: number;
  /** Durée moyenne glissante des appels réussis, en ms. */
  avgMs: number | null;
  consecutiveFails: number;
  lastFailAt: number | null;
}

// Jamais utilisés : consomment les crédits Anthropic personnels de l'utilisateur.
const NEVER_USE_PATTERN = /claude|anthropic/i;

const STATS_KEY = '@llm_route_stats';
const ROTATION_POOL_SIZE = 3;
const COOLDOWN_AFTER_FAILS = 3;
const COOLDOWN_MS = 10 * 60_000;
/** Durée supposée d'une route jamais mesurée : assez basse pour qu'elle soit
 * essayée (exploration), assez haute pour ne pas passer devant une route
 * mesurée rapide et fiable. */
const UNKNOWN_ROUTE_MS = 6000;
const AVG_WEIGHT = 0.3;
const SAVE_THROTTLE_MS = 5000;

const QUALITY_PATTERNS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /gpt[ -]?5|o3|gpt[ -]?4\.5/i, score: 100 },
  { pattern: /gemini[ -]?3|gemini[ -]?2\.5[ -]?pro/i, score: 95 },
  { pattern: /gpt[ -]?4o|gemini[ -]?2\.5[ -]?flash|mercury[ -]?2\.5|deepseek[ -]?r1/i, score: 85 },
  { pattern: /llama[ -]?3\.1[ -]?405b|mixtral[ -]?8x22b|qwen[ -]?2\.5[ -]?72b|llama[ -]?3\.3[ -]?70b/i, score: 80 },
  { pattern: /mercury[ -]?2|gemini[ -]?flash|gpt[ -]?4[ -]?turbo/i, score: 70 },
];

/** Qualité supposée d'après le nom (0-1), départage les routes jamais mesurées. */
function priorQuality(model: string): number {
  for (const { pattern, score } of QUALITY_PATTERNS) {
    if (pattern.test(model)) return score / 100;
  }
  return 0.5;
}

let stats: Record<string, RouteStats> | null = null;
let lastSaveAt = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let rotationCounter = 0;

function routeKey(route: LlmRoute): string {
  return `${route.endpoint}|${route.model}`;
}

async function loadStats(): Promise<Record<string, RouteStats>> {
  if (stats) return stats;
  try {
    const raw = await AsyncStorage.getItem(STATS_KEY);
    stats = raw ? JSON.parse(raw) : {};
  } catch {
    stats = {};
  }
  return stats!;
}

function scheduleSave(): void {
  const persist = () => {
    lastSaveAt = Date.now();
    saveTimer = null;
    try {
      AsyncStorage.setItem(STATS_KEY, JSON.stringify(stats ?? {})).catch(() => {});
    } catch {
      // mesure best-effort : ne doit jamais faire échouer un appel réussi
    }
  };
  if (Date.now() - lastSaveAt >= SAVE_THROTTLE_MS) {
    persist();
  } else if (!saveTimer) {
    saveTimer = setTimeout(persist, SAVE_THROTTLE_MS);
  }
}

function recordResult(route: LlmRoute, ok: boolean, ms: number): void {
  if (!stats) return;
  const key = routeKey(route);
  const entry = stats[key] ?? { ok: 0, fail: 0, avgMs: null, consecutiveFails: 0, lastFailAt: null };
  if (ok) {
    entry.ok += 1;
    entry.consecutiveFails = 0;
    entry.avgMs = entry.avgMs == null ? ms : entry.avgMs * (1 - AVG_WEIGHT) + ms * AVG_WEIGHT;
  } else {
    entry.fail += 1;
    entry.consecutiveFails += 1;
    entry.lastFailAt = Date.now();
  }
  stats[key] = entry;
  scheduleSave();
}

function splitModels(models: string): string[] {
  return models
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter(Boolean)
    .filter((m) => !NEVER_USE_PATTERN.test(m));
}

function trimEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

/** Fournisseurs saisis dans Paramètres (principal + supplémentaires actifs). */
export function configuredProviders(config: OmnirouteConfig): LlmProvider[] {
  const providers: LlmProvider[] = [];
  if (config.endpoint?.trim() && config.selectedModel?.trim()) {
    providers.push({
      id: 'primary',
      name: 'Principal',
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      models: config.selectedModel,
      enabled: true,
    });
  }
  for (const p of config.extraProviders ?? []) {
    if (p.enabled && p.endpoint?.trim() && p.models?.trim()) providers.push(p);
  }
  return providers;
}

/** True si au moins une route est utilisable, sans lire les clés du pool gratuit. */
export function hasConfiguredRoutes(config: OmnirouteConfig | null | undefined): boolean {
  if (!config) return false;
  return configuredProviders(config).some((p) => splitModels(p.models).length > 0);
}

export async function buildRoutes(config: OmnirouteConfig): Promise<LlmRoute[]> {
  const routes: LlmRoute[] = [];
  const seen = new Set<string>();
  const push = (route: LlmRoute) => {
    const key = routeKey(route);
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(route);
  };

  for (const provider of configuredProviders(config)) {
    for (const model of splitModels(provider.models)) {
      push({ providerName: provider.name || 'Fournisseur', endpoint: trimEndpoint(provider.endpoint), apiKey: provider.apiKey, model });
    }
  }

  try {
    for (const { provider, apiKey } of await getConfiguredFreeLLMProviders()) {
      push({ providerName: provider.label, endpoint: provider.endpoint, apiKey, model: provider.defaultModel });
    }
  } catch {
    // pool gratuit illisible : les autres routes suffisent
  }

  return routes;
}

function isCoolingDown(entry: RouteStats | undefined, now: number): boolean {
  return Boolean(
    entry &&
      entry.consecutiveFails >= COOLDOWN_AFTER_FAILS &&
      entry.lastFailAt != null &&
      now - entry.lastFailAt < COOLDOWN_MS
  );
}

function routeScore(route: LlmRoute, entry: RouteStats | undefined): number {
  const successRate = ((entry?.ok ?? 0) + 1) / ((entry?.ok ?? 0) + (entry?.fail ?? 0) + 2);
  const ms = entry?.avgMs ?? UNKNOWN_ROUTE_MS;
  return (successRate * (0.5 + priorQuality(route.model) / 2)) / (ms / 1000 + 1);
}

/** Classe un groupe de routes, puis fait tourner le départ parmi les meilleures. */
function orderGroup(routes: LlmRoute[], all: Record<string, RouteStats>, rotation: number): LlmRoute[] {
  const now = Date.now();
  const ranked = routes
    .map((route, index) => ({ route, index, entry: all[routeKey(route)] }))
    .sort((a, b) => routeScore(b.route, b.entry) - routeScore(a.route, a.entry) || a.index - b.index);

  const healthy = ranked.filter((r) => !isCoolingDown(r.entry, now)).map((r) => r.route);
  const cooling = ranked.filter((r) => isCoolingDown(r.entry, now)).map((r) => r.route);

  const poolSize = Math.min(ROTATION_POOL_SIZE, healthy.length);
  const pool = healthy.slice(0, poolSize);
  const start = poolSize > 0 ? rotation % poolSize : 0;
  const rotated = [...pool.slice(start), ...pool.slice(0, start)];

  return [...rotated, ...healthy.slice(poolSize), ...cooling];
}

/**
 * Ordre d'essai des routes pour un appel. `preferSearchCapable` place devant
 * les agents capables de chercher sur le web (faits du jour) ; à l'intérieur
 * de chaque groupe, classement par performance mesurée + rotation.
 */
export async function orderRoutes(
  routes: LlmRoute[],
  searchCapable?: (route: LlmRoute) => boolean
): Promise<LlmRoute[]> {
  const all = await loadStats();
  const rotation = rotationCounter++;
  if (!searchCapable) return orderGroup(routes, all, rotation);
  return [
    ...orderGroup(routes.filter(searchCapable), all, rotation),
    ...orderGroup(routes.filter((r) => !searchCapable(r)), all, rotation),
  ];
}

export function routeLabel(route: LlmRoute): string {
  return `${route.providerName} · ${route.model}`;
}

/** Appel chat-completions sur une route, mesuré pour le classement. */
export async function callRoute(
  route: LlmRoute,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number = 20000
): Promise<string> {
  await loadStats();
  const startedAt = Date.now();
  let content: string;
  try {
    const response = await fetchWithTimeout(
      `${route.endpoint}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: route.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
        }),
      },
      timeoutMs
    );

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      let detail = bodyText;
      try {
        const parsed = JSON.parse(bodyText);
        detail = parsed.error?.message || parsed.detail || parsed.message || bodyText;
      } catch {
        // corps non-JSON : texte brut
      }
      throw new Error(`HTTP ${response.status}${detail ? ` : ${detail}` : ` (${response.statusText})`}`);
    }

    const data = await response.json();
    content = data.choices?.[0]?.message?.content || '';
    if (!content.trim()) throw new Error('réponse vide');
  } catch (error) {
    recordResult(route, false, Date.now() - startedAt);
    throw error;
  }
  recordResult(route, true, Date.now() - startedAt);
  return content;
}

export interface ProviderCheck {
  name: string;
  ok: boolean;
  latencyMs: number;
  readyModels: number | null;
  /** Modèles configurés pour ce fournisseur, présents dans sa liste "prêts". */
  configuredReady: number | null;
  configuredTotal: number;
  error?: string;
}

/**
 * Ping d'un fournisseur : liste des modèles prêts (filtre FreeLLMAPI
 * `execution_status=ready`, ignoré par les autres serveurs) et temps de
 * réponse. Ne consomme aucun crédit de génération.
 */
export async function checkProvider(provider: LlmProvider): Promise<ProviderCheck> {
  const configured = splitModels(provider.models);
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(
      `${trimEndpoint(provider.endpoint)}/models?execution_status=ready`,
      { headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {} },
      10000
    );
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        name: provider.name,
        ok: false,
        latencyMs,
        readyModels: null,
        configuredReady: null,
        configuredTotal: configured.length,
        error: `HTTP ${response.status}`,
      };
    }
    const data = await response.json();
    const ids: string[] = (data.data ?? []).map((m: any) => String(m.id ?? ''));
    const idSet = new Set(ids);
    return {
      name: provider.name,
      ok: true,
      latencyMs,
      readyModels: ids.length,
      configuredReady: configured.filter((m) => idSet.has(m)).length,
      configuredTotal: configured.length,
    };
  } catch (error: any) {
    return {
      name: provider.name,
      ok: false,
      latencyMs: Date.now() - startedAt,
      readyModels: null,
      configuredReady: null,
      configuredTotal: configured.length,
      error: error?.name === 'AbortError' ? 'pas de réponse (délai dépassé)' : error?.message || 'injoignable',
    };
  }
}

export async function checkAllProviders(config: OmnirouteConfig): Promise<ProviderCheck[]> {
  return Promise.all(configuredProviders(config).map(checkProvider));
}

/** Classement actuel des routes (pour affichage et diagnostic). */
export async function getRouteLeaderboard(
  config: OmnirouteConfig
): Promise<Array<{ label: string; ok: number; fail: number; avgMs: number | null; coolingDown: boolean }>> {
  const all = await loadStats();
  const now = Date.now();
  const routes = await buildRoutes(config);
  return routes
    .map((route) => ({ route, entry: all[routeKey(route)] }))
    .sort((a, b) => routeScore(b.route, b.entry) - routeScore(a.route, a.entry))
    .map(({ route, entry }) => ({
      label: routeLabel(route),
      ok: entry?.ok ?? 0,
      fail: entry?.fail ?? 0,
      avgMs: entry?.avgMs != null ? Math.round(entry.avgMs) : null,
      coolingDown: isCoolingDown(entry, now),
    }));
}
