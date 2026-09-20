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

import { getAllBets } from '../database/storage';
import { HISTORICAL_BETS } from '../data/historical';
import {
  CrossCheckSample,
  EventDeltas,
  LEARNING_HORIZONS,
  LearnedModel,
  MarkerRule,
  MarkerSnapshot,
  PaperBet,
  TrackedMarket,
  TrainingRow,
  marketLabel,
  readAgentDigest,
  readCrossCheckSamples,
  readLearnedModel,
  readMarketSeries,
  readPaperBets,
  readTrainingRows,
  writeAgentDigest,
  writeLearnedModel,
  writePaperBets,
} from './learnStore';
import { computeScoutingAccuracy } from './scoutingReview';

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
        if (scored.prob < PAPER_BET_PROB_THRESHOLD) continue;

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

/**
 * Consolidation complète : règles, paris papier, recalibrage, digest.
 * Appelée à la fin de chaque tour de fond.
 */
export async function consolidateLearning(): Promise<LearnedModel | null> {
  const rows = readTrainingRows(14);
  if (rows.length < MIN_SAMPLES_PER_RULE) return readLearnedModel();

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
  };

  writeLearnedModel(model);
  writeAgentDigest(renderDigest(model, focus.markets, rows));
  return model;
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
