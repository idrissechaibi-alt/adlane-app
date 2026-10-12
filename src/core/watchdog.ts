// Alerte Telegram quand l'app se bloque : passage de fond abandonné, source gratuite en panne, tâche de fond muette,
// fichier de stats d'équipes périmé. Chaque type d'alerte est limité à une par 6 h (jamais de rafale), et un message
// « rétabli » n'est pas envoyé : seule une anomalie nouvelle ou persistante après 6 h est signalée.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getHubStatus } from '../api/footballDataAPIs/liveDataHub';
import { getNativeBackgroundTickStats, readAbortedTicks } from './backgroundTasks';
import { getTeamStatsStatus } from './teamStats';
import { sendTelegramMessage } from './telegram';

const STATE_KEY = '@watchdog_state';
const REPEAT_MS = 6 * 3_600_000;

async function problems(): Promise<Array<{ id: string; text: string }>> {
  const out: Array<{ id: string; text: string }> = [];
  try {
    const aborted = (await readAbortedTicks()) as Array<{ at?: string; step?: string }>;
    const recent = aborted.filter((a) => a.at && Date.now() - Date.parse(a.at) < 3 * 3_600_000);
    if (recent.length > 0) out.push({ id: 'aborted', text: `⏹️ ${recent.length} passage(s) de fond abandonné(s) ces 3 dernières heures (dernière étape : ${recent[recent.length - 1].step ?? '?'}).` });
  } catch {
    // lecture impossible : pas d'alerte pour ça
  }
  try {
    const hub = await getHubStatus();
    const down = Object.entries(hub).filter(([, v]) => !v.ok && Date.now() - Date.parse(v.at) < 2 * 3_600_000).map(([k]) => k);
    if (down.length >= 2) out.push({ id: 'sources', text: `📡 Sources de matchs en panne : ${down.join(', ')}.` });
  } catch {
    // idem
  }
  try {
    const native = await getNativeBackgroundTickStats();
    if (native.lastTickAt && Date.now() - Date.parse(native.lastTickAt) > 3 * 3_600_000) out.push({ id: 'silent', text: `😴 La tâche de fond n'a pas tourné depuis ${Math.round((Date.now() - Date.parse(native.lastTickAt)) / 3_600_000)} h : les paris réels ne sont plus scannés (batterie / Android ?).` });
  } catch {
    // idem
  }
  try {
    const stats = await getTeamStatsStatus();
    if (stats.indexUpdatedAt && Date.now() - Date.parse(stats.indexUpdatedAt) > 48 * 3_600_000) out.push({ id: 'teamstats', text: `📁 Le fichier des stats d'équipes n'a pas été mis à jour depuis plus de 48 h (dernière : ${stats.indexUpdatedAt.slice(0, 16).replace('T', ' ')} UTC).` });
  } catch {
    // idem
  }
  return out;
}

/** À appeler à chaque tour rapide : envoie, au plus une fois par 6 h et par type, les anomalies détectées. */
export async function runWatchdog(): Promise<number> {
  const found = await problems();
  if (found.length === 0) return 0;
  let state: Record<string, number> = {};
  try {
    state = JSON.parse((await AsyncStorage.getItem(STATE_KEY)) ?? '{}');
  } catch {
    state = {};
  }
  const due = found.filter((p) => Date.now() - (state[p.id] ?? 0) >= REPEAT_MS);
  if (due.length === 0) return 0;
  const sent = await sendTelegramMessage(`⚠️ Alerte APP adlane\n\n${due.map((p) => p.text).join('\n')}`);
  if (sent) {
    for (const p of due) state[p.id] = Date.now();
    await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state)).catch(() => {});
  }
  return sent ? due.length : 0;
}
