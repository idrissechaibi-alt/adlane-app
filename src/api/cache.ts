// Cache local pour les données API Football
// Utilise AsyncStorage pour stockage persistant sur mobile
// Gère les TTL (Time-To-Live) pour invalidation automatique

import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = '@api_cache_';
const CACHE_CONFIG_KEY = '@api_cache_config';

export interface CacheEntry<T> {
  key: string;
  data: T;
  timestamp: string;      // ISO 8601
  ttl: number;           // en secondes
}

export interface CacheConfig {
  defaultTTL: number;     // 300 = 5 min
  fixturesTTL: number;    // 600 = 10 min
  oddsTTL: number;        // 60 = 1 min (données dynamiques)
  teamTTL: number;        // 1800 = 30 min
  playerTTL: number;      // 1800 = 30 min
}

const DEFAULT_CONFIG: CacheConfig = {
  defaultTTL: 300,
  fixturesTTL: 600,
  oddsTTL: 60,
  teamTTL: 1800,
  playerTTL: 1800
};

// ==================== CONFIG ====================

export async function getCacheConfig(): Promise<CacheConfig> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveCacheConfig(config: Partial<CacheConfig>): Promise<void> {
  const current = await getCacheConfig();
  await AsyncStorage.setItem(CACHE_CONFIG_KEY, JSON.stringify({ ...current, ...config }));
}

// ==================== CACHE OPERATIONS ====================

/**
 * Récupère une entrée du cache si elle existe et n'est pas expirée
 */
export async function getFromCache<T>(key: string, ttlOverride?: number): Promise<T | null> {
  try {
    const fullKey = CACHE_PREFIX + key;
    const raw = await AsyncStorage.getItem(fullKey);

    if (!raw) return null;

    const entry: CacheEntry<T> = JSON.parse(raw);

    // Vérifier TTL
    const now = Date.now();
    const ttl = ttlOverride ?? entry.ttl;
    const ttlMs = ttl * 1000;
    const entryTime = new Date(entry.timestamp).getTime();

    if (now - entryTime > ttlMs) {
      // Expired - remove it
      await removeFromCache(key);
      return null;
    }

    return entry.data;
  } catch (error) {
    console.warn(`[CACHE] Erreur lecture clef ${key}:`, error);
    return null;
  }
}

/**
 * Sauvegarde dans le cache
 */
export async function saveToCache<T>(key: string, data: T, ttl?: number): Promise<void> {
  try {
    const fullKey = CACHE_PREFIX + key;
    const currentConfig = await getCacheConfig();
    const effectiveTTL = ttl ?? currentConfig.defaultTTL;

    const entry: CacheEntry<T> = {
      key: fullKey,
      data,
      timestamp: new Date().toISOString(),
      ttl: effectiveTTL
    };

    await AsyncStorage.setItem(fullKey, JSON.stringify(entry));
  } catch (error) {
    console.warn(`[CACHE] Erreur ecriture clef ${key}:`, error);
  }
}

/**
 * Supprime une entrée du cache
 */
export async function removeFromCache(key: string): Promise<void> {
  try {
    const fullKey = CACHE_PREFIX + key;
    await AsyncStorage.removeItem(fullKey);
  } catch (error) {
    console.warn(`[CACHE] Erreur suppression clef ${key}:`, error);
  }
}

/**
 * Vide tout le cache
 */
export async function clearCache(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const cacheKeys = allKeys.filter(k => k.startsWith(CACHE_PREFIX));
    if (cacheKeys.length > 0) {
      await AsyncStorage.multiRemove(cacheKeys);
    }
  } catch (error) {
    console.warn('[CACHE] Erreur clear:', error);
  }
}

/**
 * Nettoie les entrées expirées
 */
export async function cleanupExpiredCache(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const cacheKeys = allKeys.filter(k => k.startsWith(CACHE_PREFIX));

    const now = Date.now();
    let cleaned = 0;

    for (const key of cacheKeys) {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (raw) {
          const entry: CacheEntry<any> = JSON.parse(raw);
          const ttlMs = entry.ttl * 1000;
          const entryTime = new Date(entry.timestamp).getTime();

          if (now - entryTime > ttlMs) {
            await AsyncStorage.removeItem(key);
            cleaned++;
          }
        }
      } catch {
        // Ignorer les entrées corrompues
      }
    }

    if (cleaned > 0) {
      console.log(`[CACHE] Nettoyage: ${cleaned} entrées expirées supprimées`);
    }
  } catch (error) {
    console.warn('[CACHE] Erreur cleanup:', error);
  }
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Génère une clé de cache standardisée
 */
export function generateCacheKey(prefix: string, params: Record<string, any>): string {
  const sortedParams = Object.entries(params)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('&');

  const cleanParams = sortedParams.replace(/[^a-zA-Z0-9=&]/g, '_');
  return `${prefix}_${cleanParams}`;
}

// Exemples d'utilisation:
// fixtures:today -> 'fixtures_date_2026-09-14'
// odds:match_123 -> 'odds_matchid_123'
// team:456 -> 'team_teamid_456'
