// Primitives de règlement partagées — déterminer si une sélection texte
// libre ("Victoire Arsenal", "Plus de 9.5 corners"...) est gagnante à partir
// d'un score final réel, sans jamais deviner sur un texte ambigu.
//
// Utilisé à la fois par le bilan Scouting IA (scoutingReview.ts) et par le
// règlement des vrais paris placés (betSettlement.ts) : même logique
// d'interprétation, deux consommateurs différents.

import { fetchWithTimeout } from './httpTimeout';

export interface FinalResult {
  goalsHome: number;
  goalsAway: number;
  htHome: number;
  htAway: number;
}

/** Score final + mi-temps d'un match terminé, via football-data.org (gratuit, même clé que le planning). */
export async function fetchFinalResult(apiKey: string, numericId: string): Promise<FinalResult | null> {
  try {
    const response = await fetchWithTimeout(`https://api.football-data.org/v4/matches/${numericId}`, {
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
    console.warn('[Règlement] Résultat final indisponible:', error.message);
    return null;
  }
}

export function textMentions(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Une sélection "vainqueur" (1X2, mi-temps ou double chance) est-elle
 * gagnante ? Cherche le nom de l'équipe (ou "nul") dans le texte libre de la
 * sélection ; renvoie null si le texte est ambigu plutôt que de deviner.
 */
export function settleWinnerSelection(
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

export function settleBTTS(selection: string, goalsHome: number, goalsAway: number): boolean | null {
  const bothScored = goalsHome > 0 && goalsAway > 0;
  const saysYes = /\boui\b|\byes\b/i.test(selection);
  const saysNo = /\bnon\b|\bno\b/i.test(selection);
  if (saysYes && !saysNo) return bothScored;
  if (saysNo && !saysYes) return !bothScored;
  return null;
}

export function parseOverUnderDirection(selection: string): 'over' | 'under' | null {
  const isOver = /plus de|over/i.test(selection);
  const isUnder = /moins de|under/i.test(selection);
  if (isOver && !isUnder) return 'over';
  if (isUnder && !isOver) return 'under';
  return null;
}

/** Over/Under à ligne FIXE connue à l'avance (buts : 2.5, 1.5, 0.5). */
export function settleOverUnder(selection: string, actualTotal: number, line: number): boolean | null {
  const direction = parseOverUnderDirection(selection);
  if (!direction) return null;
  return direction === 'over' ? actualTotal > line : actualTotal < line;
}

/**
 * Over/Under à ligne VARIABLE choisie par l'IA dans le texte de la sélection
 * (corners/cartons/fautes, ex: "Plus de 9.5 corners") : on extrait le
 * premier nombre du texte comme ligne plutôt que d'en imposer une fixe.
 */
export function settleOverUnderFreeLine(selection: string, actualTotal: number): boolean | null {
  const direction = parseOverUnderDirection(selection);
  if (!direction) return null;
  const lineMatch = selection.match(/(\d+(?:[.,]\d+)?)/);
  if (!lineMatch) return null;
  const line = parseFloat(lineMatch[1].replace(',', '.'));
  if (!Number.isFinite(line)) return null;
  return direction === 'over' ? actualTotal > line : actualTotal < line;
}

/**
 * Double chance (1X / X2 / 12), en notation courte OU en texte libre
 * ("Équipe A ou Nul"). Cherche d'abord la notation courte (fiable), puis
 * retombe sur une combinaison de mentions d'équipe/nul ; renvoie null si le
 * texte ne permet toujours pas de savoir quelles deux issues sont couvertes.
 */
export function settleDoubleChance(
  selection: string,
  homeTeam: string,
  awayTeam: string,
  goalsHome: number,
  goalsAway: number
): boolean | null {
  const homeWins = goalsHome > goalsAway;
  const awayWins = goalsAway > goalsHome;
  const isDraw = goalsHome === goalsAway;

  if (/\b1x\b/i.test(selection)) return homeWins || isDraw;
  if (/\bx2\b/i.test(selection)) return isDraw || awayWins;
  if (/\b12\b/.test(selection)) return homeWins || awayWins;

  const mentionsHome = textMentions(selection, homeTeam);
  const mentionsAway = textMentions(selection, awayTeam);
  const mentionsDraw = /\bnul\b|\bdraw\b/i.test(selection);

  if (mentionsHome && mentionsDraw && !mentionsAway) return homeWins || isDraw;
  if (mentionsAway && mentionsDraw && !mentionsHome) return isDraw || awayWins;
  if (mentionsHome && mentionsAway && !mentionsDraw) return homeWins || awayWins;
  return null;
}

/**
 * Handicap asiatique simplifié (-1/+1 sur une équipe). Une ligne entière qui
 * tombe pile sur zéro après application du handicap est un "push" (ni
 * gagné ni perdu) : on renvoie null plutôt que de forcer un verdict.
 */
export function settleHandicap(
  selection: string,
  homeTeam: string,
  awayTeam: string,
  goalsHome: number,
  goalsAway: number
): boolean | null {
  const mentionsHome = textMentions(selection, homeTeam);
  const mentionsAway = textMentions(selection, awayTeam);
  if (mentionsHome === mentionsAway) return null; // aucune équipe ou les deux : ambigu

  const handicapMatch = selection.match(/([+-]\s?\d+(?:[.,]\d+)?)/);
  if (!handicapMatch) return null;
  const handicapValue = parseFloat(handicapMatch[1].replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(handicapValue)) return null;

  const diff = mentionsHome ? goalsHome - goalsAway : goalsAway - goalsHome;
  const adjusted = diff + handicapValue;
  if (adjusted === 0) return null; // push
  return adjusted > 0;
}
