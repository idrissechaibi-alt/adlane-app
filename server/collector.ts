// COLLECTE (serveur PC) : stats de chaque match en direct, minute par minute, et résultat final de chaque match terminé.
// Publiées pour le téléphone dans data/server/live/<jour UTC>/<tranche>.json (lu par src/core/serverFeed.ts), toutes les
// 2 min. Les matchs réels (5 grands championnats + Ligue des champions) sont relevés chaque minute, les autres toutes
// les 5 min. Alerte Telegram quand un match réel atteint la 20e ou la 60e minute : le téléphone analyse dès l'ouverture.
import { hubDateKey, hubFinalResult, hubLiveEvents, hubStats, HubMatch } from '../src/api/footballDataAPIs/liveDataHub';
import { buildLiveSample, LiveStatsSample } from '../src/core/liveStatsStore';
import type { FeedFinal, FeedMatch, FeedSlice } from '../src/core/serverFeed';
import { SERVER_LIVE_DIR } from '../src/core/serverFeed';
import { sendTelegramMessage } from '../src/core/telegram';
import kvStore from '../src/core/kvStore';
import { repoPut } from './github';
import { log } from './log';

const REAL_RE: Array<[RegExp, RegExp]> = [
  [/england/i, /^premier league$/i],
  [/spain/i, /laliga|la liga|primera divisi/i],
  [/italy/i, /^serie a$/i],
  [/germany/i, /^bundesliga$/i],
  [/france/i, /^ligue 1$/i],
  [/./, /champions league/i],
];
const isReal = (m: HubMatch) =>
  REAL_RE.some(([c, l]) => l.test(m.league ?? '') && c.test(m.country ?? '')) &&
  !/women|féminin|u19|u21|u23|youth|afc|caf|concacaf|asian|african|conmebol/i.test(`${m.league ?? ''} ${m.country ?? ''}`);

const keyOf = (m: { homeTeam: string; awayTeam: string }) => `${m.homeTeam} - ${m.awayTeam}`;

interface Tracked {
  match: FeedMatch;
  day: string;
  lastSampleAt: number;
  lastMinute: number;
  lastStatus: string;
  lastSample: LiveStatsSample | null;
  htSample: LiveStatsSample | null;
  seenAt: number;
  finalTries: number;
  done: boolean;
}

const tracked = new Map<string, Tracked>();
/** Ce qui reste à publier, par jour : relevés et résultats. */
const pending = new Map<string, { samples: Record<string, LiveStatsSample[]>; finals: Record<string, FeedFinal> }>();
/** Tout ce qui a été publié dans la tranche en cours (fichier réécrit à chaque publication de la tranche). */
let slice: { id: string; day: string; data: FeedSlice } | null = null;
const startStamp = Date.now().toString(36);

function queueSample(t: Tracked, key: string, s: LiveStatsSample): void {
  const p = pending.get(t.day) ?? { samples: {}, finals: {} };
  (p.samples[key] ??= []).push(s);
  pending.set(t.day, p);
}

function queueFinal(t: Tracked, key: string, f: FeedFinal): void {
  const p = pending.get(t.day) ?? { samples: {}, finals: {} };
  p.finals[key] = f;
  pending.set(t.day, p);
}

/** Alerte Telegram 20e / 60e d'un match réel (une seule fois par match et par moment). */
async function wakeIfDue(key: string, m: HubMatch): Promise<void> {
  const moment = m.statusShort === '1H' && m.minute >= 18 && m.minute <= 30 ? '20' : m.statusShort === '2H' && m.minute >= 58 && m.minute <= 72 ? '60' : null;
  if (!moment) return;
  const store = `@server_wake_${hubDateKey()}`;
  const done: string[] = JSON.parse((await kvStore.getItem(store)) ?? '[]');
  const id = `${key}|${moment}`;
  if (done.includes(id)) return;
  done.push(id);
  await kvStore.setItem(store, JSON.stringify(done));
  await sendTelegramMessage(`⏱️ ${m.homeTeam} - ${m.awayTeam} (${m.homeGoals}-${m.awayGoals}) : ${m.minute}e minute. Ouvre l'app adlane pour l'analyse des paris de la ${moment}e.`).catch(() => false);
}

/** Un passage de collecte (chaque minute). */
export async function collectOnce(): Promise<{ live: number; sampled: number; finals: number }> {
  const live = await hubLiveEvents();
  const now = Date.now();
  const day = hubDateKey();
  const liveKeys = new Set<string>();
  let sampled = 0;

  // Réels chaque minute, les autres toutes les 5 min ; au plus 25 relevés détaillés par minute (sources gratuites).
  const due = live
    .map((m) => ({ m, key: keyOf(m), real: isReal(m) }))
    .filter(({ key, real }) => {
      const t = tracked.get(key);
      return !t || now - t.lastSampleAt >= (real ? 55_000 : 5 * 60_000 - 5_000);
    })
    .sort((a, b) => Number(b.real) - Number(a.real))
    .slice(0, 25);
  for (const m of live) liveKeys.add(keyOf(m));

  for (const { m, key, real } of due) {
    let t = tracked.get(key);
    if (!t) {
      t = { match: { home: m.homeTeam, away: m.awayTeam, league: m.league ?? '', country: m.country ?? '', real }, day, lastSampleAt: 0, lastMinute: 0, lastStatus: '', lastSample: null, htSample: null, seenAt: now, finalTries: 0, done: false };
      tracked.set(key, t);
    }
    if (real) await wakeIfDue(key, m).catch(() => {});
    const stats = await hubStats(m.homeTeam, m.awayTeam, day, null, { needFirstHalf: false }).catch(() => null);
    t.lastSampleAt = now;
    t.lastMinute = m.minute;
    t.lastStatus = m.statusShort;
    if (!stats?.all) continue;
    const s = buildLiveSample(m, stats.all);
    t.lastSample = s;
    if (m.statusShort === 'HT' || (m.statusShort === '1H' && m.minute >= 44)) t.htSample = s;
    queueSample(t, key, s);
    sampled++;
  }

  // Matchs sortis du direct après la 80e : résultat final (retenté à +5, +15, +45 min).
  let finals = 0;
  for (const [key, t] of tracked) {
    if (t.done || liveKeys.has(key)) continue;
    const gone = now - t.lastSampleAt;
    if (t.lastMinute < 80 && t.lastStatus !== 'HT') {
      if (gone > 3 * 3_600_000) tracked.delete(key);
      continue;
    }
    const waits = [5, 15, 45, 120];
    if (t.finalTries >= waits.length) {
      t.done = true;
      continue;
    }
    if (gone < waits[t.finalTries] * 60_000) continue;
    t.finalTries++;
    const r = await hubFinalResult(t.match.home, t.match.away, t.day).catch(() => null);
    if (!r) continue;
    const last = t.lastSample;
    const final: FeedFinal = {
      goalsHome: r.goalsHome,
      goalsAway: r.goalsAway,
      htHome: r.htHome,
      htAway: r.htAway,
      corners1H: r.corners1H ?? t.htSample?.corners,
      cards1H: r.cards1H ?? t.htSample?.cards,
      cornersFT: r.cornersFT ?? last?.corners,
      cornersHomeFT: last?.side?.h[2],
      cornersAwayFT: last?.side?.a[2],
      cardsFT: r.cardsFT ?? last?.cards,
      fouls1H: r.fouls1H,
      foulsFT: r.foulsFT ?? last?.fouls,
      at: new Date().toISOString(),
    };
    queueFinal(t, key, final);
    t.done = true;
    finals++;
    log(`Résultat final : ${key} ${r.goalsHome}-${r.goalsAway}`);
  }
  // Mémoire bornée : matchs terminés depuis plus de 6 h oubliés.
  for (const [key, t] of tracked) if (t.done && now - t.lastSampleAt > 6 * 3_600_000) tracked.delete(key);
  return { live: live.length, sampled, finals };
}

/** Publie ce qui a été collecté depuis la dernière fois (tranche de 10 min, réécrite tant qu'elle est en cours). */
export async function publish(): Promise<boolean> {
  if (pending.size === 0) return true;
  const d = new Date();
  const id = `${String(d.getUTCHours()).padStart(2, '0')}${String(Math.floor(d.getUTCMinutes() / 10) * 10).padStart(2, '0')}`;
  const days = [...pending.keys()];
  let ok = true;
  for (const day of days) {
    const p = pending.get(day)!;
    // Copie de la tranche + nouveautés : la tranche n'est mise à jour qu'une fois l'envoi réussi (jamais de doublon).
    const base = slice && slice.id === id && slice.day === day ? slice.data : { day, matches: {}, samples: {}, finals: {} };
    const next: FeedSlice = { day, matches: { ...base.matches }, samples: Object.fromEntries(Object.entries(base.samples).map(([k, v]) => [k, [...v]])), finals: { ...base.finals } };
    for (const [k, list] of Object.entries(p.samples)) (next.samples[k] ??= []).push(...list);
    Object.assign(next.finals, p.finals);
    for (const k of [...Object.keys(p.samples), ...Object.keys(p.finals)]) {
      const t = tracked.get(k);
      if (t) next.matches[k] = t.match;
    }
    const path = `${SERVER_LIVE_DIR}/${day}/${id}-${startStamp}.json`;
    const done = await repoPut(path, JSON.stringify(next), `[serveur PC] Collecte ${day} ${id}`).catch(() => false);
    if (done) {
      slice = { id, day, data: next };
      pending.delete(day);
    } else ok = false;
  }
  return ok;
}
