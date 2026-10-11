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
  /** Total attendu − ligne, au moment de l'observation. */
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
export function maxGapFor(unit: string): number {
  const mine = observations.filter((o) => o.unit === unit);
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

async function record(unit: string, line: number, expectedTotal: number, available: boolean): Promise<void> {
  await ensureLineLimitsLoaded();
  observations.push({ unit, gap: Math.round((expectedTotal - line) * 100) / 100, available, ts: new Date().toISOString() });
  await save();
}

/** « Cette ligne n'existe pas chez mon bookmaker » dans la situation actuelle. */
export function markLineUnavailable(unit: string, line: number, expectedTotal: number): Promise<void> {
  return record(unit, line, expectedTotal, false);
}

/** Une cote a été donnée pour cette ligne : elle existe dans la situation actuelle. */
export function markLineAvailable(unit: string, line: number, expectedTotal: number): Promise<void> {
  return record(unit, line, expectedTotal, true);
}

export function getLineLimits(): Record<string, { maxGap: number | null; observations: number }> {
  const units = [...new Set(observations.map((o) => o.unit))];
  return Object.fromEntries(
    units.map((u) => {
      const g = maxGapFor(u);
      return [u, { maxGap: Number.isFinite(g) ? Math.round(g * 100) / 100 : null, observations: observations.filter((o) => o.unit === u && o.ts).length }];
    })
  );
}
