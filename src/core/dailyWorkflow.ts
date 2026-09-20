// Moteur du Workflow Matinal & Planning du Jour (§5.1, §5.2, §5.3)
// Browse les 5 championnats, découpe en créneaux, génère et valide les propositions

import { Bet, BetLeg, Market } from '../types';
import { computeDixonColesModel, computePoissonModel, poissonProb, devigOdds1X2Shin, devigOddsTwoWayShin, computeEdge } from './poisson';
import { getHistoricalPriors } from './footballDataCoUk';
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
  /** Le pari sous-jacent complet, prêt à être persisté (stake à renseigner) si l'utilisateur choisit de le placer réellement. */
  sourceBet: Bet;
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

interface EvaluatedSelection {
  match: ScheduledMatch;
  market: Market;
  selection: string;
  modelProb: number;
  fairProb: number;
  odds: number;
  edgeRatio: number;
  confidence: 'Faible' | 'Moyen' | 'Élevé';
}

/** P(X > line) pour une variable de Poisson de paramètre lambda (line est toujours un X.5, jamais d'ambiguïté de push). */
function poissonOverProb(lambda: number, line: number): number {
  let cdf = 0;
  for (let k = 0; k <= Math.floor(line); k++) cdf += poissonProb(lambda, k);
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** Ligne X.5 la plus proche (juste en dessous) de la moyenne estimée. */
function lineNearMean(lambda: number): number {
  return Math.max(0.5, Math.floor(lambda) - 0.5);
}

/**
 * Ajoute une sélection Over ET Under pour un marché sans cote de marché
 * disponible (corners/cartons/fautes — estimés depuis les moyennes de saison
 * Football-Data.co.uk, item A). Sans cote publiée, une jambe serait bloquée
 * par BLOCK_COTE_MANQUANTE : on utilise donc la cote "juste" théorique
 * (1/probabilité), explicitement signalée comme telle dans l'analyse plutôt
 * que présentée comme une cote de bookmaker.
 */
function pushEstimatedOverUnder(
  target: EvaluatedSelection[],
  match: ScheduledMatch,
  market: Market,
  lambda: number,
  unitLabel: string,
  threshold: number
): void {
  if (!(lambda > 0)) return;
  const line = lineNearMean(lambda);
  const overProb = poissonOverProb(lambda, line);
  const underProb = 1 - overProb;

  if (overProb >= threshold) {
    target.push({
      match, market, selection: `Plus de ${line} ${unitLabel}`,
      modelProb: overProb, fairProb: overProb, odds: Number((1 / overProb).toFixed(2)),
      edgeRatio: 1, confidence: 'Faible',
    });
  }
  if (underProb >= threshold) {
    target.push({
      match, market, selection: `Moins de ${line} ${unitLabel}`,
      modelProb: underProb, fairProb: underProb, odds: Number((1 / underProb).toFixed(2)),
      edgeRatio: 1, confidence: 'Faible',
    });
  }
}

/**
 * Génère des propositions de paris (Solos et Combinés) conformes aux règles
 */
export async function generateDailyProposals(
  matches: ScheduledMatch[],
  existingBets: Bet[] = []
): Promise<ProposedSlip[]> {
  const proposals: ProposedSlip[] = [];

  // 1. Analyse probabiliste individuelle de chaque match
  const evaluatedSelections: EvaluatedSelection[] = [];

  for (const match of matches) {
    // Dixon-Coles (item D) plutôt que le Poisson indépendant simple : corrige
    // la légère sur/sous-estimation des scores bas (0-0, 1-0, 0-1, 1-1), qui
    // touche directement les seuils utilisés ci-dessous (BTTS, Over 1.5/2.5).
    // Dévigage de Shin (item F) plutôt que le dévigage proportionnel : modélise
    // explicitement le biais favori-outsider du bookmaker au lieu de répartir
    // la marge au prorata, donc une estimation "juste" plus fidèle.
    const poisson = computeDixonColesModel(match.expectedHomeGoals, match.expectedAwayGoals);
    const devig1X2 = devigOdds1X2Shin(match.odds.home, match.odds.draw, match.odds.away);
    const devigOU = devigOddsTwoWayShin(match.odds.over_2_5, match.odds.under_2_5);

    // TheOddsAPI ne publie pas toujours un marché BTTS pour chaque match
    // (contrairement à h2h/totals) : sans cote réelle, une jambe BTTS
    // recevait avant une cote factice à 0, affichée comme "non définie".
    // On ne dévige/propose BTTS que si les deux cotes sont réellement là.
    const bttsOddsAvailable = match.odds.btts_yes > 1 && match.odds.btts_no > 1;
    const devigBTTS = bttsOddsAvailable
      ? devigOddsTwoWayShin(match.odds.btts_yes, match.odds.btts_no)
      : { yes: 0, no: 0, z: 0, margin: 0 };

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
    if (bttsOddsAvailable && poisson.probBTTS.yes >= 0.58) {
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

    // Évaluation Under 2.5 et BTTS Non : les opposés existaient déjà côté
    // marché (dévigés ci-dessus) mais n'étaient jamais proposés, réduisant
    // artificiellement la diversité de marchés disponible pour les combinés.
    const edgeUnder = computeEdge(poisson.probOU25.under, devigOU.no);
    if (poisson.probOU25.under >= 0.55) {
      evaluatedSelections.push({
        match, market: 'OU_2_5', selection: 'Moins de 2,5 buts',
        modelProb: poisson.probOU25.under, fairProb: devigOU.no, odds: match.odds.under_2_5,
        edgeRatio: edgeUnder.edgeRatio, confidence: poisson.probOU25.under > 0.65 ? 'Élevé' : 'Moyen'
      });
    }

    const edgeBTTSNon = computeEdge(poisson.probBTTS.no, devigBTTS.no);
    if (bttsOddsAvailable && poisson.probBTTS.no >= 0.58) {
      evaluatedSelections.push({
        match, market: 'BTTS', selection: 'Les deux équipes marquent (Non)',
        modelProb: poisson.probBTTS.no, fairProb: devigBTTS.no, odds: match.odds.btts_no,
        edgeRatio: edgeBTTSNon.edgeRatio, confidence: 'Faible'
      });
    }

    // Buts avant la mi-temps : approximation par les buts attendus divisés
    // par deux (aucune cote de mi-temps disponible ici pour dévigage réel —
    // signalé "Faible" en conséquence, comme les autres marchés estimés).
    const htModel = computePoissonModel(match.expectedHomeGoals / 2, match.expectedAwayGoals / 2);
    const probOverHT05 = 1 - htModel.scoreMatrix[0][0];
    const probUnderHT05 = htModel.scoreMatrix[0][0];
    if (probOverHT05 >= 0.55) {
      evaluatedSelections.push({
        match, market: '1ere_mi_temps', selection: 'Plus de 0,5 but avant la pause',
        modelProb: probOverHT05, fairProb: probOverHT05, odds: Number((1 / probOverHT05).toFixed(2)),
        edgeRatio: 1, confidence: 'Faible'
      });
    }
    if (probUnderHT05 >= 0.55) {
      evaluatedSelections.push({
        match, market: '1ere_mi_temps', selection: '0-0 à la pause (moins de 0,5 but)',
        modelProb: probUnderHT05, fairProb: probUnderHT05, odds: Number((1 / probUnderHT05).toFixed(2)),
        edgeRatio: 1, confidence: 'Faible'
      });
    }

    // Corners / cartons / fautes : aucune cote de marché gratuite disponible
    // pour ces marchés, donc estimation depuis les moyennes de saison réelles
    // (Football-Data.co.uk, item A) plutôt que de les ignorer complètement.
    // Silencieux si le championnat n'est pas couvert (coupes nationales) ou
    // si une équipe n'est pas reconnue — jamais une valeur inventée.
    const priors = await getHistoricalPriors(match.leagueId, match.homeTeam, match.awayTeam);
    if (priors) {
      pushEstimatedOverUnder(evaluatedSelections, match, 'corners', priors.home.cornersFor + priors.away.cornersFor, 'corners', 0.55);
      pushEstimatedOverUnder(evaluatedSelections, match, 'cards', priors.home.cardsFor + priors.away.cardsFor, 'cartons', 0.55);
      pushEstimatedOverUnder(evaluatedSelections, match, 'fouls', priors.home.foulsFor + priors.away.foulsFor, 'fautes', 0.55);
    }
  }

  // 2. Création des propositions SOLO
  for (const sel of evaluatedSelections) {
    const leg: BetLeg = {
      id: `leg-solo-${sel.match.id}`,
      match: `${sel.match.homeTeam} - ${sel.match.awayTeam}`,
      matchId: sel.match.id,
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
      sourceBet: candidateBet,
      validation: {
        valid: validation.valid,
        blockers: validation.blockers,
        warnings: validation.warnings
      }
    });
  }

  // 3. Combinés PAR CRÉNEAU : les jambes ne sont JAMAIS combinées entre deux
  // heures de coup d'envoi différentes, pour que les mises à jour mi-temps de
  // tous les matchs d'un même combiné arrivent ensemble. Dès qu'un créneau
  // réunit 3 matchs ou plus, plusieurs profils de combinés bien différenciés
  // sont proposés (sécurisé -> équilibré -> thématique buts/stats -> value/
  // risqué) au lieu d'un seul combiné générique — un créneau à 6 matchs avec
  // tous les marchés dispo (BTTS, cartons, fautes, corners, 1ère mi-temps...)
  // doit produire plusieurs combinés vraiment différents, pas juste des
  // variations du même. Chaque profil n'est créé que s'il a assez de matière
  // (jamais moins de 2 jambes, jamais deux combinés identiques).
  const selectionsBySlot = new Map<string, EvaluatedSelection[]>();
  for (const sel of evaluatedSelections) {
    const key = sel.match.creneau_display;
    const group = selectionsBySlot.get(key) ?? [];
    group.push(sel);
    selectionsBySlot.set(key, group);
  }

  for (const [slotDisplay, slotSelections] of selectionsBySlot.entries()) {
    const matchesInSlot = new Set(slotSelections.map((s) => s.match.id)).size;
    if (matchesInSlot < 2) continue; // rien à combiner

    const seenSignatures = new Set<string>();

    /** Une seule jambe par match (la meilleure au sens du critère donné), triée. */
    const pickBestPerMatch = (
      candidates: EvaluatedSelection[],
      sortBy: 'modelProb' | 'edgeRatio'
    ): EvaluatedSelection[] => {
      const bestPerMatch = new Map<string, EvaluatedSelection>();
      for (const sel of candidates) {
        const existing = bestPerMatch.get(sel.match.id);
        const better = !existing || (sortBy === 'edgeRatio' ? sel.edgeRatio > existing.edgeRatio : sel.modelProb > existing.modelProb);
        if (better) bestPerMatch.set(sel.match.id, sel);
      }
      return Array.from(bestPerMatch.values()).sort((a, b) =>
        sortBy === 'edgeRatio' ? b.edgeRatio - a.edgeRatio : b.modelProb - a.modelProb
      );
    };

    /** Construit et enregistre un combiné à partir de jambes déjà choisies. Ignore les doublons (même jeu de jambes qu'un autre profil). */
    const emitCombo = (
      label: string,
      picked: EvaluatedSelection[],
      confidenceLevel: 'Faible' | 'Moyen' | 'Élevé',
      description: string
    ): void => {
      if (picked.length < 2) return;

      const signature = picked.map((s) => `${s.match.id}:${s.market}:${s.selection}`).sort().join('|');
      if (seenSignatures.has(signature)) return; // combiné identique déjà proposé sous un autre profil
      seenSignatures.add(signature);

      const comboLegs: BetLeg[] = picked.map((s, idx) => ({
        id: `combo-leg-${slotDisplay}-${label}-${idx}`,
        match: `${s.match.homeTeam} - ${s.match.awayTeam}`,
        matchId: s.match.id,
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
      const meanProb = picked.reduce((sum, s) => sum + s.modelProb, 0) / picked.length;

      const comboCandidate: Bet = {
        id: `combo-${slotDisplay.replace(/[^0-9a-z]/gi, '')}-${label.replace(/[^0-9a-z]/gi, '')}-${new Date().toISOString().split('T')[0]}`,
        version: 1,
        date: picked[0].match.kickoff_utc.split('T')[0],
        creneau_utc: picked[0].match.kickoff_utc,
        creneau_display: slotDisplay,
        league: 'Multi-championnats',
        legs: comboLegs,
        odds: comboOdds,
        stake: null,
        excluded_from_pnl: true,
        status: 'proposed',
        played: false,
        confiance: Math.round(meanProb * 100),
        confidence_level: confidenceLevel,
        analysis: description,
        validation_flags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const validation = validateBet(comboCandidate, existingBets);

      proposals.push({
        id: comboCandidate.id,
        type: 'combo',
        title: `${label} — ${slotDisplay} (${comboLegs.length} jambes, cote ${comboOdds.toFixed(2)})`,
        legs: comboLegs,
        totalOdds: comboOdds,
        confiance: comboCandidate.confiance || 50,
        confidenceLevel,
        analysis: comboCandidate.analysis,
        sourceBet: comboCandidate,
        validation: {
          valid: validation.valid,
          blockers: validation.blockers,
          warnings: validation.warnings
        }
      });
    };

    const buildCombo = (
      label: string,
      candidates: EvaluatedSelection[],
      maxLegs: number,
      confidenceLevel: 'Faible' | 'Moyen' | 'Élevé',
      description: string,
      pickBy: 'modelProb' | 'edgeRatio' = 'modelProb'
    ): void => {
      emitCombo(label, pickBestPerMatch(candidates, pickBy).slice(0, maxLegs), confidenceLevel, description);
    };

    /**
     * Combiné "value" ciblant une cote cumulée minimale (demande explicite :
     * "high risk high reward" doit vraiment l'être — au moins 6). Les jambes
     * sont ajoutées de la plus probable à la moins probable jusqu'à
     * atteindre la cible, pour maximiser les chances de réalisation à cote
     * donnée plutôt que d'empiler des jambes au hasard. Si le créneau n'a
     * pas assez de matchs/marchés qualifiés pour atteindre la cible, le
     * combiné est soit annoté honnêtement, soit pas proposé du tout s'il
     * reste trop loin du compte.
     */
    const buildValueCombo = (
      label: string,
      candidates: EvaluatedSelection[],
      minOdds: number,
      maxLegs: number
    ): void => {
      const sorted = pickBestPerMatch(candidates, 'modelProb');
      const picked: EvaluatedSelection[] = [];
      let cumulativeOdds = 1;
      for (const sel of sorted) {
        if (picked.length >= maxLegs || cumulativeOdds >= minOdds) break;
        picked.push(sel);
        cumulativeOdds *= sel.odds || 1;
      }
      if (picked.length < 2 || cumulativeOdds < 4) return; // trop loin de "value" pour être honnêtement présenté comme tel

      const reached = cumulativeOdds >= minOdds;
      emitCombo(
        label,
        picked,
        'Faible',
        reached
          ? `Cote cumulée ${cumulativeOdds.toFixed(2)} (cible >= ${minOdds} atteinte) : jambes ajoutées de la plus probable à la moins probable pour maximiser les chances de réalisation à cette cote.`
          : `Cote cumulée ${cumulativeOdds.toFixed(2)} : la cible >= ${minOdds} n'a pas pu être atteinte, ce créneau n'a pas assez de matchs/marchés qualifiés — reste le combiné le plus proche possible en gardant les jambes les plus probables.`
      );
    };

    if (matchesInSlot >= 3) {
      buildCombo(
        '🛡️ Sécurisé',
        slotSelections.filter((s) => s.modelProb >= 0.65),
        3,
        'Élevé',
        `Combiné prudent : uniquement des sélections >= 65% de probabilité modèle, peu de jambes pour limiter le risque cumulé.`
      );

      buildCombo(
        '⚖️ Équilibré',
        slotSelections.filter((s) => s.modelProb >= 0.55),
        4,
        'Moyen',
        `Combiné standard : sélections >= 55% de probabilité modèle, marchés mélangés.`
      );

      buildCombo(
        '⚽ Buts',
        slotSelections.filter((s) => s.modelProb >= 0.55 && ['BTTS', 'OU_2_5', '1ere_mi_temps'].includes(s.market)),
        4,
        'Moyen',
        `Combiné thématique buts (BTTS, Over/Under, 1ère mi-temps) : diversifie volontairement hors des résultats 1X2.`
      );

      buildCombo(
        '🚩 Discipline',
        slotSelections.filter((s) => s.modelProb >= 0.55 && ['corners', 'cards', 'fouls'].includes(s.market)),
        4,
        'Moyen',
        `Combiné thématique discipline/rythme (corners, cartons, fautes) : estimé depuis les moyennes de saison réelles, pas de cote de marché pour ces marchés.`
      );

      buildValueCombo(
        '🔥 Value / Risqué',
        slotSelections.filter((s) => s.modelProb >= 0.45),
        6,
        8
      );
    } else {
      // 2 matchs seulement : pas assez de matière pour différencier plusieurs profils.
      buildCombo(
        'Combiné',
        slotSelections.filter((s) => s.modelProb >= 0.55),
        4,
        'Moyen',
        `Combiné du créneau ${slotDisplay}, construit sur des probabilités >= 55%.`
      );
    }
  }

  return proposals;
}
