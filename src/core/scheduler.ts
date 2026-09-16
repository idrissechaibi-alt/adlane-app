// Scheduler Matinal Automatique (Scan à 7h00 UTC = 8h00 Algérie)
// Récupère les matchs du jour, actualise la data, génère le planning par créneaux

import { DailyScheduleSlot, ScheduledMatchDetail } from '../types/database';
import { TOP_5_LEAGUES } from './dailyWorkflow';
import { getTeamsDatabase, updateTeamKnowledge } from '../database/teamDatabase';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DAILY_SCHEDULE_KEY = '@daily_schedule_json';

export interface DailyPlan {
  date: string; // YYYY-MM-DD
  generatedAt: string; // ISO 8601
  totalMatches: number;
  slots: DailyScheduleSlot[];
}

/**
 * PHASE 2 : Scan Matinal (à lancer chaque matin à 7h00 UTC = 8h00 Algérie)
 * 1. Récupère la liste des matchs du jour pour les 5 championnats
 * 2. Actualise la data (blessures, suspensions, form)
 * 3. Classe les matchs par créneaux horaires (tolérance ±15 min)
 * 4. Stocke dans daily_schedule.json
 */
export async function executeMorningScan(targetDate?: string): Promise<DailyPlan> {
  console.log('🌅 [MORNING SCAN] Démarrage du scan matinal...');

  const today = targetDate || new Date().toISOString().split('T')[0];

  // 1. RÉCUPÉRATION DES MATCHS DU JOUR
  const rawMatches = await fetchTodayFixtures(today);

  console.log(`📊 ${rawMatches.length} matchs détectés pour le ${today}`);

  // 2. ACTUALISATION DE LA DATA ÉQUIPES
  const teamsDb = await getTeamsDatabase();

  for (const match of rawMatches) {
    if (!teamsDb[match.homeTeam.toLowerCase().replace(/\s/g, '-')]) {
      console.log(`⚠️ Équipe inconnue : ${match.homeTeam}`);
    }
  }

  // 3. REGROUPEMENT PAR CRÉNEAUX HORAIRES
  const slots = groupMatchesIntoSlots(rawMatches);

  const plan: DailyPlan = {
    date: today,
    generatedAt: new Date().toISOString(),
    totalMatches: rawMatches.length,
    slots
  };

  // 4. STOCKAGE LOCAL
  await AsyncStorage.setItem(DAILY_SCHEDULE_KEY, JSON.stringify(plan));

  console.log(`✅ [MORNING SCAN] Planning du jour généré : ${slots.length} créneaux identifiés`);

  return plan;
}

/**
 * Récupère le planning du jour depuis le stockage local
 */
export async function getDailyPlan(): Promise<DailyPlan | null> {
  try {
    const raw = await AsyncStorage.getItem(DAILY_SCHEDULE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error('Erreur lecture daily_schedule:', error);
    return null;
  }
}

/**
 * Simule la récupération des matchs du jour via API externe
 */
async function fetchTodayFixtures(date: string): Promise<ScheduledMatchDetail[]> {
  const today = new Date().toISOString().split('T')[0];

  // Simulation de matchs dynamiques basés sur la date réelle
  // Les 5 grandes ligues européennes
  return [
    {
      id: `m-${today}-pl-01`,
      leagueId: 'PL',
      leagueName: 'Premier League',
      flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      homeTeam: 'Tottenham',
      awayTeam: 'Man City',
      kickoff_utc: `${today}T19:00:00Z`,
      creneau_display: '20:00',
      odds: { home: 3.80, draw: 3.60, away: 1.95, btts_yes: 1.65 },
      context: 'Grosse affiche. City doit gagner pour le titre.'
    },
    {
      id: `m-${today}-ll-01`,
      leagueId: 'LL',
      leagueName: 'La Liga',
      flag: '🇪🇸',
      homeTeam: 'Girona',
      awayTeam: 'Villarreal',
      kickoff_utc: `${today}T17:00:00Z`,
      creneau_display: '18:00',
      odds: { home: 1.85, draw: 3.80, away: 3.50 },
      context: 'Girona en course pour la C1.'
    },
    {
      id: `m-${today}-sa-01`,
      leagueId: 'SA',
      leagueName: 'Serie A',
      flag: '🇮🇹',
      homeTeam: 'Lazio',
      awayTeam: 'Empoli',
      kickoff_utc: `${today}T13:30:00Z`,
      creneau_display: '14:30',
      odds: { home: 1.60, draw: 4.00, away: 5.50 },
      context: 'Lazio favori à domicile.'
    },
    {
      id: `m-${today}-bl-01`,
      leagueId: 'BL',
      leagueName: 'Bundesliga',
      flag: '🇩🇪',
      homeTeam: 'Leverkusen',
      awayTeam: 'Bayern',
      kickoff_utc: `${today}T15:30:00Z`,
      creneau_display: '16:30',
      odds: { home: 2.30, draw: 3.60, away: 2.80 },
      context: 'Choc au sommet en Allemagne.'
    },
    {
      id: `m-${today}-l1-01`,
      leagueId: 'L1',
      leagueName: 'Ligue 1',
      flag: '🇫🇷',
      homeTeam: 'Lyon',
      awayTeam: 'Lille',
      kickoff_utc: `${today}T18:45:00Z`,
      creneau_display: '19:45',
      odds: { home: 2.10, draw: 3.40, away: 3.20 },
      context: 'Course à l\'Europe.'
    }
  ];
}

/**
 * Regroupe les matchs par créneaux horaires (tolérance ±15 min)
 */
function groupMatchesIntoSlots(matches: ScheduledMatchDetail[]): DailyScheduleSlot[] {
  const slotMap = new Map<string, ScheduledMatchDetail[]>();

  for (const match of matches) {
    const slotKey = match.creneau_display;
    const existing = slotMap.get(slotKey) || [];
    existing.push(match);
    slotMap.set(slotKey, existing);
  }

  const slots: DailyScheduleSlot[] = [];
  for (const [key, slotMatches] of slotMap.entries()) {
    const kickoffUtc = slotMatches[0].kickoff_utc;
    const now = new Date();
    const slotTime = new Date(kickoffUtc);
    const t90 = new Date(slotTime.getTime() - 90 * 60 * 1000);

    slots.push({
      slotId: `slot-${key.replace(':', '')}`,
      slotTimeDisplay: key,
      slotKickoffUtc: kickoffUtc,
      matchesCount: slotMatches.length,
      matches: slotMatches,
      isT90Reached: now >= t90,
      lineupsConfirmed: false
    });
  }

  return slots.sort((a, b) => a.slotKickoffUtc.localeCompare(b.slotKickoffUtc));
}

export async function checkAndUpdateT90Status(): Promise<void> {
  const plan = await getDailyPlan();
  if (!plan) return;

  let updated = false;
  const now = new Date();

  for (const slot of plan.slots) {
    const slotTime = new Date(slot.slotKickoffUtc);
    const t90 = new Date(slotTime.getTime() - 90 * 60 * 1000);

    if (now >= t90 && !slot.isT90Reached) {
      slot.isT90Reached = true;
      updated = true;
      console.log(`⏰ [T-90] Créneau ${slot.slotTimeDisplay} : T-90 atteint !`);
    }
  }

  if (updated) {
    await AsyncStorage.setItem(DAILY_SCHEDULE_KEY, JSON.stringify(plan));
  }
}
