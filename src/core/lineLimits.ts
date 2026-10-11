// Lignes que le bookmaker PROPOSE réellement. Il n'offre pas toutes les lignes :
// « Plus de 1.5 cartons » n'existe pas (minimum 2.5), « Plus de 17.5 fautes »
// non plus (minimum 18.5). Proposer un pari introuvable ne sert à rien.
//
// Le minimum de chaque compteur est appris : partie de ce que l'utilisateur a
// indiqué, relevé à chaque fois qu'il signale « ligne introuvable », abaissé
// quand il donne la cote d'une ligne plus basse.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@bookie_line_limits';

/** Minimum connu au départ (indiqué par l'utilisateur), par compteur. */
const SEED: Record<string, number> = { cards_ft: 2.5, fouls_ft: 18.5 };

let limits: Record<string, number> = { ...SEED };
let loaded = false;

export async function ensureLineLimitsLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) limits = { ...SEED, ...JSON.parse(raw) };
  } catch {
    // les valeurs de départ suffisent
  }
}

/** Ligne minimale proposée par le bookmaker pour ce compteur (0 = aucune limite connue). */
export function minLineFor(unit: string): number {
  return limits[unit] ?? 0;
}

async function save(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(limits));
  } catch {
    // best-effort
  }
}

/** « Cette ligne n'existe pas chez mon bookmaker » : le minimum monte juste au-dessus. */
export async function markLineUnavailable(unit: string, line: number): Promise<void> {
  await ensureLineLimitsLoaded();
  limits[unit] = Math.max(limits[unit] ?? 0, line + 1);
  await save();
}

/** Cote donnée pour cette ligne : elle existe, le minimum ne peut pas être au-dessus. */
export async function markLineAvailable(unit: string, line: number): Promise<void> {
  await ensureLineLimitsLoaded();
  if ((limits[unit] ?? 0) > line) {
    limits[unit] = line;
    await save();
  }
}

export function getLineLimits(): Record<string, number> {
  return { ...limits };
}
