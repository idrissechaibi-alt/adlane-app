// Historique Football-Data.co.uk — corners, cartons, fautes, arbitre.
//
// CSV en libre accès, un fichier par ligue et par saison, mis à jour chaque
// semaine (pas de scraping : juste un fetch() sur un fichier statique).
// Contient les stats de match ET les cotes de clôture, mais seule la partie
// "stats de match" nous intéresse ici — les cotes viennent déjà de
// TheOddsAPI/API-Football ailleurs dans l'app.
//
// Sert de PRIOR pré-match (moyenne sur la saison en cours) pour les marchés
// où la boucle d'auto-apprentissage n'a pas encore assez d'observations en
// direct — jamais pour remplacer une donnée live une fois disponible.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeTeamName } from './teamNameMatch';
import { fetchWithTimeout } from './httpTimeout';

const BASE_URL = 'https://www.football-data.co.uk/mmz4281';
const CACHE_KEY_PREFIX = '@fd_couk_csv_';

/**
 * Codes de ligue Football-Data.co.uk, indexés par l'identifiant de ligue
 * API-Football déjà utilisé ailleurs dans l'app (FootballDataScreen,
 * LEAGUE_ID_TO_ODDS_SPORT_KEY). Limité aux 5 grands championnats déjà
 * intégrés côté cotes — à étendre si besoin, Football-Data.co.uk couvre
 * aussi les divisions inférieures et d'autres pays.
 */
export const LEAGUE_ID_TO_FD_CODE: Record<string, string> = {
  '39': 'E0',   // Premier League
  '140': 'SP1', // La Liga
  '135': 'I1',  // Serie A
  '78': 'D1',   // Bundesliga
  '61': 'F1',   // Ligue 1
  '101': 'F1',
};

/**
 * L'app utilise DEUX conventions d'identifiant de ligue selon l'écran :
 * les IDs numériques API-Football (ci-dessus, utilisés par footballAPIManager
 * et FootballDataScreen) et les codes football-data.org (scheduler.ts /
 * ScoutingScreen, ex: "PL", "PD"). On accepte les deux ici pour ne pas
 * imposer à chaque appelant de connaître/convertir la convention interne de
 * ce module.
 */
const FD_ORG_CODE_TO_LEAGUE_ID: Record<string, string> = {
  'PL': '39', 'PD': '140', 'SA': '135', 'BL1': '78', 'FL1': '61',
};

function resolveLeagueId(leagueId: string): string {
  return FD_ORG_CODE_TO_LEAGUE_ID[leagueId] || leagueId;
}

/**
 * Alias des abréviations Football-Data.co.uk vers une forme normalisée
 * courante ("Man United" -> "manchester united"). Best-effort : couvre les
 * cas fréquents des 5 grands championnats, pas exhaustif. Une équipe sans
 * alias retombe sur la comparaison par recouvrement de mots ci-dessous.
 */
const NAME_ALIASES: Record<string, string> = {
  'man united': 'manchester united',
  'man city': 'manchester city',
  'newcastle': 'newcastle united',
  'nottm forest': 'nottingham forest',
  'wolves': 'wolverhampton',
  'spurs': 'tottenham',
  'leicester': 'leicester city',
  'west brom': 'west bromwich albion',
  'sheffield united': 'sheffield united',
  'brighton': 'brighton hove albion',
  "nott'm forest": 'nottingham forest',
  'atl. madrid': 'atletico madrid',
  'ath madrid': 'atletico madrid',
  'ath bilbao': 'athletic club',
  'sociedad': 'real sociedad',
  'celta': 'celta vigo',
  'betis': 'real betis',
  'inter': 'internazionale',
  'ac milan': 'milan',
  'paris sg': 'paris saint germain',
  'st etienne': 'saint etienne',
};

function seasonCode(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(-2)}${String(endYear).slice(-2)}`;
}

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

function resolveAlias(normalized: string): string {
  return NAME_ALIASES[normalized] || normalized;
}

/**
 * Un nom Football-Data.co.uk correspond-il à un nom d'équipe de l'app ?
 * Alias direct, sinon recouvrement de mots dans un sens ou l'autre — jamais
 * de correspondance par simple préfixe (trop de faux positifs entre équipes
 * d'une même ville).
 */
function namesMatch(fdName: string, appName: string): boolean {
  const a = resolveAlias(normalizeTeamName(fdName));
  const b = normalizeTeamName(appName);
  if (a === b) return true;

  const wordsA = new Set(a.split(' ').filter((w) => w.length > 2));
  const wordsB = new Set(b.split(' ').filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  const smaller = wordsA.size <= wordsB.size ? wordsA : wordsB;
  const larger = wordsA.size <= wordsB.size ? wordsB : wordsA;
  for (const word of smaller) {
    if (!larger.has(word)) return false;
  }
  return true;
}

interface CsvRow {
  homeTeam: string;
  awayTeam: string;
  homeCorners: number;
  awayCorners: number;
  homeCards: number; // jaunes + rouges
  awayCards: number;
  homeFouls: number;
  awayFouls: number;
  referee: string;
}

/** Parseur CSV minimal : suffisant pour les fichiers Football-Data.co.uk (pas de virgules dans les champs utilisés). */
function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/^﻿/, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',');
  const idx = (name: string) => headers.indexOf(name);

  const iHome = idx('HomeTeam');
  const iAway = idx('AwayTeam');
  const iHC = idx('HC'); const iAC = idx('AC');
  const iHY = idx('HY'); const iAY = idx('AY');
  const iHR = idx('HR'); const iAR = idx('AR');
  const iHF = idx('HF'); const iAF = idx('AF');
  const iRef = idx('Referee');

  if (iHome < 0 || iAway < 0) return [];

  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < headers.length) continue;

    rows.push({
      homeTeam: cols[iHome]?.trim() || '',
      awayTeam: cols[iAway]?.trim() || '',
      homeCorners: num(cols[iHC]),
      awayCorners: num(cols[iAC]),
      homeCards: num(cols[iHY]) + num(cols[iHR]),
      awayCards: num(cols[iAY]) + num(cols[iAR]),
      homeFouls: num(cols[iHF]),
      awayFouls: num(cols[iAF]),
      referee: cols[iRef]?.trim() || '',
    });
  }
  return rows;
}

async function fetchLeagueCsv(leagueId: string): Promise<CsvRow[] | null> {
  const fdCode = LEAGUE_ID_TO_FD_CODE[leagueId];
  if (!fdCode) return null;

  const cacheKey = `${CACHE_KEY_PREFIX}${fdCode}_${todayKey()}`;
  try {
    const cached = await AsyncStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // cache illisible : on retélécharge
  }

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/${seasonCode()}/${fdCode}.csv`);
    if (!response.ok) return null;

    const text = await response.text();
    const rows = parseCsv(text);
    await AsyncStorage.setItem(cacheKey, JSON.stringify(rows));
    return rows;
  } catch (error: any) {
    console.warn('[Football-Data.co.uk] Téléchargement échoué:', error.message);
    return null;
  }
}

export interface TeamHistoricalPriors {
  matchesPlayed: number;
  cornersFor: number;
  cornersAgainst: number;
  cardsFor: number;
  cardsAgainst: number;
  foulsFor: number;
  foulsAgainst: number;
}

function emptyPriors(): TeamHistoricalPriors {
  return { matchesPlayed: 0, cornersFor: 0, cornersAgainst: 0, cardsFor: 0, cardsAgainst: 0, foulsFor: 0, foulsAgainst: 0 };
}

function accumulate(priors: TeamHistoricalPriors, forCorners: number, againstCorners: number, forCards: number, againstCards: number, forFouls: number, againstFouls: number): TeamHistoricalPriors {
  return {
    matchesPlayed: priors.matchesPlayed + 1,
    cornersFor: priors.cornersFor + forCorners,
    cornersAgainst: priors.cornersAgainst + againstCorners,
    cardsFor: priors.cardsFor + forCards,
    cardsAgainst: priors.cardsAgainst + againstCards,
    foulsFor: priors.foulsFor + forFouls,
    foulsAgainst: priors.foulsAgainst + againstFouls,
  };
}

function average(priors: TeamHistoricalPriors): TeamHistoricalPriors {
  const n = priors.matchesPlayed || 1;
  return {
    matchesPlayed: priors.matchesPlayed,
    cornersFor: priors.cornersFor / n,
    cornersAgainst: priors.cornersAgainst / n,
    cardsFor: priors.cardsFor / n,
    cardsAgainst: priors.cardsAgainst / n,
    foulsFor: priors.foulsFor / n,
    foulsAgainst: priors.foulsAgainst / n,
  };
}

/**
 * Moyennes saison en cours pour les deux équipes d'un match, si le
 * championnat est couvert et que les deux noms sont reconnus dans le CSV.
 * Renvoie null plutôt qu'une estimation bancale si une équipe n'est pas
 * trouvée (promue sans historique, nom non reconnu, etc.).
 */
export async function getHistoricalPriors(
  leagueId: string,
  homeTeam: string,
  awayTeam: string
): Promise<{ home: TeamHistoricalPriors; away: TeamHistoricalPriors; refereeCardAvg: number | null } | null> {
  const rows = await fetchLeagueCsv(resolveLeagueId(leagueId));
  if (!rows || rows.length === 0) return null;

  let homeAcc = emptyPriors();
  let awayAcc = emptyPriors();
  const refereeCards: number[] = [];
  let sawHome = false;
  let sawAway = false;

  for (const row of rows) {
    const isHomeAsHome = namesMatch(row.homeTeam, homeTeam);
    const isHomeAsAway = namesMatch(row.awayTeam, homeTeam);
    const isAwayAsHome = namesMatch(row.homeTeam, awayTeam);
    const isAwayAsAway = namesMatch(row.awayTeam, awayTeam);

    if (isHomeAsHome) { homeAcc = accumulate(homeAcc, row.homeCorners, row.awayCorners, row.homeCards, row.awayCards, row.homeFouls, row.awayFouls); sawHome = true; }
    if (isHomeAsAway) { homeAcc = accumulate(homeAcc, row.awayCorners, row.homeCorners, row.awayCards, row.homeCards, row.awayFouls, row.homeFouls); sawHome = true; }
    if (isAwayAsHome) { awayAcc = accumulate(awayAcc, row.homeCorners, row.awayCorners, row.homeCards, row.awayCards, row.homeFouls, row.awayFouls); sawAway = true; }
    if (isAwayAsAway) { awayAcc = accumulate(awayAcc, row.awayCorners, row.homeCorners, row.awayCards, row.homeCards, row.awayFouls, row.homeFouls); sawAway = true; }

    if ((isHomeAsHome || isHomeAsAway || isAwayAsHome || isAwayAsAway) && row.referee) {
      refereeCards.push(row.homeCards + row.awayCards);
    }
  }

  if (!sawHome || !sawAway) return null;

  const refereeCardAvg = refereeCards.length > 0
    ? refereeCards.reduce((a, b) => a + b, 0) / refereeCards.length
    : null;

  return { home: average(homeAcc), away: average(awayAcc), refereeCardAvg };
}

export interface SingleMatchStats {
  corners: number; // total du match (domicile + extérieur)
  cards: number;
  fouls: number;
}

/**
 * Stats RÉELLES d'UN match déjà joué (pas une moyenne de saison) — sert à
 * régler objectivement les marchés corners/cartons du bilan Scouting IA
 * (scoutingReview.ts) avec une vraie source structurée plutôt qu'en devinant.
 * Une confrontation domicile/extérieur donnée n'a lieu qu'une fois par
 * saison (aller simple), donc les deux noms d'équipe suffisent à identifier
 * la ligne sans ambiguïté. Renvoie null si la ligue n'est pas couverte
 * (coupes nationales notamment) ou si le match n'est pas trouvé dans le CSV.
 */
export async function getMatchStats(
  leagueId: string,
  homeTeam: string,
  awayTeam: string
): Promise<SingleMatchStats | null> {
  const rows = await fetchLeagueCsv(resolveLeagueId(leagueId));
  if (!rows || rows.length === 0) return null;

  const row = rows.find((r) => namesMatch(r.homeTeam, homeTeam) && namesMatch(r.awayTeam, awayTeam));
  if (!row) return null;

  return {
    corners: row.homeCorners + row.awayCorners,
    cards: row.homeCards + row.awayCards,
    fouls: row.homeFouls + row.awayFouls,
  };
}
