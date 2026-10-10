// État d'un pari en direct pour l'affichage : en cours, réussi ou perdu —
// vérifié à chaque actualisation de l'écran, sans attendre le bilan horaire.
// Match terminé : même règlement que le bilan (dailyReview.ts). Match en
// cours : un pari déjà acquis ("Plus de 4.5 cartons" avec 5 cartons) ou déjà
// perdu ("Moins de 2.5 buts" à 3 buts) est annoncé tout de suite.

import { InPlayProposal, InPlayProposalLeg } from './learnStore';
import { FinalResult, settleReprojectedLeg } from './dailyReview';
import { hubFinalResult, hubLiveStatus, hubStats } from '../api/footballDataAPIs/liveDataHub';

export type LegStatus = 'won' | 'lost' | 'pending';

function lineOf(selection: string): { side: 'plus' | 'moins'; line: number } | null {
  const m = /(plus|moins) de\s+(\d+(?:[.,]\d+)?)/i.exec(selection);
  return m ? { side: m[1].toLowerCase() as 'plus' | 'moins', line: Number(m[2].replace(',', '.')) } : null;
}

/** Verdict déjà certain pendant le match (comptage qui a franchi la ligne). */
function decidedEarly(leg: InPlayProposalLeg, live: { homeGoals: number; awayGoals: number; statusShort: string }, counts: { all?: { corners: number; cards: number; fouls: number } | null; firstHalf?: { corners: number; cards: number; fouls: number } | null }): LegStatus {
  const sel = leg.selection;
  const goals = live.homeGoals + live.awayGoals;
  if (leg.market === 'total_buts') {
    const line = lineOf(sel)?.line ?? 2.5;
    if (/moins/i.test(sel) && goals > line) return 'lost';
    if (!/moins/i.test(sel) && goals > line) return 'won';
  }
  if (leg.market === 'btts' && live.homeGoals > 0 && live.awayGoals > 0) {
    return /\(non\)|ne marquent pas/i.test(sel) ? 'lost' : 'won';
  }
  if (leg.market === 'buts_1ere_mt' && live.statusShort === '1H' && goals > 0) {
    return /0-0|pas de but/i.test(sel) ? 'lost' : 'won';
  }
  if (leg.market === 'corners' || leg.market === 'cartons' || leg.market === 'fautes') {
    const l = lineOf(sel);
    if (!l) return 'pending';
    const fullMatch = /sur le match/i.test(sel);
    // 1ère MT : le compte du match vaut celui de la 1ère MT tant qu'on y est.
    const period = fullMatch ? counts.all : live.statusShort === '1H' ? counts.all : counts.firstHalf;
    if (!period) return 'pending';
    const value = leg.market === 'corners' ? period.corners : leg.market === 'cartons' ? period.cards : period.fouls;
    if (leg.market === 'fautes' && !value) return 'pending';
    if (value > l.line) return l.side === 'plus' ? 'won' : 'lost';
  }
  return 'pending';
}

const cache = new Map<string, { at: number; status: LegStatus }>();
const CHECK_INTERVAL_MS = 50_000;

export async function checkLegStatus(leg: InPlayProposalLeg, dateKey: string): Promise<LegStatus> {
  if (leg.settled && leg.won != null) return leg.won ? 'won' : 'lost';
  const key = `${dateKey}|${leg.fixtureId}|${leg.market}|${leg.selection}`;
  const hit = cache.get(key);
  if (hit && (hit.status !== 'pending' || Date.now() - hit.at < CHECK_INTERVAL_MS)) return hit.status;

  let status: LegStatus = 'pending';
  try {
    const final = await hubFinalResult(leg.homeTeam, leg.awayTeam, dateKey);
    if (final) {
      const won = settleReprojectedLeg(leg.market, leg.selection, final as FinalResult);
      if (won != null) status = won ? 'won' : 'lost';
    } else {
      const live = await hubLiveStatus(leg.homeTeam, leg.awayTeam);
      if (live) {
        const stats = await hubStats(leg.homeTeam, leg.awayTeam, dateKey).catch(() => null);
        status = decidedEarly(leg, live, { all: stats?.all, firstHalf: stats?.firstHalf });
      }
    }
  } catch {
    // reste "en cours" ; retenté à la prochaine actualisation
  }
  cache.set(key, { at: Date.now(), status });
  return status;
}

/** Combiné : perdu dès qu'une jambe l'est, réussi quand toutes le sont. */
export async function checkProposalStatus(proposal: InPlayProposal): Promise<LegStatus> {
  const dateKey = proposal.createdAt.slice(0, 10);
  const statuses = await Promise.all(proposal.legs.map((l) => checkLegStatus(l, dateKey)));
  if (statuses.includes('lost')) return 'lost';
  return statuses.every((s) => s === 'won') ? 'won' : 'pending';
}
