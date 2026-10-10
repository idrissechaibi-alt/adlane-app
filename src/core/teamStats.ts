/**
 * Tendances d'équipe tirées du fichier de stats match par match
 * (data/team-stats/, compilé chaque nuit par scripts/team-stats/collect.py :
 * 5 grands championnats + Ligue des champions, toutes compétitions officielles
 * de la saison, match entier + 1ère/2e mi-temps, « pour » et « contre »).
 *
 * L'app télécharge l'index (nom → id) puis, à la demande, le fichier des deux
 * équipes du match à proposer, et n'en garde qu'un RÉSUMÉ compact (moyennes des
 * 10 derniers matchs + des 5 derniers à domicile / à l'extérieur) : le fichier
 * complet pèse plusieurs Mo, trop pour le stockage du téléphone.
 *
 * Rien n'est jamais inventé : équipe inconnue du fichier, moins de
 * MIN_MATCHES matchs, réseau coupé → aucune tendance, la prédiction reste telle
 * quelle.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { namesLikelyMatch, normalizeTeamName } from './teamNameMatch';
import { poissonProb } from './poisson';

const BASE_URL = 'https://raw.githubusercontent.com/idrissechaibi-alt/adlane-app/main/data/team-stats';
const INDEX_KEY = '@team_stats_index';
const SUMMARIES_KEY = '@team_stats_summaries';
const INDEX_TTL_MS = 3 * 3_600_000;
const FETCH_TIMEOUT_MS = 12_000;
/** Matchs minimum (avec stats) par équipe pour qu'une tendance compte. */
const MIN_MATCHES = 4;
const LAST_N = 10;
const VENUE_N = 5;
/** Poids de la tendance dans le rythme attendu du reste du match. */
export const TREND_WEIGHT = 0.35;
/** Une jambe est bloquée si la tendance donne moins de 30 % de chances au reste du match. */
const BLOCK_BELOW = 0.3;

export type TrendKey = 'corners_ft' | 'corners_1h' | 'cards_ft' | 'cards_1h' | 'fouls_ft' | 'fouls_1h' | 'goals_ft' | 'goals_1h' | 'xg_ft';
const KEYS: TrendKey[] = ['corners_ft', 'corners_1h', 'cards_ft', 'cards_1h', 'fouls_ft', 'fouls_1h', 'goals_ft', 'goals_1h', 'xg_ft'];

type Averages = Partial<Record<TrendKey, [number, number]>>; // [pour, contre]

interface TeamSummary {
  id: number;
  name: string;
  sig: string;
  n: { all: number; home: number; away: number };
  all: Averages;
  home: Averages;
  away: Averages;
  /** Constats calculés par le script de nuit (forme, timing des buts, efficacité, lignes régulières…). */
  insights: string[];
  /** Résumé des derniers matchs : ce qui explique chaque résultat. */
  recent: string[];
}

interface IndexTeam {
  id: number;
  name: string;
  shortName: string;
  matches: number;
  lastMatch: string | null;
  analysisVersion?: number;
}

interface TeamIndex {
  updatedAt: string;
  teams: IndexTeam[];
}

export interface MatchTrend {
  homeTeam: string;
  awayTeam: string;
  /** Total attendu pour le match (les deux équipes), par marché et fenêtre. */
  expected: Partial<Record<TrendKey, number>>;
  /** Buts attendus par côté (mêlant buts et xG), si les deux équipes ont assez de matchs. */
  goals?: { home: number; away: number };
  samples: { home: number; away: number };
  /** Constats d'analyse par équipe (forme, timing, efficacité, lignes régulières). */
  insights: { home: string[]; away: string[] };
  recent: { home: string[]; away: string[] };
  /** Taux par équipe (pour, contre) : pour l'affichage et les analyses. */
  rates: { home: Partial<Record<TrendKey, [number, number]>>; away: Partial<Record<TrendKey, [number, number]>> };
}

/** Compteurs de diagnostic (appHealth) : prouvent que le fichier est chargé et réellement utilisé. */
const usage = { lookups: 0, withTrend: 0, unknownTeams: 0, lastTrendAt: null as string | null, lastUnknown: null as string | null };

let indexMemo: { at: number; index: TeamIndex } | null = null;
let summariesMemo: Record<string, TeamSummary> | null = null;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function loadIndex(): Promise<TeamIndex | null> {
  if (indexMemo && Date.now() - indexMemo.at < INDEX_TTL_MS) return indexMemo.index;
  let cached: { at: number; index: TeamIndex } | null = null;
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch {
    cached = null;
  }
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) {
    indexMemo = cached;
    return cached.index;
  }
  const fresh = await fetchJson<TeamIndex>(`${BASE_URL}/index.json`);
  if (fresh?.teams?.length) {
    indexMemo = { at: Date.now(), index: fresh };
    AsyncStorage.setItem(INDEX_KEY, JSON.stringify(indexMemo)).catch(() => {});
    return fresh;
  }
  // Réseau coupé : le dernier index connu vaut mieux que rien.
  if (cached) {
    indexMemo = { at: Date.now() - INDEX_TTL_MS + 10 * 60_000, index: cached.index };
    return cached.index;
  }
  return null;
}

async function loadSummaries(): Promise<Record<string, TeamSummary>> {
  if (summariesMemo) return summariesMemo;
  try {
    const raw = await AsyncStorage.getItem(SUMMARIES_KEY);
    summariesMemo = raw ? JSON.parse(raw) : {};
  } catch {
    summariesMemo = {};
  }
  return summariesMemo!;
}

function findTeam(index: TeamIndex, name: string): IndexTeam | null {
  const wanted = normalizeTeamName(name);
  if (!wanted) return null;
  let loose: IndexTeam | null = null;
  for (const t of index.teams) {
    const a = normalizeTeamName(t.name);
    const b = normalizeTeamName(t.shortName || t.name);
    if (a === wanted || b === wanted) return t;
    if (!loose && (namesLikelyMatch(wanted, a) || namesLikelyMatch(wanted, b))) loose = t;
  }
  return loose;
}

interface RawMatch {
  home: boolean;
  date: string;
  goals: { for: number; against: number };
  halftime: { for: number; against: number };
  stats: Record<string, Record<string, [number, number]>>;
}

function pairOf(block: Record<string, [number, number]> | undefined, ...keys: string[]): [number, number] | undefined {
  if (!block) return undefined;
  let sum: [number, number] | undefined;
  for (const k of keys) {
    const v = block[k];
    if (v) sum = [(sum?.[0] ?? 0) + v[0], (sum?.[1] ?? 0) + v[1]];
  }
  return sum;
}

function valuesOf(m: RawMatch, key: TrendKey): [number, number] | undefined {
  switch (key) {
    case 'goals_ft': return [m.goals.for, m.goals.against];
    case 'goals_1h': return [m.halftime.for, m.halftime.against];
    case 'corners_ft': return pairOf(m.stats.ft, 'corners');
    case 'corners_1h': return pairOf(m.stats.h1, 'corners');
    case 'cards_ft': return pairOf(m.stats.ft, 'yellow_cards', 'red_cards');
    case 'cards_1h': return pairOf(m.stats.h1, 'yellow_cards', 'red_cards');
    case 'fouls_ft': return pairOf(m.stats.ft, 'fouls_committed');
    case 'fouls_1h': return pairOf(m.stats.h1, 'fouls_committed');
    case 'xg_ft': return pairOf(m.stats.ft, 'expected_goals_xg');
  }
}

function averages(matches: RawMatch[]): Averages {
  const out: Averages = {};
  for (const key of KEYS) {
    const vals = matches.map((m) => valuesOf(m, key)).filter((v): v is [number, number] => !!v);
    if (vals.length < Math.min(3, MIN_MATCHES)) continue;
    out[key] = [vals.reduce((s, v) => s + v[0], 0) / vals.length, vals.reduce((s, v) => s + v[1], 0) / vals.length];
  }
  return out;
}

async function ensureSummary(team: IndexTeam): Promise<TeamSummary | null> {
  const summaries = await loadSummaries();
  const sig = `${team.lastMatch}|${team.matches}|${team.analysisVersion ?? 0}`;
  const known = summaries[String(team.id)];
  if (known && known.sig === sig) return known;

  const file = await fetchJson<{ matches: RawMatch[]; analysis?: { insights?: string[]; recent?: Array<{ date: string; opponent: string; home: boolean; note: string }> } }>(`${BASE_URL}/teams/${team.id}.json`);
  if (!file?.matches) return known ?? null;
  // Matchs avec stats détaillées uniquement, les plus récents d'abord.
  const played = file.matches.filter((m) => m.stats?.ft).sort((a, b) => (a.date < b.date ? 1 : -1));
  const home = played.filter((m) => m.home).slice(0, VENUE_N);
  const away = played.filter((m) => !m.home).slice(0, VENUE_N);
  const summary: TeamSummary = {
    id: team.id,
    name: team.name,
    sig,
    n: { all: Math.min(played.length, LAST_N), home: home.length, away: away.length },
    all: averages(played.slice(0, LAST_N)),
    home: averages(home),
    away: averages(away),
    insights: (file.analysis?.insights ?? []).slice(0, 12),
    recent: (file.analysis?.recent ?? []).slice(-3).map((r) => `${r.date} ${r.home ? 'vs' : '@'} ${r.opponent} — ${r.note}`),
  };
  summaries[String(team.id)] = summary;
  AsyncStorage.setItem(SUMMARIES_KEY, JSON.stringify(summaries)).catch(() => {});
  return summary;
}

/** Moyenne pondérée des 10 derniers matchs et des 5 derniers au même endroit (domicile/extérieur). */
function rate(team: TeamSummary, venue: 'home' | 'away', key: TrendKey): [number, number] | undefined {
  const all = team.all[key];
  if (!all) return undefined;
  const v = team[venue][key];
  if (!v || team.n[venue] < 3) return all;
  return [(all[0] + v[0]) / 2, (all[1] + v[1]) / 2];
}

/**
 * Tendance du match : pour chaque marché, ce que les deux équipes produisent
 * (pour) et concèdent (contre) récemment. Null si l'une des deux équipes est
 * inconnue du fichier ou a moins de MIN_MATCHES matchs.
 */
export async function getMatchTrend(homeTeam: string, awayTeam: string): Promise<MatchTrend | null> {
  try {
    usage.lookups++;
    const index = await loadIndex();
    if (!index) return null;
    const hTeam = findTeam(index, homeTeam);
    const aTeam = findTeam(index, awayTeam);
    if (!hTeam || !aTeam || hTeam.id === aTeam.id) {
      usage.unknownTeams++;
      usage.lastUnknown = `${homeTeam} - ${awayTeam}`;
      return null;
    }
    const [h, a] = await Promise.all([ensureSummary(hTeam), ensureSummary(aTeam)]);
    if (!h || !a || h.n.all < MIN_MATCHES || a.n.all < MIN_MATCHES) return null;

    const expected: Partial<Record<TrendKey, number>> = {};
    const rates: MatchTrend['rates'] = { home: {}, away: {} };
    for (const key of KEYS) {
      const rh = rate(h, 'home', key);
      const ra = rate(a, 'away', key);
      if (rh) rates.home[key] = rh;
      if (ra) rates.away[key] = ra;
      if (!rh || !ra) continue;
      // Ce que A produit croisé avec ce que B concède, et inversement.
      expected[key] = (rh[0] + ra[1]) / 2 + (ra[0] + rh[1]) / 2;
    }
    const side = (key: 'goals_ft' | 'xg_ft', mine: TeamSummary, myVenue: 'home' | 'away', other: TeamSummary, otherVenue: 'home' | 'away') => {
      const m = rate(mine, myVenue, key);
      const o = rate(other, otherVenue, key);
      return m && o ? (m[0] + o[1]) / 2 : undefined;
    };
    const gH = side('goals_ft', h, 'home', a, 'away');
    const gA = side('goals_ft', a, 'away', h, 'home');
    const xH = side('xg_ft', h, 'home', a, 'away');
    const xA = side('xg_ft', a, 'away', h, 'home');
    const goals =
      gH != null && gA != null
        ? { home: xH != null ? (gH + xH) / 2 : gH, away: xA != null ? (gA + xA) / 2 : gA }
        : undefined;
    if (Object.keys(expected).length === 0 && !goals) return null;
    usage.withTrend++;
    usage.lastTrendAt = new Date().toISOString();
    return { homeTeam: h.name, awayTeam: a.name, expected, goals, samples: { home: h.n.all, away: a.n.all }, insights: { home: h.insights ?? [], away: a.insights ?? [] }, recent: { home: h.recent ?? [], away: a.recent ?? [] }, rates };
  } catch {
    return null;
  }
}

/** Buts attendus mêlés à la tendance (30 %) : l'expérience récente corrige la cote du jour. */
export function blendExpectedGoals(
  xg: { home: number; away: number },
  trend: MatchTrend | null | undefined
): { home: number; away: number } {
  if (!trend?.goals) return xg;
  return {
    home: xg.home * 0.7 + trend.goals.home * 0.3,
    away: xg.away * 0.7 + trend.goals.away * 0.3,
  };
}

/** Probabilité que le reste du match fournisse au moins `needed` événements (Poisson de moyenne lambda). */
function atLeast(lambda: number, needed: number): number {
  if (needed <= 0) return 1;
  let below = 0;
  for (let k = 0; k < needed; k++) below += poissonProb(lambda, k);
  return Math.max(0, 1 - below);
}

/**
 * Décision de la tendance pour une jambe « Plus/Moins de X » sur un compteur.
 * `trendLambda` = événements restants attendus selon la tendance. Renvoie la
 * probabilité que la tendance seule donne à la jambe ; `blocked` quand elle est
 * sous 30 % (la tendance contredit nettement le pari).
 */
export function trendVerdict(
  side: 'over' | 'under',
  line: number,
  observed: number,
  trendLambda: number
): { prob: number; blocked: boolean } {
  const neededOver = Math.floor(line) + 1 - observed; // événements encore requis pour « Plus de »
  const overProb = atLeast(trendLambda, neededOver);
  const prob = side === 'over' ? overProb : 1 - overProb;
  return { prob, blocked: prob < BLOCK_BELOW };
}

/** État du fichier de tendances pour le diagnostic de l'app. */
export async function getTeamStatsStatus(): Promise<{
  indexUpdatedAt: string | null;
  teamsInIndex: number;
  summariesCached: number;
  lookups: number;
  withTrend: number;
  unknownTeams: number;
  lastTrendAt: string | null;
  lastUnknown: string | null;
}> {
  const index = indexMemo?.index ?? null;
  const summaries = await loadSummaries();
  return {
    indexUpdatedAt: index?.updatedAt ?? null,
    teamsInIndex: index?.teams.length ?? 0,
    summariesCached: Object.keys(summaries).length,
    ...usage,
  };
}

const TREND_LABELS: Array<[TrendKey, string]> = [
  ['goals_ft', 'buts'],
  ['xg_ft', 'xG'],
  ['corners_ft', 'corners'],
  ['cards_ft', 'cartons'],
  ['fouls_ft', 'fautes'],
  ['corners_1h', 'corners 1ère MT'],
  ['cards_1h', 'cartons 1ère MT'],
];

function line(name: string, n: number, rates: MatchTrend['rates']['home']): string {
  const parts = TREND_LABELS.filter(([k]) => rates[k]).map(([k, label]) => `${label} ${rates[k]![0].toFixed(1)} pour, ${rates[k]![1].toFixed(1)} contre`);
  return `${name} (${n} derniers matchs avec stats, toutes compétitions) : ${parts.join(' ; ')}`;
}

function teamNotes(name: string, insights: string[], recent: string[]): string {
  if (insights.length === 0 && recent.length === 0) return '';
  return (
    `\n- Analyse ${name} : ${insights.join(' ')}` +
    (recent.length ? `\n  Derniers matchs : ${recent.join(' | ')}` : '')
  );
}

/** Texte de tendance injecté dans les analyses (Scouting IA) : ce que le fichier de stats dit des deux équipes. */
export function describeMatchTrend(trend: MatchTrend): string {
  const exp = TREND_LABELS.filter(([k]) => trend.expected[k] != null).map(([k, label]) => `${label} ${trend.expected[k]!.toFixed(1)}`);
  return (
    `Tendances des deux équipes (fichier de stats match par match, mis à jour chaque nuit) :\n` +
    `- ${line(trend.homeTeam, trend.samples.home, trend.rates.home)}\n` +
    `- ${line(trend.awayTeam, trend.samples.away, trend.rates.away)}\n` +
    `- Total attendu pour ce match d'après ces tendances : ${exp.join(', ')}.` +
    teamNotes(trend.homeTeam, trend.insights.home, trend.recent.home) +
    teamNotes(trend.awayTeam, trend.insights.away, trend.recent.away)
  );
}
