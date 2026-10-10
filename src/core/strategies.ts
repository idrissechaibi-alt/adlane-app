// Stratégies de pronostic "SI… ALORS", sur le modèle des stratégies
// d'alertes live (conditions sur la minute, le score, les tirs, les cotes
// d'avant-match, le favori…). Chaque stratégie qui se déclenche produit un
// pari, réel (5 grands championnats) ou fictif (apprentissage), et son taux
// de réussite RÉEL est mesuré stratégie par stratégie : une stratégie qui
// annonce plus qu'elle ne réussit est suspendue d'elle-même.

import { computePoissonModel, estimateRemainingFirstHalfMarket, estimateRemainingMatchMarket } from './poisson';
import { InPlayProposal, TrackedMarket, readInPlayProposals } from './learnStore';

export interface StrategyContext {
  minute: number;
  statusShort: string;
  homeGoals: number;
  awayGoals: number;
  shotsHome?: number;
  shotsAway?: number;
  shotsOnTargetHome?: number;
  shotsOnTargetAway?: number;
  redCards?: number;
  /** Cotes 1X2 d'avant-match (bookmaker), sinon déduites des buts attendus. */
  oddsHome: number;
  oddsAway: number;
  oddsFromMarket: boolean;
  /** Buts attendus d'avant-match (corrigés de l'écart appris). */
  xg: { home: number; away: number };
}

export interface StrategyBet {
  strategyId: string;
  strategyName: string;
  market: TrackedMarket;
  selection: string;
  prob: number;
  evidence: string;
}

interface Strategy {
  id: string;
  name: string;
  /** Raisons lisibles si TOUTES les conditions sont remplies, sinon null. */
  test(ctx: StrategyContext): string[] | null;
  bet(ctx: StrategyContext): { market: TrackedMarket; selection: string; prob: number } | null;
}

const shots = (c: StrategyContext) => (c.shotsHome ?? 0) + (c.shotsAway ?? 0);
const onTarget = (c: StrategyContext) => (c.shotsOnTargetHome ?? 0) + (c.shotsOnTargetAway ?? 0);
const hasShots = (c: StrategyContext) => c.shotsHome != null && c.shotsAway != null;

/** Au moins un but de plus d'ici la fin du match. */
function nextGoalProb(c: StrategyContext): number {
  const est = estimateRemainingMatchMarket({
    preMatchExpectedGoals: c.xg,
    elapsedMinutes: c.minute,
    currentScore: { home: c.homeGoals, away: c.awayGoals },
    currentStats: { shotsOnTargetHome: c.shotsOnTargetHome, shotsOnTargetAway: c.shotsOnTargetAway },
  });
  const lambda = est.secondHalfExpectedGoals.home + est.secondHalfExpectedGoals.away;
  return 1 - Math.exp(-lambda);
}

const STRATEGIES: Strategy[] = [
  {
    // Capture 1 : "Over 1.5 Goals / Early Goal".
    id: 'over15-early-goal',
    name: 'Plus de 1.5 buts — but rapide',
    test(c) {
      if (c.statusShort !== '1H' || c.minute > 30) return null;
      if (c.homeGoals + c.awayGoals !== 1) return null;
      if (!hasShots(c) || shots(c) < 4 || onTarget(c) < 2) return null;
      if (c.oddsHome > 4.2 || c.oddsAway > 4.2) return null;
      return [
        `1 but à la ${c.minute}e`,
        `${shots(c)} tirs dont ${onTarget(c)} cadrés`,
        `cotes avant-match ${c.oddsHome.toFixed(2)} / ${c.oddsAway.toFixed(2)} (≤ 4.2)`,
      ];
    },
    bet(c) {
      return { market: 'total_buts', selection: 'Plus de 1.5 buts (total match)', prob: nextGoalProb(c) };
    },
  },
  {
    // Capture 2 : favori mené par l'outsider à l'extérieur.
    id: 'favori-mene',
    name: 'Favori mené — il pousse',
    test(c) {
      if (!['1H', 'HT'].includes(c.statusShort) || c.minute > 45) return null;
      const favoriteHome = c.oddsHome <= c.oddsAway;
      if (!favoriteHome) return null; // l'outsider doit jouer à l'extérieur
      if (c.oddsHome > 1.5) return null;
      if (c.awayGoals < 1 || c.homeGoals !== 0) return null;
      if (c.redCards != null && c.redCards > 0) return null;
      // Pression du favori (à défaut de "momentum") : au moins 60 % des tirs.
      if (!hasShots(c) || shots(c) === 0 || (c.shotsHome ?? 0) / shots(c) < 0.6) return null;
      return [
        `favori à domicile (cote ${c.oddsHome.toFixed(2)}) mené 0-${c.awayGoals}`,
        `${c.shotsHome}/${shots(c)} tirs pour le favori`,
        c.redCards === 0 ? 'aucun carton rouge' : 'cartons rouges non publiés',
      ];
    },
    bet(c) {
      const goals = c.homeGoals + c.awayGoals;
      return { market: 'total_buts', selection: `Plus de ${goals + 0.5} buts (total match)`, prob: nextGoalProb(c) };
    },
  },
  {
    // Capture 3 : but avant la pause dans un match ouvert.
    id: 'but-avant-pause',
    name: 'But avant la pause — match ouvert',
    test(c) {
      if (c.statusShort !== '1H' || c.minute <= 15 || c.minute > 32) return null;
      if (c.homeGoals + c.awayGoals !== 0) return null;
      if (!hasShots(c) || shots(c) < 4 || onTarget(c) < shots(c) * 0.5) return null;
      // À défaut de l'historique "but en 1ère MT sur les 5 derniers matchs" :
      // match attendu ouvert (≥ 2.6 buts attendus avant-match).
      if (c.xg.home + c.xg.away < 2.6) return null;
      return [
        `0-0 à la ${c.minute}e`,
        `${shots(c)} tirs dont ${onTarget(c)} cadrés (≥ 50 %)`,
        `${(c.xg.home + c.xg.away).toFixed(1)} buts attendus avant-match`,
      ];
    },
    bet(c) {
      const est = estimateRemainingFirstHalfMarket({
        preMatchExpectedGoals: c.xg,
        elapsedMinutes: c.minute,
        currentScore: { home: 0, away: 0 },
        currentStats: { shotsOnTargetHome: c.shotsOnTargetHome, shotsOnTargetAway: c.shotsOnTargetAway },
      });
      return { market: 'buts_1ere_mt', selection: 'Oui, un but avant la pause', prob: est.markets[0].estimated_prob };
    },
  },
];

/** Cotes 1X2 déduites des buts attendus quand aucune cote bookmaker n'existe. */
export function oddsFromExpectedGoals(xg: { home: number; away: number }): { home: number; away: number } {
  const p = computePoissonModel(xg.home, xg.away).prob1X2;
  return { home: 1 / Math.max(0.01, p.home), away: 1 / Math.max(0.01, p.away) };
}

export interface StrategyRecord {
  id: string;
  name: string;
  settled: number;
  won: number;
  hitRate: number;
  meanPredicted: number;
  /** Suspendue : annonce nettement plus qu'elle ne réussit. */
  suspended: boolean;
}

const SUSPEND_MIN_SAMPLES = 20;
const SUSPEND_GAP = 0.15;

let recordsCache: { at: number; records: StrategyRecord[] } | null = null;

export function getStrategyRecords(proposals?: InPlayProposal[]): StrategyRecord[] {
  if (!proposals && recordsCache && Date.now() - recordsCache.at < 5 * 60_000) return recordsCache.records;
  const list = proposals ?? readInPlayProposals();
  const records = STRATEGIES.map((s) => {
    const legs = list.filter((p) => p.strategy === s.id).flatMap((p) => p.legs).filter((l) => l.settled);
    const won = legs.filter((l) => l.won).length;
    const hitRate = legs.length ? won / legs.length : 0;
    const meanPredicted = legs.length ? legs.reduce((a, l) => a + l.prob, 0) / legs.length : 0;
    return {
      id: s.id,
      name: s.name,
      settled: legs.length,
      won,
      hitRate,
      meanPredicted,
      suspended: legs.length >= SUSPEND_MIN_SAMPLES && meanPredicted - hitRate >= SUSPEND_GAP,
    };
  });
  if (!proposals) recordsCache = { at: Date.now(), records };
  return records;
}

/** Stratégies déclenchées par la situation d'un match (une par stratégie). */
export function evaluateStrategies(ctx: StrategyContext): StrategyBet[] {
  const records = new Map(getStrategyRecords().map((r) => [r.id, r]));
  const out: StrategyBet[] = [];
  for (const s of STRATEGIES) {
    if (records.get(s.id)?.suspended) continue;
    const reasons = s.test(ctx);
    if (!reasons) continue;
    const bet = s.bet(ctx);
    if (!bet || bet.prob < 0.45 || bet.prob > 0.9) continue;
    const record = records.get(s.id);
    out.push({
      strategyId: s.id,
      strategyName: s.name,
      ...bet,
      evidence:
        `Stratégie « ${s.name} » : ${reasons.join(', ')}. Cote juste ≈ ${(1 / bet.prob).toFixed(2)} (à jouer seulement si la cote du bookmaker est au-dessus).` +
        (record && record.settled > 0
          ? ` Historique : ${record.won}/${record.settled} réussis (${Math.round(record.hitRate * 100)} %).`
          : ''),
    });
  }
  return out;
}
