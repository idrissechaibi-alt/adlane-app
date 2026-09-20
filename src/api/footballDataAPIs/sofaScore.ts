// SofaScore API Client
// Source de secours "scraping" : lit l'API publique (non officielle) de SofaScore.
// Aucune clé requise. Best-effort : SofaScore peut bloquer certaines requêtes
// (anti-bot Cloudflare) selon le réseau/l'IP ; en cas d'échec on renvoie
// simplement success:false, jamais de données inventées.

import { APIResponse, FootballMatch, MatchStatistics, Team, Player, MarketOdds } from '../types';

// Vrai domaine de l'API publique SofaScore (le code précédent appelait
// www.sofascore.com/api/... qui n'a jamais été un endpoint valide).
const BASE_URL = 'https://api.sofascore.com/api/v1';
const REQUEST_TIMEOUT_MS = 8000;

export interface SofaScoreConfig {
  useScrapingFallback?: boolean;
}

// Correspondance entre les identifiants de ligue utilisés dans l'app
// (identifiants API-Football, affichés dans le sélecteur "Données Foot")
// et le nom du tournoi tel que renvoyé par SofaScore, pour filtrer les
// matchs du jour (SofaScore expose tous les matchs par date, pas par ligue).
const LEAGUE_NAME_MATCH: Record<string, string[]> = {
  '39': ['premier league'],
  '140': ['la liga', 'laliga'],
  '135': ['serie a'],
  '78': ['bundesliga'],
  '61': ['ligue 1'],
  '2': ['champions league'],
};

function sofaScoreHeaders(): HeadersInit {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: sofaScoreHeaders(), signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Récupère les matchs du jour, filtrés sur une ligue.
 * SofaScore expose tous les matchs d'une date donnée (toutes ligues confondues) ;
 * on filtre ensuite côté client par nom de tournoi.
 */
export async function getTodayFixtures(
  config: SofaScoreConfig,
  leagueId: string
): Promise<APIResponse<FootballMatch[]>> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await fetchWithTimeout(`${BASE_URL}/sport/football/scheduled-events/${today}`);

    if (!response.ok) {
      return {
        success: false,
        error: `SofaScore a renvoyé HTTP ${response.status} (bloqué ou indisponible)`,
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }

    const data = await response.json();
    const allEvents: any[] = data.events || [];

    const matchTerms = LEAGUE_NAME_MATCH[leagueId];
    const filtered = matchTerms
      ? allEvents.filter((e) => {
          const name = (e.tournament?.name || '').toLowerCase();
          return matchTerms.some((term) => name.includes(term));
        })
      : allEvents;

    return {
      success: true,
      data: transformSofaScoreFixtures(filtered),
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    console.warn('[SofaScore] Échec récupération des matchs du jour:', error.message);
    return {
      success: false,
      error: error.message || 'SofaScore injoignable',
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  }
}

export async function getMatchStatistics(
  config: SofaScoreConfig,
  matchId: string
): Promise<APIResponse<MatchStatistics>> {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/event/${matchId}/statistics`);
    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        data: transformSofaScoreStats(data, matchId),
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
    return {
      success: false,
      error: `HTTP ${response.status}`,
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    console.warn('[SofaScore] Stats indisponibles:', error.message);
    return {
      success: false,
      error: error.message || 'Impossible de récupérer les statistiques',
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  }
}

export async function getMatchOdds(
  config: SofaScoreConfig,
  matchId: string
): Promise<APIResponse<MarketOdds[]>> {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/event/${matchId}/odds/1/all`);
    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        data: transformSofaScoreOdds(data),
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
    return {
      success: false,
      error: `HTTP ${response.status}`,
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    console.warn('[SofaScore] Cotes indisponibles:', error.message);
    return {
      success: false,
      error: error.message || 'Impossible de récupérer les cotes',
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  }
}

export async function getTeamInfo(
  config: SofaScoreConfig,
  teamId: string
): Promise<APIResponse<Team>> {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/team/${teamId}`);
    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        data: transformSofaScoreTeam(data.team),
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
    return {
      success: false,
      error: `HTTP ${response.status}`,
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    console.warn('[SofaScore] Équipe indisponible:', error.message);
    return {
      success: false,
      error: error.message || "Impossible de récupérer l'équipe",
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  }
}

export async function getPlayerInfo(
  config: SofaScoreConfig,
  playerId: string
): Promise<APIResponse<Player>> {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/player/${playerId}`);
    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        data: transformSofaScorePlayer(data.player),
        source: 'sofaScore',
        timestamp: new Date().toISOString()
      };
    }
    return {
      success: false,
      error: `HTTP ${response.status}`,
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    console.warn('[SofaScore] Joueur indisponible:', error.message);
    return {
      success: false,
      error: error.message || 'Impossible de récupérer le joueur',
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    };
  }
}

// ==================== TRANSFORMERS ====================

function transformSofaScoreFixtures(events: any[]): FootballMatch[] {
  return (events || []).map((event: any) => ({
    id: String(event.id),
    leagueId: String(event.tournament?.id ?? ''),
    leagueName: event.tournament?.name ?? '',
    leagueCountry: event.tournament?.category?.name,
    homeTeam: event.homeTeam?.name ?? '',
    awayTeam: event.awayTeam?.name ?? '',
    homeTeamId: String(event.homeTeam?.id ?? ''),
    awayTeamId: String(event.awayTeam?.id ?? ''),
    homeTeamLogo: event.homeTeam?.logo,
    awayTeamLogo: event.awayTeam?.logo,
    // startTimestamp est un epoch Unix en secondes, pas une chaîne ISO.
    kickoff_utc: typeof event.startTimestamp === 'number'
      ? new Date(event.startTimestamp * 1000).toISOString()
      : new Date().toISOString(),
    status: event.status?.code === 100 ? 'scheduled' :
            event.status?.code === 200 ? 'live' : 'finished',
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

function transformSofaScoreStats(data: any, matchId: string): MatchStatistics {
  const groups = data.statistics?.[0]?.groups || [];
  const flatten = (side: 'home' | 'away') => {
    const result: Record<string, number> = {};
    for (const group of groups) {
      for (const item of group.statisticsItems || []) {
        const raw = side === 'home' ? item.homeValue : item.awayValue;
        result[item.name] = typeof raw === 'number' ? raw : parseFloat(raw) || 0;
      }
    }
    return result;
  };

  return {
    matchId,
    homeTeam: flatten('home'),
    awayTeam: flatten('away'),
    meta: {
      source: 'sofaScore',
      timestamp: new Date().toISOString()
    }
  };
}

function transformSofaScoreOdds(data: any): MarketOdds[] {
  const markets: MarketOdds[] = [];
  const choices = data.markets || [];

  for (const marketData of choices) {
    const market: MarketOdds = {
      market: mapSofaScoreMarket(marketData.marketName),
      odds: {},
      timestamp: new Date().toISOString(),
      source: 'sofaScore'
    };

    for (const choice of marketData.choices || []) {
      const name = (choice.name || '').toLowerCase();
      const fractional = choice.fractionalValue ? parseOddsFraction(choice.fractionalValue) : undefined;
      if (fractional === undefined) continue;
      if (name === '1' || name === 'home') market.odds.home = fractional;
      else if (name === 'x' || name === 'draw') market.odds.draw = fractional;
      else if (name === '2' || name === 'away') market.odds.away = fractional;
      else if (name === 'yes') market.odds.yes = fractional;
      else if (name === 'no') market.odds.no = fractional;
      else if (name === 'over') market.odds.over = fractional;
      else if (name === 'under') market.odds.under = fractional;
    }

    if (Object.keys(market.odds).length > 0) {
      markets.push(market);
    }
  }

  return markets;
}

function parseOddsFraction(fractional: string): number | undefined {
  const [num, den] = fractional.split('/').map(Number);
  if (!num || !den) return undefined;
  return Number((num / den + 1).toFixed(2));
}

function transformSofaScoreTeam(data: any): Team {
  return {
    id: String(data.id),
    name: data.name,
    shortCode: data.nameCode,
    logo: undefined,
    stats: {}
  };
}

function transformSofaScorePlayer(data: any): Player {
  return {
    id: String(data.id),
    name: data.name,
    teamId: String(data.team?.id ?? ''),
    teamName: data.team?.name,
    position: data.position,
    stats: {}
  };
}

function mapSofaScoreMarket(name: string): MarketOdds['market'] {
  const normalized = (name || '').toLowerCase();
  if (normalized.includes('both teams to score')) return 'BTTS';
  if (normalized.includes('over/under') || normalized.includes('total')) return 'OU_2_5';
  if (normalized.includes('handicap')) return 'handicap';
  if (normalized.includes('corner')) return 'corners';
  return '1X2';
}
