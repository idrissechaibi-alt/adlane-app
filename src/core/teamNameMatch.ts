// Normalisation de noms d'équipe pour faire correspondre les mêmes matchs
// entre deux sources qui n'utilisent pas exactement le même libellé
// (ex: football-data.org "Arsenal FC" vs TheOddsAPI/API-Football "Arsenal").
// Best-effort : une équipe qui ne matche pas reste simplement non associée,
// jamais de donnée inventée à sa place.

export function normalizeTeamName(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ac|cd|ud|rc|ssd|calcio|club|ss|as)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Repli quand la correspondance exacte échoue : football-data.org utilise
 * souvent le nom officiel complet (« Olympique de Marseille », « Racing
 * Club de Lens », « Club Atlético de Madrid ») là où TheOddsAPI/les
 * bookmakers utilisent le nom court (« Marseille », « Lens », « Atletico
 * Madrid ») — ce n'est pas un problème d'accent/suffixe que
 * normalizeTeamName peut résoudre, la Premier League y échappe car les noms
 * anglais coïncident déjà (« Arsenal FC » -> « Arsenal » des deux côtés).
 * Comparaison par ENSEMBLE DE MOTS plutôt qu'inclusion de chaîne brute : un
 * mot inséré au milieu (« de », « club ») casserait une simple inclusion de
 * sous-chaîne. Accepte une correspondance si tous les mots du nom le plus
 * court apparaissent dans l'autre, jamais l'inverse — un nom à un seul mot
 * trop court (« as », « fc ») est ignoré pour éviter les faux positifs.
 * Best-effort : certains cas (nom de ville traduit, ex. « München » vs
 * « Munich », ou suffixe différent, ex. « Rennais » vs « Rennes ») restent
 * volontairement non couverts plutôt que de risquer un mauvais rapprochement.
 */
export function namesLikelyMatch(normalizedA: string, normalizedB: string): boolean {
  if (normalizedA === normalizedB) return true;
  if (normalizedA.length < 4 || normalizedB.length < 4) return false;

  // 1) Inclusion de sous-chaîne : couvre les cas où le nom court est un
  // PRÉFIXE du mot long (« Lyon » dans « Lyonnais »).
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;

  // 2) Ensemble de mots : couvre les cas où un mot est INSÉRÉ au milieu
  // (« Atletico Madrid » vs « Atletico DE Madrid »), que la simple
  // inclusion de sous-chaîne ne peut pas voir.
  const tokensA = normalizedA.split(' ').filter((t) => t.length > 0);
  const tokensB = normalizedB.split(' ').filter((t) => t.length > 0);
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  if (shorter.length === 0) return false;
  if (shorter.length === 1 && shorter[0].length < 4) return false; // mot unique trop générique

  const longerSet = new Set(longer);
  return shorter.every((token) => longerSet.has(token));
}
