// Outils de Scraping pour le Football
// Extraction de données depuis les pages HTML

import { APIResponse, FootballMatch, MatchStatistics, MarketOdds } from './types';

// ==================== CONFIGURATION ====================

export interface ScraperConfig {
  timeout?: number;
  userAgent?: string;
  useProxy?: boolean;
  maxRetries?: number;
}

const DEFAULT_CONFIG: ScraperConfig = {
  timeout: 30000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  useProxy: false,
  maxRetries: 3
};

// ==================== SCRAPER DE MATCHS ====================

/**
 * Scrappe les matchs depuis une page HTML
 * Utilise node-fetch et cheerio pour parser le HTML
 */
export async function scrapeMatchList(
  url: string,
  config: ScraperConfig = {}
): Promise<APIResponse<FootballMatch[]>> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': config.userAgent || DEFAULT_CONFIG.userAgent
      },
      timeout: config.timeout || DEFAULT_CONFIG.timeout
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'scraper', timestamp: new Date().toISOString() };
    }

    const html = await response.text();
    const matches = parseMatchListFromHTML(html, url);

    return {
      success: true,
      data: matches,
      source: 'scraper',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'scraper', timestamp: new Date().toISOString() };
  }
}

/**
 * Parse les matchs depuis le HTML
 */
function parseMatchListFromHTML(html: string, sourceUrl: string): FootballMatch[] {
  // Note: En environnement React Native, le parsing HTML nécessite une bibliothèque
  // Pour cette version, on utilise un parser simulé

  const matches: FootballMatch[] = [];

  // Simulation de parsing HTML
  // Dans une implémentation complète, utiliser cheerio:
  // const cheerio = require('cheerio');
  // const $ = cheerio.load(html);
  // $('.match-card').each((i, elem) => { ... })

  console.log(`[Scraper] Parsing HTML from ${sourceUrl}`);
  console.log('[Scraper] HTML length:', html.length);

  // Exemple de structure de parsing (à adapter selon le site cible)
  const dateRegex = /(\d{4})-(\d{2})-(\d{2})/g;
  const timeRegex = /(\d{2}):(\d{2})/g;

  // Extrait les données du HTML (méthode approximative)
  const teamsMatches = html.match(/"(.*?)".*?(.*?)<\/span>/g);

  if (teamsMatches) {
    for (let i = 0; i < teamsMatches.length; i += 2) {
      if (i + 1 < teamsMatches.length) {
        matches.push({
          id: `scraper_${i}`,
          leagueId: 'scraped',
          leagueName: 'Scraped League',
          homeTeam: extractTeamName(teamsMatches[i]),
          awayTeam: extractTeamName(teamsMatches[i + 1]),
          status: 'scheduled',
          kickoff_utc: new Date().toISOString(),
          source: 'scraper',
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  return matches;
}

function extractTeamName(str: string): string {
  // Extraction simplifiée du nom d'équipe
  const match = str.match(/>([^<]+)</);
  return match ? match[1].trim() : 'Unknown Team';
}

// ==================== SCRAPER DE COTES ====================

/**
 * Scrappe les cotes depuis une page de bookmaker
 */
export async function scrapeOddsPage(
  url: string,
  config: ScraperConfig = {}
): Promise<APIResponse<MarketOdds[]>> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': config.userAgent || DEFAULT_CONFIG.userAgent
      }
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'odds_scraper', timestamp: new Date().toISOString() };
    }

    const html = await response.text();
    const odds = parseOddsFromHTML(html);

    return {
      success: true,
      data: odds,
      source: 'odds_scraper',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'odds_scraper', timestamp: new Date().toISOString() };
  }
}

function parseOddsFromHTML(html: string): MarketOdds[] {
  const odds: MarketOdds[] = [];

  // Simulation de parsing des cotes
  // Dans une implémentation complète, extraire les cotes de manière précise

  const oddsMatches = html.match(/\d+\.\d+/g);

  if (oddsMatches && oddsMatches.length >= 3) {
    odds.push({
      market: '1X2',
      odds: {
        home: parseFloat(oddsMatches[0]),
        draw: parseFloat(oddsMatches[1]),
        away: parseFloat(oddsMatches[2])
      },
      timestamp: new Date().toISOString(),
      source: 'odds_scraper'
    });
  }

  return odds;
}

// ==================== SCRAPER DE STATS ====================

/**
 * Scrappe les statistiques d'un match
 */
export async function scrapeMatchStats(
  url: string,
  config: ScraperConfig = {}
): Promise<APIResponse<MatchStatistics>> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': config.userAgent || DEFAULT_CONFIG.userAgent
      }
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'stats_scraper', timestamp: new Date().toISOString() };
    }

    const html = await response.text();
    const stats = parseStatsFromHTML(html);

    return {
      success: true,
      data: stats,
      source: 'stats_scraper',
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'stats_scraper', timestamp: new Date().toISOString() };
  }
}

function parseStatsFromHTML(html: string): MatchStatistics {
  const stats: MatchStatistics = {
    matchId: 'scraped_stats',
    homeTeam: {},
    awayTeam: {},
    meta: {
      source: 'stats_scraper',
      timestamp: new Date().toISOString()
    }
  };

  // Simulation de parsing des stats
  const numberMatches = html.match(/\d+/g);

  if (numberMatches) {
    // Affecte des valeurs simulées
    stats.homeTeam.shotsTotal = parseInt(numberMatches[0]) || 0;
    stats.homeTeam.shotsOnTarget = parseInt(numberMatches[1] || '0');
    stats.awayTeam.shotsTotal = parseInt(numberMatches[2] || '0');
    stats.awayTeam.shotsOnTarget = parseInt(numberMatches[3] || '0');
  }

  return stats;
}

// ==================== UTILITAIRES ====================

/**
 * Vérifie si une URL est accessible
 */
export async function checkURLAvailability(
  url: string,
  config: ScraperConfig = {}
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': config.userAgent || DEFAULT_CONFIG.userAgent
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Nettoie le HTML pour extraire du texte
 */
export function cleanHTML(html: string): string {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrait toutes les URLs d'une page
 */
export function extractLinks(html: string): string[] {
  const links: string[] = [];
  const urlRegex = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = urlRegex.exec(html)) !== null) {
    links.push(match[1]);
  }

  return links;
}
