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

import { getDailyPlan } from './scheduler';
import { buildScheduledMatches, ScheduledMatch } from './dailyWorkflow';
import { LiveFixture, fetchOmnirouteMatchStatus } from './halftimeMonitor';
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
import { spendBudget } from './requestBudget';
import { getAPIConfig } from '../api/multiAPIManager';
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

const CHECKPOINT20_MIN_MINUTE = 18;
const CHECKPOINT20_MAX_MINUTE = 24;
const CHECKPOINT60_MIN_MINUTE = 58;
const CHECKPOINT60_MAX_MINUTE = 64;

/** Matchs fictifs interrogés par tour : chaque vérification est une requête
 * Omniroute de quelques secondes, et un tour doit rester court (la boucle de
 * premier plan repasse toutes les 3 minutes). */
const MAX_FICTIONAL_CHECKS_PER_TICK = 25;
/** En dessous, le rythme observé (corners/cartons par minute) porte trop peu
 * d'information pour extrapoler quoi que ce soit. */
const MIN_MINUTES_FOR_PACE_PROJECTION = 15;
/** Délai minimum entre deux relevés d'un même match pendant la surveillance :
 * la boucle de premier plan repasse toutes les 3 minutes, inutile de
 * réinterroger un agent aussi souvent pour le même match. */
const MIN_MINUTES_BETWEEN_SAMPLES = 6;
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
async function fetchRealLiveStats(fixtureId: number): Promise<LiveMatchStats | undefined> {
  const apiConfig = await getAPIConfig();
  if (!apiConfig.apiFootball) return undefined;
  if (!(await spendBudget('apiFootball'))) return undefined;

  try {
    const markers = await fetchMarkers(apiConfig.apiFootball, fixtureId);
    if (markers.shotsOnTargetHome == null && markers.shotsOnTargetAway == null) return undefined;
    return markers;
  } catch {
    return undefined;
  }
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
    const est = estimateRemainingFirstHalfMarket({ preMatchExpectedGoals, elapsedMinutes, currentScore, currentStats });
    const m = est.markets[0];
    const blended = blendWithLearnedMarkers(m.estimated_prob, m.reasoning, snapshot);
    legs.push({ market: 'buts_1ere_mt', selection: 'Oui, un but avant la pause', prob: blended.prob, evidence: blended.evidence });
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

    const cornersLambda = (priors.home.cornersFor + priors.away.cornersFor) * fraction;
    const cornersLine = pickHighestConfidentOverLine(cornersLambda, LINE_PICK_THRESHOLD, observedCorners ?? 0);
    if (cornersLine) {
      legs.push({
        market: 'corners',
        selection: `Plus de ${cornersLine.line} corners en 1ère mi-temps`,
        prob: cornersLine.prob,
        evidence: `${observedCorners ?? 0} corner(s) déjà compté(s) + ${cornersLambda.toFixed(1)} attendus sur le reste de la 1ère MT (moyennes de saison Football-Data.co.uk).`
      });
    }

    const cardsLambda = (priors.home.cardsFor + priors.away.cardsFor) * fraction;
    const cardsLine = pickHighestConfidentOverLine(cardsLambda, LINE_PICK_THRESHOLD, observedCards ?? 0);
    if (cardsLine) {
      legs.push({
        market: 'cartons',
        selection: `Plus de ${cardsLine.line} cartons en 1ère mi-temps`,
        prob: cardsLine.prob,
        evidence: `${observedCards ?? 0} carton(s) déjà compté(s) + ${cardsLambda.toFixed(1)} attendus sur le reste de la 1ère MT (moyennes de saison Football-Data.co.uk).`
      });
    }
  } else if (elapsedMinutes >= MIN_MINUTES_FOR_PACE_PROJECTION) {
    // Aucune moyenne de saison : projection au rythme observé dans CE match.
    // Le rythme mesuré pendant la surveillance (entre deux relevés) prime sur
    // la moyenne depuis le coup d'envoi — c'est lui qui reflète où en est le
    // match maintenant, pas où il en était en moyenne.
    const remainingMinutes = Math.max(0, 45 - elapsedMinutes);

    if (observedCorners != null) {
      const perMinute = observedLive?.cornersPerMinute ?? observedCorners / elapsedMinutes;
      const source = observedLive?.cornersPerMinute != null ? 'rythme suivi en direct' : 'moyenne depuis le coup d\'envoi';
      const lambda = perMinute * remainingMinutes;
      const line = pickHighestConfidentOverLine(lambda, LINE_PICK_THRESHOLD, observedCorners);
      if (line) {
        legs.push({
          market: 'corners',
          selection: `Plus de ${line.line} corners en 1ère mi-temps`,
          prob: line.prob,
          evidence: `${observedCorners} corner(s) à la ${elapsedMinutes}e minute, ${source} de ${perMinute.toFixed(2)}/min → ${lambda.toFixed(1)} attendu(s) d'ici la pause.`
        });
      }
    }

    if (observedCards != null) {
      const perMinute = observedLive?.cardsPerMinute ?? observedCards / elapsedMinutes;
      const source = observedLive?.cardsPerMinute != null ? 'rythme suivi en direct' : 'moyenne depuis le coup d\'envoi';
      const lambda = perMinute * remainingMinutes;
      const line = pickHighestConfidentOverLine(lambda, LINE_PICK_THRESHOLD, observedCards);
      if (line) {
        legs.push({
          market: 'cartons',
          selection: `Plus de ${line.line} cartons en 1ère mi-temps`,
          prob: line.prob,
          evidence: `${observedCards} carton(s) à la ${elapsedMinutes}e minute, ${source} de ${perMinute.toFixed(2)}/min → ${lambda.toFixed(1)} attendu(s) d'ici la pause.`
        });
      }
    }
  }

  // 4) BTTS / 5) Total du match — projection sur le match ENTIER, pas
  // seulement la 1ère MT (déjà acquis si les deux ont déjà marqué / si le
  // total dépasse déjà la ligne : rien à prédire, on ne propose pas).
  if (preMatchExpectedGoals) {
    const fullEst = estimateRemainingMatchMarket({ preMatchExpectedGoals, elapsedMinutes, currentScore, currentStats });
    const bttsMarket = fullEst.markets.find((m) => m.market === 'FT_btts_reprojete');
    if (bttsMarket && !(currentScore.home > 0 && currentScore.away > 0)) {
      legs.push(pickBinarySide('btts', bttsMarket, 'Les deux équipes ne marquent pas toutes les deux (Non)'));
    }
    const overMarket = fullEst.markets.find((m) => m.market === 'FT_over_2_5_reprojete');
    if (overMarket && !(currentScore.home + currentScore.away > 2.5)) {
      legs.push(pickBinarySide('total_buts', overMarket, 'Moins de 2.5 buts (total match)'));
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

  const est = estimateRemainingMatchMarket({ preMatchExpectedGoals, elapsedMinutes, currentScore, currentStats });

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
    legs.push(pickBinarySide('total_buts', overMarket, 'Moins de 2.5 buts (total match)'));
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

async function notifyProposal(proposal: InPlayProposal): Promise<void> {
  const legsText = proposal.legs
    .map((l) => `• ${l.homeTeam} ${l.scoreLabel} ${l.awayTeam} — ${l.selection} (${(l.prob * 100).toFixed(0)}%)`)
    .join('\n');
  const emoji = proposal.kind === 'minute20' ? '⚡' : '⏱️';
  const title = proposal.legs.length === 1
    ? `${emoji} ${proposal.minute}e — ${proposal.legs[0].homeTeam} ${proposal.legs[0].scoreLabel} ${proposal.legs[0].awayTeam}`
    : `${emoji} ${proposal.minute}e — Combo (${proposal.legs.length} matchs)`;
  await sendLocalNotification(
    title,
    `${proposal.window} — ${(proposal.combinedProb * 100).toFixed(0)}% combiné\n${legsText}`,
    { kind: proposal.kind }
  );
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
  const currentStats = await fetchRealLiveStats(live.fixtureId);

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

  const perMatch: LegWithContext[] = [];
  for (const { scheduled, live } of candidates) {
    const best = await bestLegFor(kind, scheduled, live);
    if (best) perMatch.push(best);
  }
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
 * Un tour de scan. Appelé par la tâche de fond (toutes les ~15 min) et par
 * la boucle de premier plan (3 min). Ne notifie jamais deux fois le même
 * match pour le même checkpoint. `liveFixtures` est déjà récupéré par
 * backgroundTasks.ts (un seul relevé /fixtures?live=all par tour, partagé
 * avec liveMarkers.ts) — avant ce partage, chaque module refaisait sa propre
 * requête, doublant la consommation du quota API-Football à chaque tour.
 */
export async function runInPlayComboTick(liveFixtures: LiveFixture[]): Promise<number> {
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

  // A) Paris RÉELS — 5 grands championnats, par créneau horaire, toutes les
  // ressources disponibles.
  const plan = await getDailyPlan();
  if (plan) {
    for (const slot of plan.slots) {
      const { matches: slotMatches } = buildScheduledMatches([slot]);
      if (slotMatches.length === 0) continue;

      const candidates20: Array<{ scheduled: ScheduledMatch; live: LiveFixture }> = [];
      const candidates60: Array<{ scheduled: ScheduledMatch; live: LiveFixture }> = [];

      for (const scheduled of slotMatches) {
        let live = findLiveFixture(scheduled, liveFixtures);
        // Repli Omniroute CIBLÉ sur ce match précis (pas la découverte large
        // du pipeline fictif) : un match d'argent réel absent du relevé live
        // partagé — API-Football en panne, ou simplement pas mentionné par la
        // découverte Omniroute générale — ne doit jamais rester sans
        // vérification, sous peine de rater une notification de pari réel.
        // Bornage au coup d'envoi théorique (± 130 min) pour ne pas
        // interroger Omniroute sur des matchs qui n'ont clairement pas encore
        // commencé ou sont clairement terminés.
        if (!live && omnirouteConfig) {
          const elapsedMs = Date.now() - Date.parse(scheduled.kickoff_utc);
          if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 130 * 60 * 1000) {
            live = (await fetchOmnirouteMatchStatus(
              omnirouteConfig, scheduled.homeTeam, scheduled.awayTeam, scheduled.leagueName
            ).catch(() => null)) ?? undefined;
          }
        }
        if (!live) continue;

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
    }
  }

  // B) Paris FICTIFS (boucle d'auto-apprentissage) — 100 % Omniroute, aucune
  // API, aucune cote, aucune donnée payante. AUCUN combo : une batterie de
  // paris SIMPLES indépendants, un par marché qualifié, pour comparer
  // estimation vs réalité marché par marché et affûter le modèle utilisé
  // ensuite sur les vrais matchs. Jamais notifié, jamais affiché comme un
  // vrai pari.
  //
  // Piloté par le PROGRAMME DU JOUR (fictionalProgram.ts) : Omniroute balaie
  // une fois par jour le calendrier de 20 pays européens, toutes divisions et
  // catégories jeunes comprises, et en retient 250 matchs avec leur heure de
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
    let checksThisTick = 0;

    for (const scheduled of program) {
      if (checksThisTick >= MAX_FICTIONAL_CHECKS_PER_TICK) break;

      const kickoff = Date.parse(scheduled.kickoff_utc);
      if (!Number.isFinite(kickoff)) continue;
      const elapsedMinutes = (Date.now() - kickoff) / 60_000;

      const checkpoint20Done = checked.has(`${scheduled.fixtureId}-minute20`);
      const checkpoint60Done = checked.has(`${scheduled.fixtureId}-minute60`);
      if (checkpoint20Done && checkpoint60Done) continue; // match déjà traité de bout en bout

      // Deux fenêtres de SURVEILLANCE, en temps réel (pas en minutes de jeu) :
      // du coup d'envoi jusqu'à la 20e minute, puis de la mi-temps jusqu'à la
      // 60e. On relève le match régulièrement pendant toute la fenêtre, et le
      // pronostic n'est émis qu'au checkpoint — à partir de l'ÉVOLUTION
      // observée depuis le début, pas d'une photo isolée. Bornes larges à
      // dessein (coup d'envoi retardé, arrêts de jeu) : la minute de jeu
      // exacte est ensuite confirmée par le relevé lui-même.
      const inFirstWatch = !checkpoint20Done && elapsedMinutes >= 0 && elapsedMinutes <= 35;
      const inSecondWatch = !checkpoint60Done && elapsedMinutes >= 50 && elapsedMinutes <= 92;
      if (!inFirstWatch && !inSecondWatch) continue;

      // Cadence de surveillance : la boucle de premier plan repasse toutes les
      // 3 minutes, inutile de réinterroger le même match aussi souvent.
      const timeline = timelines[scheduled.fixtureId] ?? [];
      const lastSample = timeline[timeline.length - 1];
      const minutesSinceLastSample = lastSample
        ? (Date.now() - Date.parse(lastSample.ts)) / 60_000
        : Infinity;
      if (minutesSinceLastSample < MIN_MINUTES_BETWEEN_SAMPLES) continue;

      checksThisTick++;
      const live = await fetchOmnirouteMatchStatus(
        omnirouteConfig, scheduled.homeTeam, scheduled.awayTeam, scheduled.league
      ).catch(() => null);
      if (!live) continue; // pas encore commencé, déjà fini, ou introuvable : on retentera

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
        continue;
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
    }

    await writeCheckedCheckpoints(checked);
    if (timelinesTouched) await writeMatchTimelines(timelines);
  }

  if (fresh.length > 0) writeInPlayProposals([...existing, ...fresh]);
  return fresh.length;
}
