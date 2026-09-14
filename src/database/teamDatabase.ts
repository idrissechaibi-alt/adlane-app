// Module de stockage local de la Base de Données Équipes (teams_database.json)
// Persistance sur le téléphone avec possibilité de mise à jour quotidienne

import AsyncStorage from '@react-native-async-storage/async-storage';
import { TeamKnowledgeData } from '../types/database';

const TEAMS_DB_KEY = '@teams_database_json';

/**
 * Base de données initiale pré-chargée pour les équipes majeures des 5 championnats
 * Inclut le déroulé temporel des buts et les patterns avant un but ou carton
 */
export const INITIAL_TEAMS_DATA: Record<string, TeamKnowledgeData> = {
  'man-city': {
    teamId: 'man-city',
    name: 'Manchester City',
    shortName: 'Man City',
    leagueId: 'PL',
    leagueName: 'Premier League',
    flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    season: '2026-2027',
    isBaselineN1: false,
    overall: {
      matchesPlayed: 12,
      wins: 9,
      draws: 2,
      losses: 1,
      goalsFor: 28,
      goalsAgainst: 9,
      xG: 2.35,
      xGA: 0.82,
      cleanSheets: 6,
      failedToScore: 1,
      cornersAvg: 7.8,
      foulsAvg: 8.5,
      yellowCardsAvg: 1.2,
      redCardsTotal: 1,
      shotsAvg: 17.2,
      shotsOnTargetAvg: 6.8,
      savesAvg: 2.1,
      possessionAvg: 66.4
    },
    home: {
      matchesPlayed: 6,
      wins: 5,
      draws: 1,
      losses: 0,
      goalsFor: 18,
      goalsAgainst: 3,
      xG: 2.65,
      xGA: 0.65,
      cleanSheets: 4,
      failedToScore: 0,
      cornersAvg: 8.5,
      foulsAvg: 7.9,
      yellowCardsAvg: 0.9,
      redCardsTotal: 0,
      shotsAvg: 19.4,
      shotsOnTargetAvg: 7.6,
      savesAvg: 1.8,
      possessionAvg: 68.2
    },
    away: {
      matchesPlayed: 6,
      wins: 4,
      draws: 1,
      losses: 1,
      goalsFor: 10,
      goalsAgainst: 6,
      xG: 2.05,
      xGA: 0.99,
      cleanSheets: 2,
      failedToScore: 1,
      cornersAvg: 7.1,
      foulsAvg: 9.1,
      yellowCardsAvg: 1.5,
      redCardsTotal: 1,
      shotsAvg: 15.0,
      shotsOnTargetAvg: 6.0,
      savesAvg: 2.4,
      possessionAvg: 64.6
    },
    goalsScoredTiming: {
      min_0_15: 3,
      min_16_30: 5,
      min_31_45: 4,
      min_46_60: 7,   // 25% des buts en début de 2e mi-temps
      min_61_75: 5,
      min_76_90: 4
    },
    goalsConcededTiming: {
      min_0_15: 1,
      min_16_30: 1,
      min_31_45: 2,
      min_46_60: 1,
      min_61_75: 1,
      min_76_90: 3    // 33% des buts encaissés après la 75e
    },
    patterns: [
      {
        eventType: 'goal_scored',
        avgMinute: 52,
        triggerContext: 'Pression soutenue (3+ tirs dans les 8 min précédentes)',
        preEventShotsAvg: 3.4,
        preEventPressureIndex: 85
      },
      {
        eventType: 'yellow_card',
        avgMinute: 72,
        triggerContext: 'Faute tactique d\'antijeu pour stopper une contre-attaque',
        preEventShotsAvg: 1.2,
        preEventPressureIndex: 45
      }
    ],
    recentForm: [
      { matchDate: '2026-09-13', opponent: 'Manchester United', isHome: false, score: '0-1', result: 'W', xG: 1.85, xGA: 0.72, shotsOnTarget: 5, cleanSheet: true },
      { matchDate: '2026-09-02', opponent: 'Inter Milan', isHome: true, score: '2-0', result: 'W', xG: 2.40, xGA: 0.50, shotsOnTarget: 7, cleanSheet: true },
      { matchDate: '2026-08-28', opponent: 'West Ham', isHome: false, score: '1-3', result: 'W', xG: 2.70, xGA: 0.90, shotsOnTarget: 8, cleanSheet: false },
      { matchDate: '2026-08-24', opponent: 'Ipswich', isHome: true, score: '4-1', result: 'W', xG: 3.10, xGA: 0.40, shotsOnTarget: 9, cleanSheet: false },
      { matchDate: '2026-08-18', opponent: 'Chelsea', isHome: false, score: '0-2', result: 'W', xG: 1.60, xGA: 1.10, shotsOnTarget: 5, cleanSheet: true }
    ],
    injuries: [],
    suspensions: [],
    coachName: 'Pep Guardiola',
    tacticalStyle: 'Possession haute & étouffement progressif',
    lastUpdated: '2026-09-14T08:00:00Z'
  },
  'arsenal': {
    teamId: 'arsenal',
    name: 'Arsenal FC',
    shortName: 'Arsenal',
    leagueId: 'PL',
    leagueName: 'Premier League',
    flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    season: '2026-2027',
    isBaselineN1: false,
    overall: {
      matchesPlayed: 12,
      wins: 8,
      draws: 3,
      losses: 1,
      goalsFor: 24,
      goalsAgainst: 8,
      xG: 2.10,
      xGA: 0.78,
      cleanSheets: 7,
      failedToScore: 1,
      cornersAvg: 6.9,
      foulsAvg: 10.2,
      yellowCardsAvg: 1.8,
      redCardsTotal: 1,
      shotsAvg: 15.8,
      shotsOnTargetAvg: 5.9,
      savesAvg: 2.6,
      possessionAvg: 61.5
    },
    home: {
      matchesPlayed: 6,
      wins: 5,
      draws: 1,
      losses: 0,
      goalsFor: 15,
      goalsAgainst: 3,
      xG: 2.30,
      xGA: 0.60,
      cleanSheets: 4,
      failedToScore: 0,
      cornersAvg: 7.5,
      foulsAvg: 9.8,
      yellowCardsAvg: 1.5,
      redCardsTotal: 0,
      shotsAvg: 17.5,
      shotsOnTargetAvg: 6.8,
      savesAvg: 2.0,
      possessionAvg: 63.5
    },
    away: {
      matchesPlayed: 6,
      wins: 3,
      draws: 2,
      losses: 1,
      goalsFor: 9,
      goalsAgainst: 5,
      xG: 1.90,
      xGA: 0.96,
      cleanSheets: 3,
      failedToScore: 1,
      cornersAvg: 6.3,
      foulsAvg: 10.6,
      yellowCardsAvg: 2.1,
      redCardsTotal: 1,
      shotsAvg: 14.1,
      shotsOnTargetAvg: 5.0,
      savesAvg: 3.2,
      possessionAvg: 59.5
    },
    goalsScoredTiming: {
      min_0_15: 4,
      min_16_30: 3,
      min_31_45: 6,   // Fort en fin de première période
      min_46_60: 3,
      min_61_75: 4,
      min_76_90: 4
    },
    goalsConcededTiming: {
      min_0_15: 0,
      min_16_30: 2,
      min_31_45: 2,
      min_46_60: 1,
      min_61_75: 2,
      min_76_90: 1
    },
    patterns: [
      {
        eventType: 'goal_scored',
        avgMinute: 38,
        triggerContext: 'Coup de pied arrêté ou corner offensif (45% des buts)',
        preEventShotsAvg: 2.8,
        preEventPressureIndex: 78
      }
    ],
    recentForm: [
      { matchDate: '2026-09-12', opponent: 'Sunderland', isHome: false, score: '0-2', result: 'W', xG: 2.05, xGA: 0.45, shotsOnTarget: 6, cleanSheet: true },
      { matchDate: '2026-09-01', opponent: 'Brighton', isHome: true, score: '1-1', result: 'D', xG: 1.75, xGA: 1.10, shotsOnTarget: 5, cleanSheet: false },
      { matchDate: '2026-08-24', opponent: 'Aston Villa', isHome: false, score: '0-2', result: 'W', xG: 1.95, xGA: 0.85, shotsOnTarget: 6, cleanSheet: true }
    ],
    injuries: ['Odegaard (incertain)'],
    suspensions: [],
    coachName: 'Mikel Arteta',
    tacticalStyle: 'Bloc médian structuré & coups de pied arrêtés ultra-efficaces',
    lastUpdated: '2026-09-14T08:00:00Z'
  },
  'psg': {
    teamId: 'psg',
    name: 'Paris Saint-Germain',
    shortName: 'PSG',
    leagueId: 'L1',
    leagueName: 'Ligue 1',
    flag: '🇫🇷',
    season: '2026-2027',
    isBaselineN1: false,
    overall: {
      matchesPlayed: 12,
      wins: 10,
      draws: 2,
      losses: 0,
      goalsFor: 32,
      goalsAgainst: 8,
      xG: 2.55,
      xGA: 0.75,
      cleanSheets: 6,
      failedToScore: 0,
      cornersAvg: 7.2,
      foulsAvg: 8.8,
      yellowCardsAvg: 1.4,
      redCardsTotal: 0,
      shotsAvg: 18.0,
      shotsOnTargetAvg: 7.5,
      savesAvg: 2.3,
      possessionAvg: 67.8
    },
    home: {
      matchesPlayed: 6,
      wins: 6,
      draws: 0,
      losses: 0,
      goalsFor: 20,
      goalsAgainst: 3,
      xG: 2.85,
      xGA: 0.60,
      cleanSheets: 4,
      failedToScore: 0,
      cornersAvg: 8.1,
      foulsAvg: 8.0,
      yellowCardsAvg: 1.1,
      redCardsTotal: 0,
      shotsAvg: 20.2,
      shotsOnTargetAvg: 8.6,
      savesAvg: 1.9,
      possessionAvg: 70.1
    },
    away: {
      matchesPlayed: 6,
      wins: 4,
      draws: 2,
      losses: 0,
      goalsFor: 12,
      goalsAgainst: 5,
      xG: 2.25,
      xGA: 0.90,
      cleanSheets: 2,
      failedToScore: 0,
      cornersAvg: 6.3,
      foulsAvg: 9.6,
      yellowCardsAvg: 1.7,
      redCardsTotal: 0,
      shotsAvg: 15.8,
      shotsOnTargetAvg: 6.4,
      savesAvg: 2.7,
      possessionAvg: 65.5
    },
    goalsScoredTiming: {
      min_0_15: 5,
      min_16_30: 6,
      min_31_45: 4,
      min_46_60: 7,
      min_61_75: 6,
      min_76_90: 4
    },
    goalsConcededTiming: {
      min_0_15: 1,
      min_16_30: 1,
      min_31_45: 1,
      min_46_60: 2,
      min_61_75: 1,
      min_76_90: 2
    },
    patterns: [
      {
        eventType: 'goal_scored',
        avgMinute: 24,
        triggerContext: 'Accélération sur les ailes (Barcola/Dembélé)',
        preEventShotsAvg: 2.5,
        preEventPressureIndex: 82
      }
    ],
    recentForm: [
      { matchDate: '2026-09-13', opponent: 'Brest', isHome: false, score: '0-1', result: 'W', xG: 1.90, xGA: 0.65, shotsOnTarget: 6, cleanSheet: true },
      { matchDate: '2026-09-01', opponent: 'Lille', isHome: false, score: '1-3', result: 'W', xG: 2.45, xGA: 1.05, shotsOnTarget: 7, cleanSheet: false }
    ],
    injuries: ['Gonçalo Ramos'],
    suspensions: [],
    coachName: 'Luis Enrique',
    tacticalStyle: 'Jeu de position fluide & percussion sur les ailes',
    lastUpdated: '2026-09-14T08:00:00Z'
  },
  'atalanta': {
    teamId: 'atalanta',
    name: 'Atalanta Bergamo',
    shortName: 'Atalanta',
    leagueId: 'SA',
    leagueName: 'Serie A',
    flag: '🇮🇹',
    season: '2026-2027',
    isBaselineN1: false,
    overall: {
      matchesPlayed: 11,
      wins: 7,
      draws: 2,
      losses: 2,
      goalsFor: 25,
      goalsAgainst: 12,
      xG: 2.20,
      xGA: 1.05,
      cleanSheets: 4,
      failedToScore: 1,
      cornersAvg: 6.8,
      foulsAvg: 12.5,
      yellowCardsAvg: 2.2,
      redCardsTotal: 0,
      shotsAvg: 16.5,
      shotsOnTargetAvg: 6.2,
      savesAvg: 2.8,
      possessionAvg: 56.4
    },
    home: {
      matchesPlayed: 5,
      wins: 4,
      draws: 1,
      losses: 0,
      goalsFor: 14,
      goalsAgainst: 4,
      xG: 2.45,
      xGA: 0.85,
      cleanSheets: 2,
      failedToScore: 0,
      cornersAvg: 7.2,
      foulsAvg: 11.8,
      yellowCardsAvg: 1.9,
      redCardsTotal: 0,
      shotsAvg: 18.2,
      shotsOnTargetAvg: 7.1,
      savesAvg: 2.2,
      possessionAvg: 58.2
    },
    away: {
      matchesPlayed: 6,
      wins: 3,
      draws: 1,
      losses: 2,
      goalsFor: 11,
      goalsAgainst: 8,
      xG: 1.95,
      xGA: 1.25,
      cleanSheets: 2,
      failedToScore: 1,
      cornersAvg: 6.4,
      foulsAvg: 13.2,
      yellowCardsAvg: 2.5,
      redCardsTotal: 0,
      shotsAvg: 14.8,
      shotsOnTargetAvg: 5.3,
      savesAvg: 3.4,
      possessionAvg: 54.6
    },
    goalsScoredTiming: {
      min_0_15: 2,
      min_16_30: 4,
      min_31_45: 5,
      min_46_60: 6,
      min_61_75: 5,
      min_76_90: 3
    },
    goalsConcededTiming: {
      min_0_15: 2,
      min_16_30: 2,
      min_31_45: 3,
      min_46_60: 2,
      min_61_75: 1,
      min_76_90: 2
    },
    patterns: [
      {
        eventType: 'goal_scored',
        avgMinute: 44,
        triggerContext: 'Intensité physique & pressing haut tout terrain',
        preEventShotsAvg: 3.1,
        preEventPressureIndex: 88
      }
    ],
    recentForm: [
      { matchDate: '2026-09-01', opponent: 'Inter', isHome: false, score: '4-0', result: 'L', xG: 0.85, xGA: 2.90, shotsOnTarget: 2, cleanSheet: false },
      { matchDate: '2026-08-25', opponent: 'Torino', isHome: false, score: '2-1', result: 'L', xG: 1.65, xGA: 1.40, shotsOnTarget: 5, cleanSheet: false },
      { matchDate: '2026-08-19', opponent: 'Lecce', isHome: false, score: '0-4', result: 'W', xG: 2.60, xGA: 0.50, shotsOnTarget: 8, cleanSheet: true }
    ],
    injuries: ['Scamacca (longue durée)'],
    suspensions: [],
    coachName: 'Gian Piero Gasperini',
    tacticalStyle: 'Marquage individuel tout terrain & verticalité immédiate',
    lastUpdated: '2026-09-14T08:00:00Z'
  }
};

/**
 * Récupère la base de données locale des équipes
 */
export async function getTeamsDatabase(): Promise<Record<string, TeamKnowledgeData>> {
  try {
    const raw = await AsyncStorage.getItem(TEAMS_DB_KEY);
    if (!raw) {
      // Première utilisation : initialiser avec les données complètes
      await saveTeamsDatabase(INITIAL_TEAMS_DATA);
      return INITIAL_TEAMS_DATA;
    }
    return JSON.parse(raw);
  } catch (error) {
    console.error('Erreur lecture teams_database:', error);
    return INITIAL_TEAMS_DATA;
  }
}

/**
 * Sauvegarde la base de données locale sur le téléphone
 */
export async function saveTeamsDatabase(data: Record<string, TeamKnowledgeData>): Promise<void> {
  try {
    await AsyncStorage.setItem(TEAMS_DB_KEY, JSON.stringify(data));
  } catch (error) {
    console.error('Erreur sauvegarde teams_database:', error);
  }
}

/**
 * Met à jour les données d'une équipe suite au scan du matin
 */
export async function updateTeamKnowledge(teamId: string, updates: Partial<TeamKnowledgeData>): Promise<void> {
  const db = await getTeamsDatabase();
  const existing = db[teamId];
  if (existing) {
    db[teamId] = {
      ...existing,
      ...updates,
      lastUpdated: new Date().toISOString()
    };
    await saveTeamsDatabase(db);
  }
}
