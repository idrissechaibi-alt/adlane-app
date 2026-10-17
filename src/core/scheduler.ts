// Scheduler Matinal - Données Football Réelles (Big 5 + Cups)
// Utilise l'API football-data.org filtrée par codes de compétition

import { DailyScheduleSlot, ScheduledMatchDetail } from '../types/database';
import AsyncStorage from './kvStore';
import * as SecureStore from 'expo-secure-store';
import { getAPIConfig, getQuotaUsage, incrementRequestCount } from '../api/multiAPIManager';
import { fetchCompetitionOdds, FOOTBALL_DATA_TO_ODDS_SPORT_KEY, SimpleMatchOdds } from '../api/footballDataAPIs/theOddsAPI';
import { normalizeTeamName, namesLikelyMatch } from './teamNameMatch';
import { fetchWithTimeout } from './httpTimeout';
import { sendTelegramMessage } from './telegram';
import { ensureDailyUniverse } from './matchUniverse';

const DAILY_SCHEDULE_KEY = '@daily_schedule_json';
const FOOTBALL_DATA_KEY = 'app-adlane.football-data-api-key';
const LAST_SCAN_DATE_KEY = '@last_morning_scan_date';
const LAST_TELEGRAM_PLAN_DATE_KEY = '@last_telegram_plan_date';

/**
 * Date du jour au format YYYY-MM-DD en heure LOCALE de l'appareil (pas UTC) :
 * c'est la journée que l'utilisateur voit sur son écran, avec ses horaires de
 * coup d'envoi déjà affichés en local. football-data.org compare ses filtres
 * dateFrom/dateTo à la date UTC du match, donc un match très tôt/tard peut en
 * théorie tomber du mauvais côté de minuit — un compromis très mineur face au
 * bug réel (aucune date envoyée, fenêtre par défaut pouvant inclure hier).
 */
export function todayLocalDateString(date: Date = new Date()): string {
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
  // Quota mensuel épuisé (relevé gratuit sur /sports) : aucune requête de cotes envoyée pour rien.
  const quota = await getQuotaUsage('theOddsApi', apiConfig).catch(() => null);
  if (quota?.live && quota.used >= quota.limit) return;

  const competitionsPresent = Array.from(new Set(
    matches.map((m) => m.leagueId).filter((code) => FOOTBALL_DATA_TO_ODDS_SPORT_KEY[code])
  ));
  if (competitionsPresent.length === 0) return;

  const oddsIndex = new Map<string, SimpleMatchOdds>();
  const allOddsEntries: SimpleMatchOdds[] = [];

  for (const competitionCode of competitionsPresent) {
    const sportKey = FOOTBALL_DATA_TO_ODDS_SPORT_KEY[competitionCode];
    try {
      await incrementRequestCount('theOddsApi');
      const result = await fetchCompetitionOdds(apiConfig.theOddsApi, sportKey);
      if (result.success && result.data) {
        for (const entry of result.data) {
          const key = `${normalizeTeamName(entry.homeTeam)}|${normalizeTeamName(entry.awayTeam)}`;
          oddsIndex.set(key, entry);
          allOddsEntries.push(entry);
        }
      } else {
        console.warn(`[Scan Matinal] TheOddsAPI (${sportKey}) sans résultat: ${result.error}`);
      }
    } catch (error: any) {
      console.warn(`[Scan Matinal] TheOddsAPI (${sportKey}) échec:`, error.message);
    }
  }

  // La correspondance exacte échoue souvent hors Premier League : les noms
  // anglais coïncident déjà entre football-data.org et TheOddsAPI, mais
  // "Olympique de Marseille"/"Olympique Lyonnais"/"Racing Club de Lens" (nom
  // officiel complet) ne correspondent jamais exactement à "Marseille"/
  // "Lyon"/"Lens" (nom court des bookmakers) — d'où des propositions qui ne
  // portaient plus que sur la Premier League. Repli en inclusion partielle,
  // une seule fois par entrée déjà utilisée par ailleurs.
  const usedEntries = new Set<SimpleMatchOdds>();
  for (const match of matches) {
    const key = `${normalizeTeamName(match.homeTeam)}|${normalizeTeamName(match.awayTeam)}`;
    let found = oddsIndex.get(key);

    if (!found) {
      const homeNorm = normalizeTeamName(match.homeTeam);
      const awayNorm = normalizeTeamName(match.awayTeam);
      found = allOddsEntries.find((entry) =>
        !usedEntries.has(entry) &&
        namesLikelyMatch(homeNorm, normalizeTeamName(entry.homeTeam)) &&
        namesLikelyMatch(awayNorm, normalizeTeamName(entry.awayTeam))
      );
    }

    if (found) {
      usedEntries.add(found);
      if (found.home != null) match.odds.home = found.home;
      if (found.draw != null) match.odds.draw = found.draw;
      if (found.away != null) match.odds.away = found.away;
      if (found.over_2_5 != null) match.odds.over_2_5 = found.over_2_5;
      if (found.under_2_5 != null) match.odds.under_2_5 = found.under_2_5;
      // BTTS restait toujours à 0 (jamais assignée) : les jambes BTTS du
      // moteur de propositions avaient donc une cote factice de 0.
      if (found.btts_yes != null) match.odds.btts_yes = found.btts_yes;
      if (found.btts_no != null) match.odds.btts_no = found.btts_no;
    }
  }
}

function hasCoreOdds(odds: ScheduledMatchDetail['odds']): boolean {
  return [odds.home, odds.draw, odds.away, odds.over_2_5, odds.under_2_5].every((o) => o > 1);
}

const API_FOOTBALL_ODDS_MAX_MATCHES = 20;

/** Première cote trouvée pour (pari, valeur), tous bookmakers confondus. */
function findOdd(bookmakers: any[], betName: string, value: string): number | null {
  for (const bookmaker of bookmakers) {
    const bet = (bookmaker.bets ?? []).find((b: any) => b.name === betName);
    const entry = bet?.values?.find((v: any) => String(v.value) === value);
    const odd = entry ? Number(entry.odd) : NaN;
    if (Number.isFinite(odd) && odd > 1) return odd;
  }
  return null;
}

/**
 * Repli quand TheOddsAPI ne fournit rien (clé absente ou match non couvert) :
 * cotes réelles d'avant-match via API-Football (/odds?fixture=), le match
 * étant retrouvé dans l'univers du jour par nom d'équipe. Sans ce repli, tout
 * match sans cote était écarté du scan en direct (un seul marché proposé,
 * rien à la 60e).
 */
const S365 = 'https://webws.365scores.com/web';
const S365_PARAMS = 'appTypeId=5&langId=1&timezoneName=UTC&userCountryId=1';

function poissonOver(lambda: number, line: number): number {
  // P(N > line) pour une ligne en .5 : 1 - P(N <= floor(line)).
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let k = 1; k <= Math.floor(line); k++) {
    term *= lambda / k;
    cdf += term;
  }
  return 1 - cdf;
}

/** Total de buts attendu (Poisson) qui reproduit la probabilité « Plus de `line` » du bookmaker (marge retirée). */
function lambdaForOver(pOver: number, line: number): number {
  let lo = 0.2;
  let hi = 7;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (poissonOver(mid, line) < pOver) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 3e repli, GRATUIT et sans quota : cotes bet365 d'avant-match publiées par 365Scores. Le 1X2 vient tel quel ; le total
 * vient à la ligne que 365Scores met en avant (souvent 2.5, parfois 1.5 ou 3.5). Pour une autre ligne que 2.5, les cotes
 * Plus / Moins de 2.5 sont DÉDUITES (même total attendu, loi de Poisson, même marge que la ligne publiée) : elles servent
 * à estimer les buts attendus du match, jamais affichées comme une cote bookmaker à jouer.
 */
async function enrichWith365ScoresOdds(matches: ScheduledMatchDetail[]): Promise<number> {
  const missing = matches.filter((m) => !hasCoreOdds(m.odds));
  if (missing.length === 0) return 0;
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  };
  const dates = Array.from(new Set(missing.map((m) => fmt(m.kickoff_utc))));
  const games: any[] = [];
  for (const d of dates) {
    try {
      const res = await fetchWithTimeout(`${S365}/games/allscores/?${S365_PARAMS}&sports=1&startDate=${d}&endDate=${d}&showOdds=true`, {}, 15_000);
      if (res.ok) games.push(...(((await res.json()) as any)?.games ?? []));
    } catch {
      // source facultative
    }
  }
  let filled = 0;
  for (const match of missing) {
    const home = normalizeTeamName(match.homeTeam);
    const away = normalizeTeamName(match.awayTeam);
    const game = games.find((g) => g?.homeCompetitor?.name && namesLikelyMatch(home, normalizeTeamName(g.homeCompetitor.name)) && namesLikelyMatch(away, normalizeTeamName(g.awayCompetitor.name)));
    if (!game) continue;
    const rate = (odds: any, name: string) => Number(odds?.options?.find((o: any) => o.name === name)?.rate?.decimal) || 0;
    if (game.odds?.lineTypeId === 1) {
      if (!(match.odds.home > 1)) match.odds.home = rate(game.odds, '1');
      if (!(match.odds.draw > 1)) match.odds.draw = rate(game.odds, 'X');
      if (!(match.odds.away > 1)) match.odds.away = rate(game.odds, '2');
    }
    if (!(match.odds.over_2_5 > 1 && match.odds.under_2_5 > 1)) {
      try {
        const res = await fetchWithTimeout(`${S365}/game/?${S365_PARAMS}&gameId=${game.id}&topBookmaker=14&showOdds=true`, {}, 15_000);
        const detail: any = res.ok ? await res.json() : null;
        const preds: any[] = detail?.game?.promotedPredictions?.predictions ?? [];
        const total = preds.map((p) => p.odds).find((o) => o?.lineTypeId === 3);
        const line = Number(total?.internalOptionValue);
        const over = rate(total, 'Over');
        const under = rate(total, 'Under');
        if (Number.isFinite(line) && over > 1 && under > 1) {
          if (line === 2.5) {
            match.odds.over_2_5 = over;
            match.odds.under_2_5 = under;
          } else {
            const book = 1 / over + 1 / under;
            const lambda = lambdaForOver(1 / over / book, line);
            const p25 = poissonOver(lambda, 2.5);
            match.odds.over_2_5 = Math.round((1 / (p25 * book)) * 100) / 100;
            match.odds.under_2_5 = Math.round((1 / ((1 - p25) * book)) * 100) / 100;
          }
        }
      } catch {
        // source facultative
      }
    }
    if (hasCoreOdds(match.odds)) filled++;
  }
  return filled;
}

const PLAN_ODDS_REFRESH_KEY = '@plan_odds_refresh_at';

/**
 * Les cotes d'avant-match sont souvent publiées APRÈS le scan de la nuit : chaque heure, les matchs du planning encore
 * sans cotes sont recomplétés (TheOddsAPI / API-Football si quota, sinon 365Scores), et le planning est réenregistré.
 */
export async function refreshPlanOddsIfDue(): Promise<number> {
  const last = Number((await AsyncStorage.getItem(PLAN_ODDS_REFRESH_KEY)) ?? 0);
  if (Date.now() - last < 60 * 60_000) return 0;
  const plan = await getDailyPlan();
  if (!plan) return 0;
  const matches = plan.slots.flatMap((s) => s.matches as ScheduledMatchDetail[]).filter((m) => Date.parse(m.kickoff_utc) > Date.now() && !hasCoreOdds(m.odds));
  await AsyncStorage.setItem(PLAN_ODDS_REFRESH_KEY, String(Date.now()));
  if (matches.length === 0) return 0;
  await enrichWithApiFootballOdds(matches).catch(() => {});
  const filled = await enrichWith365ScoresOdds(matches).catch(() => 0);
  await AsyncStorage.setItem(DAILY_SCHEDULE_KEY, JSON.stringify(plan));
  return filled;
}

async function enrichWithApiFootballOdds(matches: ScheduledMatchDetail[]): Promise<void> {
  const missing = matches.filter((m) => !hasCoreOdds(m.odds));
  if (missing.length === 0) return;

  const apiConfig = await getAPIConfig();
  if (!apiConfig.apiFootball) return;

  const universe = await ensureDailyUniverse().catch(() => []);
  if (universe.length === 0) return;

  for (const match of missing.slice(0, API_FOOTBALL_ODDS_MAX_MATCHES)) {
    const home = normalizeTeamName(match.homeTeam);
    const away = normalizeTeamName(match.awayTeam);
    const fixture = universe.find(
      (u) => namesLikelyMatch(home, normalizeTeamName(u.homeTeam)) && namesLikelyMatch(away, normalizeTeamName(u.awayTeam))
    );
    if (!fixture) continue;

    try {
      await incrementRequestCount('apiFootball');
      const response = await fetchWithTimeout(`https://v3.football.api-sports.io/odds?fixture=${fixture.fixtureId}`, {
        headers: {
          'x-rapidapi-key': apiConfig.apiFootball,
          'x-rapidapi-host': 'v3.football.api-sports.io',
          'x-apisports-key': apiConfig.apiFootball,
        },
      });
      if (!response.ok) continue;
      const data = await response.json();
      const bookmakers: any[] = data.response?.[0]?.bookmakers ?? [];
      if (bookmakers.length === 0) continue;

      const assign = (key: keyof ScheduledMatchDetail['odds'], betName: string, value: string) => {
        if (match.odds[key] > 1) return;
        const odd = findOdd(bookmakers, betName, value);
        if (odd) match.odds[key] = odd;
      };
      assign('home', 'Match Winner', 'Home');
      assign('draw', 'Match Winner', 'Draw');
      assign('away', 'Match Winner', 'Away');
      assign('over_2_5', 'Goals Over/Under', 'Over 2.5');
      assign('under_2_5', 'Goals Over/Under', 'Under 2.5');
      assign('btts_yes', 'Both Teams Score', 'Yes');
      assign('btts_no', 'Both Teams Score', 'No');
    } catch (error: any) {
      console.warn(`[Scan Matinal] Cotes API-Football indisponibles pour ${match.homeTeam} vs ${match.awayTeam}:`, error.message);
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
    const response = await fetchWithTimeout(
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

    // Planning déjà construit aujourd'hui (rafraîchissement manuel) : les cotes et compositions déjà trouvées sont gardées,
    // seules les manquantes sont recherchées — un rafraîchissement ne doit jamais effacer ce que l'app avait déjà.
    const previous = await getDailyPlan().catch(() => null);
    if (previous?.date === localToday) {
      const old = new Map(previous.slots.flatMap((s) => s.matches as ScheduledMatchDetail[]).map((m) => [m.id, m]));
      for (const m of mappedMatches) {
        const o = old.get(m.id);
        if (!o) continue;
        for (const k of Object.keys(m.odds) as Array<keyof ScheduledMatchDetail['odds']>) if (!(m.odds[k] > 1) && o.odds?.[k] > 1) m.odds[k] = o.odds[k];
        if (o.lineups && !m.lineups) m.lineups = o.lineups;
      }
    }

    await enrichWithRealOdds(mappedMatches);
    await enrichWithApiFootballOdds(mappedMatches);
    await enrichWith365ScoresOdds(mappedMatches).catch(() => 0);

    const slots = groupMatchesIntoSlots(mappedMatches);
    const plan: DailyPlan = {
      date: localToday,
      generatedAt: new Date().toISOString(),
      totalMatches: mappedMatches.length,
      slots
    };

    await AsyncStorage.setItem(DAILY_SCHEDULE_KEY, JSON.stringify(plan));
    await AsyncStorage.setItem(LAST_SCAN_DATE_KEY, localToday);

    // Une seule fois par jour sur Telegram, même si executeMorningScan est
    // rappelée plusieurs fois (rafraîchissement manuel depuis l'écran
    // Planning, en plus du scan automatique) — sans ce garde-fou, le même
    // "aucun match aujourd'hui" partait sur Telegram à chaque rafraîchissement.
    const lastTelegramPlanDate = await AsyncStorage.getItem(LAST_TELEGRAM_PLAN_DATE_KEY);
    if (lastTelegramPlanDate !== localToday) {
      const sent = await sendTelegramMessage(formatMorningPlanMessage(plan));
      if (sent) await AsyncStorage.setItem(LAST_TELEGRAM_PLAN_DATE_KEY, localToday);
    }

    return plan;
  } catch (error: any) {
    console.error('Erreur Scan Matinal:', error.message);
    throw error;
  }
}

/** Telegram refuse un message au-delà de 4096 caractères. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

function formatMorningPlanMessage(plan: DailyPlan): string {
  if (plan.totalMatches === 0) {
    return `📅 Planning du ${plan.date} : aucun match aujourd'hui sur les 5 grands championnats.`;
  }

  const lines = [`📅 Planning du ${plan.date} — ${plan.totalMatches} match(s), ${plan.slots.length} créneau(x)`];
  for (const slot of plan.slots) {
    lines.push('', `⏰ ${slot.slotTimeDisplay} (${slot.matchesCount})`);
    for (const m of slot.matches) {
      lines.push(`${m.flag} ${m.homeTeam} - ${m.awayTeam} (${m.leagueName})`);
    }
  }

  const text = lines.join('\n');
  return text.length > TELEGRAM_MAX_MESSAGE_LENGTH
    ? `${text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH)}\n… (liste tronquée, voir l'app pour le détail complet)`
    : text;
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
const AUTO_SCAN_HOUR = 1;

/**
 * Déclenche le scan matinal automatiquement, sans action de l'utilisateur.
 * Android ne garantit pas une exécution pile à 1h00 (le système décide du
 * moment exact de la tâche de fond, au mieux toutes les ~15 min) : on se
 * contente donc du PREMIER tour, après 1h locale, où la journée n'a pas
 * encore été scannée — même principe que le bilan de minuit. Idempotent :
 * un tour de plus le même jour après 1h ne relance rien.
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
