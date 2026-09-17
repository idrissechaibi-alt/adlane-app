// Scheduler Matinal - Données Football Réelles
// Utilise l'API football-data.org pour récupérer les vrais matchs

import { DailyScheduleSlot, ScheduledMatchDetail } from '../types/database';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const DAILY_SCHEDULE_KEY = '@daily_schedule_json';
const FOOTBALL_DATA_KEY = 'app-adlane.football-data-api-key';

export async function executeMorningScan(): Promise<any> {
  console.log('🌅 [MORNING SCAN] Démarrage...');
  const apiKey = await SecureStore.getItemAsync(FOOTBALL_DATA_KEY);

  if (!apiKey) {
    throw new Error('Clé API Football-Data manquante. Configurez-la dans les paramètres.');
  }

  try {
    // Récupération des matchs pour les 5 grandes ligues + Champions League
    const response = await fetch('https://api.football-data.org/v4/matches', {
      headers: { 'X-Auth-Token': apiKey }
    });

    if (!response.ok) throw new Error('Erreur API Football-Data');

    const data = await response.json();
    const matches: any[] = data.matches || [];

    const mappedMatches: ScheduledMatchDetail[] = matches.map(m => ({
      id: `m-${m.id}`,
      leagueId: m.competition.code,
      leagueName: m.competition.name,
      flag: getLeagueFlag(m.competition.code),
      homeTeam: m.homeTeam.name,
      awayTeam: m.awayTeam.name,
      kickoff_utc: m.utcDate,
      creneau_display: new Date(m.utcDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      odds: {
        home: m.odds?.homeWin || 2.0,
        draw: m.odds?.draw || 3.0,
        away: m.odds?.awayWin || 3.0
      },
      context: `Match de ${m.competition.name}. Statut: ${m.status}`
    }));

    const slots = groupMatchesIntoSlots(mappedMatches);
    const plan = {
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      totalMatches: mappedMatches.length,
      slots
    };

    await AsyncStorage.setItem(DAILY_SCHEDULE_KEY, JSON.stringify(plan));
    return plan;
  } catch (error) {
    console.error('Erreur Scan Matinal:', error);
    throw error;
  }
}

function getLeagueFlag(code: string): string {
  const flags: Record<string, string> = { 'PL': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'FL1': '🇫🇷', 'BL1': '🇩🇪', 'SA': '🇮🇹', 'PD': '🇪🇸', 'CL': '🇪🇺' };
  return flags[code] || '⚽';
}

export async function getDailyPlan(): Promise<any | null> {
  const raw = await AsyncStorage.getItem(DAILY_SCHEDULE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function groupMatchesIntoSlots(matches: ScheduledMatchDetail[]): DailyScheduleSlot[] {
  const slotMap = new Map<string, ScheduledMatchDetail[]>();
  for (const m of matches) {
    const time = m.creneau_display;
    const existing = slotMap.get(time) || [];
    existing.push(m);
    slotMap.set(time, existing);
  }
  const slots: DailyScheduleSlot[] = [];
  for (const [key, slotMatches] of slotMap.entries()) {
    slots.push({
      slotId: `slot-${key.replace(':', '')}`,
      slotTimeDisplay: key,
      slotKickoffUtc: slotMatches[0].kickoff_utc,
      matchesCount: slotMatches.length,
      matches: slotMatches,
      isT90Reached: false,
      lineupsConfirmed: false
    });
  }
  return slots.sort((a, b) => a.slotKickoffUtc.localeCompare(b.slotKickoffUtc));
}

export async function checkAndUpdateT90Status(): Promise<void> {}
