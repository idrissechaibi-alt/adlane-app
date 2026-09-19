// Boucle d'auto-apprentissage silencieuse.
//
// 1. Consolide le corpus étiqueté (liveMarkers) en règles simples et lisibles :
//    "quand X marqueurs sont réunis avant la 45e, un but tombe dans les 10
//    minutes dans Y% des cas, soit Z fois le taux de base".
// 2. Fait des paris papier en avance de phase (jamais d'argent, jamais de
//    notification) et les règle quand la vérité terrain arrive -> taux de
//    réussite réel et facteur de recalibrage.
// 3. Produit un digest court, injecté aux agents IA pour qu'ils s'appuient sur
//    ce qui a été observé plutôt que sur leur intuition.
//
// Rien ici n'invente de données : une règle sans échantillon suffisant est
// écartée, et le digest affiche toujours la taille d'échantillon.

import { getAllBets } from '../database/storage';
import { HISTORICAL_BETS } from '../data/historical';
import {
  LearnedModel,
  MarkerSnapshot,
  PaperBet,
  TrainingRow,
  readAgentDigest,
  readLearnedModel,
  readPaperBets,
  readTrainingRows,
  writeAgentDigest,
  writeLearnedModel,
  writePaperBets,
} from './learnStore';

/** Échantillon minimum pour qu'une règle soit retenue (anti-bruit). */
const MIN_SAMPLES_PER_RULE = 30;
/** Écart minimum au taux de base pour qu'une règle soit jugée informative. */
const MIN_LIFT = 1.15;
/** Seuil de déclenchement d'un pari papier. */
const PAPER_BET_PROB_THRESHOLD = 0.35;

interface MarkerCandidate {
  name: string;
  label: string;
  value: (row: TrainingRow) => number | undefined;
  thresholds: number[];
}

/**
 * Marqueurs testés. On agrège domicile + extérieur : ce qui précède un but,
 * c'est le volume de jeu dangereux TOTAL, peu importe quelle équipe le produit.
 */
const MARKER_CANDIDATES: MarkerCandidate[] = [
  {
    name: 'shots_on_target_total',
    label: 'tirs cadrés cumulés',
    value: (r) => sumDefined(r.markers.shotsOnTargetHome, r.markers.shotsOnTargetAway),
    thresholds: [2, 3, 4, 5],
  },
  {
    name: 'shots_total',
    label: 'tirs totaux cumulés',
    value: (r) => sumDefined(r.markers.shotsTotalHome, r.markers.shotsTotalAway),
    thresholds: [6, 9, 12],
  },
  {
    name: 'corners_total',
    label: 'corners cumulés',
    value: (r) => sumDefined(r.markers.cornersHome, r.markers.cornersAway),
    thresholds: [3, 5, 7],
  },
  {
    name: 'possession_imbalance',
    label: 'déséquilibre de possession (écart à 50%)',
    value: (r) =>
      r.markers.possessionHome == null ? undefined : Math.abs(r.markers.possessionHome - 50),
    thresholds: [10, 15, 20],
  },
  {
    name: 'minute',
    label: 'minute de jeu atteinte',
    value: (r) => r.minute,
    thresholds: [20, 30, 35],
  },
];

function sumDefined(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/** Ligues et marchés sur lesquels l'utilisateur joue réellement. */
async function getUserFocus(): Promise<{ leagues: string[]; markets: string[] }> {
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

function buildRules(rows: TrainingRow[], baseline: number): LearnedModel['markerRules'] {
  const rules: LearnedModel['markerRules'] = [];

  for (const candidate of MARKER_CANDIDATES) {
    for (const threshold of candidate.thresholds) {
      const matching = rows.filter((r) => {
        const value = candidate.value(r);
        return value != null && value >= threshold;
      });

      if (matching.length < MIN_SAMPLES_PER_RULE) continue;

      const goals = matching.filter((r) => r.label_goal_next_10 === 1).length;
      const goalRate = goals / matching.length;
      const lift = baseline > 0 ? goalRate / baseline : 1;

      if (lift < MIN_LIFT) continue;

      rules.push({
        marker: `${candidate.name}>=${threshold}`,
        threshold,
        samples: matching.length,
        goalRate,
        lift,
      });
    }
  }

  return rules.sort((a, b) => b.lift - a.lift).slice(0, 12);
}

/**
 * Probabilité estimée par le modèle appris pour un instantané donné :
 * on prend la règle déclenchée la plus informative, recalibrée par le bilan
 * réel des paris papier. Renvoie null si aucune règle ne s'applique.
 */
export function scoreSnapshot(snapshot: MarkerSnapshot, model: LearnedModel | null): number | null {
  if (!model || model.markerRules.length === 0) return null;

  const asRow = { ...snapshot, label_goal_next_10: 0, labelledAt: '' } as TrainingRow;
  let best: number | null = null;

  for (const rule of model.markerRules) {
    const [name, thresholdRaw] = rule.marker.split('>=');
    const candidate = MARKER_CANDIDATES.find((c) => c.name === name);
    if (!candidate) continue;

    const value = candidate.value(asRow);
    if (value == null || value < Number(thresholdRaw)) continue;

    const calibrated = rule.goalRate * model.paperBets.calibrationFactor;
    if (best == null || calibrated > best) best = calibrated;
  }

  return best;
}

/** Enregistre un pari papier si le modèle déclenche (aucune notification). */
export function maybePlacePaperBets(snapshots: MarkerSnapshot[], model: LearnedModel | null): void {
  if (!model) return;

  const existing = readPaperBets();
  const known = new Set(existing.map((b) => `${b.fixtureId}-${b.minuteAtPlacement}`));
  const added: PaperBet[] = [];

  for (const snapshot of snapshots) {
    const prob = scoreSnapshot(snapshot, model);
    if (prob == null || prob < PAPER_BET_PROB_THRESHOLD) continue;

    const key = `${snapshot.fixtureId}-${snapshot.minute}`;
    if (known.has(key)) continue;

    added.push({
      id: `paper-${snapshot.fixtureId}-${snapshot.minute}-${Date.now()}`,
      placedAt: snapshot.ts,
      fixtureId: snapshot.fixtureId,
      league: snapshot.league,
      country: snapshot.country,
      market: 'but_1ere_mi_temps_10min',
      selection: 'But dans les 10 prochaines minutes',
      modelProb: prob,
      minuteAtPlacement: snapshot.minute,
      settled: false,
    });
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
    if (!row) continue;

    bet.settled = true;
    bet.won = row.label_goal_next_10 === 1;
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

  const baseline = rows.filter((r) => r.label_goal_next_10 === 1).length / rows.length;
  const markerRules = buildRules(rows, baseline);

  const bets = settlePaperBets(rows);
  const settled = bets.filter((b) => b.settled);
  const won = settled.filter((b) => b.won).length;
  const hitRate = settled.length > 0 ? won / settled.length : 0;
  const meanPredicted =
    settled.length > 0
      ? settled.reduce((sum, b) => sum + b.modelProb, 0) / settled.length
      : 0;

  // Recalibrage : si le modèle annonce 40% et réalise 30%, on rabote d'autant.
  // Borné pour éviter qu'une série de malchance n'effondre le modèle.
  const rawFactor = meanPredicted > 0 && settled.length >= 20 ? hitRate / meanPredicted : 1;
  const calibrationFactor = Math.min(1.5, Math.max(0.5, rawFactor));

  const focus = await getUserFocus();

  const model: LearnedModel = {
    updatedAt: new Date().toISOString(),
    totalRows: rows.length,
    baselineGoalRate: baseline,
    markerRules,
    paperBets: {
      total: bets.length,
      settled: settled.length,
      won,
      hitRate,
      calibrationFactor,
    },
    focusLeagues: focus.leagues,
  };

  writeLearnedModel(model);
  writeAgentDigest(renderDigest(model, focus.markets, rows));
  return model;
}

function renderDigest(model: LearnedModel, markets: string[], rows: TrainingRow[]): string {
  const leaguesCovered = new Set(rows.map((r) => r.league)).size;
  const countriesCovered = new Set(rows.map((r) => r.country)).size;

  const lines: string[] = [
    '# Mémoire d\'auto-apprentissage — marqueurs avant but (1ère mi-temps)',
    '',
    `Mis à jour : ${model.updatedAt}`,
    `Corpus : ${model.totalRows} observations étiquetées sur ${leaguesCovered} ligues / ${countriesCovered} pays.`,
    `Taux de base observé : ${(model.baselineGoalRate * 100).toFixed(1)}% de chance qu'un but tombe dans les 10 minutes suivant une observation quelconque de 1ère mi-temps.`,
    '',
    '## Marqueurs les plus informatifs',
  ];

  if (model.markerRules.length === 0) {
    lines.push("Aucune règle ne dépasse encore le seuil d'échantillon : corpus trop jeune.");
  } else {
    for (const rule of model.markerRules) {
      lines.push(
        `- \`${rule.marker}\` → but dans les 10 min : **${(rule.goalRate * 100).toFixed(1)}%** ` +
          `(×${rule.lift.toFixed(2)} vs base, n=${rule.samples})`
      );
    }
  }

  lines.push(
    '',
    '## Fiabilité mesurée du modèle (paris papier, aucun argent engagé)',
    `- Paris simulés réglés : ${model.paperBets.settled} / ${model.paperBets.total}`,
    `- Taux de réussite réel : ${(model.paperBets.hitRate * 100).toFixed(1)}%`,
    `- Facteur de recalibrage appliqué : ×${model.paperBets.calibrationFactor.toFixed(2)} ` +
      `(<1 = le modèle était trop optimiste, ses probabilités sont rabotées)`,
    '',
    '## Périmètre de jeu de l\'utilisateur',
    `- Ligues jouées : ${model.focusLeagues.join(', ') || 'non renseigné'}`,
    `- Marchés joués : ${markets.join(', ') || 'non renseigné'}`,
    '',
    '## Consigne aux agents',
    "Utilise ces taux observés comme prior quand tu évalues un marché lié aux buts de 1ère mi-temps.",
    "Les probabilités affichées ci-dessus sont empiriques (comptées, pas estimées) : si ton intuition s'en écarte fortement, baisse ta confiance.",
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
