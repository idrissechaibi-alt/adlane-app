// Scan en direct — le match est SUIVI, pas photographié : la surveillance
// commence au coup d'envoi et se poursuit jusqu'au point de décision, de sorte
// que le pronostic s'appuie sur l'évolution réelle de la rencontre.
//
//   - Du coup d'envoi à la 20e minute : relevés réguliers (score, tirs cadrés,
//     corners, cartons). À la 20e, pronostics sur le but en 1ère MT, les
//     corners et cartons de la période (projetés au RYTHME constaté entre les
//     relevés, pas à la moyenne depuis le coup d'envoi), plus BTTS et total du
//     match entier.
//   - De la mi-temps à la 60e minute : la surveillance reprend, puis
//     pronostics sur le reste du match (résultat, BTTS, total buts).
//   - En fin de match : chaque jambe est confrontée au score réel et le
//     résultat repart dans la boucle d'apprentissage (voir dailyReview.ts).
//
// DEUX pipelines séparés, sur le même principe mais des ressources et une
// présentation différentes (demande explicite) :
//
//   A) Paris RÉELS — les 5 grands championnats seulement, ceux sur lesquels
//      de l'argent réel est misé. Utilise TOUTES les ressources disponibles
//      (cotes de marché, Football-Data.co.uk, mémoire d'auto-apprentissage,
//      contexte déjà collecté). Présentation calquée sur l'ancien Planning
//      du Jour : par CRÉNEAU HORAIRE (pas par match isolé) — un créneau de
//      moins de 3 matchs propose un pari SIMPLE par match (sa meilleure
//      jambe) ; un créneau de 3 matchs ou plus propose des COMBOS de 3
//      jambes (une par match DIFFÉRENT du créneau, jamais plusieurs marchés
//      du même match combinés ensemble), jusqu'à 2 combos par créneau et par
//      checkpoint. Seules ces propositions sont notifiées et affichées dans
//      "Combos en direct du jour".
//   B) Paris FICTIFS — tout l'univers de matchs suivi (matchUniverse, ~28
//      pays), UNIQUEMENT avec des ressources GRATUITES (aucune cote, aucune
//      API payante) : Football-Data.co.uk pour les buts attendus ET les
//      corners/cartons quand le championnat y est couvert (cinq grands
//      championnats aujourd'hui), et Omniroute en repli pour les buts
//      attendus partout ailleurs (auto-hébergé, sans quota — élargit la
//      couverture gratuitement plutôt que de laisser tout le reste de
//      l'univers sans aucune estimation). AUCUN combo : une batterie de
//      paris SIMPLES indépendants, un par marché qualifié (le maximum
//      possible), pour comparer estimation vs réalité marché par marché et
//      affûter le modèle utilisé ensuite sur les vrais matchs. Jamais
//      notifié, jamais affiché comme un vrai pari. Retraite aussi les
//      matchs déjà couverts par le pipeline réel (dédoublonnage indépendant).
//
// Dans les deux cas, les probabilités sont TOUJOURS calculées
// statistiquement (poisson.ts), jamais devinées par une IA — seule l'ENTRÉE
// du modèle (les buts attendus avant-match) peut venir d'Omniroute quand
// aucun historique gratuit n'existe pour ce championnat ; le calcul de
// probabilité lui-même reste toujours le même Poisson recalibré en direct.
// Pour le pipeline réel, Omniroute enrichit en plus le raisonnement de
// chaque jambe avec le contexte disponible — il ne touche jamais aux
// chiffres.

import { getDailyPlan, todayLocalDateString } from './scheduler';
import { buildScheduledMatches, ScheduledMatch } from './dailyWorkflow';
import { ScheduledMatchDetail } from '../types/database';
import { LiveFixture, LiveFixtureDetail, fetchOmnirouteMatchStatus, isSyntheticFixtureId, syntheticFixtureId } from './halftimeMonitor';
import { getHistoricalPriors } from './footballDataCoUk';
import {
  FictionalMatch,
  MatchSample,
  ensureFictionalDailyProgram,
  readCheckedCheckpoints,
  readMatchTimelines,
  writeCheckedCheckpoints,
  writeMatchTimelines,
} from './fictionalProgram';
import {
  estimateRemainingMatchMarket,
  estimateRemainingFirstHalfMarket,
  remainingFirstHalfEventFraction,
  pickHighestConfidentOverLine,
  SecondHalfMarket,
  LiveMatchStats,
} from './poisson';
import { applyMarketExpertise, getAgentLearningDigest, scoreAllTargets } from './autoLearn';
import { getFocusNoteByTeams, renderFocusNote, loadOmnirouteConfig } from './focusEnrichment';
import { askOmnirouteLight, askOmnirouteUsable } from './omniroute';
import { fetchMarkers } from './liveMarkers';
import { API_FOOTBALL_RESERVE, spendDirectBudget } from './requestBudget';
import { getAPIConfig, incrementRequestCount } from '../api/multiAPIManager';
import {
  InPlayProposal,
  InPlayProposalLeg,
  PendingObservation,
  TrackedMarket,
  readInPlayProposals,
  readLearnedModel,
  readPendingSnapshots,
  writeInPlayProposals,
} from './learnStore';
import { sendLocalNotification } from './notifications';
import { normalizeTeamName, namesLikelyMatch } from './teamNameMatch';
import { OmnirouteConfig } from '../types';
import { mapWithConcurrency } from './concurrency';
import { hubDateKey, hubLiveStatus, hubStats } from '../api/footballDataAPIs/liveDataHub';
import { DeltaUnit, LegProjection, describeCorrection, ensureDeltaSamplesLoaded, flushShadowProjections, getDeltaCorrection, recordShadowProjection } from './deltaLearning';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { matchesForDate, isWithinBreakWindow } from './internationalBreak';
import { INTERNATIONAL_BREAK_CALENDAR } from '../data/internationalBreakCalendar';
import { sendInternationalBreakCalendarNow } from './internationalBreakNotify';
import { fetchSportmonksInPlayMatches, SportmonksInPlayMatch } from '../api/footballDataAPIs/sportmonks';
import {
  getInPlayMatches as fetchSofaScoreInPlayMatches,
  SofaScoreInPlayMatch,
  fetchSofaEvent,
  fetchSofaStats,
  getSofaEventId,
} from '../api/footballDataAPIs/sofaScore';

// Fenêtres larges : la tâche de fond n'est réveillée par Android qu'environ
// toutes les 30-40 min ; avec 6 minutes de fenêtre, la plupart des matchs
// passaient le checkpoint sans jamais être vus (aucune prédiction à la 60e).
// Les jambes se projettent depuis la minute réelle, quelle qu'elle soit.
const CHECKPOINT20_MIN_MINUTE = 15;
const CHECKPOINT20_MAX_MINUTE = 30;
const CHECKPOINT60_MIN_MINUTE = 55;
const CHECKPOINT60_MAX_MINUTE = 70;

/** Matchs fictifs vérifiés par tour : le statut vient d'abord des sources
 * live gratuites (rapides, en cache), les fournisseurs IA seulement en repli. */
const MAX_FICTIONAL_CHECKS_PER_TICK = 60;
/** Vérifications fictives en vol simultanément pendant un tour : assez pour
 * accélérer nettement le bouton play (25 candidats à concurrence 6 ~ 4-5x plus
 * vite qu'en séquentiel), assez peu pour ne pas saturer le serveur Omniroute
 * auto-hébergé. */
const FICTIONAL_CHECK_CONCURRENCY = 6;
/** En dessous, le rythme observé (corners/cartons par minute) porte trop peu
 * d'information pour extrapoler quoi que ce soit. */
const MIN_MINUTES_FOR_PACE_PROJECTION = 15;
/** Délai minimum entre deux relevés d'un même match pendant la surveillance :
 * la boucle de premier plan repasse toutes les 3 minutes, inutile de
 * réinterroger un agent aussi souvent pour le même match. */
const MIN_MINUTES_BETWEEN_SAMPLES = 6;
/** Statuts considérés comme match terminé (API-Football) — utilisés pour
 * savoir quand arrêter la surveillance de fin de match ET, côté bilan de
 * minuit (dailyReview.ts), pour extraire un score final directement du
 * relevé déjà enregistré ici, sans la moindre recherche Omniroute. */
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
/** Borne (minutes écoulées depuis le coup d'envoi) jusqu'à laquelle on
 * continue de surveiller un match APRÈS ses deux checkpoints, dans le seul
 * but d'y capter un relevé "terminé" : couvre la mi-temps, les arrêts de jeu
 * et une éventuelle prolongation. Sans cette troisième fenêtre, le suivi
 * s'arrêtait net à 92 min écoulées (voir inSecondWatch) — bien avant la fin
 * de la plupart des matchs — et le bilan de minuit n'avait alors plus AUCUN
 * moyen fiable de régler un pari fictif (fixtureId synthétique, jamais connu
 * d'API-Football ; le repli par recherche Omniroute est lui peu fiable sur
 * des divisions obscures/jeunes). */
const FINISH_WATCH_MAX_MINUTE = 160;
/** Pipe fictif sur les vrais matchs en direct (B0) : fenêtres plus larges que
 * les checkpoints réels — la tâche de fond ne passe qu'environ toutes les
 * 30-40 min, une fenêtre de 6 min serait presque toujours manquée. Les jambes
 * se projettent depuis la minute réelle, quelle qu'elle soit. */
const LIVE_FICTIONAL_20_MIN = 15;
const LIVE_FICTIONAL_20_MAX = 30;
const LIVE_FICTIONAL_60_MIN = 55;
const LIVE_FICTIONAL_60_MAX = 70;
/** Matchs traités par tour (une estimation IA de buts attendus chacun). */
const LIVE_FICTIONAL_MAX_PER_TICK = 80;
/** Buts attendus moyens d'un match de football (domicile/extérieur), utilisés
 * seulement si l'IA ne fournit aucune estimation : la projection repose alors
 * sur le score et la minute réels, sans a priori propre aux équipes. */
const NEUTRAL_EXPECTED_GOALS = { home: 1.45, away: 1.15 };
/** Durée minimale entre deux relevés pour qu'un rythme en soit déduit : sur
 * trois minutes, un corner de plus ou de moins fausse tout. */
const MIN_MINUTES_FOR_RATE = 8;

/** Probabilité minimale pour qu'une jambe soit retenue (solo, combo, ou pari fictif). */
const MIN_LEG_PROB = 0.55;
/** Seuil interne utilisé pour choisir la ligne over/under la plus haute encore fiable (corners/cartons). */
const LINE_PICK_THRESHOLD = 0.55;
/** Au-delà de ce nombre de matchs dans le créneau : combos plutôt que paris simples (paris réels). */
const SLOT_COMBO_THRESHOLD = 3;
/** Nombre maximum de combos émis par créneau et par checkpoint (paris réels). */
const MAX_COMBOS_PER_SLOT = 2;
/** Probabilité combinée minimale pour émettre un combo réel (3 jambes à ≥55% chacune peut descendre très bas, ex. 0.55³ ≈ 17%). */
const MIN_COMBO_PROB = 0.25;

/** Identité minimale d'un match, commune aux deux pipelines. */
interface MatchRef {
  homeTeam: string;
  awayTeam: string;
  league: string;
  leagueId: string;
}

interface CandidateLeg {
  market: TrackedMarket;
  selection: string;
  prob: number;
  evidence: string;
  /** Valeur projetée de la fenêtre, comparée au réel au règlement. */
  projection?: LegProjection;
}

/** Buts attendus corrigés par l'écart mesuré sur les matchs réglés. */
function correctedGoals(xg: { home: number; away: number }, unit: DeltaUnit): { home: number; away: number } {
  const { factor } = getDeltaCorrection(unit);
  return { home: xg.home * factor, away: xg.away * factor };
}

/**
 * Choisit le bon côté (Oui/Non, Over/Under) d'un marché binaire déjà projeté
 * par poisson.ts : le côté favorisé si sa proba dépasse 50%, sinon son
 * inverse — jamais les deux à la fois (redondant).
 */
function pickBinarySide(market: TrackedMarket, projected: SecondHalfMarket, invertedSelection: string): CandidateLeg {
  if (projected.estimated_prob >= 0.5) {
    return { market, selection: projected.selection, prob: projected.estimated_prob, evidence: projected.reasoning };
  }
  return {
    market,
    selection: invertedSelection,
    prob: 1 - projected.estimated_prob,
    evidence: `Probabilité inverse (${(projected.estimated_prob * 100).toFixed(0)}% pour "${projected.selection}") : ${projected.reasoning}`
  };
}

/** Ajoute à une jambe "total de buts" la projection comparée au réel au règlement. */
function withGoalsProjection(
  leg: CandidateLeg,
  currentScore: { home: number; away: number },
  remaining: { home: number; away: number }
): CandidateLeg {
  const observed = currentScore.home + currentScore.away;
  const correction = getDeltaCorrection('goals_ft');
  return {
    ...leg,
    evidence: leg.evidence + describeCorrection(correction, 'buts'),
    projection: { unit: 'goals_ft', observed, expected: observed + remaining.home + remaining.away, factorUsed: correction.factor },
  };
}

/** Instantané liveMarkers le plus récent pour ce match, si un existe (best-effort, jamais bloquant). */
function mostRecentSnapshot(fixtureId: number): PendingObservation | undefined {
  return readPendingSnapshots()
    .filter((o) => o.fixtureId === fixtureId)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
}

/** Corners/cartons déjà comptés en 1ère mi-temps, d'après ce même instantané. */
function observedFirstHalfCounts(snapshot: PendingObservation | undefined): { corners?: number; cards?: number } {
  if (!snapshot) return {};

  const corners = snapshot.markers.cornersHome != null || snapshot.markers.cornersAway != null
    ? (snapshot.markers.cornersHome ?? 0) + (snapshot.markers.cornersAway ?? 0)
    : undefined;
  const cards = snapshot.markers.cardsHome != null || snapshot.markers.cardsAway != null
    ? (snapshot.markers.cardsHome ?? 0) + (snapshot.markers.cardsAway ?? 0)
    : undefined;

  return { corners, cards };
}

/**
 * Fenêtre d'apprentissage la plus proche de "20e minute → pause" dans
 * autoLearn.ts (LEARNING_HORIZONS = [10, 25]) : 25 minutes couvre bien le
 * même intervalle.
 */
const MARKER_RULE_HORIZON = 25;

/**
 * Recoupe l'estimation Poisson d'un but avant la pause avec les marqueurs
 * empiriquement validés par la boucle d'auto-apprentissage (autoLearn.ts —
 * "quand X marqueurs sont réunis, un but survient dans Y% des cas, sur un
 * échantillon assez grand pour être significatif"), si une règle s'applique
 * à CET instantané précis. Simple moyenne des deux estimations quand une
 * règle se déclenche — les deux sont des probabilités réelles (jamais
 * inventées), aucune raison de préférer l'une à l'autre sans plus
 * d'information. Renvoie l'estimation Poisson seule si aucune règle ne
 * s'applique (corpus trop jeune, ou aucun marqueur atteint le seuil).
 */
function blendWithLearnedMarkers(
  poissonProb: number,
  poissonEvidence: string,
  snapshot: PendingObservation | undefined
): { prob: number; evidence: string } {
  if (!snapshot) return { prob: poissonProb, evidence: poissonEvidence };

  const model = readLearnedModel();
  const scored = scoreAllTargets(snapshot, model, MARKER_RULE_HORIZON).find((s) => s.target === 'goals>=1');
  if (!scored) return { prob: poissonProb, evidence: poissonEvidence };

  const blended = (poissonProb + scored.prob) / 2;
  return {
    prob: blended,
    evidence: `${poissonEvidence} Recoupé avec un marqueur observé en direct : \`${scored.rule.marker}\` → ` +
      `${(scored.rule.hitRate * 100).toFixed(0)}% de but(s) sur les ${MARKER_RULE_HORIZON} min suivantes ` +
      `(×${scored.rule.lift.toFixed(2)} vs base, n=${scored.rule.samples}).`
  };
}

/** Bornes de sécurité pour un but attendu renvoyé par Omniroute — une jambe
 * l'utilise ensuite directement comme entrée du modèle de Poisson, contrairement
 * aux marqueurs corners/cartons de liveMarkers.ts qui sont recoupés contre la
 * vérité terrain avant d'être promus fiables ; ici on se contente d'écarter
 * une réponse absurde plutôt que de la faire confirmer par recoupement. */
const OMNIROUTE_EXPECTED_GOALS_MIN = 0.2;
const OMNIROUTE_EXPECTED_GOALS_MAX = 4.0;

/**
 * Estimation des buts attendus (avant-match) via Omniroute, quand
 * Football-Data.co.uk n'a pas d'historique pour ce championnat (couverture
 * actuelle limitée aux cinq grands championnats) — Omniroute étant
 * auto-hébergé et sans quota, il permet d'élargir gratuitement la couverture
 * du pipeline fictif à tout l'univers suivi (~28 pays) sans consommer la
 * moindre requête payante. N'invente rien : si l'agent ne trouve pas de
 * forme/effectif fiable pour ces deux équipes, il renvoie null.
 */
async function estimateExpectedGoalsViaOmniroute(
  config: OmnirouteConfig,
  homeTeam: string,
  awayTeam: string,
  league: string
): Promise<{ home: number; away: number } | null> {
  const result = await askOmnirouteUsable<{ home: number; away: number }>(
    "Tu es un outil de PRONOSTIC STATISTIQUE avant-match. Réponds UNIQUEMENT par un JSON strict, " +
      "sans texte autour. Base-toi sur la forme récente (5-10 derniers matchs), les buts marqués/encaissés " +
      "et l'effectif connu de chaque équipe. N'INVENTE RIEN : si tu ne trouves pas d'information fiable sur " +
      "ces deux équipes, réponds avec null pour les deux valeurs plutôt qu'une estimation approximative.",
    `Match à venir ou en cours : ${homeTeam} (domicile) vs ${awayTeam} (extérieur), ${league}.\n` +
      'Estime le nombre de buts attendus (expected goals) pour CE match précis, à partir de la forme ' +
      "récente et de l'effectif de chaque équipe.\n" +
      'Réponds avec ce JSON exact, sans rien autour :\n' +
      '{"expected_goals_home": number|null, "expected_goals_away": number|null}',
    config,
    (text) => {
      let parsed: any;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      } catch {
        return null;
      }

      const home = parsed?.expected_goals_home;
      const away = parsed?.expected_goals_away;
      if (typeof home !== 'number' || typeof away !== 'number' || !Number.isFinite(home) || !Number.isFinite(away)) {
        return null; // agent sans information utilisable : au suivant
      }

      return {
        home: Math.min(OMNIROUTE_EXPECTED_GOALS_MAX, Math.max(OMNIROUTE_EXPECTED_GOALS_MIN, home)),
        away: Math.min(OMNIROUTE_EXPECTED_GOALS_MAX, Math.max(OMNIROUTE_EXPECTED_GOALS_MIN, away)),
      };
    }
  ).catch((error: any) => {
    console.warn('[Scan en direct] Estimation Omniroute des buts attendus échouée:', error?.message);
    return null;
  });

  return result?.value ?? null;
}

/**
 * Tirs cadrés en direct pour ce match, via API-Football (statistiques
 * détaillées) — permet à poisson.ts/recalibrateGoalsForWindow de suivre
 * l'ÉVOLUTION réelle du match (qui domine, qui se procure les occasions),
 * pas seulement la moyenne pré-match étalée sur le temps écoulé. Réservé au
 * pipeline réel (5 grands championnats, peu de matchs simultanés) : coûte
 * une requête budgétée par match et par checkpoint, acceptable vu le faible
 * volume et le fait que toutes les ressources sont permises pour l'argent
 * réel.
 */
async function fetchRealLiveStats(live: LiveFixture): Promise<LiveMatchStats | undefined> {
  const apiConfig = await getAPIConfig();
  if (
    apiConfig.apiFootball &&
    !isSyntheticFixtureId(live.fixtureId) &&
    (await spendDirectBudget('apiFootball', API_FOOTBALL_RESERVE.settlement))
  ) {
    try {
      const markers = await fetchMarkers(apiConfig.apiFootball, live.fixtureId);
      if (markers.shotsOnTargetHome != null || markers.shotsOnTargetAway != null) return markers;
    } catch {
      // secours ci-dessous
    }
  }
  // Secours : sources live gratuites (plus de requêtes API-Football, ou
  // statistique absente de sa réponse).
  return (await fetchFreeLiveStats(live))?.stats;
}

/** Statistiques en direct depuis les sources gratuites (LiveScore d'abord,
 * puis FotMob, 365Scores, ESPN, AllSportsApi pour ce qui manque). */
async function fetchFreeLiveStats(
  live: LiveFixture
): Promise<{ stats: LiveMatchStats; observed: ObservedLiveCounts } | undefined> {
  const primary = live.sofaEventId ? await fetchSofaStats(live.sofaEventId).catch(() => null) : null;
  const merged = await hubStats(live.homeTeam, live.awayTeam, hubDateKey(), primary).catch(() => primary);
  const all = merged?.all;
  if (!all) return undefined;
  return {
    stats: {
      shotsOnTargetHome: all.shotsOnTargetHome,
      shotsOnTargetAway: all.shotsOnTargetAway,
      cornersHome: all.cornersHome,
      cornersAway: all.cornersAway,
      possessionHome: all.possessionHome,
      possessionAway: all.possessionHome != null ? 100 - all.possessionHome : undefined,
    },
    observed: { corners: all.corners, cards: all.cards },
  };
}

/** Compte observé en direct d'événements cumulés depuis le coup d'envoi, et
 * rythme mesuré sur la fenêtre de surveillance quand plusieurs relevés ont été
 * pris (voir observedFromTimeline). */
interface ObservedLiveCounts {
  corners?: number;
  cards?: number;
  /** Événements par minute, mesurés entre le premier et le dernier relevé. */
  cornersPerMinute?: number;
  cardsPerMinute?: number;
}

/**
 * Condense la surveillance d'un match en compteurs exploitables : les totaux
 * du dernier relevé, et surtout le RYTHME réellement constaté entre le premier
 * et le dernier relevé de la fenêtre.
 *
 * Pourquoi le rythme plutôt que la simple moyenne depuis le coup d'envoi : un
 * match à 4 corners dont 3 dans les cinq dernières minutes ne se projette pas
 * comme un match à 4 corners étalés sur vingt minutes. Avec un seul relevé, les
 * deux sont indiscernables — d'où la surveillance continue.
 */
function observedFromTimeline(timeline: MatchSample[]): ObservedLiveCounts {
  const last = timeline[timeline.length - 1];
  if (!last) return {};

  const counts: ObservedLiveCounts = { corners: last.cornersTotal, cards: last.cardsTotal };

  // Premier relevé de la même période de jeu que le dernier : un total de
  // corners ne se compare qu'à l'intérieur d'une même mi-temps continue.
  const first = timeline.find((s) => s.statusShort === last.statusShort);
  if (!first || first === last) return counts;

  const minutes = last.minute - first.minute;
  if (minutes < MIN_MINUTES_FOR_RATE) return counts;

  if (last.cornersTotal != null && first.cornersTotal != null) {
    counts.cornersPerMinute = Math.max(0, (last.cornersTotal - first.cornersTotal) / minutes);
  }
  if (last.cardsTotal != null && first.cardsTotal != null) {
    counts.cardsPerMinute = Math.max(0, (last.cardsTotal - first.cardsTotal) / minutes);
  }

  return counts;
}

/**
 * Jambes candidates du checkpoint 20e minute : but 1ère MT, corners/cartons
 * 1ère MT, BTTS et total du match. Les jambes buts/BTTS/total ne sont tentées
 * que si preMatchExpectedGoals est disponible ; les jambes corners/cartons
 * sont indépendantes.
 *
 * `currentStats` (tirs cadrés en direct) fait suivre la projection des buts
 * l'ÉVOLUTION réelle du match plutôt qu'une simple moyenne pré-match étalée
 * dans le temps (cf. poisson.ts/recalibrateGoalsForWindow) — omis, la
 * projection reste sur la moyenne pré-match telle quelle.
 *
 * `observedLive` (corners/cartons cumulés relevés à l'instant) permet au
 * pipeline fictif, qui n'a AUCUNE moyenne de saison (100 % Omniroute), de
 * projeter quand même ces deux marchés : au rythme constaté depuis le coup
 * d'envoi, extrapolé jusqu'à la pause. Le pipeline réel garde la priorité aux
 * moyennes de saison Football-Data.co.uk quand elles existent, plus solides
 * qu'un rythme mesuré sur 20 minutes.
 */
/** Rythmes moyens d'un match (environ 10 corners et 4 cartons sur 90 min). */
const TYPICAL_CORNERS_PER_MINUTE = 10 / 90;
const TYPICAL_CARDS_PER_MINUTE = 4 / 90;
/** Poids, en minutes de jeu, du rythme moyen face au rythme observé. */
const PACE_PRIOR_MINUTES = 20;

/**
 * Rythme projeté : rythme observé mêlé au rythme moyen d'un match. Seul, le
 * rythme observé sur 20 minutes est très bruité (1 corner à la 20e donnait
 * 0,05/min et une projection de 1,3 corner d'ici la pause, pour 6-7 réels) ;
 * le poids du rythme moyen s'efface à mesure que le match avance.
 */
function blendPace(observedPerMinute: number, elapsedMinutes: number, typicalPerMinute: number): number {
  const observedEvents = observedPerMinute * elapsedMinutes;
  return (observedEvents + typicalPerMinute * PACE_PRIOR_MINUTES) / (elapsedMinutes + PACE_PRIOR_MINUTES);
}

async function buildLegs20(
  match: MatchRef,
  fixtureId: number,
  live: LiveFixture,
  preMatchExpectedGoals: { home: number; away: number } | null,
  currentStats?: LiveMatchStats,
  observedLive?: ObservedLiveCounts
): Promise<CandidateLeg[]> {
  const legs: CandidateLeg[] = [];
  const currentScore = { home: live.homeGoals, away: live.awayGoals };
  const elapsedMinutes = live.minute;
  const snapshot = mostRecentSnapshot(fixtureId);

  // 1) But 1ère mi-temps ou pas — rien à prédire si déjà marqué (certain).
  if (preMatchExpectedGoals && currentScore.home + currentScore.away === 0) {
    const correction = getDeltaCorrection('goals_1h');
    const est = estimateRemainingFirstHalfMarket({ preMatchExpectedGoals: correctedGoals(preMatchExpectedGoals, 'goals_1h'), elapsedMinutes, currentScore, currentStats });
    const m = est.markets[0];
    const blended = blendWithLearnedMarkers(m.estimated_prob, m.reasoning + describeCorrection(correction, 'buts'), snapshot);
    legs.push({
      market: 'buts_1ere_mt',
      selection: 'Oui, un but avant la pause',
      prob: blended.prob,
      evidence: blended.evidence,
      projection: { unit: 'goals_1h', observed: 0, expected: est.secondHalfExpectedGoals.home + est.secondHalfExpectedGoals.away, factorUsed: correction.factor },
    });
  }

  // 2) Corners / 3) Cartons 1ère mi-temps — projection sur le reste de la 1ère
  // MT + ce qui est déjà compté en direct (best-effort, jamais bloquant).
  const priors = match.leagueId
    ? await getHistoricalPriors(match.leagueId, match.homeTeam, match.awayTeam).catch(() => null)
    : null;
  const snapshotCounts = observedFirstHalfCounts(snapshot);
  const observedCorners = observedLive?.corners ?? snapshotCounts.corners;
  const observedCards = observedLive?.cards ?? snapshotCounts.cards;

  if (priors) {
    const fraction = remainingFirstHalfEventFraction(elapsedMinutes);

    const cornersFix = getDeltaCorrection('corners_1h');
    const cornersLambda = (priors.home.cornersFor + priors.away.cornersFor) * fraction * cornersFix.factor;
    const cornersLine = pickHighestConfidentOverLine(cornersLambda, LINE_PICK_THRESHOLD, observedCorners ?? 0);
    if (cornersLine) {
      legs.push({
        market: 'corners',
        selection: `Plus de ${cornersLine.line} corners en 1ère mi-temps`,
        prob: cornersLine.prob,
        evidence: `${observedCorners ?? 0} corner(s) déjà compté(s) + ${cornersLambda.toFixed(1)} attendus sur le reste de la 1ère MT (moyennes de saison Football-Data.co.uk).` + describeCorrection(cornersFix, 'corners'),
        projection: { unit: 'corners_1h', observed: observedCorners ?? 0, expected: (observedCorners ?? 0) + cornersLambda, factorUsed: cornersFix.factor },
      });
    }

    const cardsFix = getDeltaCorrection('cards_1h');
    const cardsLambda = (priors.home.cardsFor + priors.away.cardsFor) * fraction * cardsFix.factor;
    const cardsLine = pickHighestConfidentOverLine(cardsLambda, LINE_PICK_THRESHOLD, observedCards ?? 0);
    if (cardsLine) {
      legs.push({
        market: 'cartons',
        selection: `Plus de ${cardsLine.line} cartons en 1ère mi-temps`,
        prob: cardsLine.prob,
        evidence: `${observedCards ?? 0} carton(s) déjà compté(s) + ${cardsLambda.toFixed(1)} attendus sur le reste de la 1ère MT (moyennes de saison Football-Data.co.uk).` + describeCorrection(cardsFix, 'cartons'),
        projection: { unit: 'cards_1h', observed: observedCards ?? 0, expected: (observedCards ?? 0) + cardsLambda, factorUsed: cardsFix.factor },
      });
    }
  } else if (elapsedMinutes >= MIN_MINUTES_FOR_PACE_PROJECTION) {
    // Aucune moyenne de saison : projection au rythme observé dans CE match.
    // Le rythme mesuré pendant la surveillance (entre deux relevés) prime sur
    // la moyenne depuis le coup d'envoi — c'est lui qui reflète où en est le
    // match maintenant, pas où il en était en moyenne.
    const remainingMinutes = Math.max(0, 45 - elapsedMinutes);

    if (observedCorners != null) {
      const observedPace = observedLive?.cornersPerMinute ?? observedCorners / elapsedMinutes;
      const perMinute = blendPace(observedPace, elapsedMinutes, TYPICAL_CORNERS_PER_MINUTE);
      const source = `${observedLive?.cornersPerMinute != null ? 'rythme suivi en direct' : 'moyenne depuis le coup d\'envoi'} mêlé au rythme moyen d'un match`;
      const fix = getDeltaCorrection('corners_1h');
      const lambda = perMinute * remainingMinutes * fix.factor;
      const line = pickHighestConfidentOverLine(lambda, LINE_PICK_THRESHOLD, observedCorners);
      if (line) {
        legs.push({
          market: 'corners',
          selection: `Plus de ${line.line} corners en 1ère mi-temps`,
          prob: line.prob,
          evidence: `${observedCorners} corner(s) à la ${elapsedMinutes}e minute, ${source} de ${perMinute.toFixed(2)}/min → ${lambda.toFixed(1)} attendu(s) d'ici la pause.` + describeCorrection(fix, 'corners'),
          projection: { unit: 'corners_1h', observed: observedCorners, expected: observedCorners + lambda, factorUsed: fix.factor },
        });
      }
    }

    if (observedCards != null) {
      const observedPace = observedLive?.cardsPerMinute ?? observedCards / elapsedMinutes;
      const perMinute = blendPace(observedPace, elapsedMinutes, TYPICAL_CARDS_PER_MINUTE);
      const source = `${observedLive?.cardsPerMinute != null ? 'rythme suivi en direct' : 'moyenne depuis le coup d\'envoi'} mêlé au rythme moyen d'un match`;
      const fix = getDeltaCorrection('cards_1h');
      const lambda = perMinute * remainingMinutes * fix.factor;
      const line = pickHighestConfidentOverLine(lambda, LINE_PICK_THRESHOLD, observedCards);
      if (line) {
        legs.push({
          market: 'cartons',
          selection: `Plus de ${line.line} cartons en 1ère mi-temps`,
          prob: line.prob,
          evidence: `${observedCards} carton(s) à la ${elapsedMinutes}e minute, ${source} de ${perMinute.toFixed(2)}/min → ${lambda.toFixed(1)} attendu(s) d'ici la pause.` + describeCorrection(fix, 'cartons'),
          projection: { unit: 'cards_1h', observed: observedCards, expected: observedCards + lambda, factorUsed: fix.factor },
        });
      }
    }
  }

  // 4) BTTS / 5) Total du match — projection sur le match ENTIER, pas
  // seulement la 1ère MT (déjà acquis si les deux ont déjà marqué / si le
  // total dépasse déjà la ligne : rien à prédire, on ne propose pas).
  if (preMatchExpectedGoals) {
    const fullEst = estimateRemainingMatchMarket({ preMatchExpectedGoals: correctedGoals(preMatchExpectedGoals, 'goals_ft'), elapsedMinutes, currentScore, currentStats });
    const bttsMarket = fullEst.markets.find((m) => m.market === 'FT_btts_reprojete');
    if (bttsMarket && !(currentScore.home > 0 && currentScore.away > 0)) {
      legs.push(pickBinarySide('btts', bttsMarket, 'Les deux équipes ne marquent pas toutes les deux (Non)'));
    }
    const overMarket = fullEst.markets.find((m) => m.market === 'FT_over_2_5_reprojete');
    if (overMarket && !(currentScore.home + currentScore.away > 2.5)) {
      legs.push(withGoalsProjection(pickBinarySide('total_buts', overMarket, 'Moins de 2.5 buts (total match)'), currentScore, fullEst.secondHalfExpectedGoals));
    }
  }

  return withLearnedExpertise(legs);
}

/**
 * Dernier passage obligatoire de toute jambe, quel que soit le pipeline : la
 * probabilité calculée est confrontée à ce que l'app a réellement mesuré sur
 * ce marché (autoLearn/applyMarketExpertise, nourri par les résultats de
 * chaque match terminé). C'est le point où l'expérience accumulée revient
 * corriger la prédiction suivante.
 */
function withLearnedExpertise(legs: CandidateLeg[]): CandidateLeg[] {
  return legs.map((leg) => {
    const { prob, evidence } = applyMarketExpertise(leg.market, leg.prob, leg.evidence);
    return { ...leg, prob, evidence };
  });
}

/**
 * Jambes candidates du checkpoint 60e minute : reste du match uniquement —
 * toutes basées sur les buts, donc rien à construire si preMatchExpectedGoals
 * est indisponible. `currentStats` : voir buildLegs20.
 */
function buildLegs60(
  live: LiveFixture,
  preMatchExpectedGoals: { home: number; away: number } | null,
  currentStats?: LiveMatchStats
): CandidateLeg[] {
  if (!preMatchExpectedGoals) return [];

  const legs: CandidateLeg[] = [];
  const currentScore = { home: live.homeGoals, away: live.awayGoals };
  const elapsedMinutes = live.minute;

  const est = estimateRemainingMatchMarket({ preMatchExpectedGoals: correctedGoals(preMatchExpectedGoals, 'goals_ft'), elapsedMinutes, currentScore, currentStats });

  const resultMarket = est.markets.find((m) => m.market === 'FT_1X2_reprojete');
  if (resultMarket) {
    legs.push({ market: '1X2', selection: resultMarket.selection, prob: resultMarket.estimated_prob, evidence: resultMarket.reasoning });
  }

  const bttsMarket = est.markets.find((m) => m.market === 'FT_btts_reprojete');
  if (bttsMarket && !(currentScore.home > 0 && currentScore.away > 0)) {
    legs.push(pickBinarySide('btts', bttsMarket, 'Les deux équipes ne marquent pas toutes les deux (Non)'));
  }
  const overMarket = est.markets.find((m) => m.market === 'FT_over_2_5_reprojete');
  if (overMarket && !(currentScore.home + currentScore.away > 2.5)) {
    legs.push(withGoalsProjection(pickBinarySide('total_buts', overMarket, 'Moins de 2.5 buts (total match)'), currentScore, est.secondHalfExpectedGoals));
  }

  return withLearnedExpertise(legs);
}

interface LegWithContext {
  leg: CandidateLeg;
  fixtureId: number;
  match: MatchRef;
  live: LiveFixture;
}

function toProposalLeg(item: LegWithContext): InPlayProposalLeg {
  return {
    market: item.leg.market,
    selection: item.leg.selection,
    prob: item.leg.prob,
    evidence: item.leg.evidence,
    fixtureId: item.fixtureId,
    league: item.match.league,
    homeTeam: item.match.homeTeam,
    awayTeam: item.match.awayTeam,
    scoreLabel: `${item.live.homeGoals}-${item.live.awayGoals}`,
    projection: item.leg.projection,
  };
}

/**
 * Enrichit le raisonnement de chaque jambe via Omniroute, à partir du
 * contexte déjà disponible (mémoire d'auto-apprentissage, forme des
 * équipes) — ne modifie JAMAIS les probabilités calculées. Fonctionne aussi
 * bien pour un pari simple (1 jambe) qu'un combo multi-matchs (plusieurs).
 * Best-effort : toute panne (config absente, réseau, JSON invalide) renvoie
 * les jambes telles quelles, jamais bloquant.
 */
async function formulateWithOmniroute(items: LegWithContext[], checkpointLabel: string): Promise<LegWithContext[]> {
  if (items.length === 0) return items;

  const omnirouteConfig = await loadOmnirouteConfig();
  if (!omnirouteConfig) return items;

  let digest: string | null = null;
  try { digest = getAgentLearningDigest(); } catch { /* pas encore de règle apprise : silencieux */ }

  const focusContexts = items
    .map((item) => {
      try {
        const note = renderFocusNote(getFocusNoteByTeams(item.match.homeTeam, item.match.awayTeam));
        return note ? `${item.match.homeTeam} vs ${item.match.awayTeam} : ${note}` : null;
      } catch {
        return null;
      }
    })
    .filter((n): n is string => Boolean(n));

  const legsText = items
    .map((item, i) =>
      `${i + 1}. ${item.match.homeTeam} vs ${item.match.awayTeam} (${item.match.league}, minute ${item.live.minute}, score ${item.live.homeGoals}-${item.live.awayGoals}) — ` +
      `[${item.leg.market}] ${item.leg.selection} — probabilité calculée : ${(item.leg.prob * 100).toFixed(0)}% (${item.leg.evidence})`
    )
    .join('\n');

  const systemPrompt =
    "Tu formules des pronostics de football EN COURS DE MATCH à partir de probabilités DÉJÀ CALCULÉES statistiquement (modèle de Poisson recalibré en direct). " +
    "RÈGLE ABSOLUE : ne recalcule jamais ces probabilités, ne les remets jamais en question, ne les modifie jamais — reprends-les EXACTEMENT telles quelles. " +
    "Ton seul rôle : enrichir le raisonnement de chaque jambe avec le contexte fourni (mémoire d'auto-apprentissage, forme des équipes), en français, factuel, sans invention. " +
    'Réponds en JSON strict, rien autour : {"legs": [{"market": "string", "reasoning": "string"}]} — un objet par jambe, EXACTEMENT dans le même ordre, le même nombre, et le même identifiant de marché.';

  const userPrompt =
    `Checkpoint : ${checkpointLabel}${items.length > 1 ? ` — combo de ${items.length} matchs du même créneau` : ' — pari simple'}\n\n` +
    `Jambes calculées (NE PAS changer les probabilités) :\n${legsText}\n` +
    (digest ? `\n${digest}\n` : '') +
    (focusContexts.length > 0 ? `\nContexte déjà collecté sur ces matchs :\n${focusContexts.join('\n')}\n` : '');

  try {
    const result = await askOmnirouteLight(systemPrompt, userPrompt, omnirouteConfig);
    if (!result) return items;

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result.text);
    const enrichedLegs: Array<{ market: string; reasoning: string }> = parsed.legs || [];

    return items.map((item, i) => {
      const enriched = enrichedLegs[i];
      // Garde-fou : si l'ordre/le marché renvoyé ne correspond pas exactement,
      // on garde le raisonnement d'origine plutôt que de risquer un mélange.
      if (!enriched?.reasoning || enriched.market !== item.leg.market) return item;
      return { ...item, leg: { ...item.leg, evidence: enriched.reasoning } };
    });
  } catch (error: any) {
    console.warn('[Scan en direct] Enrichissement Omniroute échoué (chiffres calculés conservés):', error.message);
    return items;
  }
}

function buildProposalFromItems(
  kind: 'minute20' | 'minute60',
  items: LegWithContext[],
  window: string,
  real: boolean
): InPlayProposal | null {
  if (items.length === 0) return null;

  const combinedProb = items.reduce((product, item) => product * item.leg.prob, 1);

  return {
    // Inclut le marché (pas seulement le fixtureId) : le pipeline fictif crée
    // plusieurs propositions indépendantes pour le MÊME match+checkpoint (une
    // par marché qualifié) — sans ça, leurs ids entreraient en collision.
    id: `inplay-${kind}-${items.map((i) => `${i.fixtureId}-${i.leg.market}`).join('-')}`,
    kind,
    createdAt: new Date().toISOString(),
    minute: items[0].live.minute,
    window,
    legs: items.map(toProposalLeg),
    combinedProb,
    real,
  };
}

/**
 * Le pari (ou combiné) en clair d'abord, jamais noyé dans le jargon interne
 * (fenêtre de checkpoint, libellés techniques) — demande explicite : on doit
 * pouvoir lire le message et savoir IMMÉDIATEMENT quoi jouer, sans avoir à
 * déchiffrer la structure du message.
 */
async function notifyProposal(proposal: InPlayProposal): Promise<void> {
  const emoji = proposal.kind === 'minute20' ? '⚡' : '⏱️';

  if (proposal.legs.length === 1) {
    const leg = proposal.legs[0];
    const title = `${emoji} ${proposal.minute}e — ${leg.homeTeam} ${leg.scoreLabel} ${leg.awayTeam}`;
    const body = `🎯 Pari : ${leg.selection}\nConfiance : ${(leg.prob * 100).toFixed(0)}%`;
    await sendLocalNotification(title, body, { kind: proposal.kind });
    return;
  }

  const title = `${emoji} ${proposal.minute}e — Combiné ${proposal.legs.length} matchs (${(proposal.combinedProb * 100).toFixed(0)}% combiné)`;
  const body = proposal.legs
    .map((l, i) => `${i + 1}) ${l.homeTeam} ${l.scoreLabel} ${l.awayTeam}\n   🎯 ${l.selection} (${(l.prob * 100).toFixed(0)}%)`)
    .join('\n');
  await sendLocalNotification(title, body, { kind: proposal.kind });
}

function findLiveFixture(scheduled: { homeTeam: string; awayTeam: string }, liveFixtures: LiveFixture[]): LiveFixture | undefined {
  const sHome = normalizeTeamName(scheduled.homeTeam);
  const sAway = normalizeTeamName(scheduled.awayTeam);
  return liveFixtures.find((f) => {
    const fHome = normalizeTeamName(f.homeTeam);
    const fAway = normalizeTeamName(f.awayTeam);
    return (fHome === sHome || namesLikelyMatch(fHome, sHome)) && (fAway === sAway || namesLikelyMatch(fAway, sAway));
  });
}

function matchRefOfScheduled(m: ScheduledMatch): MatchRef {
  return { homeTeam: m.homeTeam, awayTeam: m.awayTeam, league: m.leagueName, leagueId: m.leagueId };
}

const INTL_BREAK_XG_CACHE_KEY = '@intl_break_xg_cache';
const INTL_BREAK_ANNOUNCED_KEY = '@intl_break_announced_window';

export interface InternationalBreakTickDiagnostics {
  withinWindow: boolean;
  /** Matchs prévus aujourd'hui d'après le calendrier, avant tout filtre. */
  matchesScheduledToday: number;
  /** Combien ont une estimation Omniroute de buts attendus exploitable ce tour
   * (les autres sont retentés au tour suivant, voir la boucle plus bas). */
  matchesWithExpectedGoals: number;
  /** Combien ont été retrouvés "en direct" ce tour (API-Football ou repli
   * Omniroute ciblé) parmi ceux qui avaient une estimation. */
  matchesLiveFound: number;
  /** Combien étaient dans une fenêtre de checkpoint (20e ou 60e minute) PILE
   * à ce tour précis — un compteur à 0 ici est normal la plupart du temps
   * (les fenêtres ne durent que quelques minutes sur un match de 90+). */
  matchesInCheckpointWindow: number;
}

/**
 * Matchs de la trêve internationale (Ligue des Nations, qualifs CAN) prévus
 * AUJOURD'HUI, prêts pour le même traitement que les 5 grands championnats
 * (voir processRealSlot plus bas) — vide en dehors de la fenêtre du
 * calendrier (voir internationalBreak.ts), donc aucun effet le reste de
 * l'année. Contrairement aux 5 grands championnats, aucune cote de marché
 * n'existe pour ces matchs : les buts attendus viennent d'Omniroute (comme le
 * programme fictif), calculés UNE FOIS par match puis mis en cache — sans ce
 * cache, chaque tour (toutes les ~3-15 min) redemanderait la même estimation.
 */
async function getTodaysInternationalBreakMatches(
  omnirouteConfig: OmnirouteConfig | null
): Promise<{ matches: ScheduledMatch[]; diagnostics: Pick<InternationalBreakTickDiagnostics, 'withinWindow' | 'matchesScheduledToday' | 'matchesWithExpectedGoals'> }> {
  // Date LOCALE (comme le reste de l'app, cf. scheduler.ts/todayLocalDateString) :
  // une date UTC ferait basculer un match tôt/tard du mauvais côté de minuit
  // pour un fuseau non-UTC.
  const today = todayLocalDateString();
  const withinWindow = isWithinBreakWindow(INTERNATIONAL_BREAK_CALENDAR, today);
  const todaysMatches = matchesForDate(INTERNATIONAL_BREAK_CALENDAR, today).filter((m) => m.kickoff_utc);
  const diagBase = { withinWindow, matchesScheduledToday: todaysMatches.length };

  if (!omnirouteConfig || todaysMatches.length === 0) {
    return { matches: [], diagnostics: { ...diagBase, matchesWithExpectedGoals: 0 } };
  }

  const cacheRaw = await AsyncStorage.getItem(INTL_BREAK_XG_CACHE_KEY);
  const cache: Record<string, { home: number; away: number }> = cacheRaw ? JSON.parse(cacheRaw) : {};
  let cacheTouched = false;

  const scheduled: ScheduledMatch[] = [];
  for (const m of todaysMatches) {
    const key = `${m.homeTeam}-${m.awayTeam}-${m.date}`;
    let xg = cache[key];
    if (!xg) {
      const estimated = await estimateExpectedGoalsViaOmniroute(
        omnirouteConfig, m.homeTeam, m.awayTeam, m.competition
      ).catch(() => null);
      if (!estimated) continue; // pas d'estimation fiable ce tour : retenté au suivant
      xg = estimated;
      cache[key] = xg;
      cacheTouched = true;
    }

    scheduled.push({
      id: `intl-${key}`,
      leagueId: m.group,
      leagueName: m.competition,
      flag: '🌍',
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      kickoff_utc: m.kickoff_utc!,
      creneau_display: new Date(m.kickoff_utc!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      expectedHomeGoals: xg.home,
      expectedAwayGoals: xg.away,
      odds: { home: 0, draw: 0, away: 0, btts_yes: 0, btts_no: 0, over_2_5: 0, under_2_5: 0 },
      context: `${m.competition} — ${m.group}`,
    });
  }

  if (cacheTouched) await AsyncStorage.setItem(INTL_BREAK_XG_CACHE_KEY, JSON.stringify(cache));
  return { matches: scheduled, diagnostics: { ...diagBase, matchesWithExpectedGoals: scheduled.length } };
}

/**
 * Envoie le calendrier complet de la trêve sur Telegram, UNE SEULE FOIS par
 * fenêtre (marqueur AsyncStorage identifiant la fenêtre elle-même : changer
 * le calendrier pour une nouvelle fenêtre — ex. les journées 3-4 de la CAN en
 * novembre — redéclenche naturellement un envoi, sans code supplémentaire).
 *
 * Le marqueur n'est posé QUE si l'envoi a vraiment réussi (sendTelegramMessage
 * renvoie maintenant un booléen) : sans cette vérification, un échec réseau
 * ponctuel au premier tour marquait quand même "déjà envoyé", et plus aucun
 * tour suivant ne retentait — c'est exactement ce qui s'est produit la
 * première fois (calendrier jamais reçu, marqueur posé quand même).
 */
async function announceInternationalBreakCalendarIfDue(): Promise<void> {
  if (INTERNATIONAL_BREAK_CALENDAR.matches.length === 0) return;

  const windowKey = `${INTERNATIONAL_BREAK_CALENDAR.windowStart}_${INTERNATIONAL_BREAK_CALENDAR.windowEnd}`;
  const alreadyAnnounced = await AsyncStorage.getItem(INTL_BREAK_ANNOUNCED_KEY);
  if (alreadyAnnounced === windowKey) return;

  const sent = await sendInternationalBreakCalendarNow();
  if (sent) await AsyncStorage.setItem(INTL_BREAK_ANNOUNCED_KEY, windowKey);
}

/**
 * Meilleure jambe (la plus probable, seuil MIN_LEG_PROB) d'un match candidat
 * à un checkpoint donné, ou null si aucune ne qualifie.
 */
async function bestLegFor(
  kind: 'minute20' | 'minute60',
  scheduled: ScheduledMatch,
  live: LiveFixture
): Promise<LegWithContext | null> {
  const match = matchRefOfScheduled(scheduled);
  const preMatchExpectedGoals = { home: scheduled.expectedHomeGoals, away: scheduled.expectedAwayGoals };
  const currentStats = await fetchRealLiveStats(live);

  const rawLegs = kind === 'minute20'
    ? await buildLegs20(match, live.fixtureId, live, preMatchExpectedGoals, currentStats)
    : buildLegs60(live, preMatchExpectedGoals, currentStats);

  const eligible = rawLegs.filter((l) => l.prob >= MIN_LEG_PROB).sort((a, b) => b.prob - a.prob);
  if (eligible.length === 0) return null;

  return { leg: eligible[0], fixtureId: live.fixtureId, match, live };
}

/**
 * Paris RÉELS d'un créneau, pour un checkpoint donné : pari simple par match
 * si le créneau a moins de SLOT_COMBO_THRESHOLD matchs (avec cotes
 * exploitables), sinon combos de 3 jambes (une par match différent),
 * jusqu'à MAX_COMBOS_PER_SLOT.
 */
async function processRealSlotCheckpoint(
  kind: 'minute20' | 'minute60',
  slotMatchCount: number,
  candidates: Array<{ scheduled: ScheduledMatch; live: LiveFixture }>,
  window: string,
  checkpointLabel: string,
  alreadyProposed: Set<string>,
  fresh: InPlayProposal[]
): Promise<void> {
  if (candidates.length === 0) return;

  // Chaque match du créneau est indépendant des autres — vérifiés en
  // parallèle (petit créneau réel, 5 grands championnats, jamais plus d'une
  // poignée de matchs simultanés : pas besoin de borner la concurrence ici).
  const perMatchResults = await mapWithConcurrency(candidates, candidates.length, async ({ scheduled, live }) => {
    try {
      return await bestLegFor(kind, scheduled, live);
    } catch (error: any) {
      console.warn(`[Scan en direct] Vérification réelle de ${scheduled.homeTeam} vs ${scheduled.awayTeam} échouée:`, error?.message);
      return null;
    }
  });
  const perMatch: LegWithContext[] = perMatchResults.filter((r): r is LegWithContext => r !== null);
  if (perMatch.length === 0) return;

  if (slotMatchCount < SLOT_COMBO_THRESHOLD) {
    // Paris simples : un par match candidat.
    for (const item of perMatch) {
      const [enriched] = await formulateWithOmniroute([item], checkpointLabel);
      const proposal = buildProposalFromItems(kind, [enriched], window, true);
      if (proposal) {
        fresh.push(proposal);
        alreadyProposed.add(`${item.fixtureId}-${kind}`);
        await notifyProposal(proposal);
      }
    }
    return;
  }

  // Combos : jusqu'à MAX_COMBOS_PER_SLOT, 3 jambes (matchs différents)
  // chacun, en partant des matchs les plus probables, sans jamais réutiliser
  // un même match dans deux combos du même créneau.
  if (perMatch.length < 3) return; // pas assez de matchs simultanément en direct pour former un combo

  const sorted = [...perMatch].sort((a, b) => b.leg.prob - a.leg.prob);
  for (let i = 0; i + 3 <= sorted.length && (i / 3) < MAX_COMBOS_PER_SLOT; i += 3) {
    const group = sorted.slice(i, i + 3);
    const enriched = await formulateWithOmniroute(group, checkpointLabel);
    const proposal = buildProposalFromItems(kind, enriched, window, true);
    if (proposal && proposal.combinedProb >= MIN_COMBO_PROB) {
      fresh.push(proposal);
      for (const item of group) alreadyProposed.add(`${item.fixtureId}-${kind}`);
      await notifyProposal(proposal);
    }
  }
}

/**
 * Traite un créneau de matchs RÉELS (5 grands championnats ou compétitions
 * internationales pendant la trêve, voir runInPlayComboTick) : cherche le
 * relevé live de chaque match (API-Football en priorité, repli Omniroute
 * ciblé si absent du relevé partagé), puis délègue à
 * processRealSlotCheckpoint pour les deux checkpoints.
 */
/** Une source de confirmation (Sportmonks, SofaScore) a-t-elle ce match dans
 * sa liste "en cours" ? Toujours par correspondance floue de noms d'équipes
 * (aucun identifiant commun entre ces sources et le planning). */
function matchConfirmedBy(
  matches: Array<{ homeTeam: string; awayTeam: string }>,
  scheduled: { homeTeam: string; awayTeam: string }
): boolean {
  return matches.some((m) =>
    namesLikelyMatch(normalizeTeamName(m.homeTeam), normalizeTeamName(scheduled.homeTeam)) &&
    namesLikelyMatch(normalizeTeamName(m.awayTeam), normalizeTeamName(scheduled.awayTeam))
  );
}

async function processRealSlot(
  slotMatches: ScheduledMatch[],
  liveFixtures: LiveFixture[],
  omnirouteConfig: OmnirouteConfig | null,
  alreadyProposed: Set<string>,
  fresh: InPlayProposal[],
  sportmonksInPlay: SportmonksInPlayMatch[] | null,
  sofaScoreInPlay: SofaScoreInPlayMatch[] | null
): Promise<{ liveFound: number; inCheckpointWindow: number }> {
  if (slotMatches.length === 0) return { liveFound: 0, inCheckpointWindow: 0 };

  const candidates20: Array<{ scheduled: ScheduledMatch; live: LiveFixture }> = [];
  const candidates60: Array<{ scheduled: ScheduledMatch; live: LiveFixture }> = [];
  let liveFound = 0;

  for (const scheduled of slotMatches) {
    let live = findLiveFixture(scheduled, liveFixtures);
    // Repli Omniroute CIBLÉ sur ce match précis (pas la découverte large du
    // pipeline fictif) : un match d'argent réel absent du relevé live
    // partagé — API-Football en panne, ou simplement pas mentionné par la
    // découverte Omniroute générale — ne doit jamais rester sans
    // vérification, sous peine de rater une notification de pari réel.
    // Bornage au coup d'envoi théorique (± 130 min) pour ne pas interroger
    // Omniroute sur des matchs qui n'ont clairement pas encore commencé ou
    // sont clairement terminés.
    //
    // Confirmation Sportmonks/SofaScore AVANT d'appeler Omniroute (quand
    // disponibles) : ces deux sources disent si ce match est VRAIMENT en
    // cours en ce moment, sans consommer le moindre agent Omniroute pour les
    // matchs qui ne le sont pas — ça évite de solliciter des agents déjà
    // sous pression (circuit breaker) pour rien. Ni l'une ni l'autre ne
    // fournit la minute exacte ici (voir sportmonks.ts/sofaScore.ts) : seul
    // Omniroute la donne, ce filtre décide juste si ça vaut le coup de la
    // lui demander. On ne saute l'appel que si TOUTES les sources
    // effectivement disponibles ce tour s'accordent à dire "non" — une
    // seule source manquante ou en désaccord suffit à laisser passer.
    // Sources live gratuites avant les fournisseurs IA.
    if (!live) {
      const hub = await hubLiveStatus(scheduled.homeTeam, scheduled.awayTeam).catch(() => null);
      if (hub) {
        live = {
          statusShort: hub.statusShort,
          homeTeam: scheduled.homeTeam,
          awayTeam: scheduled.awayTeam,
          homeGoals: hub.homeGoals,
          awayGoals: hub.awayGoals,
          fixtureId: syntheticFixtureId(scheduled.homeTeam, scheduled.awayTeam, hubDateKey()),
          minute: hub.minute,
          league: scheduled.leagueName,
          sofaEventId: hub.provider === 'LiveScore' ? hub.eventId : undefined,
        };
      }
    }
    if (!live && omnirouteConfig) {
      const elapsedMs = Date.now() - Date.parse(scheduled.kickoff_utc);
      const withinKickoffWindow = Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 130 * 60 * 1000;

      const availableVerdicts = [
        sportmonksInPlay !== null ? matchConfirmedBy(sportmonksInPlay, scheduled) : null,
        sofaScoreInPlay !== null ? matchConfirmedBy(sofaScoreInPlay, scheduled) : null,
      ].filter((v): v is boolean => v !== null);
      const allAvailableSourcesSayNotLive = availableVerdicts.length > 0 && availableVerdicts.every((v) => !v);

      if (withinKickoffWindow && !allAvailableSourcesSayNotLive) {
        live = (await fetchOmnirouteMatchStatus(
          omnirouteConfig, scheduled.homeTeam, scheduled.awayTeam, scheduled.leagueName
        ).catch(() => null)) ?? undefined;
      }
    }
    if (!live) continue;
    liveFound++;

    if (
      live.statusShort === '1H' &&
      live.minute >= CHECKPOINT20_MIN_MINUTE && live.minute <= CHECKPOINT20_MAX_MINUTE &&
      !alreadyProposed.has(`${live.fixtureId}-minute20`)
    ) {
      candidates20.push({ scheduled, live });
    }

    if (
      live.statusShort === '2H' &&
      live.minute >= CHECKPOINT60_MIN_MINUTE && live.minute <= CHECKPOINT60_MAX_MINUTE &&
      !alreadyProposed.has(`${live.fixtureId}-minute60`)
    ) {
      candidates60.push({ scheduled, live });
    }
  }

  await processRealSlotCheckpoint(
    'minute20', slotMatches.length, candidates20,
    `20e → pause + match complet`, '20e minute — 1ère mi-temps + BTTS/total du match',
    alreadyProposed, fresh
  );
  await processRealSlotCheckpoint(
    'minute60', slotMatches.length, candidates60,
    `60e → fin de match`, '60e minute — reste du match',
    alreadyProposed, fresh
  );

  return { liveFound, inCheckpointWindow: candidates20.length + candidates60.length };
}

/**
 * Un tour de scan. Appelé par la tâche de fond (toutes les ~15 min) et par
 * la boucle de premier plan (3 min). Ne notifie jamais deux fois le même
 * match pour le même checkpoint. `liveFixtures` est déjà récupéré par
 * backgroundTasks.ts (un seul relevé /fixtures?live=all par tour, partagé
 * avec liveMarkers.ts) — avant ce partage, chaque module refaisait sa propre
 * requête, doublant la consommation du quota API-Football à chaque tour.
 */
export interface InPlayComboTickResult {
  freshProposals: number;
  intlBreak: InternationalBreakTickDiagnostics;
  /** null = Sportmonks non configuré ou appel en échec ce tour (repli
   * Omniroute à l'aveugle, comportement d'avant) ; sinon, nombre de matchs
   * confirmés en 1ère/2e mi-temps ou à la pause dans le monde entier. */
  sportmonksConfirmedMatches: number | null;
  /** Même principe que sportmonksConfirmedMatches, côté SofaScore (aucune
   * clé requise, mais bloqué par leur protection anti-bot selon le réseau —
   * null recouvre les deux cas : injoignable ce tour). */
  sofaScoreConfirmedMatches: number | null;
  /** Raison précise du null ci-dessus : "clé absente" et "appel en échec"
   * s'affichaient jusqu'ici sous le même message générique, rendant
   * impossible de distinguer une clé manquante d'une clé invalide ou d'un
   * blocage réseau sans deviner. Absent quand sportmonksConfirmedMatches
   * n'est pas null (pas d'erreur à expliquer). */
  sportmonksError?: string;
}

/**
 * Statut en direct d'un match du programme via SofaScore : minute, score,
 * tirs cadrés, corners et cartons. null si le match n'y est pas connu, pas
 * encore commencé ou si SofaScore ne répond pas (l'appelant retombe sur les
 * fournisseurs IA). Un match terminé est renvoyé avec le statut 'FT' : c'est
 * ce relevé qui permet ensuite de le régler (voir dailyReview.ts).
 */
async function fetchSofaLiveDetail(scheduled: FictionalMatch): Promise<LiveFixtureDetail | null> {
  try {
    // Sources live gratuites d'abord (LiveScore, FotMob, 365Scores, ESPN…) :
    // les fournisseurs IA ne sont plus qu'un dernier recours pour le statut.
    const eventId = await getSofaEventId(scheduled.fixtureId);
    let event = eventId ? await fetchSofaEvent(eventId).catch(() => null) : null;
    if (!event || event.statusShort === 'NS' || event.statusShort === 'OTHER') {
      event = await hubLiveStatus(scheduled.homeTeam, scheduled.awayTeam).catch(() => null);
    }
    if (!event || event.statusShort === 'NS' || event.statusShort === 'OTHER') return null;
    const primary = eventId ? await fetchSofaStats(eventId).catch(() => null) : null;
    const stats = await hubStats(scheduled.homeTeam, scheduled.awayTeam, hubDateKey(), primary).catch(() => primary);
    return {
      statusShort: event.statusShort,
      homeTeam: scheduled.homeTeam,
      awayTeam: scheduled.awayTeam,
      homeGoals: event.homeGoals,
      awayGoals: event.awayGoals,
      fixtureId: scheduled.fixtureId,
      minute: event.minute,
      league: scheduled.league,
      sofaEventId: eventId ?? undefined,
      shotsOnTargetHome: stats?.all?.shotsOnTargetHome,
      shotsOnTargetAway: stats?.all?.shotsOnTargetAway,
      cornersTotal: stats?.all?.corners,
      cardsTotal: stats?.all?.cards,
    };
  } catch {
    return null;
  }
}

const REAL_XG_FALLBACK_CACHE_KEY = '@real_xg_fallback_cache';

/**
 * Matchs du planning réel sans cotes exploitables : au lieu de les écarter
 * (un seul marché proposé sur toute la journée, rien à la 60e), buts
 * attendus estimés par l'IA (une fois par match et par jour, mis en cache),
 * à défaut moyenne neutre d'un match. La projection repose ensuite sur le
 * score, la minute et les tirs réels du match.
 */
async function withFallbackExpectedGoals(
  skipped: ScheduledMatchDetail[],
  omnirouteConfig: OmnirouteConfig | null
): Promise<ScheduledMatch[]> {
  if (skipped.length === 0) return [];
  const today = todayLocalDateString();
  const raw = await AsyncStorage.getItem(REAL_XG_FALLBACK_CACHE_KEY);
  const stored: { date: string; xg: Record<string, { home: number; away: number }> } = raw
    ? JSON.parse(raw)
    : { date: today, xg: {} };
  const cache = stored.date === today ? stored.xg : {};
  let touched = false;

  const result: ScheduledMatch[] = [];
  for (const m of skipped) {
    let xg = cache[m.id];
    if (!xg && omnirouteConfig) {
      const estimated = await estimateExpectedGoalsViaOmniroute(omnirouteConfig, m.homeTeam, m.awayTeam, m.leagueName).catch(() => null);
      if (estimated) {
        xg = estimated;
        cache[m.id] = estimated;
        touched = true;
      }
    }
    const goals = xg ?? NEUTRAL_EXPECTED_GOALS;
    result.push({ ...m, expectedHomeGoals: goals.home, expectedAwayGoals: goals.away });
  }

  if (touched) await AsyncStorage.setItem(REAL_XG_FALLBACK_CACHE_KEY, JSON.stringify({ date: today, xg: cache }));
  return result;
}

export async function runInPlayComboTick(
  liveFixtures: LiveFixture[],
  fictionalLiveFixtures: LiveFixture[] = []
): Promise<InPlayComboTickResult> {
  await ensureDeltaSamplesLoaded();
  const existing = readInPlayProposals();
  // Réel : une jambe proposée bloque TOUT le match pour ce checkpoint (peu
  // importe le marché). Fictif : chaque marché est une jambe indépendante
  // (voir plus bas), donc seul CE marché précis est bloqué pour ce match.
  const alreadyProposed = new Set(
    existing.flatMap((p) =>
      p.real === false
        ? p.legs.map((l) => `${l.fixtureId}-${p.kind}-${l.market}`)
        : p.legs.map((l) => `${l.fixtureId}-${p.kind}`)
    )
  );
  const fresh: InPlayProposal[] = [];
  const omnirouteConfig = await loadOmnirouteConfig();

  // Confirmations Sportmonks/SofaScore (voir processRealSlot) : un seul
  // appel de chaque par tour, partagés entre tous les créneaux réels et
  // internationaux — null si indisponible (pas de clé pour Sportmonks,
  // appel en échec pour l'un ou l'autre — SofaScore n'a pas besoin de clé
  // mais bloque certaines requêtes selon le réseau), auquel cas ce créneau
  // retombe sur le comportement d'avant (tenter Omniroute à l'aveugle).
  const apiConfig = await getAPIConfig();
  // Usage DIRECT (pipeline réel), pas l'auto-apprentissage : compté sur le
  // compteur global (incrementRequestCount) sans passer par spendBudget, qui
  // réserverait 70% du quota à l'auto-learning et grèverait à tort la part
  // laissée à cet usage direct.
  let sportmonksError: string | undefined = apiConfig.sportmonks
    ? undefined
    : 'clé absente (Gestion des API)';
  const sportmonksInPlay = apiConfig.sportmonks
    ? await fetchSportmonksInPlayMatches(apiConfig.sportmonks)
        .then((matches) => { void incrementRequestCount('sportmonks'); return matches; })
        .catch((error: any) => { sportmonksError = error?.message || 'erreur inconnue'; return null; })
    : null;
  const sofaScoreInPlay = await fetchSofaScoreInPlayMatches().catch(() => null);

  // A) Paris RÉELS — 5 grands championnats, par créneau horaire, toutes les
  // ressources disponibles.
  const plan = await getDailyPlan();
  if (plan) {
    for (const slot of plan.slots) {
      const { matches: withOdds, skipped } = buildScheduledMatches([slot]);
      const slotMatches = [...withOdds, ...(await withFallbackExpectedGoals(skipped, omnirouteConfig))];
      await processRealSlot(slotMatches, liveFixtures, omnirouteConfig, alreadyProposed, fresh, sportmonksInPlay, sofaScoreInPlay);
    }
  }

  // A2) Compétitions internationales pendant la trêve (Ligue des Nations,
  // qualifications CAN) — même traitement que A) ci-dessus (notifié, combos
  // par créneau, toutes les ressources), puisque c'est tout ce qui se joue
  // quand les 5 grands championnats sont en pause. Actif UNIQUEMENT dans la
  // fenêtre du calendrier fourni (voir internationalBreakCalendar.ts) : en
  // dehors, `getTodaysInternationalBreakMatches` renvoie toujours un tableau
  // vide, donc ce bloc n'a aucun effet le reste de l'année.
  await announceInternationalBreakCalendarIfDue();
  const { matches: breakMatches, diagnostics: breakDiagBase } = await getTodaysInternationalBreakMatches(omnirouteConfig);
  let intlLiveFound = 0;
  let intlInCheckpointWindow = 0;
  if (breakMatches.length > 0) {
    const bySlot = new Map<string, ScheduledMatch[]>();
    for (const m of breakMatches) {
      const arr = bySlot.get(m.creneau_display) ?? [];
      arr.push(m);
      bySlot.set(m.creneau_display, arr);
    }
    for (const slotMatches of bySlot.values()) {
      const result = await processRealSlot(slotMatches, liveFixtures, omnirouteConfig, alreadyProposed, fresh, sportmonksInPlay, sofaScoreInPlay);
      intlLiveFound += result.liveFound;
      intlInCheckpointWindow += result.inCheckpointWindow;
    }
  }
  const intlBreak: InternationalBreakTickDiagnostics = {
    ...breakDiagBase,
    matchesLiveFound: intlLiveFound,
    matchesInCheckpointWindow: intlInCheckpointWindow,
  };

  // B0) Paris FICTIFS sur les matchs en direct du reste du monde, relevés par
  // les fournisseurs IA (modèles avec accès internet vérifié) — jamais par
  // API-Football, réservé aux 5 grands championnats (demande explicite).
  // Statut, minute et score viennent de ce relevé ; le bilan règle ces paris
  // par les mêmes fournisseurs.
  const liveFictionalCandidates: Array<{ live: LiveFixture; kind: 'minute20' | 'minute60' }> = [];
  for (const live of fictionalLiveFixtures) {
    const kind: 'minute20' | 'minute60' | null =
      live.statusShort === '1H' && live.minute >= LIVE_FICTIONAL_20_MIN && live.minute <= LIVE_FICTIONAL_20_MAX
        ? 'minute20'
        : live.statusShort === '2H' && live.minute >= LIVE_FICTIONAL_60_MIN && live.minute <= LIVE_FICTIONAL_60_MAX
          ? 'minute60'
          : null;
    if (!kind) continue;
    if (alreadyProposed.has(`${live.fixtureId}-${kind}`)) continue; // déjà un pari réel sur ce match
    if ([...alreadyProposed].some((key) => key.startsWith(`${live.fixtureId}-${kind}-`))) continue;
    liveFictionalCandidates.push({ live, kind });
  }

  await mapWithConcurrency(
    liveFictionalCandidates.slice(0, LIVE_FICTIONAL_MAX_PER_TICK),
    FICTIONAL_CHECK_CONCURRENCY,
    async ({ live, kind }) => {
      try {
        const match: MatchRef = {
          homeTeam: live.homeTeam,
          awayTeam: live.awayTeam,
          league: live.league ?? 'Compétition inconnue',
          leagueId: '',
        };
        const expectedGoals =
          (omnirouteConfig
            ? await estimateExpectedGoalsViaOmniroute(omnirouteConfig, match.homeTeam, match.awayTeam, match.league).catch(() => null)
            : null) ?? NEUTRAL_EXPECTED_GOALS;

        // Statistiques réelles du match (tirs cadrés, corners, cartons déjà
        // comptés) : SofaScore les publie, les jambes se projettent donc sur
        // ce qui s'est vraiment passé et non sur la seule moyenne d'un match.
        let currentStats: LiveMatchStats | undefined;
        let observedLive: ObservedLiveCounts | undefined;
        const free = await fetchFreeLiveStats(live);
        if (free) {
          currentStats = { shotsOnTargetHome: free.stats.shotsOnTargetHome, shotsOnTargetAway: free.stats.shotsOnTargetAway };
          observedLive = free.observed;
        }

        // Écart projeté/réel sur les buts, mesuré même sans pari (deltaLearning.ts).
        if (live.statusShort === '1H') {
          const score = { home: live.homeGoals, away: live.awayGoals };
          const goalsNow = score.home + score.away;
          const fix1h = getDeltaCorrection('goals_1h');
          const est1h = estimateRemainingFirstHalfMarket({ preMatchExpectedGoals: correctedGoals(expectedGoals, 'goals_1h'), elapsedMinutes: live.minute, currentScore: score, currentStats });
          await recordShadowProjection(live, {
            unit: 'goals_1h', observed: goalsNow, factorUsed: fix1h.factor,
            expected: goalsNow + est1h.secondHalfExpectedGoals.home + est1h.secondHalfExpectedGoals.away,
          });
          const fixFt = getDeltaCorrection('goals_ft');
          const estFt = estimateRemainingMatchMarket({ preMatchExpectedGoals: correctedGoals(expectedGoals, 'goals_ft'), elapsedMinutes: live.minute, currentScore: score, currentStats });
          await recordShadowProjection(live, {
            unit: 'goals_ft', observed: goalsNow, factorUsed: fixFt.factor,
            expected: goalsNow + estFt.secondHalfExpectedGoals.home + estFt.secondHalfExpectedGoals.away,
          });
        }

        const rawLegs = kind === 'minute20'
          ? await buildLegs20(match, live.fixtureId, live, expectedGoals, currentStats, observedLive)
          : buildLegs60(live, expectedGoals, currentStats);
        const window = kind === 'minute20' ? '20e → pause + match complet' : '60e → fin de match';

        for (const leg of rawLegs.filter((l) => l.prob >= MIN_LEG_PROB)) {
          const dedupKey = `${live.fixtureId}-${kind}-${leg.market}`;
          if (alreadyProposed.has(dedupKey)) continue;
          const proposal = buildProposalFromItems(kind, [{ leg, fixtureId: live.fixtureId, match, live }], window, false);
          if (proposal) {
            fresh.push(proposal);
            alreadyProposed.add(dedupKey);
          }
        }
      } catch (error: any) {
        console.warn(`[Scan en direct] Pari fictif sur ${live.homeTeam} vs ${live.awayTeam} échoué:`, error?.message);
      }
    }
  );
  await flushShadowProjections();

  // B) Paris FICTIFS (boucle d'auto-apprentissage) — 100 % Omniroute, aucune
  // API, aucune cote, aucune donnée payante. AUCUN combo : une batterie de
  // paris SIMPLES indépendants, un par marché qualifié, pour comparer
  // estimation vs réalité marché par marché et affûter le modèle utilisé
  // ensuite sur les vrais matchs. Jamais notifié, jamais affiché comme un
  // vrai pari.
  //
  // Piloté par le PROGRAMME DU JOUR (fictionalProgram.ts) : Omniroute balaie
  // une fois par jour le calendrier de 20 pays européens, toutes divisions et
  // catégories jeunes comprises, et en retient 500 matchs avec leur heure de
  // coup d'envoi. Connaître le coup d'envoi suffit à savoir QUAND regarder
  // chaque match — d'où l'absence totale de relevé "tous les matchs en direct"
  // ici : on ne consulte que les matchs dont l'heure dit qu'ils approchent
  // d'un checkpoint, un par un, ce qui est bien plus fiable qu'une liste
  // globale susceptible d'en oublier.
  //
  // Un seul appel Omniroute par match et par checkpoint ramène tout ce qui est
  // nécessaire (statut, minute, score, tirs cadrés, corners, cartons) ; la
  // mémoire des checkpoints déjà consommés évite de réinterroger le même
  // match à chaque tour tant qu'il reste dans sa fenêtre.
  if (omnirouteConfig) {
    const program = await ensureFictionalDailyProgram(omnirouteConfig).catch(() => [] as FictionalMatch[]);
    const checked = await readCheckedCheckpoints();
    const timelines = await readMatchTimelines();
    let timelinesTouched = false;

    // Phase 1 — sélection des candidats à interroger ce tour, SANS aucun
    // appel réseau : juste de la lecture d'état déjà en mémoire (checkpoints
    // consommés, fenêtre de surveillance, cadence des relevés). Sépare le tri
    // (rapide) de la vérification (lente) pour pouvoir paralléliser cette
    // dernière à l'étape suivante.
    //
    // Priorité aux matchs CONFIRMÉS en direct par le relevé live déjà
    // partagé (API-Football en priorité, repli Omniroute sinon — voir
    // fetchSharedLiveFixtures) : un candidat confirmé a de bien meilleures
    // chances de donner un relevé exploitable qu'un candidat simplement
    // "dans la fenêtre horaire" (coup d'envoi retardé, report, erreur de
    // planning) — les appels Omniroute/FreeLLMAPI du tour, en nombre
    // plafonné, vont donc d'abord aux candidats les plus sûrs. Jamais un
    // filtre bloquant : un candidat non confirmé garde sa place si le
    // plafond du tour n'est pas atteint (le relevé live mondial ne couvre
    // pas forcément les divisions obscures/jeunes que balaie le pipe fictif).
    const eligible: Array<{ scheduled: FictionalMatch; confirmedLive: boolean }> = [];
    for (const scheduled of program) {
      const kickoff = Date.parse(scheduled.kickoff_utc);
      if (!Number.isFinite(kickoff)) continue;
      const elapsedMinutes = (Date.now() - kickoff) / 60_000;

      const checkpoint20Done = checked.has(`${scheduled.fixtureId}-minute20`);
      const checkpoint60Done = checked.has(`${scheduled.fixtureId}-minute60`);
      const timeline = timelines[scheduled.fixtureId] ?? [];
      const hasFinishedSample = timeline.some((s) => FINISHED_STATUSES.has(s.statusShort));
      if (checkpoint20Done && checkpoint60Done && hasFinishedSample) continue; // plus rien à en tirer

      // Trois fenêtres de SURVEILLANCE, en temps réel (pas en minutes de
      // jeu) : du coup d'envoi jusqu'à la 20e minute, puis de la mi-temps
      // jusqu'à la 60e — à chaque fois, le pronostic n'est émis qu'au
      // checkpoint, à partir de l'ÉVOLUTION observée depuis le début, pas
      // d'une photo isolée. Bornes larges à dessein (coup d'envoi retardé,
      // arrêts de jeu) : la minute de jeu exacte est ensuite confirmée par le
      // relevé lui-même.
      //
      // Troisième fenêtre, après les deux checkpoints : uniquement pour
      // capter un relevé "terminé" (score final), sans lequel le bilan de
      // minuit n'a aucun moyen fiable de régler ce pari (fixtureId
      // synthétique, jamais connu d'API-Football). Bornée à
      // FINISH_WATCH_MAX_MINUTE pour ne pas interroger indéfiniment un match
      // dont le suivi aurait décroché (report, erreur de planning).
      const inFirstWatch = !checkpoint20Done && elapsedMinutes >= 0 && elapsedMinutes <= 35;
      const inSecondWatch = !checkpoint60Done && elapsedMinutes >= 50 && elapsedMinutes <= 92;
      const inFinishWatch =
        !hasFinishedSample && elapsedMinutes >= 75 && elapsedMinutes <= FINISH_WATCH_MAX_MINUTE;
      if (!inFirstWatch && !inSecondWatch && !inFinishWatch) continue;

      // Cadence de surveillance : la boucle de premier plan repasse toutes les
      // 3 minutes, inutile de réinterroger le même match aussi souvent.
      const lastSample = timeline[timeline.length - 1];
      const minutesSinceLastSample = lastSample
        ? (Date.now() - Date.parse(lastSample.ts)) / 60_000
        : Infinity;
      if (minutesSinceLastSample < MIN_MINUTES_BETWEEN_SAMPLES) continue;

      eligible.push({ scheduled, confirmedLive: matchConfirmedBy(liveFixtures, scheduled) });
    }

    // Tri stable : confirmés d'abord, à l'intérieur de chaque groupe l'ordre
    // de découverte (déjà équitable entre pays, voir selectBalanced) est
    // conservé.
    eligible.sort((a, b) => Number(b.confirmedLive) - Number(a.confirmedLive));
    const candidates = eligible.slice(0, MAX_FICTIONAL_CHECKS_PER_TICK).map((e) => e.scheduled);

    // Phase 2 — les vérifications sont INDÉPENDANTES les unes des autres :
    // interrogées en parallèle (bornées à FICTIONAL_CHECK_CONCURRENCY à la
    // fois) plutôt qu'une par une comme avant, qui pouvait faire durer un
    // tour manuel plusieurs minutes pour un simple bouton play. Chaque
    // vérification touche ses propres clés (son propre fixtureId) dans
    // `checked`/`timelines`/`alreadyProposed` : aucune ne peut écraser le
    // résultat d'une autre, la parallélisation ne change donc rien au fond,
    // seulement au temps d'attente.
    await mapWithConcurrency(candidates, FICTIONAL_CHECK_CONCURRENCY, async (scheduled) => {
      try {
        // SofaScore d'abord (statut, minute, score et statistiques publiés
        // directement) ; les fournisseurs IA seulement si ce match n'y est pas
        // connu ou si SofaScore ne répond pas.
        const live =
          (await fetchSofaLiveDetail(scheduled)) ??
          (await fetchOmnirouteMatchStatus(
            omnirouteConfig, scheduled.homeTeam, scheduled.awayTeam, scheduled.league
          ).catch(() => null));
        if (!live) return; // pas encore commencé, introuvable : on retentera

        const timeline = timelines[scheduled.fixtureId] ?? [];
        timeline.push({
          ts: new Date().toISOString(),
          minute: live.minute,
          statusShort: live.statusShort,
          homeGoals: live.homeGoals,
          awayGoals: live.awayGoals,
          shotsOnTargetHome: live.shotsOnTargetHome,
          shotsOnTargetAway: live.shotsOnTargetAway,
          cornersTotal: live.cornersTotal,
          cardsTotal: live.cardsTotal,
        });
        timelines[scheduled.fixtureId] = timeline;
        timelinesTouched = true;

        const checkpoint20Done = checked.has(`${scheduled.fixtureId}-minute20`);
        const checkpoint60Done = checked.has(`${scheduled.fixtureId}-minute60`);

        const kind: 'minute20' | 'minute60' | null =
          !checkpoint20Done && live.statusShort === '1H' &&
          live.minute >= CHECKPOINT20_MIN_MINUTE && live.minute <= CHECKPOINT20_MAX_MINUTE
            ? 'minute20'
            : !checkpoint60Done && live.statusShort === '2H' &&
              live.minute >= CHECKPOINT60_MIN_MINUTE && live.minute <= CHECKPOINT60_MAX_MINUTE
              ? 'minute60'
              : null;

        if (!kind) {
          // Pas encore au checkpoint : on continue simplement à surveiller.
          // Fenêtre dépassée en revanche : elle est perdue, inutile d'y revenir.
          if (!checkpoint20Done && (live.statusShort === '2H' || live.minute > CHECKPOINT20_MAX_MINUTE)) {
            checked.add(`${scheduled.fixtureId}-minute20`);
          }
          if (!checkpoint60Done && live.statusShort === '2H' && live.minute > CHECKPOINT60_MAX_MINUTE) {
            checked.add(`${scheduled.fixtureId}-minute60`);
          }
          return;
        }

        const match: MatchRef = {
          homeTeam: scheduled.homeTeam,
          awayTeam: scheduled.awayTeam,
          league: scheduled.league,
          leagueId: '', // aucun identifiant de championnat : tout vient d'Omniroute
        };
        const preMatchExpectedGoals = await estimateExpectedGoalsViaOmniroute(
          omnirouteConfig, match.homeTeam, match.awayTeam, match.league
        ).catch(() => null);

        const currentStats: LiveMatchStats | undefined =
          live.shotsOnTargetHome != null || live.shotsOnTargetAway != null
            ? { shotsOnTargetHome: live.shotsOnTargetHome, shotsOnTargetAway: live.shotsOnTargetAway }
            : undefined;
        const observedLive = observedFromTimeline(timeline);

        const rawLegs = kind === 'minute20'
          ? await buildLegs20(match, live.fixtureId, live, preMatchExpectedGoals, currentStats, observedLive)
          : buildLegs60(live, preMatchExpectedGoals, currentStats);

        const window = kind === 'minute20' ? '20e → pause + match complet' : '60e → fin de match';
        for (const leg of rawLegs.filter((l) => l.prob >= MIN_LEG_PROB)) {
          const dedupKey = `${live.fixtureId}-${kind}-${leg.market}`;
          if (alreadyProposed.has(dedupKey)) continue;
          const proposal = buildProposalFromItems(kind, [{ leg, fixtureId: live.fixtureId, match, live }], window, false);
          if (proposal) {
            fresh.push(proposal);
            alreadyProposed.add(dedupKey);
          }
        }

        checked.add(`${scheduled.fixtureId}-${kind}`);
      } catch (error: any) {
        console.warn(`[Scan en direct] Vérification fictive de ${scheduled.homeTeam} vs ${scheduled.awayTeam} échouée:`, error?.message);
      }
    });

    await writeCheckedCheckpoints(checked);
    if (timelinesTouched) await writeMatchTimelines(timelines);
  }

  if (fresh.length > 0) writeInPlayProposals([...existing, ...fresh]);
  return {
    freshProposals: fresh.length,
    intlBreak,
    sportmonksConfirmedMatches: sportmonksInPlay?.length ?? null,
    sofaScoreConfirmedMatches: sofaScoreInPlay?.length ?? null,
    sportmonksError,
  };
}
