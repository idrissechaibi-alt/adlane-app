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
  corners?: number;
  cards?: number;
  fouls?: number;
  possessionHome?: number;
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

/**
 * Stratégies de MI-TEMPS tirées des données : règles trouvées en analysant
 * 1 386 matchs réels terminés (FotMob, 21 jours jusqu'au 9/10/2026) — stats
 * de 1ère mi-temps → ce qui s'est passé en 2e mi-temps. Chaque règle a été
 * trouvée sur les 2/3 les plus anciens puis VÉRIFIÉE sur le tiers le plus
 * récent ; la probabilité retenue mélange les deux (légèrement tirée vers le
 * taux de base). Appliquées à la pause, sur le match entier.
 */
interface DataRule {
  id: string;
  name: string;
  market: TrackedMarket;
  /** Taux observé (toutes périodes) et taux de base du marché, pour l'explication. */
  prob: number;
  base: number;
  samples: number;
  condition: (c: StrategyContext) => boolean;
  conditionLabel: (c: StrategyContext) => string;
  selection: (c: StrategyContext) => string;
}

const possessionGap = (c: StrategyContext) => (c.possessionHome == null ? undefined : Math.abs(c.possessionHome - 50));

const DATA_RULES: DataRule[] = [
  {
    id: 'mt-deux-buts-2e',
    name: '2 buts ou plus en 2e MT (gros volume de tirs, peu de corners)',
    market: 'total_buts',
    prob: 0.655, base: 0.497, samples: 138,
    condition: (c) => hasShots(c) && shots(c) >= 15 && c.corners != null && c.corners <= 4,
    conditionLabel: (c) => `${shots(c)} tirs et ${c.corners} corners à la pause`,
    selection: (c) => `Plus de ${c.homeGoals + c.awayGoals + 1.5} buts (total match)`,
  },
  {
    id: 'mt-peu-de-buts-2e',
    name: 'Au plus 1 but en 2e MT (peu de tirs cadrés malgré les corners)',
    market: 'total_buts',
    prob: 0.612, base: 0.503, samples: 196,
    condition: (c) => c.shotsOnTargetHome != null && onTarget(c) <= 2 && c.corners != null && c.corners >= 4,
    conditionLabel: (c) => `${onTarget(c)} tirs cadrés et ${c.corners} corners à la pause`,
    selection: (c) => `Moins de ${c.homeGoals + c.awayGoals + 1.5} buts (total match)`,
  },
  {
    id: 'mt-cartons-plus2',
    name: '2 cartons ou plus en 2e MT (match déjà tendu)',
    market: 'cartons',
    prob: 0.742, base: 0.501, samples: 319,
    condition: (c) => c.cards != null && c.cards >= 2 && c.fouls != null && c.fouls >= 9,
    conditionLabel: (c) => `${c.cards} cartons et ${c.fouls} fautes à la pause`,
    selection: (c) => `Plus de ${(c.cards ?? 0) + 1.5} cartons sur le match`,
  },
  {
    id: 'mt-cartons-plus3',
    name: '3 cartons ou plus en 2e MT (match très tendu)',
    market: 'cartons',
    prob: 0.555, base: 0.338, samples: 270,
    condition: (c) => c.cards != null && c.cards >= 2 && c.fouls != null && c.fouls >= 11,
    conditionLabel: (c) => `${c.cards} cartons et ${c.fouls} fautes à la pause`,
    selection: (c) => `Plus de ${(c.cards ?? 0) + 2.5} cartons sur le match`,
  },
  {
    id: 'mt-match-propre',
    name: 'Au plus 1 carton en 2e MT (match offensif et propre)',
    market: 'cartons',
    prob: 0.747, base: 0.499, samples: 302,
    condition: (c) => hasShots(c) && shots(c) >= 13 && c.cards === 0,
    conditionLabel: (c) => `${shots(c)} tirs et aucun carton à la pause`,
    selection: () => 'Moins de 1.5 cartons sur le match',
  },
  {
    id: 'mt-corners-domination',
    name: '5 corners ou plus en 2e MT (domination nette)',
    market: 'corners',
    prob: 0.662, base: 0.569, samples: 145,
    condition: (c) => c.corners != null && c.corners >= 4 && (possessionGap(c) ?? 0) >= 17,
    conditionLabel: (c) => `${c.corners} corners et possession ${Math.round(c.possessionHome ?? 50)} % / ${Math.round(100 - (c.possessionHome ?? 50))} % à la pause`,
    selection: (c) => `Plus de ${(c.corners ?? 0) + 4.5} corners sur le match`,
  },
];

for (const rule of DATA_RULES) {
  STRATEGIES.push({
    id: rule.id,
    name: rule.name,
    // À la pause seulement : les stats sont celles de la 1ère mi-temps.
    test: (c) =>
      c.statusShort === 'HT' && rule.condition(c)
        ? [
            rule.conditionLabel(c),
            `règle vérifiée sur ${rule.samples} matchs réels : ${Math.round(rule.prob * 100)} % de réussite contre ${Math.round(rule.base * 100)} % en moyenne`,
          ]
        : null,
    bet: (c) => ({ market: rule.market, selection: rule.selection(c), prob: rule.prob }),
  });
}

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
  /** Bilan des seuls paris fictifs (calibrage hors argent). */
  fictional: { settled: number; won: number; hitRate: number; meanPredicted: number };
  /** Pause sur le pipe réel, levée quand le fictif a calibré la stratégie. */
  realPaused: boolean;
}

/**
 * Stratégies mises en pause sur le pipe RÉEL (elles annonçaient nettement plus
 * qu'elles ne réussissaient : cartons). Elles continuent sur le fictif, qui les
 * recalibre ; la pause se lève d'elle-même quand le fictif a réglé au moins
 * RELEASE_MIN_SAMPLES paris avec un écart annoncé/réussi sous RELEASE_GAP.
 */
const REAL_PAUSED_IDS = new Set(['mt-cartons-plus2', 'mt-cartons-plus3', 'mt-match-propre']);
const RELEASE_MIN_SAMPLES = 30;
const RELEASE_GAP = 0.08;
/** Poids de la probabilité de départ face aux résultats observés (en nombre de paris). */
const PRIOR_WEIGHT = 15;

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
    const fLegs = list.filter((p) => p.strategy === s.id && p.real === false).flatMap((p) => p.legs).filter((l) => l.settled);
    const fWon = fLegs.filter((l) => l.won).length;
    const fictional = {
      settled: fLegs.length,
      won: fWon,
      hitRate: fLegs.length ? fWon / fLegs.length : 0,
      meanPredicted: fLegs.length ? fLegs.reduce((a, l) => a + l.prob, 0) / fLegs.length : 0,
    };
    const released = fictional.settled >= RELEASE_MIN_SAMPLES && fictional.meanPredicted - fictional.hitRate < RELEASE_GAP;
    return {
      id: s.id,
      name: s.name,
      settled: legs.length,
      won,
      hitRate,
      meanPredicted,
      suspended: legs.length >= SUSPEND_MIN_SAMPLES && meanPredicted - hitRate >= SUSPEND_GAP,
      fictional,
      realPaused: REAL_PAUSED_IDS.has(s.id) && !released,
    };
  });
  if (!proposals) recordsCache = { at: Date.now(), records };
  return records;
}

/** Stratégies déclenchées par la situation d'un match (une par stratégie). */
export function evaluateStrategies(ctx: StrategyContext, real = false): StrategyBet[] {
  const records = new Map(getStrategyRecords().map((r) => [r.id, r]));
  const out: StrategyBet[] = [];
  for (const s of STRATEGIES) {
    const record = records.get(s.id);
    // Réel : pause tant que le fictif n'a pas recalibré. Fictif : une stratégie en
    // pause réelle continue (c'est lui qui la calibre), les autres suspendues s'arrêtent.
    if (real ? record?.suspended || record?.realPaused : record?.suspended && !REAL_PAUSED_IDS.has(s.id)) continue;
    const reasons = s.test(ctx);
    if (!reasons) continue;
    const raw = s.bet(ctx);
    if (!raw) continue;
    // Probabilité annoncée recalibrée par les résultats déjà réglés (prior de 15 paris).
    const bet = record && record.settled > 0 ? { ...raw, prob: (raw.prob * PRIOR_WEIGHT + record.won) / (PRIOR_WEIGHT + record.settled) } : raw;
    if (bet.prob < 0.45 || bet.prob > 0.9) continue;
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
