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
