// Lignes que le bookmaker PROPOSE — des indices contextuels, pas une règle.
//
// Le bookmaker n'offre pas toutes les lignes, et son menu change avec le match (score,
// minute, compteur déjà joué) : une ligne qui existe à la 30e peut disparaître à la 67e.
// Chaque saisie de l'utilisateur est donc une observation datée par sa situation : la
// position de la ligne par rapport au TOTAL ATTENDU à ce moment-là (ligne − total attendu),
// et si elle existait. L'app s'en sert pour comprendre comment le bookmaker construit son
// menu, et pour estimer la CHANCE qu'une ligne soit proposée dans une situation voisine —
// jamais pour l'interdire. Un marché peu susceptible d'exister reçoit seulement moins de
// poids dans le classement ; le but reste de proposer le marché le plus optimal.
//
// Valeurs de départ (exemples de l'utilisateur) : cartons du match, 1.5 absent pour ~4
// attendus, 2.5 présent ; fautes du match, 17.5 absent pour ~24 attendues, 18.5 présent.

import AsyncStorage from './kvStore';

const KEY = '@bookie_line_availability_v2';
const OLD_KEY = '@bookie_line_availability';
const MAX_OBS = 600;

interface LineObs {
  unit: string;
  /** Ligne − total attendu au moment de l'observation (négatif : sous le total attendu). */
  off: number;
  available: boolean;
  ts?: string;
}

const SEED: LineObs[] = [
  { unit: 'cards_ft', off: -2.5, available: false },
  { unit: 'cards_ft', off: -1.5, available: true },
  { unit: 'fouls_ft', off: -6.5, available: false },
  { unit: 'fouls_ft', off: -5.5, available: true },
];

let observations: LineObs[] = [...SEED];
let loaded = false;

export async function ensureLineLimitsLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) observations = [...SEED, ...(JSON.parse(raw) as LineObs[])];
    else {
      // Reprise des observations de l'ancienne version (écart selon le côté du pari).
      const old = await AsyncStorage.getItem(OLD_KEY);
      if (old) {
        const converted = (JSON.parse(old) as Array<{ unit: string; side?: 'over' | 'under'; gap: number; available: boolean; ts?: string }>).map((o) => ({
          unit: o.unit,
          off: (o.side ?? 'over') === 'over' ? -o.gap : o.gap,
          available: o.available,
          ts: o.ts,
        }));
        observations = [...SEED, ...converted];
      }
    }
  } catch {
    // les valeurs de départ suffisent
  }
}

/**
 * Chance (0-1) qu'une ligne soit proposée par le bookmaker, d'après ce qu'il a montré dans des situations
 * voisines. Règles de bon sens d'abord : une ligne plus éloignée du total attendu qu'une ligne vue
 * absente est absente ; une ligne plus éloignée qu'une ligne vue présente l'est aussi (même côté).
 * Sinon, moyenne des observations proches, avec un a priori favorable (0,8) : sans information, on ne
 * pénalise rien.
 */
export function lineAvailability(unit: string, line: number, expectedTotal: number): { p: number; n: number } {
  const off = line - expectedTotal;
  const mine = observations.filter((o) => o.unit === unit);
  if (mine.length === 0) return { p: 1, n: 0 };
  const sameSide = mine.filter((o) => Math.sign(o.off) === Math.sign(off) || o.off === 0);
  const farther = (o: LineObs) => Math.abs(o.off) >= Math.abs(off);
  const nearer = (o: LineObs) => Math.abs(o.off) <= Math.abs(off);
  const absentFartherOrEqual = sameSide.some((o) => !o.available && nearer(o));
  const presentFartherOut = sameSide.some((o) => o.available && farther(o));
  // « absent plus près du total attendu » => ma ligne, plus éloignée encore, l'est aussi.
  if (absentFartherOrEqual && !presentFartherOut) return { p: 0.08, n: sameSide.length };
  if (presentFartherOut && !absentFartherOrEqual) return { p: 0.95, n: sameSide.length };
  // Conflit ou aucune règle : observations voisines (±1,0), pondérées par la proximité.
  let w = 0;
  let a = 0;
  for (const o of mine) {
    const d = Math.abs(o.off - off);
    if (d > 1) continue;
    const k = 1 - d;
    w += k;
    if (o.available) a += k;
  }
  return { p: (a + 0.8 * 1) / (w + 1), n: Math.round(w) };
}

/** Plage de lignes que le bookmaker semble proposer autour du total attendu (diagnostic). */
export function offeredRange(unit: string): { lowOffset: number | null; highOffset: number | null } {
  const mine = observations.filter((o) => o.unit === unit);
  const lows = mine.filter((o) => o.off < 0 && o.available).map((o) => o.off);
  const highs = mine.filter((o) => o.off > 0 && o.available).map((o) => o.off);
  return { lowOffset: lows.length ? Math.min(...lows) : null, highOffset: highs.length ? Math.max(...highs) : null };
}

async function save(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(observations.filter((o) => o.ts).slice(-MAX_OBS)));
  } catch {
    // best-effort
  }
}

async function record(unit: string, line: number, expectedTotal: number, available: boolean): Promise<void> {
  await ensureLineLimitsLoaded();
  observations.push({ unit, off: Math.round((line - expectedTotal) * 100) / 100, available, ts: new Date().toISOString() });
  await save();
}

/** Cette ligne n'existait pas chez le bookmaker dans la situation actuelle. */
export function markLineUnavailable(unit: string, line: number, expectedTotal: number): Promise<void> {
  return record(unit, line, expectedTotal, false);
}

/** Cette ligne existait (une cote a été donnée) dans la situation actuelle. */
export function markLineAvailable(unit: string, line: number, expectedTotal: number): Promise<void> {
  return record(unit, line, expectedTotal, true);
}

export function getLineLimits(): Record<string, { lowestSeenOffset: number | null; highestSeenOffset: number | null; observations: number }> {
  const units = [...new Set(observations.map((o) => o.unit))];
  return Object.fromEntries(
    units.map((u) => {
      const r = offeredRange(u);
      return [u, { lowestSeenOffset: r.lowOffset, highestSeenOffset: r.highOffset, observations: observations.filter((o) => o.unit === u && o.ts).length }];
    })
  );
}

// ---------- Marché non proposé « pour l'instant » ----------
// Parfois le bookmaker n'offre pas du tout le marché (suspendu, pas encore ouvert
// pour ce match). Ce n'est pas un problème de ligne : l'écart appris n'est pas
// touché. Le marché est simplement mis de côté pour CE match pendant un moment.

const OFF_KEY = '@bookie_market_off';
const OFF_MINUTES = 30;

interface MarketOff {
  fixtureId: number;
  /** Compteur (corners_ft…) ou marché (1X2, btts…). */
  key: string;
  until: number;
  ts: string;
}

let marketOff: MarketOff[] = [];
let offLoaded = false;

export async function ensureMarketOffLoaded(): Promise<void> {
  if (offLoaded) return;
  offLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(OFF_KEY);
    if (raw) marketOff = JSON.parse(raw);
  } catch {
    marketOff = [];
  }
}

/** « Mon bookmaker ne propose pas ce marché pour l'instant ». */
export async function markMarketOff(fixtureId: number, key: string): Promise<void> {
  await ensureMarketOffLoaded();
  const now = Date.now();
  marketOff = [...marketOff.filter((m) => !(m.fixtureId === fixtureId && m.key === key)), { fixtureId, key, until: now + OFF_MINUTES * 60_000, ts: new Date(now).toISOString() }].slice(-300);
  try {
    await AsyncStorage.setItem(OFF_KEY, JSON.stringify(marketOff));
  } catch {
    // best-effort
  }
}

/** Le marché est-il signalé indisponible pour ce match en ce moment ? */
export function isMarketOff(fixtureId: number, key: string): boolean {
  const now = Date.now();
  return marketOff.some((m) => m.fixtureId === fixtureId && m.key === key && m.until > now);
}

/** Nombre de signalements « marché non proposé » par compteur / marché (diagnostic). */
export function getMarketOffCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of marketOff) out[m.key] = (out[m.key] ?? 0) + 1;
  return out;
}
