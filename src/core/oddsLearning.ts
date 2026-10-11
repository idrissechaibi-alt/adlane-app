// Apprentissage des COTES du bookmaker : l'utilisateur saisit la cote qu'il voit
// pour un pari (sans le placer), l'app la compare à sa propre probabilité et
// apprend, par type de pari, le rapport « cote × probabilité » du bookmaker.
// Elle sait alors estimer la cote qu'un pari aura, et n'en propose plus dont la
// cote estimée est trop faible.
//
// rapport = cote saisie × probabilité du modèle. Avec un modèle juste et un
// bookmaker sans marge, il vaudrait 1 ; en pratique ≈ 0,9. Mesuré, jamais supposé
// une fois assez d'observations (la valeur de départ ne pèse que PRIOR_WEIGHT).

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { InPlayProposal, TrackedMarket } from './learnStore';

const KEY = '@bookie_odds_observations';
const MAX_OBSERVATIONS = 800;
/** Rapport cote × probabilité supposé avant toute observation (marge d'environ 8 %). */
const PRIOR_RATIO = 0.92;
/** Poids de cette valeur de départ, en nombre d'observations. */
const PRIOR_WEIGHT = 4;
/** Cote estimée minimale pour qu'un pari réel soit proposé. */
export const MIN_ESTIMATED_ODDS = 1.3;

export interface OddsObservation {
  /** Une observation par proposition : la saisie la plus récente remplace la précédente. */
  proposalId: string;
  ts: string;
  segment: string;
  modelProb: number;
  odds: number;
  minute?: number;
  fixtureId?: number;
  label: string;
}

let memo: OddsObservation[] | null = null;
let ratioCache: { at: number; bySegment: Map<string, { ratio: number; n: number }>; global: { ratio: number; n: number } } | null = null;

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

/** Segment d'un pari : marché, côté, fenêtre. Un combiné forme son propre segment. */
export function oddsSegment(market: TrackedMarket, selection: string): string {
  const side = /^plus/i.test(selection) ? 'over' : /^moins|^0-0|\(non\)|ne marquent pas/i.test(selection) ? 'under' : 'yes';
  const window = /sur le match|total match/i.test(selection) ? 'ft' : /mi-temps|pause|1ère/i.test(selection) ? '1h' : 'ft';
  return `${market}|${side}|${window}`;
}

export function proposalSegment(proposal: InPlayProposal): string {
  return proposal.legs.length === 1 ? oddsSegment(proposal.legs[0].market, proposal.legs[0].selection) : 'combo';
}

function ratios() {
  if (ratioCache && Date.now() - ratioCache.at < 60_000) return ratioCache;
  const obs = memo ?? [];
  const agg = (list: OddsObservation[]) => {
    // Médiane : une cote saisie à tort ne fausse pas tout.
    const rs = list.map((o) => o.odds * o.modelProb).sort((a, b) => a - b);
    const med = rs.length ? (rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2) : PRIOR_RATIO;
    const n = rs.length;
    return { ratio: (med * n + PRIOR_RATIO * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT), n };
  };
  const bySegment = new Map<string, { ratio: number; n: number }>();
  const groups = new Map<string, OddsObservation[]>();
  for (const o of obs) groups.set(o.segment, [...(groups.get(o.segment) ?? []), o]);
  const global = agg(obs);
  for (const [seg, list] of groups) {
    const a = agg(list);
    // Peu d'observations sur ce segment : on s'appuie sur le rapport global.
    const w = Math.min(1, list.length / 6);
    bySegment.set(seg, { ratio: a.ratio * w + global.ratio * (1 - w), n: list.length });
  }
  ratioCache = { at: Date.now(), bySegment, global };
  return ratioCache;
}

/** Cote estimée du bookmaker pour un pari de probabilité `prob`. */
export function estimateBookieOdds(segment: string, prob: number): { odds: number; observations: number } {
  const r = ratios();
  const seg = r.bySegment.get(segment);
  const ratio = seg?.ratio ?? r.global.ratio;
  return { odds: Math.max(1.01, ratio / Math.max(0.05, prob)), observations: seg?.n ?? 0 };
}

/** Un pari réel dont la cote estimée tombe sous le plancher n'est pas proposé. */
export function oddsFloorOk(segment: string, prob: number): boolean {
  return estimateBookieOdds(segment, prob).odds >= MIN_ESTIMATED_ODDS;
}

export async function recordBookieOdds(proposal: InPlayProposal, odds: number): Promise<void> {
  const list = await load();
  const first = proposal.legs[0];
  const entry: OddsObservation = {
    proposalId: proposal.id,
    ts: new Date().toISOString(),
    segment: proposalSegment(proposal),
    modelProb: proposal.combinedProb,
    odds,
    fixtureId: first?.fixtureId,
    label: proposal.legs.map((l) => l.selection).join(' + '),
  };
  const next = [...list.filter((o) => o.proposalId !== proposal.id), entry].slice(-MAX_OBSERVATIONS);
  memo = next;
  ratioCache = null;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

export function getObservedOdds(proposalId: string): OddsObservation | undefined {
  return (memo ?? []).find((o) => o.proposalId === proposalId);
}

export function getOddsLearningStatus(): { observations: number; globalRatio: number; segments: Array<{ segment: string; n: number; ratio: number }> } {
  const r = ratios();
  return {
    observations: memo?.length ?? 0,
    globalRatio: Math.round(r.global.ratio * 1000) / 1000,
    segments: Array.from(r.bySegment.entries()).map(([segment, v]) => ({ segment, n: v.n, ratio: Math.round(v.ratio * 1000) / 1000 })),
  };
}
