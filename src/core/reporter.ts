// Module Reporter - Génération des rapports quotidiens et d'amélioration (§5.5, §6)

import { Bet, Lesson, MarketCalibration, DailyReport } from '../types';
import { calculateDailySummary, calculateLedgerSummary } from './ledger';

/**
 * Génère le rapport quotidien conforme au format §5.5
 * Structure imposée :
 * 1. Bannière : résultat du jour
 * 2. Détail par pari réglé
 * 3. Cumul
 * 4. Leçons du jour
 * 5. Aucune recommandation de jeu
 */
export function generateDailyReport(
  date: string,
  allBets: Bet[],
  relevantLesson?: Lesson
): DailyReport {
  const dailySummary = calculateDailySummary(allBets, date);
  const cumulativeSummary = calculateLedgerSummary(allBets);

  const settledBetsToday = allBets.filter(
    b => b.date === date && !b.excluded_from_pnl && ['won', 'lost'].includes(b.status)
  );

  let reportText = '';

  // 1. Bannière
  if (dailySummary.bets_settled === 0) {
    reportText += `📊 **Rapport du ${date}** : Aucun pari réglé aujourd'hui.\n\n`;
  } else {
    const dailyROI = dailySummary.roi.toFixed(1);
    const netSign = dailySummary.net_pnl >= 0 ? '+' : '';
    reportText += `📊 **Rapport du ${date}** : ${dailySummary.bets_won} gagnés / ${dailySummary.bets_lost} perdus — Mise ${dailySummary.total_stake.toFixed(1)} → Net ${netSign}${dailySummary.net_pnl.toFixed(3)} (ROI ${netSign}${dailyROI}%)\n\n`;
  }

  // 2. Détail par pari réglé
  if (settledBetsToday.length > 0) {
    reportText += '**Détail :**\n';
    for (const bet of settledBetsToday) {
      const emoji = bet.status === 'won' ? '✅' : '❌';
      const legsSummary = bet.legs.map(l => l.selection).join(' + ');
      reportText += `${emoji} **${bet.id}** (${legsSummary}) — Cote ${bet.odds?.toFixed(2)} — Mise ${bet.stake}\n`;
      if (bet.status === 'lost') {
        reportText += `   └─ Cause : ${bet.analysis}\n`;
      }
    }
    reportText += '\n';
  }

  // 3. Cumul
  const cumulROI = cumulativeSummary.roi.toFixed(1);
  const cumulNetSign = cumulativeSummary.net_pnl >= 0 ? '+' : '';
  reportText += `**Cumul** : ${cumulativeSummary.bets_settled} réglés, ${cumulativeSummary.bets_won} gagnés (${cumulativeSummary.win_rate.toFixed(1)}%) — Mise ${cumulativeSummary.total_stake.toFixed(1)} → Net ${cumulNetSign}${cumulativeSummary.net_pnl.toFixed(3)} (ROI ${cumulNetSign}${cumulROI}%)\n\n`;

  // 4. Leçons
  const lessonsToday = settledBetsToday
    .filter(b => b.status === 'lost' && b.validation_flags.length > 0)
    .map(b => b.validation_flags)
    .flat();

  if (lessonsToday.length > 0 || relevantLesson) {
    reportText += '**Leçon du jour :**\n';
    if (relevantLesson) {
      reportText += `${relevantLesson.motif} (Occurrence ${relevantLesson.occurrences})\n`;
      reportText += `Correctif appliqué : ${relevantLesson.detail.split('\n')[0]}\n`;
    } else {
      reportText += 'Les règles de validation ont été respectées. Poursuite de l\'observation.\n';
    }
  }

  // 5. Aucune recommandation
  reportText += '\n---\n_Le système constate, mesure et analyse. Il ne recommande pas de jouer._';

  return {
    date,
    bets_settled: dailySummary.bets_settled,
    bets_won: dailySummary.bets_won,
    bets_lost: dailySummary.bets_lost,
    total_stake: dailySummary.total_stake,
    total_return: dailySummary.total_return,
    net_pnl: dailySummary.net_pnl,
    roi: dailySummary.roi,
    lessons_learned: relevantLesson ? [relevantLesson.doc_id] : [],
    details: reportText
  };
}

/**
 * Génère le rapport d'amélioration de l'IA
 * Affiche :
 * - Évolution de la calibration par marché
 * - Leçons apprises et nombre d'occurrences
 * - Comparaison taux réel vs taux prédit
 */
export function generateImprovementReport(
  calibrations: MarketCalibration[],
  lessons: Lesson[]
): string {
  let report = '# 📈 Rapport d\'Amélioration de l\'IA\n\n';

  report += '## 🎯 Calibration par Marché\n\n';
  report += 'Comparaison entre les probabilités annoncées et les taux de réussite réels.\n\n';

  for (const cal of calibrations) {
    if (cal.total_predictions === 0) continue;

    const statusEmoji =
      cal.calibration_status === 'calibre' ? '✅' :
      cal.calibration_status === 'suspect' ? '⚠️' : '🚫';

    const predictedPct = (cal.avg_predicted_prob * 100).toFixed(1);
    const actualPct = (cal.actual_success_rate * 100).toFixed(1);
    const delta = ((cal.avg_predicted_prob - cal.actual_success_rate) * 100).toFixed(1);

    report += `### ${statusEmoji} ${cal.market}\n`;
    report += `- **Prédictions** : ${cal.total_predictions} (${cal.predictions_won} gagnées)\n`;
    report += `- **Taux prédit moyen** : ${predictedPct}%\n`;
    report += `- **Taux réel** : ${actualPct}%\n`;
    report += `- **Écart** : ${delta > '0' ? '+' : ''}${delta} points\n`;
    report += `- **Statut** : ${cal.calibration_status}\n\n`;
  }

  report += '## 🧠 Leçons Apprises\n\n';
  report += 'Règles dures issues des erreurs passées, appliquées automatiquement par le validateur.\n\n';

  for (const lesson of lessons) {
    report += `### ${lesson.occurrences}× ${lesson.motif}\n`;
    report += `**Règle activée** : \`${lesson.regle_validation}\`\n`;
    report += `${lesson.detail.substring(0, 200)}...\n\n`;
  }

  report += '---\n';
  report += `_Dernière mise à jour : ${new Date().toISOString().split('T')[0]}_\n`;

  return report;
}
