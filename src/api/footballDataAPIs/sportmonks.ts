// Sportmonks Football API v3 — utilisé UNIQUEMENT comme confirmation "ce
// match est-il vraiment en 1ère/2e mi-temps maintenant ?" avant d'interroger
// Omniroute pour la minute précise (voir inPlayCombos.ts) — JAMAIS comme
// source de minute de jeu elle-même : contrairement au state_id (documenté,
// vérifié : voir STATE_ID_*), le champ exact portant la minute n'a pas pu
// être vérifié de façon fiable dans la documentation publique. Une minute
// devinée casserait silencieusement la fenêtre de checkpoint 20e/60e, donc
// on ne l'utilise pas : Sportmonks sert seulement de filtre "vaut le coup
// d'interroger Omniroute" plutôt que de tenter Omniroute à l'aveugle sur
// tout match proche de son coup d'envoi théorique.
//
// 3000 requêtes/jour, sans commune mesure avec les 100/jour d'API-Football —
// un seul appel par tour (comme /fixtures?live=all côté API-Football)
// suffit à couvrir tous les matchs en direct dans le monde.

import { fetchWithTimeout } from '../../core/httpTimeout';

const BASE_URL = 'https://api.sportmonks.com/v3/football';

// https://docs.sportmonks.com/v3/definitions/states
const STATE_ID_1ST_HALF = 2;
const STATE_ID_HALFTIME = 3;
const STATE_ID_2ND_HALF = 22;

export interface SportmonksInPlayMatch {
  homeTeam: string;
  awayTeam: string;
  half: '1H' | 'HT' | '2H';
}

/**
 * Tous les matchs actuellement en 1ère/2e mi-temps ou à la mi-temps, dans le
 * monde entier, en un seul appel. Jette en cas d'échec (clé absente, HTTP
 * en erreur) — à l'appelant de traiter ça comme "confirmation indisponible
 * ce tour", jamais comme "aucun match en direct".
 */
export async function fetchSportmonksInPlayMatches(apiToken: string): Promise<SportmonksInPlayMatch[]> {
  const response = await fetchWithTimeout(
    `${BASE_URL}/livescores?api_token=${encodeURIComponent(apiToken)}&include=participants`
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  const errorMessage = data.message || (Array.isArray(data.errors) ? data.errors.join(', ') : undefined);
  if (errorMessage) throw new Error(errorMessage);

  const matches: SportmonksInPlayMatch[] = [];
  for (const item of data.data || []) {
    const half: SportmonksInPlayMatch['half'] | null =
      item.state_id === STATE_ID_1ST_HALF ? '1H'
      : item.state_id === STATE_ID_HALFTIME ? 'HT'
      : item.state_id === STATE_ID_2ND_HALF ? '2H'
      : null;
    if (!half) continue;

    const participants: any[] = item.participants || [];
    const home = participants.find((p) => p.meta?.location === 'home');
    const away = participants.find((p) => p.meta?.location === 'away');
    if (!home?.name || !away?.name) continue;

    matches.push({ homeTeam: home.name, awayTeam: away.name, half });
  }
  return matches;
}
