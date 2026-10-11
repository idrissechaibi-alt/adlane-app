// Sources de SECOURS pour les cotes (liste public-apis), utilisées seulement quand ni MoviOdds ni 365Scores
// ne connaissent le match :
//  - Bet Better : probabilités du modèle et cote juste (sans marge), EPL, picks gratuits avant-match
//    (licence CC BY 4.0, source : Bet Better — https://betbetter.world).
//  - FanLine Wire : snapshot FanDuel sans clé. Au dernier relevé il ne publie aucun football et ses prix n'ont ni
//    ligne ni nom de sélection : sondé pour le diagnostic, jamais lu comme une cote.
//  - Oddsmagnet : API payante / fichiers parquet historiques, inutilisable sur le téléphone ; sondé seulement.

import { namesLikelyMatch, normalizeTeamName } from '../../core/teamNameMatch';

const BET_BETTER_URL = 'https://betbetter.world/soccer?format=json';
const FANLINE_URL = 'https://fanlinewire.com/odds.json';
const ODDSMAGNET_URL = 'https://data.oddsmagnet.com/';
const TIMEOUT_MS = 12_000;
const BET_BETTER_TTL_MS = 30 * 60_000;

export interface BackupPick {
  home: string;
  away: string;
  market: string;
  selection: string;
  line: number | null;
  prob: number;
  fairOdds: number;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const same = (a: string, b: string) => {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);
  return x === y || namesLikelyMatch(x, y);
};

let betBetterCache: { at: number; picks: BackupPick[] } | null = null;

async function betBetterPicks(): Promise<BackupPick[]> {
  if (betBetterCache && Date.now() - betBetterCache.at < BET_BETTER_TTL_MS) return betBetterCache.picks;
  const data = await getJson(BET_BETTER_URL);
  if (!data?.picks) return betBetterCache?.picks ?? [];
  const picks: BackupPick[] = [];
  for (const p of data.picks) {
    if (p.locked || !p.game || !(p.fairOdds > 1)) continue;
    const [away, home] = String(p.game).split(' @ ');
    if (!home || !away) continue;
    picks.push({ home, away, market: p.market, selection: p.selection, line: p.line != null ? Number(p.line) : null, prob: Number(p.winProbabilityPct) / 100, fairOdds: Number(p.fairOdds) });
  }
  betBetterCache = { at: Date.now(), picks };
  return picks;
}

/**
 * Cote juste Bet Better (secours) d'une jambe « total de buts » : même match, même côté, même ligne.
 * null si Bet Better n'a pas ce pari dans son flux gratuit. Cote SANS marge : l'appelant la réduit.
 */
export async function backupTotalGoalsOdds(homeTeam: string, awayTeam: string, selection: string): Promise<{ fairOdds: number; prob: number } | null> {
  const m = selection.match(/^(plus|moins) de ([\d.,]+)/i);
  if (!m) return null;
  const side = m[1].toLowerCase() === 'plus' ? 'over' : 'under';
  const line = Number(m[2].replace(',', '.'));
  const pick = (await betBetterPicks()).find(
    (p) => p.market === 'Total Goals' && p.line === line && p.selection.toLowerCase() === side && same(p.home, homeTeam) && same(p.away, awayTeam)
  );
  return pick ? { fairOdds: pick.fairOdds, prob: pick.prob } : null;
}

/** Sondage des sources de secours (diagnostic, appHealth). */
export async function probeBackupSources(): Promise<Record<string, unknown>> {
  const [bb, fl, om] = await Promise.all([
    betBetterPicks().catch(() => []),
    getJson(FANLINE_URL),
    fetch(ODDSMAGNET_URL).then((r) => r.status).catch(() => null),
  ]);
  const fixtures: any[] = fl?.fixtures ?? [];
  return {
    betBetter: { freePicks: bb.length, totalGoals: bb.filter((p) => p.market === 'Total Goals').length },
    fanLine: { fixtures: fixtures.length, soccer: fixtures.filter((f) => /soccer|football/i.test(f.sport) && !/american/i.test(f.sport)).length },
    oddsmagnet: { httpStatus: om },
  };
}
