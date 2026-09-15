// Outils de Scraping pour le Football
// Stub minimal pour React Native - le vrai scraping sera implémenté plus tard

import { APIResponse, FootballMatch, MatchStatistics, MarketOdds } from '../types';

export interface ScraperConfig {
  timeout?: number;
  userAgent?: string;
  useProxy?: boolean;
  maxRetries?: number;
}

const DEFAULT_CONFIG: ScraperConfig = {
  timeout: 30000,
  userAgent: 'Mozilla/5.0 (Linux; Android 10) Mobile Safari/537.36',
  useProxy: false,
  maxRetries: 3
};

// Stub - scraping pas implémenté pour le moment
export async function scrapeMatchList(
  _url: string,
  _config: ScraperConfig = DEFAULT_CONFIG
): Promise<APIResponse<FootballMatch[]>> {
  return {
    success: false,
    error: 'Scraping non implémenté dans cette version',
    source: 'scraper',
    timestamp: new Date().toISOString()
  };
}

export async function scrapeMatchDetails(
  _url: string,
  _config: ScraperConfig = DEFAULT_CONFIG
): Promise<APIResponse<FootballMatch>> {
  return {
    success: false,
    error: 'Scraping non implémenté dans cette version',
    source: 'scraper',
    timestamp: new Date().toISOString()
  };
}

export async function scrapeOdds(
  _url: string,
  _config: ScraperConfig = DEFAULT_CONFIG
): Promise<APIResponse<MarketOdds[]>> {
  return {
    success: false,
    error: 'Scraping non implémenté dans cette version',
    source: 'scraper',
    timestamp: new Date().toISOString()
  };
}

export async function scrapeMatchStats(
  _url: string,
  _config: ScraperConfig = DEFAULT_CONFIG
): Promise<APIResponse<MatchStatistics>> {
  return {
    success: false,
    error: 'Scraping non implémenté dans cette version',
    source: 'scraper',
    timestamp: new Date().toISOString()
  };
}