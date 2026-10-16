// Fin de scan d'un match réel : les relevés minute par minute sont ANALYSÉS, résumés en leçons, versés dans la boucle
// d'apprentissage (motifs agrégés) et dans le fichier des équipes (profil + leçons par équipe), puis les relevés bruts
// sont remplacés par un résumé compact (≈ 25 points au lieu de ≈ 90) : c'est ce qui préserve l'espace.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LiveStatsSample, listLiveStatsDays, readLiveStatsDay, removeLiveStatsMatch } from './liveStatsStore';
import { normalizeTeamName } from './teamNameMatch';
import { flushPatterns, ingestMatch } from './patternEngine';

const DIGEST_KEY = '@match_digests';
const TEAM_KEY = '@team_live_lessons';
const PATTERN_KEY = '@match_patterns';
const PERIODS = [15, 30, 45, 60, 75, 200];
const TEAM_GOALS_KEPT = 80;
const TEAM_LESSONS_KEPT = 8;

type Compact = [number, number, number, number, number, number, number, number]; // minute, dom, ext, tirs, cadrés, corners, cartons, fautes

export interface MatchDigest {
  day: string;
  match: string;
  score: [number, number];
  goals: Array<[number, 'h' | 'a']>;
  totals: { shots: number; sot: number; corners: number; cards: number; fouls: number; reds: number };
  /** Détail par équipe : [tirs, cadrés, corners, cartons, fautes] (domicile / extérieur). */
  sides?: { h: number[]; a: number[] };
  /** Par tranche de 15 min : [corners, cartons, tirs]. */
  periods: Array<[number, number, number]>;
  lessons: string[];
  key: Compact[];
}

interface TeamLive {
  name: string;
  n: number;
  goalsForMin: number[];
  goalsAgainstMin: number[];
  corners: number;
  cards: number;
  fouls: number;
  shots: number;
  /** Ce que l'équipe PRODUIT et CONCÈDE par match (corners, cartons, tirs cadrés), plus matchs à domicile. */
  own?: { shots: number; sot: number; corners: number; cards: number; fouls: number };
  conceded?: { shots: number; sot: number; corners: number; cards: number; fouls: number };
  homeMatches?: number;
  /** Minutes des buts de la saison déjà versées depuis le fichier des stats. */
  seeded?: boolean;
  lessons: string[];
}

interface PatternStat { n: number; goals: number; corners: number; cards: number }
type Patterns = Record<string, PatternStat>;

let teamMemo: Record<string, TeamLive> | null = null;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const last = <T,>(xs: T[]): T => xs[xs.length - 1];
const val = (xs: LiveStatsSample[], f: (s: LiveStatsSample) => number | undefined): number => {
  for (let i = xs.length - 1; i >= 0; i--) {
    const v = f(xs[i]);
    if (v != null) return v;
  }
  return 0;
};

function analyse(day: string, match: string, raw: LiveStatsSample[]): MatchDigest | null {
  const s = [...raw].sort((a, b) => a.minute - b.minute || a.ts.localeCompare(b.ts));
  if (s.length < 3) return null;
  const goals: MatchDigest['goals'] = [];
  let ph = 0;
  let pa = 0;
  for (const x of s) {
    for (let i = ph; i < x.home; i++) goals.push([x.minute, 'h']);
    for (let i = pa; i < x.away; i++) goals.push([x.minute, 'a']);
    ph = Math.max(ph, x.home);
    pa = Math.max(pa, x.away);
  }
  const totals = {
    shots: val(s, (x) => x.shots),
    sot: val(s, (x) => x.sot),
    corners: val(s, (x) => x.corners),
    cards: val(s, (x) => x.cards),
    fouls: val(s, (x) => x.fouls),
    reds: val(s, (x) => x.reds),
  };
  const lastSide = [...s].reverse().find((x) => x.side)?.side;
  const periods: MatchDigest['periods'] = PERIODS.map(() => [0, 0, 0]);
  for (let i = 1; i < s.length; i++) {
    const idx = PERIODS.findIndex((p) => s[i].minute <= p);
    const k = idx < 0 ? PERIODS.length - 1 : idx;
    periods[k][0] += Math.max(0, (s[i].corners ?? 0) - (s[i - 1].corners ?? 0));
    periods[k][1] += Math.max(0, (s[i].cards ?? 0) - (s[i - 1].cards ?? 0));
    periods[k][2] += Math.max(0, (s[i].shots ?? 0) - (s[i - 1].shots ?? 0));
  }
  // Points clés : un par tranche de 5 minutes, plus chaque changement de score / carton.
  const key: Compact[] = [];
  let bucket = -1;
  let prev: LiveStatsSample | null = null;
  for (const x of s) {
    const b = Math.floor(x.minute / 5);
    const changed = prev && (x.home !== prev.home || x.away !== prev.away || (x.cards ?? 0) !== (prev.cards ?? 0));
    if (b !== bucket || changed) key.push([x.minute, x.home, x.away, x.shots ?? 0, x.sot ?? 0, x.corners ?? 0, x.cards ?? 0, x.fouls ?? 0]);
    bucket = b;
    prev = x;
  }
  const final = last(s);
  const lessons: string[] = [];
  const firstGoal = goals[0];
  const total = final.home + final.away;
  if (firstGoal && firstGoal[0] <= 20) {
    const after = s.filter((x) => x.minute >= firstGoal[0]);
    const cornersAfter = (last(after).corners ?? 0) - (after[0].corners ?? 0);
    lessons.push(`But rapide (${firstGoal[0]}e) : ${total} but(s) au final, ${cornersAfter} corner(s) ensuite.`);
  } else if (!firstGoal) {
    lessons.push(`Match fermé : 0-0, ${totals.shots} tirs dont ${totals.sot} cadrés, ${totals.corners} corners.`);
  }
  const late = goals.filter((g) => g[0] >= 75).length;
  if (late > 0) lessons.push(`${late} but(s) après la 75e minute.`);
  if (totals.reds > 0) lessons.push(`Carton rouge : ${totals.cards} cartons et ${total} but(s) au total.`);
  const second = periods.slice(3).reduce((a, p) => a + p[0], 0);
  if (totals.corners >= 6 && second / Math.max(1, totals.corners) >= 0.65) lessons.push(`Corners surtout en 2e mi-temps (${second}/${totals.corners}).`);
  if (totals.cards >= 4 && periods.slice(3).reduce((a, p) => a + p[1], 0) / totals.cards >= 0.75) lessons.push(`Cartons surtout en 2e mi-temps (${totals.cards} au total).`);
  return { day, match, score: [final.home, final.away], goals, totals, sides: lastSide ? { h: lastSide.h, a: lastSide.a } : undefined, periods, lessons, key };
}

function teamsOf(match: string): [string, string] | null {
  const i = match.indexOf(' - ');
  return i > 0 ? [match.slice(0, i), match.slice(i + 3)] : null;
}

async function updateTeams(d: MatchDigest): Promise<void> {
  const teams = teamsOf(d.match);
  if (!teams) return;
  const store = teamMemo ?? (await readJson<Record<string, TeamLive>>(TEAM_KEY, {}));
  teams.forEach((name, idx) => {
    const k = normalizeTeamName(name);
    const t = (store[k] ??= { name, n: 0, goalsForMin: [], goalsAgainstMin: [], corners: 0, cards: 0, fouls: 0, shots: 0, lessons: [] });
    t.n += 1;
    for (const [min, side] of d.goals) (side === (idx === 0 ? 'h' : 'a') ? t.goalsForMin : t.goalsAgainstMin).push(min);
    t.goalsForMin = t.goalsForMin.slice(-TEAM_GOALS_KEPT);
    t.goalsAgainstMin = t.goalsAgainstMin.slice(-TEAM_GOALS_KEPT);
    t.corners += d.totals.corners;
    t.cards += d.totals.cards;
    t.fouls += d.totals.fouls;
    t.shots += d.totals.shots;
    if (d.sides) {
      const mineS = idx === 0 ? d.sides.h : d.sides.a;
      const theirS = idx === 0 ? d.sides.a : d.sides.h;
      const zero = () => ({ shots: 0, sot: 0, corners: 0, cards: 0, fouls: 0 });
      const o = (t.own ??= zero());
      const c = (t.conceded ??= zero());
      [o.shots, o.sot, o.corners, o.cards, o.fouls] = [o.shots + mineS[0], o.sot + mineS[1], o.corners + mineS[2], o.cards + mineS[3], o.fouls + mineS[4]];
      [c.shots, c.sot, c.corners, c.cards, c.fouls] = [c.shots + theirS[0], c.sot + theirS[1], c.corners + theirS[2], c.cards + theirS[3], c.fouls + theirS[4]];
    }
    if (idx === 0) t.homeMatches = (t.homeMatches ?? 0) + 1;
    const mine = d.score[idx];
    const theirs = d.score[1 - idx];
    t.lessons = [...t.lessons, `${d.day} ${d.match} ${d.score[0]}-${d.score[1]} : ${d.lessons.join(' ') || `${mine}-${theirs}, ${d.totals.corners} corners, ${d.totals.cards} cartons.`}`].slice(-TEAM_LESSONS_KEPT);
  });
  teamMemo = store;
  await AsyncStorage.setItem(TEAM_KEY, JSON.stringify(store)).catch(() => {});
}

async function updatePatterns(d: MatchDigest): Promise<void> {
  const p = await readJson<Patterns>(PATTERN_KEY, {});
  const total = d.score[0] + d.score[1];
  const add = (name: string) => {
    const e = (p[name] ??= { n: 0, goals: 0, corners: 0, cards: 0 });
    e.n += 1;
    e.goals += total;
    e.corners += d.totals.corners;
    e.cards += d.totals.cards;
  };
  add('tous');
  add(d.goals[0] && d.goals[0][0] <= 20 ? 'but rapide (≤20e)' : 'pas de but rapide');
  add(d.totals.reds > 0 ? 'avec carton rouge' : 'sans carton rouge');
  if (d.goals.some((g) => g[0] >= 75)) add('but tardif (≥75e)');
  await AsyncStorage.setItem(PATTERN_KEY, JSON.stringify(p)).catch(() => {});
}

/** Résumé écrit des motifs appris sur tous les matchs digérés (boucle d'apprentissage + message du soir). */
export async function getPatternLessons(): Promise<string[]> {
  const p = await readJson<Patterns>(PATTERN_KEY, {});
  const out: string[] = [];
  const line = (name: string): string | null => {
    const e = p[name];
    return e && e.n >= 3 ? `${name} (${e.n} matchs) : ${(e.goals / e.n).toFixed(1)} buts, ${(e.corners / e.n).toFixed(1)} corners, ${(e.cards / e.n).toFixed(1)} cartons en moyenne` : null;
  };
  for (const n of ['tous', 'but rapide (≤20e)', 'pas de but rapide', 'avec carton rouge', 'sans carton rouge', 'but tardif (≥75e)']) {
    const l = line(n);
    if (l) out.push(l);
  }
  return out;
}

/** Leçons de ce soir : résumés des matchs digérés ce jour. */
export async function getTodaysMatchLessons(day: string): Promise<string[]> {
  const all = await readJson<Record<string, MatchDigest>>(DIGEST_KEY, {});
  return Object.values(all).filter((d) => d.day === day).map((d) => `${d.match} ${d.score[0]}-${d.score[1]} : ${d.lessons.join(' ') || 'rien de notable.'}`);
}

/** Profil live d'une équipe (mémoire chargée) : buts par tranche de jeu, rythme de corners/cartons, dernières leçons. */
export async function ensureTeamLiveLessonsLoaded(): Promise<void> {
  if (!teamMemo) teamMemo = await readJson<Record<string, TeamLive>>(TEAM_KEY, {});
}

/**
 * Amorce le profil d'une équipe avec TOUTE sa saison (fichier des stats, toutes compétitions) : minutes des buts marqués et
 * encaissés. Le profil ne repart donc pas de zéro : le suivi minute par minute vient s'y ajouter, match après match.
 */
export async function seedTeamTiming(team: string, goalsForMin: number[], goalsAgainstMin: number[]): Promise<void> {
  await ensureTeamLiveLessonsLoaded();
  const k = normalizeTeamName(team);
  const store = teamMemo!;
  const t = (store[k] ??= { name: team, n: 0, goalsForMin: [], goalsAgainstMin: [], corners: 0, cards: 0, fouls: 0, shots: 0, lessons: [] });
  if (t.seeded) return;
  t.seeded = true;
  t.goalsForMin = [...goalsForMin, ...t.goalsForMin].slice(-TEAM_GOALS_KEPT);
  t.goalsAgainstMin = [...goalsAgainstMin, ...t.goalsAgainstMin].slice(-TEAM_GOALS_KEPT);
  await AsyncStorage.setItem(TEAM_KEY, JSON.stringify(store)).catch(() => {});
}

export function teamLiveNote(team: string): string {
  const t = teamMemo?.[normalizeTeamName(team)];
  if (!t || (t.n < 2 && t.goalsForMin.length < 4)) return '';
  const early = t.goalsForMin.filter((m) => m <= 30).length;
  const late = t.goalsAgainstMin.filter((m) => m >= 70).length;
  const split = t.n < 2 ? '' : t.own && t.conceded ? `produit ${(t.own.corners / t.n).toFixed(1)} corners, ${(t.own.cards / t.n).toFixed(1)} cartons, ${(t.own.sot / t.n).toFixed(1)} tirs cadrés et en concède ${(t.conceded.corners / t.n).toFixed(1)}, ${(t.conceded.cards / t.n).toFixed(1)}, ${(t.conceded.sot / t.n).toFixed(1)} par match` : `${(t.corners / t.n).toFixed(1)} corners, ${(t.cards / t.n).toFixed(1)} cartons (match entier) par match`;
  const parts = t.n >= 2 ? [`${t.n} matchs suivis minute par minute : ${split}`] : [];
  if (t.goalsForMin.length >= 4) parts.push(`${Math.round((early / t.goalsForMin.length) * 100)} % de ses buts avant la 30e`);
  if (t.goalsAgainstMin.length >= 4) parts.push(`${Math.round((late / t.goalsAgainstMin.length) * 100)} % de ses buts encaissés après la 70e`);
  return `\n- Suivi en direct ${t.name} : ${parts.join(' ; ')}. ${last(t.lessons) ? `Dernière leçon : ${last(t.lessons)}` : ''}`;
}

/**
 * Digère les matchs terminés (plus aucun relevé depuis `idleMinutes`, ou pas dans la liste en direct) : analyse, leçons,
 * boucle d'apprentissage, équipes, puis suppression des relevés bruts. Les jours passés sont toujours digérés.
 */
export async function digestFinishedMatches(liveKeys: Set<string>, idleMinutes = 6): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const digests = await readJson<Record<string, MatchDigest>>(DIGEST_KEY, {});
  let done = 0;
  for (const day of await listLiveStatsDays()) {
    const store = await readLiveStatsDay(day);
    for (const [match, samples] of Object.entries(store)) {
      const lastSample = last(samples);
      const idle = (Date.now() - Date.parse(lastSample.ts)) / 60_000;
      // Terminé = jour passé, OU plus en direct depuis assez longtemps : 6 min seulement si le dernier relevé est tardif (≥ 80e),
      // sinon 25 min — une app restée fermée ou une source muette quelques minutes ne doit pas faire croire à un match fini.
      const finished = day < today || (!liveKeys.has(match) && (idle >= 25 || (idle >= idleMinutes && lastSample.minute >= 80)));
      if (!finished) continue;
      const d = analyse(day, match, samples);
      if (d) {
        digests[`${day}|${match}`] = d;
        // Le match réel rejoué pour les motifs (situation à 15e/30e/MT/60e/75e → ce qui a suivi).
        const ctx = samples.find((x) => x.ctx)?.ctx;
        const ht = d.goals.filter((g) => g[0] <= 45);
        await ingestMatch(
          `r:${day}:${match}`,
          d.key.map((k) => ({ minute: k[0], h: k[1], a: k[2], sot: k[4], corners: k[5], cards: k[6] })),
          { h: d.score[0], a: d.score[1], htH: ht.filter((g) => g[1] === 'h').length, htA: ht.filter((g) => g[1] === 'a').length, corners: d.totals.corners, cards: d.totals.cards },
          ctx ?? undefined
        ).catch(() => false);
        await updateTeams(d);
        await updatePatterns(d);
        done++;
      }
      await removeLiveStatsMatch(day, match);
    }
  }
  if (done > 0) {
    await AsyncStorage.setItem(DIGEST_KEY, JSON.stringify(digests)).catch(() => {});
    await flushPatterns().catch(() => {});
  }
  return done;
}
