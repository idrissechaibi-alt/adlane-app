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

// Codes de compétition football-data.org -> clé "sport" TheOddsAPI. Les
// coupes nationales (FAC, CDR, DFB, CIT, CDF) ne sont volontairement pas
// mappées : TheOddsAPI ne les couvre pas de façon fiable.
export const FOOTBALL_DATA_TO_ODDS_SPORT_KEY: Record<string, string> = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  SA: 'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
};

/**
 * Même table, mais indexée par les identifiants de ligue utilisés dans
 * l'écran "Données Foot" (identifiants API-Football).
 */
export const LEAGUE_ID_TO_ODDS_SPORT_KEY: Record<string, string> = {
  '39': 'soccer_epl',
  '140': 'soccer_spain_la_liga',
  '135': 'soccer_italy_serie_a',
  '78': 'soccer_germany_bundesliga',
  '61': 'soccer_france_ligue_one',
  '101': 'soccer_france_ligue_one',
  '2': 'soccer_uefa_champs_league',
  '1': 'soccer_uefa_champs_league',
};

export interface SimpleMatchOdds {
  homeTeam: string;
  awayTeam: string;
  kickoff_utc: string;
  home?: number;
  draw?: number;
  away?: number;
  over_2_5?: number;
  under_2_5?: number;
}

/**
 * Récupère les cotes 1X2 + Over/Under 2.5 pour TOUS les matchs à venir d'une
 * compétition (une seule requête par compétition, pas par match — TheOddsAPI
 * n'expose pas de recherche par équipe). Le marché h2h pour le foot est à 3
 * issues (home/draw/away, "Draw" n'étant ni l'équipe domicile ni l'équipe
 * extérieure) — contrairement au sport US par défaut de ce fichier, d'où un
 * traitement dédié de l'issue "Draw".
 */
export async function fetchCompetitionOdds(
  apiKey: string,
  sportKey: string,
  region: 'us' | 'uk' | 'eu' | 'au' = 'eu'
): Promise<APIResponse<SimpleMatchOdds[]>> {
  try {
    const response = await fetch(
      `${BASE_URL}/sports/${sportKey}/odds?apiKey=${apiKey}&regions=${region}&markets=h2h,totals&oddsFormat=decimal`
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'theOddsAPI', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const results: SimpleMatchOdds[] = (data || []).map((event: any) => {
      const entry: SimpleMatchOdds = {
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        kickoff_utc: event.commence_time
      };

      // Prend le premier bookmaker disponible pour chaque marché (suffisant
      // pour une estimation, pas pour un comparatif multi-bookmakers).
      for (const bookmaker of event.bookmakers || []) {
        const h2h = bookmaker.markets?.find((m: any) => m.key === 'h2h');
        if (h2h && entry.home == null) {
          for (const o of h2h.outcomes || []) {
            if (o.name === event.home_team) entry.home = o.price;
            else if (o.name === event.away_team) entry.away = o.price;
            else if (o.name === 'Draw') entry.draw = o.price;
          }
        }

        const totals = bookmaker.markets?.find((m: any) => m.key === 'totals');
        if (totals && entry.over_2_5 == null) {
          const line = totals.outcomes?.find((o: any) => Math.abs((o.point ?? -1) - 2.5) < 0.01);
          if (line) {
            for (const o of totals.outcomes || []) {
              if (Math.abs((o.point ?? -1) - 2.5) < 0.01) {
                if (o.name === 'Over') entry.over_2_5 = o.price;
                else if (o.name === 'Under') entry.under_2_5 = o.price;
              }
            }
          }
        }

        if (entry.home != null && entry.over_2_5 != null) break;
      }

      return entry;
    });

    return { success: true, data: results, source: 'theOddsAPI', timestamp: new Date().toISOString() };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'theOddsAPI', timestamp: new Date().toISOString() };
  }
}
