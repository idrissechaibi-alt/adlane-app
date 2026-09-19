// Bilan de minuit — clôture la journée écoulée et alimente la courbe
// d'évolution de l'IA, marché par marché.
//
// Pour chaque prédiction émise la veille :
//   - combo de la 20e minute : réglé avec la vérité terrain déjà collectée
//     (fenêtre de 25 minutes figée par liveMarkers), zéro requête réseau.
//   - combo de mi-temps : réglé avec le score FINAL du match, récupéré en une
//     requête groupée (API-Football accepte plusieurs identifiants d'un coup).
//
// ⚠️ Android ne permet pas de garantir une exécution pile à minuit (le
// planificateur système décide du moment). Le bilan est donc déclenché par le
// PREMIER tour qui suit minuit : la journée close est toujours traitée, avec
// au plus quelques minutes de retard.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAPIConfig } from '../api/multiAPIManager';
import { spendBudget } from './requestBudget';
import {
  InPlayProposal,
  MarketDayPoint,
  TrackedMarket,
  readInPlayProposals,
  readMarketSeries,
  readTrainingRows,
  writeInPlayProposals,
  writeMarketSeries,
} from './learnStore';

const LAST_REVIEW_KEY = '@last_daily_review';
/** Nombre maximum de journées rattrapées d'un coup (app restée fermée). */
const MAX_CATCHUP_DAYS = 7;
/** Horizon couvert par un combo de la 20e minute. */
const MINUTE20_HORIZON = '25';

function dayKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

function daysBetween(fromExclusive: string, toInclusive: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${fromExclusive}T00:00:00Z`);
  const end = new Date(`${toInclusive}T00:00:00Z`);

  while (cursor < end && days.length < MAX_CATCHUP_DAYS) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    days.push(dayKey(cursor));
  }
  return days;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': 'v3.football.api-sports.io',
    'x-apisports-key': apiKey,
  };
}

interface FinalResult {
  goalsHome: number;
  goalsAway: number;
  htHome: number;
  htAway: number;
}

/** Scores finaux de plusieurs matchs en une seule requête. */
async function fetchFinalResults(
  apiKey: string,
  fixtureIds: number[]
): Promise<Map<number, FinalResult>> {
  const results = new Map<number, FinalResult>();
  if (fixtureIds.length === 0) return results;

  // API-Football accepte jusqu'à 20 identifiants par appel.
  for (let i = 0; i < fixtureIds.length; i += 20) {
    const batch = fixtureIds.slice(i, i + 20);
    if (!(await spendBudget('apiFootball'))) break;

    try {
      const response = await fetch(
        `https://v3.football.api-sports.io/fixtures?ids=${batch.join('-')}`,
        { headers: buildHeaders(apiKey) }
      );
      if (!response.ok) continue;

      const data = await response.json();
      for (const item of data.response || []) {
        if (item.fixture?.status?.short !== 'FT') continue; // match non terminé : on ne règle pas
        results.set(item.fixture.id, {
          goalsHome: item.goals?.home ?? 0,
          goalsAway: item.goals?.away ?? 0,
          htHome: item.score?.halftime?.home ?? 0,
          htAway: item.score?.halftime?.away ?? 0,
        });
      }
    } catch (error: any) {
      console.warn('[Bilan] Résultats finaux indisponibles:', error.message);
    }
  }

  return results;
}

/**
 * Une jambe de combo de mi-temps est-elle passée, au vu du score final ?
 * Renvoie null si le marché n'est pas décidable à partir du score seul
 * (corners/cartons ne sont pas dans le score : on ne devine pas).
 */
function settleHalftimeLeg(
  market: TrackedMarket,
  selection: string,
  result: FinalResult
): boolean | null {
  const totalGoals = result.goalsHome + result.goalsAway;

  if (market === '1X2') {
    if (selection.includes('1 (domicile)')) return result.goalsHome > result.goalsAway;
    if (selection.includes('2 (extérieur)')) return result.goalsAway > result.goalsHome;
    if (selection.includes('X (nul)')) return result.goalsHome === result.goalsAway;
    return null;
  }

  if (market === 'total_buts') return totalGoals > 2.5;
  if (market === 'btts') return result.goalsHome > 0 && result.goalsAway > 0;

  return null;
}

/** Règle un combo de la 20e minute avec les fenêtres déjà figées. */
function settleMinute20Proposal(proposal: InPlayProposal, rows: ReturnType<typeof readTrainingRows>): boolean {
  const row = rows.find(
    (r) => r.fixtureId === proposal.fixtureId && r.minute === proposal.minute
  );
  const deltas = row?.horizons?.[MINUTE20_HORIZON];
  if (!deltas || deltas.truncated) return false;

  for (const leg of proposal.legs) {
    // La sélection porte le seuil ("au moins 3 corners"), on le relit tel quel.
    const threshold = Number(leg.selection.match(/au moins (\d+)/)?.[1] ?? 1);

    let won: boolean | null = null;
    if (leg.market === 'corners') won = deltas.corners >= threshold;
    else if (leg.market === 'cartons') won = deltas.cards >= threshold;
    else if (leg.market === 'fautes') won = deltas.fouls >= threshold;
    else if (leg.market === 'buts_1ere_mt') won = deltas.goals >= threshold;

    if (won == null) continue;
    leg.settled = true;
    leg.won = won;
  }

  return proposal.legs.some((leg) => leg.settled);
}

/** Agrège les jambes réglées d'une journée en un point de courbe par marché. */
function buildDayPoints(date: string, proposals: InPlayProposal[]): MarketDayPoint[] {
  const byMarket = new Map<TrackedMarket, { correct: number; total: number; predictedSum: number }>();

  for (const proposal of proposals) {
    for (const leg of proposal.legs) {
      if (!leg.settled) continue;
      const entry = byMarket.get(leg.market) ?? { correct: 0, total: 0, predictedSum: 0 };
      entry.total += 1;
      entry.predictedSum += leg.prob;
      if (leg.won) entry.correct += 1;
      byMarket.set(leg.market, entry);
    }
  }

  const points: MarketDayPoint[] = [];
  for (const [market, entry] of byMarket.entries()) {
    points.push({
      date,
      market,
      predictions: entry.total,
      correct: entry.correct,
      hitRate: entry.total > 0 ? entry.correct / entry.total : 0,
      meanPredicted: entry.total > 0 ? entry.predictedSum / entry.total : 0,
    });
  }

  return points;
}

/**
 * Clôture toutes les journées écoulées depuis le dernier bilan.
 * Idempotent : une journée déjà traitée n'est jamais recomptée.
 */
export async function runNightlyReviewIfDue(): Promise<number> {
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));

  // Au tout premier bilan, on part de l'avant-veille pour que la journée
  // d'hier soit bien traitée (partir d'hier la ferait sauter définitivement).
  const storedLastReviewed = await AsyncStorage.getItem(LAST_REVIEW_KEY);
  const lastReviewed = storedLastReviewed ?? dayKey(new Date(Date.now() - 2 * 86_400_000));
  if (lastReviewed >= yesterday) return 0; // déjà à jour

  const pendingDays = daysBetween(lastReviewed, yesterday);
  if (pendingDays.length === 0) return 0;

  const allProposals = readInPlayProposals();
  const rows = readTrainingRows(MAX_CATCHUP_DAYS + 2);
  const apiConfig = await getAPIConfig();

  const series = readMarketSeries();
  let created = 0;

  for (const day of pendingDays) {
    const dayProposals = allProposals.filter(
      (p) => p.createdAt.startsWith(day) && !p.reviewed
    );
    if (dayProposals.length === 0) continue;

    // Combos de la 20e : la vérité est déjà dans le corpus.
    for (const proposal of dayProposals.filter((p) => p.kind === 'minute20')) {
      settleMinute20Proposal(proposal, rows);
      proposal.reviewed = true;
    }

    // Combos de mi-temps : il faut le score final.
    const halftimeProposals = dayProposals.filter((p) => p.kind === 'halftime');
    if (halftimeProposals.length > 0 && apiConfig.apiFootball) {
      const finals = await fetchFinalResults(
        apiConfig.apiFootball,
        halftimeProposals.map((p) => p.fixtureId)
      );

      for (const proposal of halftimeProposals) {
        const result = finals.get(proposal.fixtureId);
        if (!result) continue; // score indisponible : on laisse la proposition ouverte

        for (const leg of proposal.legs) {
          const won = settleHalftimeLeg(leg.market, leg.selection, result);
          if (won == null) continue;
          leg.settled = true;
          leg.won = won;
        }
        proposal.reviewed = true;
      }
    }

    const points = buildDayPoints(day, dayProposals);
    // Une journée déjà présente dans la série est remplacée, jamais dupliquée.
    for (const point of points) {
      const existingIndex = series.findIndex((p) => p.date === point.date && p.market === point.market);
      if (existingIndex >= 0) series[existingIndex] = point;
      else series.push(point);
      created += 1;
    }
  }

  writeInPlayProposals(allProposals);
  writeMarketSeries(series.sort((a, b) => a.date.localeCompare(b.date)));
  await AsyncStorage.setItem(LAST_REVIEW_KEY, yesterday);

  return created;
}
