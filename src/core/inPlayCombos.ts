// Combos en cours de match — la direction que tu veux prendre :
//
//   - À la 20e minute : combo portant sur les 25 minutes suivantes (jusqu'à
//     la pause). Construit UNIQUEMENT à partir des règles apprises en direct
//     (buts, corners, cartons), donc jamais avant d'avoir un corpus réel.
//   - À la mi-temps : combo portant sur la suite du match (géré par
//     halftimeMonitor, qui re-projette le résultat final avec le score acquis).
//
// Aucune proposition n'est émise si le modèle n'a pas de règle applicable :
// mieux vaut se taire que de sortir un combo fondé sur rien.

import { scoreAllTargets } from './autoLearn';
import { getFocusNote, renderFocusNote } from './focusEnrichment';
import {
  InPlayProposal,
  LearnedModel,
  PendingObservation,
  readInPlayProposals,
  readLearnedModel,
  readPendingSnapshots,
  writeInPlayProposals,
} from './learnStore';
import { sendLocalNotification } from './notifications';

/** Fenêtre de décision autour de la 20e minute. */
const DECISION_MINUTE_MIN = 18;
const DECISION_MINUTE_MAX = 24;
/** Horizon couvert par le combo : les 25 minutes suivantes. */
const COMBO_HORIZON = 25;
/** Probabilité minimale pour qu'une jambe entre dans le combo. */
const MIN_LEG_PROB = 0.55;
/** Probabilité combinée minimale pour notifier. */
const MIN_COMBINED_PROB = 0.35;
/** Nombre maximum de jambes (au-delà, la combinaison devient illisible). */
const MAX_LEGS = 3;

function scoreLabel(obs: PendingObservation): string {
  return `${obs.goalsHome}-${obs.goalsAway}`;
}

/**
 * Construit un combo pour un match donné à partir des cibles déclenchées.
 * Les jambes sont indépendantes au sens du modèle : la probabilité combinée
 * est le produit, ce qui reste une approximation prudente (les événements
 * d'un même match sont en réalité corrélés positivement).
 */
function buildComboForObservation(
  obs: PendingObservation,
  model: LearnedModel
): InPlayProposal | null {
  const eligible = scoreAllTargets(obs, model, COMBO_HORIZON).filter((s) => s.prob >= MIN_LEG_PROB);

  // Une seule jambe par famille d'événement : "corners>=2" et "corners>=3"
  // ne sont pas deux paris indépendants (le second implique le premier), les
  // multiplier n'aurait aucun sens. On garde le seuil le plus exigeant parmi
  // ceux qui passent, c'est-à-dire l'information la plus forte.
  const bestPerFamily = new Map<string, (typeof eligible)[number]>();
  for (const candidate of eligible) {
    const family = candidate.target.split('>=')[0];
    const threshold = Number(candidate.target.split('>=')[1]);
    const current = bestPerFamily.get(family);
    const currentThreshold = current ? Number(current.target.split('>=')[1]) : -Infinity;
    if (!current || threshold > currentThreshold) bestPerFamily.set(family, candidate);
  }

  const scored = Array.from(bestPerFamily.values())
    .sort((a, b) => b.prob - a.prob)
    .slice(0, MAX_LEGS);

  if (scored.length < 2) return null; // un combo, pas un pari sec

  const combinedProb = scored.reduce((product, leg) => product * leg.prob, 1);
  if (combinedProb < MIN_COMBINED_PROB) return null;

  return {
    id: `inplay-${obs.fixtureId}-${obs.minute}`,
    kind: 'minute20',
    createdAt: new Date().toISOString(),
    fixtureId: obs.fixtureId,
    league: obs.league,
    homeTeam: obs.homeTeam,
    awayTeam: obs.awayTeam,
    minute: obs.minute,
    scoreLabel: scoreLabel(obs),
    window: `${obs.minute}e → ${obs.minute + COMBO_HORIZON}e minute`,
    legs: scored.map((leg) => ({
      selection: `${leg.label} d'ici la ${obs.minute + COMBO_HORIZON}e`,
      prob: leg.prob,
      evidence: `${leg.rule.marker} → ${(leg.rule.hitRate * 100).toFixed(0)}% observé ` +
        `(×${leg.rule.lift.toFixed(2)}, n=${leg.rule.samples})`,
    })),
    combinedProb,
  };
}

/**
 * Tour de génération. Utilise les instantanés déjà relevés par liveMarkers
 * (aucune requête réseau supplémentaire) et notifie une seule fois par match.
 */
export async function runInPlayComboTick(): Promise<number> {
  const model = readLearnedModel();
  if (!model || model.markerRules.length === 0) return 0;

  const existing = readInPlayProposals();
  const alreadyProposed = new Set(existing.map((p) => `${p.fixtureId}-${p.kind}`));

  const candidates = readPendingSnapshots().filter(
    (obs) => obs.minute >= DECISION_MINUTE_MIN && obs.minute <= DECISION_MINUTE_MAX
  );

  const fresh: InPlayProposal[] = [];

  for (const obs of candidates) {
    if (alreadyProposed.has(`${obs.fixtureId}-minute20`)) continue;

    const proposal = buildComboForObservation(obs, model);
    if (!proposal) continue;

    alreadyProposed.add(`${obs.fixtureId}-minute20`);
    fresh.push(proposal);

    const context = renderFocusNote(getFocusNote(obs.fixtureId));
    const legsText = proposal.legs
      .map((leg) => `• ${leg.selection} (${(leg.prob * 100).toFixed(0)}%)`)
      .join('\n');

    await sendLocalNotification(
      `⚡ ${obs.minute}e — ${obs.homeTeam} ${proposal.scoreLabel} ${obs.awayTeam}`,
      `Combo sur ${proposal.window} — ${(proposal.combinedProb * 100).toFixed(0)}% combiné\n${legsText}` +
        (context ? '\n\nContexte collecté disponible dans l\'app.' : ''),
      { fixtureId: obs.fixtureId, kind: 'minute20' }
    );
  }

  if (fresh.length > 0) writeInPlayProposals([...existing, ...fresh]);
  return fresh.length;
}
