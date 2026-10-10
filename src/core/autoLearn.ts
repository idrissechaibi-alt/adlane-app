// Boucle d'auto-apprentissage silencieuse, multi-marchés.
//
// 1. Consolide le corpus étiqueté en règles lisibles et comptées :
//    "quand X marqueurs sont réunis, un CORNER / un BUT / un CARTON survient
//    dans les N minutes dans Y% des cas, soit Z fois le taux de base".
// 2. Fait des paris papier en avance de phase (jamais d'argent, jamais de
//    notification) et les règle quand la vérité terrain arrive -> taux de
//    réussite réel et facteur de recalibrage.
// 3. Produit un digest court, injecté aux agents IA.
//
// Rien ici n'invente : une règle sans échantillon suffisant est écartée, une
// fenêtre tronquée (mi-temps arrivée trop tôt) n'est jamais comptée.

import type { CalibrationCell } from './learnStore';
import { getStrategyRecords } from './strategies';
import { DELTA_LABELS, getAllDeltaCorrections, getShadowStats } from './deltaLearning';
import { getAllBets } from '../database/storage';
import { HISTORICAL_BETS } from '../data/historical';
import {
  CrossCheckSample,
  EventDeltas,
  LEARNING_HORIZONS,
  LearnedModel,
  MarkerRule,
  MarkerSnapshot,
  MarketDayPoint,
  MarketExpertise,
  PaperBet,
  PredictionOutcome,
  TrackedMarket,
  TrainingRow,
  marketLabel,
  appendPredictionOutcomes,
  readAgentDigest,
  readCrossCheckSamples,
  readInPlayProposals,
  readLearnedModel,
  readMarketSeries,
  readPaperBets,
  readPredictionOutcomes,
  readTrainingRows,
  readAccuracySnapshots,
  recordAccuracySnapshot,
  writeAgentDigest,
  writeLearnedModel,
  writePaperBets,
} from './learnStore';
import { computeScoutingAccuracy } from './scoutingReview';
import { todayLocalDateString } from './scheduler';

/** Fiabilité observée du scan en direct (20e/60e minute), par marché, sur les N derniers jours — réel ET fictif confondus (les deux réglés de la même façon, voir dailyReview.ts). */
function computeCheckpointCalibration(days: number = 30) {
  const cutoff = Date.now() - days * 24 * 3_600_000;
  const points = readMarketSeries().filter((p) => new Date(p.date).getTime() > cutoff);

  const byMarket = new Map<TrackedMarket, { correct: number; total: number; predictedSum: number }>();
  for (const point of points) {
    const entry = byMarket.get(point.market) ?? { correct: 0, total: 0, predictedSum: 0 };
    entry.correct += point.correct;
    entry.total += point.predictions;
    entry.predictedSum += point.meanPredicted * point.predictions;
    byMarket.set(point.market, entry);
  }

  return Array.from(byMarket.entries())
    .map(([market, entry]) => ({
      market,
      samples: entry.total,
      hitRate: entry.total > 0 ? entry.correct / entry.total : 0,
      meanPredicted: entry.total > 0 ? entry.predictedSum / entry.total : 0,
    }))
    .sort((a, b) => b.samples - a.samples);
}

/** Échantillon minimum pour qu'une règle soit retenue (anti-bruit). */
const MIN_SAMPLES_PER_RULE = 30;
/** Écart minimum au taux de base pour qu'une règle soit jugée informative. */
const MIN_LIFT = 1.15;
/** Seuil de déclenchement d'un pari papier. */
const PAPER_BET_PROB_THRESHOLD = 0.35;
/**
 * Seuils de promotion des marqueurs Omniroute (scrapés) au rang de source de
 * calibrage à part entière : il faut assez de recoupements avec la vérité
 * terrain API-Football, ET un taux d'accord suffisant, sinon Omniroute reste
 * cantonné à de la couverture supplémentaire non calibrante.
 */
const CROSSCHECK_MIN_SAMPLES = 30;
const CROSSCHECK_MIN_AGREE_RATE = 0.8;

interface MarkerCandidate {
  name: string;
  label: string;
  value: (snapshot: MarkerSnapshot) => number | undefined;
  thresholds: number[];
}

/**
 * Marqueurs testés. On agrège domicile + extérieur : ce qui précède un
 * événement, c'est le volume de jeu total, peu importe qui le produit.
 */
const MARKER_CANDIDATES: MarkerCandidate[] = [
  {
    name: 'shots_on_target_total',
    label: 'tirs cadrés cumulés',
    value: (s) => sumDefined(s.markers.shotsOnTargetHome, s.markers.shotsOnTargetAway),
    thresholds: [2, 3, 4, 5],
  },
  {
    name: 'shots_total',
    label: 'tirs totaux cumulés',
    value: (s) => sumDefined(s.markers.shotsTotalHome, s.markers.shotsTotalAway),
    thresholds: [6, 9, 12],
  },
  {
    name: 'corners_total',
    label: 'corners cumulés',
    value: (s) => sumDefined(s.markers.cornersHome, s.markers.cornersAway),
    thresholds: [2, 4, 6],
  },
  {
    name: 'cards_total',
    label: 'cartons cumulés',
    value: (s) => sumDefined(s.markers.cardsHome, s.markers.cardsAway),
    thresholds: [1, 2, 3],
  },
  {
    name: 'fouls_total',
    label: 'fautes cumulées',
    value: (s) => sumDefined(s.markers.foulsHome, s.markers.foulsAway),
    thresholds: [5, 8, 12],
  },
  {
    name: 'possession_imbalance',
    label: 'déséquilibre de possession (écart à 50%)',
    value: (s) =>
      s.markers.possessionHome == null ? undefined : Math.abs(s.markers.possessionHome - 50),
    thresholds: [10, 15, 20],
  },
  {
    name: 'minute',
    label: 'minute de jeu atteinte',
    value: (s) => s.minute,
    thresholds: [15, 20, 30],
  },
];

/** Cibles apprises : l'événement à prédire pendant la fenêtre. */
interface LearningTarget {
  key: string;
  label: string;
  /** Marché suivi dans la courbe d'évolution. */
  market: TrackedMarket;
  hit: (deltas: EventDeltas) => boolean;
}

const LEARNING_TARGETS: LearningTarget[] = [
  { key: 'goals>=1', label: 'au moins 1 but', market: 'buts_1ere_mt', hit: (d) => d.goals >= 1 },
  { key: 'goals>=2', label: 'au moins 2 buts', market: 'buts_1ere_mt', hit: (d) => d.goals >= 2 },
  { key: 'corners>=2', label: 'au moins 2 corners', market: 'corners', hit: (d) => d.corners >= 2 },
  { key: 'corners>=3', label: 'au moins 3 corners', market: 'corners', hit: (d) => d.corners >= 3 },
  { key: 'cards>=1', label: 'au moins 1 carton', market: 'cartons', hit: (d) => d.cards >= 1 },
  { key: 'cards>=2', label: 'au moins 2 cartons', market: 'cartons', hit: (d) => d.cards >= 2 },
  { key: 'fouls>=3', label: 'au moins 3 fautes', market: 'fautes', hit: (d) => d.fouls >= 3 },
  { key: 'fouls>=5', label: 'au moins 5 fautes', market: 'fautes', hit: (d) => d.fouls >= 5 },
];

/** Marché suivi correspondant à une cible apprise. */
export function marketForTarget(targetKey: string): TrackedMarket {
  return LEARNING_TARGETS.find((t) => t.key === targetKey)?.market ?? 'buts_1ere_mt';
}

/**
 * Convertit les paris papier déjà réglés en points de courbe par marché —
 * pour l'écran Courbes UNIQUEMENT (jamais consultée par autoLearn, qui
 * continue à lire paperBets directement). Intérêt : ce système se règle avec
 * les seules données observées EN DIRECT pendant le match (pas besoin du
 * score final), donc déjà fiable avec un échantillon conséquent (~90+ paris)
 * alors même que le système à checkpoints (dailyReview.ts, qui alimente
 * marketSeriesFictional) reste encore jeune après sa remise en état.
 *
 * Ne couvre que les marchés que les marqueurs en direct savent trancher —
 * buts 1ère mi-temps, corners, cartons, fautes (voir LEARNING_TARGETS) :
 * 1X2/total de buts/BTTS ont besoin du résultat complet du match et restent
 * entièrement dépendants du système à checkpoints.
 */
export function buildMarketDayPointsFromPaperBets(bets: PaperBet[]): MarketDayPoint[] {
  const byKey = new Map<
    string,
    { date: string; market: TrackedMarket; correct: number; total: number; predictedSum: number }
  >();

  for (const bet of bets) {
    if (!bet.settled || bet.won == null || !bet.settledAt) continue;
    const date = bet.settledAt.slice(0, 10);
    const market = marketForTarget(bet.target);
    const key = `${date}|${market}`;
    const entry = byKey.get(key) ?? { date, market, correct: 0, total: 0, predictedSum: 0 };
    entry.total += 1;
    entry.predictedSum += bet.modelProb;
    if (bet.won) entry.correct += 1;
    byKey.set(key, entry);
  }

  return Array.from(byKey.values()).map((e) => ({
    date: e.date,
    market: e.market,
    predictions: e.total,
    correct: e.correct,
    hitRate: e.total > 0 ? e.correct / e.total : 0,
    meanPredicted: e.total > 0 ? e.predictedSum / e.total : 0,
  }));
}

function sumDefined(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function baselineKey(target: string, horizon: number): string {
  return `${target}@${horizon}`;
}

/** Ligues et marchés sur lesquels l'utilisateur joue réellement. */
export async function getUserFocus(): Promise<{ leagues: string[]; markets: string[] }> {
  let bets = HISTORICAL_BETS;
  try {
    const stored = await getAllBets();
    if (stored && stored.length > 0) bets = stored;
  } catch {
    // base indisponible : on reste sur l'historique embarqué
  }

  const leagues = new Set<string>();
  const markets = new Set<string>();
  for (const bet of bets) {
    for (const leg of bet.legs || []) {
      if (leg.league) leagues.add(leg.league);
      if (leg.market) markets.add(String(leg.market));
    }
  }
  return { leagues: Array.from(leagues), markets: Array.from(markets) };
}

/**
 * Fiabilité mesurée des marqueurs Omniroute par recoupement avec la vérité
 * terrain API-Football (voir liveMarkers.ts). Tant que le seuil n'est pas
 * atteint, les lignes 'omniroute' ne servent qu'à observer, jamais à bâtir
 * une règle de calibrage.
 */
function computeOmnirouteTrust(samples: CrossCheckSample[]): NonNullable<LearnedModel['omnirouteTrust']> {
  if (samples.length === 0) return { samples: 0, agreeRate: 0, trusted: false };
  const agreeing = samples.filter((s) => s.agree).length;
  const agreeRate = agreeing / samples.length;
  return {
    samples: samples.length,
    agreeRate,
    trusted: samples.length >= CROSSCHECK_MIN_SAMPLES && agreeRate >= CROSSCHECK_MIN_AGREE_RATE,
  };
}

/** Lignes exploitables pour un horizon : fenêtre présente, non tronquée, et source assez fiable. */
function rowsForHorizon(
  rows: TrainingRow[],
  horizon: number,
  allowOmniroute: boolean
): Array<{ row: TrainingRow; deltas: EventDeltas }> {
  const usable: Array<{ row: TrainingRow; deltas: EventDeltas }> = [];
  for (const row of rows) {
    if (row.source === 'omniroute' && !allowOmniroute) continue;
    const deltas = row.horizons?.[String(horizon)];
    if (!deltas || deltas.truncated) continue;
    usable.push({ row, deltas });
  }
  return usable;
}

function buildRules(
  rows: TrainingRow[],
  allowOmniroute: boolean
): { rules: MarkerRule[]; baselines: Record<string, number> } {
  const rules: MarkerRule[] = [];
  const baselines: Record<string, number> = {};

  for (const horizon of LEARNING_HORIZONS) {
    const usable = rowsForHorizon(rows, horizon, allowOmniroute);
    if (usable.length < MIN_SAMPLES_PER_RULE) continue;

    for (const target of LEARNING_TARGETS) {
      const baseline = usable.filter(({ deltas }) => target.hit(deltas)).length / usable.length;
      baselines[baselineKey(target.key, horizon)] = baseline;
      if (baseline <= 0) continue;

      for (const candidate of MARKER_CANDIDATES) {
        for (const threshold of candidate.thresholds) {
          const matching = usable.filter(({ row }) => {
            const value = candidate.value(row);
            return value != null && value >= threshold;
          });

          if (matching.length < MIN_SAMPLES_PER_RULE) continue;

          const hits = matching.filter(({ deltas }) => target.hit(deltas)).length;
          const hitRate = hits / matching.length;
          const lift = hitRate / baseline;
          if (lift < MIN_LIFT) continue;

          rules.push({
            marker: `${candidate.name}>=${threshold}`,
            threshold,
            target: target.key,
            horizon,
            samples: matching.length,
            hitRate,
            baseline,
            lift,
          });
        }
      }
    }
  }

  return { rules: rules.sort((a, b) => b.lift - a.lift).slice(0, 40), baselines };
}

/**
 * Probabilité estimée par le modèle pour une cible donnée sur un instantané.
 * Prend la règle déclenchée la plus informative, recalibrée par le bilan réel
 * des paris papier. Renvoie null si aucune règle ne s'applique.
 */
export function scoreSnapshot(
  snapshot: MarkerSnapshot,
  model: LearnedModel | null,
  target: string,
  horizon: number
): { prob: number; rule: MarkerRule } | null {
  if (!model || model.markerRules.length === 0) return null;

  let best: { prob: number; rule: MarkerRule } | null = null;

  for (const rule of model.markerRules) {
    if (rule.target !== target || rule.horizon !== horizon) continue;

    const [name, thresholdRaw] = rule.marker.split('>=');
    const candidate = MARKER_CANDIDATES.find((c) => c.name === name);
    if (!candidate) continue;

    const value = candidate.value(snapshot);
    if (value == null || value < Number(thresholdRaw)) continue;

    const calibrated = Math.min(0.95, rule.hitRate * model.paperBets.calibrationFactor);
    if (!best || calibrated > best.prob) best = { prob: calibrated, rule };
  }

  return best;
}

/** Toutes les cibles déclenchées sur un instantané, triées par probabilité. */
export function scoreAllTargets(
  snapshot: MarkerSnapshot,
  model: LearnedModel | null,
  horizon: number
): Array<{ target: string; label: string; market: TrackedMarket; prob: number; rule: MarkerRule }> {
  const results: Array<{ target: string; label: string; market: TrackedMarket; prob: number; rule: MarkerRule }> = [];

  for (const target of LEARNING_TARGETS) {
    const scored = scoreSnapshot(snapshot, model, target.key, horizon);
    if (scored) {
      results.push({
        target: target.key,
        label: target.label,
        market: target.market,
        prob: scored.prob,
        rule: scored.rule,
      });
    }
  }

  return results.sort((a, b) => b.prob - a.prob);
}

/**
 * Enregistre des paris papier si le modèle déclenche (aucune notification).
 * Tant qu'Omniroute n'est pas promu source fiable, ses instantanés sont
 * exclus : sinon un bruit de lecture non prouvé fausserait le taux de
 * réussite mesuré (paperBets.hitRate), qui recalibre TOUTES les probabilités
 * — y compris celles issues d'API-Football.
 */
export function maybePlacePaperBets(snapshots: MarkerSnapshot[], model: LearnedModel | null): void {
  if (!model) return;

  const existing = readPaperBets();
  const known = new Set(existing.map((b) => `${b.fixtureId}-${b.minuteAtPlacement}-${b.target}-${b.horizon}`));
  const added: PaperBet[] = [];
  const eligibleSnapshots = model.omnirouteTrust?.trusted
    ? snapshots
    : snapshots.filter((s) => s.source !== 'omniroute');

  for (const snapshot of eligibleSnapshots) {
    for (const horizon of LEARNING_HORIZONS) {
      for (const scored of scoreAllTargets(snapshot, model, horizon)) {
        // Seuil comparé au taux BRUT de la règle, pas à la probabilité
        // recalibrée : sinon, dès que le recalibrage rabote (×0,75 observé),
        // plus aucune règle ne franchit le seuil, plus aucun pari n'est placé,
        // et le modèle ne peut plus mesurer s'il s'améliore (paris arrêtés
        // depuis le 6 octobre). La probabilité enregistrée reste recalibrée.
        if (scored.rule.hitRate < PAPER_BET_PROB_THRESHOLD) continue;

        const key = `${snapshot.fixtureId}-${snapshot.minute}-${scored.target}-${horizon}`;
        if (known.has(key)) continue;
        known.add(key);

        added.push({
          id: `paper-${key}-${Date.now()}`,
          placedAt: snapshot.ts,
          fixtureId: snapshot.fixtureId,
          league: snapshot.league,
          country: snapshot.country,
          target: scored.target,
          horizon,
          selection: `${scored.label} dans les ${horizon} prochaines minutes`,
          modelProb: scored.prob,
          minuteAtPlacement: snapshot.minute,
          settled: false,
        });
      }
    }
  }

  if (added.length > 0) writePaperBets([...existing, ...added]);
}

/** Règle les paris papier dont la vérité terrain est arrivée. */
function settlePaperBets(rows: TrainingRow[]): PaperBet[] {
  const bets = readPaperBets();
  const truth = new Map<string, TrainingRow>();
  for (const row of rows) truth.set(`${row.fixtureId}-${row.minute}`, row);

  let changed = false;
  for (const bet of bets) {
    if (bet.settled) continue;

    const row = truth.get(`${bet.fixtureId}-${bet.minuteAtPlacement}`);
    const deltas = row?.horizons?.[String(bet.horizon)];
    if (!deltas || deltas.truncated) continue;

    const target = LEARNING_TARGETS.find((t) => t.key === bet.target);
    if (!target) continue;

    bet.settled = true;
    bet.won = target.hit(deltas);
    bet.settledAt = new Date().toISOString();
    changed = true;
  }

  if (changed) writePaperBets(bets);
  return bets;
}

/** Échantillons nécessaires avant qu'un marché ne corrige quoi que ce soit :
 * en dessous, l'écart mesuré est du bruit, pas une expertise. */
const MIN_OUTCOMES_PER_MARKET = 25;

/**
 * Synthèse de ce que valent réellement nos annonces, marché par marché :
 * probabilité moyenne annoncée vs taux de réussite constaté. C'est le cœur de
 * l'expertise empirique que l'app s'auto-fabrique — alimentée surtout par les
 * paris fictifs (gros volume, aucun enjeu) et appliquée ensuite aux deux
 * pipelines, y compris aux paris réels.
 */
/** Côté et fenêtre d'un pari, d'après son intitulé. */
export function calibrationSegment(selection: string): string {
  const side = /^moins|0-0|ne marquent pas|\(non\)|pas de but/i.test(selection) ? 'non' : 'oui';
  const window = /1[èe]re mi-temps|avant la pause|à la pause/i.test(selection) ? '1h' : 'ft';
  return `${side}|${window}`;
}

const CALIBRATION_BINS: Array<[number, number]> = [[0.45, 0.55], [0.55, 0.65], [0.65, 0.75], [0.75, 0.85], [0.85, 1.01]];
/** Poids (en paris) de la probabilité annoncée face au taux observé dans une case. */
const CELL_PRIOR = 15;
const CELL_MIN_SAMPLES = 15;

function computeCells(list: PredictionOutcome[]): CalibrationCell[] {
  const cells: CalibrationCell[] = [];
  const bySegment = new Map<string, PredictionOutcome[]>();
  for (const o of list) {
    const key = calibrationSegment(o.selection);
    bySegment.set(key, [...(bySegment.get(key) ?? []), o]);
  }
  for (const [segment, items] of bySegment) {
    for (const [lo, hi] of CALIBRATION_BINS) {
      const inBin = items.filter((o) => o.predictedProb >= lo && o.predictedProb < hi);
      if (inBin.length === 0) continue;
      cells.push({
        segment,
        lo,
        hi,
        samples: inBin.length,
        hits: inBin.filter((o) => o.won).length,
        meanPredicted: inBin.reduce((a, o) => a + o.predictedProb, 0) / inBin.length,
        realSamples: inBin.filter((o) => o.real).length,
      });
    }
  }
  return cells;
}

function computeMarketExpertise(outcomes: PredictionOutcome[]): MarketExpertise[] {
  const byMarket = new Map<TrackedMarket, PredictionOutcome[]>();
  for (const outcome of outcomes) {
    const list = byMarket.get(outcome.market) ?? [];
    list.push(outcome);
    byMarket.set(outcome.market, list);
  }

  const expertise: MarketExpertise[] = [];
  for (const [market, list] of byMarket) {
    const samples = list.length;
    const hitRate = list.filter((o) => o.won).length / samples;
    const meanPredicted = list.reduce((sum, o) => sum + o.predictedProb, 0) / samples;
    // Borné comme le recalibrage global : une série de malchance ne doit pas
    // effondrer un marché, ni une bonne série le rendre euphorique.
    const rawFactor = meanPredicted > 0 && samples >= MIN_OUTCOMES_PER_MARKET ? hitRate / meanPredicted : 1;
    expertise.push({
      market,
      samples,
      meanPredicted,
      hitRate,
      calibrationFactor: Math.min(1.5, Math.max(0.5, rawFactor)),
      cells: computeCells(list),
    });
  }

  return expertise.sort((a, b) => b.samples - a.samples);
}

/**
 * Corrige une probabilité annoncée par l'expertise empirique accumulée sur ce
 * marché précis, et dit dans l'évidence ce qui a été appliqué. Appelée pour
 * CHAQUE jambe des deux pipelines : c'est le point par lequel tout ce que
 * l'app a mesuré revient nourrir la prédiction suivante. Sans assez
 * d'échantillons, renvoie la probabilité telle quelle — jamais de correction
 * bâtie sur du bruit.
 */
export function applyMarketExpertise(
  market: TrackedMarket,
  prob: number,
  evidence: string,
  selection?: string
): { prob: number; evidence: string } {
  const model = readLearnedModel();
  const expertise = model?.marketExpertise?.find((e) => e.market === market);
  // Calibration fine d'abord : même marché, même côté, même fenêtre, même
  // tranche de probabilité annoncée — paris réels ET fictifs réglés.
  const cell = selection
    ? expertise?.cells?.find((c) => c.segment === calibrationSegment(selection) && prob >= c.lo && prob < c.hi)
    : undefined;
  if (cell && cell.samples >= CELL_MIN_SAMPLES) {
    const observed = cell.hits / cell.samples;
    const shift = (observed - cell.meanPredicted) * (cell.samples / (cell.samples + CELL_PRIOR));
    const corrected = Math.min(0.97, Math.max(0.03, prob + shift));
    if (Math.abs(corrected - prob) >= 0.01) {
      return {
        prob: corrected,
        evidence:
          `${evidence} Calibré ${shift >= 0 ? '+' : ''}${Math.round(shift * 100)} pts : sur ${cell.samples} paris semblables déjà vérifiés ` +
          `(${cell.realSamples} réels, ${cell.samples - cell.realSamples} fictifs) annoncés ~${Math.round(cell.meanPredicted * 100)} %, ` +
          `${Math.round(observed * 100)} % sont passés.`,
      };
    }
  }
  if (!expertise || expertise.samples < MIN_OUTCOMES_PER_MARKET || expertise.calibrationFactor === 1) {
    return { prob, evidence };
  }

  const corrected = Math.min(0.99, Math.max(0.01, prob * expertise.calibrationFactor));
  return {
    prob: corrected,
    evidence:
      `${evidence} Corrigé ×${expertise.calibrationFactor.toFixed(2)} par l'expérience de l'app sur ce marché : ` +
      `${(expertise.meanPredicted * 100).toFixed(0)}% annoncés en moyenne pour ${(expertise.hitRate * 100).toFixed(0)}% réalisés ` +
      `sur ${expertise.samples} prédictions déjà vérifiées.`,
  };
}

/**
 * Récupère dans le corpus d'expertise les jambes déjà réglées qui n'y figurent
 * pas encore. Utile pour tout ce qui a été proposé et réglé AVANT que
 * dailyReview n'écrive ces résultats (les propositions gardaient alors leur
 * verdict pour elles seules), et comme filet si une écriture a échoué.
 * Idempotent : une jambe déjà enregistrée n'est jamais recomptée.
 */
function backfillOutcomesFromProposals(): number {
  const known = new Set(
    readPredictionOutcomes(30).map((o) => `${o.fixtureId}-${o.kind}-${o.market}-${o.selection}`)
  );

  const missing: PredictionOutcome[] = [];
  for (const proposal of readInPlayProposals()) {
    for (const leg of proposal.legs) {
      if (!leg.settled || leg.won == null) continue;
      const key = `${leg.fixtureId}-${proposal.kind}-${leg.market}-${leg.selection}`;
      if (known.has(key)) continue;
      known.add(key);
      missing.push({
        ts: proposal.createdAt,
        fixtureId: leg.fixtureId,
        league: leg.league,
        market: leg.market,
        selection: leg.selection,
        predictedProb: leg.prob,
        won: leg.won,
        kind: proposal.kind,
        minute: proposal.minute,
        real: proposal.real !== false,
      });
    }
  }

  if (missing.length > 0) appendPredictionOutcomes(missing);
  return missing.length;
}

/**
 * Consolidation complète : règles, paris papier, recalibrage, expertise par
 * marché, digest. Appelée à la fin de chaque tour de fond.
 */
export async function consolidateLearning(): Promise<LearnedModel | null> {
  backfillOutcomesFromProposals();

  const rows = readTrainingRows(14);
  const marketExpertise = computeMarketExpertise(readPredictionOutcomes(30));

  // L'expertise par marché vient d'un corpus distinct (résultats mesurés) et
  // ne dépend pas du volume d'instantanés de marqueurs : on la met à jour même
  // quand celui-ci est encore trop maigre pour bâtir des règles.
  if (rows.length < MIN_SAMPLES_PER_RULE) {
    const existing = readLearnedModel();
    if (!existing) return null;
    const updated = { ...existing, marketExpertise };
    writeLearnedModel(updated);
    return updated;
  }

  const omnirouteTrust = computeOmnirouteTrust(readCrossCheckSamples(14));
  const { rules, baselines } = buildRules(rows, omnirouteTrust.trusted);

  const bets = settlePaperBets(rows);
  const settled = bets.filter((b) => b.settled);
  const won = settled.filter((b) => b.won).length;
  const hitRate = settled.length > 0 ? won / settled.length : 0;
  const meanPredicted =
    settled.length > 0 ? settled.reduce((sum, b) => sum + b.modelProb, 0) / settled.length : 0;

  // Recalibrage : si le modèle annonce 40% et réalise 30%, on rabote d'autant.
  // Borné pour éviter qu'une série de malchance n'effondre le modèle.
  const rawFactor = meanPredicted > 0 && settled.length >= 20 ? hitRate / meanPredicted : 1;
  const calibrationFactor = Math.min(1.5, Math.max(0.5, rawFactor));

  const focus = await getUserFocus();

  const model: LearnedModel = {
    updatedAt: new Date().toISOString(),
    totalRows: rows.length,
    baselines,
    markerRules: rules,
    paperBets: {
      total: bets.length,
      settled: settled.length,
      won,
      hitRate,
      calibrationFactor,
    },
    focusLeagues: focus.leagues,
    omnirouteTrust,
    marketExpertise,
  };

  writeLearnedModel(model);
  writeAgentDigest(renderDigest(model, focus.markets, rows));

  // Instantané quotidien du taux de réussite cumulé — pour répondre
  // directement à "quel est le taux d'erreur actuel, et son évolution depuis
  // hier" sans dépendre du règlement des scores finaux (dailyReview.ts),
  // plus fragile. Écrit à chaque tour : le dernier du jour remplace les
  // précédents (voir recordAccuracySnapshot), donc toujours à jour.
  if (settled.length > 0) {
    recordAccuracySnapshot({ date: todayLocalDateString(), hitRate, total: settled.length, won });
  }

  return model;
}

export interface AccuracyTrend {
  /** Taux d'erreur actuel (100 - taux de réussite), en pourcentage. */
  errorRatePercent: number;
  /** Taux de réussite actuel, en pourcentage — pour affichage complémentaire. */
  hitRatePercent: number;
  /** Nombre de paris papier réglés derrière ce taux (plus c'est haut, plus
   * c'est fiable). */
  sampleSize: number;
  /** Évolution du taux de réussite en POINTS de pourcentage depuis hier
   * (positif = amélioration), ou null si aucun instantané n'existe pour
   * hier précisément (app pas utilisée ce jour-là, ou tout premier jour). */
  evolutionVsYesterdayPoints: number | null;
}

/**
 * Réponse directe à "quel est le taux d'erreur actuel, et son évolution
 * depuis hier" — construite sur les instantanés quotidiens du taux de
 * réussite cumulé (voir recordAccuracySnapshot), jamais sur les courbes par
 * marché (MarketDayPoint), qui dépendent du règlement des scores finaux par
 * Omniroute (dailyReview.ts) et peuvent rester vides plus longtemps.
 */
export function getAccuracyTrend(): AccuracyTrend | null {
  const snapshots = readAccuracySnapshots();
  if (snapshots.length === 0) return null;

  const latest = snapshots[snapshots.length - 1];
  const yesterday = todayLocalDateString(new Date(Date.now() - 24 * 3_600_000));
  const yesterdaySnapshot = snapshots.find((s) => s.date === yesterday);

  return {
    errorRatePercent: (1 - latest.hitRate) * 100,
    hitRatePercent: latest.hitRate * 100,
    sampleSize: latest.total,
    evolutionVsYesterdayPoints: yesterdaySnapshot
      ? (latest.hitRate - yesterdaySnapshot.hitRate) * 100
      : null,
  };
}

function renderDigest(model: LearnedModel, markets: string[], rows: TrainingRow[]): string {
  const leaguesCovered = new Set(rows.map((r) => r.league)).size;
  const countriesCovered = new Set(rows.map((r) => r.country)).size;

  const lines: string[] = [
    "# Mémoire d'auto-apprentissage — marqueurs observés en direct",
    '',
    `Mis à jour : ${model.updatedAt}`,
    `Corpus : ${model.totalRows} observations sur ${leaguesCovered} ligues / ${countriesCovered} pays.`,
    '',
    '## Taux de base observés (par fenêtre)',
  ];

  for (const [key, rate] of Object.entries(model.baselines)) {
    lines.push(`- \`${key}\` : ${(rate * 100).toFixed(1)}%`);
  }

  lines.push('', '## Marqueurs les plus informatifs');

  if (model.markerRules.length === 0) {
    lines.push("Aucune règle ne dépasse encore le seuil d'échantillon : corpus trop jeune.");
  } else {
    for (const horizon of LEARNING_HORIZONS) {
      const forHorizon = model.markerRules.filter((r) => r.horizon === horizon).slice(0, 8);
      if (forHorizon.length === 0) continue;

      lines.push('', `### Fenêtre ${horizon} minutes`);
      for (const rule of forHorizon) {
        lines.push(
          `- \`${rule.marker}\` → \`${rule.target}\` : **${(rule.hitRate * 100).toFixed(1)}%** ` +
            `(×${rule.lift.toFixed(2)} vs base ${(rule.baseline * 100).toFixed(1)}%, n=${rule.samples})`
        );
      }
    }
  }

  lines.push(
    '',
    '## Fiabilité mesurée du modèle (paris papier, aucun argent engagé)',
    `- Paris simulés réglés : ${model.paperBets.settled} / ${model.paperBets.total}`,
    `- Taux de réussite réel : ${(model.paperBets.hitRate * 100).toFixed(1)}%`,
    `- Facteur de recalibrage appliqué : ×${model.paperBets.calibrationFactor.toFixed(2)} ` +
      '(<1 = le modèle était trop optimiste, ses probabilités sont rabotées)',
  );

  if (model.omnirouteTrust) {
    const t = model.omnirouteTrust;
    lines.push(
      '',
      '## Couverture élargie via Omniroute (matchs au-delà du quota API-Football)',
      `- Recoupements avec la vérité terrain API-Football : ${t.samples} (accord : ${(t.agreeRate * 100).toFixed(1)}%)`,
      t.trusted
        ? '- Seuil de fiabilité atteint : les observations Omniroute participent désormais aussi aux règles de calibrage.'
        : `- Pas encore assez fiable (seuil : ${CROSSCHECK_MIN_SAMPLES} recoupements, ${(CROSSCHECK_MIN_AGREE_RATE * 100).toFixed(0)}% d'accord) — Omniroute élargit la couverture observée mais n'influence pas encore les probabilités.`
    );
  }

  const checkpointCalibration = computeCheckpointCalibration(30);
  lines.push('', '## Fiabilité passée du scan en direct 20e/60e minute (par marché, 30 derniers jours, réel + fictif confondus)');
  if (checkpointCalibration.length === 0) {
    lines.push("Pas encore assez de scans réglés pour juger.");
  } else {
    for (const stat of checkpointCalibration) {
      lines.push(
        `- \`${marketLabel(stat.market)}\` : réalisé **${(stat.hitRate * 100).toFixed(1)}%** ` +
          `vs annoncé ${(stat.meanPredicted * 100).toFixed(1)}% (n=${stat.samples})` +
          (stat.hitRate < stat.meanPredicted - 0.1 ? ' — trop confiant sur ce marché, à corriger.' : '')
      );
    }
  }

  const scoutingAccuracy = computeScoutingAccuracy(30);
  lines.push('', '## Fiabilité passée de l\'analyse Scouting IA (par marché, 30 derniers jours)');
  if (scoutingAccuracy.length === 0) {
    lines.push("Pas encore assez d'analyses réglées (le match doit être terminé) pour juger.");
  } else {
    for (const stat of scoutingAccuracy) {
      lines.push(
        `- \`${stat.market}\` : réalisé **${(stat.hitRate * 100).toFixed(1)}%** ` +
          `vs annoncé ${(stat.meanPredicted * 100).toFixed(1)}% (n=${stat.samples})` +
          (stat.hitRate < stat.meanPredicted - 0.1 ? ' — l\'IA est trop confiante sur ce marché, à corriger.' : '')
      );
    }
  }

  lines.push('',
    "## Périmètre de jeu de l'utilisateur",
    `- Ligues jouées : ${model.focusLeagues.join(', ') || 'non renseigné'}`,
    `- Marchés joués : ${markets.join(', ') || 'non renseigné'}`,
    '',
    '## Consigne aux agents',
    'Ces taux sont empiriques (comptés, pas estimés). Utilise-les comme prior sur les marchés buts, corners et cartons en cours de match.',
    "Si ton intuition s'écarte fortement d'un taux observé sur gros échantillon, baisse ta confiance.",
    "N'extrapole jamais une règle dont l'échantillon (n) est faible.",
  );

  return lines.join('\n');
}

/**
 * Digest prêt à injecter dans le prompt des agents (null tant qu'aucune règle
 * n'a émergé). Lit le fichier déjà rendu : pas de recalcul sur le fil d'UI.
 */
export function getAgentLearningDigest(): string | null {
  const model = readLearnedModel();
  if (!model || model.markerRules.length === 0) return null;
  return readAgentDigest();
}

/** En dessous, un écart annoncé/réalisé sur un marché est du hasard, pas une leçon. */
const REPORT_MIN_SAMPLES = 10;
/** Écart annoncé/réalisé (en part de 1) à partir duquel on parle d'erreur de jugement. */
const REPORT_GAP = 0.1;
/** Même seuil que le recalibrage global dans consolidateLearning. */
const GLOBAL_RECALIBRATION_MIN_SETTLED = 20;

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function targetLabel(targetKey: string): string {
  return LEARNING_TARGETS.find((t) => t.key === targetKey)?.label ?? targetKey;
}

function describeRule(rule: MarkerRule): string {
  const [name, threshold] = rule.marker.split('>=');
  const condition =
    name === 'minute'
      ? `à partir de la ${threshold}e minute`
      : `quand ${MARKER_CANDIDATES.find((c) => c.name === name)?.label ?? name} ≥ ${threshold}`;
  return (
    `${condition}, il y a ${targetLabel(rule.target)} dans les ${rule.horizon} minutes suivantes ` +
    `dans ${pct(rule.hitRate)} des cas, contre ${pct(rule.baseline)} en temps normal ` +
    `(${rule.samples} observations)`
  );
}

interface BetGroupStats {
  n: number;
  won: number;
  meanPredicted: number;
  hitRate: number;
}

function groupBets(bets: PaperBet[], keyOf: (bet: PaperBet) => string): Map<string, BetGroupStats> {
  const raw = new Map<string, { n: number; won: number; predictedSum: number }>();
  for (const bet of bets) {
    const key = keyOf(bet);
    const entry = raw.get(key) ?? { n: 0, won: 0, predictedSum: 0 };
    entry.n += 1;
    entry.predictedSum += bet.modelProb;
    if (bet.won) entry.won += 1;
    raw.set(key, entry);
  }
  const stats = new Map<string, BetGroupStats>();
  for (const [key, e] of raw) {
    stats.set(key, { n: e.n, won: e.won, meanPredicted: e.predictedSum / e.n, hitRate: e.won / e.n });
  }
  return stats;
}

/**
 * Rapport RÉDIGÉ de ce que la boucle fictive a appris et corrigé, construit
 * uniquement à partir des données réellement mesurées (aucun texte généré
 * par IA, rien d'inventé) : bilan, leçons tirées des paris ratés, corrections
 * effectivement appliquées aux prochaines probabilités, règles surveillées.
 */
export function buildLearningReport(): string | null {
  const model = readLearnedModel();
  const bets = readPaperBets().filter((b) => b.settled && b.won != null);
  if (!model && bets.length === 0) return null;

  const lines: string[] = ["📝 Rapport écrit — ce que l'app a appris de ses paris fictifs", ''];

  lines.push('1) Bilan');
  if (bets.length === 0) {
    lines.push("Aucun pari fictif réglé pour l'instant : rien à analyser encore.");
  } else {
    const won = bets.filter((b) => b.won).length;
    lines.push(
      `${bets.length} paris fictifs réglés : ${won} réussis, ${bets.length - won} ratés ` +
        `(${pct(won / bets.length)} de réussite).`
    );
    const evolution = getAccuracyTrend()?.evolutionVsYesterdayPoints;
    if (evolution != null) {
      lines.push(
        Math.abs(evolution) < 0.5
          ? 'Stable par rapport à hier.'
          : evolution > 0
            ? `En progrès de ${evolution.toFixed(1)} points par rapport à hier.`
            : `En recul de ${Math.abs(evolution).toFixed(1)} points par rapport à hier.`
      );
    }
  }

  lines.push('', '2) Leçons tirées des ratés');
  if (bets.length === 0) {
    lines.push('Rien à analyser tant que des paris ne sont pas réglés.');
  } else {
    const byMarket = [...groupBets(bets, (b) => marketForTarget(b.target)).entries()].sort(
      (a, b) => b[1].n - a[1].n
    );
    for (const [market, s] of byMarket) {
      const label = marketLabel(market as TrackedMarket);
      if (s.n < REPORT_MIN_SAMPLES) {
        lines.push(`• ${label} : ${s.n} paris seulement, trop tôt pour en tirer une leçon.`);
      } else if (s.meanPredicted - s.hitRate >= REPORT_GAP) {
        lines.push(
          `• ${label} : j'annonçais ${pct(s.meanPredicted)} en moyenne, il n'en est passé que ` +
            `${pct(s.hitRate)} (${s.n - s.won} ratés sur ${s.n}). J'étais trop optimiste sur ce marché.`
        );
      } else if (s.hitRate - s.meanPredicted >= REPORT_GAP) {
        lines.push(
          `• ${label} : j'annonçais ${pct(s.meanPredicted)}, il en est passé ${pct(s.hitRate)} ` +
            `(${s.won}/${s.n}). J'étais trop prudent : je sous-estimais ce marché.`
        );
      } else {
        lines.push(
          `• ${label} : annonces fiables, ${pct(s.meanPredicted)} annoncés pour ${pct(s.hitRate)} ` +
            `réalisés (${s.won}/${s.n}).`
        );
      }
    }

    const byPattern = [...groupBets(bets, (b) => `${b.target}@${b.horizon}`).entries()].filter(
      ([, s]) => s.n >= 5
    );
    const worst = byPattern
      .filter(([, s]) => s.meanPredicted - s.hitRate >= REPORT_GAP)
      .sort((a, b) => b[1].meanPredicted - b[1].hitRate - (a[1].meanPredicted - a[1].hitRate))[0];
    if (worst) {
      const [target, horizon] = worst[0].split('@');
      lines.push(
        `Le pari qui rate le plus : « ${targetLabel(target)} dans les ${horizon} minutes » — ` +
          `${worst[1].n - worst[1].won} ratés sur ${worst[1].n} alors que j'annonçais ${pct(worst[1].meanPredicted)}.`
      );
    }
    const best = byPattern.sort((a, b) => b[1].hitRate - a[1].hitRate)[0];
    if (best) {
      const [target, horizon] = best[0].split('@');
      lines.push(
        `Le plus fiable : « ${targetLabel(target)} dans les ${horizon} minutes » — ` +
          `${best[1].won}/${best[1].n} réussis.`
      );
    }
  }

  lines.push('', '3) Corrections appliquées aux prochaines prédictions');
  if (!model) {
    lines.push("Le modèle n'a pas encore été consolidé : aucune correction possible pour l'instant.");
  } else {
    const { settled, calibrationFactor: factor } = model.paperBets;
    if (settled < GLOBAL_RECALIBRATION_MIN_SETTLED) {
      lines.push(
        `Recalibrage global pas encore actif : il faut au moins ${GLOBAL_RECALIBRATION_MIN_SETTLED} paris ` +
          `réglés pour corriger sans réagir au hasard (${settled} actuellement).`
      );
    } else if (Math.abs(factor - 1) < 0.01) {
      lines.push(
        'Aucune correction globale nécessaire : mes probabilités annoncées correspondent à ce qui se réalise.'
      );
    } else if (factor < 1) {
      lines.push(
        `Toutes les probabilités tirées des marqueurs en direct sont désormais multipliées par ` +
          `×${factor.toFixed(2)} (${Math.round((1 - factor) * 100)}% de moins), parce que j'annonçais ` +
          'en moyenne plus que ce qui se réalisait.'
      );
    } else {
      lines.push(
        `Toutes les probabilités tirées des marqueurs en direct sont désormais multipliées par ` +
          `×${factor.toFixed(2)} (+${Math.round((factor - 1) * 100)}%), parce que j'étais trop prudent.`
      );
    }

    const expertise = model.marketExpertise ?? [];
    const active = expertise.filter(
      (e) => e.samples >= MIN_OUTCOMES_PER_MARKET && Math.abs(e.calibrationFactor - 1) >= 0.01
    );
    if (active.length > 0) {
      for (const e of active) {
        lines.push(
          `• ${marketLabel(e.market)} : chaque nouvelle prédiction est corrigée ×${e.calibrationFactor.toFixed(2)} ` +
            `(${pct(e.meanPredicted)} annoncés pour ${pct(e.hitRate)} réalisés sur ${e.samples} résultats vérifiés).`
        );
      }
    } else {
      const mostAdvanced = [...expertise].sort((a, b) => b.samples - a.samples)[0];
      lines.push(
        `Correction marché par marché (1X2, total de buts, BTTS…) : pas encore active, il faut ` +
          `${MIN_OUTCOMES_PER_MARKET} résultats de match vérifiés par marché` +
          (mostAdvanced
            ? ` (le plus avancé : ${marketLabel(mostAdvanced.market)}, ${mostAdvanced.samples}/${MIN_OUTCOMES_PER_MARKET}).`
            : '.')
      );
    }
  }

  lines.push('', '4) Ce que je surveille désormais en match');
  if (!model || model.markerRules.length === 0) {
    lines.push(
      `Aucune règle fiable encore : il faut au moins ${MIN_SAMPLES_PER_RULE} observations d'une même situation.`
    );
  } else {
    for (const rule of model.markerRules.slice(0, 5)) {
      const text = describeRule(rule);
      lines.push(`• ${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
    }
    lines.push(
      "Ces règles sont recalculées à chaque tour sur les 14 derniers jours : une règle qui cesse de se " +
        "vérifier disparaît d'elle-même."
    );
  }

  lines.push('', '5) Stratégies « SI… ALORS »');
  for (const r of getStrategyRecords()) {
    lines.push(
      r.settled === 0
        ? `• ${r.name} : pas encore de pari réglé.`
        : `• ${r.name} : ${r.won}/${r.settled} réussis (${pct(r.hitRate)}) pour ${pct(r.meanPredicted)} annoncés` +
            (r.suspended ? ' — SUSPENDUE (annonce nettement plus qu\'elle ne réussit).' : '.')
    );
  }

  lines.push('', '6) Écarts entre mes projections et la réalité');
  const shadow = getShadowStats();
  lines.push(
    `Mesurés sur tous les matchs suivis en direct, pari ou pas : ${shadow.measured} projections comparées au résultat réel, ${shadow.pending} en attente du score.`
  );
  const deltas = getAllDeltaCorrections().filter((d) => d.samples > 0);
  if (deltas.length === 0) {
    lines.push("Pas encore de match réglé avec une projection chiffrée : l'écart sera mesuré dès les premiers résultats.");
  } else {
    for (const d of deltas) {
      const sign = d.meanDelta >= 0 ? '+' : '';
      const verdict =
        d.samples < 5
          ? 'trop tôt pour corriger'
          : Math.abs(d.factor - 1) < 0.05
            ? 'projections justes, aucune correction'
            : d.factor > 1
              ? `je sous-estimais : le reste à jouer est désormais multiplié par ×${d.factor.toFixed(2)}`
              : `je surestimais : le reste à jouer est désormais multiplié par ×${d.factor.toFixed(2)}`;
      lines.push(
        `• ${DELTA_LABELS[d.unit]} : écart moyen réel − projeté ${sign}${d.meanDelta.toFixed(1)} ` +
          `(écart absolu ${d.meanAbsDelta.toFixed(1)}) sur ${d.samples} matchs — ${verdict}.`
      );
    }
  }

  return lines.join('\n');
}
