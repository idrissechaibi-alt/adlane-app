// Données de l'écran « Données Foot », toutes gratuites et sans clé :
//  - classements des 5 grands championnats + Ligue des champions (ESPN) ;
//  - fiches d'équipes : le fichier compilé chaque nuit (data/team-stats, FotMob) et enrichi en fin de match ;
//  - correspondance entre les deux (noms d'ESPN ↔ fichier des équipes).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { namesLikelyMatch, normalizeTeamName } from './teamNameMatch';

const TEAM_BASE = 'https://raw.githubusercontent.com/idrissechaibi-alt/adlane-app/main/data/team-stats';
const ESPN = 'https://site.api.espn.com/apis/v2/sports/soccer';
const STANDINGS_TTL_MS = 3 * 3600_000;
const TEAM_TTL_MS = 6 * 3600_000;

export interface LeagueDef {
  key: string;
  short: string;
  name: string;
  espn: string;
}

/** Les compétitions suivies par l'app : `name` = libellé du fichier des équipes. */
export const LEAGUES: LeagueDef[] = [
  { key: 'pl', short: 'PL', name: 'Premier League', espn: 'eng.1' },
  { key: 'liga', short: 'Liga', name: 'LaLiga', espn: 'esp.1' },
  { key: 'seriea', short: 'Serie A', name: 'Serie A', espn: 'ita.1' },
  { key: 'bundes', short: 'Bundes.', name: 'Bundesliga', espn: 'ger.1' },
  { key: 'l1', short: 'Ligue 1', name: 'Ligue 1', espn: 'fra.1' },
  { key: 'ucl', short: 'C1', name: 'Champions League', espn: 'uefa.champions' },
];

export interface StandingRow {
  rank: number;
  team: string;
  logo: string | null;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  diff: number;
  points: number;
  /** Zone (qualification, relégation…) quand ESPN la donne. */
  note: string | null;
  noteColor: string | null;
}

export interface Standings {
  league: string;
  season: string;
  rows: StandingRow[];
  fetchedAt: string;
}

async function getJson<T>(url: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function cached<T>(key: string, ttl: number, load: () => Promise<T | null>, force = false): Promise<{ data: T | null; stale: boolean }> {
  let old: { at: number; data: T } | null = null;
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) old = JSON.parse(raw);
  } catch {
    old = null;
  }
  if (!force && old && Date.now() - old.at < ttl) return { data: old.data, stale: false };
  const fresh = await load();
  if (fresh) {
    await AsyncStorage.setItem(key, JSON.stringify({ at: Date.now(), data: fresh })).catch(() => {});
    return { data: fresh, stale: false };
  }
  // Réseau absent : on garde la dernière version connue plutôt qu'un écran vide.
  return { data: old?.data ?? null, stale: !!old };
}

const num = (stats: Array<{ name: string; value?: number; displayValue?: string }>, name: string): number => {
  const s = stats.find((x) => x.name === name);
  return Number(s?.value ?? s?.displayValue ?? 0) || 0;
};

/** Classement ESPN d'une compétition (mis en cache 3 h, dernière version gardée hors ligne). */
export async function getStandings(league: LeagueDef, force = false): Promise<{ data: Standings | null; stale: boolean }> {
  return cached<Standings>(`@espn_standings_${league.espn}`, STANDINGS_TTL_MS, async () => {
    const d = await getJson<any>(`${ESPN}/${league.espn}/standings`);
    const group = d?.children?.[0];
    const entries: any[] = group?.standings?.entries ?? [];
    if (!entries.length) return null;
    const rows: StandingRow[] = entries.map((e) => {
      const stats = e.stats ?? [];
      return {
        rank: num(stats, 'rank'),
        team: e.team?.displayName ?? e.team?.name ?? '?',
        logo: e.team?.logos?.[0]?.href ?? null,
        played: num(stats, 'gamesPlayed'),
        wins: num(stats, 'wins'),
        draws: num(stats, 'ties'),
        losses: num(stats, 'losses'),
        goalsFor: num(stats, 'pointsFor'),
        goalsAgainst: num(stats, 'pointsAgainst'),
        diff: num(stats, 'pointDifferential'),
        points: num(stats, 'points'),
        note: e.note?.description ?? null,
        noteColor: e.note?.color ? `#${String(e.note.color).replace('#', '')}` : null,
      };
    });
    rows.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    return { league: league.name, season: d?.seasons?.[0]?.displayName ?? group?.name ?? '', rows, fetchedAt: new Date().toISOString() };
  }, force);
}

export interface TeamIndexEntry {
  id: number;
  name: string;
  shortName: string;
  leagues: string[];
  matches: number;
  lastMatch: string | null;
  updatedAt?: string;
}

export interface TeamIndexFile {
  updatedAt: string;
  teams: TeamIndexEntry[];
}

export async function getTeamIndex(force = false): Promise<{ data: TeamIndexFile | null; stale: boolean }> {
  return cached<TeamIndexFile>('@football_screen_team_index', TEAM_TTL_MS, () => getJson<TeamIndexFile>(`${TEAM_BASE}/index.json`), force);
}

export interface SheetPlayer {
  id: number;
  name: string;
  pos: string;
  apps: number;
  starts: number;
  minutes: number;
  goals: number;
  assists: number;
  sot: number;
  xg: number;
  yellow: number;
  sotPer90?: number | null;
  foulsPer90?: number | null;
}

export interface SheetMatch {
  date: string;
  competition: string;
  home: boolean;
  opponent: string;
  goalsFor: number;
  goalsAgainst: number;
  note: string;
}

export interface TeamSheet {
  id: number;
  name: string;
  leagues: string[];
  matches: number;
  form: { last5: string; ppg: number | null; record: { V: number; N: number; D: number } } | null;
  venue: { home: { ppg: number; gf: number; ga: number; n: number } | null; away: { ppg: number; gf: number; ga: number; n: number } | null };
  rates: Record<string, number>;
  /** Moyennes par match [pour, contre]. */
  averages: Record<string, [number, number]>;
  goalTiming: { for: Record<string, number>; against: Record<string, number> } | null;
  insights: string[];
  recent: SheetMatch[];
  usualFormation: string | null;
  usualXI: number[];
  players: SheetPlayer[];
  updatedAt: string | null;
}

const memoSheets: Record<number, TeamSheet> = {};

/** Fiche complète d'une équipe (fichier de nuit), réduite à ce que l'écran affiche avant mise en cache. */
export async function getTeamSheet(entry: TeamIndexEntry, force = false): Promise<TeamSheet | null> {
  if (!force && memoSheets[entry.id]) return memoSheets[entry.id];
  const { data } = await cached<TeamSheet>(`@football_screen_team_${entry.id}_${entry.lastMatch ?? ''}`, TEAM_TTL_MS, async () => {
    const f = await getJson<any>(`${TEAM_BASE}/teams/${entry.id}.json`);
    if (!f?.matches) return null;
    const a = f.analysis ?? {};
    const byDate = [...f.matches].filter((m: any) => m.goals).sort((x: any, y: any) => (x.date < y.date ? 1 : -1));
    const notes: Record<string, string> = {};
    for (const r of a.recent ?? []) notes[`${r.date}|${r.opponent}`] = r.note;
    const venue = (v: any) => (v?.matches ? { ppg: v.pointsPerGame, gf: v.goalsFor, ga: v.goalsAgainst, n: v.matches } : null);
    return {
      id: entry.id,
      name: f.name ?? entry.name,
      leagues: f.leagues ?? entry.leagues,
      matches: f.matches.length,
      form: a.form ? { last5: a.form.last5 ?? '', ppg: a.form.pointsPerGameSeason ?? null, record: a.form.record ?? { V: 0, N: 0, D: 0 } } : null,
      venue: { home: venue(a.home), away: venue(a.away) },
      rates: a.rates ?? {},
      averages: a.averages ?? {},
      goalTiming: a.goalTiming ? { for: a.goalTiming.for ?? {}, against: a.goalTiming.against ?? {} } : null,
      insights: a.insights ?? [],
      recent: byDate.slice(0, 8).map((m: any) => {
        const day = String(m.date).slice(0, 10);
        return {
          date: day,
          competition: m.competition ?? '',
          home: !!m.home,
          opponent: m.opponent?.name ?? '?',
          goalsFor: m.goals.for,
          goalsAgainst: m.goals.against,
          note: notes[`${day}|${m.opponent?.name}`] ?? m.note ?? '',
        };
      }),
      usualFormation: a.usualFormation ?? null,
      usualXI: a.usualXI ?? [],
      players: (a.players ?? []).slice(0, 18).map((p: any) => ({
        id: p.id, name: p.name, pos: p.pos, apps: p.apps, starts: p.starts, minutes: p.minutes, goals: p.goals, assists: p.assists,
        sot: p.sot, xg: p.xg, yellow: p.yellow, sotPer90: p.sotPer90, foulsPer90: p.foulsPer90,
      })),
      updatedAt: f.updatedAt ?? null,
    };
  }, force);
  if (data) memoSheets[entry.id] = data;
  return data;
}

/** Équipe du fichier correspondant à un nom (ESPN, planning…). */
export function findIndexTeam(index: TeamIndexFile | null, name: string): TeamIndexEntry | null {
  if (!index) return null;
  const wanted = normalizeTeamName(name);
  let loose: TeamIndexEntry | null = null;
  for (const t of index.teams) {
    const a = normalizeTeamName(t.name);
    const b = normalizeTeamName(t.shortName || t.name);
    if (a === wanted || b === wanted) return t;
    if (!loose && (namesLikelyMatch(wanted, a) || namesLikelyMatch(wanted, b))) loose = t;
  }
  return loose;
}
