// Apprentissage des COTES du bookmaker, minute par minute.
//
// Une cote bouge avec le match : score, minute, corners, cartons déjà joués. Chaque
// saisie est donc enregistrée AVEC son contexte (minute, compteur au moment de la
// saisie, ce que le modèle de l'app calculait à cet instant). Un même pari peut
// recevoir plusieurs cotes (30e puis 67e) : elles comptent toutes.
//
// Marchés de comptage (corners, cartons, fautes, total de buts) : à chaque saisie,
// on cherche de combien il aurait fallu multiplier le rythme attendu du modèle pour
// que SA probabilité redonne 1/cote — c'est le rythme que le bookmaker semble
// utiliser. La médiane par type de compteur et tranche de minutes (0-30, 31-60,
// 61-90) sert ensuite à estimer la cote de n'importe quelle ligne, à n'importe quel
// moment. Autres marchés (1X2, BTTS…) : rapport cote × probabilité par tranche.
// Avec peu de saisies, une marge standard de 8 % tient lieu de valeur de départ.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { InPlayProposal, TrackedMarket } from './learnStore';
import { atLeastProb } from './countModel';
import { normalizeTeamName } from './teamNameMatch';
import { DeltaUnit, getDeltaCorrection } from './deltaLearning';

const KEY = '@bookie_odds_observations_v2';
const MAX_OBSERVATIONS = 1000;
const PRIOR_RATIO = 0.92;
const PRIOR_WEIGHT = 4;
/** Observations à partir desquelles le rapport appris remplace entièrement la valeur de départ. */
const FULL_WEIGHT_AT = 12;
/** Une cote de bookmaker reste dans cette fourchette de la cote « juste » du modèle (1 / probabilité) : sans ça, 1-2 saisies suffisaient à écrouler les estimations. */
const RATIO_MIN = 0.78;
const RATIO_MAX = 1.02;
const clampOdds = (odds: number, prob: number) => Math.max(RATIO_MIN / Math.max(0.05, prob), Math.min(RATIO_MAX / Math.max(0.05, prob), odds));
const K_MIN = 0.3;
const K_MAX = 3;
/** Cote estimée minimale pour qu'un pari réel soit proposé (en dessous : mis en attente, rejoué si la cote monte). */
export const MIN_ESTIMATED_ODDS = 1.4;

/** Situation d'un pari de comptage à un instant donné. */
export interface CountInfo {
  /** Compteur : corners_1h, corners_ft, cards_ft, fouls_ft, goals_ft… */
  unit: string;
  side: 'over' | 'under';
  line: number;
  /** Déjà compté à cet instant. */
  done: number;
  /** Événements restants attendus par le modèle. */
  lambda: number;
  /** Rapport variance / moyenne mesuré (voir countModel.ts). */
  fano: number;
}

/** Ce qui s'est passé dans le match au moment de la saisie : sert à expliquer les variations de cote. */
export interface OddsStats {
  goalsHome: number;
  goalsAway: number;
  /** Tirs cadrés (total des deux équipes). */
  sot: number;
  shots: number;
  corners?: number;
  cards?: number;
  fouls?: number;
  reds: number;
}

/** Contexte relevé au moment où la cote est saisie. */
export interface OddsContext {
  minute: number;
  goalsNow: number;
  count?: CountInfo;
  stats?: OddsStats;
}

const TYPICAL_PER_MIN: Record<string, number> = { corners: 10 / 90, cards: 4 / 90, fouls: 24 / 90, goals: 2.6 / 94 };
const FEATURE_NAMES = ['rythme du compteur', 'buts', 'tirs cadrés', 'cartons rouges', 'temps écoulé'];

/**
 * Variables de situation qui peuvent faire bouger une cote : rythme du compteur
 * comparé au rythme habituel, buts, tirs cadrés (par rapport à ~8 par match), rouges, temps.
 */
export function featuresOf(unit: string, minute: number, done: number, stats?: { goals: number; sot: number; reds: number }): number[] {
  const typical = TYPICAL_PER_MIN[unit.split('_')[0]] ?? 0;
  const m = Math.max(5, minute);
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const paceRel = typical > 0 ? clamp((done / m) / typical - 1, -1, 3) : 0;
  const sotRel = clamp(((stats?.sot ?? 0) / m) * 90 / 8 - 1, -1, 3);
  return [paceRel, stats?.goals ?? 0, sotRel, stats?.reds ?? 0, minute / 90];
}

export interface OddsObservation {
  id: string;
  proposalId: string;
  /** Même match + même pari (sélection identique) : plusieurs propositions à des horaires différents partagent leurs cotes. */
  groupKey?: string;
  ts: string;
  odds: number;
  segment: string;
  /** Probabilité du modèle à cet instant (recalculée pour un comptage, sinon celle de la proposition). */
  modelProb: number;
  minute?: number;
  goalsNow?: number;
  count?: CountInfo;
  stats?: OddsStats;
  /** Variables de situation (voir featuresOf), pour expliquer les variations. */
  features?: number[];
  /** Multiplicateur du rythme du modèle qui redonne 1/cote (comptages). */
  k?: number;
  /** Cote que l'app estimait AVANT cette saisie (sans / avec la correction des écarts résiduels). */
  estRaw?: number;
  estFinal?: number;
  /** Clé de la correction résiduelle (compteur ou segment). */
  residKey?: string;
  label: string;
}

let memo: OddsObservation[] | null = null;
let cache: { at: number; resid: Map<string, number>; reaction: Map<string, { b: number[]; meanF: number[]; pairs: number }>; k: Map<string, { k: number; n: number }>; ratio: Map<string, { ratio: number; n: number }>; globalRatio: { ratio: number; n: number } } | null = null;

async function load(): Promise<OddsObservation[]> {
  if (memo) return memo;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    memo = raw ? JSON.parse(raw) : [];
  } catch {
    memo = [];
  }
  return memo!;
}

export function ensureOddsLoaded(): Promise<unknown> {
  return load();
}

export function bucketOf(minute: number | undefined): 'a' | 'b' | 'c' {
  if (minute == null) return 'b';
  return minute <= 30 ? 'a' : minute <= 60 ? 'b' : 'c';
}

export function oddsSegment(market: TrackedMarket, selection: string): string {
  const side = /^plus/i.test(selection) ? 'over' : /^moins|^0-0|\(non\)|ne marquent pas/i.test(selection) ? 'under' : 'yes';
  const window = /sur le match|total match/i.test(selection) ? 'ft' : /mi-temps|pause|1ère/i.test(selection) ? '1h' : 'ft';
  return `${market}|${side}|${window}`;
}

/** Clé commune des paris identiques (même match, même sélection) proposés à des moments différents ; null pour un combiné. */
export function groupKeyOf(proposal: InPlayProposal): string | null {
  if (proposal.legs.length !== 1) return null;
  const l = proposal.legs[0];
  return `${normalizeTeamName(l.homeTeam)}|${normalizeTeamName(l.awayTeam)}|${l.market}|${l.selection}`;
}

export function proposalSegment(proposal: InPlayProposal): string {
  return proposal.legs.length === 1 ? oddsSegment(proposal.legs[0].market, proposal.legs[0].selection) : 'combo';
}

/** Ligne et côté d'une sélection « Plus de 9.5 corners… » / « Moins de 2.5 buts… ». */
export function parseLine(selection: string): { side: 'over' | 'under'; line: number } | null {
  const m = selection.match(/^(plus|moins) de ([\d.,]+)/i);
  if (!m) return null;
  return { side: m[1].toLowerCase() === 'plus' ? 'over' : 'under', line: Number(m[2].replace(',', '.')) };
}

/** Probabilité du côté pour une situation de comptage, avec un rythme multiplié par k. */
function sideProb(c: CountInfo, k = 1): number {
  const over = atLeastProb(Math.max(0.001, c.lambda * k), c.fano, Math.floor(c.line) + 1 - c.done);
  return c.side === 'over' ? over : 1 - over;
}

/** Multiplicateur du rythme qui redonne la probabilité visée (dichotomie), ou null si hors de portée. */
function solveK(c: CountInfo, targetProb: number): number | null {
  const probAt = (k: number) => sideProb(c, k);
  const lo = probAt(K_MIN);
  const hi = probAt(K_MAX);
  const increasing = hi >= lo;
  const [min, max] = increasing ? [lo, hi] : [hi, lo];
  if (targetProb < min - 1e-6 || targetProb > max + 1e-6) return null;
  let a = K_MIN;
  let b = K_MAX;
  for (let i = 0; i < 30; i++) {
    const mid = Math.sqrt(a * b);
    if (probAt(mid) < targetProb === increasing) a = mid;
    else b = mid;
  }
  return Math.sqrt(a * b);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** Paires consécutives de saisies sur un même pari (même compteur, coefficient k connu). */
function pairsOf(obs: OddsObservation[]): Array<[OddsObservation, OddsObservation]> {
  const byProposal = new Map<string, OddsObservation[]>();
  for (const o of obs) if (o.count && o.k != null && o.features) byProposal.set(o.groupKey ?? o.proposalId, [...(byProposal.get(o.groupKey ?? o.proposalId) ?? []), o]);
  const pairs: Array<[OddsObservation, OddsObservation]> = [];
  for (const list of byProposal.values()) {
    const sorted = [...list].sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0));
    for (let i = 1; i < sorted.length; i++) pairs.push([sorted[i - 1], sorted[i]]);
  }
  return pairs;
}

/** Résout (A + lambda I) x = y par élimination de Gauss (petite dimension). */
function solveRidge(X: number[][], y: number[], lambda: number): number[] {
  const d = X[0].length;
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? lambda : 0)));
  const b = Array.from({ length: d }, (_, i) => X.reduce((s, r, n) => s + r[i] * y[n], 0));
  for (let i = 0; i < d; i++) {
    let p = i;
    for (let r = i + 1; r < d; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < d; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < d; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(d).fill(0);
  for (let i = d - 1; i >= 0; i--) x[i] = (b[i] - A[i].slice(i + 1).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / A[i][i];
  return x;
}

/**
 * Comment le bookmaker RÉAGIT : sur les paires de cotes d'un même pari, régression de
 * l'écart de ln(k) (son rythme implicite) sur l'écart des variables de situation. Les
 * coefficients sont fortement atténués (ridge) tant que les paires sont peu nombreuses.
 */
function fitReactions(obs: OddsObservation[]): Map<string, { b: number[]; meanF: number[]; pairs: number }> {
  const out = new Map<string, { b: number[]; meanF: number[]; pairs: number }>();
  const byUnit = new Map<string, Array<[OddsObservation, OddsObservation]>>();
  for (const pr of pairsOf(obs)) byUnit.set(pr[0].count!.unit, [...(byUnit.get(pr[0].count!.unit) ?? []), pr]);
  for (const [unit, pairs] of byUnit) {
    const feats = obs.filter((o) => o.count?.unit === unit && o.features).map((o) => o.features!);
    const meanF = FEATURE_NAMES.map((_, j) => feats.reduce((s, f) => s + f[j], 0) / Math.max(1, feats.length));
    if (pairs.length < 3) {
      out.set(unit, { b: new Array(FEATURE_NAMES.length).fill(0), meanF, pairs: pairs.length });
      continue;
    }
    const X = pairs.map(([a, b]) => b.features!.map((v, j) => v - a.features![j]));
    const y = pairs.map(([a, b]) => Math.log(b.k!) - Math.log(a.k!));
    out.set(unit, { b: solveRidge(X, y, 3), meanF, pairs: pairs.length });
  }
  return out;
}

/**
 * Correction RÉSIDUELLE : après tout le reste, la cote estimée reste souvent d'un certain pourcentage
 * au-dessus ou en dessous de la vraie. On mesure ln(cote réelle / cote estimée brute) par compteur
 * ou segment (médiane des 60 dernières saisies, atténuée vers 0 quand elles sont peu nombreuses).
 */
function fitResiduals(obs: OddsObservation[]): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const o of obs) {
    if (o.estRaw == null || !o.residKey) continue;
    groups.set(o.residKey, [...(groups.get(o.residKey) ?? []), Math.log(o.odds / Math.max(1.01, o.estRaw))]);
  }
  const out = new Map<string, number>();
  for (const [key, list] of groups) {
    const recent = list.slice(-60);
    out.set(key, (median(recent) * recent.length) / (recent.length + 4));
  }
  return out;
}

function build() {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const obs = memo ?? [];
  const kGroups = new Map<string, number[]>();
  const ratioGroups = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const o of obs) {
    const bucket = bucketOf(o.minute);
    if (o.count && o.k != null) {
      for (const key of [`${o.count.unit}|${bucket}`, `${o.count.unit}|*`]) kGroups.set(key, [...(kGroups.get(key) ?? []), o.k]);
    } else {
      const r = o.odds * o.modelProb;
      allRatios.push(r);
      for (const key of [`${o.segment}|${bucket}`, `${o.segment}|*`]) ratioGroups.set(key, [...(ratioGroups.get(key) ?? []), r]);
    }
  }
  const k = new Map<string, { k: number; n: number }>();
  for (const [key, list] of kGroups) k.set(key, { k: median(list), n: list.length });
  const ratio = new Map<string, { ratio: number; n: number }>();
  const shrink = (list: number[]) => {
    const n = list.length;
    return { ratio: (median(list) * n + PRIOR_RATIO * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT), n };
  };
  for (const [key, list] of ratioGroups) ratio.set(key, shrink(list));
  cache = { at: Date.now(), resid: fitResiduals(obs), reaction: fitReactions(obs), k, ratio, globalRatio: allRatios.length ? shrink(allRatios) : { ratio: PRIOR_RATIO, n: 0 } };
  return cache;
}

/** Cote estimée d'un pari de comptage : le rythme du modèle corrigé de ce que le bookmaker a montré. */
export function estimateCountOdds(c: CountInfo, minute: number | undefined, features?: number[]): { odds: number; raw: number; observations: number } {
  const b = build();
  const bucket = bucketOf(minute);
  const learned = b.k.get(`${c.unit}|${bucket}`) ?? b.k.get(`${c.unit}|*`);
  const p = sideProb(c);
  const prior = PRIOR_RATIO / Math.max(0.05, p);
  if (!learned) return { odds: Math.max(1.01, clampOdds(prior * Math.exp(b.resid.get(`c:${c.unit}`) ?? 0), p)), raw: Math.max(1.01, prior), observations: 0 };
  const w = Math.min(1, learned.n / FULL_WEIGHT_AT);
  // Réaction apprise du bookmaker : le rythme implicite se déplace selon ce qui a changé dans le match.
  const react = features ? b.reaction.get(c.unit) : undefined;
  let k = learned.k;
  if (react && features) {
    const shift = react.b.reduce((sum, coef, j) => sum + coef * (features[j] - react.meanF[j]), 0);
    k = Math.min(K_MAX, Math.max(K_MIN, learned.k * Math.exp(shift)));
  }
  const learnedOdds = 1 / Math.max(0.05, sideProb(c, k));
  const raw = Math.max(1.01, learnedOdds * w + prior * (1 - w));
  return { odds: Math.max(1.01, clampOdds(raw * Math.exp(b.resid.get(`c:${c.unit}`) ?? 0), p)), raw, observations: learned.n };
}

/** Cote estimée d'un pari hors comptage (1X2, BTTS…), d'après le rapport cote × probabilité. */
export function estimateBookieOdds(segment: string, prob: number, minute?: number): { odds: number; raw: number; observations: number } {
  const b = build();
  const hit = b.ratio.get(`${segment}|${bucketOf(minute)}`) ?? b.ratio.get(`${segment}|*`);
  const ratio = hit ? (hit.ratio * Math.min(1, hit.n / FULL_WEIGHT_AT) + b.globalRatio.ratio * (1 - Math.min(1, hit.n / FULL_WEIGHT_AT))) : b.globalRatio.ratio;
  const raw = Math.max(1.01, ratio / Math.max(0.05, prob));
  return { odds: Math.max(1.01, clampOdds(raw * Math.exp(b.resid.get(`s:${segment}`) ?? 0), prob)), raw, observations: hit?.n ?? 0 };
}

/** Jambe candidate : comptage si sa projection le permet, sinon rapport par segment. */
export function estimateLegOdds(
  leg: { market: TrackedMarket; selection: string; prob: number; projection?: { unit: string; observed: number; expected: number } },
  fano: number,
  minute: number | undefined,
  features?: number[]
): { odds: number; raw: number; observations: number } {
  const parsed = parseLine(leg.selection);
  if (leg.projection && parsed && /^(corners|cards|fouls|goals)_/.test(leg.projection.unit)) {
    return estimateCountOdds(
      { unit: leg.projection.unit, side: parsed.side, line: parsed.line, done: leg.projection.observed, lambda: Math.max(0.01, leg.projection.expected - leg.projection.observed), fano },
      minute,
      features
    );
  }
  return estimateBookieOdds(oddsSegment(leg.market, leg.selection), leg.prob, minute);
}

/** Un pari réel dont la cote estimée tombe sous le plancher n'est pas proposé. */
export function legOddsFloorOk(leg: Parameters<typeof estimateLegOdds>[0], fano: number, minute: number | undefined, features?: number[]): boolean {
  return estimateLegOdds(leg, fano, minute, features).odds >= MIN_ESTIMATED_ODDS;
}

/** Cote estimée affichée sur la carte d'une proposition (situation à sa création). */
export function estimateProposalOdds(proposal: InPlayProposal): { odds: number; raw: number; observations: number } {
  const minute = proposal.minute ?? (proposal.kind === 'minute60' ? 60 : proposal.kind === 'halftime' ? 45 : 20);
  if (proposal.legs.length === 1) {
    const leg = proposal.legs[0];
    return estimateLegOdds(leg, leg.projection ? getDeltaCorrection(leg.projection.unit as DeltaUnit).dispersion : 1, minute);
  }
  return estimateBookieOdds('combo', proposal.combinedProb, minute);
}

export async function recordBookieOdds(proposal: InPlayProposal, odds: number, context?: OddsContext | null): Promise<void> {
  const list = await load();
  const first = proposal.legs[0];
  const count = proposal.legs.length === 1 ? context?.count : undefined;
  const modelProb = count ? sideProb(count) : proposal.combinedProb;
  const k = count ? solveK(count, Math.min(0.98, 1 / odds)) : null;
  // Estimation faite AVANT d'apprendre de cette saisie : c'est elle qu'on compare à la vraie cote.
  const features =
    count && context ? featuresOf(count.unit, context.minute, count.done, context.stats ? { goals: context.stats.goalsHome + context.stats.goalsAway, sot: context.stats.sot, reds: context.stats.reds } : undefined) : undefined;
  const est = count ? estimateCountOdds(count, context?.minute, features) : estimateBookieOdds(proposalSegment(proposal), proposal.combinedProb, context?.minute);
  const residKey = count ? `c:${count.unit}` : `s:${proposalSegment(proposal)}`;
  const entry: OddsObservation = {
    id: `${proposal.id}@${Date.now()}`,
    proposalId: proposal.id,
    groupKey: groupKeyOf(proposal) ?? undefined,
    ts: new Date().toISOString(),
    odds,
    segment: proposalSegment(proposal),
    modelProb,
    minute: context?.minute,
    goalsNow: context?.goalsNow,
    count,
    stats: context?.stats,
    features,
    k: k ?? undefined,
    estRaw: est.raw,
    estFinal: est.odds,
    residKey,
    label: proposal.legs.map((l) => l.selection).join(' + '),
  };
  if (first?.fixtureId == null) return;
  // Toutes les saisies d'un même pari sont gardées (30e, 67e…) ; seule une répétition
  // de la même cote à la même minute est ignorée.
  const dup = list.some((o) => (o.groupKey && o.groupKey === entry.groupKey ? true : o.proposalId === proposal.id) && o.odds === odds && o.minute === entry.minute);
  const next = dup ? list : [...list, entry].slice(-MAX_OBSERVATIONS);
  memo = next;
  cache = null;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

/** Cotes saisies pour un pari, y compris celles données sur un pari identique d'un autre horaire. */
export function getObservedOddsList(proposal: InPlayProposal): OddsObservation[] {
  const key = groupKeyOf(proposal);
  return (memo ?? []).filter((o) => o.proposalId === proposal.id || (key != null && o.groupKey === key));
}

export function getOddsLearningStatus(): {
  observations: number;
  withContext: number;
  countMultipliers: Array<{ key: string; n: number; k: number }>;
  reactions: Array<{ unit: string; pairs: number; effects: Record<string, number> }>;
  ratios: Array<{ key: string; n: number; ratio: number }>;
} {
  const b = build();
  return {
    observations: memo?.length ?? 0,
    withContext: (memo ?? []).filter((o) => o.minute != null).length,
    reactions: getReactionStatus(),
    countMultipliers: Array.from(b.k.entries()).map(([key, v]) => ({ key, n: v.n, k: Math.round(v.k * 100) / 100 })),
    ratios: Array.from(b.ratio.entries()).map(([key, v]) => ({ key, n: v.n, ratio: Math.round(v.ratio * 1000) / 1000 })),
  };
}

const fmt = (x: number) => (x >= 0 ? `+${x}` : `${x}`);

/** Pourquoi la cote a bougé entre deux saisies d'un même pari : ce qui a changé dans le match. */
export function explainOddsMoves(proposal: InPlayProposal): string[] {
  const obs = getObservedOddsList(proposal).filter((o) => o.minute != null).sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0));
  const lines: string[] = [];
  for (let i = 1; i < obs.length; i++) {
    const a = obs[i - 1];
    const b = obs[i];
    const changes: string[] = [`${fmt((b.minute ?? 0) - (a.minute ?? 0))} min`];
    if (a.stats && b.stats) {
      const goals = b.stats.goalsHome + b.stats.goalsAway - (a.stats.goalsHome + a.stats.goalsAway);
      if (goals) changes.push(`${fmt(goals)} but${Math.abs(goals) > 1 ? 's' : ''}`);
      if (a.stats.corners != null && b.stats.corners != null && b.stats.corners !== a.stats.corners) changes.push(`${fmt(b.stats.corners - a.stats.corners)} corners`);
      if (a.stats.cards != null && b.stats.cards != null && b.stats.cards !== a.stats.cards) changes.push(`${fmt(b.stats.cards - a.stats.cards)} cartons`);
      if (a.stats.fouls != null && b.stats.fouls != null && b.stats.fouls !== a.stats.fouls) changes.push(`${fmt(b.stats.fouls - a.stats.fouls)} fautes`);
      if (b.stats.sot !== a.stats.sot) changes.push(`${fmt(b.stats.sot - a.stats.sot)} tirs cadrés`);
      if (b.stats.reds !== a.stats.reds) changes.push(`${fmt(b.stats.reds - a.stats.reds)} rouge`);
    }
    const rhythm = a.k != null && b.k != null ? ` · rythme du bookmaker ×${a.k.toFixed(2)} → ×${b.k.toFixed(2)}` : '';
    lines.push(`${a.minute}e → ${b.minute}e : cote ${a.odds.toFixed(2)} → ${b.odds.toFixed(2)} (${changes.join(', ')})${rhythm}`);
  }
  return lines;
}

/** Ce que l'app a appris de la réaction du bookmaker (coefficients par variable), pour le diagnostic. */
export function getReactionStatus(): Array<{ unit: string; pairs: number; effects: Record<string, number> }> {
  const b = build();
  return Array.from(b.reaction.entries()).map(([unit, r]) => ({
    unit,
    pairs: r.pairs,
    effects: Object.fromEntries(FEATURE_NAMES.map((name, j) => [name, Math.round(r.b[j] * 1000) / 1000])),
  }));
}

// ---------- Paris en attente d'une cote assez haute ----------
// Un pari dont la cote estimée est sous le plancher n'est pas proposé : il est gardé
// ici et réévalué à chaque passage. S'il atteint le plancher (la cote monte avec le
// match), il est proposé ; sinon il reste « en attente ».

const WATCH_KEY = '@odds_watchlist';
const WATCH_TTL_MS = 45 * 60_000;

export interface WatchedBet {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  selection: string;
  prob: number;
  estimatedOdds: number;
  minute: number;
  ts: number;
}

/** Remplace la liste d'attente d'un match (appelé à chaque évaluation de ce match). */
export async function setOddsWatch(fixtureId: number, entries: Omit<WatchedBet, 'fixtureId' | 'ts'>[]): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(WATCH_KEY);
    const all: WatchedBet[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    const next = [...all.filter((w) => w.fixtureId !== fixtureId && now - w.ts < WATCH_TTL_MS), ...entries.map((e) => ({ ...e, fixtureId, ts: now }))];
    await AsyncStorage.setItem(WATCH_KEY, JSON.stringify(next.slice(-60)));
  } catch {
    // best-effort
  }
}

export async function readOddsWatch(): Promise<WatchedBet[]> {
  try {
    const raw = await AsyncStorage.getItem(WATCH_KEY);
    const now = Date.now();
    return (raw ? (JSON.parse(raw) as WatchedBet[]) : []).filter((w) => now - w.ts < WATCH_TTL_MS);
  } catch {
    return [];
  }
}

export function getAllObservations(): OddsObservation[] {
  return memo ?? [];
}

export function getResidualCorrections(): Array<{ key: string; factor: number }> {
  return Array.from(build().resid.entries()).map(([key, v]) => ({ key, factor: Math.round(Math.exp(v) * 1000) / 1000 }));
}
