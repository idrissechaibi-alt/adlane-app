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
  let total = 0;

  for (let i = 0; i < maxGoals; i++) {
    matrix[i] = [];
    const pI = poissonProb(expectedHomeGoals, i);

    for (let j = 0; j < maxGoals; j++) {
      const pJ = poissonProb(expectedAwayGoals, j);
      const pScore = pI * pJ;
      matrix[i][j] = pScore;
      total += pScore;

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

  // La grille tronquée à 6x6 laisse échapper une petite masse de probabilité
  // (la queue de la loi de Poisson au-delà de 5 buts) — on renormalise pour
  // que scoreMatrix et les probabilités dérivées somment bien à 1.
  if (total > 0 && total !== 1) {
    for (let i = 0; i < maxGoals; i++) {
      for (let j = 0; j < maxGoals; j++) {
        matrix[i][j] /= total;
      }
    }
    pHome /= total; pDraw /= total; pAway /= total; pBTTS /= total; pOver25 /= total;
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

// ==================== CORRECTION DIXON-COLES ====================
//
// Le Poisson indépendant ci-dessus sur-estime légèrement le score 1-1 et
// sous-estime les 0-0/1-0/0-1 (les buts domicile/extérieur ne sont pas
// parfaitement indépendants sur les scores bas). Dixon & Coles (1997)
// corrigent ça avec un facteur τ(x,y,ρ) appliqué aux 4 cases les plus basses.
//
// Calibration réelle effectuée pendant cette session : τ ajusté sur une
// saison complète (Serie A 2015/16, 380 matchs, données StatsBomb open-data)
// donne un ρ optimal de -0,014 sur ces 4 cases — beaucoup plus proche de 0
// que le -0.13 souvent cité dans la littérature (calibré sur d'autres
// championnats/époques), et appliquer -0.13 tel quel dégradait l'ajustement
// sur cet échantillon (erreur quadratique ×5,6). Le champion set StatsBomb
// ouvert ne couvre pas les saisons courantes des 5 grands championnats (cf.
// rapport), donc cette valeur reste un point de départ raisonnable, pas une
// calibration définitive — à recalculer quand le corpus collecté en direct
// par la boucle d'auto-apprentissage sera assez large pour sa propre
// estimation par match plutôt que par moyenne de ligue.
export const DEFAULT_DIXON_COLES_RHO = -0.014;

function dixonColesTau(x: number, y: number, lambdaHome: number, lambdaAway: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (x === 0 && y === 1) return 1 + lambdaHome * rho;
  if (x === 1 && y === 0) return 1 + lambdaAway * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/**
 * Variante Dixon-Coles de computePoissonModel : mêmes buts attendus, matrice
 * de score corrigée sur les 4 cases basses puis renormalisée (τ modifie
 * légèrement la masse totale). À utiliser en complément du Poisson simple
 * pour les marchés sensibles aux scores bas (BTTS, 1X2 serré, moins de 1.5).
 */
export function computeDixonColesModel(
  expectedHomeGoals: number,
  expectedAwayGoals: number,
  rho: number = DEFAULT_DIXON_COLES_RHO
): PoissonOutput {
  const base = computePoissonModel(expectedHomeGoals, expectedAwayGoals);
  const maxGoals = base.scoreMatrix.length;

  const matrix: number[][] = [];
  let total = 0;
  for (let i = 0; i < maxGoals; i++) {
    matrix[i] = [];
    for (let j = 0; j < maxGoals; j++) {
      const tau = i <= 1 && j <= 1 ? dixonColesTau(i, j, expectedHomeGoals, expectedAwayGoals, rho) : 1;
      const p = base.scoreMatrix[i][j] * tau;
      matrix[i][j] = p;
      total += p;
    }
  }

  let pHome = 0, pDraw = 0, pAway = 0, pBTTS = 0, pOver25 = 0;
  for (let i = 0; i < maxGoals; i++) {
    for (let j = 0; j < maxGoals; j++) {
      const p = matrix[i][j] / total;
      matrix[i][j] = p;
      if (i > j) pHome += p; else if (i === j) pDraw += p; else pAway += p;
      if (i > 0 && j > 0) pBTTS += p;
      if (i + j > 2.5) pOver25 += p;
    }
  }

  return {
    prob1X2: { home: pHome, draw: pDraw, away: pAway },
    probBTTS: { yes: pBTTS, no: 1 - pBTTS },
    probOU25: { over: pOver25, under: 1 - pOver25 },
    expectedGoals: { home: expectedHomeGoals, away: expectedAwayGoals, total: expectedHomeGoals + expectedAwayGoals },
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

// ==================== DÉVIGAGE DE SHIN ====================
//
// Méthode alternative au simple retrait proportionnel ci-dessus : Shin (1992,
// 1993) modélise une part z de "paris d'initiés" et en déduit des probabilités
// justes différentes de la simple normalisation par les probabilités
// implicites. Pour n issues de probabilités implicites π_i (π_i = 1/cote_i,
// Σπ_i = surcote), on résout numériquement :
//   Σ_i [ sqrt(z² + 4(1-z)·π_i²/Σπ) - z ] / (2(1-z)) = 1
// puis p_i = [ sqrt(z² + 4(1-z)·π_i²/Σπ) - z ] / (2(1-z)).
// Référence : Shin, H.S. (1993), "Measuring the Incidence of Insider Trading
// in a Market for State-Contingent Claims".

function shinSumForZ(impliedProbs: number[], overround: number, z: number): number {
  let sum = 0;
  for (const pi of impliedProbs) {
    const inner = z * z + 4 * (1 - z) * (pi * pi) / overround;
    sum += (Math.sqrt(Math.max(0, inner)) - z) / (2 * (1 - z));
  }
  return sum;
}

/**
 * Dévigage de Shin pour un nombre quelconque d'issues (2 ou 3 en pratique
 * ici). Recherche binaire sur z ∈ [0, 1) : sum(z=0) = √surcote > 1 et
 * sum(z→1) < 1 pour une distribution de cotes réelle, donc une racine existe
 * toujours dans cet intervalle pour un jeu de cotes valide.
 */
export function devigShin(odds: number[]): { probs: number[]; z: number; margin: number } {
  const impliedProbs = odds.map((o) => 1 / o);
  const overround = impliedProbs.reduce((a, b) => a + b, 0);

  let lo = 0;
  let hi = 1 - 1e-9;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const sum = shinSumForZ(impliedProbs, overround, mid);
    if (sum > 1) lo = mid; else hi = mid;
  }
  const z = (lo + hi) / 2;

  const probs = impliedProbs.map((pi) => {
    const inner = z * z + 4 * (1 - z) * (pi * pi) / overround;
    return (Math.sqrt(Math.max(0, inner)) - z) / (2 * (1 - z));
  });

  // Garde-fou numérique : la résolution par bissection peut laisser un écart
  // résiduel négligeable, on renormalise pour que ça somme exactement à 1.
  const total = probs.reduce((a, b) => a + b, 0);
  return {
    probs: probs.map((p) => p / total),
    z,
    margin: (overround - 1) * 100
  };
}

/** Dévigage de Shin pour un marché 1X2 (3 issues). */
export function devigOdds1X2Shin(oddsHome: number, oddsDraw: number, oddsAway: number): {
  home: number; draw: number; away: number; z: number; margin: number;
} {
  const { probs, z, margin } = devigShin([oddsHome, oddsDraw, oddsAway]);
  return { home: probs[0], draw: probs[1], away: probs[2], z, margin };
}

/** Dévigage de Shin pour un marché à 2 issues (BTTS, Over/Under). */
export function devigOddsTwoWayShin(oddsYes: number, oddsNo: number): {
  yes: number; no: number; z: number; margin: number;
} {
  const { probs, z, margin } = devigShin([oddsYes, oddsNo]);
  return { yes: probs[0], no: probs[1], z, margin };
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

// ==================== LIGNES OVER/UNDER (marchés sans cote publiée) ====================

/** P(Poisson(lambda) > line), line pouvant être X.5 ou un entier. */
export function poissonOverProb(lambda: number, line: number): number {
  let cdf = 0;
  for (let k = 0; k <= Math.floor(line); k++) cdf += poissonProb(lambda, k);
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** Ligne X.5 la plus proche (juste en dessous) de la moyenne estimée. */
export function lineNearMean(lambda: number): number {
  return Math.max(0.5, Math.floor(lambda) - 0.5);
}

/**
 * Parmi toutes les lignes X.5 au-dessus de la moyenne, la PLUS HAUTE dont la
 * probabilité de dépassement reste >= threshold (viser le meilleur rapport
 * gain/risque plutôt qu'une ligne "évidente" proche de la moyenne — ex. 9
 * corners attendus, proposer "plus de 7" ou "plus de 8.5" plutôt que "plus de
 * 4" qui n'a aucune valeur). La probabilité décroît strictement quand la
 * ligne monte, donc un simple parcours croissant qui s'arrête au premier
 * échec suffit à trouver le maximum.
 *
 * `alreadyObserved` (par défaut 0) permet de traiter un total déjà entamé en
 * cours de match (ex: corners déjà comptés depuis le coup d'envoi) : la ligne
 * porte sur le TOTAL (déjà observé + reste modélisé en Poisson(lambda)), pas
 * seulement sur le reste.
 */
export function pickHighestConfidentOverLine(
  lambda: number,
  threshold: number,
  alreadyObserved: number = 0
): { line: number; prob: number } | null {
  let best: { line: number; prob: number } | null = null;
  const startLine = Math.max(0.5, lineNearMean(lambda) + alreadyObserved - 5);
  for (let i = 0; i < 15; i++) {
    const line = startLine + i;
    const prob = poissonOverProb(lambda, line - alreadyObserved);
    if (prob < threshold) break;
    best = { line, prob };
  }
  return best;
}

// ==================== RECALIBRAGE EN COURS DE MATCH ====================

/**
 * Part empirique approximative des buts marqués en 2ème mi-temps (les
 * statistiques agrégées sur les grands championnats européens montrent
 * historiquement une légère majorité de buts en 2ème période — fatigue,
 * changements tactiques, remplacements). Valeur ronde volontairement
 * conservatrice, pas une constante mesurée précisément sur ce jeu de données.
 * Utilisée uniquement pour pondérer le début vs la fin de match ci-dessous,
 * PAS comme un simple partage 45/45 minutes.
 */
const SECOND_HALF_GOAL_SHARE = 0.55;

export interface LiveMatchStats {
  shotsOnTargetHome?: number;
  shotsOnTargetAway?: number;
  possessionHome?: number; // 0-100
  possessionAway?: number; // 0-100
  cornersHome?: number;
  cornersAway?: number;
}

/**
 * Contexte pour re-projeter le RESTE du match à partir de n'importe quel
 * instant (20e, 45e/mi-temps, 60e minute...), pas seulement la mi-temps —
 * généralisation de l'ancien HalfTimeContext, qui supposait toujours un
 * découpage exact en 2 mi-temps de 45 minutes.
 */
export interface RemainingMatchContext {
  preMatchExpectedGoals: { home: number; away: number }; // sur 90 minutes, avant match
  elapsedMinutes: number; // minute de jeu actuelle
  currentScore: { home: number; away: number };
  currentStats?: LiveMatchStats;
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

// Taux de buts par minute impliqué par SECOND_HALF_GOAL_SHARE, pour pouvoir
// intégrer la part de buts attendus sur N'IMPORTE QUELLE fenêtre (pas
// seulement un découpage 45/45) — se réduit exactement au partage 45%/55%
// d'origine à l'instant précis de la mi-temps (45e minute).
const FIRST_HALF_RATE_PER_MIN = (1 - SECOND_HALF_GOAL_SHARE) / 45;
const SECOND_HALF_RATE_PER_MIN = SECOND_HALF_GOAL_SHARE / 45;

/**
 * Fraction des événements attendus sur le match ENTIER (buts, mais aussi
 * corners/cartons par réutilisation du même partage début/fin de match) qui
 * reste à venir à partir de `elapsedMinutes`, jusqu'à la 90e.
 */
export function remainingMatchEventFraction(elapsedMinutes: number): number {
  const e = Math.max(0, Math.min(90, elapsedMinutes));
  if (e >= 45) return SECOND_HALF_RATE_PER_MIN * (90 - e);
  return FIRST_HALF_RATE_PER_MIN * (45 - e) + SECOND_HALF_GOAL_SHARE;
}

/**
 * Fraction des événements attendus sur le match ENTIER qui reste à venir
 * avant la pause seulement (n'a de sens que pour `elapsedMinutes` < 45).
 */
export function remainingFirstHalfEventFraction(elapsedMinutes: number): number {
  const e = Math.max(0, Math.min(45, elapsedMinutes));
  return FIRST_HALF_RATE_PER_MIN * (45 - e);
}

/**
 * Recalibre les buts attendus sur une fenêtre restante à partir des stats
 * déjà observées (tirs cadrés en priorité — plus fiable que la possession sur
 * un petit échantillon). Ajustement volontairement amorti et plafonné
 * (+/-40%) : plus la fenêtre déjà jouée est courte (20 minutes), plus
 * l'échantillon est petit, on ne veut pas sur-réagir à une séquence
 * ponctuelle.
 */
function recalibrateGoalsForWindow(
  preMatchExpectedGoals: { home: number; away: number },
  windowFraction: number,
  currentStats?: LiveMatchStats
): { home: number; away: number } {
  const base = {
    home: preMatchExpectedGoals.home * windowFraction,
    away: preMatchExpectedGoals.away * windowFraction
  };

  const shotsHome = currentStats?.shotsOnTargetHome;
  const shotsAway = currentStats?.shotsOnTargetAway;

  if (shotsHome == null || shotsAway == null || shotsHome + shotsAway === 0) {
    return base; // Pas de stats fiables : on garde la projection pré-match telle quelle
  }

  const totalPreMatch = preMatchExpectedGoals.home + preMatchExpectedGoals.away;
  const preShareHome = totalPreMatch > 0 ? preMatchExpectedGoals.home / totalPreMatch : 0.5;
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
 * Point d'entrée générique : à partir de n'importe quel instant du match
 * (20e, mi-temps, 60e...), renvoie les buts attendus recalibrés sur le RESTE
 * DU MATCH ENTIER et une liste de marchés exploitables (reste du match seul +
 * ré-projection fin de match tenant compte du score déjà acquis), chacun avec
 * sa probabilité estimée et son niveau de confiance. Remplace l'ancien
 * estimateSecondHalfMarket, qui supposait toujours un point de départ à la
 * 45e minute pile.
 */
export function estimateRemainingMatchMarket(ctx: RemainingMatchContext): SecondHalfEstimate {
  const fraction = remainingMatchEventFraction(ctx.elapsedMinutes);
  const remainingExpectedGoals = recalibrateGoalsForWindow(ctx.preMatchExpectedGoals, fraction, ctx.currentStats);
  const remainingModel = computePoissonModel(remainingExpectedGoals.home, remainingExpectedGoals.away);

  const pAtLeastOneGoal = 1 - remainingModel.scoreMatrix[0][0];

  const markets: SecondHalfMarket[] = [
    {
      market: 'reste_over_0_5',
      selection: 'Plus de 0.5 but sur le reste du match',
      estimated_prob: pAtLeastOneGoal,
      confidence: confidenceFromProb(pAtLeastOneGoal),
      reasoning: `Buts attendus sur le reste du match (depuis la ${ctx.elapsedMinutes}e minute) : ${remainingExpectedGoals.home.toFixed(2)} (dom.) / ${remainingExpectedGoals.away.toFixed(2)} (ext.).`
    },
    ...(() => {
      const { home, draw, away } = remainingModel.prob1X2;
      const best = home >= away && home >= draw
        ? { selection: 'Domicile gagne le reste du match', prob: home }
        : away >= draw
          ? { selection: 'Extérieur gagne le reste du match', prob: away }
          : { selection: 'Nul sur le reste du match', prob: draw };
      return [{
        market: 'reste_1X2',
        selection: best.selection,
        estimated_prob: best.prob,
        confidence: confidenceFromProb(best.prob),
        reasoning: 'Résultat estimé sur le reste du match uniquement (indépendant du score déjà acquis).'
      }];
    })(),
    ...projectFullTimeMarkets(ctx.currentScore, remainingModel)
  ];

  return { secondHalfExpectedGoals: remainingExpectedGoals, markets };
}

/**
 * Variante pour la fenêtre "reste de la 1ère mi-temps seulement" (checkpoint
 * de la 20e minute) : projette jusqu'à la pause, pas jusqu'à la 90e. N'a de
 * sens que pour ctx.elapsedMinutes < 45.
 */
export function estimateRemainingFirstHalfMarket(ctx: RemainingMatchContext): SecondHalfEstimate {
  const fraction = remainingFirstHalfEventFraction(ctx.elapsedMinutes);
  const remainingExpectedGoals = recalibrateGoalsForWindow(ctx.preMatchExpectedGoals, fraction, ctx.currentStats);
  const remainingModel = computePoissonModel(remainingExpectedGoals.home, remainingExpectedGoals.away);

  const pAtLeastOneGoal = 1 - remainingModel.scoreMatrix[0][0];

  return {
    secondHalfExpectedGoals: remainingExpectedGoals,
    markets: [{
      market: 'mt1_over_0_5_restant',
      selection: 'Encore un but avant la pause',
      estimated_prob: pAtLeastOneGoal,
      confidence: confidenceFromProb(pAtLeastOneGoal),
      reasoning: `Buts attendus d'ici la pause (depuis la ${ctx.elapsedMinutes}e minute) : ${remainingExpectedGoals.home.toFixed(2)} (dom.) / ${remainingExpectedGoals.away.toFixed(2)} (ext.), score actuel ${ctx.currentScore.home}-${ctx.currentScore.away}.`
    }]
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
