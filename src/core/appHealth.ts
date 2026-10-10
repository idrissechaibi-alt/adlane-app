// État de santé de la boucle d'apprentissage, joint à chaque sauvegarde GitHub
// (gitAutoSync.ts) pour pouvoir diagnostiquer un blocage à distance, à partir
// des données réelles du téléphone. Uniquement des compteurs, horodatages et
// booléens de présence : aucune clé API, aucun jeton, aucune adresse.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAPIConfig, getRequestCount } from '../api/multiAPIManager';
import { getDailyPlan } from './scheduler';
import { remainingBudget } from './requestBudget';
import { estimateExpectedGoalsFromMarket } from './poisson';
import { getNativeBackgroundTickStats, readLastTickDiagnostics, readTickProgress } from './backgroundTasks';
import { loadOmnirouteConfig } from './focusEnrichment';
import { checkAllProviders, getRouteLeaderboard, getWebCapableRoutes } from './llmRouter';
import { getRecentSearchSource, getWorkingSearchProviders } from './webSearch';
import { getSofaStatus } from '../api/footballDataAPIs/sofaScore';
import { loadTelegramConfig } from './telegram';
import {
  readAccuracySnapshots,
  readInPlayProposals,
  readLearnedModel,
  readMarketSeries,
  readMarketSeriesFictional,
  readMarketSeriesReal,
  readPaperBets,
  readPredictionOutcomes,
  readTrainingRows,
} from './learnStore';

const DAY_MS = 24 * 3_600_000;

function latest(values: Array<string | undefined>): string | null {
  const defined = values.filter((v): v is string => Boolean(v)).sort();
  return defined.length > 0 ? defined[defined.length - 1] : null;
}

function countSince(values: Array<string | undefined>, since: number): number {
  return values.filter((v) => v && Date.parse(v) >= since).length;
}

async function section<T>(build: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await build();
  } catch (error: any) {
    return { error: error?.message || 'erreur inconnue' };
  }
}

export async function buildAppHealth(): Promise<Record<string, unknown>> {
  const dayAgo = Date.now() - DAY_MS;

  return {
    nativeBackgroundTicks: await section(getNativeBackgroundTickStats),
    tickProgress: await section(readTickProgress),
    lastTick: await section(readLastTickDiagnostics),
    paperBets: await section(() => {
      const bets = readPaperBets();
      const settled = bets.filter((b) => b.settled);
      return {
        total: bets.length,
        settled: settled.length,
        won: settled.filter((b) => b.won).length,
        lastPlacedAt: latest(bets.map((b) => b.placedAt)),
        lastSettledAt: latest(settled.map((b) => b.settledAt)),
        placedLast24h: countSince(bets.map((b) => b.placedAt), dayAgo),
        settledLast24h: countSince(settled.map((b) => b.settledAt), dayAgo),
      };
    }),
    trainingRows: await section(() => {
      const rows = readTrainingRows(14);
      return {
        last14Days: rows.length,
        lastClosedAt: latest(rows.map((r) => r.closedAt)),
        bySource: rows.reduce<Record<string, number>>((acc, r) => {
          const source = r.source ?? 'api_football';
          acc[source] = (acc[source] ?? 0) + 1;
          return acc;
        }, {}),
      };
    }),
    model: await section(() => {
      const model = readLearnedModel();
      if (!model) return null;
      return {
        updatedAt: model.updatedAt,
        totalRows: model.totalRows,
        markerRules: model.markerRules.length,
        paperBets: model.paperBets,
        omnirouteTrust: model.omnirouteTrust ?? null,
        marketExpertise: (model.marketExpertise ?? []).map((e) => ({
          market: e.market,
          samples: e.samples,
          hitRate: Number(e.hitRate.toFixed(3)),
          meanPredicted: Number(e.meanPredicted.toFixed(3)),
          calibrationFactor: Number(e.calibrationFactor.toFixed(3)),
        })),
      };
    }),
    inPlayProposals: await section(() => {
      const proposals = readInPlayProposals();
      const fictional = proposals.filter((p) => p.real === false);
      const real = proposals.filter((p) => p.real !== false);
      return {
        real: real.length,
        fictional: fictional.length,
        fictionalReviewed: fictional.filter((p) => p.reviewed).length,
        fictionalSettledLegs: fictional.flatMap((p) => p.legs).filter((l) => l.settled).length,
        lastCreatedAt: latest(proposals.map((p) => p.createdAt)),
        createdLast24h: countSince(proposals.map((p) => p.createdAt), dayAgo),
      };
    }),
    predictionOutcomes30d: await section(() => readPredictionOutcomes(30).length),
    marketSeries: await section(() => {
      const combined = readMarketSeries();
      return {
        combined: combined.length,
        real: readMarketSeriesReal().length,
        fictional: readMarketSeriesFictional().length,
        lastDate: latest(combined.map((p) => p.date)),
      };
    }),
    accuracySnapshots: await section(() => readAccuracySnapshots().slice(-7)),
    lastNightlyReview: await section(() => AsyncStorage.getItem('@last_daily_review')),
    aiProviders: await section(async () => {
      const config = await loadOmnirouteConfig();
      if (!config) return { configured: false };
      // Noms, latences et compteurs uniquement : jamais l'adresse ni la clé.
      return {
        configured: true,
        checks: await checkAllProviders(config),
        leaderboard: (await getRouteLeaderboard(config)).slice(0, 10),
        webCapable: await getWebCapableRoutes(config),
        searchProviders: await getWorkingSearchProviders(config),
        lastSearchSource: await getRecentSearchSource(),
      };
    }),
    dailyPlan: await section(async () => {
      const plan = await getDailyPlan();
      if (!plan) return null;
      return {
        date: plan.date,
        generatedAt: plan.generatedAt,
        matches: plan.slots.flatMap((slot) =>
          (slot.matches as any[]).map((m) => ({
            match: `${m.homeTeam} - ${m.awayTeam}`,
            league: m.leagueName,
            kickoff: m.kickoff_utc,
            hasOdds: Boolean(estimateExpectedGoalsFromMarket(m.odds)),
          }))
        ),
      };
    }),
    apiFootballBudget: await section(async () => ({
      usedToday: await getRequestCount('apiFootball'),
      autolearnUsedToday: await getRequestCount('apiFootball-autolearn'),
      autolearnRemaining: await remainingBudget('apiFootball'),
    })),
    sofaScore: await section(async () => getSofaStatus()),
    configured: await section(async () => {
      const api = await getAPIConfig();
      return {
        omniroute: Boolean(await loadOmnirouteConfig()),
        telegram: Boolean(await loadTelegramConfig()),
        apiFootball: Boolean(api.apiFootball?.trim()),
        sportmonks: Boolean(api.sportmonks?.trim()),
        allSports: Boolean(api.allSports?.trim()),
        theOddsApi: Boolean(api.theOddsApi?.trim()),
      };
    }),
  };
}
