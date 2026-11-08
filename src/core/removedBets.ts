// Paris RETIRÉS par l'utilisateur (ligne inexistante, marché non proposé, cote saisie sous le plancher).
//
// Un pari retiré sort du fichier des propositions (donc des statistiques) et ne doit pas revenir tel quel au passage
// suivant du scan : cette liste le retient.
// - 'ligne'  : la ligne n'existe pas chez le bookmaker → les lignes hors de [min, max] donnés ne sont plus proposées sur ce match.
// - 'marche' : marché non proposé → écarté 30 min sur ce match.
// - 'cote'   : cote saisie sous 1,40 → le pari revient dès que l'estimation de l'app, ramenée à l'écart mesuré avec la
//              cote réelle (cote saisie ÷ estimation du moment), dépasse de nouveau le plancher.

import AsyncStorage from './kvStore';
import { namesLikelyMatch, normalizeTeamName } from './teamNameMatch';

export type RemovalReason = 'ligne' | 'marche' | 'cote';

interface RemovedBet {
  home: string;
  away: string;
  market: string;
  selection: string;
  reason: RemovalReason;
  /** 'cote' : cote saisie ÷ estimation de l'app à ce moment (≤ 1). */
  ratio?: number;
  /** 'ligne' : bornes réellement proposées par le bookmaker. */
  lineMin?: number | null;
  lineMax?: number | null;
  until: number;
}

const KEY = '@removed_bets';
const TTL_MS: Record<RemovalReason, number> = { ligne: 10 * 3_600_000, marche: 30 * 60_000, cote: 10 * 3_600_000 };
const TEAM_MARKETS = new Set(['buts_equipe', 'corners_equipe', 'tirs_equipe']);

let mem: RemovedBet[] | null = null;
let loading: Promise<void> | null = null;

export async function ensureRemovedLoaded(): Promise<void> {
  if (mem) return;
  loading ??= (async () => {
    try {
      const raw = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]');
      mem = Array.isArray(raw) ? raw : [];
    } catch {
      mem = [];
    }
  })();
  await loading;
}

function active(): RemovedBet[] {
  const now = Date.now();
  return (mem ?? []).filter((r) => r.until > now);
}

/** Ligne du pari : nombre après « plus de / moins de ». */
function lineOf(selection: string): number | null {
  const m = selection.match(/(?:plus|moins) de\s+(\d+(?:[.,]\d+)?)/i);
  return m ? Number(m[1].replace(',', '.')) : null;
}

/**
 * Identité d'un pari hors checkpoint : marché + fenêtre (match / reste) + côté (plus / moins) + équipe pour les marchés
 * par équipe. Deux paris de même identité sur un même match sont des doublons, quelle que soit la ligne.
 */
export function legShapeKey(market: string, selection: string): string {
  const side = /^moins de|^0-0|ne marquent pas|\(non\)/i.test(selection) ? 'under' : 'over';
  const window = /sur le match|total match/i.test(selection) ? 'ft' : 'other';
  const who = TEAM_MARKETS.has(market) ? normalizeTeamName(selection.split('—')[1] ?? '') : '';
  return `${market}|${window}|${side}|${who}`;
}

function sameMatch(r: RemovedBet, home: string, away: string): boolean {
  const ok = (a: string, b: string) => normalizeTeamName(a) === normalizeTeamName(b) || namesLikelyMatch(normalizeTeamName(a), normalizeTeamName(b));
  return ok(r.home, home) && ok(r.away, away);
}

export async function addRemoved(r: Omit<RemovedBet, 'until'>): Promise<void> {
  await ensureRemovedLoaded();
  const next = [...active().filter((x) => !(x.reason === r.reason && x.selection === r.selection && sameMatch(x, r.home, r.away))), { ...r, until: Date.now() + TTL_MS[r.reason] }].slice(-200);
  mem = next;
  await AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
}

/** Pari à ne pas (re)proposer : ligne inexistante ou marché non proposé, signalés par l'utilisateur. */
export function isLegRemoved(home: string, away: string, market: string, selection: string): boolean {
  const shape = legShapeKey(market, selection);
  const line = lineOf(selection);
  for (const r of active()) {
    if (r.reason === 'cote' || !sameMatch(r, home, away) || legShapeKey(r.market, r.selection) !== shape) continue;
    if (r.reason === 'marche') return true;
    if (r.selection === selection) return true;
    if (line != null && ((r.lineMin != null && line < r.lineMin) || (r.lineMax != null && line > r.lineMax))) return true;
  }
  return false;
}

/** Facteur à appliquer à la cote estimée d'un pari dont l'utilisateur a saisi une cote sous le plancher (1 = aucun). */
export function removedOddsFactor(home: string, away: string, market: string, selection: string): number {
  let factor = 1;
  for (const r of active()) {
    if (r.reason === 'cote' && r.ratio != null && r.selection === selection && r.market === market && sameMatch(r, home, away)) factor = Math.min(factor, r.ratio);
  }
  return factor;
}
