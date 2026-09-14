// The Odds API Client
// API de cotes sportives en temps réel
// Documentation: https://the-odds-api.com/documentation

import { APIResponse, MarketOdds, AllMatchOdds } from '../types';
import { getFromCache, saveToCache, generateCacheKey } from '../cache';

const BASE_URL = 'https://api.the-odds-api.com/v4';

export interface TheOddsAPIConfig {
  apiKey: string;
  region?: 'us' | 'uk' | 'eu' | 'au';
  market?: 'h2h' | 'spreads' | 'totals' | 'ou';
}

const DEFAULT_CONFIG: TheOddsAPIConfig = {
  apiKey: '',
  region: 'us',
  market: 'h2h'
};

export async function testConnection(config: TheOddsAPIConfig): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/sports?apiKey=${config.apiKey}`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Récupère les cotes pour un match spécifique
 */
export async function getMatchOdds(
  config: TheOddsAPIConfig,
  matchId: string,
  sport: string = 'americanfootball_nfl' // default, à adapter pour football
): Promise<APIResponse<MarketOdds[]>> {
  try {
    const response = await fetch(
      `${BASE_URL}/odds?apiKey=${config.apiKey}&sport=${sport}&match_id=${matchId}&regions=${config.region}&markets=${config.market}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'theOddsAPI', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const odds = transformOdds(data, matchId);

    return {
      success: true,
      data: odds,
      source: 'theOddsAPI',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'theOddsAPI', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère les cotes en direct pour plusieurs matchs
 */
export async function getLiveOdds(
  config: TheOddsAPIConfig,
  sport: string = 'americanfootball_nfl'
): Promise<APIResponse<AllMatchOdds[]>> {
  const cacheKey = generateCacheKey('odds_live', { sport });
  const cached = await getFromCache<AllMatchOdds[]>(cacheKey);

  if (cached) {
    return { success: true, data: cached, cacheHit: true, source: 'theOddsAPI', timestamp: new Date().toISOString() };
  }

  try {
    const response = await fetch(
      `${BASE_URL}/odds?apiKey=${config.apiKey}&sport=${sport}&regions=${config.region}&markets=${config.market}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'theOddsAPI', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const odds = data.map((item: any) => transformOddItem(item));

    await saveToCache(cacheKey, odds);

    return {
      success: true,
      data: odds,
      source: 'theOddsAPI',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'theOddsAPI', timestamp: new Date().toISOString() };
  }
}

/**
 * Récupère la liste des sports disponibles
 */
export async function listSports(config: TheOddsAPIConfig): Promise<APIResponse<any[]>> {
  try {
    const response = await fetch(`${BASE_URL}/sports?apiKey=${config.apiKey}&all=true`);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'theOddsAPI', timestamp: new Date().toISOString() };
    }

    const data = await response.json();

    return {
      success: true,
      data: data,
      source: 'theOddsAPI',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'theOddsAPI', timestamp: new Date().toISOString() };
  }
}

// ==================== TRANSFORMERS ====================

function transformOdds(data: any, matchId: string): MarketOdds[] {
  const markets: MarketOdds[] = [];

  data.forEach((odd: any) => {
    const market: MarketOdds = {
      market: mapOddsMarket(odd.market),
      odds: {},
      timestamp: new Date().toISOString(),
      source: 'theOddsAPI'
    };

    odd.bookmakers?.forEach((bookmaker: any) => {
      bookmaker.markets?.forEach((m: any) => {
        if (m.key === 'h2h') {
          m.outcomes?.forEach((o: any) => {
            if (o.name === odd.home_team) market.odds.home = o.price;
            else if (o.name === odd.away_team) market.odds.away = o.price;
          });
        } else if (m.key === 'spreads') {
          // Point spread - prendre le premier bookmaker
          m.outcomes?.forEach((o: any) => {
            if (o.name === odd.home_team) market.odds.home = o.price;
            else if (o.name === odd.away_team) market.odds.away = o.price;
          });
        } else if (m.key === 'totals') {
          m.outcomes?.forEach((o: any) => {
            if (o.name === 'Over') market.odds.over = o.price;
            else if (o.name === 'Under') market.odds.under = o.price;
          });
        }
      });
    });

    if (Object.keys(market.odds).length > 0) {
      markets.push(market);
    }
  });

  return markets;
}

function transformOddItem(item: any): AllMatchOdds {
  const match: any = {
    id: String(item.id),
    leagueId: item.competition_id,
    leagueName: item.competition_name,
    homeTeam: item.home_team,
    awayTeam: item.away_team,
    kickoff_utc: item.started + 'Z',
    status: item.started ? 'live' : 'scheduled'
  };

  const markets: MarketOdds[] = [];

  item.bookmakers?.forEach((bookmaker: any) => {
    bookmaker.markets?.forEach((m: any) => {
      const market: MarketOdds = {
        market: mapOddsMarket(m.key),
        odds: {},
        timestamp: new Date().toISOString(),
        source: `theOddsAPI_${bookmaker.key}`
      };

      m.outcomes?.forEach((o: any) => {
        if (o.name === item.home_team) market.odds.home = o.price;
        else if (o.name === item.away_team) market.odds.away = o.price;
        else if (o.name === 'Over') market.odds.over = o.price;
        else if (o.name === 'Under') market.odds.under = o.price;
        else if (o.name === 'Yes') market.odds.yes = o.price;
        else if (o.name === 'No') market.odds.no = o.price;
      });

      if (Object.keys(market.odds).length > 0) {
        markets.push(market);
      }
    });
  });

  return {
    matchId: String(item.id),
    match,
    markets,
    rawOdds: item
  };
}

function mapOddsMarket(key: string): MarketOdds['market'] {
  const marketMap: Record<string, MarketOdds['market']> = {
    'h2h': '1X2',
    'spreads': 'handicap',
    'totals': 'OU_2_5',
    'ou': 'OU_2_5',
    'btts': 'BTTS'
  };
  return marketMap[key] || '1X2';
}
