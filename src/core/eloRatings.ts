// Elo / pi-ratings — second avis indépendant du marché (rapport, item E).
//
// Idée : une note de force par équipe, mise à jour UNIQUEMENT à partir des
// résultats de matchs (jamais des cotes). Sert de recoupement : si le
// marché (dévigé) et l'Elo divergent fortement sur un match, c'est un signal
// à vérifier, pas une source à fusionner silencieusement dans les autres
// probabilités — d'où une fonction séparée, jamais mélangée dans poisson.ts.
//
// Implémentation : Elo classique avec avantage du terrain et multiplicateur
// d'écart de buts, sur le modèle documenté du "World Football Elo Ratings"
// (eloratings.net) — K=20, avantage terrain=100 points. Ce n'est PAS
// l'implémentation complète des pi-ratings de Constantinou & Fenton (qui
// suivent des sous-notes attaque/défense séparées domicile/extérieur et
// demandent leur propre jeu de données pour calibrer un taux
// d'apprentissage dédié) — un point de départ pragmatique, pas une
// reproduction académique du papier.
//
// Alimenté par openfootball/football.json (même source gratuite que le
// filet de secours des fixtures, item B) : aucun coût de quota API, mais de
// fait limité aux 5 grands championnats déjà couverts par ce fichier.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeTeamName } from './teamNameMatch';
import { fetchWithTimeout } from './httpTimeout';

const RATINGS_KEY = '@elo_ratings_v1';
const SYNC_COUNT_KEY_PREFIX = '@elo_synced_count_';

export const DEFAULT_RATING = 1500;
const K_FACTOR = 20;
const HOME_ADVANTAGE = 100;

/** Nombre minimum de matchs observés avant de faire confiance à une note. */
const MIN_MATCHES_FOR_OPINION = 5;

// Taux de nul moyen dans les 5 grands championnats européens, et vitesse à
// laquelle il diminue quand l'écart de niveau se creuse (heuristique, pas
// une calibration empirique comme le rho de Dixon-Coles).
const DRAW_BASE = 0.26;
const DRAW_DECAY = 200;

const OPENFOOTBALL_BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';

/** Mêmes codes que openFootballFallback.ts — 5 grands championnats couverts. */
const LEAGUE_CODES: Record<string, string> = {
  '39': 'en.1',
  '140': 'es.1',
  '135': 'it.1',
  '78': 'de.1',
  '61': 'fr.1',
  '101': 'fr.1',
};

export interface EloRating {
  rating: number;
  matchesPlayed: number;
}

type RatingsStore = Record<string, EloRating>; // clé = nom d'équipe normalisé

async function loadRatings(): Promise<RatingsStore> {
  try {
    const raw = await AsyncStorage.getItem(RATINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function saveRatings(store: RatingsStore): Promise<void> {
  await AsyncStorage.setItem(RATINGS_KEY, JSON.stringify(store));
}

function keyFor(team: string): string {
  return normalizeTeamName(team);
}

function getOrInit(store: RatingsStore, team: string): EloRating {
  const k = keyFor(team);
  if (!store[k]) store[k] = { rating: DEFAULT_RATING, matchesPlayed: 0 };
  return store[k];
}

/** Multiplicateur K selon l'écart de buts (World Football Elo Ratings). */
function goalDiffMultiplier(diff: number): number {
  const d = Math.abs(diff);
  if (d <= 1) return 1;
  if (d === 2) return 1.5;
  return (11 + d) / 8;
}

function applyResult(store: RatingsStore, home: string, away: string, goalsHome: number, goalsAway: number): void {
  const homeR = getOrInit(store, home);
  const awayR = getOrInit(store, away);

  const diff = homeR.rating + HOME_ADVANTAGE - awayR.rating;
  const expectedHome = 1 / (1 + Math.pow(10, -diff / 400));

  let actualHome: number;
  if (goalsHome > goalsAway) actualHome = 1;
  else if (goalsHome === goalsAway) actualHome = 0.5;
  else actualHome = 0;

  const mult = goalDiffMultiplier(goalsHome - goalsAway);
  const delta = K_FACTOR * mult * (actualHome - expectedHome);

  homeR.rating += delta;
  awayR.rating -= delta;
  homeR.matchesPlayed += 1;
  awayR.matchesPlayed += 1;
}

function seasonFolder(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

interface RawMatch {
  date: string;
  team1: string;
  team2: string;
  score?: { ft?: [number, number] } | [number, number];
}

/**
 * Rejoue les résultats d'une ligue non encore appliqués depuis la dernière
 * synchro (curseur = nombre de matchs terminés déjà traités). Idempotent et
 * gratuit : rappeler sans nouveau match terminé n'a aucun effet.
 */
export async function syncEloForLeague(leagueId: string): Promise<number> {
  const code = LEAGUE_CODES[leagueId];
  if (!code) return 0;

  let payload: { matches?: RawMatch[] };
  try {
    const response = await fetchWithTimeout(`${OPENFOOTBALL_BASE}/${seasonFolder()}/${code}.json`);
    if (!response.ok) return 0;
    payload = await response.json();
  } catch (error: any) {
    console.warn('[Elo] Synchro openfootball échouée:', error.message);
    return 0;
  }

  const finished = (payload.matches || [])
    .map((m) => ({ ...m, score: Array.isArray(m.score) ? m.score : m.score?.ft }))
    .filter((m): m is RawMatch & { score: [number, number] } => Array.isArray(m.score))
    .sort((a, b) => a.date.localeCompare(b.date));

  const syncKey = `${SYNC_COUNT_KEY_PREFIX}${code}`;
  const syncedCount = Number((await AsyncStorage.getItem(syncKey)) || '0');
  const newMatches = finished.slice(syncedCount);
  if (newMatches.length === 0) return 0;

  const store = await loadRatings();
  for (const m of newMatches) {
    applyResult(store, m.team1, m.team2, m.score[0], m.score[1]);
  }
  await saveRatings(store);
  await AsyncStorage.setItem(syncKey, String(finished.length));

  return newMatches.length;
}

/** À appeler une fois par jour (bilan de minuit) : synchronise les 5 championnats couverts. */
export async function syncEloForAllCoveredLeagues(): Promise<number> {
  let total = 0;
  for (const leagueId of new Set(Object.keys(LEAGUE_CODES))) {
    total += await syncEloForLeague(leagueId);
  }
  return total;
}

export interface EloSecondOpinion {
  home: number;
  draw: number;
  away: number;
  ratingHome: number;
  ratingAway: number;
  matchesHome: number;
  matchesAway: number;
}

/**
 * Second avis 1X2 basé uniquement sur la force Elo des deux équipes.
 * Renvoie null si l'une des deux équipes n'a pas assez d'historique observé
 * (promotion, nom non reconnu, championnat hors des 5 couverts) plutôt
 * qu'une estimation fondée sur la note par défaut, qui ne dirait rien.
 */
export async function getSecondOpinion(homeTeam: string, awayTeam: string): Promise<EloSecondOpinion | null> {
  const store = await loadRatings();
  const homeR = store[keyFor(homeTeam)];
  const awayR = store[keyFor(awayTeam)];
  if (!homeR || !awayR || homeR.matchesPlayed < MIN_MATCHES_FOR_OPINION || awayR.matchesPlayed < MIN_MATCHES_FOR_OPINION) {
    return null;
  }

  const diff = homeR.rating + HOME_ADVANTAGE - awayR.rating;
  const pHomeNoDraw = 1 / (1 + Math.pow(10, -diff / 400));
  const pDraw = DRAW_BASE * Math.exp(-Math.abs(diff) / DRAW_DECAY);
  const pHome = pHomeNoDraw * (1 - pDraw);
  const pAway = (1 - pHomeNoDraw) * (1 - pDraw);

  return {
    home: pHome,
    draw: pDraw,
    away: pAway,
    ratingHome: homeR.rating,
    ratingAway: awayR.rating,
    matchesHome: homeR.matchesPlayed,
    matchesAway: awayR.matchesPlayed,
  };
}
