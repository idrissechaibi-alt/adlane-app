// Modèle statistique de Poisson & Dévigage de cotes de marché (§5.1)

/**
 * Calcule la factorielle d'un entier
 */
function factorial(n: number): number {
  if (n <= 1) return 1;
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

/**
 * Loi de Poisson : P(X = k) = (lambda^k * e^-lambda) / k!
 */
export function poissonProb(lambda: number, k: number): number {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

export interface PoissonOutput {
  prob1X2: { home: number; draw: number; away: number };
  probBTTS: { yes: number; no: number };
  probOU25: { over: number; under: number };
  expectedGoals: { home: number; away: number; total: number };
  scoreMatrix: number[][]; // 6x6 score grid
}

/**
 * Calcule les probabilités à partir des buts attendus (xG / moyennes)
 */
export function computePoissonModel(expectedHomeGoals: number, expectedAwayGoals: number): PoissonOutput {
  const maxGoals = 6;
  const matrix: number[][] = [];

  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let pBTTS = 0;
  let pOver25 = 0;

  for (let i = 0; i < maxGoals; i++) {
    matrix[i] = [];
    const pI = poissonProb(expectedHomeGoals, i);

    for (let j = 0; j < maxGoals; j++) {
      const pJ = poissonProb(expectedAwayGoals, j);
      const pScore = pI * pJ;
      matrix[i][j] = pScore;

      // 1X2
      if (i > j) pHome += pScore;
      else if (i === j) pDraw += pScore;
      else pAway += pScore;

      // BTTS
      if (i > 0 && j > 0) pBTTS += pScore;

      // Over 2.5
      if (i + j > 2.5) pOver25 += pScore;
    }
  }

  return {
    prob1X2: { home: pHome, draw: pDraw, away: pAway },
    probBTTS: { yes: pBTTS, no: 1 - pBTTS },
    probOU25: { over: pOver25, under: 1 - pOver25 },
    expectedGoals: {
      home: expectedHomeGoals,
      away: expectedAwayGoals,
      total: expectedHomeGoals + expectedAwayGoals
    },
    scoreMatrix: matrix
  };
}

/**
 * Dévigage des cotes (retrait de la marge du bookmaker)
 * Permet d'obtenir les vraies probabilités implicites du marché
 */
export function devigOdds1X2(oddsHome: number, oddsDraw: number, oddsAway: number): {
  home: number;
  draw: number;
  away: number;
  margin: number;
} {
  const invHome = 1 / oddsHome;
  const invDraw = 1 / oddsDraw;
  const invAway = 1 / oddsAway;

  const totalInv = invHome + invDraw + invAway;
  const margin = (totalInv - 1) * 100; // Marge du bookmaker en %

  return {
    home: invHome / totalInv,
    draw: invDraw / totalInv,
    away: invAway / totalInv,
    margin
  };
}

/**
 * Dévigage pour marché à 2 issues (ex: BTTS ou Over/Under)
 */
export function devigOddsTwoWay(oddsYes: number, oddsNo: number): {
  yes: number;
  no: number;
  margin: number;
} {
  const invYes = 1 / oddsYes;
  const invNo = 1 / oddsNo;
  const total = invYes + invNo;

  return {
    yes: invYes / total,
    no: invNo / total,
    margin: (total - 1) * 100
  };
}

/**
 * Estime les buts attendus (home/away) à partir des cotes du marché,
 * quand aucune donnée xG réelle n'est disponible.
 *
 * Principe : le total de buts (home+away) suit une loi de Poisson de
 * paramètre lambda_total, donc P(total > 2.5) ne dépend que de
 * lambda_total. On recherche la paire (home, away) qui reproduit à la
 * fois cette probabilité "Over 2.5" dévigée ET les probabilités 1X2
 * dévigées. C'est un dévigage plus honnête qu'une valeur fixe : les
 * buts attendus reflètent le marché réel, ils ne sont pas inventés.
 */
export function estimateExpectedGoalsFromMarket(odds: {
  home: number;
  draw: number;
  away: number;
  over_2_5: number;
  under_2_5: number;
}): { home: number; away: number } | null {
  if (
    !odds.home || !odds.draw || !odds.away ||
    !odds.over_2_5 || !odds.under_2_5 ||
    odds.home <= 1 || odds.draw <= 1 || odds.away <= 1 ||
    odds.over_2_5 <= 1 || odds.under_2_5 <= 1
  ) {
    return null; // Cotes absentes ou invalides : impossible d'estimer honnêtement
  }

  const fair1X2 = devigOdds1X2(odds.home, odds.draw, odds.away);
  const fairOU = devigOddsTwoWay(odds.over_2_5, odds.under_2_5);

  let best = { home: 1.3, away: 1.1 };
  let bestError = Infinity;

  for (let home = 0.3; home <= 4.0; home += 0.1) {
    for (let away = 0.3; away <= 4.0; away += 0.1) {
      const model = computePoissonModel(home, away);
      const error =
        Math.pow(model.prob1X2.home - fair1X2.home, 2) +
        Math.pow(model.prob1X2.draw - fair1X2.draw, 2) +
        Math.pow(model.prob1X2.away - fair1X2.away, 2) +
        Math.pow(model.probOU25.over - fairOU.yes, 2);

      if (error < bestError) {
        bestError = error;
        best = { home, away };
      }
    }
  }

  return best;
}

// ==================== RECALIBRAGE À LA MI-TEMPS ====================

/**
 * Part empirique approximative des buts marqués en 2ème mi-temps (les
 * statistiques agrégées sur les grands championnats européens montrent
 * historiquement une légère majorité de buts en 2ème période — fatigue,
 * changements tactiques, remplacements). Valeur ronde volontairement
 * conservatrice, pas une constante mesurée précisément sur ce jeu de données.
 */
const SECOND_HALF_GOAL_SHARE = 0.55;

export interface HalfTimeStats {
  shotsOnTargetHome?: number;
  shotsOnTargetAway?: number;
  possessionHome?: number; // 0-100
  possessionAway?: number; // 0-100
  cornersHome?: number;
  cornersAway?: number;
}

export interface HalfTimeContext {
  preMatchExpectedGoals: { home: number; away: number }; // sur 90 minutes, avant match
  htScore: { home: number; away: number };
  htStats?: HalfTimeStats;
}

export interface SecondHalfMarket {
  market: string;
  selection: string;
  estimated_prob: number;
  confidence: 'Faible' | 'Moyen' | 'Élevé';
  reasoning: string;
}

export interface SecondHalfEstimate {
  secondHalfExpectedGoals: { home: number; away: number };
  markets: SecondHalfMarket[];
}

function confidenceFromProb(prob: number): 'Faible' | 'Moyen' | 'Élevé' {
  if (prob >= 0.65) return 'Élevé';
  if (prob >= 0.55) return 'Moyen';
  return 'Faible';
}

/**
 * Recalibre les buts attendus de 2ème mi-temps à partir des stats déjà
 * observées en 1ère mi-temps (tirs cadrés en priorité — plus fiable que la
 * possession sur un échantillon de 45 minutes). Ajustement volontairement
 * amorti et plafonné (+/-40%) : 45 minutes de jeu restent un petit
 * échantillon, on ne veut pas sur-réagir à une séquence ponctuelle.
 */
function recalibrateSecondHalfGoals(ctx: HalfTimeContext): { home: number; away: number } {
  const base = {
    home: ctx.preMatchExpectedGoals.home * SECOND_HALF_GOAL_SHARE,
    away: ctx.preMatchExpectedGoals.away * SECOND_HALF_GOAL_SHARE
  };

  const shotsHome = ctx.htStats?.shotsOnTargetHome;
  const shotsAway = ctx.htStats?.shotsOnTargetAway;

  if (shotsHome == null || shotsAway == null || shotsHome + shotsAway === 0) {
    return base; // Pas de stats fiables : on garde la projection pré-match telle quelle
  }

  const totalPreMatch = ctx.preMatchExpectedGoals.home + ctx.preMatchExpectedGoals.away;
  const preShareHome = totalPreMatch > 0 ? ctx.preMatchExpectedGoals.home / totalPreMatch : 0.5;
  const shotShareHome = shotsHome / (shotsHome + shotsAway);

  const rawShift = shotShareHome - preShareHome;
  const dampedShift = Math.max(-0.4, Math.min(0.4, rawShift * 1.5));

  return {
    home: Math.max(0.05, base.home * (1 + dampedShift)),
    away: Math.max(0.05, base.away * (1 - dampedShift))
  };
}

/**
 * Projette les issues finales (résultat, Over/Under 2.5, BTTS) en combinant
 * le score de mi-temps DÉJÀ ACQUIS (certain, pas aléatoire) avec la
 * distribution de Poisson des buts de 2ème mi-temps — pas une simple
 * addition des lambdas, qui fausserait la variance.
 */
function projectFullTimeMarkets(
  htScore: { home: number; away: number },
  secondHalfModel: PoissonOutput
): SecondHalfMarket[] {
  const maxGoals = secondHalfModel.scoreMatrix.length;
  let pHomeFT = 0, pDrawFT = 0, pAwayFT = 0, pOver25FT = 0, pBttsFT = 0;

  for (let i = 0; i < maxGoals; i++) {
    for (let j = 0; j < maxGoals; j++) {
      const p = secondHalfModel.scoreMatrix[i][j];
      const finalHome = htScore.home + i;
      const finalAway = htScore.away + j;

      if (finalHome > finalAway) pHomeFT += p;
      else if (finalHome === finalAway) pDrawFT += p;
      else pAwayFT += p;

      if (finalHome + finalAway > 2.5) pOver25FT += p;
      if (finalHome > 0 && finalAway > 0) pBttsFT += p;
    }
  }

  const ftFavorite = pHomeFT >= pAwayFT && pHomeFT >= pDrawFT
    ? { selection: '1 (domicile)', prob: pHomeFT }
    : pAwayFT >= pDrawFT
      ? { selection: '2 (extérieur)', prob: pAwayFT }
      : { selection: 'X (nul)', prob: pDrawFT };

  return [
    {
      market: 'FT_1X2_reprojete',
      selection: ftFavorite.selection,
      estimated_prob: ftFavorite.prob,
      confidence: confidenceFromProb(ftFavorite.prob),
      reasoning: `Score mi-temps ${htScore.home}-${htScore.away} + distribution 2ème MT projetée en fin de match.`
    },
    {
      market: 'FT_over_2_5_reprojete',
      selection: 'Plus de 2.5 buts (total match)',
      estimated_prob: pOver25FT,
      confidence: confidenceFromProb(pOver25FT),
      reasoning: `${htScore.home + htScore.away} but(s) déjà marqué(s) à la mi-temps, projection sur la suite du match.`
    },
    {
      market: 'FT_btts_reprojete',
      selection: 'Les deux équipes marquent (BTTS)',
      estimated_prob: pBttsFT,
      confidence: confidenceFromProb(pBttsFT),
      reasoning: 'Probabilité recalculée en tenant compte des buts déjà inscrits à la mi-temps.'
    }
  ];
}

/**
 * Point d'entrée : à partir du contexte de mi-temps (score, cotes pré-match,
 * stats optionnelles), renvoie les buts attendus recalibrés pour la 2ème MT
 * et une liste de marchés exploitables (2ème MT seule + ré-projection fin de
 * match), chacun avec sa probabilité estimée et son niveau de confiance.
 */
export function estimateSecondHalfMarket(ctx: HalfTimeContext): SecondHalfEstimate {
  const secondHalfExpectedGoals = recalibrateSecondHalfGoals(ctx);
  const secondHalfModel = computePoissonModel(secondHalfExpectedGoals.home, secondHalfExpectedGoals.away);

  const pAtLeastOneGoal2H = 1 - secondHalfModel.scoreMatrix[0][0];

  const markets: SecondHalfMarket[] = [
    {
      market: '2MT_over_0_5',
      selection: 'Plus de 0.5 but en 2ème mi-temps',
      estimated_prob: pAtLeastOneGoal2H,
      confidence: confidenceFromProb(pAtLeastOneGoal2H),
      reasoning: `Buts attendus 2ème MT : ${secondHalfExpectedGoals.home.toFixed(2)} (dom.) / ${secondHalfExpectedGoals.away.toFixed(2)} (ext.).`
    },
    ...(() => {
      const { home, draw, away } = secondHalfModel.prob1X2;
      const best = home >= away && home >= draw
        ? { selection: 'Domicile gagne la 2ème MT', prob: home }
        : away >= draw
          ? { selection: 'Extérieur gagne la 2ème MT', prob: away }
          : { selection: 'Nul en 2ème MT', prob: draw };
      return [{
        market: '2MT_1X2',
        selection: best.selection,
        estimated_prob: best.prob,
        confidence: confidenceFromProb(best.prob),
        reasoning: 'Résultat estimé sur la seule 2ème mi-temps (indépendant du score déjà acquis).'
      }];
    })(),
    ...projectFullTimeMarkets(ctx.htScore, secondHalfModel)
  ];

  return { secondHalfExpectedGoals, markets };
}

/**
 * Calcule l'edge (écart entre modèle et marché dévigué)
 */
export function computeEdge(modelProb: number, fairMarketProb: number): {
  edgeRatio: number;      // ex: 1.10 = +10% d'edge
  edgePoints: number;     // écart en points de pourcentage
  hasEdge: boolean;
} {
  const edgeRatio = fairMarketProb > 0 ? modelProb / fairMarketProb : 1;
  const edgePoints = (modelProb - fairMarketProb) * 100;

  return {
    edgeRatio,
    edgePoints,
    hasEdge: edgeRatio > 1.05 // Seuil d'edge minimum 5%
  };
}
