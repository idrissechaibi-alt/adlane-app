// Bureau des 5 entraîneurs. Étape 1 : MODE OMBRE. Chaque pari réel est soumis à l'entraîneur de sa ligue, son verdict est
// enregistré, jamais appliqué. Une fois le pari réglé, on compare le résultat à ce qu'avait dit l'entraîneur ; le pouvoir de
// veto / d'ajustement ne s'active (étape 3) que si les paris contestés perdent clairement plus que les soutenus.

import AsyncStorage from '../kvStore';
import { readLiveStatsDay, type LiveStatsSample } from '../liveStatsStore';
import { readInPlayProposals, type InPlayProposal } from '../learnStore';
import { namesLikelyMatch, normalizeTeamName } from '../teamNameMatch';
import { COACHES, coachForLeague, type CoachProfile } from './knowledge';
import { opinionOn, readMatch, type CoachOpinion, type Stance, type TacticalRead } from './tacticalEngine';

const KEY = '@coach_shadow_v1';
/** Seuil de décision de l'étape 3 : nombre de paris réglés avant de juger l'apport d'un entraîneur. */
export const COACH_MIN_SETTLED = 200;
const MAX_RECORDS = 3000;

export interface ShadowVerdict {
  proposalId: string;
  at: string;
  coach: CoachProfile['id'];
  legs: Array<{ selection: string; market: string; prob: number; stance: Stance; adjust: number; reasons: string[]; won?: boolean }>;
  read: Pick<TacticalRead, 'minute' | 'diff' | 'dominance' | 'recentDominance' | 'tempoTrend' | 'profile' | 'phase' | 'flags' | 'reliable'> | null;
  settled?: boolean;
}

let memo: ShadowVerdict[] | null = null;

async function load(): Promise<ShadowVerdict[]> {
  if (memo) return memo;
  try {
    memo = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]');
  } catch {
    memo = [];
  }
  return memo!;
}

async function save(): Promise<void> {
  if (!memo) return;
  if (memo.length > MAX_RECORDS) memo = memo.slice(-MAX_RECORDS);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(memo));
  } catch {
    /* le prochain passage réenregistrera */
  }
}

/** Relevés du jour pour un match, quel que soit le nom sous lequel ils ont été rangés. */
async function samplesFor(homeTeam: string, awayTeam: string): Promise<LiveStatsSample[]> {
  const day = await readLiveStatsDay(new Date().toISOString().slice(0, 10));
  const h = normalizeTeamName(homeTeam);
  const a = normalizeTeamName(awayTeam);
  for (const [key, samples] of Object.entries(day)) {
    const parts = key.split(' - ');
    if (parts.length < 2) continue;
    const kh = normalizeTeamName(parts[0]);
    const ka = normalizeTeamName(parts.slice(1).join(' - '));
    if (namesLikelyMatch(h, kh) && namesLikelyMatch(a, ka)) return [...samples].sort((x, y) => x.minute - y.minute);
  }
  return [];
}

export interface CoachLegInput {
  market: string;
  selection: string;
  prob: number;
  league: string;
  homeTeam: string;
  awayTeam: string;
}

/** Avis de l'entraîneur de la ligue sur les jambes d'un pari (null si la ligue n'a pas d'entraîneur). */
export async function coachOpinions(legs: CoachLegInput[]): Promise<{ coach: CoachProfile; read: TacticalRead | null; opinions: CoachOpinion[] } | null> {
  const coach = coachForLeague(legs[0]?.league);
  if (!coach) return null;
  const read = readMatch(await samplesFor(legs[0].homeTeam, legs[0].awayTeam));
  return { coach, read, opinions: legs.map((l) => opinionOn(read, coach, l)) };
}

/** Enregistre le verdict d'ombre d'un pari réel qui vient d'être proposé (n'influence rien). */
export async function recordShadowVerdict(proposal: Pick<InPlayProposal, 'id' | 'legs'>): Promise<void> {
  try {
    const res = await coachOpinions(proposal.legs.map((l) => ({ market: l.market, selection: l.selection, prob: l.prob, league: l.league, homeTeam: l.homeTeam, awayTeam: l.awayTeam })));
    if (!res) return;
    const all = await load();
    if (all.some((v) => v.proposalId === proposal.id)) return;
    const r = res.read;
    all.push({
      proposalId: proposal.id,
      at: new Date().toISOString(),
      coach: res.coach.id,
      legs: proposal.legs.map((l, i) => ({ selection: l.selection, market: l.market, prob: l.prob, stance: res.opinions[i].stance, adjust: res.opinions[i].adjust, reasons: res.opinions[i].reasons })),
      read: r ? { minute: r.minute, diff: r.diff, dominance: r.dominance, recentDominance: r.recentDominance, tempoTrend: r.tempoTrend, profile: r.profile, phase: r.phase, flags: r.flags, reliable: r.reliable } : null,
    });
    await save();
  } catch (error: any) {
    console.warn('[Entraîneurs] Verdict d’ombre non enregistré:', error?.message);
  }
}

/** Reporte sur chaque verdict le résultat des jambes réglées (appelé après le bilan de minuit). */
export async function reconcileShadowVerdicts(): Promise<number> {
  const all = await load();
  const open = all.filter((v) => !v.settled);
  if (!open.length) return 0;
  const byId = new Map(readInPlayProposals().map((p) => [p.id, p]));
  let done = 0;
  for (const v of open) {
    const p = byId.get(v.proposalId);
    if (!p) continue;
    let all_ = true;
    p.legs.forEach((leg, i) => {
      if (!v.legs[i]) return;
      if (leg.voided) { v.legs[i].won = undefined; return; }
      if (leg.settled && leg.won != null) v.legs[i].won = leg.won;
      else all_ = false;
    });
    if (all_) { v.settled = true; done++; }
  }
  if (done) await save();
  return done;
}

export interface CoachRecord {
  coach: string;
  league: string;
  verdicts: number;
  settledLegs: number;
  supported: { n: number; won: number };
  contested: { n: number; won: number };
  neutral: { n: number; won: number };
  /** Taux de réussite des paris soutenus moins celui des contestés (en points) : l'apport estimé du veto. */
  edge: number | null;
  /** Le pouvoir peut-il être activé ? (étape 3) */
  ready: boolean;
}

export async function getCoachStatus(): Promise<{ coaches: CoachRecord[]; total: number }> {
  const all = await load();
  const coaches: CoachRecord[] = COACHES.map((c) => {
    const mine = all.filter((v) => v.coach === c.id);
    const bucket = { soutient: { n: 0, won: 0 }, conteste: { n: 0, won: 0 }, neutre: { n: 0, won: 0 } };
    let settledLegs = 0;
    for (const v of mine) for (const l of v.legs) {
      if (l.won == null) continue;
      settledLegs++;
      const b = bucket[l.stance];
      b.n++;
      if (l.won) b.won++;
    }
    const rate = (b: { n: number; won: number }) => (b.n ? b.won / b.n : null);
    const rs = rate(bucket.soutient);
    const rc = rate(bucket.conteste);
    const edge = rs != null && rc != null ? Math.round((rs - rc) * 1000) / 10 : null;
    return {
      coach: c.name,
      league: c.league,
      verdicts: mine.length,
      settledLegs,
      supported: bucket.soutient,
      contested: bucket.conteste,
      neutral: bucket.neutre,
      edge,
      ready: settledLegs >= COACH_MIN_SETTLED && bucket.conteste.n >= 30 && edge != null && edge >= 8,
    };
  });
  return { coaches, total: all.length };
}
