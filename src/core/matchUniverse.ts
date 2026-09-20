// Univers de matchs du jour : jusqu'à 500 matchs, TOUTES divisions confondues,
// sur les pays suivis. Construit une fois par jour (1 à 3 requêtes seulement :
// API-Football renvoie toutes les rencontres d'une date en un appel, paginé).
//
// C'est la liste que la boucle d'auto-apprentissage observe en direct.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAPIConfig } from '../api/multiAPIManager';
import { spendBudget } from './requestBudget';
import { fetchWithTimeout } from './httpTimeout';

const UNIVERSE_KEY_PREFIX = '@match_universe_';
const MAX_UNIVERSE_SIZE = 500;
const MAX_PAGES = 3; // plafond dur de requêtes pour la construction quotidienne

/**
 * Pays suivis (libellés exactement tels qu'API-Football les renvoie).
 * Toutes les divisions de ces pays sont prises, pas seulement l'élite.
 */
export const TARGET_COUNTRIES = [
  'England', 'Scotland', 'Wales', 'Northern-Ireland', 'Ireland',
  'France', 'Spain', 'Germany', 'Italy', 'Portugal',
  'Belgium', 'Netherlands', 'Switzerland', 'Austria',
  'Poland', 'Czech-Republic', 'Slovakia', 'Croatia', 'Serbia',
  'Denmark', 'Norway', 'Sweden', 'Greece', 'Turkey', 'Ukraine',
  'Brazil', 'Argentina', 'Russia',
];

export interface UniverseMatch {
  fixtureId: number;
  league: string;
  leagueId: number;
  country: string;
  homeTeam: string;
  awayTeam: string;
  kickoff_utc: string;
}

function universeKey(date: string): string {
  return `${UNIVERSE_KEY_PREFIX}${date}`;
}

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

export async function getStoredUniverse(date: string = todayKey()): Promise<UniverseMatch[] | null> {
  try {
    const raw = await AsyncStorage.getItem(universeKey(date));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': 'v3.football.api-sports.io',
    'x-apisports-key': apiKey,
  };
}

/**
 * Priorise les matchs quand il y en a plus de 500 : d'abord les ligues sur
 * lesquelles l'utilisateur joue vraiment (focusLeagues), puis les pays en tête
 * de TARGET_COUNTRIES (ordre = importance), puis l'heure de coup d'envoi.
 */
function prioritize(matches: UniverseMatch[], focusLeagues: string[]): UniverseMatch[] {
  const focus = new Set(focusLeagues.map((l) => l.toLowerCase()));

  return [...matches].sort((a, b) => {
    const aFocus = focus.has(a.league.toLowerCase()) ? 0 : 1;
    const bFocus = focus.has(b.league.toLowerCase()) ? 0 : 1;
    if (aFocus !== bFocus) return aFocus - bFocus;

    const aCountry = TARGET_COUNTRIES.indexOf(a.country);
    const bCountry = TARGET_COUNTRIES.indexOf(b.country);
    if (aCountry !== bCountry) return aCountry - bCountry;

    return a.kickoff_utc.localeCompare(b.kickoff_utc);
  });
}

/**
 * Construit (ou relit) l'univers du jour. Idempotent : si l'univers du jour
 * existe déjà en cache, aucune requête réseau n'est faite.
 */
export async function ensureDailyUniverse(focusLeagues: string[] = []): Promise<UniverseMatch[]> {
  const date = todayKey();

  const cached = await getStoredUniverse(date);
  if (cached && cached.length > 0) return cached;

  const config = await getAPIConfig();
  if (!config.apiFootball) return [];

  const collected: UniverseMatch[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (!(await spendBudget('apiFootball'))) break; // quota du jour épuisé

    let payload: any;
    try {
      const response = await fetchWithTimeout(
        `https://v3.football.api-sports.io/fixtures?date=${date}&page=${page}`,
        { headers: buildHeaders(config.apiFootball) }
      );
      if (!response.ok) break;
      payload = await response.json();
    } catch (error: any) {
      console.warn('[Univers] Échec récupération des matchs du jour:', error.message);
      break;
    }

    for (const item of payload.response || []) {
      const country = item.league?.country;
      if (!TARGET_COUNTRIES.includes(country)) continue;

      collected.push({
        fixtureId: item.fixture?.id,
        league: item.league?.name || '',
        leagueId: item.league?.id,
        country,
        homeTeam: item.teams?.home?.name || '',
        awayTeam: item.teams?.away?.name || '',
        kickoff_utc: item.fixture?.date || '',
      });
    }

    const totalPages = payload.paging?.total ?? 1;
    if (page >= totalPages) break;
  }

  const universe = prioritize(collected, focusLeagues).slice(0, MAX_UNIVERSE_SIZE);
  await AsyncStorage.setItem(universeKey(date), JSON.stringify(universe));
  return universe;
}
