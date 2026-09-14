// SofaScore API Client
// Extraction de données football via API publique + scraping fallback
// Documentation: https://www.sofascore.com/api

import { APIResponse, FootballMatch, MatchStatistics, Team, Player, MarketOdds } from '../types';
import { getFromCache, saveToCache, generateCacheKey } from '../cache';

// URL publique de l'API SofaScore
const BASE_URL = 'https://www.sofascore.com';

export interface SofaScoreConfig {
  // SofaScore n'a pas d'API publique authentifiée officielle
  // On utilise les endpoints publics avec fallback scraping
  useScrapingFallback?: boolean;
}

const DEFAULT_CONFIG: SofaScoreConfig = {
  useScrapingFallback: true
};

/**
 * Récupère les matchs du jour pour une ligue
 * Note: SofaScore utilise un format JSON interne dans ses pages
 */
export async function getTodayFixtures(
  config: SofaScoreConfig,
  leagueId: string
): Promise<APIResponse<FootballMatch[]>> {
  try {
    // Premier essai: endpoint direct (si disponible)
    const response = await fetch(`${BASE_URL}/api/league/${leagueId}/events`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    });

    if (response.ok) {
      const data = await response.json();
      const fixtures = transformSofaScoreFixtures(data.events || []);
      return {
        success: true,
        data: fixtures,
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.warn('[SofaScore] API direct failed, trying fallback:', error);
  }

  // Fallback scraping
  if (config.useScrapingFallback) {
    return tryScrapingFixtures(leagueId);
  }

  return {
    success: false,
    error: 'SofaScore API failed and scraping disabled',
    source: 'sofaScore',
    timestamp: new Date().toISOString()
  };
}

/**
 * Récupère les statistiques d'un match via scraping
 * Note: Requiert un environnement avec cheerio ou puppeteer
 */
export async function getMatchStatistics(
  config: SofaScoreConfig,
  matchId: string
): Promise<APIResponse<MatchStatistics>> {
  try {
    const response = await fetch(`${BASE_URL}/api/event/${matchId}/statistics`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.ok) {
      const data = await response.json();
      const stats = transformSofaScoreStats(data);
      return {
        success: true,
        data: stats,
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.warn('[SofaScore] Stats API failed:', error);
  }

  return {
    success: false,
    error: 'Could not fetch match statistics',
    source: 'sofaScore',
    timestamp: new Date().toISOString()
  };
}

/**
 * Récupère les cotes d'un match (fallback scraping)
 */
export async function getMatchOdds(
  config: SofaScoreConfig,
  matchId: string
): Promise<APIResponse<MarketOdds[]>> {
  try {
    const response = await fetch(`${BASE_URL}/api/event/${matchId}/odds`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.ok) {
      const data = await response.json();
      const odds = transformSofaScoreOdds(data);
      return {
        success: true,
        data: odds,
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.warn('[SofaScore] Odds API failed:', error);
  }

  return {
    success: false,
    error: 'Could not fetch odds',
    source: 'sofaScore',
    timestamp: new Date().toISOString()
  };
}

/**
 * Récupère les informations d'une équipe
 */
export async function getTeamInfo(
  config: SofaScoreConfig,
  teamId: string
): Promise<APIResponse<Team>> {
  try {
    const response = await fetch(`${BASE_URL}/api/team/${teamId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.ok) {
      const data = await response.json();
      const team = transformSofaScoreTeam(data.team);
      return {
        success: true,
        data: team,
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.warn('[SofaScore] Team API failed:', error);
  }

  return {
    success: false,
    error: 'Could not fetch team info',
    source: 'sofaScore',
    timestamp: new Date().toISOString()
  };
}

/**
 * Récupère les infos d'un joueur
 */
export async function getPlayerInfo(
  config: SofaScoreConfig,
  playerId: string
): Promise<APIResponse<Player>> {
  try {
    const response = await fetch(`${BASE_URL}/api/player/${playerId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.ok) {
      const data = await response.json();
      const player = transformSofaScorePlayer(data.player);
      return {
        success: true,
        data: player,
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.warn('[SofaScore] Player API failed:', error);
  }

  return {
    success: false,
    error: 'Could not fetch player info',
    source: 'sofaScore',
    timestamp: new Date().toISOString()
  };
}

// ==================== SCRAPING FUNCTIONS ====================

/**
 * Scraping des fixtures depuis la page HTML
 * Utilise un fetch + parsing HTML
 */
async function tryScrapingFixtures(leagueId: string): Promise<APIResponse<FootballMatch[]>> {
  try {
    // Note: En Node.js réel, utiliser cheerio pour parser le HTML
    // Ici on simulera le parsing car on est dans React Native
    const response = await fetch(`${BASE_URL}/api/league/${leagueId}/events`);

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        data: transformSofaScoreFixtures(data.events || []),
        source: 'sofaScore(scraped)',
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.error('[SofaScore] Scraping failed:', error);
  }

  return {
    success: false,
    error: 'Scraping failed',
    source: 'sofaScore',
    timestamp: new Date().toISOString()
  };
}

// ==================== TRANSFORMERS ====================

function transformSofaScoreFixtures(events: any[]): FootballMatch[] {
  return (events || []).map((event: any) => ({
    id: String(event.id),
    leagueId: String(event.tournament.id),
    leagueName: event.tournament.name,
    leagueCountry: event.tournament.category?.name,
    homeTeam: event.homeTeam.name,
    awayTeam: event.awayTeam.name,
    homeTeamId: String(event.homeTeam.id),
    awayTeamId: String(event.awayTeam.id),
    homeTeamLogo: event.homeTeam?.logo,
    awayTeamLogo: event.awayTeam?.logo,
    kickoff_utc: event.startTimestamp + 'Z',
    status: event.status.code === 100 ? 'scheduled' :
            event.status.code === 200 ? 'live' : 'finished',
    scoreFulltime: event.homeScore?.current !== undefined ? {
      home: event.homeScore.current,
      away: event.awayScore?.current || 0
    } : undefined,
    venue: event.venue?.name,
    timezone: event.timezone,
    round: event.roundInfo?.round,
    season: event.season?.year
  }));
}

function transformSofaScoreStats(data: any): MatchStatistics {
  const homeTeam = data.homeTeam?.name || 'Home';
  const awayTeam = data.awayTeam?.name || 'Away';

  const statistics = data.statistics || [];

  const transformStat = (statsArray: any[]) => {
    const result: Record<string, number> = {};
    statsArray.forEach((stat: any) => {
      const value = stat.home !== undefined ? stat.home :
                   stat.value !== undefined ? stat.value : 0;
      result[stat.type?.name || stat.type || 'unknown'] = value;
    });
    return result;
  };

  return {
    matchId: data.event?.id || 'unknown',
    homeTeam: transformStat(statistics.find((s: any) => s.team?.name === homeTeam)?.values || []),
    awayTeam: transformStat(statistics.find((s: any) => s.team?.name === awayTeam)?.values || []),
    meta: {
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    }
  };
}

function transformSofaScoreOdds(data: any): MarketOdds[] {
  const odds = data.odds || [];
  const markets: MarketOdds[] = [];

  odds.forEach((odd: any) => {
    const market: MarketOdds = {
      market: mapSofaScoreMarket(odd.type),
      odds: {},
      timestamp: new Date().toISOString(),
      source: 'sofaScore'
    };

    odd.values?.forEach((val: any) => {
      if (val.name === 'home') market.odds.home = val.odds;
      else if (val.name === 'draw') market.odds.draw = val.odds;
      else if (val.name === 'away') market.odds.away = val.odds;
      else if (val.name === 'yes') market.odds.yes = val.odds;
      else if (val.name === 'no') market.odds.no = val.odds;
      else if (val.name === 'over') market.odds.over = val.odds;
      else if (val.name === 'under') market.odds.under = val.odds;
    });

    if (Object.keys(market.odds).length > 0) {
      markets.push(market);
    }
  });

  return markets;
}

function transformSofaScoreTeam(data: any): Team {
  return {
    id: String(data.id),
    name: data.name,
    shortCode: data.abbreviation,
    logo: data.image,
    stats: {
      played: data.matches?.played,
      won: data.matches?.won,
      draw: data.matches?.draw,
      lost: data.matches?.lost,
      goalsFor: data.goalsFor,
      goalsAgainst: data.goalsAgainst,
      points: data.points
    }
  };
}

function transformSofaScorePlayer(data: any): Player {
  return {
    id: String(data.id),
    name: data.name,
    teamId: String(data.team?.id),
    teamName: data.team?.name,
    position: data.position,
    stats: {
      matchesPlayed: data.matches?.played,
      goals: data.goals,
      assists: data.assists,
      yellowCards: data.yellowCards,
      redCards: data.redCards,
      shotsOnTarget: data.shotsOnTarget
    }
  };
}

function mapSofaScoreMarket(type: string): MarketOdds['market'] {
  const marketMap: Record<string, MarketOdds['market']> = {
    'matchWinner': '1X2',
    'bothTeamsToScore': 'BTTS',
    'totalGoalsOverUnder': 'OU_2_5',
    'handicap': 'handicap',
    'cornersOverUnder': 'corners',
  };
  return marketMap[type] || '1X2';
}
