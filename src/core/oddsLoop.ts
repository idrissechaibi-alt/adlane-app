// Boucle d'apprentissage des COTES : l'app apprend à coter comme le bookmaker de l'utilisateur.
//
// À chaque cote saisie :
//   1. l'app note la cote qu'elle AURAIT donnée (avant d'apprendre de cette saisie) ;
//   2. elle mesure l'écart avec la vraie cote (en %) ;
//   3. elle en apprend (oddsLearning.ts : rythme implicite du bookmaker par compteur et tranche
//      de minutes, réaction aux buts / tirs / rouges, correction résiduelle) ;
//   4. elle cherche POURQUOI l'écart existe (par marché, tranche de minutes, niveau de
//      probabilité, côté) et met à jour le fichier de la boucle.
//
// Score d'alignement = 100 × (1 − écart absolu moyen / 40 %), borné à 0-100. Il se calcule sur les
// estimations faites AVANT d'apprendre de chaque saisie : un score honnête, pas un score appris par cœur.

import AsyncStorage from './kvStore';
import type { InPlayProposal } from './learnStore';
import {
  OddsContext,
  OddsObservation,
  bucketOf,
  getAllObservations,
  getOddsLearningStatus,
  getResidualCorrections,
  oddsSegment,
  recordBookieOdds,
  setRefCorrections,
} from './oddsLearning';

const FILE_KEY = '@odds_learning_file';
const REF_KEY = '@ref_odds_comparisons';
const REF_MAX = 50_000; // aucun plafond pratique : tout l'historique des cotes lues en ligne est gardé
const HISTORY_MAX = 300;
const SCORE_FULL_ERROR = 0.4;

export interface AlignmentPoint {
  n: number;
  ts: string;
  /** Écart absolu moyen (en fraction, 0,12 = 12 %) sur les saisies jusque-là. */
  mape: number;
  score: number;
  bias: number;
}

export interface GroupDelta {
  label: string;
  n: number;
  /** Écart signé moyen : (estimée − réelle) / réelle. Positif = l'app surestime la cote. */
  bias: number;
  mape: number;
}

/** Cote de l'app comparée à une cote de référence gratuite (bet365 via 365Scores). */
export interface RefComparison {
  ts: string;
  key: string;
  market: string;
  selection: string;
  minute: number;
  modelProb: number;
  /** Cote que le modèle de l'app estimait, sans la cote de référence. */
  estModel: number;
  /** Cote bet365 lue à ce moment. */
  ref: number;
}

export interface RefAlignment {
  n: number;
  score: number | null;
  meanAbsDeltaPct: number | null;
  biasPct: number | null;
  byMarket: GroupDelta[];
}

export interface OddsLoopFile {
  updatedAt: string;
  observations: number;
  scored: number;
  /** Score d'alignement 0-100 (null tant qu'aucune saisie n'a été comparée). */
  score: number | null;
  /** Écart absolu moyen global, en %. */
  meanAbsDeltaPct: number | null;
  /** Écart signé moyen global, en % (positif = cotes de l'app trop hautes). */
  biasPct: number | null;
  /** Score sur les 15 dernières saisies et tendance par rapport aux 15 précédentes. */
  recentScore: number | null;
  trend: 'en progrès' | 'stable' | 'en recul' | 'trop tôt';
  bySegment: GroupDelta[];
  byMinute: GroupDelta[];
  byProbability: GroupDelta[];
  /** Pourquoi les cotes de l'app s'écartent encore de celles du bookmaker. */
  reasons: string[];
  /** Alignement du modèle avec bet365 sur le 1X2 et le total de buts (cotes lues automatiquement). */
  vsBet365: RefAlignment;
  /** Ce que l'app a appris à ce jour (rythme implicite, réactions, corrections). */
  learned: ReturnType<typeof getOddsLearningStatus> & { residuals: Array<{ key: string; factor: number }> };
  history: AlignmentPoint[];
}

const pct = (x: number) => Math.round(x * 1000) / 10;

function delta(o: OddsObservation): number | null {
  // Écart plafonné à ±150 % : une cote saisie à tort ne ruine pas le score.
  return o.estFinal != null && o.odds > 1 ? Math.max(-1.5, Math.min(1.5, (o.estFinal - o.odds) / o.odds)) : null;
}

const scoreOf = (mape: number) => Math.round(Math.max(0, Math.min(1, 1 - mape / SCORE_FULL_ERROR)) * 100);

function group(obs: OddsObservation[], keyOf: (o: OddsObservation) => string): GroupDelta[] {
  const map = new Map<string, number[]>();
  for (const o of obs) {
    const d = delta(o);
    if (d == null) continue;
    const k = keyOf(o);
    map.set(k, [...(map.get(k) ?? []), d]);
  }
  return Array.from(map.entries())
    .map(([label, ds]) => ({
      label,
      n: ds.length,
      bias: pct(ds.reduce((a, b) => a + b, 0) / ds.length),
      mape: pct(ds.reduce((a, b) => a + Math.abs(b), 0) / ds.length),
    }))
    .sort((a, b) => b.n - a.n);
}

const SEGMENT_LABEL: Record<string, string> = {
  corners: 'corners', cartons: 'cartons', fautes: 'fautes', tirs_cadres: 'tirs cadrés joueur', total_buts: 'total de buts', btts: 'les deux équipes marquent', '1X2': '1X2', buts_1ere_mt: 'but en 1ère mi-temps', combo: 'combinés',
};
function segmentLabel(o: OddsObservation): string {
  if (o.count) return `${SEGMENT_LABEL[o.segment.split('|')[0]] ?? o.segment.split('|')[0]} ${o.count.unit.endsWith('_1h') ? '(1ère MT)' : '(match)'} · ${o.count.side === 'over' ? 'Plus de' : 'Moins de'}`;
  const [market, side, window] = o.segment.split('|');
  return market === 'combo' ? 'combinés' : `${SEGMENT_LABEL[market] ?? market}${window === '1h' ? ' (1ère MT)' : ''}${side === 'under' ? ' · Moins/Non' : ''}`;
}
const MINUTE_LABEL = { a: 'minutes 0-30', b: 'minutes 31-60', c: 'minutes 61-90' } as const;
const probBin = (p: number) => (p < 0.55 ? 'probabilité < 55 %' : p < 0.7 ? 'probabilité 55-70 %' : 'probabilité ≥ 70 %');

/** Pourquoi l'écart existe : les groupes où l'app se trompe le plus, dans quel sens, et ce que le bookmaker semble faire. */
function explain(file: Pick<OddsLoopFile, 'bySegment' | 'byMinute' | 'byProbability' | 'learned' | 'biasPct'>): string[] {
  const reasons: string[] = [];
  const say = (g: GroupDelta, why: string) => reasons.push(`${g.label} : l'app ${g.bias > 0 ? 'surestime' : 'sous-estime'} la cote de ${Math.abs(g.bias)} % en moyenne (${g.n} cotes). ${why}`);
  const worst = (gs: GroupDelta[]) => gs.filter((g) => g.n >= 3 && Math.abs(g.bias) >= 5).sort((a, b) => Math.abs(b.bias) * Math.sqrt(b.n) - Math.abs(a.bias) * Math.sqrt(a.n))[0];

  const seg = worst(file.bySegment);
  if (seg) say(seg, seg.bias > 0 ? 'Le bookmaker cote ce pari plus bas que moi : il le juge plus probable ou prend moins de marge.' : 'Le bookmaker cote ce pari plus haut que moi : il le juge moins probable ou garde une marge plus forte.');
  const min = worst(file.byMinute);
  if (min) say(min, min.label.includes('61') ? 'En fin de match le bookmaker réagit plus vite au score et au temps qui reste.' : min.label.includes('0-30') ? 'Début de match : peu de données pour juger le rythme, le bookmaker reste proche de ses moyennes.' : 'Autour de la mi-temps, son rythme implicite bouge avec les événements du match.');
  const prob = worst(file.byProbability);
  if (prob) say(prob, prob.label.includes('≥ 70') ? 'Les paris très probables : sa marge pèse davantage sur les petites cotes.' : 'Zone intermédiaire : l\'écart vient surtout de la différence entre ma probabilité et la sienne.');
  if (file.biasPct != null && Math.abs(file.biasPct) >= 5) {
    reasons.push(`Écart moyen global : mes cotes sont ${file.biasPct > 0 ? 'trop hautes' : 'trop basses'} de ${Math.abs(file.biasPct)} % — la correction résiduelle s'ajuste à chaque saisie.`);
  }
  const react = file.learned.reactions.filter((r) => r.pairs >= 3).map((r) => ({ unit: r.unit, top: Object.entries(r.effects).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0] })).filter((r) => r.top && Math.abs(r.top[1]) >= 0.05);
  for (const r of react.slice(0, 2)) reasons.push(`Pour ${r.unit} : la cote du bookmaker réagit surtout à « ${r.top[0]} » (effet ${r.top[1] > 0 ? '+' : ''}${r.top[1]}).`);
  if (reasons.length === 0) reasons.push('Pas encore assez de cotes saisies pour expliquer les écarts (il en faut au moins 3 par groupe).');
  return reasons;
}

/** Recalcule le fichier de la boucle à partir de toutes les saisies. */
export function buildOddsLoopFile(previousHistory: AlignmentPoint[] = [], refs: RefComparison[] = []): OddsLoopFile {
  const all = getAllObservations();
  const scored = all.filter((o) => delta(o) != null).sort((a, b) => a.ts.localeCompare(b.ts));
  const ds = scored.map((o) => delta(o) as number);
  const mape = ds.length ? ds.reduce((a, d) => a + Math.abs(d), 0) / ds.length : null;
  const bias = ds.length ? ds.reduce((a, d) => a + d, 0) / ds.length : null;
  const recent = ds.slice(-15);
  const before = ds.slice(-30, -15);
  const m = (xs: number[]) => xs.reduce((a, d) => a + Math.abs(d), 0) / xs.length;
  const trend: OddsLoopFile['trend'] =
    recent.length >= 8 && before.length >= 8 ? (m(recent) < m(before) - 0.02 ? 'en progrès' : m(recent) > m(before) + 0.02 ? 'en recul' : 'stable') : 'trop tôt';

  const bySegment = group(scored, segmentLabel);
  const byMinute = group(scored, (o) => MINUTE_LABEL[bucketOf(o.minute)]);
  const byProbability = group(scored, (o) => probBin(o.modelProb));
  const learned = { ...getOddsLearningStatus(), residuals: getResidualCorrections() };
  const lastN = previousHistory[previousHistory.length - 1]?.n;
  const history = mape != null && lastN !== scored.length ? [...previousHistory, { n: scored.length, ts: new Date().toISOString(), mape: pct(mape), score: scoreOf(mape), bias: bias != null ? pct(bias) : 0 }].slice(-HISTORY_MAX) : previousHistory;

  // Alignement avec bet365 : écart (modèle − référence) / référence, plafonné à ±150 %.
  const rd = refs.map((r) => ({ m: r.market, d: Math.max(-1.5, Math.min(1.5, (r.estModel - r.ref) / r.ref)) }));
  const refMape = rd.length ? rd.reduce((a, x) => a + Math.abs(x.d), 0) / rd.length : null;
  const refGroups = new Map<string, number[]>();
  for (const x of rd) refGroups.set(x.m, [...(refGroups.get(x.m) ?? []), x.d]);
  const vsBet365: RefAlignment = {
    n: rd.length,
    score: refMape != null ? scoreOf(refMape) : null,
    meanAbsDeltaPct: refMape != null ? pct(refMape) : null,
    biasPct: rd.length ? pct(rd.reduce((a, x) => a + x.d, 0) / rd.length) : null,
    byMarket: Array.from(refGroups.entries()).map(([label, ds]) => ({ label: label === '1X2' ? '1X2' : 'total de buts', n: ds.length, bias: pct(ds.reduce((a, b) => a + b, 0) / ds.length), mape: pct(ds.reduce((a, b) => a + Math.abs(b), 0) / ds.length) })),
  };

  const file: OddsLoopFile = {
    updatedAt: new Date().toISOString(),
    observations: all.length,
    scored: scored.length,
    score: mape != null ? scoreOf(mape) : null,
    meanAbsDeltaPct: mape != null ? pct(mape) : null,
    biasPct: bias != null ? pct(bias) : null,
    recentScore: recent.length ? scoreOf(m(recent)) : null,
    trend,
    bySegment,
    byMinute,
    byProbability,
    reasons: [],
    vsBet365,
    learned,
    history,
  };
  file.reasons = explain(file);
  return file;
}

let memoFile: OddsLoopFile | null = null;

export async function readOddsLoopFile(fresh = false): Promise<OddsLoopFile | null> {
  if (memoFile && !fresh) return memoFile;
  try {
    const raw = await AsyncStorage.getItem(FILE_KEY);
    memoFile = raw ? JSON.parse(raw) : null;
  } catch {
    memoFile = null;
  }
  return memoFile;
}

/** Met à jour le fichier de la boucle (appelé à chaque cote saisie). */
export async function updateOddsLoopFile(): Promise<OddsLoopFile> {
  const previous = await readOddsLoopFile(true);
  const file = buildOddsLoopFile(previous?.history ?? [], await readRefComparisons());
  memoFile = file;
  try {
    await AsyncStorage.setItem(FILE_KEY, JSON.stringify(file));
  } catch {
    // best-effort
  }
  return file;
}

/** Enregistre une cote saisie ET fait tourner la boucle d'apprentissage. */
export async function recordOddsAndLearn(proposal: InPlayProposal, odds: number, context?: OddsContext | null): Promise<OddsLoopFile> {
  await recordBookieOdds(proposal, odds, context);
  return updateOddsLoopFile();
}

async function readRefComparisons(): Promise<RefComparison[]> {
  try {
    const raw = await AsyncStorage.getItem(REF_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Garde la comparaison « mon estimation / cote bet365 » (une par pari et par tranche de 10 minutes de temps réel). */
export async function recordRefComparison(c: Omit<RefComparison, 'ts'>): Promise<void> {
  const list = await readRefComparisons();
  const now = Date.now();
  if (list.some((x) => x.key === c.key && now - Date.parse(x.ts) < 10 * 60_000)) return;
  try {
    await AsyncStorage.setItem(REF_KEY, JSON.stringify([...list, { ...c, ts: new Date(now).toISOString() }].slice(-REF_MAX)));
  } catch {
    // best-effort
  }
}

/**
 * Apprend des cotes bet365 lues en ligne : pour chaque marché/côté/fenêtre, rapport moyen (géométrique) cote réelle / cote estimée,
 * ramené vers 1 quand les mesures sont peu nombreuses, borné à [0,6 ; 1,6]. Appliqué aux estimations des paris dont bet365 ne
 * donne pas la cote ; les cotes que vous saisissez à la main continuent de compléter l'apprentissage.
 */
export async function ensureRefCorrections(): Promise<void> {
  const refs = await readRefComparisons();
  const bySeg = new Map<string, number[]>();
  for (const r of refs) {
    if (!(r.ref > 1) || !(r.estModel > 1)) continue;
    const seg = oddsSegment(r.market as any, r.selection);
    const list = bySeg.get(seg) ?? [];
    list.push(Math.log(r.ref / r.estModel));
    bySeg.set(seg, list);
  }
  const out = new Map<string, number>();
  for (const [seg, logs] of bySeg) {
    if (logs.length < 5) continue;
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const weight = logs.length / (logs.length + 10);
    out.set(seg, Math.min(1.6, Math.max(0.6, Math.exp(mean * weight))));
  }
  setRefCorrections(out);
}
