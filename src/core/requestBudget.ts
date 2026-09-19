// Garde-fou de quota : la boucle d'auto-apprentissage tourne en continu, elle
// ne doit JAMAIS faire exploser les quotas gratuits des API configurées.
// Chaque appel passe par ici : si le budget du jour est épuisé, l'appel est
// refusé proprement (la boucle saute simplement ce tour, elle ne plante pas).

import { getRequestCount, getQuotaConfig, incrementRequestCount } from '../api/multiAPIManager';

/**
 * Part du quota journalier réservée à l'auto-apprentissage. Le reste est
 * laissé à l'usage direct de l'utilisateur (scan matinal, scouting, etc.) :
 * la boucle de fond ne doit pas consommer la clé au point de bloquer une
 * analyse demandée explicitement.
 */
const AUTOLEARN_BUDGET_SHARE = 0.7;

export async function remainingBudget(source: string): Promise<number> {
  const [used, quotas] = await Promise.all([getRequestCount(source), getQuotaConfig()]);
  const setting = quotas[source];
  if (!setting || setting.limit <= 0) return 0;

  const dailyLimit = setting.period === 'day'
    ? setting.limit
    : setting.period === 'hour'
      ? setting.limit * 24
      : Math.floor(setting.limit / 30); // mensuel ramené au jour

  return Math.max(0, Math.floor(dailyLimit * AUTOLEARN_BUDGET_SHARE) - used);
}

/**
 * Consomme une unité de budget si elle est disponible.
 * Renvoie false quand le quota du jour est atteint — l'appelant doit alors
 * s'abstenir d'appeler l'API (et surtout pas réessayer en boucle).
 */
export async function spendBudget(source: string, units: number = 1): Promise<boolean> {
  const remaining = await remainingBudget(source);
  if (remaining < units) return false;

  for (let i = 0; i < units; i++) {
    await incrementRequestCount(source);
  }
  return true;
}
