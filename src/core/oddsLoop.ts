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

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { InPlayProposal } from './learnStore';
import {
  OddsContext,
  OddsObservation,
  bucketOf,
  getAllObservations,
  getOddsLearningStatus,
  getResidualCorrections,
  recordBookieOdds,
} from './oddsLearning';

const FILE_KEY = '@odds_learning_file';
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
  corners: 'corners', cartons: 'cartons', fautes: 'fautes', total_buts: 'total de buts', btts: 'les deux équipes marquent', '1X2': '1X2', buts_1ere_mt: 'but en 1ère mi-temps', combo: 'combinés',
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
export function buildOddsLoopFile(previousHistory: AlignmentPoint[] = []): OddsLoopFile {
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
  const history = mape != null ? [...previousHistory, { n: scored.length, ts: new Date().toISOString(), mape: pct(mape), score: scoreOf(mape), bias: bias != null ? pct(bias) : 0 }].slice(-HISTORY_MAX) : previousHistory;

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
  const previous = await readOddsLoopFile();
  const file = buildOddsLoopFile(previous?.history ?? []);
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
