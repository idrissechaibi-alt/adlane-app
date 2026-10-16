// MOTEUR DE MOTIFS (statistiques seules, aucune IA).
//
// Chaque match terminé (fictif ou réel) dont on a la chronologie est « rejoué » à 5 moments : 15e, 30e, mi-temps, 60e, 75e.
// À chaque moment, on note la SITUATION (déclencheurs : score et minute, rythme des stats, favori, équipes / compos) et ce qui
// s'est passé ENSUITE (cibles : au moins k buts / corners / cartons jusqu'à la fin, but avant la pause, les deux marquent).
//
// Pour chaque trio (moment, déclencheur, cible), on compte n et le nombre de fois où la cible s'est produite. Le taux est
// comparé au taux de base du même moment (tous matchs confondus). Un MOTIF est retenu quand n ≥ 50 et que l'écart au taux de
// base atteint 10 points. Il corrige alors la probabilité des paris concernés : d'abord sur le pipe fictif, puis sur le réel
// quand il se confirme (n ≥ 100). Chaque pari réglé reçoit une explication chiffrée : pourquoi il a réussi ou raté.

import AsyncStorage from '@react-native-async-storage/async-storage';

export const CHECKPOINTS = [15, 30, 45, 60, 75] as const;
const MIN_PATTERN_SAMPLES = 50;
const MIN_REAL_SAMPLES = 100;
const MIN_DELTA = 0.1;
const ADJUST_WEIGHT = 0.5;
const COUNTS_KEY = '@pattern_counts';
const INGESTED_KEY = '@pattern_ingested';
const EXPLAIN_KEY = '@leg_explanations';

/** Un instant du match (cumul depuis le coup d'envoi). */
export interface MatchPoint {
  minute: number;
  h: number;
  a: number;
  sot?: number;
  corners?: number;
  cards?: number;
}

export interface MatchFinal {
  h: number;
  a: number;
  htH?: number;
  htA?: number;
  corners?: number;
  cards?: number;
}

/** Contexte connu en dehors de la chronologie (pipe réel surtout). */
export interface MatchExtra {
  /** Favori d'avant-match. */
  favSide?: 'h' | 'a' | null;
  /** Total de buts attendu d'après la tendance des deux équipes. */
  trendGoals?: number | null;
  /** Titulaires habituels absents (compo officielle). */
  keyAbsent?: number | null;
  /** Système de jeu inhabituel pour au moins une équipe. */
  formationChanged?: boolean | null;
}

const CONDITION_LABELS: Record<string, string> = {
  g0: 'aucun but',
  g1: '1 seul but',
  g2: '2 buts ou plus',
  diff2: "2 buts d'écart ou plus",
  drawGoals: 'nul avec des buts',
  homeTrail: 'domicile mené',
  awayTrail: 'extérieur mené',
  sotHigh: 'beaucoup de tirs cadrés',
  sotLow: 'très peu de tirs cadrés',
  cornHigh: 'rythme de corners élevé',
  cornLow: 'rythme de corners faible',
  cardHigh: 'beaucoup de cartons',
  cardNone: 'aucun carton',
  favTrail: 'favori mené',
  favLead: 'favori devant',
  prolific: 'deux équipes prolifiques (tendance)',
  tight: 'deux équipes fermées (tendance)',
  keyAbsent: 'titulaires clés absents',
  formation: 'système de jeu inhabituel',
};

const TARGET_LABELS = (t: string): string => {
  const m = /^(goals|corners|cards)_rem(\d+)$/.exec(t);
  if (m) return `au moins ${m[2]} ${m[1] === 'goals' ? 'but(s)' : m[1] === 'corners' ? 'corner(s)' : 'carton(s) jaune(s)'} ensuite`;
  if (t === 'htGoal') return 'un but avant la pause';
  if (t === 'btts') return 'les deux équipes marquent';
  return t;
};

/** Déclencheurs actifs à un instant. */
export function conditionsAt(p: MatchPoint, extra?: MatchExtra): string[] {
  const out: string[] = [];
  const g = p.h + p.a;
  const min = Math.max(1, p.minute);
  out.push(g === 0 ? 'g0' : g === 1 ? 'g1' : 'g2');
  if (Math.abs(p.h - p.a) >= 2) out.push('diff2');
  if (p.h === p.a && g >= 2) out.push('drawGoals');
  if (p.h < p.a) out.push('homeTrail');
  if (p.a < p.h) out.push('awayTrail');
  if (p.sot != null) {
    if (p.sot / min >= 0.15) out.push('sotHigh');
    else if (p.sot / min <= 0.05) out.push('sotLow');
  }
  if (p.corners != null) {
    if (p.corners / min >= 0.13) out.push('cornHigh');
    else if (p.corners / min <= 0.05) out.push('cornLow');
  }
  if (p.cards != null) {
    if (p.cards / min >= 0.05) out.push('cardHigh');
    else if (p.cards === 0 && p.minute >= 30) out.push('cardNone');
  }
  if (extra?.favSide) {
    const favGoals = extra.favSide === 'h' ? p.h : p.a;
    const other = extra.favSide === 'h' ? p.a : p.h;
    if (favGoals < other) out.push('favTrail');
    if (favGoals > other) out.push('favLead');
  }
  if (extra?.trendGoals != null) {
    if (extra.trendGoals >= 3.1) out.push('prolific');
    else if (extra.trendGoals <= 2.2) out.push('tight');
  }
  if ((extra?.keyAbsent ?? 0) >= 2) out.push('keyAbsent');
  if (extra?.formationChanged) out.push('formation');
  return out;
}

/** Cibles atteintes (ou non) après un instant, d'après le résultat final. */
function targetsAfter(p: MatchPoint, f: MatchFinal, checkpoint: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const g = p.h + p.a;
  const gRem = f.h + f.a - g;
  for (let k = 1; k <= 4; k++) out[`goals_rem${k}`] = gRem >= k;
  if (p.corners != null && f.corners != null) {
    const r = f.corners - p.corners;
    for (let k = 1; k <= 8; k++) out[`corners_rem${k}`] = r >= k;
  }
  if (p.cards != null && f.cards != null) {
    const r = f.cards - p.cards;
    for (let k = 1; k <= 4; k++) out[`cards_rem${k}`] = r >= k;
  }
  if (checkpoint < 45 && f.htH != null && f.htA != null && g === 0) out.htGoal = f.htH + f.htA > 0;
  if (!(p.h > 0 && p.a > 0)) out.btts = f.h > 0 && f.a > 0;
  return out;
}

type Counts = Record<string, [number, number]>; // clé -> [n, réussites]
let counts: Counts | null = null;
let ingested: Set<string> | null = null;

async function load(): Promise<void> {
  if (counts && ingested) return;
  try {
    counts = JSON.parse((await AsyncStorage.getItem(COUNTS_KEY)) ?? '{}');
  } catch {
    counts = {};
  }
  try {
    ingested = new Set(JSON.parse((await AsyncStorage.getItem(INGESTED_KEY)) ?? '[]'));
  } catch {
    ingested = new Set();
  }
}

async function save(): Promise<void> {
  try {
    await AsyncStorage.setItem(COUNTS_KEY, JSON.stringify(counts));
    // Identifiants des matchs déjà rejoués : les plus récents suffisent à éviter un double comptage.
    await AsyncStorage.setItem(INGESTED_KEY, JSON.stringify([...ingested!].slice(-20_000)));
  } catch {
    // best-effort
  }
}

/** Point de la chronologie le plus proche d'un moment (au plus 8 minutes avant). */
function pointAt(timeline: MatchPoint[], checkpoint: number): MatchPoint | null {
  let best: MatchPoint | null = null;
  for (const p of timeline) {
    if (p.minute <= checkpoint && p.minute >= checkpoint - 8 && (!best || p.minute > best.minute)) best = p;
  }
  return best;
}

/** Rejoue un match terminé (une seule fois par identifiant) et met à jour les compteurs. */
export async function ingestMatch(id: string, timeline: MatchPoint[], final: MatchFinal, extra?: MatchExtra): Promise<boolean> {
  await load();
  if (ingested!.has(id) || timeline.length < 2) return false;
  ingested!.add(id);
  for (const cp of CHECKPOINTS) {
    const p = pointAt(timeline, cp);
    if (!p) continue;
    const targets = targetsAfter(p, final, cp);
    const conds = ['*', ...conditionsAt(p, extra)];
    for (const [t, hit] of Object.entries(targets)) {
      for (const c of conds) {
        const k = `${cp}|${c}|${t}`;
        const cell = (counts![k] ??= [0, 0]);
        cell[0] += 1;
        if (hit) cell[1] += 1;
      }
    }
  }
  return true;
}

export async function flushPatterns(): Promise<void> {
  if (counts) await save();
}

export interface Pattern {
  checkpoint: number;
  condition: string;
  conditionLabel: string;
  target: string;
  targetLabel: string;
  market: 'buts' | 'corners' | 'cartons' | 'mi-temps' | 'btts';
  n: number;
  rate: number;
  baseRate: number;
  delta: number;
  /** n ≥ 50 et écart ≥ 10 points : utilisé pour corriger les pronos (réel à partir de n ≥ 100). */
  validated: boolean;
  /** Assez solide pour le pipe réel. */
  real: boolean;
}

const marketOf = (t: string): Pattern['market'] =>
  t.startsWith('goals') ? 'buts' : t.startsWith('corners') ? 'corners' : t.startsWith('cards') ? 'cartons' : t === 'htGoal' ? 'mi-temps' : 'btts';

/** Tous les motifs mesurés (validés et émergents), les plus marqués d'abord. */
export async function getPatterns(minSamples = 20): Promise<Pattern[]> {
  await load();
  const out: Pattern[] = [];
  for (const [k, [n, hit]] of Object.entries(counts!)) {
    const [cp, cond, target] = k.split('|');
    if (cond === '*' || n < minSamples) continue;
    const base = counts![`${cp}|*|${target}`];
    if (!base || base[0] < n) continue;
    const rate = hit / n;
    const baseRate = base[1] / base[0];
    const delta = rate - baseRate;
    out.push({
      checkpoint: Number(cp),
      condition: cond,
      conditionLabel: CONDITION_LABELS[cond] ?? cond,
      target,
      targetLabel: TARGET_LABELS(target),
      market: marketOf(target),
      n,
      rate,
      baseRate,
      delta,
      validated: n >= MIN_PATTERN_SAMPLES && Math.abs(delta) >= MIN_DELTA,
      real: n >= MIN_REAL_SAMPLES && Math.abs(delta) >= MIN_DELTA,
    });
  }
  return out.sort((x, y) => Number(y.validated) - Number(x.validated) || Math.abs(y.delta) - Math.abs(x.delta));
}

export function describePattern(p: Pattern): string {
  const moment = p.checkpoint === 45 ? 'à la mi-temps' : `à la ${p.checkpoint}e`;
  return `Quand il y a « ${p.conditionLabel} » ${moment} : ${p.targetLabel} dans ${Math.round(p.rate * 100)} % des cas (${p.n} matchs), contre ${Math.round(p.baseRate * 100)} % en moyenne (${p.delta >= 0 ? '+' : ''}${Math.round(p.delta * 100)} pts).`;
}

/** Cible correspondant à une jambe (« Plus de 2.5 buts » à 1 but déjà marqué → au moins 2 buts ensuite). */
export function targetForLeg(market: string, selection: string, done: number): { target: string; eventSide: boolean } | null {
  const m = selection.match(/^(plus|moins) de\s+([\d.,]+)/i);
  const over = m ? m[1].toLowerCase() === 'plus' : null;
  if (market === 'btts') return { target: 'btts', eventSide: !/\(non\)|ne marque pas/i.test(selection) };
  if (market === 'buts_1ere_mt') return { target: 'htGoal', eventSide: !/0-0|pas de but/i.test(selection) };
  if (!m || over == null) return null;
  if (!/sur le match|total match/i.test(selection) && market !== 'total_buts') return null; // fenêtres 1ère MT : non couvertes
  const line = Number(m[2].replace(',', '.'));
  const k = Math.floor(line) + 1 - done;
  const unit = market === 'total_buts' ? 'goals' : market === 'corners' ? 'corners' : market === 'cartons' ? 'cards' : null;
  if (!unit || k < 1) return null;
  const max = unit === 'corners' ? 8 : 4;
  if (k > max) return null;
  return { target: `${unit}_rem${k}`, eventSide: over };
}

/**
 * Correction d'une probabilité par les motifs validés de la situation actuelle. Renvoie la nouvelle probabilité et la note
 * à ajouter à l'argumentaire, ou null si aucun motif ne s'applique.
 */
export async function patternAdjust(
  market: string,
  selection: string,
  prob: number,
  point: MatchPoint,
  real: boolean,
  done: number,
  extra?: MatchExtra
): Promise<{ prob: number; note: string } | null> {
  const t = targetForLeg(market, selection, done);
  if (!t) return null;
  const cp = [...CHECKPOINTS].reverse().find((c) => c <= point.minute && point.minute - c <= 12);
  if (cp == null) return null;
  const conds = conditionsAt(point, extra);
  const all = await getPatterns(MIN_PATTERN_SAMPLES);
  const hits = all.filter((p) => p.checkpoint === cp && p.target === t.target && conds.includes(p.condition) && (real ? p.real : p.validated));
  if (hits.length === 0) return null;
  // Moyenne des écarts des motifs actifs (plusieurs déclencheurs disent souvent la même chose).
  const delta = hits.reduce((s, p) => s + p.delta, 0) / hits.length;
  const eventDelta = ADJUST_WEIGHT * delta;
  const adjusted = Math.max(0.02, Math.min(0.97, prob + (t.eventSide ? eventDelta : -eventDelta)));
  const best = hits.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))[0];
  return {
    prob: adjusted,
    note: ` Motif appris : ${describePattern(best)} Probabilité ${prob >= adjusted ? 'abaissée' : 'relevée'} de ${Math.round(Math.abs(adjusted - prob) * 100)} pts.`,
  };
}

export interface LegExplanation {
  at: string;
  day: string;
  real: boolean;
  match: string;
  selection: string;
  won: boolean;
  prob: number;
  text: string;
}

/**
 * Pourquoi un pari a réussi ou raté, en chiffres : écart entre ce qui était projeté et ce qui s'est passé, puis motifs connus de
 * la situation au moment du pari (favorables ou défavorables), sinon « variance normale ».
 */
export async function explainSettledLeg(args: {
  day: string;
  real: boolean;
  match: string;
  market: string;
  selection: string;
  prob: number;
  won: boolean;
  point: MatchPoint | null;
  expected?: number;
  actual?: number;
  unitLabel?: string;
}): Promise<LegExplanation> {
  const parts: string[] = [];
  if (args.expected != null && args.actual != null) {
    const diff = args.actual - args.expected;
    const noun = args.unitLabel ?? '';
    if (Math.abs(diff) >= 1.5) parts.push(`le match a été nettement ${diff > 0 ? 'plus ouvert' : 'plus fermé'} que projeté (${args.expected.toFixed(1)} ${noun} attendus, ${args.actual} réels)`);
    else parts.push(`projection proche du réel (${args.expected.toFixed(1)} ${noun} attendus, ${args.actual} réels)`);
  }
  if (args.point) {
    const done = args.market === 'total_buts' ? args.point.h + args.point.a : args.market === 'corners' ? args.point.corners ?? 0 : args.market === 'cartons' ? args.point.cards ?? 0 : 0;
    const t = targetForLeg(args.market, args.selection, done);
    const cp = [...CHECKPOINTS].reverse().find((c) => c <= args.point!.minute && args.point!.minute - c <= 12);
    if (t && cp != null) {
      const conds = conditionsAt(args.point);
      const ps = (await getPatterns(30)).filter((p) => p.checkpoint === cp && p.target === t.target && conds.includes(p.condition) && Math.abs(p.delta) >= MIN_DELTA);
      const against = ps.filter((p) => (t.eventSide ? p.delta < 0 : p.delta > 0));
      const forIt = ps.filter((p) => (t.eventSide ? p.delta > 0 : p.delta < 0));
      if (!args.won && against.length) parts.push(`un motif connu allait contre ce pari : ${describePattern(against[0])}`);
      else if (args.won && forIt.length) parts.push(`motif favorable confirmé : ${describePattern(forIt[0])}`);
      else if (!args.won && forIt.length) parts.push(`raté malgré un motif favorable (${forIt[0].conditionLabel}) : cas rare, à surveiller`);
    }
  }
  if (parts.length === 0) parts.push(`aucun motif connu dans cette situation : résultat dans la variance normale (annoncé à ${Math.round(args.prob * 100)} %)`);
  const e: LegExplanation = {
    at: new Date().toISOString(),
    day: args.day,
    real: args.real,
    match: args.match,
    selection: args.selection,
    won: args.won,
    prob: args.prob,
    text: `${args.won ? 'Réussi' : 'Raté'} — ${parts.join(' ; ')}.`,
  };
  return e;
}

export async function saveExplanations(list: LegExplanation[]): Promise<void> {
  if (list.length === 0) return;
  try {
    const old: LegExplanation[] = JSON.parse((await AsyncStorage.getItem(EXPLAIN_KEY)) ?? '[]');
    const seen = new Set(old.map((e) => `${e.day}|${e.match}|${e.selection}`));
    const fresh = list.filter((e) => !seen.has(`${e.day}|${e.match}|${e.selection}`));
    await AsyncStorage.setItem(EXPLAIN_KEY, JSON.stringify([...old, ...fresh].slice(-3000)));
  } catch {
    // best-effort
  }
}

export async function readExplanations(): Promise<LegExplanation[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(EXPLAIN_KEY)) ?? '[]');
  } catch {
    return [];
  }
}

/** Nombre de matchs déjà rejoués (diagnostic). */
export async function patternStatus(): Promise<{ matches: number; cells: number; validated: number; realReady: number }> {
  await load();
  const ps = await getPatterns(MIN_PATTERN_SAMPLES);
  return { matches: ingested!.size, cells: Object.keys(counts!).length, validated: ps.filter((p) => p.validated).length, realReady: ps.filter((p) => p.real).length };
}
