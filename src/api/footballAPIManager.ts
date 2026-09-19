// Module principal pour gérer toutes les API Football
// Orchestre les appels avec fallback automatique

import { APIResponse, FootballMatch, MatchStatistics, Team, Player, MarketOdds, AllMatchOdds } from './types';
import * as ballDontLie from './footballDataAPIs/ballDontLie';
import * as sofaScore from './footballDataAPIs/sofaScore';
import * as footballData from './footballDataAPIs/footballData';
import * as theOddsAPI from './footballDataAPIs/theOddsAPI';
import * as openFootball from '../core/openFootballFallback';
import { incrementRequestCount } from './multiAPIManager';

// Sources exposées par multiAPIManager.ts (compteurs de requêtes / config utilisateur)
const REQUEST_COUNTER_SOURCE: Record<string, string> = {
  ballDontLie: 'apiFootball',
  footballData: 'footballData',
  theOddsAPI: 'theOddsApi',
  sofaScore: 'sofaScore',
};

// ==================== CONFIGURATION ====================

export interface FootballAPIConfig {
  ballDontLie?: ballDontLie.BallDontLieConfig;
  sofaScore?: sofaScore.SofaScoreConfig;
  footballData?: footballData.FootballDataConfig;
  theOddsAPI?: theOddsAPI.TheOddsAPIConfig;

  // Ordre de priorité des API
  priority?: ('ballDontLie' | 'sofaScore' | 'footballData' | 'theOddsAPI' | 'openFootball')[];

  // Fallback settings
  enableFallback: boolean;
  maxRetries: number;
}

export const DEFAULT_CONFIG: FootballAPIConfig = {
  ballDontLie: { apiKey: '', apiHost: 'v3.football.api-sports.io' },
  sofaScore: { useScrapingFallback: true },
  footballData: { apiKey: '' },
  theOddsAPI: { apiKey: '', region: 'us' },
  // openFootball en tout dernier : ni cotes ni stats, juste un filet de
  // sécurité pour ne jamais afficher 0 match quand tout le reste est indisponible.
  priority: ['ballDontLie', 'footballData', 'sofaScore', 'theOddsAPI', 'openFootball'],
  enableFallback: true,
  maxRetries: 2
};

// ==================== GESTIONNAIRE D'API ====================

export class FootballAPIManager {
  private config: FootballAPIConfig;

  constructor(config: FootballAPIConfig = DEFAULT_CONFIG) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Met à jour la configuration
   */
  setConfig(config: Partial<FootballAPIConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Récupère les fixtures avec fallback automatique
   */
  async getFixturesByDate(
    leagueId: string,
    date: string
  ): Promise<APIResponse<FootballMatch[]>> {
    const results: APIResponse<FootballMatch[]>[] = [];
    // Une réponse "réussie" mais avec 0 match (ex : mauvais league ID pour la
    // source, ou paramètre manquant côté API) ne doit PAS arrêter la
    // cascade — sinon les sources suivantes qui ont de vraies données ne sont
    // jamais essayées. On la garde de côté comme dernier recours seulement.
    let lastEmptySuccess: APIResponse<FootballMatch[]> | null = null;

    for (const source of this.config.priority!) {
      let result: APIResponse<FootballMatch[]>;

      switch (source) {
        case 'ballDontLie':
          if (this.config.ballDontLie?.apiKey) {
            await incrementRequestCount(REQUEST_COUNTER_SOURCE.ballDontLie);
            result = await ballDontLie.getFixturesByDate(this.config.ballDontLie, leagueId, date);
          } else {
            continue;
          }
          break;

        case 'footballData':
          if (this.config.footballData?.apiKey) {
            await incrementRequestCount(REQUEST_COUNTER_SOURCE.footballData);
            result = await footballData.getFixturesByDate(this.config.footballData, leagueId, date);
          } else {
            continue;
          }
          break;

        case 'sofaScore':
          await incrementRequestCount(REQUEST_COUNTER_SOURCE.sofaScore);
          result = await sofaScore.getTodayFixtures(this.config.sofaScore || {}, leagueId);
          break;

        case 'openFootball':
          result = await openFootball.getFixturesByDate(leagueId, date);
          break;

        default:
          continue;
      }

      results.push(result);

      if (result.success && result.data && result.data.length > 0) {
        console.log(`[API] Got fixtures from ${source}`);
        return result;
      }

      if (result.success) {
        console.log(`[API] ${source} répond mais 0 match, on essaie la source suivante`);
        lastEmptySuccess = result;
      } else {
        console.warn(`[API] ${source} failed: ${result.error}`);
      }
    }

    // Aucune source n'a de match : si au moins une a réellement répondu (juste
    // vide), on renvoie ce résultat honnête plutôt qu'une fausse erreur.
    if (lastEmptySuccess) {
      return lastEmptySuccess;
    }

    return {
      success: false,
      error: `All API sources failed: ${results.map(r => r.error).join(', ')}`,
      source: 'multiAPI',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Récupère les statistiques d'un match
   */
  async getMatchStatistics(
    matchId: string
  ): Promise<APIResponse<MatchStatistics>> {
    for (const source of this.config.priority!) {
      let result: APIResponse<MatchStatistics>;

      switch (source) {
        case 'ballDontLie':
          if (this.config.ballDontLie?.apiKey) {
            await incrementRequestCount(REQUEST_COUNTER_SOURCE.ballDontLie);
            result = await ballDontLie.getMatchStatistics(this.config.ballDontLie, matchId);
          } else {
            continue;
          }
          break;

        case 'footballData':
          if (this.config.footballData?.apiKey) {
            await incrementRequestCount(REQUEST_COUNTER_SOURCE.footballData);
            result = await footballData.getMatchStatistics(this.config.footballData, matchId);
          } else {
            continue;
          }
          break;

        case 'sofaScore':
          await incrementRequestCount(REQUEST_COUNTER_SOURCE.sofaScore);
          result = await sofaScore.getMatchStatistics(this.config.sofaScore || {}, matchId);
          break;

        default:
          continue;
      }

      if (result.success) {
        console.log(`[API] Got stats from ${source}`);
        return result;
      }
    }

    return {
      success: false,
      error: 'All API sources failed for match statistics',
      source: 'multiAPI',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Récupère les cotes pour un match
   */
  async getMatchOdds(
    matchId: string
  ): Promise<APIResponse<MarketOdds[]>> {
    for (const source of this.config.priority!) {
      let result: APIResponse<MarketOdds[]>;

      switch (source) {
        case 'theOddsAPI':
          if (this.config.theOddsAPI?.apiKey) {
            await incrementRequestCount(REQUEST_COUNTER_SOURCE.theOddsAPI);
            result = await theOddsAPI.getMatchOdds(this.config.theOddsAPI, matchId);
          } else {
            continue;
          }
          break;

        case 'sofaScore':
          await incrementRequestCount(REQUEST_COUNTER_SOURCE.sofaScore);
          result = await sofaScore.getMatchOdds(this.config.sofaScore || {}, matchId);
          break;

        default:
          continue;
      }

      if (result.success) {
        console.log(`[API] Got odds from ${source}`);
        return result;
      }
    }

    return {
      success: false,
      error: 'All API sources failed for odds',
      source: 'multiAPI',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Récupère les infos d'une équipe
   */
  async getTeamInfo(
    teamId: string
  ): Promise<APIResponse<Team>> {
    for (const source of this.config.priority!) {
      let result: APIResponse<Team>;

      switch (source) {
        case 'ballDontLie':
          if (this.config.ballDontLie?.apiKey) {
            await incrementRequestCount(REQUEST_COUNTER_SOURCE.ballDontLie);
            result = await ballDontLie.getTeamInfo(this.config.ballDontLie, teamId);
          } else {
            continue;
          }
          break;

        case 'footballData':
          if (this.config.footballData?.apiKey) {
            await incrementRequestCount(REQUEST_COUNTER_SOURCE.footballData);
            result = await footballData.getTeamInfo(this.config.footballData, teamId);
          } else {
            continue;
          }
          break;

        case 'sofaScore':
          await incrementRequestCount(REQUEST_COUNTER_SOURCE.sofaScore);
          result = await sofaScore.getTeamInfo(this.config.sofaScore || {}, teamId);
          break;

        default:
          continue;
      }

      if (result.success) {
        return result;
      }
    }

    return {
      success: false,
      error: 'All API sources failed for team info',
      source: 'multiAPI',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Récupère les infos d'un joueur
   */
  async getPlayerInfo(
    playerId: string
  ): Promise<APIResponse<Player>> {
    // SofaScore est la principale source pour les joueurs
    await incrementRequestCount(REQUEST_COUNTER_SOURCE.sofaScore);
    const result = await sofaScore.getPlayerInfo(this.config.sofaScore || {}, playerId);

    if (result.success) {
      return result;
    }

    return {
      success: false,
      error: 'Player info not available',
      source: 'multiAPI',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Récupère les fixtures du jour pour toutes les ligués
   */
  async getTodayAllLeagues(
    leagueIds: string[]
  ): Promise<APIResponse<FootballMatch[]>> {
    const allMatches: FootballMatch[] = [];
    const errors: string[] = [];

    for (const leagueId of leagueIds) {
      const result = await this.getFixturesByDate(leagueId, new Date().toISOString().split('T')[0]);
      if (result.success && result.data) {
        allMatches.push(...result.data);
      } else {
        errors.push(`League ${leagueId}: ${result.error}`);
      }
    }

    return {
      success: errors.length < leagueIds.length,
      data: allMatches.length > 0 ? allMatches : undefined,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      source: 'multiAPI',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Teste la connexion à toutes les API
   */
  async testAllAPIs(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    if (this.config.ballDontLie?.apiKey) {
      results.ballDontLie = await ballDontLie.testConnection(this.config.ballDontLie);
    }

    if (this.config.footballData?.apiKey) {
      results.footballData = await footballData.testConnection(this.config.footballData);
    }

    if (this.config.theOddsAPI?.apiKey) {
      results.theOddsAPI = await theOddsAPI.testConnection(this.config.theOddsAPI);
    }

    // SofaScore n'a pas de test de connexion simple
    results.sofaScore = true;

    return results;
  }
}

// ==================== FONCTIONS UTILITAIRES ====================

/**
 * Crée un manager avec la configuration par défaut
 */
export function createFootballAPIManager(config: Partial<FootballAPIConfig> = {}): FootballAPIManager {
  return new FootballAPIManager({ ...DEFAULT_CONFIG, ...config });
}

/**
 * Vérifie si une API est disponible
 */
export async function isAPIAvailable(
  apiName: 'ballDontLie' | 'footballData' | 'theOddsAPI',
  apiKey: string
): Promise<boolean> {
  switch (apiName) {
    case 'ballDontLie':
      return await ballDontLie.testConnection({ apiKey, apiHost: 'v3.football.api-sports.io' });
    case 'footballData':
      return await footballData.testConnection({ apiKey });
    case 'theOddsAPI':
      return await theOddsAPI.testConnection({ apiKey });
    default:
      return false;
  }
}
