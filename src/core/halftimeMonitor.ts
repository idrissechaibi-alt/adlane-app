// Lecture des matchs en direct (API-Football /fixtures?live=all) — utilisée
// par le scan Scouting (détection live) et par le scan 20e/60e minute
// (src/core/inPlayCombos.ts). Le combo de mi-temps qui vivait ici a été
// retiré (remplacé par le scan unifié 20e/60e minute).

import { fetchWithTimeout } from './httpTimeout';

export interface LiveFixture {
  statusShort: string; // '1H', 'HT', '2H', 'FT', ...
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  fixtureId: number;
  /** Minute de jeu actuelle (temps additionnel compris dans le décompte API-Football). */
  minute: number;
}

export function buildApiFootballHeaders(apiKey: string): Record<string, string> {
  return {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': 'v3.football.api-sports.io',
    'x-apisports-key': apiKey
  };
}

/**
 * Récupère TOUS les matchs actuellement en direct dans le monde (une seule
 * requête, filtrée ensuite côté client par nom d'équipe) — API-Football
 * n'offre pas de recherche live par équipe.
 */
export async function fetchLiveFixtures(apiKey: string): Promise<LiveFixture[]> {
  const response = await fetchWithTimeout('https://v3.football.api-sports.io/fixtures?live=all', {
    headers: buildApiFootballHeaders(apiKey)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();

  // API-Football répond souvent HTTP 200 même en cas de problème de clé/plan
  // (ex: "Missing application key", déjà rencontré sur /standings avec ce
  // compte) — l'erreur réelle est dans data.errors, jamais dans le statut
  // HTTP. Sans cette vérification, "aucun match en direct trouvé" et "l'appel
  // a échoué" sont indiscernables : impossible de savoir si un match
  // réellement en cours a juste été raté, ou si l'API a refusé la requête.
  const errors = data.errors;
  const hasErrors = errors && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors).length > 0);
  if (hasErrors) {
    const message = Array.isArray(errors) ? errors.join(', ') : Object.values(errors).join(', ');
    throw new Error(message || 'Erreur API-Football inconnue (data.errors non vide)');
  }

  return (data.response || []).map((item: any) => ({
    statusShort: item.fixture?.status?.short || '',
    homeTeam: item.teams?.home?.name || '',
    awayTeam: item.teams?.away?.name || '',
    homeGoals: item.goals?.home ?? 0,
    awayGoals: item.goals?.away ?? 0,
    fixtureId: item.fixture?.id,
    minute: item.fixture?.status?.elapsed ?? 0
  }));
}
