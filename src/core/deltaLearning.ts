// Apprentissage des ÉCARTS (delta) entre ce que l'app projetait et ce qui
// s'est réellement passé, pour les marchés de comptage : corners et cartons
// de 1ère mi-temps, buts à la pause et en fin de match. Exemple : 2 corners
// projetés à la pause pour 7 réels → la partie restant à jouer avait été
// sous-estimée ; sur l'ensemble des matchs réglés, le rapport réel/projeté
// devient un facteur de correction appliqué aux projections suivantes.
// Entièrement mesuré sur les résultats réels, rien d'inventé.

import { readInPlayProposals } from './learnStore';

export type DeltaUnit = 'corners_1h' | 'cards_1h' | 'goals_1h' | 'goals_ft';

export interface LegProjection {
  unit: DeltaUnit;
  /** Valeur finale projetée pour la fenêtre (déjà compté + attendu). */
  expected: number;
  /** Déjà compté au moment du pronostic. */
  observed: number;
  /** Valeur réelle, renseignée au règlement. */
  actual?: number;
}

export interface DeltaCorrection {
  unit: DeltaUnit;
  /** Multiplicateur appliqué à la partie restant à jouer. */
  factor: number;
  samples: number;
  /** Écart moyen réel − projeté (signé) et écart absolu moyen, AVANT correction. */
  meanDelta: number;
  meanAbsDelta: number;
}

/** Matchs pris en compte (les plus récents). */
const WINDOW = 400;
/** Poids du "pas de correction" (en événements) : évite qu'une poignée de
 * matchs fasse varier le facteur brutalement. */
const PRIOR_EVENTS = 4;
const FACTOR_MIN = 0.4;
const FACTOR_MAX = 3;
const CACHE_MS = 5 * 60_000;

let cached: { at: number; byUnit: Map<DeltaUnit, DeltaCorrection> } | null = null;

function compute(): Map<DeltaUnit, DeltaCorrection> {
  const samples = new Map<DeltaUnit, LegProjection[]>();
  const seen = new Set<string>();
  const proposals = readInPlayProposals();
  for (let i = proposals.length - 1; i >= 0; i--) {
    for (const leg of proposals[i].legs) {
      const p = (leg as { projection?: LegProjection }).projection;
      if (!p || p.actual == null) continue;
      // Un même match/fenêtre ne compte qu'une fois (plusieurs lignes possibles).
      const key = `${leg.fixtureId}|${p.unit}|${p.observed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = samples.get(p.unit) ?? [];
      if (list.length < WINDOW) list.push(p);
      samples.set(p.unit, list);
    }
  }

  const out = new Map<DeltaUnit, DeltaCorrection>();
  for (const [unit, list] of samples) {
    let actualRemaining = 0;
    let expectedRemaining = 0;
    let delta = 0;
    let absDelta = 0;
    for (const p of list) {
      actualRemaining += Math.max(0, p.actual! - p.observed);
      expectedRemaining += Math.max(0, p.expected - p.observed);
      delta += p.actual! - p.expected;
      absDelta += Math.abs(p.actual! - p.expected);
    }
    const factor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, (actualRemaining + PRIOR_EVENTS) / (expectedRemaining + PRIOR_EVENTS)));
    out.set(unit, {
      unit,
      factor,
      samples: list.length,
      meanDelta: list.length ? delta / list.length : 0,
      meanAbsDelta: list.length ? absDelta / list.length : 0,
    });
  }
  return out;
}

export function getDeltaCorrection(unit: DeltaUnit): DeltaCorrection {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    try {
      cached = { at: Date.now(), byUnit: compute() };
    } catch {
      cached = { at: Date.now(), byUnit: new Map() };
    }
  }
  return cached.byUnit.get(unit) ?? { unit, factor: 1, samples: 0, meanDelta: 0, meanAbsDelta: 0 };
}

export function getAllDeltaCorrections(): DeltaCorrection[] {
  return (['corners_1h', 'cards_1h', 'goals_1h', 'goals_ft'] as DeltaUnit[]).map(getDeltaCorrection);
}

/** Phrase d'explication ajoutée au raisonnement d'un pronostic corrigé. */
export function describeCorrection(c: DeltaCorrection, noun: string): string {
  if (c.samples < 5 || Math.abs(c.factor - 1) < 0.05) return '';
  const sign = c.meanDelta >= 0 ? '+' : '';
  return ` Correction apprise ×${c.factor.toFixed(2)} sur le reste à jouer (écart moyen réel − projeté : ${sign}${c.meanDelta.toFixed(1)} ${noun} sur ${c.samples} matchs).`;
}

export function invalidateDeltaCache(): void {
  cached = null;
}

export const DELTA_LABELS: Record<DeltaUnit, string> = {
  corners_1h: 'Corners 1ère mi-temps',
  cards_1h: 'Cartons 1ère mi-temps',
  goals_1h: 'Buts à la pause',
  goals_ft: 'Buts en fin de match',
};
