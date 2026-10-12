// Statistiques en direct des matchs RÉELS, relevées chaque minute auprès des 6 sources gratuites (LiveScore, FotMob,
// 365Scores, ESPN, AllSportsApi, TheSportsDB). Un relevé par match et par minute de scan : score, minute, tirs,
// tirs cadrés, corners, cartons, fautes, possession, xG, rouges. Aucun plafond : tout l'historique est gardé.

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface LiveStatsSample {
  ts: string;
  minute: number;
  status: string;
  home: number;
  away: number;
  shots?: number;
  sot?: number;
  corners?: number;
  cards?: number;
  fouls?: number;
  possessionHome?: number;
  xg?: number;
  reds?: number;
}

const KEY_PREFIX = '@real_live_stats_';
const MIN_GAP_MS = 50_000;
const lastAt = new Map<string, number>();
let lastScan: { at: string; matches: number; sources: string } | null = null;

const dayKey = () => new Date().toISOString().slice(0, 10);

export async function appendLiveStatsSample(matchKey: string, sample: LiveStatsSample): Promise<boolean> {
  const last = lastAt.get(matchKey) ?? 0;
  if (Date.now() - last < MIN_GAP_MS) return false;
  lastAt.set(matchKey, Date.now());
  try {
    const key = `${KEY_PREFIX}${dayKey()}`;
    const store: Record<string, LiveStatsSample[]> = JSON.parse((await AsyncStorage.getItem(key)) ?? '{}');
    (store[matchKey] ??= []).push(sample);
    await AsyncStorage.setItem(key, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function noteLiveStatsScan(matches: number, sources: string): void {
  lastScan = { at: new Date().toISOString(), matches, sources };
}

/** Diagnostic : dernier passage et nombre de relevés du jour par match. */
export async function getLiveStatsScanStatus(): Promise<{ lastScan: typeof lastScan; todaySamples: Record<string, number> }> {
  let counts: Record<string, number> = {};
  try {
    const store: Record<string, LiveStatsSample[]> = JSON.parse((await AsyncStorage.getItem(`${KEY_PREFIX}${dayKey()}`)) ?? '{}');
    counts = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.length]));
  } catch {
    counts = {};
  }
  return { lastScan, todaySamples: counts };
}

/** Relevés bruts d'un jour (tous les matchs). */
export async function readLiveStatsDay(day: string): Promise<Record<string, LiveStatsSample[]>> {
  try {
    return JSON.parse((await AsyncStorage.getItem(`${KEY_PREFIX}${day}`)) ?? '{}');
  } catch {
    return {};
  }
}

/** Retire les relevés bruts d'un match (une fois digérés en un résumé compact). */
export async function removeLiveStatsMatch(day: string, matchKey: string): Promise<void> {
  try {
    const store = await readLiveStatsDay(day);
    delete store[matchKey];
    if (Object.keys(store).length === 0) await AsyncStorage.removeItem(`${KEY_PREFIX}${day}`);
    else await AsyncStorage.setItem(`${KEY_PREFIX}${day}`, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

/** Jours de relevés bruts encore présents (les plus anciens sont digérés puis supprimés). */
export async function listLiveStatsDays(): Promise<string[]> {
  try {
    return (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(KEY_PREFIX)).map((k) => k.slice(KEY_PREFIX.length)).sort();
  } catch {
    return [];
  }
}
