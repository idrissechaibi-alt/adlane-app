// Tâche native planifiée (WorkManager côté Android) : continue de tourner
// quand l'app est fermée.
//
// ⚠️ Plancher système : Android n'autorise pas mieux que ~15 minutes pour une
// tâche périodique, et décide lui-même du moment exact selon la batterie et le
// réseau. Le pas de 3 minutes demandé n'est possible que pendant que l'app est
// ouverte (boucle de premier plan dans App.tsx, qui appelle le même tick).

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAPIConfig } from '../api/multiAPIManager';
import { API_FOOTBALL_RESERVE, spendDirectBudget } from './requestBudget';
import { ensureDailyUniverse } from './matchUniverse';
import { ensureFictionalDailyProgram, getFictionalProgramStatus } from './fictionalProgram';
import { runLiveMarkerTick } from './liveMarkers';
import { fetchLiveFixtures, fetchOmnirouteAllLiveFixtures, LiveFixture } from './halftimeMonitor';
import { consolidateLearning } from './autoLearn';
import { OmnirouteAttempt } from './omniroute';
import { enrichFocusMatches, loadOmnirouteConfig } from './focusEnrichment';
import { runInPlayComboTick, InternationalBreakTickDiagnostics } from './inPlayCombos';
import { runNightlyReviewIfDue } from './dailyReview';
import { autoProbeWebCapability } from './llmRouter';
import { getRecentSearchSource, probeAnySearch } from './webSearch';
import { fetchAllSportsLive } from '../api/footballDataAPIs/allSports';
import { syntheticFixtureId } from './halftimeMonitor';
import { fetchSofaLiveEvents, registerSofaEvents } from '../api/footballDataAPIs/sofaScore';
import { getDailyPlan, runMorningScanIfDue } from './scheduler';
import { reconcileScoutingAnalyses } from './scoutingReview';
import { refreshDueLineups } from './lineupRefresh';
import { readLearnedModel } from './learnStore';
import { namesLikelyMatch, normalizeTeamName } from './teamNameMatch';

interface SharedLiveFixturesResult {
  /** Matchs en direct des 5 grands championnats et coupes (API-Football) :
   * pipeline RÉEL uniquement. */
  fixtures: LiveFixture[];
  /** Matchs en direct du reste du monde, relevés par les fournisseurs IA
   * (modèles avec accès internet) : pipe FICTIF uniquement. */
  fictionalFixtures: LiveFixture[];
  /** D'où viennent (ou pourquoi pas) les fixtures — sert au diagnostic du
   * bouton "forcer le scan" (EvolutionScreen) : sans ça, un relevé vide est
   * indiscernable d'un vrai calme (aucun match en ce moment) ou d'Omniroute
   * non configuré. */
  source: 'api_football' | 'omniroute' | 'aucune_omniroute_non_configure' | 'aucune_echec_omniroute';
  /** Raison précise d'un repli sur Omniroute côté API-Football (message
   * d'erreur exact de data.errors, ou HTTP xxx) — sans ça, "source: omniroute"
   * ne dit pas si la clé est en cause, le quota, ou (fréquent chez
   * API-Football) un endpoint restreint sur certains plans, comme
   * /fixtures?live=all qui peut être hors plan alors que /status répond très
   * bien. Absent quand source vaut 'api_football' (pas d'échec à expliquer). */
  apiFootballError?: string;
}

/**
 * Un seul relevé live par tour, partagé entre runLiveMarkerTick et
 * runInPlayComboTick (avant ce partage, chacun refaisait sa propre requête,
 * doublant la consommation du quota API-Football à chaque tour — de quoi
 * l'épuiser en cours d'après-midi et rater silencieusement les scans du
 * soir).
 *
 * Repli Omniroute FORCÉ : dès que la clé API-Football manque, que son quota
 * du jour est épuisé, ou que l'appel échoue, Omniroute (auto-hébergé,
 * scraping, sans quota) prend le relais et découvre LUI-MÊME tous les
 * matchs actuellement en cours (fetchOmnirouteAllLiveFixtures) — sans
 * dépendre du programme du jour construit par API-Football (matchUniverse) :
 * une première version de ce repli ne faisait que RE-VÉRIFIER des matchs
 * déjà connus de matchUniverse, et se retrouvait donc sans aucun candidat à
 * interroger (0 appel, pas un appel qui échoue) si matchUniverse n'avait
 * jamais pu se construire faute de budget — exactement le blocage que ce
 * repli est censé lever.
 */
const LIVE_FIXTURES_CACHE_KEY = '@shared_live_fixtures_cache';
/** Durée de réutilisation du relevé en direct API-Football. */
const LIVE_FIXTURES_CACHE_MS = 15 * 60_000;
/** Fenêtre (minutes depuis le coup d'envoi) pendant laquelle un match du planning réel peut être en direct. */
const REAL_MATCH_LIVE_WINDOW = { from: -5, to: 125 };
let liveFixturesCache: { at: number; fixtures: LiveFixture[] } | null = null;

async function readCachedLiveFixtures(): Promise<LiveFixture[] | null> {
  try {
    if (!liveFixturesCache) {
      const raw = await AsyncStorage.getItem(LIVE_FIXTURES_CACHE_KEY);
      liveFixturesCache = raw ? JSON.parse(raw) : null;
    }
  } catch {
    liveFixturesCache = null;
  }
  if (!liveFixturesCache) return null;
  const elapsedMinutes = Math.floor((Date.now() - liveFixturesCache.at) / 60_000);
  if (elapsedMinutes * 60_000 >= LIVE_FIXTURES_CACHE_MS) return null;

  // Minute avancée du temps écoulé ; un match qui aurait pu changer de
  // période entre-temps (fin de 1ère mi-temps, fin de match) est écarté
  // plutôt que présenté avec un statut périmé.
  return liveFixturesCache.fixtures
    .map((f) => ({ ...f, minute: f.minute + elapsedMinutes }))
    .filter((f) => (f.statusShort === '1H' ? f.minute <= 45 : f.statusShort === '2H' ? f.minute <= 90 : false));
}

async function writeCachedLiveFixtures(fixtures: LiveFixture[]): Promise<void> {
  liveFixturesCache = { at: Date.now(), fixtures };
  try {
    await AsyncStorage.setItem(LIVE_FIXTURES_CACHE_KEY, JSON.stringify(liveFixturesCache));
  } catch {
    // cache best-effort
  }
}

const FICTIONAL_LIVE_CACHE_KEY = '@fictional_live_fixtures_cache';
let fictionalLiveCache: { at: number; fixtures: LiveFixture[] } | null = null;

/**
 * Relevé en direct pour le pipe fictif, par les fournisseurs IA (jamais
 * API-Football, réservé aux paris réels). Réutilisé 15 min comme le relevé
 * réel : chaque relevé coûte des appels IA.
 */
async function fetchFictionalLiveFixtures(realLive: LiveFixture[]): Promise<LiveFixture[]> {
  try {
    if (!fictionalLiveCache) {
      const raw = await AsyncStorage.getItem(FICTIONAL_LIVE_CACHE_KEY);
      fictionalLiveCache = raw ? JSON.parse(raw) : null;
    }
  } catch {
    fictionalLiveCache = null;
  }

  let fixtures: LiveFixture[];
  let fromSofaScore = false;

  // SofaScore d'abord : source structurée et gratuite (score, minute, période
  // de TOUS les matchs en direct du monde en un appel), sans modèle ni
  // recherche web. Les fournisseurs IA ne servent plus qu'en repli.
  try {
    const sofaEvents = (await fetchSofaLiveEvents()).filter((e) => ['1H', 'HT', '2H'].includes(e.statusShort));
    if (sofaEvents.length > 0) {
      const ids = await registerSofaEvents(sofaEvents);
      fixtures = sofaEvents.map((e) => ({
        statusShort: e.statusShort,
        homeTeam: e.homeTeam,
        awayTeam: e.awayTeam,
        homeGoals: e.homeGoals,
        awayGoals: e.awayGoals,
        fixtureId: ids.get(e.eventId)!,
        minute: e.minute,
        league: e.league,
        sofaEventId: e.eventId,
      }));
      fromSofaScore = true;
    } else {
      fixtures = [];
    }
  } catch (error: any) {
    console.warn('[Tâche de fond] Relevé SofaScore indisponible, repli fournisseurs IA:', error?.message);
    fixtures = [];
  }

  // AllSportsApi : ajoute les matchs de son plan que SofaScore n'a pas relevés
  // (aucun des 5 grands championnats n'y figure : tout est fictif).
  try {
    const key = (await getAPIConfig()).allSports?.trim();
    if (key) {
      const dateKey = new Date().toISOString().slice(0, 10);
      for (const e of await fetchAllSportsLive(key)) {
        const dup = fixtures.some(
          (f) =>
            namesLikelyMatch(normalizeTeamName(f.homeTeam), normalizeTeamName(e.homeTeam)) &&
            namesLikelyMatch(normalizeTeamName(f.awayTeam), normalizeTeamName(e.awayTeam))
        );
        if (dup) continue;
        fixtures.push({
          statusShort: e.statusShort,
          homeTeam: e.homeTeam,
          awayTeam: e.awayTeam,
          homeGoals: e.homeGoals,
          awayGoals: e.awayGoals,
          fixtureId: syntheticFixtureId(e.homeTeam, e.awayTeam, dateKey),
          minute: e.minute,
          league: e.league,
        });
        fromSofaScore = true;
      }
    }
  } catch (error: any) {
    console.warn('[Tâche de fond] AllSportsApi indisponible:', error?.message);
  }

  const elapsedMinutes = fictionalLiveCache ? Math.floor((Date.now() - fictionalLiveCache.at) / 60_000) : Infinity;
  if (fromSofaScore) {
    // déjà relevé
  } else if (fictionalLiveCache && elapsedMinutes * 60_000 < LIVE_FIXTURES_CACHE_MS) {
    fixtures = fictionalLiveCache.fixtures
      .map((f) => ({ ...f, minute: f.minute + elapsedMinutes }))
      .filter((f) => (f.statusShort === '1H' ? f.minute <= 45 : f.statusShort === '2H' ? f.minute <= 90 : false));
  } else {
    const omnirouteConfig = await loadOmnirouteConfig();
    if (!omnirouteConfig) return [];
    fixtures = await fetchOmnirouteAllLiveFixtures(omnirouteConfig).catch(() => [] as LiveFixture[]);
    fictionalLiveCache = { at: Date.now(), fixtures };
    try {
      await AsyncStorage.setItem(FICTIONAL_LIVE_CACHE_KEY, JSON.stringify(fictionalLiveCache));
    } catch {
      // cache best-effort
    }
  }

  // Un match des 5 grands championnats déjà relevé par API-Football relève
  // du pipeline réel, pas du fictif.
  return fixtures.filter(
    (f) =>
      !realLive.some(
        (r) =>
          namesLikelyMatch(normalizeTeamName(r.homeTeam), normalizeTeamName(f.homeTeam)) &&
          namesLikelyMatch(normalizeTeamName(r.awayTeam), normalizeTeamName(f.awayTeam))
      )
  );
}

async function hasRealMatchInLiveWindow(): Promise<boolean> {
  try {
    const plan = await getDailyPlan();
    if (!plan) return false;
    const now = Date.now();
    return plan.slots.some((slot) =>
      (slot.matches as Array<{ kickoff_utc: string }>).some((m) => {
        const minutes = (now - Date.parse(m.kickoff_utc)) / 60_000;
        return minutes >= REAL_MATCH_LIVE_WINDOW.from && minutes <= REAL_MATCH_LIVE_WINDOW.to;
      })
    );
  } catch {
    return true; // planning illisible : on préfère relever que rater un pari réel
  }
}

async function fetchSharedLiveFixtures(): Promise<SharedLiveFixturesResult> {
  const apiConfig = await getAPIConfig();
  let apiFootballError: string | undefined;
  let fixtures: LiveFixture[] = [];
  let source: SharedLiveFixturesResult['source'] = 'api_football';

  // Relevé récent réutilisé (minutes avancées du temps écoulé) : la boucle de
  // premier plan repasse toutes les 3 min, et une requête par passage
  // épuisait le quota du jour en une vingtaine de minutes d'app ouverte.
  const cached = await readCachedLiveFixtures();
  if (cached) {
    fixtures = cached;
  } else if (!(await hasRealMatchInLiveWindow())) {
    // Aucun match du planning réel (5 grands championnats) ne peut être en
    // cours : pas de requête API-Football (quota gardé pour les heures de match).
    fixtures = [];
  } else if (apiConfig.apiFootball && (await spendDirectBudget('apiFootball', API_FOOTBALL_RESERVE.settlement))) {
    try {
      fixtures = await fetchLiveFixtures(apiConfig.apiFootball);
      await writeCachedLiveFixtures(fixtures);
    } catch (error: any) {
      apiFootballError = error?.message || 'erreur inconnue';
      source = 'aucune_echec_omniroute';
      console.warn('[Tâche de fond] Relevé live API-Football échoué:', error.message);
    }
  } else {
    apiFootballError = apiConfig.apiFootball ? 'quota du jour atteint (réserve gardée pour le règlement)' : 'clé absente (Gestion des API)';
    source = 'aucune_echec_omniroute';
  }

  const fictionalFixtures = await fetchFictionalLiveFixtures(fixtures).catch(() => [] as LiveFixture[]);
  return { fixtures, fictionalFixtures, source, apiFootballError };
}

export const AUTOLEARN_TASK_NAME = 'adlane-autolearn-tick';
const MINIMUM_INTERVAL_MINUTES = 15; // plancher Android, inutile de descendre

const NATIVE_BG_TICK_LOG_KEY = '@native_bg_tick_log';
const MAX_LOGGED_TICKS = 200;

/** Horodatage à chaque réveil de la VRAIE tâche native (voir
 * TaskManager.defineTask plus bas) — jamais depuis la boucle de premier plan
 * (3 min, seulement app ouverte) ni le bouton "Forcer le scan", qui ne
 * disent rien de la fréquence réelle décidée par Android en arrière-plan.
 * Best-effort : un échec ici ne doit jamais faire échouer le tour lui-même. */
async function recordNativeBackgroundTick(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(NATIVE_BG_TICK_LOG_KEY);
    const log: string[] = raw ? JSON.parse(raw) : [];
    log.push(new Date().toISOString());
    await AsyncStorage.setItem(NATIVE_BG_TICK_LOG_KEY, JSON.stringify(log.slice(-MAX_LOGGED_TICKS)));
  } catch (error: any) {
    console.warn('[Tâche de fond] Enregistrement du réveil natif échoué:', error?.message);
  }
}

export interface NativeBackgroundTickStats {
  /** null si la tâche native ne s'est jamais réveillée depuis l'installation
   * (ou depuis la dernière purge du stockage) — à distinguer d'un simple
   * délai : voir ticksLast24h pour la fréquence réelle récente. */
  lastTickAt: string | null;
  ticksLast24h: number;
}

/**
 * Fréquence RÉELLE des réveils de la tâche native en arrière-plan — sert à
 * distinguer "le pipeline ne détecte rien" de "Android ne réveille quasiment
 * jamais la tâche" (optimisation de batterie, Doze). Le plancher Android
 * annoncé (~15 min) n'est qu'un minimum demandé, jamais une garantie : sans
 * ce chiffre, un manque de propositions est indiscernable de l'intérieur de
 * l'app entre ces deux causes très différentes (l'une se corrige dans les
 * réglages Android, l'autre nulle part dans ce code).
 */
export async function getNativeBackgroundTickStats(): Promise<NativeBackgroundTickStats> {
  try {
    const raw = await AsyncStorage.getItem(NATIVE_BG_TICK_LOG_KEY);
    const log: string[] = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - 24 * 3_600_000;
    const ticksLast24h = log.filter((ts) => Date.parse(ts) >= cutoff).length;
    return { lastTickAt: log.length > 0 ? log[log.length - 1] : null, ticksLast24h };
  } catch {
    return { lastTickAt: null, ticksLast24h: 0 };
  }
}

export interface AutoLearnTickDiagnostics {
  universeSize: number;
  /** Omniroute utilisable (endpoint + au moins un agent) : sans ça, TOUTE la
   * boucle de fond est muette, et chaque compteur reste à 0 sans erreur. */
  omnirouteConfigured: boolean;
  /** Matchs du planning du jour, et provenance (liste transmise ou balayage). */
  fictionalProgramSize: number;
  fictionalProgramFromFeed: boolean;
  /** Matchs du programme encore à venir, et heure du prochain coup d'envoi. */
  fictionalMatchesAhead: number;
  fictionalNextKickoffUtc?: string;
  /** Avancement du balayage pays par pays (il s'étale sur plusieurs tours). */
  fictionalCountriesTried: number;
  fictionalCountriesTotal: number;
  /** Ce que les agents ont répondu au dernier pays interrogé. */
  fictionalLastTrace?: { country: string; attempts: OmnirouteAttempt[] };
  /** Répartition par provenance (hors planning transmis) — pour vérifier que
   * Sportmonks alimente bien le programme plutôt qu'Omniroute en dernier
   * recours (demande explicite : démotion d'Omniroute). */
  fictionalSportmonksMatches: number;
  fictionalSofascoreMatches: number;
  fictionalOmnirouteMatches: number;
  /** Raison précise d'un "0 via Sportmonks" (clé absente, quota épuisé, ou
   * message d'erreur exact) — remplace un "injoignable" générique impossible
   * à agir dessus. */
  fictionalSportmonksError?: string;
  liveFixturesFound: number;
  /** Matchs en direct relevés par les fournisseurs IA pour le pipe fictif. */
  fictionalLiveFixturesFound: number;
  liveFixturesSource: SharedLiveFixturesResult['source'];
  /** Raison précise d'un repli sur Omniroute (clé absente, ou message
   * d'erreur exact d'API-Football) — absent quand liveFixturesSource vaut
   * 'api_football' (pas d'échec à expliquer). */
  apiFootballError?: string;
  liveMarkerObserved: number;
  liveMarkerClosed: number;
  freshInPlayProposals: number;
  /** Compétitions internationales pendant la trêve (Ligue des Nations, CAN) :
   * absent uniquement si runInPlayComboTick a échoué avant même de calculer
   * ce diagnostic (voir le try/catch autour de son appel plus bas). */
  intlBreak?: InternationalBreakTickDiagnostics;
  /** null = Sportmonks non configuré/en échec ce tour ; undefined seulement
   * si runInPlayComboTick a échoué avant de le calculer. */
  sportmonksConfirmedMatches?: number | null;
  /** Même principe, côté SofaScore. */
  sofaScoreConfirmedMatches?: number | null;
  /** Raison précise d'un sportmonksConfirmedMatches null (clé absente, ou
   * message d'erreur exact) — remplace un "injoignable" générique. */
  sportmonksError?: string;
  /** Points de courbe créés/mis à jour par le bilan de minuit ce tour (0 si
   * ce n'était pas encore l'heure, undefined si le bilan a échoué). */
  nightlyReviewPointsCreated?: number;
  /** Message d'erreur exact si le bilan de minuit a échoué — sans ça,
   * "Aucun bilan encore effectué" dans les courbes ne permettait pas de
   * savoir si c'était juste pas encore l'heure, ou un échec systématique. */
  nightlyReviewError?: string;
}

/**
 * Un tour complet : univers du jour, relevé live + étiquetage, consolidation
 * du modèle, puis scan en direct 20e/60e minute. Chaque étape est isolée :
 * si l'une échoue (réseau coupé, quota atteint), les autres continuent.
 * Renvoie un résumé chiffré de ce qui s'est vraiment passé (voir
 * AutoLearnTickDiagnostics) — utilisé par le bouton "forcer le scan"
 * (EvolutionScreen) pour distinguer "aucun match en direct en ce moment" de
 * "quelque chose bloque en amont", plutôt que de laisser deviner face à un
 * compteur qui reste silencieusement à 0.
 */
export async function runAutoLearnTick(): Promise<AutoLearnTickDiagnostics> {
  // Trois déclencheurs indépendants appellent cette fonction (tâche native
  // en arrière-plan, boucle de premier plan toutes les 3 min, bouton
  // "Forcer le scan") : sans ce verrou, deux tours pouvaient tourner en
  // CONCURRENCE (ex. le tour automatique se déclenche pendant qu'un tour
  // manuel est en cours) — chacun lisait les propositions déjà connues
  // AVANT que l'autre n'ait écrit la sienne, et proposait donc deux fois le
  // même match/checkpoint (constaté : 3 notifications Telegram quasi
  // identiques pour le même match en moins d'une minute). Un tour déjà en
  // vol est simplement réutilisé — jamais de double exécution simultanée.
  // Un tour resté accroché (requête qui ne rend jamais la main) ne doit pas
  // bloquer tous les suivants : au-delà de STALE_TICK_MS, on en relance un.
  if (inFlightTick && Date.now() - inFlightStartedAt < STALE_TICK_MS) return inFlightTick;

  const tick = runAutoLearnTickLocked();
  inFlightTick = tick;
  inFlightStartedAt = Date.now();
  tick.finally(() => {
    if (inFlightTick === tick) inFlightTick = null;
  }).catch(() => {});
  return tick;
}

let inFlightTick: Promise<AutoLearnTickDiagnostics> | null = null;
let inFlightStartedAt = 0;
const STALE_TICK_MS = 12 * 60_000;

const TICK_PROGRESS_KEY = '@autolearn_tick_progress';
let currentTickStartedAt = '';

/** Étape en cours du tour, persistée : si Android coupe le tour, le rapport
 * d'état (appHealth.ts) montre exactement où il s'est arrêté. */
async function markTickStep(step: string): Promise<void> {
  try {
    await AsyncStorage.setItem(
      TICK_PROGRESS_KEY,
      JSON.stringify({ startedAt: currentTickStartedAt, step, at: new Date().toISOString() })
    );
  } catch {
    // diagnostic best-effort
  }
}

export async function readTickProgress(): Promise<{ startedAt: string; step: string; at: string } | null> {
  const raw = await AsyncStorage.getItem(TICK_PROGRESS_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function runAutoLearnTickLocked(): Promise<AutoLearnTickDiagnostics> {
  // Scan matinal automatique (7h locales) : voir runMorningScanIfDue pour le
  // principe de déclenchement (premier tour après l'heure cible, idempotent).
  currentTickStartedAt = new Date().toISOString();
  await markTickStep('scan matinal');
  try {
    await runMorningScanIfDue();
  } catch (error: any) {
    console.warn('[Tâche de fond] Scan matinal automatique échoué:', error.message);
  }

  // Planning du Jour (solos/combinés pré-match) désactivé : les cotes
  // avant-match ne sont plus jugées rentables (demande explicite). L'univers
  // du jour ci-dessous reste construit — c'est la base des scans en direct
  // (20e/60e minute), pas seulement du Planning du Jour.
  await markTickStep('univers du jour');
  let universeSize = 0;
  try {
    const model = readLearnedModel();
    const universe = await ensureDailyUniverse(model?.focusLeagues ?? []);
    universeSize = universe.length;
  } catch (error: any) {
    console.warn('[Tâche de fond] Univers du jour indisponible:', error.message);
  }

  // Programme du jour de la boucle FICTIVE : découvert par planning transmis,
  // Sportmonks (calendrier mondial, découverte primaire) ou, en dernier
  // recours seulement, un balayage Omniroute pays par pays (voir
  // fictionalProgram.ts). Idempotent — construit au premier tour après
  // minuit puis rafraîchi au rythme des passes, relu tel quel entre-temps.
  // Ne dépend PLUS d'Omniroute pour fonctionner : Sportmonks (ou le planning
  // transmis) suffit désormais, Omniroute ne comble que ce qu'ils n'ont pas
  // couvert.
  await markTickStep('programme fictif');
  let fictionalProgramSize = 0;
  let omnirouteConfigured = false;
  let fictionalProgramFromFeed = false;
  let fictionalMatchesAhead = 0;
  let fictionalNextKickoffUtc: string | undefined;
  let fictionalCountriesTried = 0;
  let fictionalCountriesTotal = 0;
  let fictionalLastTrace: { country: string; attempts: OmnirouteAttempt[] } | undefined;
  let fictionalSportmonksMatches = 0;
  let fictionalSofascoreMatches = 0;
  let fictionalOmnirouteMatches = 0;
  let fictionalSportmonksError: string | undefined;
  try {
    const omnirouteConfig = await loadOmnirouteConfig();
    omnirouteConfigured = Boolean(omnirouteConfig);
    const program = await ensureFictionalDailyProgram(omnirouteConfig);
    fictionalProgramSize = program.length;
    const status = await getFictionalProgramStatus();
    fictionalProgramFromFeed = status.fromFeed;
    fictionalMatchesAhead = status.matchesAhead;
    fictionalNextKickoffUtc = status.nextKickoffUtc;
    fictionalCountriesTried = status.countriesTried;
    fictionalCountriesTotal = status.countriesTotal;
    fictionalLastTrace = status.lastTrace;
    fictionalSportmonksMatches = status.sportmonksMatches;
    fictionalSofascoreMatches = status.sofascoreMatches;
    fictionalOmnirouteMatches = status.omnirouteMatches;
    fictionalSportmonksError = status.sportmonksLastError;
  } catch (error: any) {
    console.warn('[Tâche de fond] Programme fictif du jour indisponible:', error.message);
  }

  // Compositions confirmées à T-90 (recherche Google/Omniroute, gratuit) :
  // débloque le placement direct des paris du Planning dès que l'info est là.
  await markTickStep('compositions T-90');
  try {
    await refreshDueLineups();
  } catch (error: any) {
    console.warn('[Tâche de fond] Rafraîchissement compositions T-90 échoué:', error.message);
  }

  await markTickStep('relevé live partagé');
  const shared = await fetchSharedLiveFixtures();
  const liveFixtures = shared.fixtures;

  await markTickStep('marqueurs live');
  let liveMarkerObserved = 0;
  let liveMarkerClosed = 0;
  try {
    const result = await runLiveMarkerTick([...liveFixtures, ...shared.fictionalFixtures]);
    liveMarkerObserved = result.observed;
    liveMarkerClosed = result.closed;
  } catch (error: any) {
    console.warn('[Tâche de fond] Relevé live échoué:', error.message);
  }

  // Confronte les analyses Scouting IA de la veille (et plus anciennes) au
  // score final réel, AVANT de consolider le digest : la fiabilité mesurée
  // doit être à jour pour la prochaine analyse.
  await markTickStep('bilan Scouting');
  try {
    await reconcileScoutingAnalyses();
  } catch (error: any) {
    console.warn('[Tâche de fond] Bilan Scouting vs réalité échoué:', error.message);
  }

  await markTickStep('consolidation apprentissage');
  try {
    await consolidateLearning();
  } catch (error: any) {
    console.warn('[Tâche de fond] Consolidation échouée:', error.message);
  }

  await markTickStep('enrichissement matchs suivis');
  try {
    await enrichFocusMatches();
  } catch (error: any) {
    console.warn('[Tâche de fond] Enrichissement des matchs suivis échoué:', error.message);
  }

  // Scan en direct 20e minute (buts/corners/cartons 1ère MT + BTTS/total du
  // match) et 60e minute (reste du match) — remplace l'ancien combo 20e
  // minute (règles apprises seules) et le moniteur mi-temps.
  await markTickStep('scan en direct 20e/60e');
  let freshInPlayProposals = 0;
  let intlBreak: InternationalBreakTickDiagnostics | undefined;
  let sportmonksConfirmedMatches: number | null | undefined;
  let sofaScoreConfirmedMatches: number | null | undefined;
  let sportmonksError: string | undefined;
  try {
    const result = await runInPlayComboTick(liveFixtures, shared.fictionalFixtures);
    freshInPlayProposals = result.freshProposals;
    intlBreak = result.intlBreak;
    sportmonksConfirmedMatches = result.sportmonksConfirmedMatches;
    sofaScoreConfirmedMatches = result.sofaScoreConfirmedMatches;
    sportmonksError = result.sportmonksError;
  } catch (error: any) {
    console.warn('[Tâche de fond] Scan en direct échoué:', error.message);
  }

  // Bilan de la journée écoulée : se déclenche au premier tour après minuit.
  // Erreur capturée et remontée au diagnostic (plutôt qu'un simple
  // console.warn invisible) : "Aucun bilan encore effectué" dans les courbes
  // était indiscernable entre "pas encore l'heure" et "échoue à chaque
  // tentative depuis toujours" sans ça.
  await markTickStep('bilan de minuit');
  let nightlyReviewPointsCreated: number | undefined;
  let nightlyReviewError: string | undefined;
  try {
    nightlyReviewPointsCreated = await runNightlyReviewIfDue();
  } catch (error: any) {
    nightlyReviewError = error?.message || 'erreur inconnue';
    console.warn('[Tâche de fond] Bilan de minuit échoué:', error.message);
  }

  const diagnostics: AutoLearnTickDiagnostics = {
    universeSize,
    omnirouteConfigured,
    fictionalProgramSize,
    fictionalProgramFromFeed,
    fictionalMatchesAhead,
    fictionalNextKickoffUtc,
    fictionalCountriesTried,
    fictionalCountriesTotal,
    fictionalLastTrace,
    fictionalSportmonksMatches,
    fictionalSofascoreMatches,
    fictionalOmnirouteMatches,
    fictionalSportmonksError,
    liveFixturesFound: liveFixtures.length,
    fictionalLiveFixturesFound: shared.fictionalFixtures.length,
    liveFixturesSource: shared.source,
    apiFootballError: shared.apiFootballError,
    liveMarkerObserved,
    liveMarkerClosed,
    freshInPlayProposals,
    intlBreak,
    sportmonksConfirmedMatches,
    sofaScoreConfirmedMatches,
    sportmonksError,
    nightlyReviewPointsCreated,
    nightlyReviewError,
  };
  // Détection quotidienne des modèles avec accès internet (voir llmRouter),
  // après tout le reste pour ne jamais retarder le scan lui-même.
  await markTickStep('vérification accès internet des modèles');
  try {
    const config = await loadOmnirouteConfig();
    if (config) {
      await autoProbeWebCapability(config);
      if (!(await getRecentSearchSource())) await probeAnySearch(config);
    }
  } catch (error: any) {
    console.warn('[Tâche de fond] Vérification accès internet échouée:', error?.message);
  }
  await markTickStep('terminé');
  await saveLastTickDiagnostics(diagnostics);
  return diagnostics;
}

const LAST_TICK_DIAGNOSTICS_KEY = '@last_autolearn_tick_diagnostics';

/** Dernier tour terminé, quel qu'en soit le déclencheur — relu par
 * appHealth.ts pour la sauvegarde GitHub. Best-effort, jamais bloquant. */
async function saveLastTickDiagnostics(diagnostics: AutoLearnTickDiagnostics): Promise<void> {
  try {
    await AsyncStorage.setItem(
      LAST_TICK_DIAGNOSTICS_KEY,
      JSON.stringify({ finishedAt: new Date().toISOString(), ...diagnostics })
    );
  } catch (error: any) {
    console.warn('[Tâche de fond] Enregistrement du diagnostic échoué:', error?.message);
  }
}

export async function readLastTickDiagnostics(): Promise<
  (AutoLearnTickDiagnostics & { finishedAt: string }) | null
> {
  const raw = await AsyncStorage.getItem(LAST_TICK_DIAGNOSTICS_KEY);
  return raw ? JSON.parse(raw) : null;
}

// La définition doit se faire au chargement du module, hors de tout composant :
// le système peut réveiller l'app directement sur cette tâche.
TaskManager.defineTask(AUTOLEARN_TASK_NAME, async () => {
  await recordNativeBackgroundTick();
  try {
    await runAutoLearnTick();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    console.error('[Tâche de fond] Échec du tour:', error);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundAutoLearn(): Promise<void> {
  try {
    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(AUTOLEARN_TASK_NAME);
    if (alreadyRegistered) return;

    await BackgroundTask.registerTaskAsync(AUTOLEARN_TASK_NAME, {
      minimumInterval: MINIMUM_INTERVAL_MINUTES,
    });
  } catch (error: any) {
    console.warn('[Tâche de fond] Enregistrement impossible:', error.message);
  }
}

export async function unregisterBackgroundAutoLearn(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(AUTOLEARN_TASK_NAME);
  } catch (error: any) {
    console.warn('[Tâche de fond] Désinscription impossible:', error.message);
  }
}
