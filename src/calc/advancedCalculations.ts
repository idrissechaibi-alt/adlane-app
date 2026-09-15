// Outils de Calcul Avancé pour le Betting
// Modèles statistiques, Value Betting, Surebets, etc.

import { FootballMatch, MatchStatistics, MarketOdds } from '../api/types';

// ==================== CONFIGURATION ====================

export interface CalculationConfig {
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  minConfidence: number;
  maxMarketSize: number;
  valueThreshold: number;
}

const DEFAULT_CONFIG: CalculationConfig = {
  riskTolerance: 'moderate',
  minConfidence: 0.65,
  maxMarketSize: 10000,
  valueThreshold: 1.05 // Minimum value edge (5%)
};

// ==================== CALCULATEUR D'EDGE (VALUE BETTING) ====================

export class EdgeCalculator {
  private config: CalculationConfig;

  constructor(config: Partial<CalculationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calcule l'edge pour un marché donné
   * Edge = (Probabilité Implicite - Probabilité Réelle) / Probabilité Implicite
   */
  calculateEdge(
    odds: number,
    impliedProbability: number
  ): number {
    if (odds <= 1) return 0;
    return (impliedProbability - (1 / odds)) / impliedProbability;
  }

  /**
   * Trouve les value bets parmi une liste d'odds
   */
  findValueBets(
    match: FootballMatch,
    oddsData: MarketOdds[]
  ): ValueBet[] {
    const valueBets: ValueBet[] = [];

    oddsData.forEach(market => {
      if (market.market === '1X2') {
        const homeEdge = this.calculateEdge(market.odds.home || 0, 0.5);
        const drawEdge = this.calculateEdge(market.odds.draw || 0, 0.3);
        const awayEdge = this.calculateEdge(market.odds.away || 0, 0.5);

        if (homeEdge > this.config.valueThreshold - 1) {
          valueBets.push({
            match,
            market: '1X2',
            selection: 'home',
            odds: market.odds.home!,
            edge: homeEdge,
            confidence: this.calculateConfidence(homeEdge)
          });
        }

        if (drawEdge > this.config.valueThreshold - 1) {
          valueBets.push({
            match,
            market: '1X2',
            selection: 'draw',
            odds: market.odds.draw!,
            edge: drawEdge,
            confidence: this.calculateConfidence(drawEdge)
          });
        }

        if (awayEdge > this.config.valueThreshold - 1) {
          valueBets.push({
            match,
            market: '1X2',
            selection: 'away',
            odds: market.odds.away!,
            edge: awayEdge,
            confidence: this.calculateConfidence(awayEdge)
          });
        }
      }
    });

    return valueBets;
  }

  /**
   * Calcule la confiance à partir de l'edge
   */
  calculateConfidence(edge: number): number {
    // Map l'edge (0-1) vers une confiance (0-1)
    return Math.min(1, Math.max(0, edge * 2));
  }

  /**
   * Calcule leKelly Criterion pour la gestion de bankroll
   */
  calculateKelly(
    odds: number,
    winProbability: number
  ): number {
    if (odds <= 1 || winProbability <= 0 || winProbability >= 1) {
      return 0;
    }
    const b = odds - 1;
    const p = winProbability;
    const q = 1 - p;
    const kelly = (b * p - q) / b;
    return Math.max(0, kelly);
  }

  /**
   * Calcule la taille de mise recommandée
   */
  calculateBetSize(
    bankroll: number,
    odds: number,
    winProbability: number
  ): number {
    const kelly = this.calculateKelly(odds, winProbability);

    // Utiliser Fractional Kelly pour réduire la volatilité
    const fraction = this.getFractionalKelly();
    const recommendedBet = bankroll * kelly * fraction;

    return Math.min(recommendedBet, this.config.maxMarketSize);
  }

  private getFractionalKelly(): number {
    switch (this.config.riskTolerance) {
      case 'conservative':
        return 0.25; // 1/4 Kelly
      case 'aggressive':
        return 0.75; // 3/4 Kelly
      case 'moderate':
      default:
        return 0.5; // 1/2 Kelly
    }
  }
}

// ==================== CALCULATEUR DE SUREBET (ARBITRAGE) ====================

export class SurebetCalculator {
  /**
   * Détecte les surebets entre plusieurs bookmakers
   */
  findSurebets(
    match: FootballMatch,
    oddsByBookmaker: Record<string, MarketOdds[]>
  ): Surebet[] {
    const surebets: Surebet[] = [];

    // Trouver les meilleures cotes pour chaque issue
    const bestOdds: Record<string, number> = {};
    const bestBookmakers: Record<string, string> = {};

    Object.entries(oddsByBookmaker).forEach(([bookmaker, markets]) => {
      markets.forEach(market => {
        if (market.market === '1X2') {
          if (market.odds.home && (!bestOdds['home'] || market.odds.home > bestOdds['home'])) {
            bestOdds['home'] = market.odds.home;
            bestBookmakers['home'] = bookmaker;
          }
          if (market.odds.draw && (!bestOdds['draw'] || market.odds.draw > bestOdds['draw'])) {
            bestOdds['draw'] = market.odds.draw;
            bestBookmakers['draw'] = bookmaker;
          }
          if (market.odds.away && (!bestOdds['away'] || market.odds.away > bestOdds['away'])) {
            bestOdds['away'] = market.odds.away;
            bestBookmakers['away'] = bookmaker;
          }
        }
      });
    });

    // Vérifier si la somme des inverses < 1 (surebet)
    const sumInv = (1 / (bestOdds['home'] || 0)) +
                   (1 / (bestOdds['draw'] || 0)) +
                   (1 / (bestOdds['away'] || 0));

    if (sumInv < 1) {
      surebets.push({
        match,
        type: 'full_arbitrage',
        homeBookmaker: bestBookmakers['home'] || 'Unknown',
        drawBookmaker: bestBookmakers['draw'] || 'Unknown',
        awayBookmaker: bestBookmakers['away'] || 'Unknown',
        homeOdds: bestOdds['home'] || 0,
        drawOdds: bestOdds['draw'] || 0,
        awayOdds: bestOdds['away'] || 0,
        profitPercentage: (1 - sumInv) * 100
      });
    }

    return surebets;
  }

  /**
   * Calcule la répartition des mises pour un surebet
   */
  calculateArbitrageBets(
    totalStake: number,
    odds: { home: number; draw: number; away: number }
  ): ArbitrageDistribution {
    const sumInv = (1 / odds.home) + (1 / odds.draw) + (1 / odds.away);
    const homeBet = totalStake * (1 / odds.home) / sumInv;
    const drawBet = totalStake * (1 / odds.draw) / sumInv;
    const awayBet = totalStake * (1 / odds.away) / sumInv;

    return {
      homeBet,
      drawBet,
      awayBet,
      totalStake,
      guaranteedProfit: totalStake - (homeBet + drawBet + awayBet),
      roi: ((totalStake - (homeBet + drawBet + awayBet)) / totalStake) * 100
    };
  }
}

// ==================== CALCULATEUR DE PROBABILITÉS (POISSON ÉTENDU) ====================

export class ProbabilityCalculator {
  /**
   * Calcule les probabilités avec un modèle Poisson étendu
   * Prend en compte xG, forme récente, etc.
   */
  calculateMatchProbabilities(
    homeTeam: any,
    awayTeam: any,
    match: FootballMatch
  ): MatchProbabilities {
    // Calcul du xG (expected goals) basé sur les stats des équipes
    const homeXG = this.calculateXG(homeTeam);
    const awayXG = this.calculateXG(awayTeam);

    // Ajustement selon la forme récente
    const homeFormFactor = this.calculateFormFactor(homeTeam.form);
    const awayFormFactor = this.calculateFormFactor(awayTeam.form);

    // Ajustement selon l'importance du match (si disponible)
    const importanceFactor = this.calculateImportanceFactor(match);

    // Probabilités finales
    const homeProb = this.calculateWinProbability(homeXG * homeFormFactor * importanceFactor, awayXG);
    const awayProb = this.calculateWinProbability(awayXG * awayFormFactor, homeXG * homeFormFactor);
    const drawProb = 1 - homeProb - awayProb;

    // Ajuster la probabilité de nul pour qu'elle reste positive
    const finalDrawProb = Math.max(0, drawProb);
    const total = homeProb + awayProb + finalDrawProb;
    const normalizedHome = homeProb / total;
    const normalizedAway = awayProb / total;
    const normalizedDraw = finalDrawProb / total;

    return {
      homeWin: normalizedHome,
      draw: normalizedDraw,
      awayWin: normalizedAway,
      homeXG,
      awayXG,
      confidence: this.calculateConfidence(homeXG, awayXG)
    };
  }

  /**
   * Calcule le xG basé sur les stats de l'équipe
   */
  calculateXG(team: any): number {
    const stats = team.stats || {};
    const goalsFor = stats.goalsFor || 0;
    const played = stats.played || 1;

    return played > 0 ? goalsFor / played : 1.5;
  }

  /**
   * Calcule un facteur de forme (0.8 - 1.2)
   */
  calculateFormFactor(form?: string[]): number {
    if (!form || form.length === 0) return 1.0;

    let points = 0;
    form.forEach(result => {
      if (result === 'W' || result === 'G') points += 3;
      else if (result === 'D' || result === 'N') points += 1;
    });

    const avg = points / (form.length * 3);
    return 0.8 + (avg * 0.4); // 0.8 - 1.2
  }

  /**
   * Calcule un facteur d'importance du match
   */
  calculateImportanceFactor(match: FootballMatch): number {
    // Ligue top tier = facteur plus élevé
    if (match.leagueName?.includes('Premier') || match.leagueName?.includes('Champions')) {
      return 1.1;
    }
    return 1.0;
  }

  /**
   * Calcule la probabilité de victoire d'une équipe
   */
  calculateWinProbability(myXG: number, opponentXG: number): number {
    // Modèle simple basé sur le ratio de xG
    const ratio = myXG / (myXG + opponentXG);
    return Math.max(0.05, Math.min(0.95, ratio));
  }

  /**
   * Calcule la confiance de la prédiction
   */
  calculateConfidence(homeXG: number, awayXG: number): number {
    // Plus la différence de xG est grande, plus on est confiant
    const diff = Math.abs(homeXG - awayXG);
    return Math.min(0.95, 0.5 + (diff * 0.2));
  }
}

// ==================== TYPES ====================

export interface ValueBet {
  match: FootballMatch;
  market: string;
  selection: string;
  odds: number;
  edge: number;
  confidence: number;
  recommendedStake?: number;
}

export interface Surebet {
  match: FootballMatch;
  type: 'full_arbitrage' | 'back_lay';
  homeBookmaker: string;
  drawBookmaker?: string;
  awayBookmaker: string;
  homeOdds: number;
  drawOdds?: number;
  awayOdds: number;
  profitPercentage: number;
}

export interface ArbitrageDistribution {
  homeBet: number;
  drawBet: number;
  awayBet: number;
  totalStake: number;
  guaranteedProfit: number;
  roi: number;
}

export interface MatchProbabilities {
  homeWin: number;
  draw: number;
  awayWin: number;
  homeXG: number;
  awayXG: number;
  confidence: number;
}

// ==================== FONCTIONS UTILITAIRES ====================

/**
 * Calcule le ROI d'une stratégie de betting
 */
export function calculateROI(
  initialBankroll: number,
  finalBankroll: number
): number {
  return ((finalBankroll - initialBankroll) / initialBankroll) * 100;
}

/**
 * Calcule le win rate nécessaire pour être rentable
 */
export function breakEvenWinRate(
  averageOdds: number
): number {
  return 1 / averageOdds;
}

/**
 * Simule un portefeuille de betting
 */
export function simulateBettingPortfolio(
  initialBankroll: number,
  bets: { stake: number; odds: number; win: boolean }[]
): number {
  let bankroll = initialBankroll;

  bets.forEach(bet => {
    if (bet.win) {
      bankroll += bet.stake * (bet.odds - 1);
    } else {
      bankroll -= bet.stake;
    }
  });

  return bankroll;
}
