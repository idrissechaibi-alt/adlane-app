// Apprentissage des ÉCARTS (delta) entre ce que l'app projetait et ce qui
// s'est réellement passé, pour les marchés de comptage : corners et cartons
// de 1ère mi-temps, buts à la pause et en fin de match. Exemple : 2 corners
// projetés à la pause pour 7 réels → la partie restant à jouer avait été
// sous-estimée ; sur l'ensemble des matchs réglés, le rapport réel/projeté
// devient un facteur de correction appliqué aux projections suivantes.
// Entièrement mesuré sur les résultats réels, rien d'inventé.

import AsyncStorage from './kvStore';
import { readInPlayProposals } from './learnStore';
import { hubFinalResult } from '../api/footballDataAPIs/liveDataHub';
import { mapWithConcurrency } from './concurrency';

export type DeltaUnit = 'corners_1h' | 'cards_1h' | 'fouls_1h' | 'goals_1h' | 'goals_ft' | 'corners_ft' | 'cards_ft' | 'fouls_ft';

/**
 * Maximum réaliste d'un compteur sur la fenêtre (au-delà : relevé aberrant ou projection folle).
 * Sert à écarter les relevés incohérents avant d'apprendre, et à plafonner chaque projection.
 */
export const PLAUSIBLE_MAX: Record<DeltaUnit, number> = {
  corners_1h: 12, cards_1h: 7, fouls_1h: 24, goals_1h: 6,
  goals_ft: 12, corners_ft: 24, cards_ft: 14, fouls_ft: 45,
};

export const isPlausible = (unit: DeltaUnit, ...values: Array<number | undefined>): boolean =>
  values.every((v) => v == null || (Number.isFinite(v) && v >= 0 && v <= PLAUSIBLE_MAX[unit]));

export interface LegProjection {
  unit: DeltaUnit;
  /** Valeur finale projetée pour la fenêtre (déjà compté + attendu). */
  expected: number;
  /** Déjà compté au moment du pronostic. */
  observed: number;
  /** Valeur réelle, renseignée au règlement. */
  actual?: number;
  /** Correction déjà appliquée dans `expected` (pour retrouver la projection brute). */
  factorUsed?: number;
  /** Situation du match au moment de la projection (voir SITUATION_FEATURES) : sert à apprendre leurs effets. */
  features?: number[];
  /** Multiplicateur de situation déjà appliqué dans `expected` (1 = aucun). */
  situationUsed?: number;
}

export interface DeltaCorrection {
  unit: DeltaUnit;
  /** Multiplicateur appliqué à la partie restant à jouer. */
  factor: number;
  samples: number;
  /** Écart moyen réel − projeté (signé) et écart absolu moyen, AVANT correction. */
  meanDelta: number;
  meanAbsDelta: number;
  /** Rapport variance / moyenne du reste à jouer (1 = Poisson ; > 1 = matchs plus extrêmes que prévu). */
  dispersion: number;
  /** Facteur par tranche de reste attendu : un match ouvert n'est pas sous-estimé comme un match fermé. */
  bins: Array<{ upTo: number; factor: number; samples: number }>;
}

/** Facteur à appliquer à un reste attendu brut, selon sa tranche (global à défaut). */
export function factorForRemaining(c: DeltaCorrection, rawRemaining: number): number {
  for (const b of c.bins) if (rawRemaining <= b.upTo) return b.factor;
  return c.bins.length ? c.bins[c.bins.length - 1].factor : c.factor;
}

/** Matchs pris en compte (les plus récents). */
const WINDOW = 400;
/** Poids du "pas de correction" (en événements) : évite qu'une poignée de
 * matchs fasse varier le facteur brutalement. */
const PRIOR_EVENTS = 4;
const FACTOR_MIN = 0.4;
const FACTOR_MAX = 3;
const CACHE_MS = 5 * 60_000;
/** Échantillons minimum pour qu'une tranche ait son propre facteur. */
const BIN_MIN_SAMPLES = 15;
const DISPERSION_MAX = 3.5;
/** Poids du « Poisson pur » (en matchs) dans la dispersion mesurée. */
const DISPERSION_PRIOR = 20;

let cached: { at: number; byUnit: Map<DeltaUnit, DeltaCorrection> } | null = null;

function compute(): Map<DeltaUnit, DeltaCorrection> {
  const samples = new Map<DeltaUnit, LegProjection[]>();
  const seen = new Set<string>();
  const add = (fixtureId: number, p: LegProjection) => {
    if (p.actual == null) return;
    // Relevé ou projection aberrants (19 corners prédits en 1ère MT…) : ne servent pas à apprendre.
    if (!isPlausible(p.unit, p.actual, p.observed, p.expected)) return;
    // Un même match/fenêtre ne compte qu'une fois (plusieurs lignes possibles).
    const key = `${fixtureId}|${p.unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    const list = samples.get(p.unit) ?? [];
    if (list.length < WINDOW) list.push(p);
    samples.set(p.unit, list);
  };
  // Matchs suivis sans pari (les plus nombreux), puis jambes de paris.
  for (let i = shadowCache.length - 1; i >= 0; i--) add(shadowCache[i].fixtureId, shadowCache[i]);
  const proposals = readInPlayProposals();
  for (let i = proposals.length - 1; i >= 0; i--) {
    for (const leg of proposals[i].legs) {
      const p = (leg as { projection?: LegProjection }).projection;
      if (p) add(leg.fixtureId, p);
    }
  }

  const out = new Map<DeltaUnit, DeltaCorrection>();
  for (const [unit, list] of samples) {
    let actualRemaining = 0;
    let rawExpectedRemaining = 0;
    let delta = 0;
    let absDelta = 0;
    for (const p of list) {
      actualRemaining += Math.max(0, p.actual! - p.observed);
      // Projection SANS la correction de l'époque : le facteur reste absolu,
      // il ne se corrige pas lui-même au fil des passes.
      rawExpectedRemaining += Math.max(0, p.expected - p.observed) / ((p.factorUsed ?? 1) * (p.situationUsed ?? 1));
      delta += p.actual! - p.expected;
      absDelta += Math.abs(p.actual! - p.expected);
    }
    const factor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, (actualRemaining + PRIOR_EVENTS) / (rawExpectedRemaining + PRIOR_EVENTS)));

    // Reste attendu brut / réel de chaque match, pour les tranches et la dispersion.
    const rows = list.map((p) => ({
      raw: Math.max(0, p.expected - p.observed) / ((p.factorUsed ?? 1) * (p.situationUsed ?? 1)),
      act: Math.max(0, p.actual! - p.observed),
    }));
    // Tranches (3 terciles de reste attendu) : facteur propre quand l'échantillon suffit.
    const sorted = [...rows].sort((a, b) => a.raw - b.raw);
    const bins: DeltaCorrection['bins'] = [];
    if (sorted.length >= BIN_MIN_SAMPLES * 3) {
      const cut = [Math.floor(sorted.length / 3), Math.floor((2 * sorted.length) / 3), sorted.length];
      let from = 0;
      cut.forEach((to, i) => {
        const part = sorted.slice(from, to);
        from = to;
        const a = part.reduce((t, r) => t + r.act, 0);
        const e = part.reduce((t, r) => t + r.raw, 0);
        bins.push({
          upTo: i === cut.length - 1 ? Number.POSITIVE_INFINITY : part[part.length - 1].raw,
          factor: Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, (a + PRIOR_EVENTS) / (e + PRIOR_EVENTS))),
          samples: part.length,
        });
      });
    }
    // Dispersion du reste APRÈS correction : variance mesurée / moyenne prévue.
    const binned = (raw: number) => {
      for (const b of bins) if (raw <= b.upTo) return b.factor;
      return factor;
    };
    const sq = rows.reduce((t, r) => t + (r.act - r.raw * binned(r.raw)) ** 2, 0);
    const predicted = rows.reduce((t, r) => t + r.raw * binned(r.raw), 0);
    const measured = predicted > 0 ? sq / predicted : 1;
    const dispersion = Math.min(DISPERSION_MAX, Math.max(1, (measured * list.length + DISPERSION_PRIOR) / (list.length + DISPERSION_PRIOR)));
    out.set(unit, {
      unit,
      factor,
      samples: list.length,
      meanDelta: list.length ? delta / list.length : 0,
      meanAbsDelta: list.length ? absDelta / list.length : 0,
      dispersion,
      bins,
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
  return cached.byUnit.get(unit) ?? { unit, factor: 1, samples: 0, meanDelta: 0, meanAbsDelta: 0, dispersion: 1, bins: [] };
}

export function getAllDeltaCorrections(): DeltaCorrection[] {
  return (['corners_1h', 'cards_1h', 'fouls_1h', 'corners_ft', 'cards_ft', 'fouls_ft', 'goals_1h', 'goals_ft'] as DeltaUnit[]).map(getDeltaCorrection);
}

/** Phrase d'explication ajoutée au raisonnement d'un pronostic corrigé. */
export function describeCorrection(c: DeltaCorrection, noun: string): string {
  if (c.samples < 5 || Math.abs(c.factor - 1) < 0.05) return '';
  const sign = c.meanDelta >= 0 ? '+' : '';
  return ` Correction apprise ×${c.factor.toFixed(2)} sur le reste à jouer (écart moyen réel − projeté : ${sign}${c.meanDelta.toFixed(1)} ${noun} sur ${c.samples} matchs).`;
}

export function invalidateDeltaCache(): void {
  cached = null;
  situationCache = null;
}

export const DELTA_LABELS: Record<DeltaUnit, string> = {
  corners_1h: 'Corners 1ère mi-temps',
  cards_1h: 'Cartons 1ère mi-temps',
  goals_1h: 'Buts à la pause',
  goals_ft: 'Buts en fin de match',
  corners_ft: 'Corners sur le match',
  cards_ft: 'Cartons sur le match',
  fouls_1h: 'Fautes 1ère mi-temps',
  fouls_ft: 'Fautes sur le match',
};


// ---------- Matchs suivis SANS pari : projection enregistrée, réel mesuré ----------
// Chaque match suivi en direct (15e-35e minute) reçoit une projection de ses
// corners/cartons à la pause, même quand aucune ligne n'est jouée. Réglée
// ensuite par les sources live gratuites : des centaines d'écarts mesurés
// par jour au lieu des seuls paris.

const SHADOW_KEY = '@delta_shadow_samples';
const SHADOW_KEEP_MS = 14 * 86_400_000;
const SHADOW_MAX = 4000;
const SHADOW_SETTLE_DELAY_MS = 75 * 60_000;
const SHADOW_SETTLE_MAX_PER_PASS = 120;
const SHADOW_MAX_TRIES = 6;

interface ShadowSample extends LegProjection {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  /** Date UTC du match (YYYY-MM-DD). */
  date: string;
  minute: number;
  at: number;
  tries?: number;
}

let shadowCache: ShadowSample[] = [];
let shadowLoaded = false;

async function loadShadows(): Promise<ShadowSample[]> {
  if (shadowLoaded) return shadowCache;
  try {
    const raw = await AsyncStorage.getItem(SHADOW_KEY);
    shadowCache = raw ? JSON.parse(raw) : [];
  } catch {
    shadowCache = [];
  }
  shadowLoaded = true;
  cached = null;
  return shadowCache;
}

async function saveShadows(): Promise<void> {
  const now = Date.now();
  shadowCache = shadowCache.filter((s) => now - s.at < SHADOW_KEEP_MS).slice(-SHADOW_MAX);
  try {
    await AsyncStorage.setItem(SHADOW_KEY, JSON.stringify(shadowCache));
  } catch {
    // best-effort
  }
  cached = null;
}

/** Charge les écarts mesurés hors paris (à appeler en début de tour). */
export async function ensureDeltaSamplesLoaded(): Promise<void> {
  await loadShadows();
}

/** Rythmes moyens d'une 1ère mi-temps (≈ 10 corners / 4 cartons par match). */
const TYPICAL_PER_MINUTE: Partial<Record<DeltaUnit, number>> = { corners_1h: 10 / 90, cards_1h: 4 / 90, fouls_1h: 24 / 90 };
const PACE_PRIOR_MINUTES = 20;

/** Projection à la pause au rythme observé (mêlé au rythme moyen), corrigée de l'écart appris. */
export function projectFirstHalfCount(unit: 'corners_1h' | 'cards_1h' | 'fouls_1h', observed: number, minute: number, features?: number[] | null): LegProjection {
  const typical = TYPICAL_PER_MINUTE[unit]!;
  const perMinute = (observed + typical * PACE_PRIOR_MINUTES) / (Math.max(1, minute) + PACE_PRIOR_MINUTES);
  const factor = getDeltaCorrection(unit).factor;
  return { unit, observed, expected: observed + perMinute * Math.max(0, 45 - minute) * factor, factorUsed: factor, features: features ?? undefined };
}

/** Projection en fin de match (corners/cartons du match entier), même formule. */
export function projectFullMatchCount(unit: 'corners_ft' | 'cards_ft' | 'fouls_ft', observed: number, minute: number, features?: number[] | null): LegProjection {
  const typical = unit === 'corners_ft' ? 10 / 90 : unit === 'cards_ft' ? 4 / 90 : 24 / 90;
  const perMinute = (observed + typical * PACE_PRIOR_MINUTES) / (Math.max(1, minute) + PACE_PRIOR_MINUTES);
  const factor = getDeltaCorrection(unit).factor;
  return { unit, observed, expected: observed + perMinute * Math.max(0, 94 - minute) * factor, factorUsed: factor, features: features ?? undefined };
}

/** Enregistre (une fois par match et par fenêtre) la projection d'un match suivi. */
export async function recordShadowProjection(
  match: { fixtureId: number; homeTeam: string; awayTeam: string; minute: number },
  projection: LegProjection
): Promise<void> {
  const fullMatchCount = projection.unit === 'corners_ft' || projection.unit === 'cards_ft' || projection.unit === 'fouls_ft';
  if (fullMatchCount ? match.minute < 50 || match.minute > 75 : match.minute < 15 || match.minute > 35) return;
  const list = await loadShadows();
  if (list.some((s) => s.fixtureId === match.fixtureId && s.unit === projection.unit)) return;
  list.push({
    ...projection,
    fixtureId: match.fixtureId,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    date: new Date().toISOString().slice(0, 10),
    minute: match.minute,
    at: Date.now(),
  });
  shadowDirty = true;
}

let shadowDirty = false;

/** Écrit les projections enregistrées pendant le tour. */
export async function flushShadowProjections(): Promise<void> {
  if (!shadowDirty) return;
  shadowDirty = false;
  await saveShadows();
}

/** Mesure la valeur réelle des matchs suivis et terminés (passage horaire). */
const SHADOW_SETTLE_INTERVAL_MS = 15 * 60_000;
let lastShadowSettle = 0;

export async function settleShadowProjections(deadline = Infinity): Promise<number> {
  const now = Date.now();
  if (now - lastShadowSettle < SHADOW_SETTLE_INTERVAL_MS) return 0;
  lastShadowSettle = now;
  const list = await loadShadows();
  const pending = new Map<number, ShadowSample[]>();
  for (const s of list) {
    if (s.actual != null || now - s.at < SHADOW_SETTLE_DELAY_MS || (s.tries ?? 0) >= SHADOW_MAX_TRIES) continue;
    const group = pending.get(s.fixtureId) ?? [];
    group.push(s);
    pending.set(s.fixtureId, group);
  }
  let settled = 0;
  const groups = [...pending.values()].slice(0, SHADOW_SETTLE_MAX_PER_PASS);
  await mapWithConcurrency(groups, 4, async (group) => {
    if (Date.now() > deadline) return;
    const first = group[0];
    const result = await hubFinalResult(first.homeTeam, first.awayTeam, first.date).catch(() => null);
    for (const s of group) {
      s.tries = (s.tries ?? 0) + 1;
      if (!result) continue;
      const actual =
        s.unit === 'corners_1h' ? result.corners1H
        : s.unit === 'cards_1h' ? result.cards1H
        : s.unit === 'corners_ft' ? result.cornersFT
        : s.unit === 'cards_ft' ? result.cardsFT
        : s.unit === 'fouls_1h' ? result.fouls1H
        : s.unit === 'fouls_ft' ? result.foulsFT
        : s.unit === 'goals_1h' ? result.htHome + result.htAway
        : result.goalsHome + result.goalsAway;
      if (actual != null && !isPlausible(s.unit, actual)) {
        s.tries = SHADOW_MAX_TRIES; // valeur réelle aberrante de la source : écartée
      } else if (actual != null) {
        s.actual = actual;
        settled++;
      } else {
        s.tries = SHADOW_MAX_TRIES; // la source ne publie pas cette stat : inutile d'insister
      }
    }
  });
  if (groups.length > 0) await saveShadows();
  return settled;
}

/** Nombre de projections hors paris en attente / mesurées (diagnostic). */
export function getShadowStats(): { pending: number; measured: number } {
  return {
    pending: shadowCache.filter((s) => s.actual == null && (s.tries ?? 0) < SHADOW_MAX_TRIES).length,
    measured: shadowCache.filter((s) => s.actual != null).length,
  };
}


// ---------- Écarts EXACTS prédit / réel ----------
// Pour chaque compteur : la valeur finale prédite comparée à la valeur finale réelle,
// que le pari soit gagné ou perdu. « 2 prédit, 10 réel » est un gros écart même si le
// pari « Plus de 1.5 » est passé. Les plus gros ratés sont listés avec leur match.

export interface DeltaMiss {
  match: string;
  predicted: number;
  actual: number;
}

export interface DeltaReportRow {
  unit: DeltaUnit;
  label: string;
  /** Projections réglées avec la valeur réelle connue. */
  verified: number;
  /** Projections encore sans valeur réelle (match en cours, source muette). */
  pending: number;
  meanPredicted: number;
  meanActual: number;
  /** Écart signé moyen : réel − prédit (positif = l'app sous-estime). */
  meanError: number;
  /** Écart absolu moyen. */
  meanAbsError: number;
  /** Cas où |réel − prédit| ≥ max(3, 100 % de la valeur prédite). */
  bigMisses: number;
  worst: DeltaMiss[];
}

export function getDeltaReport(): DeltaReportRow[] {
  const entries: Array<{ unit: DeltaUnit; predicted: number; actual?: number; match: string; key: string }> = [];
  const seen = new Set<string>();
  const push = (fixtureId: number, p: LegProjection, match: string) => {
    const key = `${fixtureId}|${p.unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!isPlausible(p.unit, p.actual, p.expected)) return;
    entries.push({ unit: p.unit, predicted: p.expected, actual: p.actual, match, key });
  };
  for (const sh of shadowCache) push(sh.fixtureId, sh, `${sh.homeTeam} - ${sh.awayTeam}`);
  for (const proposal of readInPlayProposals()) {
    for (const leg of proposal.legs) {
      const p = (leg as { projection?: LegProjection }).projection;
      if (p) push(leg.fixtureId, p, `${leg.homeTeam} - ${leg.awayTeam}`);
    }
  }
  return (Object.keys(DELTA_LABELS) as DeltaUnit[]).map((unit) => {
    const mine = entries.filter((e) => e.unit === unit);
    const done = mine.filter((e) => e.actual != null) as Array<{ predicted: number; actual: number; match: string }>;
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const errs = done.map((e) => e.actual - e.predicted);
    const big = done.filter((e) => Math.abs(e.actual - e.predicted) >= Math.max(3, e.predicted));
    return {
      unit,
      label: DELTA_LABELS[unit],
      verified: done.length,
      pending: mine.length - done.length,
      meanPredicted: avg(done.map((e) => e.predicted)),
      meanActual: avg(done.map((e) => e.actual)),
      meanError: avg(errs),
      meanAbsError: avg(errs.map(Math.abs)),
      bigMisses: big.length,
      worst: [...done]
        .sort((a, b) => Math.abs(b.actual - b.predicted) - Math.abs(a.actual - a.predicted))
        .slice(0, 3)
        .map((e) => ({ match: e.match, predicted: Math.round(e.predicted * 10) / 10, actual: e.actual })),
    };
  });
}


// ---------- Situation du match : momentum, favori, état du match, rouges, occasions ----------
// Chaque projection enregistre la SITUATION du match à cet instant (SITUATION_FEATURES). Une fois le
// résultat connu, une régression (ridge) mesure de combien le reste à jouer réel s'écarte du reste
// prévu par le modèle de base, en fonction de ces variables. Les poids ne sont pas devinés : ils sont
// appris, plafonnés (±25 % par variable, ±40 % au total) et ne passent sur le pipe RÉEL qu'une fois
// qu'ils améliorent l'erreur sur des matchs mis de côté (« promus »).

export const SITUATION_FEATURES = [
  'intensité récente 10 min',
  'intensité récente 20 min',
  'momentum (une équipe domine)',
  'force du favori',
  'favori mené',
  'favori devant',
  'écart de buts',
  'cartons rouges',
  'qualité des occasions',
  // Météo du stade (Open-Meteo) — ajoutée en fin de vecteur : les échantillons plus anciens (9 variables) restent valables.
  'pluie',
  'vent',
  'chaleur ou froid',
];
const PER_FEATURE_CAP = Math.log(1.25);
const TOTAL_CAP = Math.log(1.4);
const SITUATION_MIN_SAMPLES = 40;
const SITUATION_PROMOTE_SAMPLES = 60;
const SITUATION_PROMOTE_GAIN = 0.03;
const RIDGE = 6;

interface SituationFit {
  unit: DeltaUnit;
  n: number;
  weights: number[];
  maeBase: number | null;
  maeNew: number | null;
  promoted: boolean;
}

let situationCache: { at: number; byUnit: Map<DeltaUnit, SituationFit> } | null = null;

function solve(A: number[][], b: number[]): number[] {
  const d = b.length;
  for (let i = 0; i < d; i++) {
    let piv = i;
    for (let r = i + 1; r < d; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]];
    [b[i], b[piv]] = [b[piv], b[i]];
    if (Math.abs(A[i][i]) < 1e-9) continue;
    for (let r = i + 1; r < d; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < d; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(d).fill(0);
  for (let i = d - 1; i >= 0; i--) {
    if (Math.abs(A[i][i]) < 1e-9) continue;
    x[i] = (b[i] - A[i].slice(i + 1).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / A[i][i];
  }
  return x;
}

function ridge(rows: Array<{ f: number[]; y: number }>): number[] {
  const d = SITUATION_FEATURES.length;
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r.f[i] * r.f[j], 0) + (i === j ? RIDGE : 0)));
  const b = Array.from({ length: d }, (_, i) => rows.reduce((s, r) => s + r.f[i] * r.y, 0));
  return solve(A, b);
}

function capped(weights: number[], f: number[]): number {
  let total = 0;
  for (let j = 0; j < weights.length; j++) total += Math.max(-PER_FEATURE_CAP, Math.min(PER_FEATURE_CAP, weights[j] * (f[j] ?? 0)));
  return Math.max(-TOTAL_CAP, Math.min(TOTAL_CAP, total));
}

function fitSituation(): Map<DeltaUnit, SituationFit> {
  const byUnit = new Map<DeltaUnit, Array<{ f: number[]; baseRem: number; actRem: number; at: number }>>();
  const seen = new Set<string>();
  const add = (fixtureId: number, p: LegProjection, at: number) => {
    if (p.actual == null || !p.features || p.features.length > SITUATION_FEATURES.length || p.features.length < 9 || !isPlausible(p.unit, p.actual, p.observed, p.expected)) return;
    const key = `${fixtureId}|${p.unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    const baseRem = Math.max(0, p.expected - p.observed) / (p.situationUsed ?? 1);
    const list = byUnit.get(p.unit) ?? [];
    list.push({ f: [...p.features, ...new Array(SITUATION_FEATURES.length - p.features.length).fill(0)], baseRem, actRem: Math.max(0, p.actual - p.observed), at });
    byUnit.set(p.unit, list);
  };
  for (const sh of shadowCache) add(sh.fixtureId, sh, sh.at);
  let proposals: ReturnType<typeof readInPlayProposals> = [];
  try {
    proposals = readInPlayProposals();
  } catch {
    proposals = [];
  }
  for (const proposal of proposals) {
    for (const leg of proposal.legs) {
      const p = (leg as { projection?: LegProjection }).projection;
      if (p) add(leg.fixtureId, p, Date.parse(proposal.createdAt));
    }
  }
  const out = new Map<DeltaUnit, SituationFit>();
  for (const [unit, list] of byUnit) {
    list.sort((a, b) => a.at - b.at);
    const rows = list.map((r) => ({ f: r.f, y: Math.log((r.actRem + 1) / (r.baseRem + 1)) }));
    if (list.length < SITUATION_MIN_SAMPLES) {
      out.set(unit, { unit, n: list.length, weights: new Array(SITUATION_FEATURES.length).fill(0), maeBase: null, maeNew: null, promoted: false });
      continue;
    }
    // Évaluation sur les 30 % de matchs les plus récents, poids appris sur les 70 % précédents.
    const cut = Math.floor(list.length * 0.7);
    const wTrain = ridge(rows.slice(0, cut));
    const test = list.slice(cut);
    const mae = (pred: (r: (typeof list)[number]) => number) => test.reduce((s, r) => s + Math.abs(r.actRem - pred(r)), 0) / test.length;
    const maeBase = mae((r) => r.baseRem);
    const maeNew = mae((r) => r.baseRem * Math.exp(capped(wTrain, r.f)));
    const promoted = list.length >= SITUATION_PROMOTE_SAMPLES && maeNew <= maeBase * (1 - SITUATION_PROMOTE_GAIN);
    out.set(unit, { unit, n: list.length, weights: ridge(rows), maeBase, maeNew, promoted });
  }
  return out;
}

function situationFits(): Map<DeltaUnit, SituationFit> {
  if (!situationCache || Date.now() - situationCache.at > CACHE_MS) {
    try {
      situationCache = { at: Date.now(), byUnit: fitSituation() };
    } catch {
      situationCache = { at: Date.now(), byUnit: new Map() };
    }
  }
  return situationCache.byUnit;
}

/**
 * Multiplicateur de situation du reste à jouer pour ce compteur. Pipe fictif : appliqué dès que les poids sont
 * appris (c'est lui qui apporte la preuve). Pipe réel : seulement une fois « promus » sur des matchs de test.
 */
export function situationMultiplier(unit: DeltaUnit, features: number[] | null | undefined, real: boolean): number {
  if (!features) return 1;
  const fit = situationFits().get(unit);
  if (!fit || fit.n < SITUATION_MIN_SAMPLES) return 1;
  if (real && !fit.promoted) return 1;
  return Math.exp(capped(fit.weights, features));
}

export interface SituationReportRow {
  unit: DeltaUnit;
  label: string;
  samples: number;
  /** Erreur absolue du reste à jouer sur les matchs de test : modèle de base / avec situation. */
  maeBase: number | null;
  maeNew: number | null;
  promoted: boolean;
  /** Effet (en %) sur le reste à jouer d'une variable à +1 (plafonné). */
  effects: Array<{ name: string; pct: number }>;
}

export function getSituationReport(): SituationReportRow[] {
  const fits = situationFits();
  return (Object.keys(DELTA_LABELS) as DeltaUnit[]).map((unit) => {
    const fit = fits.get(unit);
    return {
      unit,
      label: DELTA_LABELS[unit],
      samples: fit?.n ?? 0,
      maeBase: fit?.maeBase ?? null,
      maeNew: fit?.maeNew ?? null,
      promoted: fit?.promoted ?? false,
      effects: SITUATION_FEATURES.map((name, j) => ({
        name,
        pct: Math.round((Math.exp(Math.max(-PER_FEATURE_CAP, Math.min(PER_FEATURE_CAP, fit?.weights[j] ?? 0))) - 1) * 100),
      })),
    };
  });
}
