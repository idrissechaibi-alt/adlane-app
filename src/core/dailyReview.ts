// Bilan de minuit — clôture la journée écoulée et alimente la courbe
// d'évolution de l'IA, marché par marché.
//
// Pour chaque prédiction émise la veille (scans 20e et 60e minute) : réglée
// avec le score final + le score de mi-temps du match, récupérés en une
// requête groupée (API-Football accepte plusieurs identifiants d'un coup).
// Corners/cartons 1ère mi-temps ne sont volontairement jamais réglés : aucune
// source structurée gratuite ne publie de répartition par mi-temps pour ces
// marchés (seul le total du match l'est) — deviner romprait la mesure de
// fiabilité elle-même.
//
// ⚠️ Android ne permet pas de garantir une exécution pile à minuit (le
// planificateur système décide du moment). Le bilan est donc déclenché par le
// PREMIER tour qui suit minuit : la journée close est toujours traitée, avec
// au plus quelques minutes de retard.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAPIConfig } from '../api/multiAPIManager';
import { spendBudget } from './requestBudget';
import { syncEloForAllCoveredLeagues } from './eloRatings';
import { settlePlacedBets, settleProposedBets } from './betSettlement';
import { fetchWithTimeout } from './httpTimeout';
import { generateDailyReport } from './reporter';
import { getAllBets, saveDailyReport, getDailyReports } from '../database/storage';
import {
  InPlayProposal,
  MarketDayPoint,
  TrackedMarket,
  readInPlayProposals,
  readMarketSeries,
  writeInPlayProposals,
  writeMarketSeries,
} from './learnStore';

const LAST_REVIEW_KEY = '@last_daily_review';
const LAST_ELO_SYNC_KEY = '@last_elo_sync';
/** Nombre maximum de journées rattrapées d'un coup (app restée fermée). */
const MAX_CATCHUP_DAYS = 7;

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
      const response = await fetchWithTimeout(
        `https://v3.football.api-sports.io/fixtures?ids=${batch.join('-')}`,
        { headers: buildHeaders(apiKey) }
      );
      if (!response.ok) continue;

      const data = await response.json();

      // API-Football répond souvent HTTP 200 même en cas de problème de clé/plan
      // (ex: "Missing application key") — l'erreur réelle est dans data.errors,
      // jamais dans le statut HTTP. Sans cette vérification, un lot en échec est
      // indiscernable d'un lot de matchs simplement pas encore terminés.
      const errors = data.errors;
      const hasErrors = errors && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors).length > 0);
      if (hasErrors) {
        const message = Array.isArray(errors) ? errors.join(', ') : Object.values(errors).join(', ');
        console.warn('[Bilan] Résultats finaux indisponibles:', message || 'data.errors non vide');
        continue;
      }

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
 * Une jambe de scan 20e/60e minute (ou de l'ancien combo mi-temps) est-elle
 * passée, au vu du score final + score de mi-temps ? Renvoie null si le
 * marché n'est pas décidable à partir du score seul — corners/cartons ne
 * sont pas dans le score, et aucune source structurée gratuite ne publie de
 * répartition 1ère MT / reste du match pour ces marchés (seul le total du
 * match l'est, sur Football-Data.co.uk) : on ne devine jamais une valeur à
 * la place, la jambe reste simplement non réglée plutôt que faussement jugée.
 */
function settleReprojectedLeg(
  market: TrackedMarket,
  selection: string,
  result: FinalResult
): boolean | null {
  const totalGoals = result.goalsHome + result.goalsAway;
  const htGoals = result.htHome + result.htAway;

  if (market === '1X2') {
    if (selection.includes('1 (domicile)') || selection.includes('Domicile')) return result.goalsHome > result.goalsAway;
    if (selection.includes('2 (extérieur)') || selection.includes('Extérieur')) return result.goalsAway > result.goalsHome;
    if (selection.includes('X (nul)') || selection.includes('Nul')) return result.goalsHome === result.goalsAway;
    return null;
  }

  if (market === 'total_buts') return totalGoals > 2.5;
  if (market === 'btts') return result.goalsHome > 0 && result.goalsAway > 0;
  if (market === 'buts_1ere_mt') return htGoals >= 1;

  return null; // corners / cartons / fautes : pas de source structurée par mi-temps
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

  // Synchro Elo (item E) : gratuite (openfootball, pas de quota API), une
  // fois par jour suffit largement puisque les championnats couverts ne
  // jouent pas plus d'une fois par jour de toute façon.
  const lastEloSync = await AsyncStorage.getItem(LAST_ELO_SYNC_KEY);
  if (lastEloSync !== today) {
    try {
      await syncEloForAllCoveredLeagues();
    } catch (error: any) {
      console.warn('[Bilan] Synchro Elo échouée:', error.message);
    }
    await AsyncStorage.setItem(LAST_ELO_SYNC_KEY, today);
  }

  // Règle les vrais paris placés (bouton "Placer ce pari") avant de générer
  // le moindre bilan : le rapport doit refléter des paris déjà réglés, pas
  // des paris encore "pending".
  try {
    await settlePlacedBets();
  } catch (error: any) {
    console.warn('[Bilan] Règlement des paris placés échoué:', error.message);
  }

  // Bilan quotidien texte (X propositions émises, Y auraient gagné, grandes
  // lignes) : rattrape TOUT jour passé avec des paris (placés OU simples
  // propositions jamais jouées — demande explicite : le rapport porte sur
  // TOUT ce que l'app a proposé, pas seulement les vrais paris placés) mais
  // sans rapport encore sauvegardé, indépendamment de la fenêtre de
  // rattrapage ci-dessous (bornée à MAX_CATCHUP_DAYS à partir d'un point de
  // départ qui n'avance que vers l'avant). Sans ça, des paris plus anciens
  // que cette fenêtre (historique importé, ou l'app restée fermée plus de 7
  // jours) ne recevaient jamais de bilan — la section Rapport restait vide
  // pour toujours, pas juste en retard. generateDailyReport est un calcul
  // pur sur des données déjà connues (aucun appel réseau) : le relancer sur
  // un jour déjà couvert ne coûte rien, donc on ne complique pas avec un
  // curseur séparé.
  try {
    const activeDates = Array.from(new Set(
      (await getAllBets()).filter((b) => b.date < today).map((b) => b.date)
    ));
    const existingReports = await getDailyReports(365);
    const reportedDates = new Set(existingReports.map((r) => r.date));
    for (const day of activeDates) {
      if (reportedDates.has(day)) continue;

      try {
        await settleProposedBets(day);
      } catch (error: any) {
        console.warn(`[Bilan] Règlement des propositions du ${day} échoué:`, error.message);
      }

      const freshBets = await getAllBets(); // relire après règlement des propositions du jour
      const report = generateDailyReport(day, freshBets);
      await saveDailyReport(report);
    }
  } catch (error: any) {
    console.warn('[Bilan] Rattrapage des rapports quotidiens échoué:', error.message);
  }

  // Au tout premier bilan, on part de l'avant-veille pour que la journée
  // d'hier soit bien traitée (partir d'hier la ferait sauter définitivement).
  const storedLastReviewed = await AsyncStorage.getItem(LAST_REVIEW_KEY);
  const lastReviewed = storedLastReviewed ?? dayKey(new Date(Date.now() - 2 * 86_400_000));
  if (lastReviewed >= yesterday) return 0; // déjà à jour

  const pendingDays = daysBetween(lastReviewed, yesterday);
  if (pendingDays.length === 0) return 0;

  const allProposals = readInPlayProposals();
  const apiConfig = await getAPIConfig();

  const series = readMarketSeries();
  let created = 0;

  for (const day of pendingDays) {
    const dayProposals = allProposals.filter(
      (p) => p.createdAt.startsWith(day) && !p.reviewed
    );
    if (dayProposals.length === 0) continue;

    // Scans 20e/60e minute (et l'ancien combo mi-temps, pour les
    // enregistrements encore non réglés) : tous reposent sur le score final +
    // mi-temps, récupérés en une requête groupée.
    if (apiConfig.apiFootball) {
      const finals = await fetchFinalResults(
        apiConfig.apiFootball,
        dayProposals.map((p) => p.fixtureId)
      );

      for (const proposal of dayProposals) {
        const result = finals.get(proposal.fixtureId);
        if (!result) continue; // score indisponible : on laisse la proposition ouverte

        for (const leg of proposal.legs) {
          const won = settleReprojectedLeg(leg.market, leg.selection, result);
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
