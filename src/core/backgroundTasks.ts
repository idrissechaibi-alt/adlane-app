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
import { ensureDailyUniverse, getStoredUniverse } from './matchUniverse';
import { runLiveMarkerTick } from './liveMarkers';
import { fetchLiveFixtures, fetchOmnirouteLiveFixtures, LiveFixture } from './halftimeMonitor';
import { consolidateLearning } from './autoLearn';
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
   * indiscernable d'un budget épuisé, d'un univers vide, ou d'Omniroute non
   * configuré — trois causes très différentes du même symptôme "0 match". */
  source: 'api_football' | 'omniroute' | 'aucune_api_football_epuisee' | 'aucune_omniroute_non_configure' | 'aucune_univers_vide';
  universeSize: number;
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
 * scraping, sans quota) prend le relais à partir du programme du jour déjà
 * connu (matchUniverse) — sans ce repli, un quota épuisé arrêtait TOUT le
 * scan en direct, y compris le pipeline fictif qui n'est pourtant censé
 * dépendre d'aucune ressource payante.
 *
 * ⚠️ Ce repli a lui-même une limite non résolue : il lit matchUniverse
 * (getStoredUniverse), qui est construit par ensureDailyUniverse — LUI-MÊME
 * entièrement gated derrière le budget API-Football (aucun repli Omniroute
 * pour bâtir le programme du jour). Si le budget est déjà épuisé au tout
 * premier appel du jour, l'univers reste vide et Omniroute n'a alors aucun
 * match candidat à interroger — il ne fait littéralement aucun appel, pas
 * un appel qui échoue. D'où le diagnostic détaillé ci-dessous plutôt qu'un
 * simple booléen "ça a marché / pas marché".
 */
async function fetchSharedLiveFixtures(): Promise<SharedLiveFixturesResult> {
  const apiConfig = await getAPIConfig();

  if (apiConfig.apiFootball && (await spendBudget('apiFootball'))) {
    try {
      const fixtures = await fetchLiveFixtures(apiConfig.apiFootball);
      return { fixtures, source: 'api_football', universeSize: 0 };
    } catch (error: any) {
      console.warn('[Tâche de fond] Relevé live API-Football échoué, repli Omniroute:', error.message);
    }
  }

  try {
    const omnirouteConfig = await loadOmnirouteConfig();
    if (!omnirouteConfig) return { fixtures: [], source: 'aucune_omniroute_non_configure', universeSize: 0 };
    const universe = await getStoredUniverse();
    if (!universe || universe.length === 0) {
      return { fixtures: [], source: 'aucune_univers_vide', universeSize: 0 };
    }
    const fixtures = await fetchOmnirouteLiveFixtures(omnirouteConfig, universe);
    return { fixtures, source: 'omniroute', universeSize: universe.length };
  } catch (error: any) {
    console.warn('[Tâche de fond] Repli Omniroute pour le relevé live échoué:', error.message);
    return { fixtures: [], source: 'aucune_api_football_epuisee', universeSize: 0 };
  }
}

export const AUTOLEARN_TASK_NAME = 'adlane-autolearn-tick';
const MINIMUM_INTERVAL_MINUTES = 15; // plancher Android, inutile de descendre

export interface AutoLearnTickDiagnostics {
  universeSize: number;
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

  // Compositions confirmées à T-90 (recherche Google/Omniroute, gratuit) :
  // débloque le placement direct des paris du Planning dès que l'info est là.
  try {
    await refreshDueLineups();
  } catch (error: any) {
    console.warn('[Tâche de fond] Rafraîchissement compositions T-90 échoué:', error.message);
  }

  const shared = await fetchSharedLiveFixtures();
  const liveFixtures = shared.fixtures;
  // fetchSharedLiveFixtures ne relit l'univers que sur le chemin Omniroute ;
  // sur le chemin API-Football normal, l'univers ci-dessus reste la mesure
  // à afficher (déjà lu dans les deux cas, jamais 0 par défaut par erreur).
  if (shared.universeSize > 0) universeSize = shared.universeSize;

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
