// Formatage pur du bilan Telegram du soir (paris fictifs) — séparé de
// dailyReview.ts pour rester testable sans dépendre des modules natifs
// (expo-file-system, expo-secure-store) que la boucle de bilan utilise par
// ailleurs. Aucun accès disque/réseau ici, uniquement du calcul sur des
// données déjà en mémoire.

import type { InPlayProposal, MarketDayPoint, TrackedMarket } from './learnStore';

/** Statistiques d'un marché pour un jour donné, restreintes aux paris
 * FICTIFS (real === false) — pour le bilan Telegram du soir uniquement ; la
 * série de calibration (buildDayPoints, dans dailyReview.ts) reste inchangée
 * (réel + fictif combinés, par conception, pour plus d'échantillon). */
export function buildFictionalMarketStats(
  proposals: InPlayProposal[]
): Map<TrackedMarket, { correct: number; total: number; predictedSum: number }> {
  const byMarket = new Map<TrackedMarket, { correct: number; total: number; predictedSum: number }>();
  for (const proposal of proposals) {
    if (proposal.real !== false) continue;
    for (const leg of proposal.legs) {
      if (!leg.settled) continue;
      const entry = byMarket.get(leg.market) ?? { correct: 0, total: 0, predictedSum: 0 };
      entry.total += 1;
      entry.predictedSum += leg.prob;
      if (leg.won) entry.correct += 1;
      byMarket.set(leg.market, entry);
    }
  }
  return byMarket;
}

/** Taux de réussite cumulé d'un marché sur les journées STRICTEMENT
 * antérieures à `beforeDate` déjà dans la série — référence pour dire si le
 * jour du bilan est en amélioration ou en recul. */
export function cumulativeHitRateBefore(
  series: MarketDayPoint[],
  market: TrackedMarket,
  beforeDate: string
): { hitRate: number; total: number } | null {
  const priorPoints = series.filter((p) => p.market === market && p.date < beforeDate);
  const total = priorPoints.reduce((sum, p) => sum + p.predictions, 0);
  if (total === 0) return null;
  const correct = priorPoints.reduce((sum, p) => sum + p.correct, 0);
  return { hitRate: correct / total, total };
}

/**
 * Message du bilan Telegram du soir : ce qui a été réglé aujourd'hui sur les
 * paris FICTIFS (par marché), et une courte analyse (marché en amélioration/
 * recul vs l'historique, marché où le modèle était trop confiant) — c'est
 * cette mesure empirique qu'autoLearn consulte ensuite pour ajuster les
 * prochaines estimations (applyMarketExpertise).
 */
export function formatFictionalDigestMessage(
  day: string,
  stats: Map<TrackedMarket, { correct: number; total: number; predictedSum: number }>,
  seriesBeforeDay: MarketDayPoint[]
): string | null {
  if (stats.size === 0) return null;

  const lines = [`🌙 Bilan des paris fictifs du ${day}`];
  const analysisLines: string[] = [];
  let totalPred = 0;
  let totalCorrect = 0;

  for (const [market, entry] of [...stats.entries()].sort((a, b) => b[1].total - a[1].total)) {
    totalPred += entry.total;
    totalCorrect += entry.correct;
    const hitRate = entry.correct / entry.total;
    const meanPredicted = entry.predictedSum / entry.total;
    lines.push(
      `• ${market} : ${entry.correct}/${entry.total} correct (${(hitRate * 100).toFixed(0)}% réalisé, ${(meanPredicted * 100).toFixed(0)}% estimé)`
    );

    const baseline = cumulativeHitRateBefore(seriesBeforeDay, market, day);
    if (baseline && baseline.total >= 10) {
      const deltaPts = (hitRate - baseline.hitRate) * 100;
      if (Math.abs(deltaPts) >= 5) {
        analysisLines.push(
          `${market} : ${deltaPts > 0 ? 'en amélioration' : 'en recul'} vs moyenne historique ` +
            `(${(baseline.hitRate * 100).toFixed(0)}% sur ${baseline.total} précédents), ` +
            `${deltaPts > 0 ? '+' : ''}${deltaPts.toFixed(0)} pts aujourd'hui.`
        );
      }
    }

    const overconfidencePts = (meanPredicted - hitRate) * 100;
    if (entry.total >= 5 && overconfidencePts >= 10) {
      analysisLines.push(
        `${market} : le modèle était trop confiant aujourd'hui (annoncé ${(meanPredicted * 100).toFixed(0)}% ` +
          `vs réalisé ${(hitRate * 100).toFixed(0)}%) — corrigé automatiquement pour les prochaines estimations.`
      );
    }
  }

  lines.push('', `Total : ${totalCorrect}/${totalPred} corrects (${totalPred > 0 ? ((totalCorrect / totalPred) * 100).toFixed(0) : 0}%)`);
  lines.push(
    '',
    '📈 Analyse :',
    ...(analysisLines.length > 0
      ? analysisLines.map((l) => `- ${l}`)
      : ["Rien de significatif à signaler aujourd'hui, échantillon stable."])
  );

  return lines.join('\n');
}
