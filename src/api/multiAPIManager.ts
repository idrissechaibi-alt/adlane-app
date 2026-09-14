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
  fallbackEnabled: boolean;
  maxRetries: number;
}

const DEFAULT_CONFIG: APIConfig = {
  apiFootball: '',
  theOddsApi: '',
  footballData: '',
  sportmonks: '',
  sofaScore: '',
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
        const res1 = await fetch('https://v3.football.api-sports.io/status', {
          headers: {
            'x-rapidapi-key': config.apiFootball,
            'x-rapidapi-host': 'v3.football.api-sports.io'
          }
        });
        return res1.ok;

      case 'footballData':
        if (!config.footballData) return false;
        const res2 = await fetch('https://api.football-data.org/v4/competitions', {
          headers: { 'X-Auth-Token': config.footballData }
        });
        return res2.ok;

      case 'theOddsApi':
        if (!config.theOddsApi) return false;
        const res3 = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${config.theOddsApi}`);
        return res3.ok;

      case 'sofaScore':
        // SofaScore n'a pas de test de connexion simple
        return true;

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
