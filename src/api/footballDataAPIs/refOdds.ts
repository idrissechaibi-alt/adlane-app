// Cotes de référence GRATUITES : bet365 via l'API publique de 365Scores (sans clé).
// Disponibles, pendant le match, pour le résultat 1X2 et le total de buts (ligne
// affichée par la source, souvent 2.5). Aucune cote de corners, cartons ou fautes
// n'est publiée par les fournisseurs gratuits.
//
// Ce n'est pas le bookmaker de l'utilisateur : ces cotes servent de référence tant
// que lui n'a pas donné les siennes, et à mesurer l'écart de l'app avec un vrai marché.

import { namesLikelyMatch, normalizeTeamName } from '../../core/teamNameMatch';

// Autre source gratuite sans clé (liste public-apis) : MoviOdds, le tableau bet365 complet — buts, corners,
// cartons, BTTS, tirs cadrés joueur… avec les lignes réellement proposées et leurs cotes en direct.
const MOVI_URL = 'https://moviodds.com/odds?in_play=1&groups=1777,10565,421,17,5,16,441,10160,50197,1781,50554,177906';
const MOVI_TTL_MS = 40_000;

const BASE = 'https://webws.365scores.com/web';
const PARAMS = 'appTypeId=5&langId=1&timezoneName=UTC&userCountryId=1';
const TIMEOUT_MS = 12_000;
const LIVE_TTL_MS = 45_000;
const DETAIL_TTL_MS = 60_000;

/** Une cote du tableau bet365 de MoviOdds (marché identifié par son numéro de groupe). */
export interface BoardQuote {
  group: string;
  /** Over / Under / Exactly, ou le nom du joueur pour les marchés joueur. */
  side: string | null;
  line: number | null;
  /** Oui / Non, nom d'équipe, « 1+ »… */
  label: string | null;
  odds: number;
}

export interface RefOdds {
  gameId: number;
  source: 'bet365 (365Scores)' | 'bet365 (MoviOdds)';
  /** Toutes les cotes ouvertes (non suspendues) que bet365 propose en ce moment sur le match, par marché. */
  board?: BoardQuote[];
  x12?: { home: number; draw: number; away: number };
  total?: { line: number; under: number; over: number };
  fetchedAt: number;
}

interface LiveGame {
  id: number;
  home: string;
  away: string;
  x12?: RefOdds['x12'];
  /** Cotes d'OUVERTURE (avant-match) : servent à savoir qui est le favori. */
  x12Open?: RefOdds['x12'];
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

function parseX12Open(odds: any): RefOdds['x12'] | undefined {
  if (!odds || odds.lineTypeId !== 1 || !Array.isArray(odds.options)) return undefined;
  const rate = (name: string) => odds.options.find((o: any) => o.name === name)?.originalRate?.decimal;
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
    .map((g: any) => ({ id: g.id, home: g.homeCompetitor.name, away: g.awayCompetitor.name, x12: parseX12(g.odds), x12Open: parseX12Open(g.odds) }));
  if (games.length > 0) liveCache = { at: Date.now(), games };
  return games.length > 0 ? games : liveCache?.games ?? [];
}

function sameTeams(a: string, b: string): boolean {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);
  return x === y || namesLikelyMatch(x, y);
}

interface MoviMatch { home: string; away: string; id: string; board: BoardQuote[] }
let moviCache: { at: number; matches: MoviMatch[] } | null = null;

async function moviMatches(): Promise<MoviMatch[]> {
  if (moviCache && Date.now() - moviCache.at < MOVI_TTL_MS) return moviCache.matches;
  const data = await getJson(MOVI_URL);
  if (!data?.matches) return moviCache?.matches ?? [];
  const matches: MoviMatch[] = data.matches
    .filter((m: any) => m?.in_play && m.home && m.away)
    .map((m: any) => ({
      id: String(m.id),
      home: m.home,
      away: m.away,
      board: (m.quotes ?? [])
        .filter((q: any) => !q.suspended && q.odds_dec > 1)
        .map((q: any): BoardQuote => {
          const raw = q.line != null && Number.isFinite(Number(q.line)) ? Number(q.line) : null;
          // Corners « à 3 issues » (Plus de 9 / Exactement 9 / Moins de 9, ligne entière) : Plus de 9 gagne à 10+, soit « Plus de 9.5 » ;
          // Moins de 9 gagne à 8-, soit « Moins de 8.5 ». Ramené aux lignes en .5 de l'app.
          const threeWay = ['16', '10160', '50197'].includes(String(q.group_id)) && raw != null && Number.isInteger(raw);
          const side = String(q.side ?? '').toLowerCase();
          const line = threeWay ? (side === 'over' ? raw! + 0.5 : side === 'under' ? raw! - 0.5 : null) : raw;
          return {
          group: String(q.group_id),
          side: q.side ?? null,
          line,
          label: q.label ?? q.n2 ?? null,
          odds: Math.round(q.odds_dec * 100) / 100,
        };
        }),
    }));
  moviCache = { at: Date.now(), matches };
  return matches;
}

/** Cotes bet365 d'un match en direct (1X2, buts, corners, cartons, BTTS, tirs cadrés joueur…), ou null si aucune source ne le connaît. */
export async function getRefOdds(homeTeam: string, awayTeam: string): Promise<RefOdds | null> {
  const [scores, movi] = await Promise.all([getRefOdds365(homeTeam, awayTeam), moviMatches().then((ms) => ms.find((m) => sameTeams(m.home, homeTeam) && sameTeams(m.away, awayTeam))).catch(() => undefined)]);
  if (!movi || movi.board.length === 0) return scores;
  return scores
    ? { ...scores, board: movi.board }
    : { gameId: Number(movi.id) || 0, source: 'bet365 (MoviOdds)', board: movi.board, fetchedAt: Date.now() };
}

async function getRefOdds365(homeTeam: string, awayTeam: string): Promise<RefOdds | null> {
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

const GOAL_GROUPS = ['421', '17'];
const CORNER_GROUPS_FT = ['16', '441'];

function legShape(selection: string): { side: 'over' | 'under' | null; line: number | null; firstHalf: boolean } {
  const m = selection.match(/^(plus|moins) de ([\d.,]+)/i);
  return {
    side: m ? (m[1].toLowerCase() === 'plus' ? 'over' : 'under') : null,
    line: m ? Number(m[2].replace(',', '.')) : null,
    firstHalf: /1[èe]re mi-temps/i.test(selection),
  };
}

/** Groupes du tableau bet365 qui portent ce marché (null = marché absent du tableau). */
function groupsFor(market: string, selection: string): string[] | null {
  const { firstHalf } = legShape(selection);
  if (market === 'total_buts') return GOAL_GROUPS;
  if (market === 'corners') return firstHalf ? ['10160'] : CORNER_GROUPS_FT;
  if (market === 'cartons') return firstHalf ? null : ['1781'];
  return null;
}

const normName = (x: string) => normalizeTeamName(x);

/**
 * Cote bet365 d'une jambe — lue sur le tableau MoviOdds quand il la propose (même ligne, même côté), sinon
 * sur 365Scores (1X2 / total à la ligne affichée). null = bet365 ne propose pas cette cote en ce moment.
 */
export function refOddsForLeg(ref: RefOdds | null, market: string, selection: string): number | null {
  if (!ref) return null;
  const board = ref.board ?? [];
  const { side, line } = legShape(selection);

  if (board.length > 0) {
    const groups = groupsFor(market, selection);
    if (groups && side && line != null) {
      const q = board.find((b) => groups.includes(b.group) && b.line != null && Math.abs(b.line - line) < 0.01 && b.side?.toLowerCase() === side);
      if (q) return q.odds;
    }
    if (market === 'btts') {
      const wantNo = /\(non\)|ne marque pas/i.test(selection);
      const q = board.find((b) => b.group === '10565' && b.label?.toLowerCase() === (wantNo ? 'no' : 'yes'));
      if (q) return q.odds;
    }
    if (market === 'tirs_cadres' && line != null) {
      const who = /—\s*(.+?)\s*\(/.exec(selection)?.[1];
      if (who) {
        const want = normName(who);
        const q = board.find((b) => (b.group === '50554' || b.group === '177906') && b.line === line && b.side && (normName(b.side) === want || normName(b.side).includes(want) || want.includes(normName(b.side))));
        if (q) return q.odds;
      }
    }
  }

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

/**
 * La ligne de cette jambe est-elle proposée par bet365 en ce moment ? true / false d'après le tableau réel
 * (au moins 2 lignes ouvertes sur ce marché, pour ne pas confondre « marché fermé » et « ligne absente ») ;
 * null quand le tableau ne permet pas de trancher.
 */
export function legLineOffered(ref: RefOdds | null, market: string, selection: string): boolean | null {
  const board = ref?.board;
  if (!board || board.length === 0) return null;
  const groups = groupsFor(market, selection);
  const { side, line } = legShape(selection);
  if (!groups || !side || line == null) return null;
  const lines = new Set(board.filter((b) => groups.includes(b.group) && b.line != null && (b.side?.toLowerCase() === 'over' || b.side?.toLowerCase() === 'under')).map((b) => b.line as number));
  if (lines.size < 2) return null;
  return [...lines].some((l) => Math.abs(l - line) < 0.01);
}

/**
 * Probabilités avant-match 1X2 d'après les cotes d'OUVERTURE bet365 (marge retirée), pour savoir qui est
 * le favori. Une seule requête partagée par tous les matchs en direct ; null si la source ne connaît pas le match.
 */
export async function getOpeningProbabilities(homeTeam: string, awayTeam: string): Promise<{ home: number; draw: number; away: number } | null> {
  try {
    const game = (await liveGames()).find((g) => sameTeams(g.home, homeTeam) && sameTeams(g.away, awayTeam));
    const o = game?.x12Open;
    if (!o) return null;
    const inv = { home: 1 / o.home, draw: 1 / o.draw, away: 1 / o.away };
    const sum = inv.home + inv.draw + inv.away;
    return { home: inv.home / sum, draw: inv.draw / sum, away: inv.away / sum };
  } catch {
    return null;
  }
}
