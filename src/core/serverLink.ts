// TÉLÉPHONE ↔ SERVEUR PC (mode « le PC fait tout », désactivé le 20/10 : le serveur ne fait que collecter, voir
// serverFeed.ts). Gardé pour l'export de configuration et si ce mode est réactivé un jour.
//
// Quand le serveur du PC tourne (battement de cœur récent dans data/server/heartbeat.json), le téléphone ne fait plus le
// travail lui-même :
//  - ce que l'utilisateur saisit (cote d'un pari, ligne proposée ou non, marché fermé, pari posé) est appliqué sur le
//    téléphone ET déposé dans data/server/inbox/ ; le serveur l'applique à son tour (server/inbox.ts) ;
//  - les écrans relisent les résultats du serveur : sa sauvegarde complète (data/full-backup) est rapatriée, seuls les
//    morceaux modifiés depuis la dernière fois sont téléchargés.
// Si le PC s'arrête, le battement de cœur vieillit et le téléphone reprend tout seul.

import AsyncStorage from './kvStore';
import * as SecureStore from 'expo-secure-store';
import { FREE_LLM_PROVIDERS } from './freeLLMProviders';
import { Directory, File, Paths } from 'expo-file-system';
import { fetchRepoText, getServerStatus, listRepoDir, phoneShouldStandBy, putRepoText } from './gitAutoSync';
import { isRunningOnServer } from './serverMode';
import { readAllLearningFiles, replaceLearningFile, setLegBookOdds } from './learnStore';
import { recordOddsAndLearn } from './oddsLoop';
import { markLineAvailable, markLineUnavailable, markMarketOff } from './lineLimits';
import { saveBet } from '../database/storage';

export const SERVER_INBOX_DIR = 'data/server/inbox';
const OUTBOX_KEY = '@server_outbox';
const PULL_STATE_KEY = '@server_pull_state';
const LOCAL_ODDS_KEY = '@server_local_book_odds';

export type UserActionName = 'saveBet' | 'setLegBookOdds' | 'recordOddsAndLearn' | 'markLineAvailable' | 'markLineUnavailable' | 'markMarketOff';

export interface UserAction {
  id: string;
  at: string;
  name: UserActionName;
  args: unknown[];
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Dépose une saisie pour le serveur (gardée sur le téléphone et renvoyée plus tard si le réseau manque). */
async function forward(name: UserActionName, args: unknown[]): Promise<void> {
  if (isRunningOnServer()) return;
  // Le serveur ne fait que collecter (phoneShouldStandBy toujours faux) : rien à lui transmettre.
  if (!(await phoneShouldStandBy())) return;
  const action: UserAction = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), name, args };
  const outbox = await readJson<UserAction[]>(OUTBOX_KEY, []);
  outbox.push(action);
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.slice(-500)));
  void flushOutbox();
}

let flushing: Promise<number> | null = null;
/** Envoie au serveur les saisies en attente. Renvoie le nombre envoyé. */
export function flushOutbox(): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    const outbox = await readJson<UserAction[]>(OUTBOX_KEY, []);
    const left: UserAction[] = [];
    for (const a of outbox) {
      const ok = await putRepoText(`${SERVER_INBOX_DIR}/${a.id}.json`, JSON.stringify(a), `[APP adlane] Saisie pour le serveur : ${a.name}`).catch(() => false);
      if (ok) sent++;
      else left.push(a);
    }
    if (sent > 0 || left.length !== outbox.length) await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(left));
    return sent;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// ---- Saisies de l'utilisateur (écran Planning) : appliquées ici, puis transmises au serveur s'il tourne.

export async function userSaveBet(...args: Parameters<typeof saveBet>): Promise<void> {
  await saveBet(...args);
  await forward('saveBet', args);
}

export async function userSetLegBookOdds(proposalId: string, odds: number): Promise<void> {
  setLegBookOdds(proposalId, odds);
  // Gardée de côté : la prochaine relecture des résultats du serveur ne doit pas l'effacer avant qu'il l'ait reçue.
  const local = await readJson<Record<string, { odds: number; at: string }>>(LOCAL_ODDS_KEY, {});
  local[proposalId] = { odds, at: new Date().toISOString() };
  await AsyncStorage.setItem(LOCAL_ODDS_KEY, JSON.stringify(local));
  await forward('setLegBookOdds', [proposalId, odds]);
}

export async function userRecordOddsAndLearn(...args: Parameters<typeof recordOddsAndLearn>): Promise<void> {
  await recordOddsAndLearn(...args);
  await forward('recordOddsAndLearn', args);
}

export async function userMarkLineAvailable(...args: Parameters<typeof markLineAvailable>): Promise<void> {
  await markLineAvailable(...args);
  await forward('markLineAvailable', args);
}

export async function userMarkLineUnavailable(...args: Parameters<typeof markLineUnavailable>): Promise<void> {
  await markLineUnavailable(...args);
  await forward('markLineUnavailable', args);
}

export async function userMarkMarketOff(...args: Parameters<typeof markMarketOff>): Promise<void> {
  await markMarketOff(...args);
  await forward('markMarketOff', args);
}

// ---- Relecture des résultats du serveur.

interface PullState {
  manifestAt: string | null;
  shas: Record<string, string>;
  at: number;
}

function partsDir(): Directory {
  const d = new Directory(Paths.document, 'app-adlane', 'server-pull');
  d.create({ intermediates: true, idempotent: true });
  return d;
}

const partFile = (id: string) => new File(partsDir(), id.replace(/\//g, '__'));

/**
 * Rapatrie la sauvegarde complète du serveur (seuls les morceaux changés). À appeler app ouverte : au plus toutes les
 * 20 min sauf `force`. Renvoie le nombre de fichiers mis à jour.
 */
let pulling: Promise<number> | null = null;
export function pullServerData(force = false): Promise<number> {
  if (isRunningOnServer()) return Promise.resolve(0);
  if (pulling) return pulling;
  pulling = (async () => {
    const state = await readJson<PullState>(PULL_STATE_KEY, { manifestAt: null, shas: {}, at: 0 });
    if (!force && Date.now() - state.at < 20 * 60_000) return 0;
    if (!(await getServerStatus()).alive) return 0;
    const manifestRaw = await fetchRepoText('data/full-backup/manifest.json');
    if (!manifestRaw) return 0;
    const manifest: { updatedAt: string; parts: Record<string, number> } = JSON.parse(manifestRaw);
    if (!force && manifest.updatedAt === state.manifestAt) {
      await AsyncStorage.setItem(PULL_STATE_KEY, JSON.stringify({ ...state, at: Date.now() }));
      return 0;
    }
    const listing = [...((await listRepoDir('data/full-backup/files')) ?? []), ...((await listRepoDir('data/full-backup/storage')) ?? [])];
    const shaById = new Map(listing.map((x) => [x.path.replace('data/full-backup/', '').replace(/\.txt$/, ''), x.sha]));
    let updated = 0;
    for (const [name, parts] of Object.entries(manifest.parts)) {
      let changed = false;
      let complete = true;
      for (let i = 1; i <= parts; i++) {
        const id = `${name}.part${i}`;
        const sha = shaById.get(id);
        const f = partFile(id);
        if (sha && state.shas[id] === sha && f.exists) continue;
        const text = await fetchRepoText(`data/full-backup/${id}.txt`);
        if (text == null) {
          complete = false;
          break;
        }
        f.write(text);
        if (sha) state.shas[id] = sha;
        changed = true;
      }
      if (!changed || !complete) continue;
      let text = '';
      for (let i = 1; i <= parts; i++) text += partFile(`${name}.part${i}`).textSync();
      if (name.startsWith('files/')) {
        // Garde-fou : jamais remplacer un fichier local par une version deux fois plus petite (copie du serveur incomplète).
        const local = readAllLearningFiles().find((f) => `files/${f.name}` === name)?.text;
        if (local && local.length > 1_000_000 && text.length * 2 < local.length) continue;
        replaceLearningFile(name.slice('files/'.length), text);
      }
      else if (name.startsWith('storage/')) await AsyncStorage.setItem(name.slice('storage/'.length).replace(/^_/, '@'), text);
      updated++;
    }
    // Cotes saisies ici que le serveur n'a peut-être pas encore reçues : réappliquées (les plus vieilles de 2 h sont oubliées).
    const local = await readJson<Record<string, { odds: number; at: string }>>(LOCAL_ODDS_KEY, {});
    for (const [id, v] of Object.entries(local)) {
      if (Date.now() - Date.parse(v.at) > 2 * 3_600_000) delete local[id];
      else setLegBookOdds(id, v.odds);
    }
    await AsyncStorage.setItem(LOCAL_ODDS_KEY, JSON.stringify(local));
    await AsyncStorage.setItem(PULL_STATE_KEY, JSON.stringify({ manifestAt: manifest.updatedAt, shas: state.shas, at: Date.now() }));
    return updated;
  })()
    .catch(() => 0)
    .finally(() => {
      pulling = null;
    });
  return pulling;
}

// ---- Configuration pour le serveur : clés et réglages du téléphone, à copier une fois sur le PC.


const CONFIG_KV_KEYS = [
  '@multi_api_manager_config',
  '@telegram_config',
  '@omniroute_config',
  '@github_data_sync_config',
  '@api_quota_config',
  '@api_cache_config',
];
const CONFIG_SECURE_KEYS = ['app-adlane.github-token', 'app-adlane.football-data-api-key', 'app-adlane.gemini-api-key'];

export interface ServerConfigExport {
  format: 'adlane-server-config';
  exportedAt: string;
  kv: Record<string, string>;
  secure: Record<string, string>;
}

/** Texte JSON à coller dans le serveur du PC (clés comprises : à ne partager qu'avec soi-même). */
export async function buildServerConfigExport(): Promise<string> {
  const kv: Record<string, string> = {};
  for (const k of CONFIG_KV_KEYS) {
    const v = await AsyncStorage.getItem(k);
    if (v) kv[k] = v;
  }
  const secure: Record<string, string> = {};
  for (const k of [...CONFIG_SECURE_KEYS, ...FREE_LLM_PROVIDERS.map((p) => p.keyStorageKey)]) {
    const v = await SecureStore.getItemAsync(k).catch(() => null);
    if (v) secure[k] = v;
  }
  const out: ServerConfigExport = { format: 'adlane-server-config', exportedAt: new Date().toISOString(), kv, secure };
  return JSON.stringify(out);
}
