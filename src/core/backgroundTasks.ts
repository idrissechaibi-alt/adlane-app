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
import { checkHalftimeOpportunities } from './halftimeMonitor';
import { enrichFocusMatches } from './focusEnrichment';
import { runInPlayComboTick } from './inPlayCombos';
import { readLearnedModel } from './learnStore';

export const AUTOLEARN_TASK_NAME = 'adlane-autolearn-tick';
const MINIMUM_INTERVAL_MINUTES = 15; // plancher Android, inutile de descendre

/**
 * Un tour complet : univers du jour, relevé live + étiquetage, consolidation
 * du modèle, puis alertes mi-temps. Chaque étape est isolée : si l'une échoue
 * (réseau coupé, quota atteint), les autres continuent.
 */
export async function runAutoLearnTick(): Promise<void> {
  try {
    const model = readLearnedModel();
    await ensureDailyUniverse(model?.focusLeagues ?? []);
  } catch (error: any) {
    console.warn('[Tâche de fond] Univers du jour indisponible:', error.message);
  }

  try {
    await runLiveMarkerTick();
  } catch (error: any) {
    console.warn('[Tâche de fond] Relevé live échoué:', error.message);
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

  try {
    await runInPlayComboTick();
  } catch (error: any) {
    console.warn('[Tâche de fond] Combos en direct échoués:', error.message);
  }

  try {
    await checkHalftimeOpportunities();
  } catch (error: any) {
    console.warn('[Tâche de fond] Vérification mi-temps échouée:', error.message);
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
