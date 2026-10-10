// Client données live : LiveScore en priorité (aucun blocage), SofaScore en repli.
// Source de secours "scraping" : lit l'API publique (non officielle) de SofaScore.
// Aucune clé requise. Best-effort : SofaScore peut bloquer certaines requêtes
// (anti-bot Cloudflare) selon le réseau/l'IP ; en cas d'échec on renvoie
// simplement success:false, jamais de données inventées.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { APIResponse, FootballMatch, MatchStatistics, Team, Player, MarketOdds } from '../types';
import { syntheticFixtureId } from '../../core/halftimeMonitor';

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

async function fetchWithTimeout(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: sofaScoreHeaders(), signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// SofaScore refuse les connexions de l'app selon leur empreinte technique (pas
// selon les en-têtes : `curl` passe, le client réseau de l'app non). Le relais
// local (scripts/sofascore-relay.js, lancé dans Termux) refait la requête avec
// curl. Essayé d'abord ; injoignable = retenté seulement 5 min plus tard, puis
// connexion directe (qui passe selon le réseau).
const RELAY_BASE = 'http://localhost:8788/api/v1';
const RELAY_TIMEOUT_MS = 6000;
const RELAY_RETRY_MS = 5 * 60_000;
let relayDownUntil = 0;
let lastRoute: 'relais' | 'direct' | 'livescore' | null = null;

async function sofaFetch(path: string): Promise<Response> {
  if (Date.now() >= relayDownUntil) {
    try {
      const response = await fetchWithTimeout(`${RELAY_BASE}${path}`, RELAY_TIMEOUT_MS);
      // 403 = SofaScore refuse l'IP du moment (VPN coupé) : on tente la route
      // directe ensuite, et le relais est réessayé au prochain appel.
      if (response.status < 500 && response.status !== 403) {
        lastRoute = 'relais';
        return response;
      }
    } catch {
      relayDownUntil = Date.now() + RELAY_RETRY_MS;
    }
  }
  lastRoute = 'direct';
  return fetchWithTimeout(`${BASE_URL}${path}`);
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
    const response = await sofaFetch(`/sport/football/scheduled-events/${today}`);

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

export interface SofaScoreInPlayMatch {
  homeTeam: string;
  awayTeam: string;
}

/**
 * Tous les matchs actuellement EN COURS (football, toutes compétitions),
 * dans le monde entier — sert de confirmation avant d'interroger Omniroute
 * pour la minute précise (voir inPlayCombos.ts), exactement comme Sportmonks
 * (fetchSportmonksInPlayMatches). Repose UNIQUEMENT sur `status.type ===
 * 'inprogress'` : c'est le seul champ de statut confirmé de façon cohérente
 * par plusieurs sources indépendantes lors de l'intégration — jamais sur un
 * numéro de code de statut (valeurs contradictoires selon les sources
 * consultées), ni sur un champ de minute de jeu (jamais vérifié de façon
 * fiable, l'accès direct à l'API depuis cet environnement de développement
 * ayant été bloqué par leur protection anti-bot). Jette en cas d'échec — à
 * l'appelant de traiter ça comme "confirmation indisponible", jamais comme
 * "aucun match en direct" (voir le commentaire "best-effort" en tête de
 * fichier : ce blocage réseau est documenté comme dépendant du réseau/IP).
 */
export async function getInPlayMatches(): Promise<SofaScoreInPlayMatch[]> {
  const today = new Date().toISOString().split('T')[0];
  const response = await sofaFetch(`/sport/football/scheduled-events/${today}`);
  if (!response.ok) throw new Error(`SofaScore a renvoyé HTTP ${response.status}`);

  const data = await response.json();
  const events: any[] = data.events || [];

  const matches: SofaScoreInPlayMatch[] = [];
  for (const event of events) {
    if (event.status?.type !== 'inprogress') continue;
    const homeTeam = event.homeTeam?.name;
    const awayTeam = event.awayTeam?.name;
    if (!homeTeam || !awayTeam) continue;
    matches.push({ homeTeam, awayTeam });
  }
  return matches;
}

export async function getMatchStatistics(
  config: SofaScoreConfig,
  matchId: string
): Promise<APIResponse<MatchStatistics>> {
  try {
    const response = await sofaFetch(`/event/${matchId}/statistics`);
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
    const response = await sofaFetch(`/event/${matchId}/odds/1/all`);
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
    const response = await sofaFetch(`/team/${teamId}`);
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
    const response = await sofaFetch(`/player/${playerId}`);
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

// ==================== PIPELINE FICTIF : DIRECT, STATISTIQUES, RÉSULTATS ====================
//
// Source STRUCTURÉE et gratuite des matchs du reste du monde : tous les
// matchs en direct (score, période, minute), le programme du jour, les
// statistiques par période (match entier / 1ère mi-temps : corners, cartons,
// fautes, tirs) et les résultats. Évite de passer par une recherche web + un
// modèle pour des chiffres que SofaScore publie directement.

export interface SofaEvent {
  eventId: number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  /** Pays tel que renvoyé par SofaScore (anglais). */
  country: string;
  /** '1H' | 'HT' | '2H' | 'FT' | 'NS' (pas commencé) | 'OTHER' (reporté, annulé…). */
  statusShort: string;
  minute: number;
  homeGoals: number;
  awayGoals: number;
  homeGoalsHT: number;
  awayGoalsHT: number;
  startTimestamp: number;
}

function mapSofaEvent(e: any): SofaEvent | null {
  const homeTeam = e?.homeTeam?.name;
  const awayTeam = e?.awayTeam?.name;
  if (!e?.id || !homeTeam || !awayTeam) return null;

  const type = e.status?.type;
  const code = e.status?.code;
  const description = String(e.status?.description ?? '').toLowerCase();
  let statusShort = 'OTHER';
  let minute = 0;

  if (type === 'inprogress') {
    if (code === 31 || description === 'halftime') {
      statusShort = 'HT';
      minute = 45;
    } else if (code === 7 || description.includes('2nd')) {
      statusShort = '2H';
    } else if (code === 6 || description.includes('1st')) {
      statusShort = '1H';
    } else {
      statusShort = 'OTHER'; // prolongation, tirs au but…
    }
    if (statusShort === '1H' || statusShort === '2H') {
      const start = Number(e.time?.currentPeriodStartTimestamp);
      const initial = Number(e.time?.initial ?? 0);
      if (Number.isFinite(start) && start > 0) {
        minute = Math.floor((Date.now() / 1000 - start + initial) / 60) + 1;
      }
    }
  } else if (type === 'finished') {
    statusShort = 'FT';
    minute = 90;
  } else if (type === 'notstarted') {
    statusShort = 'NS';
  }

  return {
    eventId: e.id,
    homeTeam,
    awayTeam,
    league: e.tournament?.name || e.tournament?.uniqueTournament?.name || 'Compétition inconnue',
    country: e.tournament?.category?.name || '',
    statusShort,
    minute: Math.max(0, minute),
    homeGoals: e.homeScore?.current ?? 0,
    awayGoals: e.awayScore?.current ?? 0,
    homeGoalsHT: e.homeScore?.period1 ?? 0,
    awayGoalsHT: e.awayScore?.period1 ?? 0,
    startTimestamp: Number(e.startTimestamp) || 0,
  };
}

const SOFA_STATUS_KEY = '@sofascore_status';

async function recordSofaStatus(entry: { liveCount?: number; error?: string | null }): Promise<void> {
  try {
    await AsyncStorage.setItem(SOFA_STATUS_KEY, JSON.stringify({ ...entry, route: lastRoute, at: new Date().toISOString() }));
  } catch {
    // diagnostic best-effort
  }
}

/** Dernier état de SofaScore (diagnostic) : nombre de matchs en direct ou erreur. */
export async function getSofaStatus(): Promise<{ liveCount?: number; error?: string | null; route?: 'relais' | 'direct' | 'livescore' | null; at: string } | null> {
  try {
    const raw = await AsyncStorage.getItem(SOFA_STATUS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function getJson(path: string): Promise<any> {
  const response = await sofaFetch(path);
  if (!response.ok) throw new Error(`SofaScore HTTP ${response.status}`);
  return response.json();
}

/** Tous les matchs de football EN DIRECT dans le monde (un seul appel). */
export async function fetchSofaLiveEvents(): Promise<SofaEvent[]> {
  let liveScoreError: any = null;
  try {
    const events = await fetchLiveScoreLive();
    lastRoute = 'livescore';
    await recordSofaStatus({ liveCount: events.length, error: null });
    return events;
  } catch (error) {
    liveScoreError = error;
  }
  try {
    const data = await getJson('/sport/football/events/live');
    const events = ((data.events ?? []) as any[]).map(mapSofaEvent).filter((e): e is SofaEvent => e !== null);
    await recordSofaStatus({ liveCount: events.length, error: null });
    return events;
  } catch (error: any) {
    await recordSofaStatus({ error: `LiveScore : ${liveScoreError?.message || 'injoignable'} · SofaScore : ${error?.message || 'injoignable'}` });
    throw error;
  }
}

/** Programme (tous les matchs de football) d'une date UTC. */
export async function fetchSofaScheduledEvents(dateKey: string): Promise<SofaEvent[]> {
  try {
    return await fetchLiveScoreDate(dateKey);
  } catch {
    // repli SofaScore
  }
  const data = await getJson(`/sport/football/scheduled-events/${dateKey}`);
  return ((data.events ?? []) as any[]).map(mapSofaEvent).filter((e): e is SofaEvent => e !== null);
}

/** Détail d'un match (statut, minute, score, score à la mi-temps). */
export async function fetchSofaEvent(eventId: number): Promise<SofaEvent | null> {
  if (eventId < 0) return fetchLiveScoreEvent(-eventId);
  const data = await getJson(`/event/${eventId}`);
  return mapSofaEvent(data.event);
}

export interface SofaPeriodStats {
  corners: number;
  cards: number;
  fouls: number;
  shotsOnTargetHome: number;
  shotsOnTargetAway: number;
  shotsTotalHome: number;
  shotsTotalAway: number;
  cornersHome: number;
  cornersAway: number;
  cardsHome: number;
  cardsAway: number;
  foulsHome: number;
  foulsAway: number;
  possessionHome?: number;
}

export interface SofaStats {
  /** Match entier. */
  all: SofaPeriodStats | null;
  /** 1ère mi-temps seulement (null si SofaScore ne la publie pas). */
  firstHalf: SofaPeriodStats | null;
}

function statItem(period: any, key: string): { home: number; away: number } | null {
  for (const group of period?.groups ?? []) {
    for (const item of group.statisticsItems ?? []) {
      if (item.key === key) {
        const home = Number(item.homeValue);
        const away = Number(item.awayValue);
        if (Number.isFinite(home) && Number.isFinite(away)) return { home, away };
      }
    }
  }
  return null;
}

function parsePeriod(period: any): SofaPeriodStats | null {
  if (!period) return null;
  const corners = statItem(period, 'cornerKicks');
  const yellow = statItem(period, 'yellowCards');
  const red = statItem(period, 'redCards');
  const fouls = statItem(period, 'fouls');
  const onTarget = statItem(period, 'shotsOnGoal');
  const shots = statItem(period, 'totalShotsOnGoal');
  const possession = statItem(period, 'ballPossession');
  // Aucune des statistiques utiles : période non publiée pour ce match.
  if (!corners && !yellow && !fouls && !onTarget) return null;
  // Tout à zéro (ni corner, ni faute, ni tir, ni carton) : divisions
  // inférieures où SofaScore ne publie aucune statistique — pas un match sans
  // le moindre événement. Mieux vaut "pas de donnée" qu'un faux zéro.
  const sum = (stat: { home: number; away: number } | null) => (stat ? stat.home + stat.away : 0);
  if (sum(corners) + sum(yellow) + sum(red) + sum(fouls) + sum(onTarget) + sum(shots) === 0) return null;

  // SofaScore omet une statistique à zéro (ex. aucun carton rouge) : absente = 0.
  const cardsHome = (yellow?.home ?? 0) + (red?.home ?? 0);
  const cardsAway = (yellow?.away ?? 0) + (red?.away ?? 0);
  return {
    corners: (corners?.home ?? 0) + (corners?.away ?? 0),
    cards: cardsHome + cardsAway,
    fouls: (fouls?.home ?? 0) + (fouls?.away ?? 0),
    shotsOnTargetHome: onTarget?.home ?? 0,
    shotsOnTargetAway: onTarget?.away ?? 0,
    shotsTotalHome: shots?.home ?? 0,
    shotsTotalAway: shots?.away ?? 0,
    cornersHome: corners?.home ?? 0,
    cornersAway: corners?.away ?? 0,
    cardsHome,
    cardsAway,
    foulsHome: fouls?.home ?? 0,
    foulsAway: fouls?.away ?? 0,
    possessionHome: possession?.home,
  };
}

/** Statistiques d'un match, match entier et 1ère mi-temps. */
export async function fetchSofaStats(eventId: number): Promise<SofaStats> {
  if (eventId < 0) return fetchLiveScoreStats(-eventId);
  const data = await getJson(`/event/${eventId}/statistics`);
  const periods: any[] = data.statistics ?? [];
  return {
    all: parsePeriod(periods.find((p) => p.period === 'ALL')),
    firstHalf: parsePeriod(periods.find((p) => p.period === '1ST')),
  };
}

// ---------- Correspondance identifiant synthétique <-> match SofaScore ----------

const SOFA_IDS_KEY = '@sofascore_event_ids';
const SOFA_IDS_KEEP_MS = 3 * 24 * 3_600_000;
let sofaIds: Record<string, { id: number; at: number }> | null = null;
let sofaIdsDirty = false;

async function loadSofaIds(): Promise<Record<string, { id: number; at: number }>> {
  if (sofaIds) return sofaIds;
  try {
    const raw = await AsyncStorage.getItem(SOFA_IDS_KEY);
    sofaIds = raw ? JSON.parse(raw) : {};
  } catch {
    sofaIds = {};
  }
  return sofaIds!;
}

/** Date UTC (YYYY-MM-DD) du coup d'envoi — base de l'identifiant synthétique. */
export function sofaDateKey(event: SofaEvent): string {
  return new Date((event.startTimestamp || Date.now() / 1000) * 1000).toISOString().split('T')[0];
}

/** Identifiant synthétique d'un match SofaScore, mémorisé pour retrouver ses statistiques et son résultat. */
export async function registerSofaEvents(events: SofaEvent[], dateKey?: string): Promise<Map<number, number>> {
  const store = await loadSofaIds();
  const byEventId = new Map<number, number>();
  const now = Date.now();
  for (const event of events) {
    const fixtureId = syntheticFixtureId(event.homeTeam, event.awayTeam, dateKey ?? sofaDateKey(event));
    byEventId.set(event.eventId, fixtureId);
    if (store[fixtureId]?.id !== event.eventId) {
      store[fixtureId] = { id: event.eventId, at: now };
      sofaIdsDirty = true;
    }
  }
  if (sofaIdsDirty) {
    for (const key of Object.keys(store)) if (now - store[key].at > SOFA_IDS_KEEP_MS) delete store[key];
    sofaIdsDirty = false;
    try {
      await AsyncStorage.setItem(SOFA_IDS_KEY, JSON.stringify(store));
    } catch {
      // mémoire best-effort
    }
  }
  return byEventId;
}

export async function getSofaEventId(fixtureId: number): Promise<number | null> {
  const store = await loadSofaIds();
  return store[fixtureId]?.id ?? null;
}


// ---------- LiveScore (prod-public-api.livescore.com) ----------
// API publique de l'app LiveScore : sans clé, sans blocage d'IP ni d'empreinte
// (contrairement à SofaScore, qui refuse le réseau de l'utilisateur). Couvre
// tous les matchs du monde : direct, programme par date, score à la
// mi-temps, statistiques par période (corners, cartons, fautes, tirs).
// Ses matchs portent un identifiant NÉGATIF (-Eid) pour ne jamais se
// confondre avec un identifiant SofaScore dans la table de correspondance.

const LIVESCORE_BASE = 'https://prod-public-api.livescore.com/v1/api/app';

async function liveScoreJson(path: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${LIVESCORE_BASE}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`LiveScore HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** "55'" → 55, "45+2'" → 47 ; null si ce n'est pas une minute de jeu. */
function parseLiveScoreMinute(eps: string): number | null {
  const m = /^(\d+)(?:\+(\d+))?'?$/.exec(eps.trim());
  return m ? Number(m[1]) + Number(m[2] ?? 0) : null;
}

/** "20261010030000" (UTC) → secondes Unix. */
function parseLiveScoreDate(esd: unknown): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(esd ?? ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : 0;
}

function mapLiveScoreEvent(e: any, stage: any): SofaEvent | null {
  const homeTeam = e?.T1?.[0]?.Nm;
  const awayTeam = e?.T2?.[0]?.Nm;
  const eid = Number(e?.Eid);
  if (!eid || !homeTeam || !awayTeam) return null;

  const eps = String(e.Eps ?? '');
  const esid = Number(e.Esid);
  let statusShort = 'OTHER';
  let minute = 0;
  const playing = parseLiveScoreMinute(eps);
  if (eps === 'NS') {
    statusShort = 'NS';
  } else if (eps === 'HT') {
    statusShort = 'HT';
    minute = 45;
  } else if (eps === 'FT' || eps === 'AET' || eps === 'AP') {
    statusShort = 'FT';
    minute = 90;
  } else if (playing != null) {
    minute = playing;
    if (esid === 2) statusShort = '1H';
    else if (esid === 3) statusShort = '2H';
    else if (playing <= 45) statusShort = '1H';
    else if (playing <= 95) statusShort = '2H';
    else statusShort = 'OTHER'; // prolongation
  }

  const goalsHome = Number(e.Tr1 ?? 0) || 0;
  const goalsAway = Number(e.Tr2 ?? 0) || 0;
  const firstHalfDone = statusShort !== '1H' && statusShort !== 'NS';
  return {
    eventId: -eid,
    homeTeam,
    awayTeam,
    league: stage?.CompN || stage?.Snm || 'Compétition inconnue',
    country: stage?.Cnm || '',
    statusShort,
    minute,
    homeGoals: goalsHome,
    awayGoals: goalsAway,
    homeGoalsHT: firstHalfDone ? Number(e.Trh1 ?? goalsHome) || 0 : goalsHome,
    awayGoalsHT: firstHalfDone ? Number(e.Trh2 ?? goalsAway) || 0 : goalsAway,
    startTimestamp: parseLiveScoreDate(e.Esd),
  };
}

function liveScoreEvents(data: any): SofaEvent[] {
  const events: SofaEvent[] = [];
  for (const stage of data?.Stages ?? []) {
    for (const e of stage.Events ?? []) {
      const mapped = mapLiveScoreEvent(e, stage);
      if (mapped) events.push(mapped);
    }
  }
  return events;
}

async function fetchLiveScoreLive(): Promise<SofaEvent[]> {
  return liveScoreEvents(await liveScoreJson('/live/soccer/0?MD=1'));
}

async function fetchLiveScoreDate(dateKey: string): Promise<SofaEvent[]> {
  return liveScoreEvents(await liveScoreJson(`/date/soccer/${dateKey.replace(/-/g, '')}/0?MD=1`));
}

async function fetchLiveScoreEvent(eid: number): Promise<SofaEvent | null> {
  const data = await liveScoreJson(`/scoreboard/soccer/${eid}`);
  return mapLiveScoreEvent(data, data?.Stg ?? null);
}

function liveScorePeriod(home: any, away: any): SofaPeriodStats | null {
  if (!home || !away) return null;
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const cornersHome = n(home.Cos);
  const cornersAway = n(away.Cos);
  const cardsHome = n(home.Ycs) + n(home.Rcs) + n(home.YRcs);
  const cardsAway = n(away.Ycs) + n(away.Rcs) + n(away.YRcs);
  const foulsHome = n(home.Fls);
  const foulsAway = n(away.Fls);
  const onTargetHome = n(home.Shon);
  const onTargetAway = n(away.Shon);
  const total = cornersHome + cornersAway + cardsHome + cardsAway + foulsHome + foulsAway + onTargetHome + onTargetAway;
  if (total === 0) return null; // pas de statistiques publiées : pas de faux zéro
  return {
    corners: cornersHome + cornersAway,
    cards: cardsHome + cardsAway,
    fouls: foulsHome + foulsAway,
    shotsOnTargetHome: onTargetHome,
    shotsOnTargetAway: onTargetAway,
    shotsTotalHome: onTargetHome + n(home.Shof) + n(home.Shbl),
    shotsTotalAway: onTargetAway + n(away.Shof) + n(away.Shbl),
    cornersHome,
    cornersAway,
    cardsHome,
    cardsAway,
    foulsHome,
    foulsAway,
    possessionHome: home.Pss != null ? n(home.Pss) : undefined,
  };
}

async function fetchLiveScoreStats(eid: number): Promise<SofaStats> {
  const data = await liveScoreJson(`/statistics/soccer/${eid}`);
  const stat: any[] = data?.Stat ?? [];
  const home = stat.find((x) => Number(x.Tnb) === 1);
  const away = stat.find((x) => Number(x.Tnb) === 2);
  const periods: any[] = data?.PStat ?? [];
  const homeP = periods.find((x) => Number(x?.['1']?.Tnb) === 1)?.['1'];
  const awayP = periods.find((x) => Number(x?.['1']?.Tnb) === 2)?.['1'];
  return { all: liveScorePeriod(home, away), firstHalf: liveScorePeriod(homeP, awayP) };
}
