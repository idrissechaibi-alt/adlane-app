// Tâche native planifiée (WorkManager côté Android) : continue de tourner
// quand l'app est fermée.
//
// ⚠️ Plancher système : Android n'autorise pas mieux que ~15 minutes pour une
// tâche périodique, et décide lui-même du moment exact selon la batterie et le
// réseau. Le pas de 3 minutes demandé n'est possible que pendant que l'app est
// ouverte (boucle de premier plan dans App.tsx, qui appelle le même tick).

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { getAPIConfig } from '../api/multiAPIManager';
import { spendBudget } from './requestBudget';
import { ensureDailyUniverse } from './matchUniverse';
import { ensureFictionalDailyProgram, getFictionalProgramStatus } from './fictionalProgram';
import { runLiveMarkerTick } from './liveMarkers';
import { fetchLiveFixtures, fetchOmnirouteAllLiveFixtures, LiveFixture } from './halftimeMonitor';
import { consolidateLearning } from './autoLearn';
import { OmnirouteAttempt } from './omniroute';
import { enrichFocusMatches, loadOmnirouteConfig } from './focusEnrichment';
import { runInPlayComboTick } from './inPlayCombos';
import { runNightlyReviewIfDue } from './dailyReview';
import { runMorningScanIfDue } from './scheduler';
import { reconcileScoutingAnalyses } from './scoutingReview';
import { refreshDueLineups } from './lineupRefresh';
import { readLearnedModel } from './learnStore';

interface SharedLiveFixturesResult {
  fixtures: LiveFixture[];
  /** D'où viennent (ou pourquoi pas) les fixtures — sert au diagnostic du
   * bouton "forcer le scan" (EvolutionScreen) : sans ça, un relevé vide est
   * indiscernable d'un vrai calme (aucun match en ce moment) ou d'Omniroute
   * non configuré. */
  source: 'api_football' | 'omniroute' | 'aucune_omniroute_non_configure' | 'aucune_echec_omniroute';
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
async function fetchSharedLiveFixtures(): Promise<SharedLiveFixturesResult> {
  const apiConfig = await getAPIConfig();

  if (apiConfig.apiFootball && (await spendBudget('apiFootball'))) {
    try {
      const fixtures = await fetchLiveFixtures(apiConfig.apiFootball);
      return { fixtures, source: 'api_football' };
    } catch (error: any) {
      console.warn('[Tâche de fond] Relevé live API-Football échoué, repli Omniroute:', error.message);
    }
  }

  const omnirouteConfig = await loadOmnirouteConfig();
  if (!omnirouteConfig) return { fixtures: [], source: 'aucune_omniroute_non_configure' };

  try {
    const fixtures = await fetchOmnirouteAllLiveFixtures(omnirouteConfig);
    return { fixtures, source: 'omniroute' };
  } catch (error: any) {
    console.warn('[Tâche de fond] Repli Omniroute pour le relevé live échoué:', error.message);
    return { fixtures: [], source: 'aucune_echec_omniroute' };
  }
}

export const AUTOLEARN_TASK_NAME = 'adlane-autolearn-tick';
const MINIMUM_INTERVAL_MINUTES = 15; // plancher Android, inutile de descendre

export interface AutoLearnTickDiagnostics {
  universeSize: number;
  /** Omniroute utilisable (endpoint + au moins un agent) : sans ça, TOUTE la
   * boucle de fond est muette, et chaque compteur reste à 0 sans erreur. */
  omnirouteConfigured: boolean;
  /** Matchs du programme fictif du jour (Omniroute seul). */
  fictionalProgramSize: number;
  /** Avancement du balayage pays par pays (il s'étale sur plusieurs tours). */
  fictionalCountriesTried: number;
  fictionalCountriesTotal: number;
  /** Ce que les agents ont répondu au dernier pays interrogé. */
  fictionalLastTrace?: { country: string; attempts: OmnirouteAttempt[] };
  liveFixturesFound: number;
  liveFixturesSource: SharedLiveFixturesResult['source'];
  liveMarkerObserved: number;
  liveMarkerClosed: number;
  freshInPlayProposals: number;
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
  // Scan matinal automatique (7h locales) : voir runMorningScanIfDue pour le
  // principe de déclenchement (premier tour après l'heure cible, idempotent).
  try {
    await runMorningScanIfDue();
  } catch (error: any) {
    console.warn('[Tâche de fond] Scan matinal automatique échoué:', error.message);
  }

  // Planning du Jour (solos/combinés pré-match) désactivé : les cotes
  // avant-match ne sont plus jugées rentables (demande explicite). L'univers
  // du jour ci-dessous reste construit — c'est la base des scans en direct
  // (20e/60e minute), pas seulement du Planning du Jour.
  let universeSize = 0;
  try {
    const model = readLearnedModel();
    const universe = await ensureDailyUniverse(model?.focusLeagues ?? []);
    universeSize = universe.length;
  } catch (error: any) {
    console.warn('[Tâche de fond] Univers du jour indisponible:', error.message);
  }

  // Programme du jour de la boucle FICTIVE : Omniroute balaie une fois par
  // jour le calendrier de 20 pays européens (toutes divisions, catégories
  // jeunes comprises) et en retient 250 matchs avec leurs horaires. Idempotent
  // — construit au premier tour après minuit, relu tel quel ensuite. C'est ce
  // programme, et lui seul, qui dit au pipeline fictif quels matchs suivre et
  // quand : aucune API n'intervient.
  let fictionalProgramSize = 0;
  let omnirouteConfigured = false;
  let fictionalCountriesTried = 0;
  let fictionalCountriesTotal = 0;
  let fictionalLastTrace: { country: string; attempts: OmnirouteAttempt[] } | undefined;
  try {
    const omnirouteConfig = await loadOmnirouteConfig();
    omnirouteConfigured = Boolean(omnirouteConfig);
    if (omnirouteConfig) {
      const program = await ensureFictionalDailyProgram(omnirouteConfig);
      fictionalProgramSize = program.length;
      const status = await getFictionalProgramStatus();
      fictionalCountriesTried = status.countriesTried;
      fictionalCountriesTotal = status.countriesTotal;
      fictionalLastTrace = status.lastTrace;
    }
  } catch (error: any) {
    console.warn('[Tâche de fond] Programme fictif du jour indisponible:', error.message);
  }

  // Compositions confirmées à T-90 (recherche Google/Omniroute, gratuit) :
  // débloque le placement direct des paris du Planning dès que l'info est là.
  try {
    await refreshDueLineups();
  } catch (error: any) {
    console.warn('[Tâche de fond] Rafraîchissement compositions T-90 échoué:', error.message);
  }

  const shared = await fetchSharedLiveFixtures();
  const liveFixtures = shared.fixtures;

  let liveMarkerObserved = 0;
  let liveMarkerClosed = 0;
  try {
    const result = await runLiveMarkerTick(liveFixtures);
    liveMarkerObserved = result.observed;
    liveMarkerClosed = result.closed;
  } catch (error: any) {
    console.warn('[Tâche de fond] Relevé live échoué:', error.message);
  }

  // Confronte les analyses Scouting IA de la veille (et plus anciennes) au
  // score final réel, AVANT de consolider le digest : la fiabilité mesurée
  // doit être à jour pour la prochaine analyse.
  try {
    await reconcileScoutingAnalyses();
  } catch (error: any) {
    console.warn('[Tâche de fond] Bilan Scouting vs réalité échoué:', error.message);
  }

  try {
    await consolidateLearning();
  } catch (error: any) {
    console.warn('[Tâche de fond] Consolidation échouée:', error.message);
  }

  try {
    await enrichFocusMatches();
  } catch (error: any) {
    console.warn('[Tâche de fond] Enrichissement des matchs suivis échoué:', error.message);
  }

  // Scan en direct 20e minute (buts/corners/cartons 1ère MT + BTTS/total du
  // match) et 60e minute (reste du match) — remplace l'ancien combo 20e
  // minute (règles apprises seules) et le moniteur mi-temps.
  let freshInPlayProposals = 0;
  try {
    freshInPlayProposals = await runInPlayComboTick(liveFixtures);
  } catch (error: any) {
    console.warn('[Tâche de fond] Scan en direct échoué:', error.message);
  }

  // Bilan de la journée écoulée : se déclenche au premier tour après minuit.
  try {
    await runNightlyReviewIfDue();
  } catch (error: any) {
    console.warn('[Tâche de fond] Bilan de minuit échoué:', error.message);
  }

  return {
    universeSize,
    omnirouteConfigured,
    fictionalProgramSize,
    fictionalCountriesTried,
    fictionalCountriesTotal,
    fictionalLastTrace,
    liveFixturesFound: liveFixtures.length,
    liveFixturesSource: shared.source,
    liveMarkerObserved,
    liveMarkerClosed,
    freshInPlayProposals,
  };
}

// La définition doit se faire au chargement du module, hors de tout composant :
// le système peut réveiller l'app directement sur cette tâche.
TaskManager.defineTask(AUTOLEARN_TASK_NAME, async () => {
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
