// Moteur du Workflow Matinal & Planning du Jour (§5.1, §5.2, §5.3)
// Browse les 5 championnats, découpe en créneaux, génère et valide les propositions

import { Bet, BetLeg, Market } from '../types';
import { computeDixonColesModel, computePoissonModel, poissonProb, devigOdds1X2Shin, devigOddsTwoWayShin, computeEdge, estimateExpectedGoalsFromMarket } from './poisson';
import { getHistoricalPriors } from './footballDataCoUk';
import { validateBet } from './validator';
import { DailyScheduleSlot, ScheduledMatchDetail } from '../types/database';
import { getDailyPlan } from './scheduler';
import { getAllBets, saveBet } from '../database/storage';

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

/**
 * Convertit les matchs planifiés (scan matinal) en entrées exploitables par
 * le moteur de propositions. Les buts attendus sont dérivés des cotes du
 * marché (jamais inventés) ; un match sans cotes 1X2 + Over/Under
 * exploitables est exclu plutôt que de produire une "proposition" basée sur
 * des données fictives.
 *
 * Partagé entre l'écran Planning (affichage) et la tâche de fond (qui doit
 * générer et persister les mêmes propositions sans dépendre de l'écran) —
 * une seule implémentation, jamais deux qui pourraient diverger.
 */
export function buildScheduledMatches(slots: DailyScheduleSlot[]): { matches: ScheduledMatch[]; skippedNoOdds: number } {
  const matches: ScheduledMatch[] = [];
  let skippedNoOdds = 0;

  for (const slot of slots) {
    for (const m of slot.matches as ScheduledMatchDetail[]) {
      const estimated = estimateExpectedGoalsFromMarket(m.odds);
      if (!estimated) {
        skippedNoOdds++;
        continue;
      }
      matches.push({ ...m, expectedHomeGoals: estimated.home, expectedAwayGoals: estimated.away });
    }
  }

  return { matches, skippedNoOdds };
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
  /** 'market' = cote réelle (TheOddsAPI) ; 'estimated' = cote juste théorique (1/proba), aucun marché publié pour ce type de sélection. */
  oddsSource: 'market' | 'estimated';
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
 * Parmi toutes les lignes X.5 au-dessus de la moyenne, la PLUS HAUTE dont la
 * probabilité de dépassement reste >= threshold (demande explicite : viser
 * le meilleur rapport gain/risque plutôt qu'une ligne "évidente" proche de la
 * moyenne — ex. 9 corners attendus, proposer "plus de 7" ou "plus de 8.5"
 * plutôt que "plus de 4" qui n'a aucune valeur). La probabilité décroît
 * strictement quand la ligne monte, donc un simple parcours croissant qui
 * s'arrête au premier échec suffit à trouver le maximum.
 */
function pickHighestConfidentOverLine(lambda: number, threshold: number): { line: number; prob: number } | null {
  // La ligne proche de la moyenne est déjà souvent SOUS le seuil (une
  // médiane de Poisson tourne autour de 50%, parfois moins) : partir de là
  // et ne monter ferait rater la plupart des cas. On part donc plus bas
  // (où la probabilité est confortablement au-dessus du seuil) et on monte
  // tant que ça tient, en gardant la dernière ligne qui passe encore.
  let best: { line: number; prob: number } | null = null;
  const startLine = Math.max(0.5, lineNearMean(lambda) - 5);
  for (let i = 0; i < 15; i++) {
    const line = startLine + i;
    const prob = poissonOverProb(lambda, line);
    if (prob < threshold) break;
    best = { line, prob };
  }
  return best;
}

/**
 * Ajoute une sélection Over ET Under pour un marché sans cote de marché
 * disponible (corners/cartons/fautes — estimés depuis les moyennes de saison
 * Football-Data.co.uk, item A). Sans cote publiée, une jambe serait bloquée
 * par BLOCK_COTE_MANQUANTE : on utilise donc la cote "juste" théorique
 * (1/probabilité) en interne pour la validation, mais marquée
 * oddsSource:'estimated' pour ne jamais être affichée comme une cote de
 * bookmaker côté écran (l'utilisateur la complète lui-même au placement).
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

  const bestOver = pickHighestConfidentOverLine(lambda, threshold);
  if (bestOver) {
    target.push({
      match, market, selection: `Plus de ${bestOver.line} ${unitLabel}`,
      modelProb: bestOver.prob, fairProb: bestOver.prob, odds: Number((1 / bestOver.prob).toFixed(2)),
      edgeRatio: 1, confidence: 'Faible', oddsSource: 'estimated',
    });
  }

  // Under : ligne proche de la moyenne (l'inverse d'une ligne haute serait
  // trivialement sûr et sans intérêt côté under).
  const line = lineNearMean(lambda);
  const underProb = 1 - poissonOverProb(lambda, line);
  if (underProb >= threshold) {
    target.push({
      match, market, selection: `Moins de ${line} ${unitLabel}`,
      modelProb: underProb, fairProb: underProb, odds: Number((1 / underProb).toFixed(2)),
      edgeRatio: 1, confidence: 'Faible', oddsSource: 'estimated',
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
        confidence: poisson.prob1X2.home > 0.60 ? 'Élevé' : 'Moyen',
        oddsSource: 'market'
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
        confidence: poisson.prob1X2.away > 0.60 ? 'Élevé' : 'Moyen',
        oddsSource: 'market'
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
        confidence: poisson.probOU25.over > 0.65 ? 'Élevé' : 'Moyen',
        oddsSource: 'market'
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
        confidence: 'Faible', // Règle §4.1 : BTTS toujours dégradé en faible
        oddsSource: 'market'
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
        edgeRatio: edgeUnder.edgeRatio, confidence: poisson.probOU25.under > 0.65 ? 'Élevé' : 'Moyen',
        oddsSource: 'market'
      });
    }

    const edgeBTTSNon = computeEdge(poisson.probBTTS.no, devigBTTS.no);
    if (bttsOddsAvailable && poisson.probBTTS.no >= 0.58) {
      evaluatedSelections.push({
        match, market: 'BTTS', selection: 'Les deux équipes marquent (Non)',
        modelProb: poisson.probBTTS.no, fairProb: devigBTTS.no, odds: match.odds.btts_no,
        edgeRatio: edgeBTTSNon.edgeRatio, confidence: 'Faible',
        oddsSource: 'market'
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
        edgeRatio: 1, confidence: 'Faible', oddsSource: 'estimated'
      });
    }
    if (probUnderHT05 >= 0.55) {
      evaluatedSelections.push({
        match, market: '1ere_mi_temps', selection: '0-0 à la pause (moins de 0,5 but)',
        modelProb: probUnderHT05, fairProb: probUnderHT05, odds: Number((1 / probUnderHT05).toFixed(2)),
        edgeRatio: 1, confidence: 'Faible', oddsSource: 'estimated'
      });
    }

    // Corners / cartons / fautes : aucune cote de marché gratuite disponible
    // pour ces marchés, donc estimation depuis les moyennes de saison réelles
    // (Football-Data.co.uk, item A) plutôt que de les ignorer complètement.
    // Silencieux si le championnat n'est pas couvert (coupes nationales) ou
    // si une équipe n'est pas reconnue — jamais une valeur inventée.
    // Un échec ici (réseau, timeout) ne doit jamais faire échouer la
    // génération de TOUTES les propositions du jour — juste priver ce match
    // des marchés corners/cartons/fautes.
    try {
      const priors = await getHistoricalPriors(match.leagueId, match.homeTeam, match.awayTeam);
      if (priors) {
        pushEstimatedOverUnder(evaluatedSelections, match, 'corners', priors.home.cornersFor + priors.away.cornersFor, 'corners', 0.55);
        pushEstimatedOverUnder(evaluatedSelections, match, 'cards', priors.home.cardsFor + priors.away.cardsFor, 'cartons', 0.55);
        pushEstimatedOverUnder(evaluatedSelections, match, 'fouls', priors.home.foulsFor + priors.away.foulsFor, 'fautes', 0.55);
      }
    } catch (error: any) {
      console.warn(`[Planning] Priors historiques indisponibles pour ${match.homeTeam} - ${match.awayTeam}:`, error.message);
    }
  }

  // 2. Création des propositions SOLO — jamais dans un créneau de 3 matchs ou
  // plus (demande explicite) : ces créneaux ont assez de matière pour ne
  // proposer QUE des combinés, plus intéressants que des solos isolés.
  const matchCountBySlot = new Map<string, number>();
  for (const m of matches) {
    matchCountBySlot.set(m.creneau_display, (matchCountBySlot.get(m.creneau_display) ?? 0) + 1);
  }

  for (const sel of evaluatedSelections) {
    if ((matchCountBySlot.get(sel.match.creneau_display) ?? 0) >= 3) continue;

    const leg: BetLeg = {
      id: `leg-solo-${sel.match.id}`,
      match: `${sel.match.homeTeam} - ${sel.match.awayTeam}`,
      matchId: sel.match.id,
      leagueId: sel.match.leagueId,
      kickoff_utc: sel.match.kickoff_utc,
      league: sel.match.leagueName,
      market: sel.market,
      selection: sel.selection,
      odds: sel.odds,
      oddsSource: sel.oddsSource,
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
      title: `Solo : ${sel.match.homeTeam} - ${sel.match.awayTeam} — ${sel.selection}`,
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
        leagueId: s.match.leagueId,
        kickoff_utc: s.match.kickoff_utc,
        league: s.match.leagueName,
        market: s.market,
        selection: s.selection,
        odds: s.odds,
        oddsSource: s.oddsSource,
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

    if (matchesInSlot >= 3) {
      // Regroupe les sélections qualifiées par match, triées par probabilité
      // décroissante : la meilleure sert de base, les suivantes de variantes
      // (marché différent sur ce même match) pour diversifier les combinés
      // bâtis sur un même trio de matchs.
      const byMatch = new Map<string, EvaluatedSelection[]>();
      for (const s of slotSelections) {
        const arr = byMatch.get(s.match.id) ?? [];
        arr.push(s);
        byMatch.set(s.match.id, arr);
      }
      for (const arr of byMatch.values()) arr.sort((a, b) => b.modelProb - a.modelProb);
      const matchIds = Array.from(byMatch.keys());

      // Chaque combiné porte TOUJOURS sur 3 matchs distincts (jamais plus,
      // jamais moins, demande explicite) — la diversité vient du NOMBRE de
      // combinés générés (qui grandit avec la taille du créneau), pas de
      // leur taille.
      const matchTriples: string[][] = [];
      for (let i = 0; i < matchIds.length; i++) {
        for (let j = i + 1; j < matchIds.length; j++) {
          for (let k = j + 1; k < matchIds.length; k++) {
            matchTriples.push([matchIds[i], matchIds[j], matchIds[k]]);
          }
        }
      }

      interface ComboCandidate { legs: EvaluatedSelection[]; prob: number; }
      const candidates: ComboCandidate[] = [];
      const seenTripleSignatures = new Set<string>();
      const addCandidate = (legs: EvaluatedSelection[]): void => {
        const signature = legs.map((l) => `${l.match.id}:${l.market}:${l.selection}`).sort().join('|');
        if (seenTripleSignatures.has(signature)) return;
        seenTripleSignatures.add(signature);
        candidates.push({ legs, prob: legs.reduce((acc, l) => acc * l.modelProb, 1) });
      };

      for (const triple of matchTriples) {
        const base = triple.map((id) => byMatch.get(id)![0]);
        addCandidate(base);

        // Variantes : sur chaque position du trio, essaie les sélections
        // suivantes (marché différent) de CE match, les deux autres restant
        // sur leur meilleure — explore toutes les combinaisons de marchés
        // raisonnables sans exploser combinatoirement (2 alternatives max
        // par position).
        for (let pos = 0; pos < 3; pos++) {
          const alts = byMatch.get(triple[pos])!;
          for (let altIdx = 1; altIdx < Math.min(alts.length, 3); altIdx++) {
            const legs = [...base];
            legs[pos] = alts[altIdx];
            addCandidate(legs);
          }
        }
      }

      // Classés par probabilité décroissante (demande explicite) : le
      // premier est le plus sûr, chaque suivant un peu moins.
      candidates.sort((a, b) => b.prob - a.prob);

      // Nombre de combinés visé : grandit avec le nombre de matchs du
      // créneau (ex. 6 matchs -> 8 combinés), jamais moins de 4.
      const targetCombos = Math.max(4, Math.min(matchesInSlot + 2, 8));
      const mainCount = targetCombos - 1; // le dernier est le combiné libre/risqué ci-dessous

      let rank = 0;
      for (const cand of candidates) {
        if (rank >= mainCount) break;
        const inBand = cand.prob >= 0.60 && cand.prob <= 0.68;
        rank++;
        emitCombo(
          `Combiné #${rank}`,
          cand.legs,
          inBand ? 'Moyen' : cand.prob > 0.68 ? 'Élevé' : 'Faible',
          `Probabilité combinée ${(cand.prob * 100).toFixed(1)}%${inBand ? ' (dans la fourchette 60-68% visée)' : ''}.`
        );
      }

      // Dernier combiné : libre, volontairement le plus risqué possible
      // parmi les jambes encore qualifiées (chacune a déjà passé son seuil
      // de probabilité minimal à l'évaluation individuelle du match —
      // risqué, mais jamais fabriqué), hors fourchette 60-68% par
      // construction (demande explicite : "je te laisse quartier libre").
      const riskyByMatch = new Map<string, EvaluatedSelection>();
      for (const s of [...slotSelections].sort((a, b) => a.modelProb - b.modelProb)) {
        if (riskyByMatch.size >= 3) break;
        if (!riskyByMatch.has(s.match.id)) riskyByMatch.set(s.match.id, s);
      }
      if (riskyByMatch.size >= 2) {
        const riskyLegs = Array.from(riskyByMatch.values());
        const riskyProb = riskyLegs.reduce((acc, l) => acc * l.modelProb, 1);
        emitCombo(
          `Combiné #${rank + 1} 🔥 Risqué (libre)`,
          riskyLegs,
          'Faible',
          `Probabilité combinée ${(riskyProb * 100).toFixed(1)}% : combiné volontairement risqué (hors fourchette 60-68%), construit sur les jambes les moins probables encore qualifiées du créneau pour maximiser le gain potentiel sans jambe fabriquée.`
        );
      }
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

/**
 * Génère et persiste toutes les propositions du jour (solos + combinés),
 * qu'elles soient placées ou non — sans ça, une proposition disparaît dès
 * que l'écran Planning n'est plus ouvert, et le bilan du soir ne peut
 * jamais dire "X propositions émises, Y auraient gagné" (demande
 * explicite : le rapport porte sur TOUT ce qui a été proposé, pas
 * seulement les vrais paris placés). Appelé depuis la tâche de fond, pas
 * seulement quand l'utilisateur ouvre l'écran.
 *
 * saveBet fait un upsert par id (déterministe : solo-<matchId>,
 * combo-<créneau>-<rang>-<date>) — rappeler ceci plusieurs fois par jour ne
 * duplique rien, juste rafraîchit la dernière version avant règlement.
 */
export async function persistTodaysProposals(): Promise<number> {
  const plan = await getDailyPlan();
  if (!plan) return 0;

  const { matches } = buildScheduledMatches(plan.slots);
  if (matches.length === 0) return 0;

  const existingBets = await getAllBets();
  const proposals = await generateDailyProposals(matches, existingBets);

  // Ne jamais écraser un pari qui a avancé au-delà du simple stade de
  // proposition (placé réellement, réglé, void...) : la régénération du
  // jour ne fait que rafraîchir les propositions encore à l'état "proposed".
  const advancedIds = new Set(
    existingBets.filter((b) => b.status !== 'proposed').map((b) => b.id)
  );

  for (const proposal of proposals) {
    if (advancedIds.has(proposal.sourceBet.id)) continue;
    await saveBet(proposal.sourceBet);
  }

  return proposals.length;
}
