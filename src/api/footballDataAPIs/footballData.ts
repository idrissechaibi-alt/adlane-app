// Football-Data.org API Client
// Source publique pour fixtures, stats, et cotes
// Documentation: https://www.football-data.org/documentation

import { APIResponse, FootballMatch, MatchStatistics, Team } from '../types';
import { getFromCache, saveToCache, generateCacheKey } from '../cache';

const BASE_URL = 'https://api.football-data.org/v4';

export interface FootballDataConfig {
  apiKey: string;
  endpoint?: string;
}

const DEFAULT_CONFIG: FootballDataConfig = {
  apiKey: '',
  endpoint: BASE_URL
};

export async function testConnection(config: FootballDataConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.endpoint}/competitions`, {
      headers: {
        'X-Auth-Token': config.apiKey
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Récupère les matchs d'une ligue pour une journée
 */
export async function getFixturesByDate(
  config: FootballDataConfig,
  leagueId: string,
  date: string
): Promise<APIResponse<FootballMatch[]>> {
  const cacheKey = generateCacheKey('footballData_fixtures', { leagueId, date });
  const cached = await getFromCache<FootballMatch[]>(cacheKey);

  if (cached) {
    return { success: true, data: cached, cacheHit: true, source: 'footballData', timestamp: new Date().toISOString() };
  }

  try {
    const response = await fetch(`${config.endpoint}/competitions/${leagueId}/fixtures?date=${date}`, {
      headers: {
        'X-Auth-Token': config.apiKey
      }
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'footballData', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const fixtures = data.fixtures?.map((item: any) => transformMatch(item)) || [];

    await saveToCache(cacheKey, fixtures);

    return {
      success: true,
      data: fixtures,
      source: 'footballData',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'footballData', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les matchs d'une ligue pour une saison
 */
export async function getFixturesBySeason(
  config: FootballDataConfig,
  leagueId: string,
  season: number
): Promise<APIResponse<FootballMatch[]>> {
  try {
    const response = await fetch(`${config.endpoint}/competitions/${leagueId}/fixtures?season=${season}`, {
      headers: {
        'X-Auth-Token': config.apiKey
      }
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'footballData', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const fixtures = data.fixtures?.map((item: any) => transformMatch(item)) || [];

    return {
      success: true,
      data: fixtures,
      source: 'footballData',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'footballData', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les statistiques d'un match
 */
export async function getMatchStatistics(
  config: FootballDataConfig,
  matchId: string
): Promise<APIResponse<MatchStatistics>> {
  try {
    const response = await fetch(`${config.endpoint}/matches/${matchId}`, {
      headers: {
        'X-Auth-Token': config.apiKey
      }
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'footballData', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const stats = transformMatchStats(data);

    return {
      success: true,
      data: stats,
      source: 'footballData',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'footballData', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les données d'une équipe
 */
export async function getTeamInfo(
  config: FootballDataConfig,
  teamId: string
): Promise<APIResponse<Team>> {
  try {
    const response = await fetch(`${config.endpoint}/teams/${teamId}`, {
      headers: {
        'X-Auth-Token': config.apiKey
      }
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'footballData', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const team = transformTeam(data);

    return {
      success: true,
      data: team,
      source: 'footballData',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'footballData', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les matchs récents d'une équipe
 */
export async function getTeamLastMatches(
  config: FootballDataConfig,
  teamId: string,
  count: number = 5
): Promise<APIResponse<FootballMatch[]>> {
  try {
    const response = await fetch(`${config.endpoint}/teams/${teamId}/matches?limit=${count}`, {
      headers: {
        'X-Auth-Token': config.apiKey
      }
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'footballData', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const matches = data.matches?.map((item: any) => transformMatch(item)) || [];

    return {
      success: true,
      data: matches,
      source: 'footballData',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'footballData', timestamp: new Date().toISOString() };
  }
}

// ==================== TRANSFORMERS ====================

function transformMatch(item: any): FootballMatch {
  return {
    id: String(item.id),
    leagueId: String(item.competition?.id),
    leagueName: item.competition?.name,
    leagueCountry: item.competition?.area?.name,
    leagueLogo: item.competition?.logo,
    homeTeam: item.homeTeam?.name,
    awayTeam: item.awayTeam?.name,
    homeTeamId: String(item.homeTeam?.id),
    awayTeamId: String(item.awayTeam?.id),
    homeTeamLogo: item.homeTeam?.logo,
    awayTeamLogo: item.awayTeam?.logo,
    kickoff_utc: item.utcDate + 'Z',
    kickoff_local: item.utcDate,
    status: item.status?.toLowerCase() as any,
    scoreFulltime: item.score?.fulltime ? {
      home: item.score.fulltime.home,
      away: item.score.fulltime.away
    } : undefined,
    scoreHalftime: item.score?.halftime ? {
      home: item.score.halftime.home,
      away: item.score.halftime.away
    } : undefined,
    venue: item.venue?.name,
    timezone: item.utcDate,
    round: item.matchday,
    season: item.season?.year
  };
}

function transformMatchStats(data: any): MatchStatistics {
  const homeTeam = data.homeTeam?.name || 'Home';
  const awayTeam = data.awayTeam?.name || 'Away';

  const stats = data.statistics || [];

  const transformStats = (statsArray: any[]) => {
    const result: Record<string, number> = {};
    statsArray.forEach((stat: any) => {
      const values = stat.values || [];
      values.forEach((v: any) => {
        if (v.team?.name === homeTeam) result[stat.type] = v.value;
      });
    });
    return result;
  };

  return {
    matchId: String(data.id),
    homeTeam: transformStats(stats.filter((s: any) => s.team?.name === homeTeam)),
    awayTeam: transformStats(stats.filter((s: any) => s.team?.name === awayTeam)),
    meta: {
      source: 'footballData',
      timestamp: new Date().toISOString()
    }
  };
}

function transformTeam(data: any): Team {
  return {
    id: String(data.id),
    name: data.name,
    shortCode: data.code,
    logo: data.logo,
    stats: {
      played: data.playedGames,
      won: data.won,
      draw: data.draw,
      lost: data.lost,
      goalsFor: data.goalsFor,
      goalsAgainst: data.goalsAgainst,
      points: data.points
    }
  };
}
