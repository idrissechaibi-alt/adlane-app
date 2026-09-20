// Garde-fou de quota : la boucle d'auto-apprentissage tourne en continu, elle
// ne doit JAMAIS faire exploser les quotas gratuits des API configurées.
// Chaque appel passe par ici : si le budget du jour est épuisé, l'appel est
// refusé proprement (la boucle saute simplement ce tour, elle ne plante pas).

import { getRequestCount, getQuotaConfig, incrementRequestCount } from '../api/multiAPIManager';

/**
 * Part du quota journalier réservée à l'auto-apprentissage. Le reste est
 * laissé à l'usage direct de l'utilisateur (scan matinal, scouting, Données
 * Foot, etc.).
 *
 * Décomptée sur un compteur DÉDIÉ (`${source}-autolearn`), jamais partagé
 * avec l'usage direct : avant ce correctif, les deux tiraient sur le MÊME
 * compteur global, donc une simple navigation dans Données Foot (classement,
 * 3 derniers résultats par équipe) pouvait épuiser à elle seule la part
 * réservée à l'auto-learning pour le reste de la journée, alors que "70%
 * réservés" ne protégeait en réalité personne — l'usage direct n'avait lui-
 * même aucun plafond. Le compteur global (`source`, affiché dans Gestion des
 * API) continue d'être incrémenté à chaque appel réel, direct ou non, pour
 * que le quota affiché reste exact ; il sert aussi de garde-fou final pour
 * ne jamais dépasser le vrai quota du fournisseur même si l'usage direct est
 * déjà très élevé.
 */
const AUTOLEARN_BUDGET_SHARE = 0.7;

function autolearnCounterKey(source: string): string {
  return `${source}-autolearn`;
}

export async function remainingBudget(source: string): Promise<number> {
  const [totalUsed, autolearnUsed, quotas] = await Promise.all([
    getRequestCount(source),
    getRequestCount(autolearnCounterKey(source)),
    getQuotaConfig(),
  ]);
  const setting = quotas[source];
  if (!setting || setting.limit <= 0) return 0;

  const dailyLimit = setting.period === 'day'
    ? setting.limit
    : setting.period === 'hour'
      ? setting.limit * 24
      : Math.floor(setting.limit / 30); // mensuel ramené au jour

  const autolearnShare = Math.floor(dailyLimit * AUTOLEARN_BUDGET_SHARE);

  // Le plus restrictif des deux : la part propre à l'auto-learning (jamais
  // affectée par l'usage direct) ET le quota réel total (jamais dépassé,
  // même combiné à un usage direct déjà élevé).
  return Math.max(0, Math.min(autolearnShare - autolearnUsed, dailyLimit - totalUsed));
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
    await incrementRequestCount(autolearnCounterKey(source));
  }
  return true;
}
