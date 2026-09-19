// Gestionnaire Multi-API avec Fallback Automatique
// Orchestre plusieurs sources de données football avec retry et cache

import AsyncStorage from '@react-native-async-storage/async-storage';

const API_CONFIG_KEY = '@multi_api_manager_config';

export interface APIConfig {
  apiFootball: string;
  theOddsApi: string;
  footballData: string;
  sportmonks: string;
  sofaScore: string;
  perplexity: string;
  fallbackEnabled: boolean;
  maxRetries: number;
}

const DEFAULT_CONFIG: APIConfig = {
  apiFootball: '',
  theOddsApi: '',
  footballData: '',
  sportmonks: '',
  sofaScore: '',
  perplexity: '',
  fallbackEnabled: true,
  maxRetries: 2
};

export async function getAPIConfig(): Promise<APIConfig> {
  try {
    const raw = await AsyncStorage.getItem(API_CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveAPIConfig(config: APIConfig): Promise<void> {
  await AsyncStorage.setItem(API_CONFIG_KEY, JSON.stringify(config));
}

// ==================== COMPTEUR DE REQUÊTES ====================
// Compte les requêtes envoyées à chaque source, remis à zéro chaque jour
// (les quotas des API football sont quasiment tous exprimés en requêtes/jour).

const REQUEST_COUNT_KEY = '@api_request_counts';

interface RequestCountEntry {
  date: string; // YYYY-MM-DD
  count: number;
}

type RequestCountStore = Record<string, RequestCountEntry>;

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

async function readRequestCounts(): Promise<RequestCountStore> {
  try {
    const raw = await AsyncStorage.getItem(REQUEST_COUNT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeRequestCounts(store: RequestCountStore): Promise<void> {
  await AsyncStorage.setItem(REQUEST_COUNT_KEY, JSON.stringify(store));
}

/**
 * Incrémente le compteur de requêtes d'une source pour la journée en cours.
 */
export async function incrementRequestCount(source: string): Promise<number> {
  const store = await readRequestCounts();
  const today = todayKey();
  const entry = store[source];
  const nextCount = entry && entry.date === today ? entry.count + 1 : 1;
  store[source] = { date: today, count: nextCount };
  await writeRequestCounts(store);
  return nextCount;
}

/**
 * Retourne le nombre de requêtes envoyées aujourd'hui pour une source (0 si aucune ou jour différent).
 */
export async function getRequestCount(source: string): Promise<number> {
  const store = await readRequestCounts();
  const entry = store[source];
  return entry && entry.date === todayKey() ? entry.count : 0;
}

/**
 * Retourne les compteurs du jour pour toutes les sources connues.
 */
export async function getAllRequestCounts(): Promise<Record<string, number>> {
  const store = await readRequestCounts();
  const today = todayKey();
  const result: Record<string, number> = {};
  for (const [source, entry] of Object.entries(store)) {
    result[source] = entry.date === today ? entry.count : 0;
  }
  return result;
}

/**
 * Remet à zéro le compteur d'une source (ex : après renouvellement de quota).
 */
export async function resetRequestCount(source: string): Promise<void> {
  const store = await readRequestCounts();
  delete store[source];
  await writeRequestCounts(store);
}

// ==================== QUOTAS / CONSOMMATION DE CRÉDIT ====================
// Barre de progression par source : quand l'API expose elle-même son quota
// réel (API-Football, TheOddsAPI, Football-Data.org), on l'utilise tel quel.
// Sinon, on retombe sur le compteur local de requêtes comparé à une limite
// que l'utilisateur règle lui-même pour coller à son plan exact.

export type QuotaPeriod = 'hour' | 'day' | 'month';

export interface QuotaSetting {
  limit: number;
  period: QuotaPeriod;
}

export interface QuotaUsage {
  used: number;
  limit: number;
  period: QuotaPeriod;
  live: boolean; // true = quota lu en direct depuis l'API, false = estimation locale
}

const QUOTA_CONFIG_KEY = '@api_quota_config';

// Limites par défaut des plans gratuits usuels — modifiables dans l'écran
// Gestion des API pour coller au plan réellement souscrit par l'utilisateur.
export const DEFAULT_QUOTAS: Record<string, QuotaSetting> = {
  apiFootball: { limit: 100, period: 'day' },
  footballData: { limit: 10, period: 'hour' },
  theOddsApi: { limit: 500, period: 'month' },
  sportmonks: { limit: 3000, period: 'day' },
  perplexity: { limit: 100, period: 'month' },
  // Moteurs IA : plafonds volontairement prudents pour l'enrichissement
  // automatique des matchs suivis (modifiables dans Gestion des API).
  gemini: { limit: 200, period: 'day' },
  omniroute: { limit: 100, period: 'day' },
};

export async function getQuotaConfig(): Promise<Record<string, QuotaSetting>> {
  try {
    const raw = await AsyncStorage.getItem(QUOTA_CONFIG_KEY);
    const stored = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_QUOTAS, ...stored };
  } catch {
    return DEFAULT_QUOTAS;
  }
}

export async function setQuotaSetting(source: string, setting: QuotaSetting): Promise<void> {
  const all = await getQuotaConfig();
  all[source] = setting;
  await AsyncStorage.setItem(QUOTA_CONFIG_KEY, JSON.stringify(all));
}

/**
 * Interroge le quota RÉEL directement depuis l'API quand elle l'expose,
 * sans compter cette vérification elle-même dans le compteur local (pour ne
 * pas fausser la conso affichée).
 */
async function fetchLiveQuota(source: string, config: APIConfig): Promise<QuotaUsage | null> {
  try {
    if (source === 'apiFootball' && config.apiFootball) {
      const res = await fetch('https://v3.football.api-sports.io/status', {
        headers: { 'x-rapidapi-key': config.apiFootball, 'x-rapidapi-host': 'v3.football.api-sports.io' }
      });
      if (!res.ok) return null;
      const data = await res.json();
      const requests = data.response?.requests;
      if (!requests || typeof requests.limit_day !== 'number') return null;
      return { used: requests.current || 0, limit: requests.limit_day, period: 'day', live: true };
    }

    if (source === 'theOddsApi' && config.theOddsApi) {
      const res = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${config.theOddsApi}`);
      const used = Number(res.headers.get('x-requests-used'));
      const remaining = Number(res.headers.get('x-requests-remaining'));
      if (!Number.isFinite(used) || !Number.isFinite(remaining)) return null;
      return { used, limit: used + remaining, period: 'month', live: true };
    }

    if (source === 'footballData' && config.footballData) {
      const res = await fetch('https://api.football-data.org/v4/competitions', {
        headers: { 'X-Auth-Token': config.footballData }
      });
      const remaining = Number(res.headers.get('x-requests-available-minute'));
      if (!Number.isFinite(remaining)) return null;
      // Fenêtre glissante par minute (pas une vraie limite horaire), mais
      // c'est la seule donnée réelle exposée par cette API en accès gratuit.
      const quota = (await getQuotaConfig())[source] || DEFAULT_QUOTAS[source];
      const limit = quota.period === 'hour' ? quota.limit : 10;
      return { used: Math.max(0, limit - remaining), limit, period: 'hour', live: true };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Renvoie la conso à afficher pour une source : quota réel si l'API l'expose,
 * sinon compteur local de requêtes comparé à la limite réglée par l'utilisateur.
 * Renvoie null si la source n'a pas de clé configurée (rien à afficher).
 */
export async function getQuotaUsage(source: string, config: APIConfig): Promise<QuotaUsage | null> {
  const hasKey = Boolean((config as any)[source]);
  if (!hasKey) return null;

  const live = await fetchLiveQuota(source, config);
  if (live) return live;

  const setting = (await getQuotaConfig())[source] || { limit: 100, period: 'day' as QuotaPeriod };
  const used = await getRequestCount(source);
  return { used, limit: setting.limit, period: setting.period, live: false };
}

/**
 * Test de connexion avec retry automatique
 */
export async function testAPIConnection(
  source: string,
  config: APIConfig,
  retries: number = 0
): Promise<boolean> {
  try {
    switch (source) {
      case 'apiFootball':
        if (!config.apiFootball) return false;
        await incrementRequestCount('apiFootball');
        const res1 = await fetch('https://v3.football.api-sports.io/status', {
          headers: {
            'x-rapidapi-key': config.apiFootball,
            'x-rapidapi-host': 'v3.football.api-sports.io'
          }
        });
        return res1.ok;

      case 'footballData':
        if (!config.footballData) return false;
        await incrementRequestCount('footballData');
        const res2 = await fetch('https://api.football-data.org/v4/competitions', {
          headers: { 'X-Auth-Token': config.footballData }
        });
        return res2.ok;

      case 'theOddsApi':
        if (!config.theOddsApi) return false;
        await incrementRequestCount('theOddsApi');
        const res3 = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${config.theOddsApi}`);
        return res3.ok;

      case 'sofaScore':
        // SofaScore n'a pas de test de connexion simple
        return true;

      case 'perplexity':
        if (!config.perplexity) return false;
        await incrementRequestCount('perplexity');
        const res4 = await fetch('https://api.perplexity.ai/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.perplexity}`
          },
          body: JSON.stringify({ query: 'test', max_results: 1 })
        });
        return res4.ok;

      default:
        return false;
    }
  } catch (error) {
    if (retries < config.maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retries + 1)));
      return testAPIConnection(source, config, retries + 1);
    }
    return false;
  }
}

/**
 * Obtient l'API disponible avec fallback automatique
 */
export async function getAvailableAPI(config: APIConfig): Promise<string | null> {
  const sources = ['apiFootball', 'footballData', 'theOddsApi', 'sofaScore'];

  for (const source of sources) {
    if (await testAPIConnection(source, config)) {
      return source;
    }
  }

  return null;
}

/**
 * Récupère un client API configuré
 */
export function getAPIClient(source: string, config: APIConfig) {
  switch (source) {
    case 'apiFootball':
      return {
        baseURL: 'https://v3.football.api-sports.io',
        headers: {
          'x-rapidapi-key': config.apiFootball,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        }
      };

    case 'footballData':
      return {
        baseURL: 'https://api.football-data.org/v4',
        headers: { 'X-Auth-Token': config.footballData }
      };

    case 'theOddsApi':
      return {
        baseURL: 'https://api.the-odds-api.com/v4',
        params: { apiKey: config.theOddsApi }
      };

    case 'sofaScore':
      return {
        baseURL: 'https://www.sofascore.com/api'
      };

    default:
      return null;
  }
}
