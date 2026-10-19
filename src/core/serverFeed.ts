// COLLECTE DU SERVEUR PC → TÉLÉPHONE.
//
// Le serveur du PC (server/collector.ts) relève les stats de chaque match en direct minute par minute, note le résultat
// final de chaque match terminé, et publie le tout dans data/server/live/<jour UTC>/<tranche de 10 min>.json. Le
// téléphone, à chacun de ses réveils (même app fermée), rapatrie les tranches nouvelles et les verse dans ses propres
// relevés : l'analyse, les paris, les notifications, le règlement et l'apprentissage restent sur le téléphone, mais ne
// dépendent plus de l'app gardée ouverte pour avoir la chronologie complète de chaque match.

import AsyncStorage from './kvStore';
import { fetchRepoText, listRepoDir } from './gitAutoSync';
import { isRunningOnServer } from './serverMode';
import { LiveStatsSample, mergeLiveSamples } from './liveStatsStore';
import { MatchSample, readMatchTimelines, readStoredFictionalProgram, writeMatchTimelines } from './fictionalProgram';
import { namesLikelyMatch, normalizeTeamName } from './teamNameMatch';
import { canonicalMatchKey } from './inPlayCombos';
import { getDailyPlan } from './scheduler';

export const SERVER_LIVE_DIR = 'data/server/live';

/** Match suivi par le serveur. `real` : 5 grands championnats et Ligue des champions. */
export interface FeedMatch {
  home: string;
  away: string;
  league: string;
  country: string;
  real: boolean;
}

/** Résultat final noté par le serveur (consensus des sources + comptes de son propre relevé). */
export interface FeedFinal {
  goalsHome: number;
  goalsAway: number;
  htHome: number;
  htAway: number;
  corners1H?: number;
  cards1H?: number;
  cornersFT?: number;
  cornersHomeFT?: number;
  cornersAwayFT?: number;
  cardsFT?: number;
  fouls1H?: number;
  foulsFT?: number;
  at: string;
}

/** Une tranche publiée par le serveur. */
export interface FeedSlice {
  day: string;
  matches: Record<string, FeedMatch>;
  samples: Record<string, LiveStatsSample[]>;
  finals: Record<string, FeedFinal>;
}

const PULL_KEY = '@server_feed_pull';
const FINALS_KEY = (day: string) => `@server_finals_${day}`;
const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const sameMatch = (aHome: string, aAway: string, bHome: string, bAway: string) =>
  namesLikelyMatch(normalizeTeamName(aHome), normalizeTeamName(bHome)) && namesLikelyMatch(normalizeTeamName(aAway), normalizeTeamName(bAway));

/** Résultat final d'un match d'après le serveur PC (null s'il ne l'a pas noté). */
export async function serverFinalFor(homeTeam: string, awayTeam: string, day: string): Promise<FeedFinal | null> {
  for (const d of [day, new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)]) {
    try {
      const all: Record<string, FeedFinal & { home: string; away: string }> = JSON.parse((await AsyncStorage.getItem(FINALS_KEY(d))) ?? '{}');
      const hit = Object.values(all).find((f) => sameMatch(f.home, f.away, homeTeam, awayTeam));
      if (hit) return hit;
    } catch {
      // stockage illisible : pas de résultat serveur
    }
  }
  return null;
}

let pulling: Promise<number> | null = null;
let lastPullAt = 0;

/**
 * Rapatrie les tranches nouvelles du serveur (aujourd'hui et hier, pour les matchs finis après minuit) et les verse dans
 * les relevés du téléphone. Au plus toutes les 90 s. Renvoie le nombre de relevés ajoutés.
 */
export function pullServerLiveFeed(): Promise<number> {
  if (isRunningOnServer()) return Promise.resolve(0);
  if (pulling) return pulling;
  if (Date.now() - lastPullAt < 90_000) return Promise.resolve(0);
  lastPullAt = Date.now();
  pulling = (async () => {
    const seen: Record<string, string> = JSON.parse((await AsyncStorage.getItem(PULL_KEY)) ?? '{}');
    let added = 0;
    for (const day of [utcDay(-1), utcDay()]) {
      const files = await listRepoDir(`${SERVER_LIVE_DIR}/${day}`);
      if (!files) continue;
      for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
        if (seen[f.path] === f.sha) continue;
        const raw = await fetchRepoText(f.path);
        if (!raw) continue;
        try {
          added += await mergeSlice(JSON.parse(raw) as FeedSlice);
          seen[f.path] = f.sha;
        } catch {
          // tranche illisible : retentée au prochain passage
        }
      }
    }
    // Mémoire des tranches lues : seuls les 3 derniers jours.
    const keep = new Set([utcDay(-2), utcDay(-1), utcDay()]);
    for (const k of Object.keys(seen)) if (!keep.has(k.split('/')[3])) delete seen[k];
    await AsyncStorage.setItem(PULL_KEY, JSON.stringify(seen));
    return added;
  })()
    .catch(() => 0)
    .finally(() => {
      pulling = null;
    });
  return pulling;
}

async function mergeSlice(slice: FeedSlice): Promise<number> {
  let added = 0;
  // Résultats finaux : gardés pour le bilan (dailyReview → serverFinalFor).
  if (Object.keys(slice.finals ?? {}).length) {
    const all = JSON.parse((await AsyncStorage.getItem(FINALS_KEY(slice.day))) ?? '{}');
    for (const [k, fin] of Object.entries(slice.finals)) {
      const m = slice.matches[k];
      if (m) all[k] = { ...fin, home: m.home, away: m.away };
    }
    await AsyncStorage.setItem(FINALS_KEY(slice.day), JSON.stringify(all));
  }
  // Matchs réels : dans le relevé minute par minute du téléphone (digest de fin de match, motifs, fichier des équipes).
  // Clé du planning du jour quand le match y est, pour ne jamais créer un doublon de nom.
  const plan = await getDailyPlan().catch(() => null);
  const planned = (plan?.slots ?? []).flatMap((s: any) => s.matches as Array<{ homeTeam: string; awayTeam: string }>);
  for (const [k, samples] of Object.entries(slice.samples ?? {})) {
    const m = slice.matches[k];
    if (!m?.real || !samples.length) continue;
    added += await mergeLiveSamples(slice.day, canonicalMatchKey({ homeTeam: m.home, awayTeam: m.away }, planned), samples);
  }
  // Matchs du programme fictif : dans leur chronologie (rythme observé, motifs, règlement de secours).
  const program = await readStoredFictionalProgram(slice.day).catch(() => []);
  if (program.length) {
    const timelines = await readMatchTimelines(slice.day);
    let touched = false;
    for (const [k, samples] of Object.entries(slice.samples ?? {})) {
      const m = slice.matches[k];
      if (!m || m.real || !samples.length) continue;
      const p = program.find((x) => sameMatch(x.homeTeam, x.awayTeam, m.home, m.away));
      if (!p) continue;
      const tl = (timelines[p.fixtureId] ??= []);
      const lastTs = tl.length ? Date.parse(tl[tl.length - 1].ts) : 0;
      for (const x of samples) {
        if (Date.parse(x.ts) <= lastTs + 30_000) continue;
        const sample: MatchSample = {
          ts: x.ts,
          minute: x.minute,
          statusShort: x.status,
          homeGoals: x.home,
          awayGoals: x.away,
          shotsOnTargetHome: x.side?.h[1],
          shotsOnTargetAway: x.side?.a[1],
          cornersTotal: x.corners,
          cardsTotal: x.cards,
          ...(x.adv ? { adv: x.adv } : {}),
        };
        tl.push(sample);
        added++;
        touched = true;
      }
    }
    if (touched) await writeMatchTimelines(timelines, slice.day);
  }
  return added;
}
