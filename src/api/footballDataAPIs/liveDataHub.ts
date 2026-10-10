// Données live MULTI-SOURCES gratuites : LiveScore, FotMob, 365Scores, ESPN,
// TheSportsDB et AllSportsApi (clé). Toutes répondent sans blocage d'IP.
// Principe : une source qui n'a pas une statistique (1ère mi-temps, corners,
// cartons, score à la pause…) est complétée par la suivante, match par match.
// Sert au pipe fictif ET de secours au pipe réel quand API-Football n'a plus
// de requêtes. Les matchs sont rapprochés entre sources par noms d'équipe.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAPIConfig } from '../multiAPIManager';
import { namesLikelyMatch, normalizeTeamName } from '../../core/teamNameMatch';
import {
  SofaEvent,
  SofaPeriodStats,
  SofaStats,
  fetchLiveScoreDate,
  fetchLiveScoreEvent,
  fetchLiveScoreLive,
  fetchLiveScoreStats,
} from './sofaScore';

export type HubProviderName = 'LiveScore' | 'FotMob' | '365Scores' | 'ESPN' | 'TheSportsDB' | 'AllSportsApi';

export interface HubMatch extends SofaEvent {
  provider: HubProviderName;
  /** Identifiant du match chez ce fournisseur. */
  ref: string;
  /** false = le fournisseur ne publie pas le score à la pause dans sa liste. */
  hasHalfTime: boolean;
}

interface HubDetail {
  stats: SofaStats;
  /** Score à la pause, quand le fournisseur le donne dans le détail. */
  ht?: [number, number];
}

interface Provider {
  name: HubProviderName;
  live(): Promise<HubMatch[]>;
  byDate(dateKey: string): Promise<HubMatch[]>;
  detail?(match: HubMatch): Promise<HubDetail>;
}

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

async function getJson(url: string, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '').replace('%', ''));
  return Number.isFinite(n) ? n : 0;
};

function utcDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** "57'" → 57, "45+2'" → 47, "90'+5'" → 95. */
function parseMinute(text: unknown): number | null {
  const m = /(\d+)\s*'?\s*(?:\+\s*(\d+))?/.exec(String(text ?? ''));
  return m ? Number(m[1]) + Number(m[2] ?? 0) : null;
}

function buildPeriod(p: {
  cornersHome: number; cornersAway: number; cardsHome: number; cardsAway: number;
  foulsHome?: number; foulsAway?: number; onTargetHome?: number; onTargetAway?: number;
  shotsHome?: number; shotsAway?: number; possessionHome?: number;
}): SofaPeriodStats | null {
  const total = p.cornersHome + p.cornersAway + p.cardsHome + p.cardsAway + (p.foulsHome ?? 0) + (p.foulsAway ?? 0) + (p.onTargetHome ?? 0) + (p.onTargetAway ?? 0);
  if (total === 0) return null; // pas de statistiques publiées : jamais de faux zéro
  return {
    corners: p.cornersHome + p.cornersAway,
    cards: p.cardsHome + p.cardsAway,
    fouls: (p.foulsHome ?? 0) + (p.foulsAway ?? 0),
    shotsOnTargetHome: p.onTargetHome ?? 0,
    shotsOnTargetAway: p.onTargetAway ?? 0,
    shotsTotalHome: p.shotsHome ?? 0,
    shotsTotalAway: p.shotsAway ?? 0,
    cornersHome: p.cornersHome,
    cornersAway: p.cornersAway,
    cardsHome: p.cardsHome,
    cardsAway: p.cardsAway,
    foulsHome: p.foulsHome ?? 0,
    foulsAway: p.foulsAway ?? 0,
    possessionHome: p.possessionHome,
  };
}

// ---------------------------------------------------------------- LiveScore

const liveScore: Provider = {
  name: 'LiveScore',
  async live() {
    return (await fetchLiveScoreLive()).map((e) => ({ ...e, provider: 'LiveScore', ref: String(-e.eventId), hasHalfTime: true }));
  },
  async byDate(dateKey) {
    return (await fetchLiveScoreDate(dateKey)).map((e) => ({ ...e, provider: 'LiveScore', ref: String(-e.eventId), hasHalfTime: true }));
  },
  async detail(match) {
    const eid = Number(match.ref);
    const [stats, event] = await Promise.all([fetchLiveScoreStats(eid), fetchLiveScoreEvent(eid).catch(() => null)]);
    return { stats, ht: event && event.statusShort !== '1H' ? [event.homeGoalsHT, event.awayGoalsHT] : undefined };
  },
};

// ---------------------------------------------------------------- FotMob

function mapFotMob(m: any, league: any): HubMatch | null {
  const homeTeam = m?.home?.longName || m?.home?.name;
  const awayTeam = m?.away?.longName || m?.away?.name;
  if (!m?.id || !homeTeam || !awayTeam) return null;
  const st = m.status ?? {};
  let statusShort = 'NS';
  let minute = 0;
  const reason = String(st.reason?.short ?? '');
  const liveShort = String(st.liveTime?.short ?? '');
  if (st.cancelled || st.awarded) statusShort = 'OTHER';
  else if (st.finished) {
    statusShort = /pen|aet|ET/i.test(reason) ? 'FT' : 'FT';
    minute = 90;
  } else if (st.started) {
    if (reason === 'HT' || liveShort === 'HT') {
      statusShort = 'HT';
      minute = 45;
    } else {
      minute = parseMinute(liveShort) ?? 0;
      statusShort = st.halfs?.secondHalfStarted ? '2H' : '1H';
      if (minute > 95) statusShort = 'OTHER'; // prolongation
    }
  }
  return {
    eventId: 0,
    provider: 'FotMob',
    ref: String(m.id),
    homeTeam,
    awayTeam,
    league: league?.name || 'Compétition inconnue',
    country: league?.ccode || '',
    statusShort,
    minute,
    homeGoals: num(m.home?.score),
    awayGoals: num(m.away?.score),
    homeGoalsHT: 0,
    awayGoalsHT: 0,
    hasHalfTime: false,
    startTimestamp: Date.parse(st.utcTime ?? '') / 1000 || 0,
  };
}

async function fotMobDate(dateKey: string): Promise<HubMatch[]> {
  const data = await getJson(`https://www.fotmob.com/api/data/matches?date=${dateKey.replace(/-/g, '')}&timezone=UTC`);
  const out: HubMatch[] = [];
  for (const league of data?.leagues ?? []) {
    for (const m of league.matches ?? []) {
      const mapped = mapFotMob(m, league);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}

function fotMobPeriod(period: any): SofaPeriodStats | null {
  const values = new Map<string, [number, number]>();
  for (const group of period?.stats ?? []) {
    for (const s of group.stats ?? []) {
      if (Array.isArray(s.stats) && s.stats.length === 2 && !values.has(s.key)) values.set(s.key, [num(s.stats[0]), num(s.stats[1])]);
    }
  }
  if (values.size === 0) return null;
  const v = (k: string) => values.get(k) ?? [0, 0];
  return buildPeriod({
    cornersHome: v('corners')[0], cornersAway: v('corners')[1],
    cardsHome: v('yellow_cards')[0] + v('red_cards')[0], cardsAway: v('yellow_cards')[1] + v('red_cards')[1],
    foulsHome: v('fouls')[0], foulsAway: v('fouls')[1],
    onTargetHome: v('ShotsOnTarget')[0], onTargetAway: v('ShotsOnTarget')[1],
    shotsHome: v('total_shots')[0], shotsAway: v('total_shots')[1],
    possessionHome: values.has('BallPossesion') ? v('BallPossesion')[0] : undefined,
  });
}

const fotMob: Provider = {
  name: 'FotMob',
  async live() {
    return (await fotMobDate(utcDay())).filter((m) => ['1H', 'HT', '2H'].includes(m.statusShort));
  },
  byDate: fotMobDate,
  async detail(match) {
    const d = await getJson(`https://www.fotmob.com/api/data/matchDetails?matchId=${match.ref}`);
    const periods = d?.content?.stats?.Periods ?? {};
    const events: any[] = d?.content?.matchFacts?.events?.events ?? [];
    const half = events.find((e) => e?.type === 'Half' && e?.halfStrShort === 'HT');
    return {
      stats: { all: fotMobPeriod(periods.All), firstHalf: fotMobPeriod(periods.FirstHalf) },
      ht: half ? [num(half.homeScore), num(half.awayScore)] : undefined,
    };
  },
};

// ---------------------------------------------------------------- 365Scores

const S365 = 'https://webws.365scores.com/web';
const S365_COMMON = 'appTypeId=5&langId=1&timezoneName=UTC&userCountryId=-1';

function map365(g: any, competitions: Map<number, any>): HubMatch | null {
  const homeTeam = g?.homeCompetitor?.name;
  const awayTeam = g?.awayCompetitor?.name;
  if (!g?.id || !homeTeam || !awayTeam) return null;
  const group = Number(g.statusGroup);
  const text = String(g.shortStatusText ?? g.statusText ?? '');
  let statusShort = 'OTHER';
  let minute = 0;
  if (group === 2) statusShort = 'NS';
  else if (group === 3) {
    if (/half\s*time|^HT$/i.test(text)) {
      statusShort = 'HT';
      minute = 45;
    } else {
      minute = Math.floor(num(g.gameTime));
      statusShort = /2nd/i.test(text) ? '2H' : /1st/i.test(text) ? '1H' : minute > 45 ? '2H' : '1H';
      if (/extra|penalt/i.test(text)) statusShort = 'OTHER';
    }
  } else if (group === 4 && /ended|final|after|aet|pen/i.test(text)) {
    statusShort = 'FT';
    minute = 90;
  }
  const competition = competitions.get(Number(g.competitionId));
  return {
    eventId: 0,
    provider: '365Scores',
    ref: String(g.id),
    homeTeam,
    awayTeam,
    league: competition?.name || g.competitionDisplayName || 'Compétition inconnue',
    country: '',
    statusShort,
    minute,
    homeGoals: Math.max(0, num(g.homeCompetitor?.score)),
    awayGoals: Math.max(0, num(g.awayCompetitor?.score)),
    homeGoalsHT: 0,
    awayGoalsHT: 0,
    hasHalfTime: false,
    startTimestamp: Date.parse(g.startTime ?? '') / 1000 || 0,
  };
}

function list365(data: any): HubMatch[] {
  const competitions = new Map<number, any>((data?.competitions ?? []).map((c: any) => [Number(c.id), c]));
  return (data?.games ?? []).map((g: any) => map365(g, competitions)).filter((m: HubMatch | null): m is HubMatch => m !== null);
}

const scores365: Provider = {
  name: '365Scores',
  async live() {
    return list365(await getJson(`${S365}/games/current/?${S365_COMMON}&sports=1`)).filter((m) => ['1H', 'HT', '2H'].includes(m.statusShort));
  },
  async byDate(dateKey) {
    const [y, mo, d] = dateKey.split('-');
    const day = `${d}/${mo}/${y}`;
    return list365(await getJson(`${S365}/games/allscores/?${S365_COMMON}&sports=1&startDate=${day}&endDate=${day}&onlyMajorGames=false&showOdds=false`));
  },
  async detail(match) {
    const d = await getJson(`${S365}/game/stats/?${S365_COMMON}&games=${match.ref}`);
    const homeId = Number(d?.games?.[0]?.homeCompetitor?.id);
    const pick = (names: string[]): [number, number] => {
      const out: [number, number] = [0, 0];
      for (const s of d?.statistics ?? []) {
        if (!names.includes(String(s.name))) continue;
        out[Number(s.competitorId) === homeId ? 0 : 1] = num(s.value);
      }
      return out;
    };
    const corners = pick(['Corners']);
    const yellow = pick(['Yellow Cards']);
    const red = pick(['Red Cards']);
    const fouls = pick(['Fouls', 'Fouls Committed']);
    const onTarget = pick(['Shots On Target']);
    const shots = pick(['Total Shots']);
    const possession = pick(['Possession']);
    return {
      stats: {
        all: buildPeriod({
          cornersHome: corners[0], cornersAway: corners[1],
          cardsHome: yellow[0] + red[0], cardsAway: yellow[1] + red[1],
          foulsHome: fouls[0], foulsAway: fouls[1],
          onTargetHome: onTarget[0], onTargetAway: onTarget[1],
          shotsHome: shots[0], shotsAway: shots[1],
          possessionHome: possession[0] || undefined,
        }),
        firstHalf: null,
      },
    };
  },
};

// ---------------------------------------------------------------- ESPN

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all';

function mapEspn(e: any): HubMatch | null {
  const comp = e?.competitions?.[0];
  const home = comp?.competitors?.find((c: any) => c.homeAway === 'home');
  const away = comp?.competitors?.find((c: any) => c.homeAway === 'away');
  if (!e?.id || !home?.team?.displayName || !away?.team?.displayName) return null;
  const type = e.status?.type ?? {};
  let statusShort = 'OTHER';
  let minute = 0;
  if (type.state === 'pre') statusShort = 'NS';
  else if (type.state === 'post' && type.completed) {
    statusShort = 'FT';
    minute = 90;
  } else if (type.state === 'in') {
    if (/HALFTIME/.test(String(type.name))) {
      statusShort = 'HT';
      minute = 45;
    } else {
      minute = parseMinute(e.status?.displayClock) ?? 0;
      const period = Number(e.status?.period);
      statusShort = period === 1 ? '1H' : period === 2 ? '2H' : 'OTHER';
    }
  }
  return {
    eventId: 0,
    provider: 'ESPN',
    ref: String(e.id),
    homeTeam: home.team.displayName,
    awayTeam: away.team.displayName,
    league: e.season?.slug || 'Compétition inconnue',
    country: '',
    statusShort,
    minute,
    homeGoals: num(home.score),
    awayGoals: num(away.score),
    homeGoalsHT: 0,
    awayGoalsHT: 0,
    hasHalfTime: false,
    startTimestamp: Date.parse(e.date ?? '') / 1000 || 0,
  };
}

const espn: Provider = {
  name: 'ESPN',
  async live() {
    const d = await getJson(`${ESPN}/scoreboard`);
    return (d?.events ?? []).map(mapEspn).filter((m: HubMatch | null): m is HubMatch => !!m && ['1H', 'HT', '2H'].includes(m.statusShort));
  },
  async byDate(dateKey) {
    const d = await getJson(`${ESPN}/scoreboard?dates=${dateKey.replace(/-/g, '')}`);
    return (d?.events ?? []).map(mapEspn).filter((m: HubMatch | null): m is HubMatch => m !== null);
  },
  async detail(match) {
    const d = await getJson(`${ESPN}/summary?event=${match.ref}`);
    const competitors: any[] = d?.header?.competitions?.[0]?.competitors ?? [];
    const homeId = String(competitors.find((c) => c.homeAway === 'home')?.team?.id ?? '');
    const teams: any[] = d?.boxscore?.teams ?? [];
    const homeT = teams.find((t) => String(t.team?.id) === homeId) ?? teams[0];
    const awayT = teams.find((t) => t !== homeT);
    const stat = (t: any, name: string) => num((t?.statistics ?? []).find((s: any) => s.name === name)?.displayValue);
    const homeC = competitors.find((c) => c.homeAway === 'home');
    const awayC = competitors.find((c) => c.homeAway === 'away');
    const htH = homeC?.linescores?.[0]?.displayValue;
    const htA = awayC?.linescores?.[0]?.displayValue;
    return {
      stats: {
        all: homeT && awayT ? buildPeriod({
          cornersHome: stat(homeT, 'wonCorners'), cornersAway: stat(awayT, 'wonCorners'),
          cardsHome: stat(homeT, 'yellowCards') + stat(homeT, 'redCards'), cardsAway: stat(awayT, 'yellowCards') + stat(awayT, 'redCards'),
          foulsHome: stat(homeT, 'foulsCommitted'), foulsAway: stat(awayT, 'foulsCommitted'),
          onTargetHome: stat(homeT, 'shotsOnTarget'), onTargetAway: stat(awayT, 'shotsOnTarget'),
          shotsHome: stat(homeT, 'totalShots'), shotsAway: stat(awayT, 'totalShots'),
          possessionHome: stat(homeT, 'possessionPct') || undefined,
        }) : null,
        firstHalf: null,
      },
      ht: htH != null && htA != null ? [num(htH), num(htA)] : undefined,
    };
  },
};

// ---------------------------------------------------------------- TheSportsDB

function mapSportsDb(x: any): HubMatch | null {
  if (!x?.strHomeTeam || !x?.strAwayTeam) return null;
  const s = String(x.strStatus ?? '');
  let statusShort = 'OTHER';
  let minute = 0;
  if (s === '1H' || s === '2H') {
    statusShort = s;
    minute = num(x.strProgress);
  } else if (s === 'HT') {
    statusShort = 'HT';
    minute = 45;
  } else if (/^(FT|AET|PEN|Match Finished)$/i.test(s)) {
    statusShort = 'FT';
    minute = 90;
  } else if (/^(NS|Not Started)$/i.test(s) || !s) statusShort = 'NS';
  return {
    eventId: 0,
    provider: 'TheSportsDB',
    ref: String(x.idEvent ?? x.idLiveScore),
    homeTeam: x.strHomeTeam,
    awayTeam: x.strAwayTeam,
    league: x.strLeague || 'Compétition inconnue',
    country: x.strCountry || '',
    statusShort,
    minute,
    homeGoals: num(x.intHomeScore),
    awayGoals: num(x.intAwayScore),
    homeGoalsHT: 0,
    awayGoalsHT: 0,
    hasHalfTime: false,
    startTimestamp: Date.parse(`${x.strTimestamp ?? ''}Z`) / 1000 || 0,
  };
}

const sportsDb: Provider = {
  name: 'TheSportsDB',
  async live() {
    const d = await getJson('https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Soccer');
    return (d?.livescore ?? []).map(mapSportsDb).filter((m: HubMatch | null): m is HubMatch => !!m && ['1H', 'HT', '2H'].includes(m.statusShort));
  },
  async byDate(dateKey) {
    const d = await getJson(`https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${dateKey}&s=Soccer`);
    return (d?.events ?? []).map(mapSportsDb).filter((m: HubMatch | null): m is HubMatch => m !== null);
  },
};

// ---------------------------------------------------------------- AllSportsApi (clé)

const ALLSPORTS = 'https://apiv2.allsportsapi.com/football/';
const allSportsRaw = new Map<string, any>();

function mapAllSports(x: any): HubMatch | null {
  if (!x?.event_key || !x?.event_home_team || !x?.event_away_team) return null;
  const status = String(x.event_status ?? '');
  const score = /(\d+)\s*-\s*(\d+)/.exec(String(x.event_final_result ?? ''));
  const ht = /(\d+)\s*-\s*(\d+)/.exec(String(x.event_halftime_result ?? ''));
  let statusShort = 'NS';
  let minute = 0;
  if (/finished|after/i.test(status)) {
    statusShort = 'FT';
    minute = 90;
  } else if (/half\s*time/i.test(status)) {
    statusShort = 'HT';
    minute = 45;
  } else if (String(x.event_live) === '1') {
    minute = parseMinute(status) ?? 0;
    statusShort = minute > 45 ? '2H' : '1H';
  } else if (/postp|cancel|aband/i.test(status)) statusShort = 'OTHER';
  allSportsRaw.set(String(x.event_key), x);
  return {
    eventId: 0,
    provider: 'AllSportsApi',
    ref: String(x.event_key),
    homeTeam: String(x.event_home_team),
    awayTeam: String(x.event_away_team),
    league: x.league_name || 'Compétition inconnue',
    country: x.country_name || '',
    statusShort,
    minute,
    homeGoals: score ? Number(score[1]) : 0,
    awayGoals: score ? Number(score[2]) : 0,
    homeGoalsHT: ht ? Number(ht[1]) : 0,
    awayGoalsHT: ht ? Number(ht[2]) : 0,
    hasHalfTime: Boolean(ht),
    startTimestamp: Date.parse(`${x.event_date}T${x.event_time || '00:00'}:00Z`) / 1000 || 0,
  };
}

async function allSportsKey(): Promise<string> {
  const key = (await getAPIConfig()).allSports?.trim();
  if (!key) throw new Error('clé absente');
  return key;
}

const allSports: Provider = {
  name: 'AllSportsApi',
  async live() {
    const d = await getJson(`${ALLSPORTS}?met=Livescore&timezone=UTC&APIkey=${encodeURIComponent(await allSportsKey())}`);
    return (Array.isArray(d?.result) ? d.result : []).map(mapAllSports).filter((m: HubMatch | null): m is HubMatch => m !== null);
  },
  async byDate(dateKey) {
    const d = await getJson(`${ALLSPORTS}?met=Fixtures&timezone=UTC&APIkey=${encodeURIComponent(await allSportsKey())}&from=${dateKey}&to=${dateKey}`);
    return (Array.isArray(d?.result) ? d.result : []).map(mapAllSports).filter((m: HubMatch | null): m is HubMatch => m !== null);
  },
  async detail(match) {
    const x = allSportsRaw.get(match.ref);
    const stats: any[] = x?.statistics ?? [];
    const pair = (type: string): [number, number] => {
      const row = stats.find((s) => s?.type === type);
      return row ? [num(row.home), num(row.away)] : [0, 0];
    };
    const cards: any[] = Array.isArray(x?.cards) ? x.cards : [];
    const count = (side: 'home' | 'away', firstHalf: boolean) =>
      cards.filter((c) => (c.home_fault ? 'home' : c.away_fault ? 'away' : c.info) === side && (!firstHalf || num(c.time) <= 45)).length;
    const corners = pair('Corners');
    const onTarget = pair('On Target');
    return {
      stats: {
        all: buildPeriod({
          cornersHome: corners[0], cornersAway: corners[1],
          cardsHome: count('home', false), cardsAway: count('away', false),
          onTargetHome: onTarget[0], onTargetAway: onTarget[1],
        }),
        firstHalf: null,
      },
    };
  },
};

// ---------------------------------------------------------------- Agrégation

/** Ordre de priorité : la source la plus complète d'abord. */
const PROVIDERS: Provider[] = [liveScore, fotMob, scores365, espn, allSports, sportsDb];

const LIVE_TTL_MS = 90_000;
const TODAY_TTL_MS = 10 * 60_000;
const PAST_TTL_MS = 6 * 3_600_000;
const FAILURE_PAUSE_MS = 5 * 60_000;

const cache = new Map<string, { at: number; data: HubMatch[] }>();
const pausedUntil = new Map<string, number>();
const STATUS_KEY = '@live_data_hub_status';
const status: Record<string, { ok: boolean; count?: number; error?: string; at: string }> = {};
let statusDirty = false;

function noteStatus(provider: HubProviderName, ok: boolean, count?: number, error?: string) {
  status[provider] = { ok, count, error, at: new Date().toISOString() };
  statusDirty = true;
}

async function flushStatus(): Promise<void> {
  if (!statusDirty) return;
  statusDirty = false;
  try {
    await AsyncStorage.setItem(STATUS_KEY, JSON.stringify(status));
  } catch {
    // diagnostic best-effort
  }
}

async function cachedList(provider: Provider, kind: 'live' | string): Promise<HubMatch[]> {
  const key = `${provider.name}|${kind}`;
  const ttl = kind === 'live' ? LIVE_TTL_MS : kind >= utcDay(-1) ? TODAY_TTL_MS : PAST_TTL_MS;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if ((pausedUntil.get(key) ?? 0) > Date.now()) return hit?.data ?? [];
  try {
    const data = kind === 'live' ? await provider.live() : await provider.byDate(kind);
    cache.set(key, { at: Date.now(), data });
    if (kind === 'live') noteStatus(provider.name, true, data.length);
    return data;
  } catch (error: any) {
    pausedUntil.set(key, Date.now() + FAILURE_PAUSE_MS);
    if (kind === 'live' && error?.message !== 'clé absente') noteStatus(provider.name, false, undefined, error?.message || 'injoignable');
    return hit?.data ?? [];
  }
}

function sameMatch(a: { homeTeam: string; awayTeam: string }, b: { homeTeam: string; awayTeam: string }): boolean {
  const ah = normalizeTeamName(a.homeTeam);
  const aa = normalizeTeamName(a.awayTeam);
  const bh = normalizeTeamName(b.homeTeam);
  const ba = normalizeTeamName(b.awayTeam);
  return namesLikelyMatch(ah, bh) && namesLikelyMatch(aa, ba);
}

/** Tous les matchs en cours, toutes sources réunies (sans doublon, la
 * source prioritaire gardée pour chaque match). */
export async function hubLiveEvents(): Promise<HubMatch[]> {
  const lists = await Promise.all(PROVIDERS.map((p) => cachedList(p, 'live')));
  await flushStatus();
  const merged: HubMatch[] = [];
  for (const list of lists) {
    for (const m of list) {
      if (!['1H', 'HT', '2H'].includes(m.statusShort)) continue;
      if (!merged.some((x) => sameMatch(x, m))) merged.push(m);
    }
  }
  return merged;
}

/** Ce match chez chaque fournisseur qui le connaît (ordre de priorité). */
async function findEverywhere(homeTeam: string, awayTeam: string, dateKey: string, includeLive: boolean): Promise<HubMatch[]> {
  const target = { homeTeam, awayTeam };
  const found: HubMatch[] = [];
  await Promise.all(
    PROVIDERS.map(async (p, index) => {
      const lists = await Promise.all([cachedList(p, dateKey), includeLive ? cachedList(p, 'live') : Promise.resolve([])]);
      const live = lists[1].find((m) => sameMatch(m, target));
      const dated = lists[0].find((m) => sameMatch(m, target));
      const hit = live ?? dated;
      if (hit) found[index] = hit;
    })
  );
  return found.filter(Boolean);
}

const detailCache = new Map<string, { at: number; data: HubDetail }>();
const DETAIL_TTL_MS = 60_000;

async function detailOf(match: HubMatch): Promise<HubDetail | null> {
  const provider = PROVIDERS.find((p) => p.name === match.provider);
  if (!provider?.detail) return null;
  const key = `${match.provider}|${match.ref}|${match.statusShort}`;
  const hit = detailCache.get(key);
  const ttl = match.statusShort === 'FT' ? PAST_TTL_MS : DETAIL_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  try {
    const data = await provider.detail(match);
    detailCache.set(key, { at: Date.now(), data });
    if (detailCache.size > 400) detailCache.delete(detailCache.keys().next().value as string);
    return data;
  } catch {
    return null;
  }
}

/**
 * Statistiques d'un match : celles déjà obtenues (`primary`) complétées,
 * période par période, par les autres sources jusqu'à avoir le match entier
 * ET la 1ère mi-temps.
 */
export async function hubStats(homeTeam: string, awayTeam: string, dateKey: string, primary?: SofaStats | null): Promise<SofaStats> {
  const result: SofaStats = { all: primary?.all ?? null, firstHalf: primary?.firstHalf ?? null };
  if (result.all && result.firstHalf) return result;
  const matches = await findEverywhere(homeTeam, awayTeam, dateKey, dateKey === utcDay());
  for (const m of matches) {
    const detail = await detailOf(m);
    if (!detail) continue;
    result.all ??= detail.stats.all;
    result.firstHalf ??= detail.stats.firstHalf;
    if (result.all && result.firstHalf) break;
  }
  return result;
}

/** Statut en direct d'un match (score, minute) depuis la première source qui le suit. */
export async function hubLiveStatus(homeTeam: string, awayTeam: string): Promise<HubMatch | null> {
  const live = await hubLiveEvents();
  return live.find((m) => sameMatch(m, { homeTeam, awayTeam })) ?? null;
}

export interface HubFinalResult {
  goalsHome: number;
  goalsAway: number;
  htHome: number;
  htAway: number;
  corners1H?: number;
  cards1H?: number;
  sources: HubProviderName[];
}

/**
 * Résultat final d'un match terminé. Le score retenu est celui sur lequel le
 * plus de sources s'accordent (la source prioritaire départage) ; le score à
 * la pause et les stats de 1ère mi-temps viennent de la première source qui
 * les publie. null tant qu'aucune source ne le donne terminé, ou sans score
 * à la pause (indispensable aux marchés 1ère mi-temps).
 */
export async function hubFinalResult(homeTeam: string, awayTeam: string, dateKey: string): Promise<HubFinalResult | null> {
  let matches = (await findEverywhere(homeTeam, awayTeam, dateKey, false)).filter((m) => m.statusShort === 'FT');
  if (matches.length === 0) {
    // Fuseaux différents selon la source : match tard le soir rangé au lendemain.
    const next = new Date(Date.parse(`${dateKey}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (next <= utcDay()) matches = (await findEverywhere(homeTeam, awayTeam, next, false)).filter((m) => m.statusShort === 'FT');
  }
  if (matches.length === 0) return null;

  const votes = new Map<string, number>();
  for (const m of matches) votes.set(`${m.homeGoals}-${m.awayGoals}`, (votes.get(`${m.homeGoals}-${m.awayGoals}`) ?? 0) + 1);
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const [goalsHome, goalsAway] = best.split('-').map(Number);
  const agreeing = matches.filter((m) => `${m.homeGoals}-${m.awayGoals}` === best);

  let ht: [number, number] | undefined;
  const fromList = agreeing.find((m) => m.hasHalfTime);
  if (fromList) ht = [fromList.homeGoalsHT, fromList.awayGoalsHT];
  let firstHalf: SofaPeriodStats | null = null;
  for (const m of agreeing) {
    if (ht && firstHalf) break;
    const detail = await detailOf(m);
    if (!detail) continue;
    ht ??= detail.ht;
    firstHalf ??= detail.stats.firstHalf;
  }
  if (!ht) return null;
  if (ht[0] > goalsHome || ht[1] > goalsAway) return null; // incohérent : on n'invente rien

  return {
    goalsHome,
    goalsAway,
    htHome: ht[0],
    htAway: ht[1],
    corners1H: firstHalf?.corners,
    cards1H: firstHalf?.cards,
    sources: agreeing.map((m) => m.provider),
  };
}

/** État de chaque source au dernier relevé en direct (diagnostic / écran). */
export async function getHubStatus(): Promise<Record<string, { ok: boolean; count?: number; error?: string; at: string }>> {
  if (Object.keys(status).length > 0) return status;
  try {
    const raw = await AsyncStorage.getItem(STATUS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export { utcDay as hubDateKey };

/** Programme d'une date (UTC), toutes sources réunies sans doublon :
 * LiveScore d'abord, complété par FotMob, 365Scores, ESPN, AllSportsApi. */
export async function hubScheduled(dateKey: string): Promise<HubMatch[]> {
  const lists = await Promise.all(PROVIDERS.filter((p) => p.name !== 'TheSportsDB').map((p) => cachedList(p, dateKey)));
  const merged: HubMatch[] = [];
  // Un même match a la même heure de coup d'envoi partout : on ne compare les
  // noms qu'entre matchs du même quart d'heure (rapide même à 2 000 matchs).
  const byKickoff = new Map<number, HubMatch[]>();
  for (const list of lists) {
    for (const m of list) {
      const slot = Math.round(m.startTimestamp / 900);
      // ±3 h : certaines sources décalent l'heure (fuseau, horaire provisoire).
      const nearby: HubMatch[] = [];
      for (let k = slot - 12; k <= slot + 12; k++) nearby.push(...(byKickoff.get(k) ?? []));
      if (nearby.some((x) => sameMatch(x, m))) continue;
      merged.push(m);
      byKickoff.set(slot, [...(byKickoff.get(slot) ?? []), m]);
    }
  }
  return merged;
}
