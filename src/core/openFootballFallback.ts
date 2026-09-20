// Secours calendrier/résultats — openfootball/football.json.
//
// JSON en domaine public sur GitHub, un fichier par ligue et par saison.
// Aucune clé, aucune limite de débit connue (juste des fichiers statiques
// servis par raw.githubusercontent.com). Sert de DERNIER recours quand
// football-data.org ET API-Football sont tous les deux indisponibles
// (quota épuisé, panne) — il ne fournit ni cotes ni stats de match, donc il
// ne remplace jamais une source qui répond.

import { APIResponse, FootballMatch } from '../api/types';
import { fetchWithTimeout } from './httpTimeout';

const BASE_URL = 'https://raw.githubusercontent.com/openfootball/football.json/master';

/** Mêmes identifiants de ligue API-Football que le reste de l'app. */
const LEAGUE_ID_TO_OPENFOOTBALL_CODE: Record<string, string> = {
  '39': 'en.1',
  '140': 'es.1',
  '135': 'it.1',
  '78': 'de.1',
  '61': 'fr.1',
  '101': 'fr.1',
};

function seasonFolder(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(-2)}`;
}

interface RawMatch {
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score?: { ft?: [number, number] } | [number, number];
}

function transformMatch(raw: RawMatch, leagueId: string, index: number): FootballMatch {
  const kickoff = raw.time ? `${raw.date}T${raw.time}:00Z` : `${raw.date}T00:00:00Z`;
  const score = Array.isArray(raw.score) ? raw.score : raw.score?.ft;

  return {
    id: `of-${leagueId}-${index}`,
    leagueId,
    leagueName: '',
    homeTeam: raw.team1,
    awayTeam: raw.team2,
    kickoff_utc: kickoff,
    kickoff_local: kickoff,
    status: score ? 'finished' : 'scheduled',
    scoreFulltime: score ? { home: score[0], away: score[1] } : undefined,
    source: 'openFootball',
  };
}

/**
 * Matchs d'une ligue pour une date donnée (YYYY-MM-DD), dernier recours dans
 * la cascade de footballAPIManager.
 */
export async function getFixturesByDate(leagueId: string, date: string): Promise<APIResponse<FootballMatch[]>> {
  const code = LEAGUE_ID_TO_OPENFOOTBALL_CODE[leagueId];
  if (!code) {
    return { success: false, error: 'Ligue non couverte par openfootball', source: 'openFootball', timestamp: new Date().toISOString() };
  }

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/${seasonFolder()}/${code}.json`);
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, source: 'openFootball', timestamp: new Date().toISOString() };
    }

    const data = await response.json();
    const matches = ((data.matches || []) as RawMatch[])
      .map((m, i) => ({ raw: m, index: i }))
      .filter(({ raw }) => raw.date === date)
      .map(({ raw, index }) => transformMatch(raw, leagueId, index));

    return { success: true, data: matches, source: 'openFootball', timestamp: new Date().toISOString() };
  } catch (error: any) {
    return { success: false, error: error.message, source: 'openFootball', timestamp: new Date().toISOString() };
  }
}
