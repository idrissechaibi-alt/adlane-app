// Sportmonks Football API v3 — DEUX usages, chacun borné à ce qui a pu être
// vérifié dans la documentation publique :
//
//   1. fetchSportmonksInPlayMatches : confirmation "ce match est-il vraiment
//      en 1ère/2e mi-temps maintenant ?" avant d'interroger Omniroute pour la
//      minute précise (voir inPlayCombos.ts) — JAMAIS comme source de minute
//      de jeu elle-même : contrairement au state_id (documenté, vérifié :
//      voir STATE_ID_*), le champ exact portant la minute n'a pas pu être
//      vérifié de façon fiable. Une minute devinée casserait silencieusement
//      la fenêtre de checkpoint 20e/60e, donc on ne l'utilise pas.
//   2. fetchSportmonksFixturesByDate : calendrier MONDIAL d'une date (toutes
//      divisions, tous pays couverts), utilisé par le programme fictif
//      (fictionalProgram.ts) comme découverte PRIMAIRE, à la place du
//      balayage pays-par-pays par agent Omniroute — flux de données
//      structuré, aucun risque de "circuit breaker" côté agents de
//      recherche. Omniroute ne reste qu'un filet de secours pour les pays
//      que cet appel n'aurait pas couverts.
//
// 3000 requêtes/jour, sans commune mesure avec les 100/jour d'API-Football —
// un seul appel par tour (comme /fixtures?live=all côté API-Football)
// suffit à couvrir tous les matchs en direct dans le monde, et la découverte
// du calendrier quotidien (usage 2 ci-dessus) reste modeste en comparaison
// (quelques pages paginées par jour).

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

export interface SportmonksFixture {
  homeTeam: string;
  awayTeam: string;
  league: string;
  /** Nom du pays TEL QUE renvoyé par Sportmonks (anglais) — à l'appelant de
   * le traduire vers ses propres libellés, ce fichier reste un simple client
   * API sans connaissance du domaine "programme fictif". */
  country: string;
  kickoffUtc: string;
}

interface SportmonksFixturesPage {
  fixtures: SportmonksFixture[];
  /** Curseur à repasser en paramètre `cursor` pour la page suivante, ou null
   * quand `pagination.has_more` est faux. */
  nextCursor: string | null;
}

/**
 * Une page du calendrier MONDIAL d'une date donnée, toutes divisions et tous
 * pays couverts par Sportmonks confondus (endpoint /fixtures/date/{date}).
 * Remplace, quand une clé est configurée, le balayage pays-par-pays par
 * agent Omniroute : un flux de données structuré plutôt qu'une recherche web
 * agent par agent, donc aucun "circuit breaker" possible ici. Pagination par
 * curseur — rappeler avec `nextCursor` tant qu'il n'est pas null.
 *
 * Jette en cas d'échec (clé absente, HTTP en erreur) — à l'appelant de
 * traiter ça comme "page indisponible ce tour", jamais comme "calendrier
 * vide".
 */
export async function fetchSportmonksFixturesByDate(
  apiToken: string,
  dateKey: string,
  cursor: string | null = null
): Promise<SportmonksFixturesPage> {
  const url =
    `${BASE_URL}/fixtures/date/${dateKey}?api_token=${encodeURIComponent(apiToken)}` +
    `&include=participants;league;league.country&per_page=50` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  const errorMessage = data.message || (Array.isArray(data.errors) ? data.errors.join(', ') : undefined);
  if (errorMessage) throw new Error(errorMessage);

  const fixtures: SportmonksFixture[] = [];
  for (const item of data.data || []) {
    const participants: any[] = item.participants || [];
    const home = participants.find((p) => p.meta?.location === 'home');
    const away = participants.find((p) => p.meta?.location === 'away');
    if (!home?.name || !away?.name) continue;

    const startingAt = typeof item.starting_at === 'string' ? item.starting_at : '';
    // Sportmonks renvoie "YYYY-MM-DD HH:MM:SS" en UTC (pas de décalage) —
    // reformaté en ISO strict pour rester comparable au reste de l'app.
    const kickoffUtc = startingAt ? `${startingAt.replace(' ', 'T')}Z` : '';
    if (!Number.isFinite(Date.parse(kickoffUtc))) continue;

    fixtures.push({
      homeTeam: home.name,
      awayTeam: away.name,
      league: typeof item.league?.name === 'string' ? item.league.name : 'Compétition inconnue',
      country: typeof item.league?.country?.name === 'string' ? item.league.country.name : '',
      kickoffUtc,
    });
  }

  const pagination = data.pagination || {};
  const nextCursor =
    pagination.has_more && typeof pagination.next_cursor === 'string' ? pagination.next_cursor : null;
  return { fixtures, nextCursor };
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
