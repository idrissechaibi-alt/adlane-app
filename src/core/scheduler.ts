// Scheduler Matinal - Données Football Réelles (Big 5 + Cups)
// Utilise l'API football-data.org filtrée par codes de compétition

import { DailyScheduleSlot, ScheduledMatchDetail } from '../types/database';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getAPIConfig, incrementRequestCount } from '../api/multiAPIManager';
import { fetchCompetitionOdds, FOOTBALL_DATA_TO_ODDS_SPORT_KEY, SimpleMatchOdds } from '../api/footballDataAPIs/theOddsAPI';
import { normalizeTeamName } from './teamNameMatch';

const DAILY_SCHEDULE_KEY = '@daily_schedule_json';
const FOOTBALL_DATA_KEY = 'app-adlane.football-data-api-key';
const LAST_SCAN_DATE_KEY = '@last_morning_scan_date';

/**
 * Date du jour au format YYYY-MM-DD en heure LOCALE de l'appareil (pas UTC) :
 * c'est la journée que l'utilisateur voit sur son écran, avec ses horaires de
 * coup d'envoi déjà affichés en local. football-data.org compare ses filtres
 * dateFrom/dateTo à la date UTC du match, donc un match très tôt/tard peut en
 * théorie tomber du mauvais côté de minuit — un compromis très mineur face au
 * bug réel (aucune date envoyée, fenêtre par défaut pouvant inclure hier).
 */
function todayLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Codes officiels Football-Data pour les Big 5 + Cups majeures
const COMPETITIONS = 'PL,PD,BL1,SA,FL1,CL,FAC,CDR,DFB,CIT,CDF';

/**
 * football-data.org (fixtures/résultats) ne fournit AUCUNE cote — l'ancien
 * code lisait m.odds.* qui n'existe simplement pas dans sa réponse, d'où des
 * cotes toujours à 0. On récupère les vraies cotes séparément via TheOddsAPI
 * (une requête par compétition présente dans le scan du jour) et on les
 * associe aux matchs par nom d'équipe normalisé.
 */
async function enrichWithRealOdds(
  matches: Array<{ leagueId: string; homeTeam: string; awayTeam: string; odds: ScheduledMatchDetail['odds'] }>
): Promise<void> {
  const apiConfig = await getAPIConfig();
  if (!apiConfig.theOddsApi) return;

  const competitionsPresent = Array.from(new Set(
    matches.map((m) => m.leagueId).filter((code) => FOOTBALL_DATA_TO_ODDS_SPORT_KEY[code])
  ));
  if (competitionsPresent.length === 0) return;

  const oddsIndex = new Map<string, SimpleMatchOdds>();

  for (const competitionCode of competitionsPresent) {
    const sportKey = FOOTBALL_DATA_TO_ODDS_SPORT_KEY[competitionCode];
    try {
      await incrementRequestCount('theOddsApi');
      const result = await fetchCompetitionOdds(apiConfig.theOddsApi, sportKey);
      if (result.success && result.data) {
        for (const entry of result.data) {
          const key = `${normalizeTeamName(entry.homeTeam)}|${normalizeTeamName(entry.awayTeam)}`;
          oddsIndex.set(key, entry);
        }
      } else {
        console.warn(`[Scan Matinal] TheOddsAPI (${sportKey}) sans résultat: ${result.error}`);
      }
    } catch (error: any) {
      console.warn(`[Scan Matinal] TheOddsAPI (${sportKey}) échec:`, error.message);
    }
  }

  for (const match of matches) {
    const key = `${normalizeTeamName(match.homeTeam)}|${normalizeTeamName(match.awayTeam)}`;
    const found = oddsIndex.get(key);
    if (found) {
      if (found.home != null) match.odds.home = found.home;
      if (found.draw != null) match.odds.draw = found.draw;
      if (found.away != null) match.odds.away = found.away;
      if (found.over_2_5 != null) match.odds.over_2_5 = found.over_2_5;
      if (found.under_2_5 != null) match.odds.under_2_5 = found.under_2_5;
    }
  }
}

export interface DailyPlan {
  date: string;
  generatedAt: string;
  totalMatches: number;
  slots: DailyScheduleSlot[];
}

export async function executeMorningScan(): Promise<DailyPlan> {
  console.log('🌅 [MORNING SCAN] Récupération des Big 5 + Cups...');
  const apiKey = await SecureStore.getItemAsync(FOOTBALL_DATA_KEY);

  if (!apiKey) {
    throw new Error('Clé API Football-Data manquante dans les paramètres.');
  }

  try {
    // Appel filtré sur les compétitions demandées ET sur la date du jour
    // (heure locale de l'appareil). Sans dateFrom/dateTo explicites,
    // football-data.org applique une fenêtre par défaut non documentée qui
    // peut inclure des matchs d'hier ou de demain selon l'heure d'appel —
    // c'est ce qui faisait apparaître le planning d'une autre journée.
    //
    // dateTo = demain (pas aujourd'hui) : dateFrom=dateTo=aujourd'hui donnait
    // "aucun match" à chaque appel, quelle que soit l'heure — signe que
    // dateTo est traité comme une borne EXCLUSIVE (minuit de ce jour-là), ce
    // qui exclut alors tous les matchs de la journée. Élargir dateTo à demain
    // couvre toute la journée d'aujourd'hui, que la borne soit inclusive ou
    // exclusive.
    const localToday = todayLocalDateString();
    const localTomorrow = todayLocalDateString(new Date(Date.now() + 24 * 3_600_000));
    await incrementRequestCount('footballData');
    const response = await fetch(
      `https://api.football-data.org/v4/matches?competitions=${COMPETITIONS}&dateFrom=${localToday}&dateTo=${localTomorrow}`,
      { headers: { 'X-Auth-Token': apiKey } }
    );

    if (!response.ok) {
      if (response.status === 403) throw new Error('API Football-Data : Votre plan ne permet pas d\'accéder à certaines coupes. Vérifiez votre clé.');
      throw new Error(`Erreur API (${response.status})`);
    }

    const data = await response.json();
    // dateTo=demain élargit volontairement la fenêtre (voir commentaire
    // ci-dessus) : on ne garde ici que ce qui tombe vraiment sur la journée
    // locale demandée, jamais les matchs de demain qui auraient pu se
    // glisser dans la réponse.
    const matches: any[] = (data.matches || []).filter(
      (m: any) => todayLocalDateString(new Date(m.utcDate)) === localToday
    );

    const mappedMatches: ScheduledMatchDetail[] = matches.map(m => ({
      id: `m-${m.id}`,
      leagueId: m.competition.code,
      leagueName: m.competition.name,
      flag: getLeagueFlag(m.competition.code),
      homeTeam: m.homeTeam.name,
      awayTeam: m.awayTeam.name,
      kickoff_utc: m.utcDate,
      creneau_display: new Date(m.utcDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      // football-data.org ne fournit aucune cote (son API n'expose pas ce
      // champ) : on part de 0 puis enrichWithRealOdds() remplit les vraies
      // valeurs via TheOddsAPI juste après, si une clé est configurée.
      odds: {
        home: 0,
        draw: 0,
        away: 0,
        btts_yes: 0,
        btts_no: 0,
        over_2_5: 0,
        under_2_5: 0
      },
      context: `Match de ${m.competition.name}. ${m.homeTeam.name} vs ${m.awayTeam.name}.`
    }));

    await enrichWithRealOdds(mappedMatches);

    const slots = groupMatchesIntoSlots(mappedMatches);
    const plan: DailyPlan = {
      date: localToday,
      generatedAt: new Date().toISOString(),
      totalMatches: mappedMatches.length,
      slots
    };

    await AsyncStorage.setItem(DAILY_SCHEDULE_KEY, JSON.stringify(plan));
    await AsyncStorage.setItem(LAST_SCAN_DATE_KEY, localToday);
    return plan;
  } catch (error: any) {
    console.error('Erreur Scan Matinal:', error.message);
    throw error;
  }
}

function getLeagueFlag(code: string): string {
  const flags: Record<string, string> = {
    'PL': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'FL1': '🇫🇷', 'BL1': '🇩🇪', 'SA': '🇮🇹', 'PD': '🇪🇸',
    'CL': '🇪🇺', 'FAC': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'CDR': '🇪🇸', 'DFB': '🇩🇪', 'CIT': '🇮🇹', 'CDF': '🇫🇷'
  };
  return flags[code] || '⚽';
}

export async function getDailyPlan(): Promise<DailyPlan | null> {
  const raw = await AsyncStorage.getItem(DAILY_SCHEDULE_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** Heure locale (0-23) à partir de laquelle le scan matinal se déclenche tout seul. */
const AUTO_SCAN_HOUR = 7;

/**
 * Déclenche le scan matinal automatiquement, sans action de l'utilisateur.
 * Android ne garantit pas une exécution pile à 7h00 (le système décide du
 * moment exact de la tâche de fond, au mieux toutes les ~15 min) : on se
 * contente donc du PREMIER tour, après 7h locales, où la journée n'a pas
 * encore été scannée — même principe que le bilan de minuit. Idempotent :
 * un tour de plus le même jour après 7h ne relance rien.
 */
export async function runMorningScanIfDue(): Promise<boolean> {
  const now = new Date();
  if (now.getHours() < AUTO_SCAN_HOUR) return false;

  const today = todayLocalDateString(now);
  const lastScanDate = await AsyncStorage.getItem(LAST_SCAN_DATE_KEY);
  if (lastScanDate === today) return false;

  await executeMorningScan();
  return true;
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
