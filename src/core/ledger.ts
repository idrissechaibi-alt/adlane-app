// Module Ledger - Calculs financiers et P&L
// Conforme aux tests de non-régression du §7

import { Bet, BetLeg } from '../types';

/**
 * Recalcule la cote effective d'un combiné en tenant compte des jambes void
 * Règle métier §2.1 : Une jambe void sort du calcul, la cote est recalculée
 */
export function calculateEffectiveOdds(legs: BetLeg[]): number | null {
  const activeLegs = legs.filter(leg => !leg.is_void);

  if (activeLegs.length === 0) return null;

  // Si une jambe n'a pas de cote publiée -> null (BLOCK_COTE_MANQUANTE)
  if (activeLegs.some(leg => leg.odds === null)) return null;

  // Produit des cotes actives
  return activeLegs.reduce((acc, leg) => acc * (leg.odds as number), 1);
}

/**
 * Détermine le statut d'un pari combiné à partir de ses jambes
 * Règle métier §3.2 : Une seule jambe perdante -> lost
 */
export function resolveBetStatus(legs: BetLeg[]): 'won' | 'lost' | 'void' | 'pending' {
  const activeLegs = legs.filter(leg => !leg.is_void);

  if (activeLegs.length === 0) return 'void';
  if (activeLegs.some(leg => leg.result === 'pending')) return 'pending';
  if (activeLegs.some(leg => leg.result === 'lost')) return 'lost';
  if (activeLegs.every(leg => leg.result === 'won')) return 'won';

  return 'pending';
}

/**
 * Calcule le P&L d'un pari
 */
export function calculatePnL(bet: Bet): { payout: number; net_pnl: number } {
  if (bet.excluded_from_pnl || bet.odds === null || bet.stake === null) {
    return { payout: 0, net_pnl: 0 };
  }

  if (bet.status === 'won') {
    const payout = bet.stake * bet.odds;
    return { payout, net_pnl: payout - bet.stake };
  }

  if (bet.status === 'lost') {
    return { payout: 0, net_pnl: -bet.stake };
  }

  // void ou pending
  return { payout: 0, net_pnl: 0 };
}

/**
 * Calcule le bilan global d'un ensemble de paris
 */
export interface LedgerSummary {
  total_bets: number;
  bets_settled: number;
  bets_won: number;
  bets_lost: number;
  win_rate: number;        // %
  total_stake: number;
  total_return: number;
  net_pnl: number;
  roi: number;             // %
}

export function calculateLedgerSummary(bets: Bet[]): LedgerSummary {
  const settledBets = bets.filter(b => !b.excluded_from_pnl && ['won', 'lost'].includes(b.status));

  const bets_won = settledBets.filter(b => b.status === 'won').length;
  const bets_lost = settledBets.filter(b => b.status === 'lost').length;
  const bets_settled = bets_won + bets_lost;

  const total_stake = settledBets.reduce((sum, b) => sum + (b.stake || 0), 0);
  const total_return = settledBets.reduce((sum, b) => {
    if (b.status === 'won' && b.odds && b.stake) {
      return sum + (b.odds * b.stake);
    }
    return sum;
  }, 0);

  const net_pnl = total_return - total_stake;
  const roi = total_stake > 0 ? (net_pnl / total_stake) * 100 : 0;
  const win_rate = bets_settled > 0 ? (bets_won / bets_settled) * 100 : 0;

  return {
    total_bets: bets.length,
    bets_settled,
    bets_won,
    bets_lost,
    win_rate,
    total_stake,
    total_return,
    net_pnl,
    roi
  };
}

/**
 * Calcule le bilan d'une journée spécifique
 */
export function calculateDailySummary(bets: Bet[], date: string): LedgerSummary {
  const dailyBets = bets.filter(b => b.date === date);
  return calculateLedgerSummary(dailyBets);
}
