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
