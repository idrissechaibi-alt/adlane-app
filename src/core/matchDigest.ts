// Fin de scan d'un match réel : les relevés minute par minute sont ANALYSÉS, résumés en leçons, versés dans la boucle
// d'apprentissage (motifs agrégés) et dans le fichier des équipes (profil + leçons par équipe), puis les relevés bruts
// sont remplacés par un résumé compact (≈ 25 points au lieu de ≈ 90) : c'est ce qui préserve l'espace.

import AsyncStorage from './kvStore';
import { LiveStatsSample, listLiveStatsDays, readLiveStatsDay, removeLiveStatsMatch, takeLivePlayers } from './liveStatsStore';
import { normalizeTeamName, sameTeamStrict, teamCoreKey } from './teamNameMatch';
import { flushPatterns, ingestMatch } from './patternEngine';
import { hubPlayerShots } from '../api/footballDataAPIs/liveDataHub';

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
  /**
   * Stats individuelles des joueurs DE CE MATCH, par équipe (ESPN, dernier relevé en direct) :
   * [nom, poste, titulaire 1/0, tirs, tirs cadrés, buts, passes déc., fautes, jaunes, rouges, entré 1/0, sorti 1/0].
   */
  players?: { h: PlayerLine[]; a: PlayerLine[] };
}

export type PlayerLine = [string, string, number, number, number, number, number, number, number, number, number, number];

function playerLines(players: any[] | null, side: 'home' | 'away'): PlayerLine[] {
  return (players ?? [])
    .filter((p) => p?.team === side && p.name)
    .map((p): PlayerLine => [String(p.name), String(p.position ?? ''), p.starter ? 1 : 0, p.shots ?? 0, p.sot ?? 0, p.goals ?? 0, p.assists ?? 0, p.fouls ?? 0, p.yellow ?? 0, p.red ?? 0, p.subIn ? 1 : 0, p.subOut ? 1 : 0]);
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
  /** Joueurs suivis en direct (cumul) : matchs, titularisations, buts, passes, tirs, cadrés, fautes, jaunes, rouges. */
  players?: Record<string, [number, number, number, number, number, number, number, number, number]>;
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

async function updateTeams(d: MatchDigest, players?: any[] | null): Promise<void> {
  const teams = teamsOf(d.match);
  if (!teams) return;
  const store = teamMemo ?? (await readJson<Record<string, TeamLive>>(TEAM_KEY, {}));
  teams.forEach((name, idx) => {
    // Dossier existant de la même équipe sous un autre nom (« Atalanta » / « Atalanta BC ») : réutilisé.
    const norm = normalizeTeamName(name);
    const k = store[norm] ? norm : Object.keys(store).find((x) => sameTeamStrict(norm, x)) ?? norm;
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
    // Stats des joueurs de ce match (dernier relevé ESPN), compilées dans le profil de l'équipe.
    for (const p of players ?? []) {
      if (p.team !== (idx === 0 ? 'home' : 'away') || !p.name) continue;
      const cur = ((t.players ??= {})[p.name] ??= [0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const add = [1, p.starter ? 1 : 0, p.goals ?? 0, p.assists ?? 0, p.shots ?? 0, p.sot ?? 0, p.fouls ?? 0, p.yellow ?? 0, p.red ?? 0];
      for (let i = 0; i < 9; i++) cur[i] += add[i];
    }
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
  const shooters = Object.entries(t.players ?? {}).filter(([, v]) => v[0] >= 2).sort((x, y) => y[1][5] / y[1][0] - x[1][5] / x[1][0]).slice(0, 2);
  if (shooters.length) parts.push(`tireurs suivis en direct : ${shooters.map(([n, v]) => `${n} ${(v[5] / v[0]).toFixed(1)} tirs cadrés/match`).join(', ')}`);
  return `\n- Suivi en direct ${t.name} : ${parts.join(' ; ')}. ${last(t.lessons) ? `Dernière leçon : ${last(t.lessons)}` : ''}`;
}

/**
 * Digère les matchs terminés (plus aucun relevé depuis `idleMinutes`, ou pas dans la liste en direct) : analyse, leçons,
 * boucle d'apprentissage, équipes, puis suppression des relevés bruts. Les jours passés sont toujours digérés.
 */
/**
 * Un même match peut avoir été relevé sous deux noms (« Atalanta - Venezia » chez une source, « Atalanta BC - Venezia FC »
 * chez une autre) : les relevés sont réunis sous un seul nom (le plus fourni) avant l'analyse, sinon le match compterait
 * deux fois dans le fichier des équipes.
 */
function mergeSameMatches(store: Record<string, LiveStatsSample[]>): Record<string, { samples: LiveStatsSample[]; aliases: string[] }> {
  const groups: Array<{ home: string; away: string; keys: string[] }> = [];
  for (const key of Object.keys(store)) {
    const [h, a] = key.split(' - ');
    const home = normalizeTeamName(h ?? '');
    const away = normalizeTeamName(a ?? '');
    const g = groups.find((x) => sameTeamStrict(home, x.home) && sameTeamStrict(away, x.away));
    if (g) g.keys.push(key);
    else groups.push({ home, away, keys: [key] });
  }
  const out: Record<string, { samples: LiveStatsSample[]; aliases: string[] }> = {};
  for (const g of groups) {
    const main = [...g.keys].sort((x, y) => store[y].length - store[x].length)[0];
    const merged = g.keys.flatMap((k) => store[k]).sort((x, y) => x.ts.localeCompare(y.ts));
    // Deux relevés à moins de 30 s d'écart (deux noms, même instant) : un seul gardé.
    const samples = merged.filter((s, i) => i === 0 || Date.parse(s.ts) - Date.parse(merged[i - 1].ts) >= 30_000 || s.minute !== merged[i - 1].minute);
    const ctx = merged.find((s) => s.ctx)?.ctx;
    if (ctx && samples.length && !samples[0].ctx) samples[0] = { ...samples[0], ctx };
    out[main] = { samples, aliases: g.keys };
  }
  return out;
}

const REBUILT_KEY = '@team_live_rebuilt_v1';

/**
 * Nettoyage, une seule fois : un match résumé deux fois sous deux noms (avant le registre des équipes) n'est gardé qu'une
 * fois (la version la plus complète), puis les dossiers d'équipe sont reconstruits à partir des résumés dédoublonnés —
 * « Atalanta » et « Atalanta BC » ne font plus qu'un dossier, et le match n'y compte qu'une fois.
 */
async function dedupeAndRebuildTeamsOnce(digests: Record<string, MatchDigest>): Promise<boolean> {
  if ((await AsyncStorage.getItem(REBUILT_KEY).catch(() => null)) === 'done') return false;
  const ident = (d: MatchDigest) => {
    const t = teamsOf(d.match);
    return t ? `${d.day}|${teamCoreKey(normalizeTeamName(t[0])) || t[0]}|${teamCoreKey(normalizeTeamName(t[1])) || t[1]}` : `${d.day}|${d.match}`;
  };
  const best = new Map<string, string>();
  for (const [k, d] of Object.entries(digests)) {
    const id = ident(d);
    const cur = best.get(id);
    if (!cur || (d.key?.length ?? 0) + (d.players ? 1000 : 0) > (digests[cur].key?.length ?? 0) + (digests[cur].players ? 1000 : 0)) best.set(id, k);
  }
  const keep = new Set(best.values());
  for (const k of Object.keys(digests)) if (!keep.has(k)) delete digests[k];
  teamMemo = {};
  const toHub = (lines: PlayerLine[], team: 'home' | 'away') =>
    lines.map(([name, position, starter, shots, sot, goals, assists, fouls, yellow, red]) => ({ name, position, starter: !!starter, shots, sot, goals, assists, fouls, yellow, red, team }));
  for (const d of Object.values(digests).sort((a, b) => a.day.localeCompare(b.day))) {
    await updateTeams(d, d.players ? [...toHub(d.players.h, 'home'), ...toHub(d.players.a, 'away')] : null);
  }
  if (Object.keys(digests).length === 0) await AsyncStorage.setItem(TEAM_KEY, JSON.stringify({})).catch(() => {});
  await AsyncStorage.setItem(REBUILT_KEY, 'done').catch(() => {});
  return true;
}

export async function digestFinishedMatches(liveKeys: Set<string>, idleMinutes = 6): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const digests = await readJson<Record<string, MatchDigest>>(DIGEST_KEY, {});
  const rebuilt = await dedupeAndRebuildTeamsOnce(digests).catch(() => false);
  let done = 0;
  for (const day of await listLiveStatsDays()) {
    const store = mergeSameMatches(await readLiveStatsDay(day));
    for (const [match, { samples, aliases }] of Object.entries(store)) {
      const lastSample = last(samples);
      const idle = (Date.now() - Date.parse(lastSample.ts)) / 60_000;
      // Terminé = jour passé, OU plus en direct depuis assez longtemps : 6 min seulement si le dernier relevé est tardif (≥ 80e),
      // sinon 25 min — une app restée fermée ou une source muette quelques minutes ne doit pas faire croire à un match fini.
      const finished = day < today || (!aliases.some((k) => liveKeys.has(k)) && (idle >= 25 || (idle >= idleMinutes && lastSample.minute >= 80)));
      if (!finished) continue;
      const d = analyse(day, match, samples);
      if (d) {
        // Stats des joueurs : la copie la plus fournie parmi les noms du même match.
        let players: any[] | null = null;
        for (const k of aliases) {
          const p = await takeLivePlayers(day, k).catch(() => null);
          if (p && (!players || p.length > players.length)) players = p;
        }
        // Relevé en direct manquant : feuille de match ESPN, disponible après le coup de sifflet.
        if (!players?.length) {
          const t = teamsOf(match);
          if (t) players = (await hubPlayerShots(t[0], t[1], day).catch(() => null)) as any[] | null;
        }
        // Chaque match compilé garde les stats perso de ses joueurs, équipe par équipe.
        if (players?.length) d.players = { h: playerLines(players, 'home'), a: playerLines(players, 'away') };
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
        await updateTeams(d, players);
        await updatePatterns(d);
        done++;
      }
      for (const k of aliases) await removeLiveStatsMatch(day, k);
    }
  }
  // Rattrapage : matchs déjà compilés sans stats des joueurs (avant cette fonction) → feuille de match ESPN, 6 par passage.
  let filled = 0;
  for (const d of Object.values(digests)) {
    if (filled >= 6) break;
    if (d.players || (d as any).playersTried) continue;
    const t = teamsOf(d.match);
    const players = t ? await hubPlayerShots(t[0], t[1], d.day).catch(() => null) : null;
    if (players?.length) d.players = { h: playerLines(players, 'home'), a: playerLines(players, 'away') };
    else (d as any).playersTried = true; // source sans feuille pour ce match : pas retenté
    filled++;
  }
  if (done > 0 || filled > 0 || rebuilt) {
    await AsyncStorage.setItem(DIGEST_KEY, JSON.stringify(digests)).catch(() => {});
    await flushPatterns().catch(() => {});
  }
  return done;
}
