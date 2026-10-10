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
import { spendDirectBudget } from './requestBudget';
import { syncEloForAllCoveredLeagues } from './eloRatings';
import { settlePlacedBets, settleProposedBets } from './betSettlement';
import { fetchWithTimeout } from './httpTimeout';
import { generateDailyReport } from './reporter';
import { getAllBets, saveBet, saveDailyReport, getDailyReports } from '../database/storage';
import { mapWithConcurrency } from './concurrency';
import {
  InPlayProposal,
  MarketDayPoint,
  PredictionOutcome,
  TrackedMarket,
  appendPredictionOutcomes,
  readInPlayProposals,
  readMarketSeries,
  readMarketSeriesReal,
  readMarketSeriesFictional,
  writeInPlayProposals,
  writeMarketSeries,
  writeMarketSeriesReal,
  writeMarketSeriesFictional,
} from './learnStore';
import { loadOmnirouteConfig } from './focusEnrichment';
import { askOmnirouteUsable } from './omniroute';
import { OmnirouteConfig } from '../types';
import { sendTelegramMessage } from './telegram';
import { buildFictionalMarketStats, formatFictionalDigestMessage } from './dailyDigest';
import { readMatchTimelines, MatchSample } from './fictionalProgram';
import { isSyntheticFixtureId } from './halftimeMonitor';
import { fetchSofaEvent, fetchSofaStats, getSofaEventId } from '../api/footballDataAPIs/sofaScore';

const LAST_REVIEW_KEY = '@last_daily_review';
const LAST_ELO_SYNC_KEY = '@last_elo_sync';
const LAST_TODAY_ATTEMPT_KEY = '@last_today_review_attempt';
/** Nombre maximum de journées rattrapées d'un coup (app restée fermée). */
const MAX_CATCHUP_DAYS = 7;
/** Fréquence de retraitement de la journée EN COURS (voir plus bas) — pas
 * plus souvent, pour ne pas multiplier les appels API-Football/Omniroute sur
 * des matchs encore en cours, qui échoueraient de toute façon à chaque essai. */
const TODAY_RETRY_INTERVAL_MS = 60 * 60_000;

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
  /** Corners et cartons (jaunes + rouges) de la 1ère mi-temps, quand
   * API-Football les fournit (fixtures/statistics avec half=true). */
  corners1H?: number;
  cards1H?: number;
}

/** Nombre de requêtes de statistiques de 1ère mi-temps par passage du bilan. */
const FIRST_HALF_STATS_MAX_PER_PASS = 12;

function statValue(stats: any[] | undefined, type: string): number | null {
  const entry = (stats ?? []).find((s) => s?.type === type);
  if (!entry) return null;
  const value = typeof entry.value === 'number' ? entry.value : entry.value == null ? 0 : Number(entry.value);
  return Number.isFinite(value) ? value : null;
}

/**
 * Corners et cartons de la 1ère mi-temps d'un match terminé. Sans ces
 * chiffres, un pari "Plus de X corners en 1ère mi-temps" n'était jamais
 * vérifié à la 45e et la calibration n'en apprenait rien. Renvoie null si
 * API-Football ne fournit pas le détail par mi-temps pour ce match : le pari
 * reste alors non réglé plutôt que deviné.
 */
async function fetchFirstHalfStats(
  apiKey: string,
  fixtureId: number
): Promise<{ corners: number; cards: number } | null> {
  try {
    const response = await fetchWithTimeout(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}&half=true`,
      { headers: buildHeaders(apiKey) }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const teams: any[] = data.response ?? [];
    if (teams.length !== 2) return null;

    let corners = 0;
    let cards = 0;
    for (const team of teams) {
      const firstHalf = team.statistics_1h;
      if (!Array.isArray(firstHalf)) return null;
      const teamCorners = statValue(firstHalf, 'Corner Kicks');
      const yellow = statValue(firstHalf, 'Yellow Cards');
      const red = statValue(firstHalf, 'Red Cards');
      if (teamCorners == null || yellow == null || red == null) return null;
      corners += teamCorners;
      cards += yellow + red;
    }
    return { corners, cards };
  } catch {
    return null;
  }
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
    // Budget direct : ces scores règlent les paris RÉELS, ils ne doivent pas
    // dépendre de la part de l'auto-apprentissage (épuisée dès le petit matin).
    if (!(await spendDirectBudget('apiFootball'))) break;

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
 * Équivalent Omniroute de fetchFinalResults, pour les matchs découverts
 * directement par Omniroute (fixtureId synthétique, cf. halftimeMonitor.ts/
 * fetchOmnirouteAllLiveFixtures) — API-Football ne les connaît sous aucun
 * identifiant, donc `fetchFinalResults` ne peut littéralement jamais les
 * régler : sans ce repli, ces propositions restaient non réglées pour
 * toujours, et n'alimentaient donc jamais la boucle d'auto-apprentissage
 * malgré le "réussi" affiché en calibrage. Un appel par match (pas de
 * requête groupée possible sans identifiant commun), mais gratuit et sans
 * quota — un par jour et par match suffit largement.
 *
 * Appels PARALLÉLISÉS (bornés) plutôt qu'un par un : chaque appel Omniroute/
 * FreeLLMAPI peut prendre plusieurs secondes (voire jusqu'à 20s en cas de
 * ronde sur plusieurs modèles), et les matchs non réglés par API-Football
 * (tout le programme fictif, dont les fixtureId synthétiques ne sont connus
 * d'aucune autre source) peuvent se compter par dizaines un jour donné — en
 * séquentiel, ça pouvait faire dépasser plusieurs minutes, voire le temps
 * d'exécution qu'Android accorde à une tâche de fond avant de la tuer. Sans
 * jamais d'erreur ni de log visible dans ce cas : le bilan était simplement
 * interrompu en cours de route, AVANT d'écrire quoi que ce soit (l'écriture
 * n'intervient qu'à la toute fin de runNightlyReviewIfDue) — cohérent avec
 * "Aucun bilan encore effectué" qui persistait malgré des jours d'activité.
 */
const OMNIROUTE_FINAL_RESULT_CONCURRENCY = 6;
/** Matchs interrogés par passage horaire (le reste suit au passage suivant). */
const OMNIROUTE_FINAL_RESULT_MAX_PER_PASS = 30;

const SOFA_FINAL_RESULT_MAX_PER_PASS = 60;

/**
 * Résultat final d'un match déjà connu de SofaScore (voir registerSofaEvents) :
 * score final, score à la mi-temps, corners et cartons de la 1ère mi-temps —
 * publiés directement, sans modèle ni recherche. Renvoie seulement les
 * matchs TERMINÉS ; les autres restent à régler plus tard.
 */
async function fetchFinalResultsViaSofaScore(
  legs: Array<{ fixtureId: number }>
): Promise<Map<number, FinalResult>> {
  const results = new Map<number, FinalResult>();
  await mapWithConcurrency(legs.slice(0, SOFA_FINAL_RESULT_MAX_PER_PASS), 6, async ({ fixtureId }) => {
    try {
      const eventId = await getSofaEventId(fixtureId);
      if (!eventId) return;
      const event = await fetchSofaEvent(eventId);
      if (!event || event.statusShort !== 'FT') return;
      const stats = await fetchSofaStats(eventId).catch(() => null);
      results.set(fixtureId, {
        goalsHome: event.homeGoals,
        goalsAway: event.awayGoals,
        htHome: event.homeGoalsHT,
        htAway: event.awayGoalsHT,
        corners1H: stats?.firstHalf?.corners,
        cards1H: stats?.firstHalf?.cards,
      });
    } catch {
      // match suivant : retenté au prochain passage
    }
  });
  return results;
}

/** Statuts considérés comme match terminé (API-Football) — même liste que
 * FINISHED_STATUSES dans inPlayCombos.ts (pas exportée de là pour éviter un
 * import croisé avec un module qui dépend lui-même d'autres choses). */
const TIMELINE_FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);

/**
 * Score final extrait du relevé en direct DÉJÀ enregistré pendant le suivi
 * du match (inPlayCombos.ts), sans la moindre requête supplémentaire — bien
 * plus fiable qu'une recherche Omniroute après coup : la source est le même
 * flux qui a servi à émettre les pronostics eux-mêmes, pas une recherche web
 * rétroactive sur un match de division obscure/jeune, souvent introuvable.
 * Score de mi-temps approximé par le dernier relevé de la 1ère mi-temps
 * (aucun score HT explicite dans MatchSample) — suffisant pour les marchés
 * concernés (settleReprojectedLeg).
 */
function extractFinalResultFromTimeline(timeline: MatchSample[]): FinalResult | null {
  const finished = [...timeline].reverse().find((s) => TIMELINE_FINISHED_STATUSES.has(s.statusShort));
  if (!finished) return null;

  const lastFirstHalf = [...timeline].reverse().find((s) => s.statusShort === '1H');

  return {
    goalsHome: finished.homeGoals,
    goalsAway: finished.awayGoals,
    htHome: lastFirstHalf?.homeGoals ?? 0,
    htAway: lastFirstHalf?.awayGoals ?? 0,
  };
}

async function fetchFinalResultsViaOmniroute(
  omnirouteConfig: OmnirouteConfig,
  matches: Array<{ fixtureId: number; homeTeam: string; awayTeam: string }>
): Promise<Map<number, FinalResult>> {
  const results = new Map<number, FinalResult>();

  await mapWithConcurrency(matches, OMNIROUTE_FINAL_RESULT_CONCURRENCY, async ({ fixtureId, homeTeam, awayTeam }) => {
    // Ronde jusqu'à une réponse exploitable : un agent sans outil de recherche
    // répondrait "pas trouvé" et, s'il était en tête de ronde, empêcherait
    // tous les autres de régler le match.
    const result = await askOmnirouteUsable<FinalResult>(
      'Tu es un outil de lecture de résultats de football TERMINÉS. Réponds UNIQUEMENT par un JSON strict, ' +
        "sans texte autour. N'invente RIEN : si ce match n'est pas terminé, ou que tu ne trouves pas son score " +
        'sur une source fiable, réponds avec finished: false.',
      `Match : ${homeTeam} vs ${awayTeam}.\n` +
        'Ce match est-il terminé ? Si oui : score final, score à la mi-temps, et nombre total de corners et de ' +
        'cartons (jaunes + rouges, les deux équipes) en 1ère mi-temps.\n' +
        'Réponds avec ce JSON exact, sans rien autour (null pour une valeur introuvable) :\n' +
        '{"finished": boolean, "home_goals": number|null, "away_goals": number|null, ' +
        '"ht_home_goals": number|null, "ht_away_goals": number|null, ' +
        '"corners_1h": number|null, "cards_1h": number|null}',
      omnirouteConfig,
      (text) => {
        let parsed: any;
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch {
          return null;
        }
        if (!parsed?.finished) return null;

        const goalsHome = parsed.home_goals;
        const goalsAway = parsed.away_goals;
        if (typeof goalsHome !== 'number' || typeof goalsAway !== 'number') return null;

        return {
          goalsHome,
          goalsAway,
          htHome: typeof parsed.ht_home_goals === 'number' ? parsed.ht_home_goals : 0,
          htAway: typeof parsed.ht_away_goals === 'number' ? parsed.ht_away_goals : 0,
          corners1H: typeof parsed.corners_1h === 'number' ? parsed.corners_1h : undefined,
          cards1H: typeof parsed.cards_1h === 'number' ? parsed.cards_1h : undefined,
        };
      },
      undefined,
      `${homeTeam} ${awayTeam} score final résultat corners cartons` // recherche web avant la question
    ).catch((error: any) => {
      console.warn('[Bilan] Résultat final Omniroute échoué:', error?.message);
      return null;
    });

    if (result) results.set(fixtureId, result.value);
  });

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

  // Le côté joué compte : un pari "Moins de 2.5" ou "BTTS Non" était réglé
  // comme son contraire, ce qui faussait la calibration de ces marchés.
  if (market === 'total_buts') return /moins/i.test(selection) ? totalGoals < 2.5 : totalGoals > 2.5;
  if (market === 'btts') {
    const bothScored = result.goalsHome > 0 && result.goalsAway > 0;
    return /\(non\)|ne marquent pas/i.test(selection) ? !bothScored : bothScored;
  }
  if (market === 'buts_1ere_mt') return htGoals >= 1;

  if (market === 'corners' || market === 'cartons') {
    const line = selection.match(/plus de\s+(\d+(?:[.,]\d+)?)/i);
    if (!line || !/1[èe]re mi-temps/i.test(selection)) return null;
    const value = market === 'corners' ? result.corners1H : result.cards1H;
    if (value == null) return null;
    return value > Number(line[1].replace(',', '.'));
  }

  return null; // fautes : pas de source structurée par mi-temps
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

/** Fusionne les points d'une journée dans une série existante — une journée
 * déjà présente (même date + marché) est remplacée, jamais dupliquée. */
function mergeDayPoints(series: MarketDayPoint[], points: MarketDayPoint[]): void {
  for (const point of points) {
    const existingIndex = series.findIndex((p) => p.date === point.date && p.market === point.market);
    if (existingIndex >= 0) series[existingIndex] = point;
    else series.push(point);
  }
}

/**
 * Paris en direct réellement joués (bouton "Placer ce pari", id
 * `live-<proposition>`) : réglés avec le résultat déjà vérifié de chaque
 * jambe de leur proposition. Une jambe sans résultat vérifiable laisse le
 * pari en attente, jamais un statut deviné.
 */
async function settlePlacedLiveBets(proposals: InPlayProposal[]): Promise<void> {
  const byId = new Map(proposals.map((p) => [`live-${p.id}`, p]));
  for (const bet of await getAllBets()) {
    if (!bet.played || bet.status !== 'pending' || !bet.id.startsWith('live-')) continue;
    const proposal = byId.get(bet.id);
    if (!proposal) continue;

    const anyLost = proposal.legs.some((leg) => leg.settled && leg.won === false);
    const allWon = proposal.legs.every((leg) => leg.settled && leg.won === true);
    if (!anyLost && !allWon) continue;

    const stake = bet.stake ?? 0;
    const payout = allWon ? stake * (bet.odds ?? 0) : 0;
    await saveBet({
      ...bet,
      status: allWon ? 'won' : 'lost',
      payout,
      net_pnl: payout - stake,
      legs: bet.legs.map((leg, index) => {
        const source = proposal.legs[index];
        return source?.settled ? { ...leg, result: source.won ? 'won' : 'lost' } : leg;
      }),
      updatedAt: new Date().toISOString(),
    });
  }
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
  const closedPendingDays = lastReviewed >= yesterday ? [] : daysBetween(lastReviewed, yesterday);

  // La journée EN COURS est volontairement retraitée elle aussi (pas
  // seulement "hier") : avec l'ancienne logique, un match qui se terminait
  // à 14h attendait le bilan du LENDEMAIN pour apparaître dans les courbes —
  // et si le tout premier bilan réussi n'arrivait que des jours plus tard
  // (bug désormais corrigé), ses propositions "d'hier" pouvaient déjà avoir
  // été purgées par la fenêtre de 48h sur inplay-proposals.json, donnant
  // "0 point" alors même que la fonction tournait enfin sans erreur.
  // Retraiter aujourd'hui à chaque passage comblerait ce retard — mais
  // coûterait un appel API-Football/Omniroute par match encore en cours à
  // CHAQUE tour (~toutes les 15-20 min), pour rien tant qu'il n'est pas
  // terminé : throttlé à une fois par heure via sa propre clé.
  const lastTodayAttemptRaw = await AsyncStorage.getItem(LAST_TODAY_ATTEMPT_KEY);
  const lastTodayAttempt = lastTodayAttemptRaw ? Number(lastTodayAttemptRaw) : 0;
  const todayDue = Date.now() - lastTodayAttempt >= TODAY_RETRY_INTERVAL_MS;

  // Passage horaire : la veille est RETENTÉE aussi tant que des propositions y
  // restent non réglées (moins de 48 h, avant la purge). Avant, une veille
  // "close" au premier passage n'était jamais revue : ses paris dont le
  // score n'avait pas encore pu être trouvé restaient non réglés pour
  // toujours (111 paris fictifs du 9 octobre).
  const retryDays = [yesterday, today].filter((day) => !closedPendingDays.includes(day));
  const pendingDays = todayDue ? [...closedPendingDays, ...retryDays] : closedPendingDays;
  if (pendingDays.length === 0) return 0;
  if (todayDue) await AsyncStorage.setItem(LAST_TODAY_ATTEMPT_KEY, String(Date.now()));

  const allProposals = readInPlayProposals();
  const apiConfig = await getAPIConfig();

  const series = readMarketSeries();
  // Séries séparées, pour l'écran uniquement (voir le commentaire dans
  // learnStore.ts) — jamais consultées par autoLearn.
  const seriesReal = readMarketSeriesReal();
  const seriesFictional = readMarketSeriesFictional();
  let created = 0;
  const telegramDigests: string[] = [];

  for (const day of pendingDays) {
    // Seules celles pas encore réglées : "today" peut repasser ici plusieurs
    // fois dans la même journée (voir plus haut) — pas la peine de refaire la
    // moindre requête pour une proposition déjà réglée lors d'un passage
    // précédent.
    const unreviewedDayProposals = allProposals.filter(
      (p) => p.createdAt.startsWith(day) && !p.reviewed
    );
    if (unreviewedDayProposals.length === 0) continue;

    // Scans 20e/60e minute (et l'ancien combo mi-temps, pour les
    // enregistrements encore non réglés) : chaque jambe porte son propre
    // fixtureId (un combo porte sur PLUSIEURS matchs différents du même
    // créneau) — récupérés en une seule requête groupée pour toute la
    // journée. Un combo n'est réglé QUE quand TOUS ses matchs ont un score
    // final disponible ; sinon on retente au prochain bilan.
    const allLegs = Array.from(
      new Map(
        unreviewedDayProposals.flatMap((p) => p.legs.map((l) => [l.fixtureId, l] as const))
      ).values()
    );
    // API-Football uniquement pour les paris RÉELS (5 grands championnats) ;
    // les paris fictifs sont réglés par les fournisseurs IA (plus bas).
    const realFixtureIds = new Set(
      unreviewedDayProposals.filter((p) => p.real !== false).flatMap((p) => p.legs.map((l) => l.fixtureId))
    );
    const finals = apiConfig.apiFootball
      ? await fetchFinalResults(apiConfig.apiFootball, Array.from(realFixtureIds).filter((id) => !isSyntheticFixtureId(id)))
      : new Map<number, FinalResult>();

    // SofaScore : résultat publié directement (score, mi-temps, corners et
    // cartons de 1ère MT) pour tout match du pipe fictif qu'il connaît.
    const stillOpen = allLegs.filter((l) => !finals.has(l.fixtureId));
    if (stillOpen.length > 0) {
      const sofaFinals = await fetchFinalResultsViaSofaScore(stillOpen);
      for (const [fixtureId, result] of sofaFinals) finals.set(fixtureId, result);
    }

    // Repli GRATUIT, et plus fiable qu'une recherche : le score déjà capté
    // pendant le suivi en direct du match lui-même (inPlayCombos.ts). C'est
    // la SEULE source pour les matchs fictifs (fixtureId synthétique, jamais
    // connu d'API-Football) — sans lui, ils ne pouvaient être réglés que par
    // une recherche web Omniroute rétroactive, peu fiable sur des divisions
    // obscures/jeunes. Un seul accès au stockage local pour toute la
    // journée, avant toute requête réseau supplémentaire.
    const timelines = await readMatchTimelines(day);
    for (const leg of allLegs) {
      if (finals.has(leg.fixtureId)) continue;
      const result = extractFinalResultFromTimeline(timelines[leg.fixtureId] ?? []);
      if (result) finals.set(leg.fixtureId, result);
    }

    // Repli Omniroute (recherche web rétroactive) : seulement pour ce qui
    // reste non réglé après le relevé en direct ci-dessus — par exemple un
    // match dont le suivi aurait décroché avant la fin (coup d'envoi mal
    // renseigné, app restée fermée pendant toute la fenêtre de fin de
    // match...). Jamais un doublon d'appel pour un match déjà résolu.
    // Corners/cartons de 1ère mi-temps : une requête de statistiques par
    // match terminé concerné (vrais identifiants API-Football uniquement).
    if (apiConfig.apiFootball) {
      const needStats = Array.from(
        new Set(
          allLegs
            .filter((l) => (l.market === 'corners' || l.market === 'cartons') && finals.has(l.fixtureId))
            .filter((l) => realFixtureIds.has(l.fixtureId))
            .filter((l) => finals.get(l.fixtureId)!.corners1H == null && !isSyntheticFixtureId(l.fixtureId))
            .map((l) => l.fixtureId)
        )
      ).slice(0, FIRST_HALF_STATS_MAX_PER_PASS);
      for (const fixtureId of needStats) {
        if (!(await spendDirectBudget('apiFootball'))) break;
        const stats = await fetchFirstHalfStats(apiConfig.apiFootball, fixtureId);
        if (stats) {
          const final = finals.get(fixtureId)!;
          final.corners1H = stats.corners;
          final.cards1H = stats.cards;
        }
      }
    }

    const unresolvedLegs = allLegs.filter((l) => !finals.has(l.fixtureId));
    if (unresolvedLegs.length > 0) {
      const omnirouteConfig = await loadOmnirouteConfig();
      if (omnirouteConfig) {
        const omnirouteFinals = await fetchFinalResultsViaOmniroute(
          omnirouteConfig,
          unresolvedLegs.slice(0, OMNIROUTE_FINAL_RESULT_MAX_PER_PASS)
        );
        for (const [fixtureId, result] of omnirouteFinals) finals.set(fixtureId, result);
      }
    }

    // Chaque jambe réglée part aussi dans le corpus d'expertise empirique :
    // c'est lui qu'autoLearn synthétise marché par marché, et que chaque
    // prédiction suivante consulte (applyMarketExpertise). Sans cette
    // écriture, un match qui se termine n'apprend rien à l'app.
    const settledOutcomes: PredictionOutcome[] = [];

    for (const proposal of unreviewedDayProposals) {
      const allResolved = proposal.legs.every((leg) => finals.has(leg.fixtureId));
      if (!allResolved) continue; // au moins un match du combo n'a pas encore de score final

      for (const leg of proposal.legs) {
        const result = finals.get(leg.fixtureId)!;
        const won = settleReprojectedLeg(leg.market, leg.selection, result);
        if (won == null) continue;
        leg.settled = true;
        leg.won = won;
        settledOutcomes.push({
          ts: new Date().toISOString(),
          fixtureId: leg.fixtureId,
          league: leg.league,
          market: leg.market,
          selection: leg.selection,
          predictedProb: leg.prob,
          won,
          kind: proposal.kind,
          minute: proposal.minute,
          real: proposal.real !== false,
        });
      }
      proposal.reviewed = true;
    }

    if (settledOutcomes.length > 0) appendPredictionOutcomes(settledOutcomes);

    // Le digest Telegram ne porte que sur ce qui vient d'être réglé À CET
    // APPEL (pas tout le règlement cumulé du jour) : "today" peut repasser
    // ici plusieurs fois dans la même journée, et resservir le même bilan à
    // chaque heure serait un spam. `unreviewedDayProposals` n'inclut déjà
    // plus rien de réglé lors d'un passage précédent.
    //
    // Capturé AVANT la fusion des points du jour dans `series` juste
    // dessous : `cumulativeHitRateBefore` doit comparer contre l'historique
    // STRICTEMENT antérieur à `day`, jamais contre lui-même.
    const digestMessage = formatFictionalDigestMessage(
      day,
      buildFictionalMarketStats(unreviewedDayProposals),
      series
    );
    if (digestMessage) telegramDigests.push(digestMessage);

    // Pour la COURBE en revanche, on recalcule sur TOUTES les propositions du
    // jour (réglées à cet appel OU lors d'un appel précédent) : mergeDayPoints
    // REMPLACE le point existant plutôt que de l'additionner, donc repartir
    // seulement de `unreviewedDayProposals` effacerait le travail déjà acquis
    // les passages précédents sur "today".
    const allDayProposals = allProposals.filter((p) => p.createdAt.startsWith(day));
    const points = buildDayPoints(day, allDayProposals);
    mergeDayPoints(series, points);
    created += points.length;

    // Séries séparées (affichage uniquement, voir learnStore.ts) : mêmes
    // points que ci-dessus mais calculés sur un sous-ensemble réel ou fictif
    // de allDayProposals, pour comparer visuellement les deux pipelines.
    mergeDayPoints(seriesReal, buildDayPoints(day, allDayProposals.filter((p) => p.real !== false)));
    mergeDayPoints(seriesFictional, buildDayPoints(day, allDayProposals.filter((p) => p.real === false)));
  }

  try {
    await settlePlacedLiveBets(allProposals);
  } catch (error: any) {
    console.warn('[Bilan] Règlement des paris en direct placés échoué:', error.message);
  }

  writeInPlayProposals(allProposals);
  writeMarketSeries(series.sort((a, b) => a.date.localeCompare(b.date)));
  writeMarketSeriesReal(seriesReal.sort((a, b) => a.date.localeCompare(b.date)));
  writeMarketSeriesFictional(seriesFictional.sort((a, b) => a.date.localeCompare(b.date)));
  // N'avance que si une journée CLOSE a été rattrapée — "today" seul ne doit
  // jamais marquer le rattrapage quotidien comme à jour, sinon la vraie
  // journée d'hier pourrait être sautée si elle restait à traiter.
  if (closedPendingDays.length > 0) {
    await AsyncStorage.setItem(LAST_REVIEW_KEY, yesterday);
  }

  for (const digest of telegramDigests) {
    await sendTelegramMessage(digest);
  }

  return created;
}
