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
import { DeltaUnit, getDeltaCorrection } from './deltaLearning';

const KEY = '@bookie_odds_observations_v2';
const MAX_OBSERVATIONS = 1000;
const PRIOR_RATIO = 0.92;
const PRIOR_WEIGHT = 4;
/** Observations à partir desquelles le rapport appris remplace entièrement la valeur de départ. */
const FULL_WEIGHT_AT = 6;
const K_MIN = 0.3;
const K_MAX = 3;
/** Cote estimée minimale pour qu'un pari réel soit proposé. */
export const MIN_ESTIMATED_ODDS = 1.3;

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

/** Contexte relevé au moment où la cote est saisie. */
export interface OddsContext {
  minute: number;
  goalsNow: number;
  count?: CountInfo;
}

export interface OddsObservation {
  id: string;
  proposalId: string;
  ts: string;
  odds: number;
  segment: string;
  /** Probabilité du modèle à cet instant (recalculée pour un comptage, sinon celle de la proposition). */
  modelProb: number;
  minute?: number;
  goalsNow?: number;
  count?: CountInfo;
  /** Multiplicateur du rythme du modèle qui redonne 1/cote (comptages). */
  k?: number;
  label: string;
}

let memo: OddsObservation[] | null = null;
let cache: { at: number; k: Map<string, { k: number; n: number }>; ratio: Map<string, { ratio: number; n: number }>; globalRatio: { ratio: number; n: number } } | null = null;

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
  cache = { at: Date.now(), k, ratio, globalRatio: allRatios.length ? shrink(allRatios) : { ratio: PRIOR_RATIO, n: 0 } };
  return cache;
}

/** Cote estimée d'un pari de comptage : le rythme du modèle corrigé de ce que le bookmaker a montré. */
export function estimateCountOdds(c: CountInfo, minute: number | undefined): { odds: number; observations: number } {
  const b = build();
  const bucket = bucketOf(minute);
  const learned = b.k.get(`${c.unit}|${bucket}`) ?? b.k.get(`${c.unit}|*`);
  const p = sideProb(c);
  const prior = PRIOR_RATIO / Math.max(0.05, p);
  if (!learned) return { odds: Math.max(1.01, prior), observations: 0 };
  const w = Math.min(1, learned.n / FULL_WEIGHT_AT);
  const learnedOdds = 1 / Math.max(0.05, sideProb(c, learned.k));
  return { odds: Math.max(1.01, learnedOdds * w + prior * (1 - w)), observations: learned.n };
}

/** Cote estimée d'un pari hors comptage (1X2, BTTS…), d'après le rapport cote × probabilité. */
export function estimateBookieOdds(segment: string, prob: number, minute?: number): { odds: number; observations: number } {
  const b = build();
  const hit = b.ratio.get(`${segment}|${bucketOf(minute)}`) ?? b.ratio.get(`${segment}|*`);
  const ratio = hit ? (hit.ratio * Math.min(1, hit.n / FULL_WEIGHT_AT) + b.globalRatio.ratio * (1 - Math.min(1, hit.n / FULL_WEIGHT_AT))) : b.globalRatio.ratio;
  return { odds: Math.max(1.01, ratio / Math.max(0.05, prob)), observations: hit?.n ?? 0 };
}

/** Jambe candidate : comptage si sa projection le permet, sinon rapport par segment. */
export function estimateLegOdds(
  leg: { market: TrackedMarket; selection: string; prob: number; projection?: { unit: string; observed: number; expected: number } },
  fano: number,
  minute: number | undefined
): { odds: number; observations: number } {
  const parsed = parseLine(leg.selection);
  if (leg.projection && parsed && /^(corners|cards|fouls|goals)_/.test(leg.projection.unit)) {
    return estimateCountOdds(
      { unit: leg.projection.unit, side: parsed.side, line: parsed.line, done: leg.projection.observed, lambda: Math.max(0.01, leg.projection.expected - leg.projection.observed), fano },
      minute
    );
  }
  return estimateBookieOdds(oddsSegment(leg.market, leg.selection), leg.prob, minute);
}

/** Un pari réel dont la cote estimée tombe sous le plancher n'est pas proposé. */
export function legOddsFloorOk(leg: Parameters<typeof estimateLegOdds>[0], fano: number, minute: number | undefined): boolean {
  return estimateLegOdds(leg, fano, minute).odds >= MIN_ESTIMATED_ODDS;
}

/** Cote estimée affichée sur la carte d'une proposition (situation à sa création). */
export function estimateProposalOdds(proposal: InPlayProposal): { odds: number; observations: number } {
  const minute = proposal.kind === 'minute60' ? 60 : 20;
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
  const entry: OddsObservation = {
    id: `${proposal.id}@${Date.now()}`,
    proposalId: proposal.id,
    ts: new Date().toISOString(),
    odds,
    segment: proposalSegment(proposal),
    modelProb,
    minute: context?.minute,
    goalsNow: context?.goalsNow,
    count,
    k: k ?? undefined,
    label: proposal.legs.map((l) => l.selection).join(' + '),
  };
  if (first?.fixtureId == null) return;
  // Toutes les saisies d'un même pari sont gardées (30e, 67e…) ; seule une répétition
  // de la même cote à la même minute est ignorée.
  const dup = list.some((o) => o.proposalId === proposal.id && o.odds === odds && o.minute === entry.minute);
  const next = dup ? list : [...list, entry].slice(-MAX_OBSERVATIONS);
  memo = next;
  cache = null;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

export function getObservedOddsList(proposalId: string): OddsObservation[] {
  return (memo ?? []).filter((o) => o.proposalId === proposalId);
}

export function getOddsLearningStatus(): {
  observations: number;
  withContext: number;
  countMultipliers: Array<{ key: string; n: number; k: number }>;
  ratios: Array<{ key: string; n: number; ratio: number }>;
} {
  const b = build();
  return {
    observations: memo?.length ?? 0,
    withContext: (memo ?? []).filter((o) => o.minute != null).length,
    countMultipliers: Array.from(b.k.entries()).map(([key, v]) => ({ key, n: v.n, k: Math.round(v.k * 100) / 100 })),
    ratios: Array.from(b.ratio.entries()).map(([key, v]) => ({ key, n: v.n, ratio: Math.round(v.ratio * 1000) / 1000 })),
  };
}
