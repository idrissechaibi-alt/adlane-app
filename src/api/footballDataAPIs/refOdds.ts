// Cotes de référence GRATUITES : bet365 via l'API publique de 365Scores (sans clé).
// Disponibles, pendant le match, pour le résultat 1X2 et le total de buts (ligne
// affichée par la source, souvent 2.5). Aucune cote de corners, cartons ou fautes
// n'est publiée par les fournisseurs gratuits.
//
// Ce n'est pas le bookmaker de l'utilisateur : ces cotes servent de référence tant
// que lui n'a pas donné les siennes, et à mesurer l'écart de l'app avec un vrai marché.

import { namesLikelyMatch, normalizeTeamName } from '../../core/teamNameMatch';

const BASE = 'https://webws.365scores.com/web';
const PARAMS = 'appTypeId=5&langId=1&timezoneName=UTC&userCountryId=1';
const TIMEOUT_MS = 12_000;
const LIVE_TTL_MS = 45_000;
const DETAIL_TTL_MS = 60_000;

export interface RefOdds {
  gameId: number;
  source: 'bet365 (365Scores)';
  x12?: { home: number; draw: number; away: number };
  total?: { line: number; under: number; over: number };
  fetchedAt: number;
}

interface LiveGame {
  id: number;
  home: string;
  away: string;
  x12?: RefOdds['x12'];
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

function parseX12(odds: any): RefOdds['x12'] | undefined {
  if (!odds || odds.lineTypeId !== 1 || !Array.isArray(odds.options)) return undefined;
  const rate = (name: string) => odds.options.find((o: any) => o.name === name)?.rate?.decimal;
  const home = rate('1');
  const draw = rate('X');
  const away = rate('2');
  return home > 1 && draw > 1 && away > 1 ? { home, draw, away } : undefined;
}

function parseTotal(odds: any): RefOdds['total'] | undefined {
  if (!odds || odds.lineTypeId !== 3 || !Array.isArray(odds.options)) return undefined;
  const line = Number(odds.internalOptionValue);
  const under = odds.options.find((o: any) => o.name === 'Under')?.rate?.decimal;
  const over = odds.options.find((o: any) => o.name === 'Over')?.rate?.decimal;
  return Number.isFinite(line) && under > 1 && over > 1 ? { line, under, over } : undefined;
}

let liveCache: { at: number; games: LiveGame[] } | null = null;
const detailCache = new Map<number, RefOdds>();

async function liveGames(): Promise<LiveGame[]> {
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.games;
  const data = await getJson(`${BASE}/games/current/?${PARAMS}&sports=1&showOdds=true`);
  const games: LiveGame[] = (data?.games ?? [])
    .filter((g: any) => g?.homeCompetitor?.name && g?.awayCompetitor?.name)
    .map((g: any) => ({ id: g.id, home: g.homeCompetitor.name, away: g.awayCompetitor.name, x12: parseX12(g.odds) }));
  if (games.length > 0) liveCache = { at: Date.now(), games };
  return games.length > 0 ? games : liveCache?.games ?? [];
}

function sameTeams(a: string, b: string): boolean {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);
  return x === y || namesLikelyMatch(x, y);
}

/** Cotes bet365 d'un match en direct (1X2 et total de buts), ou null si la source ne le connaît pas. */
export async function getRefOdds(homeTeam: string, awayTeam: string): Promise<RefOdds | null> {
  try {
    const game = (await liveGames()).find((g) => sameTeams(g.home, homeTeam) && sameTeams(g.away, awayTeam));
    if (!game) return null;
    const cached = detailCache.get(game.id);
    if (cached && Date.now() - cached.fetchedAt < DETAIL_TTL_MS) return cached;
    const detail = await getJson(`${BASE}/game/?${PARAMS}&gameId=${game.id}&topBookmaker=14&showOdds=true`);
    const predictions: any[] = detail?.game?.promotedPredictions?.predictions ?? [];
    const result: RefOdds = { gameId: game.id, source: 'bet365 (365Scores)', x12: game.x12, total: undefined, fetchedAt: Date.now() };
    for (const p of predictions) {
      result.x12 ??= parseX12(p.odds);
      result.total ??= parseTotal(p.odds);
    }
    if (!result.x12 && !result.total) return null;
    detailCache.set(game.id, result);
    return result;
  } catch {
    return null;
  }
}

/** Cote de référence pour une jambe 1X2 ou « total de buts » dont la ligne est celle proposée par la source. */
export function refOddsForLeg(ref: RefOdds | null, market: string, selection: string): number | null {
  if (!ref) return null;
  if (market === '1X2' && ref.x12) {
    if (/domicile|^1\b/i.test(selection)) return ref.x12.home;
    if (/ext[ée]rieur|^2\b/i.test(selection)) return ref.x12.away;
    if (/nul|^x\b/i.test(selection)) return ref.x12.draw;
  }
  if (market === 'total_buts' && ref.total) {
    const m = selection.match(/^(plus|moins) de ([\d.,]+)/i);
    if (m && Math.abs(Number(m[2].replace(',', '.')) - ref.total.line) < 0.01) return m[1].toLowerCase() === 'plus' ? ref.total.over : ref.total.under;
  }
  return null;
}
