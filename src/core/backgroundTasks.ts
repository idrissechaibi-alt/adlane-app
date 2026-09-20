// Tâche native planifiée (WorkManager côté Android) : continue de tourner
// quand l'app est fermée.
//
// ⚠️ Plancher système : Android n'autorise pas mieux que ~15 minutes pour une
// tâche périodique, et décide lui-même du moment exact selon la batterie et le
// réseau. Le pas de 3 minutes demandé n'est possible que pendant que l'app est
// ouverte (boucle de premier plan dans App.tsx, qui appelle le même tick).

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { ensureDailyUniverse } from './matchUniverse';
import { runLiveMarkerTick } from './liveMarkers';
import { consolidateLearning } from './autoLearn';
import { enrichFocusMatches } from './focusEnrichment';
import { runInPlayComboTick } from './inPlayCombos';
import { runNightlyReviewIfDue } from './dailyReview';
import { runMorningScanIfDue } from './scheduler';
import { reconcileScoutingAnalyses } from './scoutingReview';
import { refreshDueLineups } from './lineupRefresh';
import { readLearnedModel } from './learnStore';

export const AUTOLEARN_TASK_NAME = 'adlane-autolearn-tick';
const MINIMUM_INTERVAL_MINUTES = 15; // plancher Android, inutile de descendre

/**
 * Un tour complet : univers du jour, relevé live + étiquetage, consolidation
 * du modèle, puis scan en direct 20e/60e minute. Chaque étape est isolée :
 * si l'une échoue (réseau coupé, quota atteint), les autres continuent.
 */
export async function runAutoLearnTick(): Promise<void> {
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
  try {
    const model = readLearnedModel();
    await ensureDailyUniverse(model?.focusLeagues ?? []);
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

  try {
    await runLiveMarkerTick();
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
  try {
    await runInPlayComboTick();
  } catch (error: any) {
    console.warn('[Tâche de fond] Scan en direct échoué:', error.message);
  }

  // Bilan de la journée écoulée : se déclenche au premier tour après minuit.
  try {
    await runNightlyReviewIfDue();
  } catch (error: any) {
    console.warn('[Tâche de fond] Bilan de minuit échoué:', error.message);
  }
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
