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

import AsyncStorage from './kvStore';
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
  legOdds,
  CURVE_MIN_ODDS,
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
import { HubPlayerShots, hubFinalResult, hubLiveStatus, hubPlayerShots, hubStats } from '../api/footballDataAPIs/liveDataHub';
import { playerSotFromSelection } from './playerShots';
import { LegExplanation, explainSettledLeg, flushPatterns, ingestMatch, saveExplanations } from './patternEngine';
import { digestPlayers } from './matchDigest';
import { EVENING_PARTS, EveningPart, buildEveningMessage } from './eveningReport';
import { syncFullBackupToGitHub } from './gitAutoSync';
import { liveLegVerdict } from './liveBetStatus';
import { DeltaUnit, invalidateDeltaCache, settleShadowProjections } from './deltaLearning';
import { fetchSofaEvent, fetchSofaStats, getSofaEventId } from '../api/footballDataAPIs/sofaScore';

const LAST_REVIEW_KEY = '@last_daily_review';
const LAST_ELO_SYNC_KEY = '@last_elo_sync';
const LAST_TODAY_ATTEMPT_KEY = '@last_today_review_attempt';
/** Nombre maximum de journées rattrapées d'un coup (app restée fermée). */
const MAX_CATCHUP_DAYS = 7;
/** Fréquence de retraitement de la journée EN COURS (voir plus bas) — pas
 * plus souvent, pour ne pas multiplier les appels API-Football/Omniroute sur
 * des matchs encore en cours, qui échoueraient de toute façon à chaque essai. */
const TODAY_RETRY_INTERVAL_MS = 15 * 60_000;

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

export interface FinalResult {
  goalsHome: number;
  goalsAway: number;
  htHome: number;
  htAway: number;
  /** Corners et cartons (jaunes + rouges) de la 1ère mi-temps, quand
   * API-Football les fournit (fixtures/statistics avec half=true). */
  corners1H?: number;
  cards1H?: number;
  /** Corners / cartons du match entier. */
  cornersFT?: number;
  /** Corners de chaque équipe sur le match (marché « corners par équipe »). */
  cornersHomeFT?: number;
  cornersAwayFT?: number;
  cardsFT?: number;
  fouls1H?: number;
  foulsFT?: number;
  /** Tirs cadrés par joueur en fin de match (ESPN) : marché « tirs cadrés joueur ». */
  playerSot?: HubPlayerShots[];
  /** Corners / cartons de notre propre relevé minute par minute : dernier recours si aucune source en ligne ne les donne. */
  tlCounts?: { cornersFT?: number; cardsFT?: number; corners1H?: number; cards1H?: number };
}

/** Matchs réglés via les sources live gratuites par passage du bilan. */
const HUB_FINAL_RESULT_MAX_PER_PASS = 150;

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
    if (!reviewTimeLeft()) return;
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
        cornersFT: stats?.all?.corners,
        cardsFT: stats?.all?.cards,
        fouls1H: stats?.firstHalf?.fouls || undefined,
        foulsFT: stats?.all?.fouls || undefined,
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
  // Corners / cartons à la pause : relevé pris pendant la mi-temps (certain), sinon dernier relevé de la 1ère MT à 45'+.
  const atBreak = timeline.find((s) => s.statusShort === 'HT') ?? (lastFirstHalf && lastFirstHalf.minute >= 45 ? lastFirstHalf : undefined);

  return {
    goalsHome: finished.homeGoals,
    goalsAway: finished.awayGoals,
    htHome: lastFirstHalf?.homeGoals ?? 0,
    htAway: lastFirstHalf?.awayGoals ?? 0,
    // Corners et cartons (jaunes) relevés pendant le match : sans eux, les paris corners/cartons des matchs fictifs
    // attendaient une source en ligne plafonnée par passage, et beaucoup restaient sans verdict.
    tlCounts: { cornersFT: finished.cornersTotal, cardsFT: finished.cardsTotal, corners1H: atBreak?.cornersTotal, cards1H: atBreak?.cardsTotal },
  } as FinalResult;
}

async function fetchFinalResultsViaOmniroute(
  omnirouteConfig: OmnirouteConfig,
  matches: Array<{ fixtureId: number; homeTeam: string; awayTeam: string }>
): Promise<Map<number, FinalResult>> {
  const results = new Map<number, FinalResult>();

  await mapWithConcurrency(matches, OMNIROUTE_FINAL_RESULT_CONCURRENCY, async ({ fixtureId, homeTeam, awayTeam }) => {
    if (!reviewTimeLeft()) return;
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
export function settleReprojectedLeg(
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
  if (market === 'total_buts') {
    const m = /(plus|moins) de\s+(\d+(?:[.,]\d+)?)/i.exec(selection);
    const line = m ? Number(m[2].replace(',', '.')) : 2.5;
    return /moins/i.test(selection) ? totalGoals < line : totalGoals > line;
  }
  if (market === 'btts') {
    const bothScored = result.goalsHome > 0 && result.goalsAway > 0;
    return /\(non\)|ne marquent pas/i.test(selection) ? !bothScored : bothScored;
  }
  if (market === 'buts_1ere_mt') return /0-0 à la pause|pas de but/i.test(selection) ? htGoals === 0 : htGoals >= 1;

  // Marchés par équipe : « Plus de 0.5 but — Arsenal (domicile) », « Moins de 4.5 corners — Lens (extérieur) ».
  if (market === 'buts_equipe' || market === 'corners_equipe') {
    const m = /^(plus|moins) de\s+(\d+(?:[.,]\d+)?)/i.exec(selection);
    const side = /\(domicile\)/i.test(selection) ? 'home' : /\(extérieur\)/i.test(selection) ? 'away' : null;
    if (!m || !side) return null;
    const line = Number(m[2].replace(',', '.'));
    const value =
      market === 'buts_equipe' ? (side === 'home' ? result.goalsHome : result.goalsAway) : side === 'home' ? result.cornersHomeFT : result.cornersAwayFT;
    if (value == null) return null;
    return /^moins/i.test(selection) ? value < line : value > line;
  }

  if (market === 'tirs_cadres') {
    const line = selection.match(/(plus|moins) de\s+(\d+(?:[.,]\d+)?)/i);
    if (!line || result.playerSot == null) return null;
    const value = playerSotFromSelection(selection, result.playerSot);
    if (value == null) return null;
    const threshold = Number(line[2].replace(',', '.'));
    return /moins/i.test(line[1]) ? value < threshold : value > threshold;
  }

  if (market === 'corners' || market === 'cartons' || market === 'fautes') {
    const line = selection.match(/(plus|moins) de\s+(\d+(?:[.,]\d+)?)/i);
    if (!line) return null;
    const fullMatch = /sur le match/i.test(selection);
    if (!fullMatch && !/1[èe]re mi-temps/i.test(selection)) return null;
    const value =
      market === 'corners' ? (fullMatch ? result.cornersFT : result.corners1H)
      : market === 'cartons' ? (fullMatch ? result.cardsFT : result.cards1H)
      : fullMatch ? result.foulsFT : result.fouls1H;
    if (value == null) return null;
    const threshold = Number(line[2].replace(',', '.'));
    return /moins/i.test(line[1]) ? value < threshold : value > threshold;
  }

  return null;
}

/** Valeur réelle d'une fenêtre de comptage, pour mesurer l'écart avec la projection. */
function actualValueFor(unit: DeltaUnit, result: FinalResult): number | null {
  if (unit === 'corners_1h') return result.corners1H ?? null;
  if (unit === 'cards_1h') return result.cards1H ?? null;
  if (unit === 'corners_ft') return result.cornersFT ?? null;
  if (unit === 'cards_ft') return result.cardsFT ?? null;
  if (unit === 'fouls_1h') return result.fouls1H ?? null;
  if (unit === 'fouls_ft') return result.foulsFT ?? null;
  if (unit === 'goals_1h') return result.htHome + result.htAway;
  return result.goalsHome + result.goalsAway;
}

/** Agrège les jambes réglées d'une journée en un point de courbe par marché. */
function buildDayPoints(date: string, proposals: InPlayProposal[]): MarketDayPoint[] {
  const byMarket = new Map<TrackedMarket, { correct: number; total: number; predictedSum: number }>();

  for (const proposal of proposals) {
    for (const leg of proposal.legs) {
      // Courbes : paris réglés (verdict connu) ET jouables (cote ≥ 1,40 : bookmaker saisie, sinon estimée).
      if (!leg.settled || legOdds(leg) < CURVE_MIN_ODDS) continue;
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
    if (!bet.played || !bet.id.startsWith('live-')) continue;
    // Un pari déjà réglé est revérifié s'il date de moins de 2 jours : un verdict corrigé sur le résultat final le corrige aussi.
    const recent = Date.now() - Date.parse(bet.createdAt) < 2 * 86_400_000;
    if (bet.status !== 'pending' && !(recent && (bet.status === 'won' || bet.status === 'lost'))) continue;
    const proposal = byId.get(bet.id);
    if (!proposal) continue;

    const anyLost = proposal.legs.some((leg) => leg.settled && leg.won === false);
    const allWon = proposal.legs.every((leg) => leg.settled && leg.won === true);
    if (!anyLost && !allWon) continue;
    if (bet.status === (allWon ? 'won' : 'lost')) continue;

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
/** Budget de temps d'un passage du bilan : au-delà, plus aucune nouvelle
 * recherche de résultat n'est lancée (le reste passe au passage suivant) —
 * un bilan de 20 min retardait les scans en direct au point de rater la
 * fenêtre de la 20e minute des matchs réels. */
const REVIEW_TIME_BUDGET_MS = 3 * 60_000;
const CATCHUP_KEY = '@review_catchup_attempts';
const VOID_AFTER_MS = 48 * 3_600_000;
const REVIEW_BUDGET_MS = 4 * 60_000;
let reviewDeadline = Infinity;
const reviewTimeLeft = () => Date.now() < reviewDeadline;

const PATTERN_BACKFILL_KEY = '@pattern_backfill';
const PATTERN_BACKFILL_EVERY_MS = 20 * 60_000;

const timelinePoints = (tl: MatchSample[]) =>
  tl.map((x) => ({ minute: x.minute, h: x.homeGoals, a: x.awayGoals, sot: x.shotsOnTargetHome != null ? x.shotsOnTargetHome + (x.shotsOnTargetAway ?? 0) : undefined, corners: x.cornersTotal, cards: x.cardsTotal }));

/**
 * MOTIFS : tous les matchs fictifs terminés dont la chronologie est en mémoire (y compris les jours passés, avec ou sans
 * pari proposé) alimentent le moteur de motifs. Toutes les 20 min ; un jour clos entièrement lu n'est plus relu.
 */
async function ingestAllTimelinesIntoPatterns(): Promise<void> {
  let state: { at: number; doneDays: string[] } = { at: 0, doneDays: [] };
  try {
    state = { ...state, ...JSON.parse((await AsyncStorage.getItem(PATTERN_BACKFILL_KEY)) ?? '{}') };
  } catch {
    // état absent : tout relire
  }
  if (Date.now() - state.at < PATTERN_BACKFILL_EVERY_MS) return;
  const prefix = '@fictional_timeline_';
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  const done = new Set(state.doneDays);
  for (const key of keys.sort()) {
    const day = key.slice(prefix.length);
    if (done.has(day)) continue;
    const timelines = await readMatchTimelines(day);
    for (const [fixtureId, tl] of Object.entries(timelines)) {
      if (!tl || tl.length < 2) continue;
      const final = extractFinalResultFromTimeline(tl);
      if (!final) continue;
      const last = [...tl].reverse().find((x) => TIMELINE_FINISHED_STATUSES.has(x.statusShort));
      await ingestMatch(`f:${day}:${fixtureId}`, timelinePoints(tl), { h: final.goalsHome, a: final.goalsAway, htH: final.htHome, htA: final.htAway, corners: last?.cornersTotal, cards: last?.cardsTotal });
    }
    if (day < yesterday) done.add(day);
  }
  await flushPatterns();
  await AsyncStorage.setItem(PATTERN_BACKFILL_KEY, JSON.stringify({ at: Date.now(), doneDays: Array.from(done) })).catch(() => {});
}

export async function runNightlyReviewIfDue(): Promise<number> {
  reviewDeadline = Date.now() + REVIEW_TIME_BUDGET_MS;
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
  // Valeurs réelles des matchs suivis sans pari (écarts projeté/réel).
  try {
    await settleShadowProjections(Date.now() + 60_000);
  } catch (error: any) {
    console.warn('[Bilan] Mesure des écarts échouée:', error?.message);
  }

  const lastTodayAttemptRaw = await AsyncStorage.getItem(LAST_TODAY_ATTEMPT_KEY);
  const lastTodayAttempt = lastTodayAttemptRaw ? Number(lastTodayAttemptRaw) : 0;
  const todayDue = Date.now() - lastTodayAttempt >= TODAY_RETRY_INTERVAL_MS;

  // Passage horaire : la veille est RETENTÉE aussi tant que des propositions y
  // restent non réglées (moins de 48 h, avant la purge). Avant, une veille
  // "close" au premier passage n'était jamais revue : ses paris dont le
  // score n'avait pas encore pu être trouvé restaient non réglés pour
  // toujours (111 paris fictifs du 9 octobre).
  try {
    await ingestAllTimelinesIntoPatterns();
  } catch (error: any) {
    console.warn('[Bilan] Motifs (chronologies) échoués:', error?.message);
  }

  const retryDays = [yesterday, today].filter((day) => !closedPendingDays.includes(day));
  const pendingDays = todayDue ? [...closedPendingDays, ...retryDays] : [...closedPendingDays];
  const allProposals = readInPlayProposals();
  const reviewStartedAt = Date.now();

  // RATTRAPAGE : jours passés (14 derniers) où des paris n'ont pas encore de verdict (stat manquante au premier bilan).
  // Chaque jour est retenté au plus toutes les 6 h, 2 jours par passage — les courbes et la calibration ne gardent
  // ainsi aucun trou silencieux.
  try {
    const attempts: Record<string, number> = JSON.parse((await AsyncStorage.getItem(CATCHUP_KEY)) ?? '{}');
    const oldest = dayKey(new Date(Date.now() - 14 * 86_400_000));
    const open = Array.from(new Set(allProposals.filter((p) => p.legs.some((l) => !l.settled && !l.voided)).map((p) => p.createdAt.slice(0, 10))))
      .filter((d) => d >= oldest && d < yesterday && !pendingDays.includes(d) && Date.now() - (attempts[d] ?? 0) >= 6 * 3_600_000)
      .sort()
      .slice(0, 2);
    for (const d of open) attempts[d] = Date.now();
    for (const d of Object.keys(attempts)) if (d < oldest) delete attempts[d];
    if (open.length) await AsyncStorage.setItem(CATCHUP_KEY, JSON.stringify(attempts));
    pendingDays.push(...open);
  } catch {
    // rattrapage best-effort
  }
  if (pendingDays.length === 0) return 0;
  if (todayDue) await AsyncStorage.setItem(LAST_TODAY_ATTEMPT_KEY, String(Date.now()));

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
      // Revu mais une jambe restée sans verdict (stat du joueur pas encore disponible…) : repris aux bilans suivants.
      (p) => p.createdAt.startsWith(day) && (!p.reviewed || p.legs.some((l) => !l.settled && !l.voided))
    );
    if (unreviewedDayProposals.length === 0) continue;
    // Budget : au-delà de 4 min, les jours de reprise (aujourd'hui, rattrapage) attendent le passage suivant — le tour de
    // fond doit encore relever les matchs en direct. Le bilan de la veille (jour clos) passe toujours.
    if (!closedPendingDays.includes(day) && Date.now() - reviewStartedAt > REVIEW_BUDGET_MS) continue;

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
    // TOUTES les jambes (allLegs n'en garde qu'une par match) : un match peut porter un pari buts ET un pari corners ET un
    // pari tirs cadrés — chaque étape ci-dessous doit voir le marché de chacune, sinon la stat n'est jamais demandée.
    const everyLeg = unreviewedDayProposals.flatMap((p) => p.legs);
    const oneLegPerMatch = <T extends { fixtureId: number }>(legs: T[]) => Array.from(new Map(legs.map((l) => [l.fixtureId, l])).values());
    const needsHalfFor = (fixtureId: number) =>
      everyLeg.some((l) => l.fixtureId === fixtureId && (l.market === 'buts_1ere_mt' || (['corners', 'cartons', 'fautes'].includes(l.market) && !/sur le match/i.test(l.selection))));
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

    // Sources live gratuites réunies (LiveScore, FotMob, 365Scores, ESPN,
    // AllSportsApi, TheSportsDB) : score validé par plusieurs sources, score à
    // la pause et stats de 1ère mi-temps prises chez la première qui les a.
    // Vaut pour les paris fictifs ET les réels quand API-Football n'a plus de
    // requêtes.
    const hubPending = allLegs.filter((l) => !finals.has(l.fixtureId)).slice(0, HUB_FINAL_RESULT_MAX_PER_PASS);
    await mapWithConcurrency(hubPending, 4, async (leg) => {
      if (!reviewTimeLeft()) return;
      let result = await hubFinalResult(leg.homeTeam, leg.awayTeam, day).catch(() => null);
      // Pari sur le match entier : le score final suffit, sans score à la pause (sauf si UN des paris du match en dépend).
      const needsHalf = needsHalfFor(leg.fixtureId);
      if (!result && !needsHalf) result = await hubFinalResult(leg.homeTeam, leg.awayTeam, day, { needHalfTime: false }).catch(() => null);
      if (result) finals.set(leg.fixtureId, result);
    });

    // Corners / cartons du match entier manquants (score venu d'API-Football,
    // qui ne les donne pas ici) : complétés par les sources live gratuites.
    const needCounts = oneLegPerMatch(everyLeg.filter((l) => {
      const final = finals.get(l.fixtureId);
      if (!final) return false;
      const ft = /sur le match/i.test(l.selection);
      if (l.market === 'corners') return (ft ? final.cornersFT : final.corners1H) == null;
      if (l.market === 'cartons') return (ft ? final.cardsFT : final.cards1H) == null;
      if (l.market === 'fautes') return (ft ? final.foulsFT : final.fouls1H) == null;
      if (l.market === 'corners_equipe') return final.cornersHomeFT == null || final.cornersAwayFT == null;
      return false;
    }));
    await mapWithConcurrency(needCounts.slice(0, HUB_FINAL_RESULT_MAX_PER_PASS), 4, async (leg) => {
      if (!reviewTimeLeft()) return;
      const stats = await hubStats(leg.homeTeam, leg.awayTeam, day).catch(() => null);
      const final = finals.get(leg.fixtureId);
      if (!final || !stats) return;
      final.cornersFT ??= stats.all?.corners;
      final.cornersHomeFT ??= stats.all?.cornersHome;
      final.cornersAwayFT ??= stats.all?.cornersAway;
      final.cardsFT ??= stats.all?.cards;
      final.foulsFT ??= stats.all?.fouls || undefined;
      final.corners1H ??= stats.firstHalf?.corners;
      final.cards1H ??= stats.firstHalf?.cards;
      final.fouls1H ??= stats.firstHalf?.fouls || undefined;
    });

    // Dernier recours pour les corners / cartons encore manquants : notre relevé minute par minute du match.
    for (const final of finals.values()) {
      const t = final.tlCounts;
      if (!t) continue;
      final.cornersFT ??= t.cornersFT;
      final.cardsFT ??= t.cardsFT;
      final.corners1H ??= t.corners1H;
      final.cards1H ??= t.cards1H;
    }

    // Tirs cadrés par joueur (marché « tirs cadrés joueur ») : ESPN, une requête par match concerné.
    const needPlayers = Array.from(new Map(everyLeg.filter((l) => l.market === 'tirs_cadres' && finals.has(l.fixtureId) && !finals.get(l.fixtureId)!.playerSot).map((l) => [l.fixtureId, l])).values());
    await mapWithConcurrency(needPlayers.slice(0, HUB_FINAL_RESULT_MAX_PER_PASS), 4, async (leg) => {
      if (!reviewTimeLeft()) return;
      // ESPN, sinon les stats des joueurs gardées dans le résumé du match (relevé en direct).
      const players = (await hubPlayerShots(leg.homeTeam, leg.awayTeam, day).catch(() => null)) ?? ((await digestPlayers(day, leg.homeTeam, leg.awayTeam).catch(() => null)) as any);
      const final = finals.get(leg.fixtureId);
      if (final && players) final.playerSot = players;
    });

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
          everyLeg
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

    // MOTIFS : chaque match terminé dont on a la chronologie (pipe fictif) est rejoué à la 15e/30e/mi-temps/60e/75e pour
    // apprendre ce qui suit chaque situation (voir patternEngine.ts). Une seule fois par match.
    try {
      for (const [fixtureId, final] of finals) {
        const tl = timelines[fixtureId];
        if (!tl || tl.length < 2) continue;
        await ingestMatch(
          `f:${day}:${fixtureId}`,
          timelinePoints(tl),
          { h: final.goalsHome, a: final.goalsAway, htH: final.htHome, htA: final.htAway, corners: final.cornersFT, cards: final.cardsFT }
        );
      }
      await flushPatterns();
    } catch {
      // apprentissage best-effort
    }

    // Aucune recherche par IA : les résultats viennent uniquement des sources de données
    // (API-Football, puis les 6 sources live gratuites).

    // Chaque jambe réglée part aussi dans le corpus d'expertise empirique :
    // c'est lui qu'autoLearn synthétise marché par marché, et que chaque
    // prédiction suivante consulte (applyMarketExpertise). Sans cette
    // écriture, un match qui se termine n'apprend rien à l'app.
    const settledOutcomes: PredictionOutcome[] = [];

    // Règlement EN COURS DE MATCH : une jambe dont le verdict est déjà certain d'après
    // les sources live gratuites (ligne franchie) est réglée tout de suite. Une jambe
    // réglée à tort sur un match qui se joue encore (le live ne la confirme pas) est
    // remise en jeu.
    for (const p of allProposals) {
      if (!p.createdAt.startsWith(day)) continue;
      for (const l of p.legs) {
        if (finals.has(l.fixtureId)) continue; // match terminé : le règlement final s'en charge
        const live = await hubLiveStatus(l.homeTeam, l.awayTeam).catch(() => null);
        if (!live || !['1H', 'HT', '2H'].includes(live.statusShort)) continue;
        const verdict = await liveLegVerdict(l, day).catch(() => 'pending' as const);
        if (verdict !== 'pending') {
          if (!l.settled || l.won !== (verdict === 'won')) {
            l.settled = true;
            l.won = verdict === 'won';
          }
        } else if (l.settled) {
          l.settled = false;
          l.won = undefined;
          if (l.projection) l.projection.actual = undefined;
          p.reviewed = false;
        }
      }
    }

    // CONTRÔLE DE COHÉRENCE (réel ET fictif) : toute jambe d'un match terminé est recalculée sur le résultat final ; une valeur
    // enregistrée différente (réglée en cours de match sur un score faux) est corrigée, et la correction est journalisée et
    // reversée dans les résultats mesurés pour que les courbes et la calibration ne gardent pas l'erreur.
    const audit: Array<{ at: string; match: string; selection: string; was: string; now: string; real: boolean }> = [];
    const corrected: PredictionOutcome[] = [];
    for (const p of allProposals) {
      if (!p.createdAt.startsWith(day)) continue;
      for (const l of p.legs) {
        const result = finals.get(l.fixtureId);
        if (!result || !l.settled) continue;
        const truth = settleReprojectedLeg(l.market, l.selection, result);
        if (truth == null || truth === l.won) continue;
        audit.push({ at: new Date().toISOString(), match: `${l.homeTeam} - ${l.awayTeam}`, selection: l.selection, was: l.won ? 'gagné' : 'perdu', now: truth ? 'gagné' : 'perdu', real: p.real !== false });
        l.won = truth;
        corrected.push({ ts: new Date().toISOString(), fixtureId: l.fixtureId, league: l.league, market: l.market, selection: l.selection, predictedProb: l.prob, won: truth, kind: p.kind, minute: p.minute, real: p.real !== false });
      }
    }
    if (audit.length > 0) {
      appendPredictionOutcomes(corrected);
      try {
        const old = JSON.parse((await AsyncStorage.getItem('@settlement_audit')) ?? '[]');
        await AsyncStorage.setItem('@settlement_audit', JSON.stringify([...old, ...audit]));
      } catch {
        // journal best-effort
      }
    }

    const explanations: LegExplanation[] = [];
    for (const proposal of unreviewedDayProposals) {
      // 48 h après le pari, une jambe toujours sans verdict est ANNULÉE : comptée à part, exclue des courbes et de la
      // calibration, plus jamais retentée (au lieu de rester « en attente » et de fausser les taux).
      const expired = Date.now() - Date.parse(proposal.createdAt) > VOID_AFTER_MS;
      const allResolved = proposal.legs.every((leg) => finals.has(leg.fixtureId));
      if (!allResolved) {
        if (expired) {
          for (const leg of proposal.legs) if (!leg.settled) leg.voided = true;
          proposal.reviewed = true;
        }
        continue; // au moins un match du combo n'a pas encore de score final
      }

      for (const leg of proposal.legs) {
        const result = finals.get(leg.fixtureId)!;
        // Écart projeté / réel (deltaLearning.ts) : mesuré même quand la
        // ligne ne se règle pas, pour corriger les projections suivantes.
        if (leg.projection && leg.projection.actual == null) {
          const actual = actualValueFor(leg.projection.unit, result);
          if (actual != null) leg.projection.actual = actual;
        }
        const won = settleReprojectedLeg(leg.market, leg.selection, result);
        if (won == null) continue;
        leg.settled = true;
        leg.won = won;
        // Pourquoi ce pari a réussi / raté (chiffres + motifs de la situation au moment du pari).
        try {
          const tl = timelines[leg.fixtureId] ?? [];
          const at = [...tl].reverse().find((x) => x.minute <= (proposal.minute ?? 0));
          const [sh, sa] = (leg.scoreLabel ?? '0-0').split('-').map(Number);
          const point = at
            ? { minute: at.minute, h: at.homeGoals, a: at.awayGoals, sot: at.shotsOnTargetHome != null ? at.shotsOnTargetHome + (at.shotsOnTargetAway ?? 0) : undefined, corners: at.cornersTotal, cards: at.cardsTotal }
            : { minute: proposal.minute ?? 0, h: sh || 0, a: sa || 0 };
          explanations.push(
            await explainSettledLeg({
              day,
              real: proposal.real !== false,
              match: `${leg.homeTeam} - ${leg.awayTeam}`,
              market: leg.market,
              selection: leg.selection,
              prob: leg.prob,
              won,
              point,
              expected: leg.projection?.expected,
              actual: leg.projection?.actual,
              unitLabel: leg.market === 'total_buts' ? 'buts' : leg.market === 'corners' ? 'corners' : leg.market === 'cartons' ? 'cartons' : leg.market === 'fautes' ? 'fautes' : '',
            })
          );
        } catch {
          // explication best-effort
        }
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
      // « Revu » seulement quand toutes les jambes ont un verdict : sinon la courbe ne compterait que les jambes réglées
      // (1 tir cadré gagné sur 3 affiché 100 %). Au-delà de 3 jours sans verdict possible, on abandonne.
      if (expired) for (const leg of proposal.legs) if (!leg.settled) leg.voided = true;
      if (proposal.legs.every((l) => l.settled || l.voided)) proposal.reviewed = true;
    }

    if (settledOutcomes.length > 0) appendPredictionOutcomes(settledOutcomes);
    await saveExplanations(explanations).catch(() => {});

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

  // Relu juste avant d'écrire : le bilan peut durer plusieurs minutes (sources
  // live interrogées match par match) et un autre tour a pu créer des
  // propositions entre-temps — les écraser avec la copie lue au début les
  // ferait disparaître. Seules les propositions réglées ici sont remplacées.
  const reviewedById = new Map(allProposals.map((p) => [p.id, p]));
  const current = readInPlayProposals();
  const currentIds = new Set(current.map((p) => p.id));
  writeInPlayProposals([
    ...current.map((p) => reviewedById.get(p.id) ?? p),
    ...allProposals.filter((p) => !currentIds.has(p.id)),
  ]);
  invalidateDeltaCache();
  // COURBES RECALCULÉES EN ENTIER à chaque bilan, à partir des paris eux-mêmes : un point calculé quand une partie des
  // paris du jour n'avait pas encore de verdict (1 tir cadré réglé sur 3 → 100 %), puis jamais repris, ne peut plus rester
  // faux. Les corrections du contrôle, les rattrapages et les annulations (exclues) y sont toujours pris en compte.
  const byDay = new Map<string, typeof allProposals>();
  for (const p of allProposals) {
    const d = p.createdAt.slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(p);
  }
  const rebuilt: MarketDayPoint[] = [];
  const rebuiltReal: MarketDayPoint[] = [];
  const rebuiltFict: MarketDayPoint[] = [];
  for (const [d, list] of byDay) {
    rebuilt.push(...buildDayPoints(d, list));
    rebuiltReal.push(...buildDayPoints(d, list.filter((p) => p.real !== false)));
    rebuiltFict.push(...buildDayPoints(d, list.filter((p) => p.real === false)));
  }
  // Jours plus anciens que les paris conservés (aucun ici, rien n'est purgé) : gardés tels quels.
  const keepOld = (old: MarketDayPoint[], fresh: MarketDayPoint[]) => [...old.filter((p) => !byDay.has(p.date)), ...fresh];
  writeMarketSeries(keepOld(series, rebuilt).sort((a, b) => a.date.localeCompare(b.date)));
  writeMarketSeriesReal(keepOld(seriesReal, rebuiltReal).sort((a, b) => a.date.localeCompare(b.date)));
  writeMarketSeriesFictional(keepOld(seriesFictional, rebuiltFict).sort((a, b) => a.date.localeCompare(b.date)));
  // N'avance que si une journée CLOSE a été rattrapée — "today" seul ne doit
  // jamais marquer le rattrapage quotidien comme à jour, sinon la vraie
  // journée d'hier pourrait être sautée si elle restait à traiter.
  if (closedPendingDays.length > 0) {
    await AsyncStorage.setItem(LAST_REVIEW_KEY, yesterday);
  }

  // Plus d'envoi à chaque passage : « today » repasse ici toutes les 15 min et
  // chaque règlement partiel envoyait un bilan (des dizaines dans la journée).
  // Un seul bilan par soir, à 23h30 (voir sendEveningDigestIfDue).
  void telegramDigests;

  return created;
}


const EVENING_DIGEST_KEY = '@evening_digest_sent_date';
const EVENING_PARTS_KEY = '@evening_digest_parts';
/** Heure locale du bilan unique du soir. */
const EVENING_DIGEST_HOUR = 23;
const EVENING_DIGEST_MINUTE = 30;

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Bilan UNIQUE du soir (Telegram), à partir de 23h30 locales : tout ce qui a
 * été réglé aujourd'hui sur les paris fictifs, par marché, avec la tendance
 * face à l'historique. Marqué envoyé seulement si Telegram a accepté le
 * message ; un tour de plus le même soir ne renvoie rien.
 */
export async function sendEveningDigestIfDue(): Promise<boolean> {
  const now = new Date();
  const lastSent = await AsyncStorage.getItem(EVENING_DIGEST_KEY);
  let day = localDay(now);
  let late = false;
  if (now.getHours() * 60 + now.getMinutes() < EVENING_DIGEST_HOUR * 60 + EVENING_DIGEST_MINUTE) {
    // Rapport de la veille manqué (téléphone éteint, tour de fond bloqué…) : envoyé le lendemain, signalé en retard.
    const yesterday = localDay(new Date(now.getTime() - 86_400_000));
    if (!lastSent || lastSent >= yesterday) return false;
    day = yesterday;
    late = true;
  }
  if (lastSent === day) return false;

  // 4 messages séparés ; chacun marqué envoyé seul, un échec Telegram n'en fait pas renvoyer un autre.
  let state: { day: string; sent: EveningPart[] } = { day, sent: [] };
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(EVENING_PARTS_KEY)) ?? 'null');
    if (raw?.day === day) state = raw;
  } catch {
    // état illisible : on repart de zéro pour ce soir
  }
  if (state.sent.length === 0) await syncFullBackupToGitHub(true).catch(() => {});
  let sentAny = false;
  for (const part of EVENING_PARTS) {
    if (state.sent.includes(part)) continue;
    const body = await buildEveningMessage(part, day).catch((error: any) => `⚠️ Rapport « ${part} » indisponible : ${error?.message ?? error}`);
    const text = late ? `⏰ Rapport du ${day.split('-').reverse().join('/')}, envoyé en retard\n\n${body}` : body;
    if (!(await sendTelegramMessage(text))) continue;
    state.sent.push(part);
    sentAny = true;
    await AsyncStorage.setItem(EVENING_PARTS_KEY, JSON.stringify(state));
  }
  if (state.sent.length === EVENING_PARTS.length) await AsyncStorage.setItem(EVENING_DIGEST_KEY, day);
  return sentAny;
}
