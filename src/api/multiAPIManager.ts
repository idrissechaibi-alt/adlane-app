// Gestionnaire Multi-API avec Fallback Automatique
// Configure et orchestre plusieurs sources de données football

import AsyncStorage from '@react-native-async-storage/async-storage';

const API_CONFIG_KEY = '@multi_api_manager_config';

export interface APIConfig {
  apiFootball: string;
  theOddsApi: string;
  footballData: string;
  sportmonks: string;
  fallbackEnabled: boolean;
}

const DEFAULT_CONFIG: APIConfig = {
  apiFootball: '',
  theOddsApi: '',
  footballData: '',
  sportmonks: '',
  fallbackEnabled: true
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

export async function testAPIConnection(source: string, config: APIConfig): Promise<boolean> {
  try {
    if (source === 'apiFootball' && config.apiFootball) {
      const res = await fetch('https://v3.football.api-sports.io/status', {
        headers: {
          'x-rapidapi-key': config.apiFootball,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        }
      });
      return res.ok;
    }
    return false;
  } catch {
    return false;
  }
}
