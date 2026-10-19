// Statistiques en direct des matchs RÉELS, relevées chaque minute auprès des 6 sources gratuites (LiveScore, FotMob,
// 365Scores, ESPN, AllSportsApi, TheSportsDB). Un relevé par match et par minute de scan : score, minute, tirs,
// tirs cadrés, corners, cartons, fautes, possession, xG, rouges. Aucun plafond : tout l'historique est gardé.

import AsyncStorage from './kvStore';

import { advancedOf, type AdvancedPoint } from './patternEngine';
import type { SofaPeriodStats } from '../api/footballDataAPIs/sofaScore';

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
  /** Détail par équipe (domicile / extérieur) : tirs, cadrés, corners, cartons, fautes. */
  side?: { h: [number, number, number, number, number]; a: [number, number, number, number, number] };
  /** Contexte d'avant-match (premier relevé seulement) : favori, buts attendus d'après la tendance des équipes. */
  ctx?: { fav?: 'h' | 'a' | null; trendGoals?: number | null; keyAbsent?: number | null; formationChanged?: boolean | null; refRatio?: number | null };
  /** Marqueurs avancés (FotMob) : xG, touches dans la surface adverse, passes dans le camp adverse, centres, momentum. */
  adv?: AdvancedPoint;
}

const KEY_PREFIX = '@real_live_stats_';
const MIN_GAP_MS = 50_000;
const lastAt = new Map<string, number>();
let lastScan: { at: string; matches: number; sources: string } | null = null;

const dayKey = () => new Date().toISOString().slice(0, 10);

/** Ce match a-t-il déjà un relevé aujourd'hui (le contexte d'avant-match n'est joint qu'au premier) ? */
export function hasLiveStats(matchKey: string): boolean {
  return lastAt.has(matchKey);
}

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

/**
 * Buts marqués avant la pause d'après nos relevés minute par minute (ou le résumé du match s'il est déjà digéré) :
 * { goals, certain }. certain = on a vu la 2e mi-temps ou la pause (donc « 0 but » est fiable) ;
 * un but vu avant la 45e est toujours certain.
 */
export async function getHalfTimeGoals(matchKey: string): Promise<{ goals: number; certain: boolean } | null> {
  const day = dayKey();
  const raw = (await readLiveStatsDay(day))[matchKey];
  if (raw && raw.length > 0) {
    const first = raw.filter((x) => x.minute <= 45 && x.status === '1H');
    const maxGoals = first.reduce((m, x) => Math.max(m, x.home + x.away), 0);
    const seenAfter = raw.some((x) => x.status === 'HT' || x.status === '2H' || x.minute > 45);
    if (maxGoals > 0) return { goals: maxGoals, certain: true };
    if (seenAfter && first.length > 0) return { goals: 0, certain: true };
    return first.length > 0 ? { goals: 0, certain: false } : null;
  }
  try {
    const digests = JSON.parse((await AsyncStorage.getItem('@match_digests')) ?? '{}');
    const d = digests[`${day}|${matchKey}`];
    if (d) return { goals: d.goals.filter((g: [number, string]) => g[0] <= 45).length, certain: true };
  } catch {
    // pas de résumé
  }
  return null;
}

/** Corners / cartons / fautes à la pause, d'après notre relevé pris pendant la mi-temps (statut HT). null si aucun. */
export async function getHalfTimeCounts(matchKey: string): Promise<{ corners: number; cards: number; fouls: number } | null> {
  const raw = (await readLiveStatsDay(dayKey()))[matchKey];
  const ht = raw?.find((x) => x.status === 'HT' && x.corners != null);
  return ht ? { corners: ht.corners ?? 0, cards: ht.cards ?? 0, fouls: ht.fouls ?? 0 } : null;
}

const PLAYERS_PREFIX = '@real_live_players_';

/** Dernier relevé des stats des joueurs d'un match (écrase le précédent : seul le plus récent compte). */
export async function saveLivePlayers(matchKey: string, players: unknown[]): Promise<void> {
  const key = `${PLAYERS_PREFIX}${dayKey()}`;
  try {
    const store = JSON.parse((await AsyncStorage.getItem(key)) ?? '{}');
    store[matchKey] = players;
    await AsyncStorage.setItem(key, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

/** Stats des joueurs d'un match (dernier relevé), puis suppression (une fois compilées dans le profil des équipes). */
export async function takeLivePlayers(day: string, matchKey: string): Promise<any[] | null> {
  const key = `${PLAYERS_PREFIX}${day}`;
  try {
    const store = JSON.parse((await AsyncStorage.getItem(key)) ?? '{}');
    const players = store[matchKey] ?? null;
    if (players) {
      delete store[matchKey];
      if (Object.keys(store).length === 0) await AsyncStorage.removeItem(key);
      else await AsyncStorage.setItem(key, JSON.stringify(store));
    }
    return players;
  } catch {
    return null;
  }
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

/** Relevé normalisé à partir des stats d'une source (téléphone et serveur PC produisent exactement le même format). */
export function buildLiveSample(
  live: { minute: number; statusShort: string; homeGoals: number; awayGoals: number },
  a: SofaPeriodStats
): LiveStatsSample {
  return {
    ts: new Date().toISOString(),
    minute: live.minute,
    status: live.statusShort,
    home: live.homeGoals,
    away: live.awayGoals,
    shots: a.shotsTotalHome + a.shotsTotalAway,
    sot: a.shotsOnTargetHome + a.shotsOnTargetAway,
    corners: a.corners,
    cards: a.cards,
    fouls: a.fouls || undefined,
    possessionHome: a.possessionHome ?? undefined,
    xg: a.xgHome != null && a.xgAway != null ? Math.round((a.xgHome + a.xgAway) * 100) / 100 : undefined,
    reds: a.redCards ?? undefined,
    adv: advancedOf(a),
    side: {
      h: [a.shotsTotalHome, a.shotsOnTargetHome, a.cornersHome, a.cardsHome ?? 0, a.foulsHome ?? 0],
      a: [a.shotsTotalAway, a.shotsOnTargetAway, a.cornersAway, a.cardsAway ?? 0, a.foulsAway ?? 0],
    },
  };
}

/**
 * Relevés venus du serveur PC (src/core/serverFeed.ts) : ajoutés au relevé du jour, sans doublon (seuls ceux plus récents
 * que le dernier relevé déjà là pour ce match). Renvoie le nombre ajouté.
 */
export async function mergeLiveSamples(day: string, matchKey: string, samples: LiveStatsSample[]): Promise<number> {
  try {
    const key = `${KEY_PREFIX}${day}`;
    const store: Record<string, LiveStatsSample[]> = JSON.parse((await AsyncStorage.getItem(key)) ?? '{}');
    const list = (store[matchKey] ??= []);
    const lastTs = list.length ? Date.parse(list[list.length - 1].ts) : 0;
    const fresh = samples.filter((x) => Date.parse(x.ts) > lastTs + 30_000);
    if (fresh.length === 0) return 0;
    list.push(...fresh);
    await AsyncStorage.setItem(key, JSON.stringify(store));
    lastAt.set(matchKey, Date.now());
    return fresh.length;
  } catch {
    return 0;
  }
}
