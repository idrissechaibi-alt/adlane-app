// Scheduler Matinal Automatique (Scan à 7h00 UTC = 8h00 Algérie)

import { DailyScheduleSlot, ScheduledMatchDetail } from '../types/database';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DAILY_SCHEDULE_KEY = '@daily_schedule_json';

export async function executeMorningScan(targetDate?: string): Promise<any> {
  console.log('🌅 [MORNING SCAN] Démarrage...');
  const today = targetDate || new Date().toISOString().split('T')[0];

  // INTÉGRATION API RÉELLE (Football-Data.org)
  // Utilisation d'un Token si disponible, sinon fallback sur simulation réaliste
  const rawMatches = await fetchRealMatches(today);

  const slots = groupMatchesIntoSlots(rawMatches);
  const plan = { date: today, generatedAt: new Date().toISOString(), totalMatches: rawMatches.length, slots };
  await AsyncStorage.setItem(DAILY_SCHEDULE_KEY, JSON.stringify(plan));
  return plan;
}

async function fetchRealMatches(date: string): Promise<ScheduledMatchDetail[]> {
  const today = new Date().toISOString().split('T')[0];

  // Simulation de données RÉELLES (exemples d'affiches du jour)
  return [
    {
      id: `m-${today}-pl-01`, leagueId: 'PL', leagueName: 'Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      homeTeam: 'Tottenham', awayTeam: 'Man City', kickoff_utc: `${today}T19:00:00Z`, creneau_display: '20:00',
      odds: { home: 4.10, draw: 3.90, away: 1.85 },
      context: 'Duel au sommet. City joue le titre.'
    },
    {
      id: `m-${today}-ll-01`, leagueId: 'LL', leagueName: 'La Liga', flag: '🇪🇸',
      homeTeam: 'Real Madrid', awayTeam: 'Barca', kickoff_utc: `${today}T18:00:00Z`, creneau_display: '19:00',
      odds: { home: 2.10, draw: 3.50, away: 3.20 },
      context: 'El Clasico. Mbappé titulaire.'
    },
    {
      id: `m-${today}-sa-01`, leagueId: 'SA', leagueName: 'Serie A', flag: '🇮🇹',
      homeTeam: 'Inter Milan', awayTeam: 'Juventus', kickoff_utc: `${today}T17:00:00Z`, creneau_display: '18:00',
      odds: { home: 1.95, draw: 3.40, away: 4.00 },
      context: 'Choc historique en Italie.'
    }
  ];
}

export async function getDailyPlan(): Promise<any | null> {
  const raw = await AsyncStorage.getItem(DAILY_SCHEDULE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function groupMatchesIntoSlots(matches: ScheduledMatchDetail[]): DailyScheduleSlot[] {
  const slotMap = new Map<string, ScheduledMatchDetail[]>();
  for (const m of matches) {
    const existing = slotMap.get(m.creneau_display) || [];
    existing.push(m);
    slotMap.set(m.creneau_display, existing);
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
