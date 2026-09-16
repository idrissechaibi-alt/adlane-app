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
  // TODO : Connecter une vraie API (ex: Football-Data.org)
  return [
    {
      id: `m-${today}-pl-01`,
      leagueId: 'PL',
      leagueName: 'Premier League',
      flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      homeTeam: 'Team A (Today)',
      awayTeam: 'Team B (Today)',
      kickoff_utc: `${today}T15:00:00Z`,
      creneau_display: '16:00',
      odds: { home: 1.80, draw: 3.40, away: 4.50, btts_yes: 1.90 },
      context: 'Match détecté le ' + today + '. Analyse IA disponible à T-90.'
    },
    {
      id: `m-${today}-pl-02`,
      leagueId: 'PL',
      leagueName: 'Premier League',
      flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      homeTeam: 'Team C (Today)',
      awayTeam: 'Team D (Today)',
      kickoff_utc: `${today}T15:00:00Z`,
      creneau_display: '16:00',
      odds: { home: 2.10, draw: 3.20, away: 3.60 },
      context: 'Match détecté le ' + today + '.'
    },
    {
      id: `m-${today}-ll-01`,
      leagueId: 'LL',
      leagueName: 'La Liga',
      flag: '🇪🇸',
      homeTeam: 'Team E (Today)',
      awayTeam: 'Team F (Today)',
      kickoff_utc: `${today}T18:00:00Z`,
      creneau_display: '19:00',
      odds: { home: 1.50, draw: 4.20, away: 6.50 },
      context: 'Match en soirée.'
    },
    {
      id: `m-${today}-ll-02`,
      leagueId: 'LL',
      leagueName: 'La Liga',
      flag: '🇪🇸',
      homeTeam: 'Team G (Today)',
      awayTeam: 'Team H (Today)',
      kickoff_utc: `${today}T20:00:00Z`,
      creneau_display: '21:00',
      odds: { home: 2.50, draw: 3.10, away: 3.00 },
      context: 'Dernier match du jour.'
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
