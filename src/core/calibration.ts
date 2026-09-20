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
