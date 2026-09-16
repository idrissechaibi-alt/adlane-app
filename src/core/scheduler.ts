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
  // TODO : Connexion API-Football / TheOddsAPI / Football-Data
  // Pour l'instant : matchs d'exemple
  const rawMatches = await fetchTodayFixtures(today);

  console.log(`📊 ${rawMatches.length} matchs détectés pour le ${today}`);

  // 2. ACTUALISATION DE LA DATA ÉQUIPES
  const teamsDb = await getTeamsDatabase();

  for (const match of rawMatches) {
    // Actualiser les données si nécessaire (nouvelles blessures, form)
    // Exemple : si une équipe n'est pas dans la DB, on la crée
    if (!teamsDb[match.homeTeam.toLowerCase().replace(/\s/g, '-')]) {
      console.log(`⚠️ Équipe inconnue : ${match.homeTeam} (à enrichir via API)`);
    }
  }

  // 3. REGROUPEMENT PAR CRÉNEAUX HORAIRES (tolérance ±15 min)
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
 * TODO : Remplacer par un vrai appel API (API-Football, TheOddsAPI)
 */
async function fetchTodayFixtures(date: string): Promise<ScheduledMatchDetail[]> {
  // Détection de la date système
  const today = new Date().toISOString().split('T')[0];

  return [
    {
      id: `m-${today}-pl-01`,
      leagueId: 'PL',
      leagueName: 'Premier League',
      flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      homeTeam: 'Liverpool',
      awayTeam: 'Nottingham Forest',
      kickoff_utc: `${today}T14:00:00Z`,
      creneau_display: '15:00',
      odds: {
        home: 1.35,
        draw: 5.20,
        away: 8.50,
        btts_yes: 1.85,
        btts_no: 1.95,
        over_2_5: 1.55,
        under_2_5: 2.40
      },
      context: 'Liverpool invaincu à domicile. Salah de retour.'
    },
    {
      id: `m-${today}-pl-02`,
      leagueId: 'PL',
      leagueName: 'Premier League',
      flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      homeTeam: 'Brighton',
      awayTeam: 'Ipswich Town',
      kickoff_utc: `${today}T14:00:00Z`,
      creneau_display: '15:00',
      odds: {
        home: 1.65,
        draw: 4.00,
        away: 5.00,
        btts_yes: 1.70,
        btts_no: 2.10,
        over_2_5: 1.68,
        under_2_5: 2.15
      },
      context: 'Brighton intense à domicile, Ipswich fragile.'
    },
    {
      id: `m-${today}-pl-03`,
      leagueId: 'PL',
      leagueName: 'Premier League',
      flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      homeTeam: 'Southampton',
      awayTeam: 'Manchester United',
      kickoff_utc: `${today}T16:30:00Z`,
      creneau_display: '17:30',
      odds: {
        home: 4.50,
        draw: 3.80,
        away: 1.75,
        btts_yes: 1.75,
        btts_no: 2.05,
        over_2_5: 1.70,
        under_2_5: 2.10
      },
      context: 'Arbitre Michael Oliver. Rashford incertain.'
    },
    {
      id: `m-${today}-ll-01`,
      leagueId: 'LL',
      leagueName: 'La Liga',
      flag: '🇪🇸',
      homeTeam: 'Real Madrid',
      awayTeam: 'Real Sociedad',
      kickoff_utc: `${today}T19:00:00Z`,
      creneau_display: '20:00',
      odds: {
        home: 1.30,
        draw: 5.50,
        away: 10.00,
        btts_yes: 1.95,
        btts_no: 1.85,
        over_2_5: 1.50,
        under_2_5: 2.50
      },
      context: 'Mbappé et Vinicius titulaires. Real Sociedad défensive.'
    },
    {
      id: `m-${today}-sa-01`,
      leagueId: 'SA',
      leagueName: 'Serie A',
      flag: '🇮🇹',
      homeTeam: 'Inter Milan',
      awayTeam: 'Monza',
      kickoff_utc: `${today}T19:00:00Z`,
      creneau_display: '20:00',
      odds: {
        home: 1.28,
        draw: 5.75,
        away: 11.00,
        btts_yes: 2.05,
        btts_no: 1.75,
        over_2_5: 1.48,
        under_2_5: 2.60
      },
      context: 'Inter en forme, 6 victoires consécutives. Lautaro en feu.'
    },
    {
      id: `m-${today}-l1-01`,
      leagueId: 'L1',
      leagueName: 'Ligue 1',
      flag: '🇫🇷',
      homeTeam: 'PSG',
      awayTeam: 'Brest',
      kickoff_utc: `${today}T18:45:00Z`,
      creneau_display: '19:45',
      odds: {
        home: 1.22,
        draw: 6.50,
        away: 13.00,
        btts_yes: 2.15,
        btts_no: 1.68,
        over_2_5: 1.40,
        under_2_5: 2.90
      },
      context: 'PSG au Parc. Barcola et Dembélé alignés.'
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
      lineupsConfirmed: false // Sera mis à jour à T-90
    });
  }

  return slots.sort((a, b) => a.slotKickoffUtc.localeCompare(b.slotKickoffUtc));
}

/**
 * Vérifie si T-90 min est atteint pour un créneau et met à jour le flag
 */
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
      console.log(`⏰ [T-90] Créneau ${slot.slotTimeDisplay} : T-90 atteint ! Génération des propositions...`);
      // TODO : Déclencher la génération des combinés et solos (Phase 3)
    }
  }

  if (updated) {
    await AsyncStorage.setItem(DAILY_SCHEDULE_KEY, JSON.stringify(plan));
  }
}
