// Alias de noms d'équipes APPRIS : quand un match du planning est retrouvé dans une source par un autre chemin que le nom
// (même horaire + une équipe reconnue), l'autre équipe est mémorisée sous les deux noms. Rien à saisir à la main, et la
// liste grandit toute seule. Persisté, rechargé au démarrage de chaque tour.

import AsyncStorage from './kvStore';
import { normalizeTeamName, setLearnedAliases } from './teamNameMatch';

const KEY = '@team_aliases';
let memo: Record<string, string> | null = null;

export async function loadLearnedAliases(): Promise<void> {
  if (memo) return;
  try {
    memo = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}');
  } catch {
    memo = {};
  }
  setLearnedAliases(new Map(Object.entries(memo!)));
}

/** Mémorise que `variant` désigne la même équipe que `canonical` (noms bruts). */
export async function learnAlias(canonical: string, variant: string): Promise<void> {
  await loadLearnedAliases();
  const c = normalizeTeamName(canonical);
  const v = normalizeTeamName(variant);
  if (!c || !v || c === v) return;
  memo![v] = c;
  setLearnedAliases(new Map(Object.entries(memo!)));
  await AsyncStorage.setItem(KEY, JSON.stringify(memo)).catch(() => {});
}

export async function readLearnedAliases(): Promise<Record<string, string>> {
  await loadLearnedAliases();
  return { ...memo! };
}
