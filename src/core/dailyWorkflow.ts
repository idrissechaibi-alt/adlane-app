// Moteur du Workflow Matinal & Planning du Jour (§5.1, §5.2, §5.3)
// Browse les 5 championnats, découpe en créneaux, génère et valide les propositions

import { Bet, BetLeg, Market } from '../types';
import { computePoissonModel, devigOdds1X2, devigOddsTwoWay, computeEdge } from './poisson';
import { validateBet } from './validator';

export interface LeagueInfo {
  id: string;
  name: string;
  country: string;
  flag: string;
}

export const TOP_5_LEAGUES: LeagueInfo[] = [
  { id: 'PL', name: 'Premier League', country: 'Angleterre', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { id: 'LL', name: 'La Liga', country: 'Espagne', flag: '🇪🇸' },
  { id: 'SA', name: 'Serie A', country: 'Italie', flag: '🇮🇹' },
  { id: 'BL', name: 'Bundesliga', country: 'Allemagne', flag: '🇩🇪' },
  { id: 'L1', name: 'Ligue 1', country: 'France', flag: '🇫🇷' }
];

export interface ScheduledMatch {
  id: string;
  leagueId: string;
  leagueName: string;
  flag: string;
  homeTeam: string;
  awayTeam: string;
  kickoff_utc: string;
  creneau_display: string; // Heure Algérie UTC+1
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  odds: {
    home: number;
    draw: number;
    away: number;
    btts_yes: number;
    btts_no: number;
    over_2_5: number;
    under_2_5: number;
  };
  context: string;
}

export interface DaySlot {
  slotKey: string;            // ex: "15h30"
  time_utc: string;
  display_time: string;       // UTC+1
  matches: ScheduledMatch[];
}

export interface ProposedSlip {
  id: string;
  type: 'solo' | 'combo';
  title: string;
  legs: BetLeg[];
  totalOdds: number;
  confiance: number;
  confidenceLevel: 'Faible' | 'Moyen' | 'Élevé';
  analysis: string;
  validation: {
    valid: boolean;
    blockers: string[];
    warnings: string[];
  };
}

/**
 * Générateur d'exemples de matchs du jour pour les 5 championnats
 */
export function getSampleDailyFixtures(targetDate: string = '2026-09-14'): ScheduledMatch[] {
  return [
    {
      id: 'm-pl-01',
      leagueId: 'PL',
      leagueName: 'Premier League',
      flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      homeTeam: 'Leeds United',
      awayTeam: 'Newcastle United',
      kickoff_utc: `${targetDate}T19:00:00Z`,
      creneau_display: '20:00',
      expectedHomeGoals: 1.15,
      expectedAwayGoals: 1.65,
      odds: {
        home: 3.40,
        draw: 3.60,
        away: 2.10,
        btts_yes: 1.68,
        btts_no: 2.15,
        over_2_5: 1.82,
        under_2_5: 2.00
      },
      context: 'Arbitre Anthony Taylor. Isak titulaire.'
    },
    {
      id: 'm-ll-01',
      leagueId: 'LL',
      leagueName: 'La Liga',
      flag: '🇪🇸',
      homeTeam: 'Sevilla FC',
      awayTeam: 'Girona',
      kickoff_utc: `${targetDate}T19:00:00Z`,
      creneau_display: '20:00',
      expectedHomeGoals: 1.40,
      expectedAwayGoals: 1.20,
      odds: {
        home: 2.30,
        draw: 3.30,
        away: 3.10,
        btts_yes: 1.75,
        btts_no: 2.05,
        over_2_5: 1.95,
        under_2_5: 1.85
      },
      context: 'Gérone solide en transition, Séville en reconstruction.'
    },
    {
      id: 'm-sa-01',
      leagueId: 'SA',
      leagueName: 'Serie A',
      flag: '🇮🇹',
      homeTeam: 'Verona',
      awayTeam: 'Atalanta',
      kickoff_utc: `${targetDate}T17:30:00Z`,
      creneau_display: '18:30',
      expectedHomeGoals: 0.85,
      expectedAwayGoals: 2.05,
      odds: {
        home: 4.50,
        draw: 3.80,
        away: 1.75,
        btts_yes: 1.80,
        btts_no: 2.00,
        over_2_5: 1.70,
        under_2_5: 2.10
      },
      context: 'Atalanta en forme offensive. Retegui en pointe.'
    },
    {
      id: 'm-bl-01',
      leagueId: 'BL',
      leagueName: 'Bundesliga',
      flag: '🇩🇪',
      homeTeam: 'Bochum',
      awayTeam: 'Eintracht Frankfurt',
      kickoff_utc: `${targetDate}T18:30:00Z`,
      creneau_display: '19:30',
      expectedHomeGoals: 1.10,
      expectedAwayGoals: 1.90,
      odds: {
        home: 3.60,
        draw: 3.75,
        away: 1.95,
        btts_yes: 1.55,
        btts_no: 2.40,
        over_2_5: 1.62,
        under_2_5: 2.25
      },
      context: 'Marmoush en feu. Bochum fragile sur coups de pied arrêtés.'
    },
    {
      id: 'm-l1-01',
      leagueId: 'L1',
      leagueName: 'Ligue 1',
      flag: '🇫🇷',
      homeTeam: 'Lens',
      awayTeam: 'Lyon',
      kickoff_utc: `${targetDate}T18:45:00Z`,
      creneau_display: '19:45',
      expectedHomeGoals: 1.55,
      expectedAwayGoals: 1.10,
      odds: {
        home: 1.95,
        draw: 3.60,
        away: 3.75,
        btts_yes: 1.70,
        btts_no: 2.10,
        over_2_5: 1.80,
        under_2_5: 2.00
      },
      context: 'Bollaert à guichets fermés. Lyon avec Lacazette.'
    }
  ];
}

/**
 * Découpe les matchs en créneaux horaires chronologiques
 */
export function groupMatchesBySlots(matches: ScheduledMatch[]): DaySlot[] {
  const slotMap = new Map<string, ScheduledMatch[]>();

  for (const match of matches) {
    const key = match.creneau_display;
    const existing = slotMap.get(key) || [];
    existing.push(match);
    slotMap.set(key, existing);
  }

  const slots: DaySlot[] = [];
  for (const [key, slotMatches] of slotMap.entries()) {
    slots.push({
      slotKey: key,
      time_utc: slotMatches[0].kickoff_utc,
      display_time: key,
      matches: slotMatches
    });
  }

  // Tri par heure croissante
  return slots.sort((a, b) => a.time_utc.localeCompare(b.time_utc));
}

/**
 * Génère des propositions de paris (Solos et Combinés) conformes aux règles
 */
export function generateDailyProposals(
  matches: ScheduledMatch[],
  existingBets: Bet[] = []
): ProposedSlip[] {
  const proposals: ProposedSlip[] = [];

  // 1. Analyse probabiliste individuelle de chaque match
  const evaluatedSelections: Array<{
    match: ScheduledMatch;
    market: Market;
    selection: string;
    modelProb: number;
    fairProb: number;
    odds: number;
    edgeRatio: number;
    confidence: 'Faible' | 'Moyen' | 'Élevé';
  }> = [];

  for (const match of matches) {
    const poisson = computePoissonModel(match.expectedHomeGoals, match.expectedAwayGoals);
    const devig1X2 = devigOdds1X2(match.odds.home, match.odds.draw, match.odds.away);
    const devigBTTS = devigOddsTwoWay(match.odds.btts_yes, match.odds.btts_no);
    const devigOU = devigOddsTwoWay(match.odds.over_2_5, match.odds.under_2_5);

    // Évaluation 1X2 Domicile
    // Note : sans source de xG indépendante du marché, computeEdge() ne peut pas
    // servir de filtre (les buts attendus sont eux-mêmes dérivés des cotes,
    // donc modèle ≈ marché par construction). On sélectionne sur la probabilité
    // seule ; edgeRatio reste calculé pour l'affichage, sans être un filtre.
    const edgeHome = computeEdge(poisson.prob1X2.home, devig1X2.home);
    if (poisson.prob1X2.home >= 0.50) {
      evaluatedSelections.push({
        match,
        market: '1X2',
        selection: `Victoire ${match.homeTeam}`,
        modelProb: poisson.prob1X2.home,
        fairProb: devig1X2.home,
        odds: match.odds.home,
        edgeRatio: edgeHome.edgeRatio,
        confidence: poisson.prob1X2.home > 0.60 ? 'Élevé' : 'Moyen'
      });
    }

    // Évaluation 1X2 Extérieur
    const edgeAway = computeEdge(poisson.prob1X2.away, devig1X2.away);
    if (poisson.prob1X2.away >= 0.50) {
      evaluatedSelections.push({
        match,
        market: '1X2',
        selection: `Victoire ${match.awayTeam}`,
        modelProb: poisson.prob1X2.away,
        fairProb: devig1X2.away,
        odds: match.odds.away,
        edgeRatio: edgeAway.edgeRatio,
        confidence: poisson.prob1X2.away > 0.60 ? 'Élevé' : 'Moyen'
      });
    }

    // Évaluation Over 2.5
    const edgeOver = computeEdge(poisson.probOU25.over, devigOU.yes);
    if (poisson.probOU25.over >= 0.55) {
      evaluatedSelections.push({
        match,
        market: 'OU_2_5',
        selection: 'Plus de 2,5 buts',
        modelProb: poisson.probOU25.over,
        fairProb: devigOU.yes,
        odds: match.odds.over_2_5,
        edgeRatio: edgeOver.edgeRatio,
        confidence: poisson.probOU25.over > 0.65 ? 'Élevé' : 'Moyen'
      });
    }

    // Évaluation BTTS (avec malus de calibration §4.1)
    const edgeBTTS = computeEdge(poisson.probBTTS.yes, devigBTTS.yes);
    if (poisson.probBTTS.yes >= 0.58) {
      evaluatedSelections.push({
        match,
        market: 'BTTS',
        selection: 'Les deux équipes marquent (Oui)',
        modelProb: poisson.probBTTS.yes,
        fairProb: devigBTTS.yes,
        odds: match.odds.btts_yes,
        edgeRatio: edgeBTTS.edgeRatio,
        confidence: 'Faible' // Règle §4.1 : BTTS toujours dégradé en faible
      });
    }
  }

  // 2. Création des propositions SOLO
  for (const sel of evaluatedSelections) {
    const leg: BetLeg = {
      id: `leg-solo-${sel.match.id}`,
      match: `${sel.match.homeTeam} - ${sel.match.awayTeam}`,
      kickoff_utc: sel.match.kickoff_utc,
      league: sel.match.leagueName,
      market: sel.market,
      selection: sel.selection,
      odds: sel.odds,
      estimated_prob: sel.modelProb,
      is_void: false,
      result: 'pending'
    };

    const candidateBet: Bet = {
      id: `solo-${sel.match.id}`,
      version: 1,
      date: sel.match.kickoff_utc.split('T')[0],
      creneau_utc: sel.match.kickoff_utc,
      creneau_display: sel.match.creneau_display,
      league: sel.match.leagueName,
      legs: [leg],
      odds: sel.odds,
      stake: null,
      excluded_from_pnl: true,
      status: 'proposed',
      played: false,
      confiance: Math.round(sel.modelProb * 100),
      confidence_level: sel.confidence,
      analysis: sel.edgeRatio > 1.05
        ? `Edge estimé +${((sel.edgeRatio - 1) * 100).toFixed(1)}%. Proba modèle ${(sel.modelProb * 100).toFixed(1)}%.`
        : `Proba modèle ${(sel.modelProb * 100).toFixed(1)}% (alignée avec le marché, aucune divergence détectée sans stats indépendantes des cotes).`,
      validation_flags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const validation = validateBet(candidateBet, existingBets);

    proposals.push({
      id: candidateBet.id,
      type: 'solo',
      title: `Solo : ${sel.selection}`,
      legs: [leg],
      totalOdds: sel.odds,
      confiance: candidateBet.confiance || 50,
      confidenceLevel: sel.confidence,
      analysis: candidateBet.analysis,
      validation: {
        valid: validation.valid,
        blockers: validation.blockers,
        warnings: validation.warnings
      }
    });
  }

  // 3. Création d'un COMBINÉ de volume si au moins 2 jambes solides (sans 1X2 < 50%)
  const strongLegs = evaluatedSelections.filter(s => s.modelProb >= 0.55 && s.market !== 'BTTS');

  if (strongLegs.length >= 2) {
    const comboLegs: BetLeg[] = strongLegs.slice(0, 3).map((s, idx) => ({
      id: `combo-leg-${idx}`,
      match: `${s.match.homeTeam} - ${s.match.awayTeam}`,
      kickoff_utc: s.match.kickoff_utc,
      league: s.match.leagueName,
      market: s.market,
      selection: s.selection,
      odds: s.odds,
      estimated_prob: s.modelProb,
      is_void: false,
      result: 'pending'
    }));

    const comboOdds = comboLegs.reduce((acc, l) => acc * (l.odds || 1), 1);

    const comboCandidate: Bet = {
      id: `combo-daily-${new Date().toISOString().split('T')[0]}`,
      version: 1,
      date: strongLegs[0].match.kickoff_utc.split('T')[0],
      creneau_utc: strongLegs[0].match.kickoff_utc,
      creneau_display: strongLegs[0].match.creneau_display,
      league: 'Multi-championnats',
      legs: comboLegs,
      odds: comboOdds,
      stake: null,
      excluded_from_pnl: true,
      status: 'proposed',
      played: false,
      confiance: 65,
      confidence_level: 'Moyen',
      analysis: 'Combiné de volume construit sur des jambes à probabilité >= 55%.',
      validation_flags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const validation = validateBet(comboCandidate, existingBets);

    proposals.push({
      id: comboCandidate.id,
      type: 'combo',
      title: `Combiné ${comboLegs.length} jambes`,
      legs: comboLegs,
      totalOdds: comboOdds,
      confiance: comboCandidate.confiance || 50,
      confidenceLevel: 'Moyen',
      analysis: comboCandidate.analysis,
      validation: {
        valid: validation.valid,
        blockers: validation.blockers,
        warnings: validation.warnings
      }
    });
  }

  return proposals;
}
