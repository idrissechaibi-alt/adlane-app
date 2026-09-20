// Client API-Football (BallDontLie via RapidAPI)
// Source principale pour fixtures et stats
// Documentation: https://www.api-sports.io/documentation

import { APIResponse, FootballMatch, MatchStatistics, Team } from '../types';
import { getFromCache, saveToCache, generateCacheKey, getCacheConfig } from '../cache';

const BASE_URL = 'https://v3.football.api-sports.io';

export interface BallDontLieConfig {
  apiKey: string;
  apiHost: string;
}

const DEFAULT_CONFIG: BallDontLieConfig = {
  apiKey: '',
  apiHost: 'v3.football.api-sports.io'
};

/**
 * API-Football a DEUX portes d'entrée avec des en-têtes différents : via
 * RapidAPI (x-rapidapi-key + x-rapidapi-host) ou en direct sur le dashboard
 * api-sports.io (x-apisports-key seul, sans host). On appelle toujours le
 * domaine direct (v3.football.api-sports.io), donc une clé du dashboard
 * direct renvoie "Missing application key" si on n'envoie que les en-têtes
 * RapidAPI. On envoie les deux jeux d'en-têtes : le serveur ignore ceux qu'il
 * ne reconnaît pas, donc ça marche quel que soit le type de clé de l'utilisateur.
 */
function buildHeaders(config: BallDontLieConfig): Record<string, string> {
  return {
    'x-rapidapi-key': config.apiKey,
    'x-rapidapi-host': config.apiHost,
    'x-apisports-key': config.apiKey
  };
}

/**
 * API-Football exige TOUJOURS "season" quand "league" est utilisé (sinon elle
 * renvoie HTTP 200 avec response: [] et une erreur "season is required" dans
 * errors — un succès silencieux mais vide, jamais des vrais matchs). La saison
 * correspond à l'année de DÉBUT de la saison européenne (juillet à juin).
 */
function seasonForDate(date: string): number {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12
  return month >= 7 ? year : year - 1;
}

/**
 * Vérifie la validité de la clé API
 */
export async function testConnection(config: BallDontLieConfig): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/status`, {
      headers: buildHeaders(config)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Récupère les matchs d'une journée pour une ligue
 */
export async function getFixturesByDate(
  config: BallDontLieConfig,
  leagueId: string,
  date: string
): Promise<APIResponse<FootballMatch[]>> {
  const cacheKey = generateCacheKey('fixtures', { leagueId, date });
  const cached = await getFromCache<FootballMatch[]>(cacheKey);

  if (cached) {
    return { success: true, data: cached, cacheHit: true, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }

  try {
    const season = seasonForDate(date);
    const response = await fetch(`${BASE_URL}/fixtures?league=${leagueId}&date=${date}&season=${season}`, {
      headers: buildHeaders(config)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'ballDontLie', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const apiError = data.errors && Object.keys(data.errors).length > 0
      ? Object.values(data.errors).join('; ')
      : null;
    if (apiError) {
      return { success: false, error: `API-Football: ${apiError}`, source: 'ballDontLie', timestamp: new Date().toISOString() };
    }

    const fixtures = data.response?.map((item: any) => transformMatch(item)) || [];

    await saveToCache(cacheKey, fixtures);

    return {
      success: true,
      data: fixtures,
      rateLimit: extractRateLimit(response),
      source: 'ballDontLie',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les matchs d'une ligue pour une saison
 */
export async function getFixturesBySeason(
  config: BallDontLieConfig,
  leagueId: string,
  season: number
): Promise<APIResponse<FootballMatch[]>> {
  try {
    const response = await fetch(`${BASE_URL}/fixtures?league=${leagueId}&season=${season}`, {
      headers: buildHeaders(config)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'ballDontLie', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const fixtures = data.response?.map((item: any) => transformMatch(item)) || [];

    return {
      success: true,
      data: fixtures,
      rateLimit: extractRateLimit(response),
      source: 'ballDontLie',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les statistiques d'un match
 */
export async function getMatchStatistics(
  config: BallDontLieConfig,
  matchId: string
): Promise<APIResponse<MatchStatistics>> {
  const cacheKey = generateCacheKey('stats', { matchId });
  const cached = await getFromCache<MatchStatistics>(cacheKey);

  if (cached) {
    return { success: true, data: cached, cacheHit: true, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }

  try {
    const response = await fetch(`${BASE_URL}/fixtures/statistics?fixture=${matchId}`, {
      headers: buildHeaders(config)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'ballDontLie', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const stats = transformStatistics(data);

    await saveToCache(cacheKey, stats);

    return {
      success: true,
      data: stats,
      rateLimit: extractRateLimit(response),
      source: 'ballDontLie',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les données d'une équipe
 */
export async function getTeamInfo(
  config: BallDontLieConfig,
  teamId: string
): Promise<APIResponse<Team>> {
  const cacheKey = generateCacheKey('team', { teamId });
  const cached = await getFromCache<Team>(cacheKey);

  if (cached) {
    return { success: true, data: cached, cacheHit: true, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }

  try {
    const response = await fetch(`${BASE_URL}/teams?id=${teamId}`, {
      headers: buildHeaders(config)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'ballDontLie', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const team = transformTeam(data.response?.[0]);

    await saveToCache(cacheKey, team);

    return {
      success: true,
      data: team,
      rateLimit: extractRateLimit(response),
      source: 'ballDontLie',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les résultats récents d'une équipe
 */
export async function getTeamLastMatches(
  config: BallDontLieConfig,
  teamId: string,
  count: number = 5
): Promise<APIResponse<FootballMatch[]>> {
  try {
    const response = await fetch(`${BASE_URL}/fixtures?team=${teamId}&last=${count}`, {
      headers: buildHeaders(config)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'ballDontLie', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const matches = data.response?.map((item: any) => transformMatch(item)) || [];

    return {
      success: true,
      data: matches,
      rateLimit: extractRateLimit(response),
      source: 'ballDontLie',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }
}

export interface StandingEntry {
  rank: number;
  teamName: string;
  teamLogo?: string;
  played: number;
  win: number;
  draw: number;
  lose: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsDiff: number;
  points: number;
  form?: string;
}

/**
 * Classement réel de la ligue (utilisé par l'écran Données Foot quand on
 * clique sur une compétition). Mis en cache comme le reste : le classement
 * ne change qu'après chaque journée jouée.
 */
export async function getStandings(
  config: BallDontLieConfig,
  leagueId: string,
  season?: number
): Promise<APIResponse<StandingEntry[]>> {
  const year = season ?? seasonForDate(new Date().toISOString());
  const cacheKey = generateCacheKey('standings', { leagueId, year });
  const cached = await getFromCache<StandingEntry[]>(cacheKey);

  if (cached) {
    return { success: true, data: cached, cacheHit: true, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }

  try {
    const response = await fetch(`${BASE_URL}/standings?league=${leagueId}&season=${year}`, {
      headers: buildHeaders(config)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'ballDontLie', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const apiError = data.errors && Object.keys(data.errors).length > 0
      ? Object.values(data.errors).join('; ')
      : null;
    if (apiError) {
      return { success: false, error: `API-Football: ${apiError}`, source: 'ballDontLie', timestamp: new Date().toISOString() };
    }

    // API-Football renvoie un tableau de groupes (poules) ; les 5 grands
    // championnats n'en ont qu'un seul, on prend le premier.
    const table = data.response?.[0]?.league?.standings?.[0] || [];
    const standings: StandingEntry[] = table.map((row: any) => ({
      rank: row.rank,
      teamName: row.team?.name || '',
      teamLogo: row.team?.logo,
      played: row.all?.played ?? 0,
      win: row.all?.win ?? 0,
      draw: row.all?.draw ?? 0,
      lose: row.all?.lose ?? 0,
      goalsFor: row.all?.goals?.for ?? 0,
      goalsAgainst: row.all?.goals?.against ?? 0,
      goalsDiff: row.goalsDiff ?? 0,
      points: row.points ?? 0,
      form: row.form,
    }));

    await saveToCache(cacheKey, standings);

    return { success: true, data: standings, source: 'ballDontLie', timestamp: new Date().toISOString() };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'ballDontLie', timestamp: new Date().toISOString() };
  }
}

// ==================== TRANSFORMERS ====================

/**
 * Date de coup d'envoi en ISO 8601, quelle que soit la forme renvoyée.
 * Renvoie une chaîne vide plutôt qu'une date invalide : l'affichage saura
 * dire "horaire indisponible" au lieu d'écrire "Invalid Date".
 */
function isoFromFixture(fixture: any): string {
  if (typeof fixture?.date === 'string' && fixture.date.length > 0) return fixture.date;
  if (typeof fixture?.timestamp === 'number') {
    return new Date(fixture.timestamp * 1000).toISOString();
  }
  return '';
}

function transformMatch(item: any): FootballMatch {
  return {
    id: String(item.fixture.id),
    leagueId: String(item.league.id),
    leagueName: item.league.name,
    leagueCountry: item.league.country,
    leagueLogo: item.league.logo,
    homeTeam: item.teams.home.name,
    awayTeam: item.teams.away.name,
    homeTeamId: String(item.teams.home.id),
    awayTeamId: String(item.teams.away.id),
    homeTeamLogo: item.teams.home.logo,
    awayTeamLogo: item.teams.away.logo,
    // API-Football expose `date` (ISO 8601 complet) et `timestamp` (epoch en
    // SECONDES). L'ancien code concaténait "Z" au timestamp numérique, ce qui
    // donnait "1758400000Z" -> Invalid Date à l'affichage.
    kickoff_utc: isoFromFixture(item.fixture),
    kickoff_local: isoFromFixture(item.fixture),
    status: item.fixture.status.short.toLowerCase() as any,
    scoreFulltime: item.score?.fulltime,
    scoreHalftime: item.score?.halftime,
    venue: item.fixture.venue?.name,
    timezone: item.fixture.venue?.timezone,
    round: item.league.round,
    season: item.league.season
  };
}

function transformStatistics(data: any): MatchStatistics {
  const statistics = data.response || [];

  const transformStats = (statsArray: any[]) => {
    const stats: Record<string, number> = {};
    statsArray.forEach((item: any) => {
      stats[item.type] = item.value;
    });
    return stats;
  };

  const homeStats = statistics.find((s: any) => s.team.name === data.request.teams.home);
  const awayStats = statistics.find((s: any) => s.team.name === data.request.teams.away);

  return {
    matchId: data.request.fixture.id,
    homeTeam: transformStats(homeStats?.statistics || []),
    awayTeam: transformStats(awayStats?.statistics || []),
    meta: {
      source: 'ballDontLie',
      timestamp: new Date().toISOString()
    }
  };
}

function transformTeam(data: any): Team {
  return {
    id: String(data.team.id),
    name: data.team.name,
    shortCode: data.team.code,
    logo: data.team.logo,
    leagueId: String(data.league.id),
    stats: {
      played: data.records.all.matched,
      won: data.records.all.won.value,
      draw: data.records.all.draw.value,
      lost: data.records.all.lost.value,
      goalsFor: data.goals.for.total,
      goalsAgainst: data.goals_against.total,
      points: data.points
    }
  };
}

function extractRateLimit(response: Response): { remaining: number; reset: string; limit: number } | undefined {
  const remaining = response.headers.get('X-RateLimit-Remaining');
  const reset = response.headers.get('X-RateLimit-Reset');
  const limit = response.headers.get('X-RateLimit-Limit');

  if (remaining && reset && limit) {
    return {
      remaining: parseInt(remaining),
      reset: new Date(parseInt(reset) * 1000).toISOString(),
      limit: parseInt(limit)
    };
  }
  return undefined;
}
