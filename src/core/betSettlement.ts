// Règlement des VRAIS paris placés (bouton "Placer ce pari", Planning du
// Jour) — décide won/lost à partir du score final réel (football-data.org,
// structuré, gratuit), jamais en demandant à une IA de "se souvenir" d'un
// résultat via une recherche texte : une erreur ici fausserait le vrai
// Bilan P&L de l'utilisateur, pas juste une mesure de calibration interne.
//
// Un pari (solo ou combiné) est gagné seulement si TOUTES ses jambes sont
// gagnées ; perdu dès qu'UNE jambe est perdue (peu importe que les autres
// soient encore indéterminées) ; sinon il reste "pending" et sera retenté
// au prochain tour plutôt que d'être deviné.

import * as SecureStore from 'expo-secure-store';
import { Bet, BetLeg } from '../types';
import { getAllBets, saveBet } from '../database/storage';
import { getMatchStats } from './footballDataCoUk';
import {
  FinalResult,
  fetchFinalResult,
  settleWinnerSelection,
  settleBTTS,
  settleOverUnder,
  settleOverUnderFreeLine,
} from './matchSettlement';

const FOOTBALL_DATA_KEY = 'app-adlane.football-data-api-key';

// 90 min + mi-temps + arrêts de jeu : marge large avant d'interroger le résultat.
const MATCH_DURATION_BUFFER_MS = 150 * 60 * 1000;

interface MatchStatsCache {
  corners: number;
  cards: number;
  fouls: number;
}

/** true = gagnée, false = perdue, null = pas encore déterminable (retenté plus tard). */
function settleBetLeg(
  leg: BetLeg,
  homeTeam: string,
  awayTeam: string,
  result: FinalResult,
  matchStats: MatchStatsCache | null
): boolean | null {
  const totalGoals = result.goalsHome + result.goalsAway;
  switch (leg.market) {
    case '1X2':
      return settleWinnerSelection(leg.selection, homeTeam, awayTeam, result.goalsHome, result.goalsAway);
    case 'BTTS':
      return settleBTTS(leg.selection, result.goalsHome, result.goalsAway);
    case 'OU_2_5':
      return settleOverUnder(leg.selection, totalGoals, 2.5);
    case '1ere_mi_temps':
      return settleOverUnder(leg.selection, result.htHome + result.htAway, 0.5);
    case 'corners':
      return matchStats ? settleOverUnderFreeLine(leg.selection, matchStats.corners) : null;
    case 'cards':
      return matchStats ? settleOverUnderFreeLine(leg.selection, matchStats.cards) : null;
    case 'fouls':
      return matchStats ? settleOverUnderFreeLine(leg.selection, matchStats.fouls) : null;
    default:
      return null; // shots_on_target, saves : pas de source structurée gratuite pour ces marchés
  }
}

function extractTeams(matchLabel: string): { homeTeam: string; awayTeam: string } | null {
  const parts = matchLabel.split(' - ');
  if (parts.length !== 2) return null;
  return { homeTeam: parts[0].trim(), awayTeam: parts[1].trim() };
}

interface BetOutcome {
  anyLost: boolean;
  allWon: boolean;
  anyUnresolved: boolean;
}

/**
 * Détermine l'issue d'un pari (placé ou non) à partir du score final réel de
 * chacune de ses jambes. Partagé entre le règlement des vrais paris placés
 * (settlePlacedBets, avec payout/P&L) et celui des simples propositions
 * (settleProposedBets, sans aucun payout — juste le statut won/lost pour le
 * bilan) : la logique de détermination de l'issue est strictement la même
 * dans les deux cas, seul ce qu'on en fait diffère.
 */
async function computeBetOutcome(
  bet: Bet,
  apiKey: string,
  resultCache: Map<string, FinalResult | null>,
  statsCache: Map<string, MatchStatsCache | null>
): Promise<BetOutcome> {
  let anyLost = false;
  let allWon = true;
  let anyUnresolved = false;

  for (const leg of bet.legs) {
    const teams = extractTeams(leg.match);
    if (!teams || !leg.matchId) { anyUnresolved = true; allWon = false; continue; }

    const numericId = leg.matchId.replace(/^m-/, '');
    if (!resultCache.has(numericId)) {
      resultCache.set(numericId, await fetchFinalResult(apiKey, numericId));
    }
    const result = resultCache.get(numericId) ?? null;
    if (!result) { anyUnresolved = true; allWon = false; continue; }

    let matchStats: MatchStatsCache | null = null;
    if (['corners', 'cards', 'fouls'].includes(leg.market) && leg.leagueId) {
      if (!statsCache.has(leg.matchId)) {
        statsCache.set(
          leg.matchId,
          await getMatchStats(leg.leagueId, teams.homeTeam, teams.awayTeam).catch(() => null)
        );
      }
      matchStats = statsCache.get(leg.matchId) ?? null;
    }

    const outcome = settleBetLeg(leg, teams.homeTeam, teams.awayTeam, result, matchStats);
    if (outcome === false) { anyLost = true; allWon = false; }
    else if (outcome === null) { anyUnresolved = true; allWon = false; }
  }

  return { anyLost, allWon, anyUnresolved };
}

/**
 * Règle les vrais paris placés (played:true, status:pending) dont le match
 * est terminé depuis assez longtemps. Idempotent (status devient won/lost,
 * jamais retraité) et sans risque en cas d'échec réseau : un pari non
 * réglable est simplement retenté au tour suivant.
 */
export async function settlePlacedBets(): Promise<number> {
  const allBets = await getAllBets();
  const pending = allBets.filter(
    (b) => b.played && b.status === 'pending' && b.legs.every((l) => l.matchId)
  );
  if (pending.length === 0) return 0;

  const apiKey = await SecureStore.getItemAsync(FOOTBALL_DATA_KEY);
  if (!apiKey) return 0;

  // Un même match peut apparaître dans plusieurs paris (plusieurs jambes) :
  // un seul appel réseau par match, jamais un par pari.
  const resultCache = new Map<string, FinalResult | null>();
  const statsCache = new Map<string, MatchStatsCache | null>();

  let settledCount = 0;

  for (const bet of pending) {
    // Ne tente de régler que si TOUS les matchs du pari sont bien terminés
    // depuis assez longtemps — sinon on attend le tour suivant plutôt que de
    // ne régler qu'une partie des jambes.
    const allMatchesOld = bet.legs.every(
      (leg) => Date.now() - new Date(leg.kickoff_utc).getTime() > MATCH_DURATION_BUFFER_MS
    );
    if (!allMatchesOld) continue;

    const { anyLost, allWon, anyUnresolved } = await computeBetOutcome(bet, apiKey, resultCache, statsCache);

    if (anyLost) {
      const updated: Bet = { ...bet, status: 'lost', payout: 0, net_pnl: -(bet.stake ?? 0), updatedAt: new Date().toISOString() };
      await saveBet(updated);
      settledCount += 1;
    } else if (allWon && !anyUnresolved) {
      const payout = (bet.stake ?? 0) * (bet.odds ?? 0);
      const updated: Bet = { ...bet, status: 'won', payout, net_pnl: payout - (bet.stake ?? 0), updatedAt: new Date().toISOString() };
      await saveBet(updated);
      settledCount += 1;
    }
    // sinon : au moins une jambe indéterminée et aucune perdue -> on laisse
    // "pending", retenté au prochain tour (jamais un statut deviné).
  }

  return settledCount;
}

/**
 * Règle TOUTES les propositions émises un jour donné (status:'proposed'),
 * placées ou non — pour le bilan "X propositions émises, Y auraient
 * gagné" (demande explicite : le rapport quotidien porte sur tout ce qui a
 * été proposé, pas seulement les vrais paris placés). Ne touche jamais
 * payout/net_pnl (ces propositions restent excluded_from_pnl) : seul le
 * statut change, pour compter won/lost dans le bilan.
 */
export async function settleProposedBets(day: string): Promise<number> {
  const allBets = await getAllBets();
  const dayProposals = allBets.filter(
    (b) => b.date === day && b.status === 'proposed' && b.legs.every((l) => l.matchId)
  );
  if (dayProposals.length === 0) return 0;

  const apiKey = await SecureStore.getItemAsync(FOOTBALL_DATA_KEY);
  if (!apiKey) return 0;

  const resultCache = new Map<string, FinalResult | null>();
  const statsCache = new Map<string, MatchStatsCache | null>();
  let settledCount = 0;

  for (const bet of dayProposals) {
    const allMatchesOld = bet.legs.every(
      (leg) => Date.now() - new Date(leg.kickoff_utc).getTime() > MATCH_DURATION_BUFFER_MS
    );
    if (!allMatchesOld) continue;

    const { anyLost, allWon, anyUnresolved } = await computeBetOutcome(bet, apiKey, resultCache, statsCache);

    if (anyLost) {
      await saveBet({ ...bet, status: 'lost', updatedAt: new Date().toISOString() });
      settledCount += 1;
    } else if (allWon && !anyUnresolved) {
      await saveBet({ ...bet, status: 'won', updatedAt: new Date().toISOString() });
      settledCount += 1;
    }
  }

  return settledCount;
}
