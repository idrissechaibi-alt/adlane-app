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

function buildHeaders(config: BallDontLieConfig): Record<string, string> {
  return {
    'x-rapidapi-key': config.apiKey,
    'x-rapidapi-host': config.apiHost
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

// ==================== TRANSFORMERS ====================

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
    kickoff_utc: item.fixture.timestamp + 'Z',
    kickoff_local: item.fixture.timestamp + 'Z', // API-Football fournit en UTC
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
