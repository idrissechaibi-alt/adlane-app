// Lignes que le bookmaker PROPOSE réellement — selon la situation du match.
//
// Il n'offre pas toutes les lignes, et pas toujours les mêmes : « Plus de 1.5
// cartons » existe parfois et pas d'autres fois. Une ligne n'est proposée que
// si elle reste proche du total attendu (le bookmaker écarte celles qui sont
// trop faciles). On apprend donc un ÉCART MAXIMAL entre le total attendu et la
// ligne, par compteur, au lieu d'un minimum fixe :
//   ligne proposée  <=>  total attendu − ligne ≤ écart maximal.
//
// Chaque « Ligne introuvable » (écart observé trop grand) et chaque cote donnée
// (écart observé acceptable) affine cet écart. Les valeurs de départ viennent
// des exemples de l'utilisateur : cartons du match, 1.5 absent pour ~4 attendus,
// 2.5 présent ; fautes du match, 17.5 absent pour ~24 attendues, 18.5 présent.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@bookie_line_availability';
const MAX_OBS = 400;

interface LineObs {
  unit: string;
  /** 'over' : écart = total attendu − ligne (ligne trop basse) ; 'under' : écart = ligne − total attendu (ligne trop haute). */
  side?: 'over' | 'under';
  gap: number;
  available: boolean;
  ts?: string;
}

const SEED: LineObs[] = [
  { unit: 'cards_ft', gap: 2.5, available: false },
  { unit: 'cards_ft', gap: 1.5, available: true },
  { unit: 'fouls_ft', gap: 6.5, available: false },
  { unit: 'fouls_ft', gap: 5.5, available: true },
];

let observations: LineObs[] = [...SEED];
let loaded = false;

export async function ensureLineLimitsLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) observations = [...SEED, ...(JSON.parse(raw) as LineObs[])];
  } catch {
    // les valeurs de départ suffisent
  }
}

/** Écart maximal total attendu − ligne pour que la ligne existe (Infinity = aucune limite connue). */
export function maxGapFor(unit: string, side: 'over' | 'under' = 'over'): number {
  const mine = observations.filter((o) => o.unit === unit && (o.side ?? 'over') === side);
  if (mine.length === 0) return Number.POSITIVE_INFINITY;
  const unavailable = mine.filter((o) => !o.available).map((o) => o.gap);
  const available = mine.filter((o) => o.available).map((o) => o.gap);
  if (unavailable.length === 0) return Number.POSITIVE_INFINITY;
  const lowestUnavailable = Math.min(...unavailable);
  // Entre le plus grand écart vu proposé et le plus petit écart vu introuvable.
  const highestAvailable = available.length ? Math.max(...available.filter((g) => g < lowestUnavailable), -Infinity) : -Infinity;
  return Number.isFinite(highestAvailable) ? (highestAvailable + lowestUnavailable) / 2 : lowestUnavailable - 0.5;
}

/** Plus petite ligne X.5 que le bookmaker propose pour ce compteur et ce total attendu (0 = aucune limite). */
export function minLineFor(unit: string, expectedTotal: number): number {
  const gap = maxGapFor(unit);
  if (!Number.isFinite(gap)) return 0;
  return Math.max(0, Math.ceil(expectedTotal - gap - 0.5) + 0.5);
}

async function save(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(observations.filter((o) => o.ts).slice(-MAX_OBS)));
  } catch {
    // best-effort
  }
}

async function record(unit: string, line: number, expectedTotal: number, available: boolean, side: 'over' | 'under'): Promise<void> {
  await ensureLineLimitsLoaded();
  const gap = side === 'over' ? expectedTotal - line : line - expectedTotal;
  observations.push({ unit, side, gap: Math.round(gap * 100) / 100, available, ts: new Date().toISOString() });
  await save();
}

/**
 * Plus grande ligne X.5 que le bookmaker propose pour un « Moins de » sur ce compteur et ce
 * total attendu (Infinity = aucune limite connue) : au-dessus, la ligne est trop facile.
 */
export function maxLineFor(unit: string, expectedTotal: number): number {
  const gap = maxGapFor(unit, 'under');
  if (!Number.isFinite(gap)) return Number.POSITIVE_INFINITY;
  return Math.floor(expectedTotal + gap - 0.5) + 0.5;
}

/**
 * « Cette ligne n'existe pas chez mon bookmaker » dans la situation actuelle.
 * side 'over' : ligne trop basse (minimum) ; side 'under' : ligne trop haute (maximum).
 */
export function markLineUnavailable(unit: string, line: number, expectedTotal: number, side: 'over' | 'under' = 'over'): Promise<void> {
  return record(unit, line, expectedTotal, false, side);
}

/** Une cote a été donnée pour cette ligne : elle existe dans la situation actuelle. */
export function markLineAvailable(unit: string, line: number, expectedTotal: number, side: 'over' | 'under' = 'over'): Promise<void> {
  return record(unit, line, expectedTotal, true, side);
}

export function getLineLimits(): Record<string, { maxGapOver: number | null; maxGapUnder: number | null; observations: number }> {
  const units = [...new Set(observations.map((o) => o.unit))];
  const r = (g: number) => (Number.isFinite(g) ? Math.round(g * 100) / 100 : null);
  return Object.fromEntries(
    units.map((u) => [u, { maxGapOver: r(maxGapFor(u, 'over')), maxGapUnder: r(maxGapFor(u, 'under')), observations: observations.filter((o) => o.unit === u && o.ts).length }])
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
