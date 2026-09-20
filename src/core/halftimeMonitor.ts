// Moniteur mi-temps — détecte quand un match du plan du jour atteint la
// mi-temps, récupère le score + les stats déjà jouées via API-Football
// (source live), recalibre l'estimation de 2ème mi-temps (src/core/poisson.ts)
// et propose un COMBO portant sur la suite du match.
//
// Tourne aussi bien depuis la tâche native planifiée (app fermée) que depuis
// la boucle de premier plan.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDailyPlan } from './scheduler';
import { getAPIConfig } from '../api/multiAPIManager';
import { estimateExpectedGoalsFromMarket, estimateSecondHalfMarket, SecondHalfMarket } from './poisson';
import { normalizeTeamName } from './teamNameMatch';
import { sendLocalNotification } from './notifications';
import { InPlayProposal, TrackedMarket, readInPlayProposals, writeInPlayProposals } from './learnStore';
import { fetchWithTimeout } from './httpTimeout';
import { ScheduledMatchDetail } from '../types/database';

/**
 * Traduit un marché de la re-projection de mi-temps (poisson.ts) vers le
 * marché suivi dans la courbe d'évolution.
 */
function marketForHalftimeMarket(market: string): TrackedMarket {
  if (market.includes('1X2')) return '1X2';
  if (market.includes('btts')) return 'btts';
  if (market.includes('over_2_5')) return 'total_buts';
  return 'buts_1ere_mt';
}

const NOTIFIED_KEY_PREFIX = '@halftime_notified_';
/** Probabilité minimale pour qu'un marché entre dans le combo de mi-temps. */
const MIN_LEG_PROB = 0.55;
const MAX_LEGS = 3;

// Fenêtre de détection : la mi-temps réelle tombe généralement entre 45 et
// 55 minutes après le coup d'envoi (temps additionnel compris) ; on élargit
// un peu pour absorber l'imprécision du polling (~toutes les 3 minutes).
const HT_WINDOW_MIN_MINUTES = 38;
const HT_WINDOW_MAX_MINUTES = 75;
// Seuil minimum pour juger qu'une opportunité mérite une notification (évite
// le spam sur des probabilités proches du 50/50 sans signal réel).
const NOTIFY_PROB_THRESHOLD = 0.60;

export interface LiveFixture {
  statusShort: string; // '1H', 'HT', '2H', 'FT', ...
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  fixtureId: number;
}

interface LiveStats {
  shotsOnTargetHome?: number;
  shotsOnTargetAway?: number;
  cornersHome?: number;
  cornersAway?: number;
}

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

async function getNotifiedIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(`${NOTIFIED_KEY_PREFIX}${todayKey()}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

async function markNotified(matchId: string): Promise<void> {
  const ids = await getNotifiedIds();
  ids.add(matchId);
  await AsyncStorage.setItem(`${NOTIFIED_KEY_PREFIX}${todayKey()}`, JSON.stringify(Array.from(ids)));
}

function buildApiFootballHeaders(apiKey: string): Record<string, string> {
  return {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': 'v3.football.api-sports.io',
    'x-apisports-key': apiKey
  };
}

/**
 * Récupère TOUS les matchs actuellement en direct dans le monde (une seule
 * requête, filtrée ensuite côté client par nom d'équipe) — API-Football
 * n'offre pas de recherche live par équipe.
 */
export async function fetchLiveFixtures(apiKey: string): Promise<LiveFixture[]> {
  const response = await fetchWithTimeout('https://v3.football.api-sports.io/fixtures?live=all', {
    headers: buildApiFootballHeaders(apiKey)
  });
  if (!response.ok) return [];

  const data = await response.json();
  return (data.response || []).map((item: any) => ({
    statusShort: item.fixture?.status?.short || '',
    homeTeam: item.teams?.home?.name || '',
    awayTeam: item.teams?.away?.name || '',
    homeGoals: item.goals?.home ?? 0,
    awayGoals: item.goals?.away ?? 0,
    fixtureId: item.fixture?.id
  }));
}

async function fetchLiveStats(apiKey: string, fixtureId: number, homeTeam: string): Promise<LiveStats> {
  try {
    const response = await fetchWithTimeout(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`, {
      headers: buildApiFootballHeaders(apiKey)
    });
    if (!response.ok) return {};

    const data = await response.json();
    const entries: any[] = data.response || [];
    const homeEntry = entries.find((e) => normalizeTeamName(e.team?.name || '') === normalizeTeamName(homeTeam));
    const awayEntry = entries.find((e) => e !== homeEntry);

    const extract = (entry: any, type: string): number | undefined => {
      const stat = entry?.statistics?.find((s: any) => s.type === type);
      return stat && typeof stat.value === 'number' ? stat.value : undefined;
    };

    return {
      shotsOnTargetHome: extract(homeEntry, 'Shots on Goal'),
      shotsOnTargetAway: extract(awayEntry, 'Shots on Goal'),
      cornersHome: extract(homeEntry, 'Corner Kicks'),
      cornersAway: extract(awayEntry, 'Corner Kicks')
    };
  } catch {
    return {};
  }
}

function pickTopMarket(markets: SecondHalfMarket[]): SecondHalfMarket {
  return markets.reduce((best, m) => (m.estimated_prob > best.estimated_prob ? m : best), markets[0]);
}

/**
 * Point d'entrée à appeler périodiquement (toutes les ~3 minutes) pendant
 * que l'app est ouverte. Ne fait rien si aucun match du plan du jour n'est
 * dans la fenêtre de mi-temps, ou si API-Football n'est pas configuré.
 */
export async function checkHalftimeOpportunities(): Promise<void> {
  const plan = await getDailyPlan();
  if (!plan) return;

  const apiConfig = await getAPIConfig();
  if (!apiConfig.apiFootball) return; // stats live indisponibles sans cette clé

  const notifiedIds = await getNotifiedIds();
  const now = Date.now();

  const candidates: ScheduledMatchDetail[] = plan.slots
    .flatMap((s) => s.matches)
    .filter((m) => {
      if (notifiedIds.has(m.id)) return false;
      const elapsedMin = (now - new Date(m.kickoff_utc).getTime()) / 60000;
      if (elapsedMin < HT_WINDOW_MIN_MINUTES || elapsedMin > HT_WINDOW_MAX_MINUTES) return false;
      return estimateExpectedGoalsFromMarket(m.odds) !== null;
    });

  if (candidates.length === 0) return;

  let liveFixtures: LiveFixture[];
  try {
    liveFixtures = await fetchLiveFixtures(apiConfig.apiFootball);
  } catch (error: any) {
    console.warn('[Moniteur mi-temps] Échec récupération des matchs en direct:', error.message);
    return;
  }

  const liveIndex = new Map<string, LiveFixture>();
  for (const fixture of liveFixtures) {
    liveIndex.set(`${normalizeTeamName(fixture.homeTeam)}|${normalizeTeamName(fixture.awayTeam)}`, fixture);
  }

  for (const match of candidates) {
    const key = `${normalizeTeamName(match.homeTeam)}|${normalizeTeamName(match.awayTeam)}`;
    const live = liveIndex.get(key);

    if (!live || live.statusShort !== 'HT') continue; // pas (encore) à la mi-temps côté live

    const preMatchExpectedGoals = estimateExpectedGoalsFromMarket(match.odds);
    if (!preMatchExpectedGoals) continue; // garde-fou (déjà filtré plus haut, mais TS l'exige)

    const htStats = await fetchLiveStats(apiConfig.apiFootball, live.fixtureId, match.homeTeam);

    const estimate = estimateSecondHalfMarket({
      preMatchExpectedGoals,
      htScore: { home: live.homeGoals, away: live.awayGoals },
      htStats
    });

    // On marque comme "traité" dans tous les cas pour ne jamais renvoyer une
    // notification en boucle sur ce même match, même si le seuil n'est pas atteint.
    await markNotified(match.id);

    // Combo portant sur la SUITE DU MATCH : on retient les marchés les plus
    // probables issus de la re-projection (2ème MT seule + fin de match).
    const legs = estimate.markets
      .filter((m) => m.estimated_prob >= MIN_LEG_PROB)
      .sort((a, b) => b.estimated_prob - a.estimated_prob)
      .slice(0, MAX_LEGS);

    if (legs.length < 2) continue; // pas de combo lisible, on se tait

    const combinedProb = legs.reduce((product, leg) => product * leg.estimated_prob, 1);
    const scoreLabel = `${live.homeGoals}-${live.awayGoals}`;

    const proposal: InPlayProposal = {
      id: `inplay-ht-${live.fixtureId}`,
      kind: 'halftime',
      createdAt: new Date().toISOString(),
      fixtureId: live.fixtureId,
      league: match.leagueName,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      minute: 45,
      scoreLabel,
      window: 'mi-temps → fin de match',
      legs: legs.map((leg) => ({
        market: marketForHalftimeMarket(leg.market),
        selection: leg.selection,
        prob: leg.estimated_prob,
        evidence: leg.reasoning,
      })),
      combinedProb,
    };

    writeInPlayProposals([...readInPlayProposals(), proposal]);

    const legsText = legs
      .map((leg) => `• ${leg.selection} (${(leg.estimated_prob * 100).toFixed(0)}%)`)
      .join('\n');

    await sendLocalNotification(
      `⏸️ Mi-temps : ${match.homeTeam} ${scoreLabel} ${match.awayTeam}`,
      `Combo sur la suite du match — ${(combinedProb * 100).toFixed(0)}% combiné\n${legsText}`,
      { matchId: match.id, kind: 'halftime' }
    );
  }
}
