// Module de calibration et boucle d'apprentissage (§6.3)
// Compare la probabilité moyenne annoncée au taux de réussite réel

import { Bet, Market, MarketCalibration } from '../types';

/**
 * Recalcule la calibration de tous les marchés à partir des paris réglés
 */
export function computeMarketCalibrations(bets: Bet[]): MarketCalibration[] {
  const settledBets = bets.filter(b => !b.excluded_from_pnl && ['won', 'lost'].includes(b.status));

  const marketStats = new Map<Market, { total: number; won: number; probSum: number }>();

  // Initialiser les marchés
  const allMarkets: Market[] = ['1X2', 'BTTS', 'OU_2_5', 'corners', 'shots_on_target', 'fouls', 'cards', 'saves', '1ere_mi_temps'];
  for (const m of allMarkets) {
    marketStats.set(m, { total: 0, won: 0, probSum: 0 });
  }

  // Agréger les résultats par marché
  for (const bet of settledBets) {
    for (const leg of bet.legs) {
      if (leg.is_void) continue;

      const stats = marketStats.get(leg.market);
      if (!stats) continue;

      stats.total += 1;
      if (leg.result === 'won') {
        stats.won += 1;
      }
      if (leg.estimated_prob) {
        stats.probSum += leg.estimated_prob;
      }
    }
  }

  // Construire les objets de calibration
  const calibrations: MarketCalibration[] = [];

  for (const [market, stats] of marketStats.entries()) {
    const actual_rate = stats.total > 0 ? stats.won / stats.total : 0;
    const avg_prob = stats.total > 0 ? stats.probSum / stats.total : 0;

    let status: 'calibre' | 'suspect' | 'non_calibre' = 'non_calibre';

    if (stats.total === 0) {
      status = 'non_calibre';
    } else if (stats.total >= 5) {
      // Si la proba annoncée dépasse le taux réel de plus de 15 points -> suspect
      if (avg_prob - actual_rate > 0.15) {
        status = 'suspect';
      } else {
        status = 'calibre';
      }
    } else {
      // Moins de 5 prédictions -> échantillon trop faible
      status = 'non_calibre';
    }

    calibrations.push({
      market,
      total_predictions: stats.total,
      predictions_won: stats.won,
      actual_success_rate: actual_rate,
      avg_predicted_prob: avg_prob,
      calibration_status: status,
      last_updated: new Date().toISOString()
    });
  }

  return calibrations;
}

/**
 * Vérifie si un marché peut être recommandé en confiance élevée
 * Règle métier : un marché non calibré ne peut jamais sortir en confiance Élevée
 */
export function isMarketReliable(market: Market, calibrations: MarketCalibration[]): boolean {
  const cal = calibrations.find(c => c.market === market);
  if (!cal) return false;
  return cal.calibration_status === 'calibre';
}

const TRACKED_TO_MARKET: Record<string, Market> = {
  '1X2': '1X2', total_buts: 'OU_2_5', btts: 'BTTS', buts_1ere_mt: '1ere_mi_temps',
  corners: 'corners', cartons: 'cards', fautes: 'fouls', tirs_cadres: 'shots_on_target',
};

/**
 * Calibration sur TOUS les paris : propositions réelles ET fictives réglées (jambe par jambe) + anciens paris
 * posés hors direct. Les paris en direct posés (« live-… ») ne sont pas recomptés : leur proposition l'est déjà.
 */
export function computeAllBetsCalibrations(
  bets: Bet[],
  proposals: Array<{ legs: Array<{ market: string; prob: number; settled?: boolean; won?: boolean }> }>
): MarketCalibration[] {
  const stats = new Map<Market, { total: number; won: number; probSum: number }>();
  const add = (market: Market | undefined, won: boolean, prob: number) => {
    if (!market) return;
    const e = stats.get(market) ?? { total: 0, won: 0, probSum: 0 };
    e.total += 1;
    if (won) e.won += 1;
    e.probSum += prob || 0;
    stats.set(market, e);
  };
  for (const bet of bets) {
    if (bet.id.startsWith('live-') || bet.excluded_from_pnl || !['won', 'lost'].includes(bet.status)) continue;
    for (const leg of bet.legs) if (!leg.is_void) add(leg.market, leg.result === 'won', leg.estimated_prob ?? 0);
  }
  // Un même pari (match, marché, sélection, checkpoint) n'est compté qu'une fois.
  const seen = new Set<string>();
  for (const p of proposals as Array<{ kind?: string; legs: Array<{ market: string; prob: number; settled?: boolean; won?: boolean; fixtureId?: number; selection?: string }> }>) {
    for (const l of p.legs) {
      if (!l.settled) continue;
      const key = `${l.fixtureId}|${l.market}|${l.selection}|${p.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(TRACKED_TO_MARKET[l.market], !!l.won, l.prob);
    }
  }

  const now = new Date().toISOString();
  return [...stats.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([market, e]) => {
      const rate = e.won / e.total;
      const avg = e.probSum / e.total;
      const status = e.total < 5 ? 'non_calibre' : avg - rate > 0.15 ? 'suspect' : 'calibre';
      return { market, total_predictions: e.total, predictions_won: e.won, actual_success_rate: rate, avg_predicted_prob: avg, calibration_status: status, last_updated: now };
    });
}

/** Titres clairs des marchés (le code interne « OU_2_5 » ne parle à personne). */
export const MARKET_TITLES: Record<string, string> = {
  '1X2': 'Victoire (1X2)',
  BTTS: 'Les deux équipes marquent',
  OU_2_5: 'Total de buts (plus / moins de X buts)',
  '1ere_mi_temps': 'But en 1ère mi-temps',
  corners: 'Corners',
  cards: 'Cartons',
  fouls: 'Fautes',
  shots_on_target: 'Tirs cadrés (joueur)',
  saves: 'Arrêts du gardien',
};
