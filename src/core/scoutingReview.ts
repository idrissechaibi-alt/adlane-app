// Bilan Scouting IA vs réalité — chaque jour, après la fin des matchs.
//
// Chaque analyse Scouting (Gemini / pool gratuit / Omniroute) est enregistrée
// au moment où elle est produite (recordScoutingAnalysis, appelé depuis
// ScoutingScreen). Une fois le match terminé, reconcileScoutingAnalyses()
// relit le score final via football-data.org (déjà utilisé pour le planning,
// même clé) et règle chaque marché qu'un score final permet de trancher SANS
// ambiguïté. Corners/cartons/handicap ne sont pas objectivement réglables à
// partir du seul score, et le double chance nécessiterait un parsing de texte
// libre trop fragile pour être fiable — ces marchés restent volontairement
// non jugés plutôt que devinés.
//
// Le delta (probabilité annoncée vs résultat réel) est agrégé par marché et
// injecté dans le digest d'auto-apprentissage (autoLearn.ts) : c'est la
// boucle demandée — l'IA voit sa propre fiabilité passée avant sa prochaine
// analyse.

import * as SecureStore from 'expo-secure-store';
import { AIAnalysisOutput } from './omniroute';
import { ScoutingRecord, ScoutingRecordLeg, readScoutingRecords, writeScoutingRecords } from './learnStore';

const FOOTBALL_DATA_KEY = 'app-adlane.football-data-api-key';

// 90 min + mi-temps + arrêts de jeu : marge large plutôt que d'interroger un
// match encore en cours (dont le statut ne serait de toute façon pas FINISHED).
const MATCH_DURATION_BUFFER_MS = 150 * 60 * 1000;

/** Enregistre une analyse Scouting IA, pour confrontation ultérieure au résultat réel. */
export function recordScoutingAnalysis(
  match: { id: string; homeTeam: string; awayTeam: string; leagueName: string; kickoff_utc: string },
  result: AIAnalysisOutput,
  engine: string
): void {
  const records = readScoutingRecords();
  records.push({
    id: match.id,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    league: match.leagueName,
    kickoff_utc: match.kickoff_utc,
    analyzedAt: new Date().toISOString(),
    engine,
    legs: result.markets.map((m) => ({
      market: m.market,
      selection: m.selection,
      estimated_prob: m.estimated_prob,
    })),
    reviewed: false,
  });
  writeScoutingRecords(records);
}

function textMentions(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Une sélection "vainqueur" (1X2 ou 1X2 mi-temps) est-elle gagnante ?
 * Cherche le nom de l'équipe (ou "nul") dans le texte libre de la sélection ;
 * renvoie null si le texte est ambigu (mentionne les deux équipes, ou
 * aucune) plutôt que de deviner.
 */
function settleWinnerSelection(
  selection: string,
  homeTeam: string,
  awayTeam: string,
  goalsHome: number,
  goalsAway: number
): boolean | null {
  const homeWins = goalsHome > goalsAway;
  const awayWins = goalsAway > goalsHome;
  const isDraw = goalsHome === goalsAway;

  const mentionsHome = textMentions(selection, homeTeam);
  const mentionsAway = textMentions(selection, awayTeam);
  const mentionsDraw = /\bnul\b|\bdraw\b|\bmatch nul\b/i.test(selection);

  if (mentionsHome && !mentionsAway) return homeWins;
  if (mentionsAway && !mentionsHome) return awayWins;
  if (mentionsDraw && !mentionsHome && !mentionsAway) return isDraw;
  return null;
}

function settleBTTS(selection: string, goalsHome: number, goalsAway: number): boolean | null {
  const bothScored = goalsHome > 0 && goalsAway > 0;
  const saysYes = /\boui\b|\byes\b/i.test(selection);
  const saysNo = /\bnon\b|\bno\b/i.test(selection);
  if (saysYes && !saysNo) return bothScored;
  if (saysNo && !saysYes) return !bothScored;
  return null;
}

function settleOverUnder(selection: string, totalGoals: number, line: number): boolean | null {
  const isOver = /plus de|over/i.test(selection);
  const isUnder = /moins de|under/i.test(selection);
  if (isOver && !isUnder) return totalGoals > line;
  if (isUnder && !isOver) return totalGoals < line;
  return null;
}

function settleLeg(
  leg: ScoutingRecordLeg,
  homeTeam: string,
  awayTeam: string,
  goalsHome: number,
  goalsAway: number,
  htHome: number,
  htAway: number
): boolean | null {
  switch (leg.market) {
    case '1X2':
      return settleWinnerSelection(leg.selection, homeTeam, awayTeam, goalsHome, goalsAway);
    case 'mi_temps_1X2':
      return settleWinnerSelection(leg.selection, homeTeam, awayTeam, htHome, htAway);
    case 'BTTS':
      return settleBTTS(leg.selection, goalsHome, goalsAway);
    case 'OU_2_5':
      return settleOverUnder(leg.selection, goalsHome + goalsAway, 2.5);
    case 'OU_1_5':
      return settleOverUnder(leg.selection, goalsHome + goalsAway, 1.5);
    case '1ere_mi_temps':
      return settleOverUnder(leg.selection, htHome + htAway, 0.5);
    default:
      // double_chance (texte libre trop ambigu), corners, cartons, handicap
      // (aucune stat correspondante côté football-data.org) : pas de verdict.
      return null;
  }
}

interface FinalResult {
  goalsHome: number;
  goalsAway: number;
  htHome: number;
  htAway: number;
}

async function fetchFinalResult(apiKey: string, numericId: string): Promise<FinalResult | null> {
  try {
    const response = await fetch(`https://api.football-data.org/v4/matches/${numericId}`, {
      headers: { 'X-Auth-Token': apiKey },
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (data.status !== 'FINISHED') return null;

    return {
      goalsHome: data.score?.fullTime?.home ?? 0,
      goalsAway: data.score?.fullTime?.away ?? 0,
      htHome: data.score?.halfTime?.home ?? 0,
      htAway: data.score?.halfTime?.away ?? 0,
    };
  } catch (error: any) {
    console.warn('[Bilan Scouting] Résultat final indisponible:', error.message);
    return null;
  }
}

/**
 * Règle les analyses Scouting dont le match est terminé depuis assez
 * longtemps. Idempotent (reviewed:true une fois réglé) et sans risque en cas
 * d'échec réseau : un enregistrement non réglé est simplement retenté au
 * prochain tour.
 */
export async function reconcileScoutingAnalyses(): Promise<number> {
  const records = readScoutingRecords();
  const pending = records.filter(
    (r) => !r.reviewed && Date.now() - new Date(r.kickoff_utc).getTime() > MATCH_DURATION_BUFFER_MS
  );
  if (pending.length === 0) return 0;

  const apiKey = await SecureStore.getItemAsync(FOOTBALL_DATA_KEY);
  if (!apiKey) return 0;

  let settledCount = 0;
  for (const record of pending) {
    const numericId = record.id.replace(/^m-/, '');
    const result = await fetchFinalResult(apiKey, numericId);
    if (!result) continue; // pas encore FINISHED côté API (ou requête échouée) : retenté au prochain tour

    const settledLegs = record.legs
      .map((leg) => {
        const correct = settleLeg(leg, record.homeTeam, record.awayTeam, result.goalsHome, result.goalsAway, result.htHome, result.htAway);
        return correct == null ? null : { ...leg, correct };
      })
      .filter((l): l is ScoutingRecordLeg & { correct: boolean } => l != null);

    record.outcome = { ...result, settledLegs };
    record.reviewed = true;
    settledCount += 1;
  }

  writeScoutingRecords(records);
  return settledCount;
}

export interface ScoutingMarketAccuracy {
  market: string;
  samples: number;
  correct: number;
  hitRate: number;
  meanPredicted: number;
}

/** Fiabilité observée par marché sur les N derniers jours de records réglés — utilisé par le digest d'auto-apprentissage. */
export function computeScoutingAccuracy(days: number = 30): ScoutingMarketAccuracy[] {
  const cutoff = Date.now() - days * 24 * 3_600_000;
  const records = readScoutingRecords().filter(
    (r) => r.reviewed && r.outcome && new Date(r.analyzedAt).getTime() > cutoff
  );

  const byMarket = new Map<string, { correct: number; total: number; predictedSum: number }>();
  for (const record of records) {
    for (const leg of record.outcome!.settledLegs) {
      const entry = byMarket.get(leg.market) ?? { correct: 0, total: 0, predictedSum: 0 };
      entry.total += 1;
      entry.predictedSum += leg.estimated_prob;
      if (leg.correct) entry.correct += 1;
      byMarket.set(leg.market, entry);
    }
  }

  const result: ScoutingMarketAccuracy[] = [];
  for (const [market, entry] of byMarket.entries()) {
    result.push({
      market,
      samples: entry.total,
      correct: entry.correct,
      hitRate: entry.total > 0 ? entry.correct / entry.total : 0,
      meanPredicted: entry.total > 0 ? entry.predictedSum / entry.total : 0,
    });
  }
  return result.sort((a, b) => b.samples - a.samples);
}
