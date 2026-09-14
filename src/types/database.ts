// Schémas de données pour la Base de Connaissance Équipes & Déroulé Temporel des Matchs
// Conforme au dossier méthodologique §1.2, §2.3, §5.1

import { Market } from './index';

export interface TemporalGoalStats {
  min_0_15: number;   // Buts 0-15 min
  min_16_30: number;  // Buts 16-30 min
  min_31_45: number;  // Buts 31-45 min
  min_46_60: number;  // Buts 46-60 min
  min_61_75: number;  // Buts 61-75 min
  min_76_90: number;  // Buts 76-90+ min
}

export interface MatchEventPattern {
  eventType: 'goal_scored' | 'goal_conceded' | 'yellow_card' | 'red_card';
  avgMinute: number;
  triggerContext: string; // ex: "Transition rapide après corner", "Faute tactique bloc haut"
  preEventShotsAvg: number; // Nombre moyen de tirs avant l'événement
  preEventPressureIndex: number; // Index de pression (0-100)
}

export interface TeamStatsSplit {
  matchesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  xG: number;
  xGA: number;
  cleanSheets: number;
  failedToScore: number;
  cornersAvg: number;
  foulsAvg: number;
  yellowCardsAvg: number;
  redCardsTotal: number;
  shotsAvg: number;
  shotsOnTargetAvg: number;
  savesAvg: number;
  possessionAvg: number; // %
}

export interface TeamKnowledgeData {
  teamId: string;
  name: string;
  shortName: string;
  leagueId: string;
  leagueName: string;
  flag: string;
  season: string; // ex: "2026-2027"
  isBaselineN1: boolean; // true si < 8 matchs joués cette saison (§2.3)

  // Statistiques globales et splits
  overall: TeamStatsSplit;
  home: TeamStatsSplit;
  away: TeamStatsSplit;

  // Déroulé temporel & patterns pré-buts/cartons
  goalsScoredTiming: TemporalGoalStats;
  goalsConcededTiming: TemporalGoalStats;
  patterns: MatchEventPattern[];

  // Forme récente (5 derniers matchs)
  recentForm: Array<{
    matchDate: string;
    opponent: string;
    isHome: boolean;
    score: string;
    result: 'W' | 'D' | 'L';
    xG: number;
    xGA: number;
    shotsOnTarget: number;
    cleanSheet: boolean;
  }>;

  // Actualités & Contexte à jour
  injuries: string[];
  suspensions: string[];
  coachName: string;
  tacticalStyle: string; // ex: "Possession 4-3-3", "Bloc bas contre-attaque"
  lastUpdated: string;   // ISO 8601
}

export interface DailyScheduleSlot {
  slotId: string;
  slotTimeDisplay: string; // ex: "15:30" (heure UTC+1 Algérie)
  slotKickoffUtc: string;  // ISO 8601
  matchesCount: number;
  matches: ScheduledMatchDetail[];
  isT90Reached: boolean;   // true si now >= kickoff - 90 min
  lineupsConfirmed: boolean;
}

export interface ScheduledMatchDetail {
  id: string;
  leagueId: string;
  leagueName: string;
  flag: string;
  homeTeam: string;
  awayTeam: string;
  kickoff_utc: string;
  creneau_display: string;
  homeTeamData?: TeamKnowledgeData;
  awayTeamData?: TeamKnowledgeData;
  odds: {
    home: number;
    draw: number;
    away: number;
    btts_yes: number;
    btts_no: number;
    over_2_5: number;
    under_2_5: number;
  };
  lineups?: {
    homeConfirmed: boolean;
    awayConfirmed: boolean;
    homeXI: string[];
    awayXI: string[];
    keyAbsences: string[];
  };
  context: string;
}
