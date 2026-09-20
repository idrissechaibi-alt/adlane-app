// Rafraîchissement "composition confirmée" à T-90 — débloque le placement
// direct d'un pari du Planning avec les toutes dernières infos (compo
// réelle, actus presse/analystes) plutôt qu'avec les données du matin.
//
// Priorité aux outils gratuits (demande explicite) : recherche Google via
// Gemini (déjà utilisée pour l'enrichissement Scouting) en premier, puis
// Omniroute si Gemini n'est pas configuré ou échoue. Jamais de cote/proba
// inventée ici — uniquement du texte factuel pour lever le verrou T-90.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { fetchGoogleSearchContext } from './gemini';
import { askOmnirouteLight, DEFAULT_OMNIROUTE_CONFIG } from './omniroute';
import { getDailyPlan } from './scheduler';

const GEMINI_KEY_STORAGE = 'app-adlane.gemini-api-key';
const OMNIROUTE_CONFIG_KEY = '@omniroute_config';
const REFRESH_STORE_KEY = '@t90_lineup_refresh';

/** Minutes avant le coup d'envoi à partir desquelles la compo réelle est généralement connue. */
export const T90_MINUTES = 90;

export interface LineupRefresh {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  fetchedAt: string;
  contextText: string;
  source: 'gemini' | 'omniroute';
}

async function readRefreshes(): Promise<Record<string, LineupRefresh>> {
  try {
    const raw = await AsyncStorage.getItem(REFRESH_STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeRefreshes(data: Record<string, LineupRefresh>): Promise<void> {
  // Fenêtre glissante de 48h : largement suffisant, un match analysé avant-hier ne sert plus.
  const cutoff = Date.now() - 48 * 3_600_000;
  const fresh = Object.fromEntries(
    Object.entries(data).filter(([, v]) => new Date(v.fetchedAt).getTime() > cutoff)
  );
  await AsyncStorage.setItem(REFRESH_STORE_KEY, JSON.stringify(fresh));
}

export function isT90Reached(kickoffUtc: string): boolean {
  const t90 = new Date(kickoffUtc).getTime() - T90_MINUTES * 60 * 1000;
  return Date.now() >= t90;
}

export async function getLineupRefresh(matchId: string): Promise<LineupRefresh | null> {
  const all = await readRefreshes();
  return all[matchId] || null;
}

/**
 * Lance (si pas déjà fait) la recherche de composition/actus confirmées pour
 * un match dont le T-90 vient d'être atteint. Idempotent : un match déjà
 * rafraîchi n'est jamais réinterrogé. Renvoie null si rien n'a pu être
 * trouvé (aucun moteur configuré, ou recherche vide) — le pari reste
 * verrouillé plutôt que débloqué avec du vide.
 */
export async function ensureLineupRefresh(
  matchId: string,
  homeTeam: string,
  awayTeam: string
): Promise<LineupRefresh | null> {
  const existing = await getLineupRefresh(matchId);
  if (existing) return existing;

  let contextText = '';
  let source: 'gemini' | 'omniroute' = 'gemini';

  const geminiKey = await SecureStore.getItemAsync(GEMINI_KEY_STORAGE);
  if (geminiKey) {
    try {
      const result = await fetchGoogleSearchContext(homeTeam, awayTeam, geminiKey);
      contextText = result.contextText;
    } catch (error: any) {
      console.warn('[T-90] Recherche Google échouée:', error.message);
    }
  }

  if (!contextText) {
    try {
      const raw = await AsyncStorage.getItem(OMNIROUTE_CONFIG_KEY);
      const omnirouteConfig = raw ? JSON.parse(raw) : null;
      if (omnirouteConfig?.endpoint && omnirouteConfig.selectedModel?.trim()) {
        const result = await askOmnirouteLight(
          'Tu cherches des informations factuelles et récentes sur un match de football, à partir de la presse et des analystes. Pas de pronostic, pas de conseil de pari.',
          `Composition probable/confirmée et dernières nouvelles (blessures, absences, changements tactiques) pour ${homeTeam} vs ${awayTeam}, à l'approche du coup d'envoi.`,
          {
            ...DEFAULT_OMNIROUTE_CONFIG,
            endpoint: omnirouteConfig.endpoint,
            apiKey: omnirouteConfig.apiKey,
            selectedModel: omnirouteConfig.selectedModel,
          }
        );
        if (result?.text) {
          contextText = result.text;
          source = 'omniroute';
        }
      }
    } catch (error: any) {
      console.warn('[T-90] Recherche Omniroute échouée:', error.message);
    }
  }

  if (!contextText) return null;

  const refresh: LineupRefresh = {
    matchId,
    homeTeam,
    awayTeam,
    fetchedAt: new Date().toISOString(),
    contextText,
    source,
  };

  const all = await readRefreshes();
  all[matchId] = refresh;
  await writeRefreshes(all);
  return refresh;
}

/**
 * Parcourt le planning du jour et rafraîchit tous les matchs dont le T-90
 * vient d'être atteint et qui n'ont pas encore été rafraîchis. Appelé depuis
 * la tâche de fond — c'est ce qui débloque le bouton "Placer ce pari" sans
 * action de l'utilisateur, dès que l'information est disponible.
 */
export async function refreshDueLineups(): Promise<number> {
  const plan = await getDailyPlan();
  if (!plan) return 0;

  let refreshed = 0;
  for (const slot of plan.slots) {
    for (const match of slot.matches) {
      if (!isT90Reached(match.kickoff_utc)) continue;
      const result = await ensureLineupRefresh(match.id, match.homeTeam, match.awayTeam);
      if (result) refreshed += 1;
    }
  }
  return refreshed;
}
