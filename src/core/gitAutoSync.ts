// 🔄 Sauvegarde des données locales vers GitHub
// La base de données reste sur le téléphone. Cette option crée seulement une copie JSON chiffrée en transit.

import { Directory, EncodingType, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from './kvStore';
import { isRunningOnServer } from './serverMode';
import { getAllBets, getAllCalibrations, getAllLessons, getDailyReports, restoreSnapshot } from '../database/storage';
import { fetchWithTimeout } from './httpTimeout';
import { readAllLearningFiles } from './learnStore';

const SYNC_CONFIG_KEY = '@github_data_sync_config';
const LAST_SYNC_KEY = '@last_github_data_sync';
const GITHUB_TOKEN_KEY = 'app-adlane.github-token';
const DEFAULT_SYNC_INTERVAL_MINUTES = 20;
const MAX_GITHUB_CONTENT_SIZE_BYTES = 900_000;

export interface GitHubDataSyncConfig {
  enabled: boolean;
  repoOwner: string;
  repoName: string;
  branch: string;
  dataFolderPath: string;
  localDataDirectory: string;
  interval: number;
}

interface StoredGitHubSyncConfig extends GitHubDataSyncConfig {
  token?: string;
}

interface GitHubContentResponse {
  content?: string;
  message?: string;
  sha?: string;
}

interface GitHubDirectoryItem {
  path: string;
  type: 'file' | 'dir' | string;
}

interface SyncPayload {
  exportedAt: string;
  formatVersion: 1;
  source: 'APP adlane';
  data: {
    bets: Awaited<ReturnType<typeof getAllBets>>;
    calibrations: Awaited<ReturnType<typeof getAllCalibrations>>;
    dailyReports: Awaited<ReturnType<typeof getDailyReports>>;
    lessons: Awaited<ReturnType<typeof getAllLessons>>;
  };
  /** État de la boucle d'apprentissage (appHealth.ts) — diagnostic seulement,
   * jamais relu par la restauration. */
  health?: unknown;
}

// Fourni par App.tsx plutôt qu'importé ici : appHealth dépend de modules qui
// importent eux-mêmes ce fichier, l'injection évite le cycle d'imports.
let healthProvider: (() => Promise<unknown>) | null = null;

export function setSnapshotHealthProvider(provider: () => Promise<unknown>): void {
  healthProvider = provider;
}

const DEFAULT_GITHUB_SYNC_CONFIG: GitHubDataSyncConfig = {
  enabled: true, // MODE AUTO ACTIVÉ
  repoOwner: 'idrissechaibi-alt',
  repoName: 'adlane-app',
  branch: 'main',
  dataFolderPath: 'data',
  localDataDirectory: new Directory(Paths.document, 'app-adlane', 'backups').uri,
  interval: DEFAULT_SYNC_INTERVAL_MINUTES,
};

let syncIntervalId: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;

function normalizeFolderPath(folderPath: string): string {
  return folderPath.replace(/^\/+|\/+$/g, '') || 'data';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function getSnapshotFile(config: GitHubDataSyncConfig): File {
  const backupDirectory = new Directory(config.localDataDirectory);
  return new File(backupDirectory, 'app-adlane-data.json');
}

async function getStoredConfig(): Promise<StoredGitHubSyncConfig> {
  const raw = await AsyncStorage.getItem(SYNC_CONFIG_KEY);
  if (!raw) {
    return DEFAULT_GITHUB_SYNC_CONFIG;
  }

  const parsed = JSON.parse(raw) as Partial<StoredGitHubSyncConfig>;
  return {
    ...DEFAULT_GITHUB_SYNC_CONFIG,
    ...parsed,
    dataFolderPath: normalizeFolderPath(parsed.dataFolderPath ?? DEFAULT_GITHUB_SYNC_CONFIG.dataFolderPath),
    interval:
      Number.isFinite(parsed.interval) && (parsed.interval ?? 0) > 0
        ? parsed.interval as number
        : DEFAULT_SYNC_INTERVAL_MINUTES,
  };
}

/** Récupère la configuration sans jamais exposer le token à l'interface. */
export async function getGitHubSyncConfig(): Promise<GitHubDataSyncConfig> {
  try {
    const config = await getStoredConfig();
    const { token: _legacyToken, ...publicConfig } = config;
    return publicConfig;
  } catch (error) {
    console.error('Erreur lecture config GitHub sync:', error);
    return DEFAULT_GITHUB_SYNC_CONFIG;
  }
}

/**
 * Enregistre la configuration locale.
 * Le token est stocké séparément dans Android Keystore via Expo SecureStore.
 */
export async function saveGitHubSyncConfig(
  config: Partial<GitHubDataSyncConfig> & { token?: string }
): Promise<void> {
  const existing = await getStoredConfig();
  const { token, ...publicUpdates } = config;
  const updated: GitHubDataSyncConfig = {
    ...existing,
    ...publicUpdates,
    dataFolderPath: normalizeFolderPath(publicUpdates.dataFolderPath ?? existing.dataFolderPath),
    interval:
      Number.isFinite(publicUpdates.interval) && (publicUpdates.interval ?? 0) > 0
        ? publicUpdates.interval as number
        : existing.interval,
  };

  await AsyncStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(updated));

  if (typeof token === 'string') {
    const trimmedToken = token.trim();
    if (trimmedToken) {
      await SecureStore.setItemAsync(GITHUB_TOKEN_KEY, trimmedToken);
    } else {
      await SecureStore.deleteItemAsync(GITHUB_TOKEN_KEY);
    }
  }
}

export async function isGitHubTokenConfigured(): Promise<boolean> {
  const token = await SecureStore.getItemAsync(GITHUB_TOKEN_KEY);
  return Boolean(token?.trim());
}

export async function getGitHubToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(GITHUB_TOKEN_KEY);
  return token?.trim() || null;
}

/**
 * Lit un fichier JSON du dépôt. Sert de canal de RÉCEPTION : le dépôt ne
 * contient pas que les sauvegardes envoyées par l'app, il porte aussi des
 * fichiers déposés à son intention — à commencer par le planning du jour
 * (voir fictionalProgram.ts), préparé chaque matin hors de l'app.
 *
 * Renvoie null si le fichier n'existe pas ou si l'accès échoue : un canal de
 * réception absent doit dégrader le comportement, jamais le bloquer.
 */
export async function fetchRepoJson<T>(repositoryPath: string): Promise<T | null> {
  try {
    const config = await getGitHubSyncConfig();
    const token = await getGitHubToken();
    if (!token) return null;

    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}` +
        `/contents/${repositoryPath}?ref=${encodeURIComponent(config.branch)}&t=${Date.now()}`,
      { headers: { ...githubHeaders(token), Accept: 'application/vnd.github.v3.raw', 'Cache-Control': 'no-cache' } }
    );
    if (!response.ok) return null;

    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Texte brut d'un fichier du dépôt (null s'il n'existe pas ou si l'accès échoue). */
export async function fetchRepoText(repositoryPath: string): Promise<string | null> {
  try {
    const config = await getGitHubSyncConfig();
    const token = await getGitHubToken();
    if (!token) return null;
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}` +
        `/contents/${repositoryPath}?ref=${encodeURIComponent(config.branch)}&t=${Date.now()}`,
      { headers: { ...githubHeaders(token), Accept: 'application/vnd.github.v3.raw', 'Cache-Control': 'no-cache' } },
      60_000
    );
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/** Contenu d'un dossier du dépôt : nom, chemin et empreinte (sha) de chaque fichier. */
export async function listRepoDir(repositoryPath: string): Promise<Array<{ name: string; path: string; sha: string }> | null> {
  try {
    const config = await getGitHubSyncConfig();
    const token = await getGitHubToken();
    if (!token) return null;
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}` +
        `/contents/${repositoryPath}?ref=${encodeURIComponent(config.branch)}&t=${Date.now()}`,
      { headers: { ...githubHeaders(token), 'Cache-Control': 'no-cache' } },
      30_000
    );
    if (response.status === 404) return [];
    if (!response.ok) return null;
    const list = await response.json();
    return Array.isArray(list) ? list.map((x: any) => ({ name: x.name, path: x.path, sha: x.sha })) : null;
  } catch {
    return null;
  }
}

/** Écrit un fichier texte dans le dépôt (création ou remplacement). */
export async function putRepoText(repositoryPath: string, text: string, message: string): Promise<boolean> {
  const config = await getGitHubSyncConfig();
  const token = await getGitHubToken();
  if (!token) return false;
  return putRepoFile(config, token, repositoryPath, text, message).catch(() => false);
}

/**
 * SERVEUR PC : il écrit data/server/heartbeat.json toutes les 5 min. Tant qu'il est vivant (moins de 20 min), le téléphone
 * ne fait plus le travail : il relit les résultats du serveur et lui transmet les saisies de l'utilisateur. Si le PC
 * s'arrête, le téléphone reprend tout seul.
 */
export const SERVER_HEARTBEAT_PATH = 'data/server/heartbeat.json';
const SERVER_ALIVE_MS = 20 * 60_000;
let aliveMemo: { at: number; alive: boolean; info: ServerHeartbeat | null } | null = null;

export interface ServerHeartbeat {
  at: string;
  host?: string;
  startedAt?: string;
  lastTickAt?: string | null;
  lastFullBackupAt?: string | null;
}

export async function getServerStatus(force = false): Promise<{ alive: boolean; info: ServerHeartbeat | null }> {
  if (isRunningOnServer()) return { alive: true, info: null };
  if (!force && aliveMemo && Date.now() - aliveMemo.at < 3 * 60_000) return aliveMemo;
  const info = await fetchRepoJson<ServerHeartbeat>(SERVER_HEARTBEAT_PATH);
  const alive = !!info?.at && Date.now() - Date.parse(info.at) < SERVER_ALIVE_MS;
  aliveMemo = { at: Date.now(), alive, info };
  return aliveMemo;
}

/** Vrai sur le téléphone quand le serveur du PC tourne : le téléphone se met alors en retrait. */
export async function phoneShouldStandBy(): Promise<boolean> {
  if (isRunningOnServer()) return false;
  return (await getServerStatus()).alive;
}

async function createSnapshot(): Promise<SyncPayload> {
  const [bets, lessons, calibrations, dailyReports] = await Promise.all([
    getAllBets(),
    getAllLessons(),
    getAllCalibrations(),
    getDailyReports(365),
  ]);

  let health: unknown;
  if (healthProvider) {
    try {
      health = await healthProvider();
    } catch (error) {
      health = { error: safeErrorMessage(error) };
    }
  }

  return {
    exportedAt: new Date().toISOString(),
    formatVersion: 1,
    source: 'APP adlane',
    data: { bets, calibrations, dailyReports, lessons },
    health,
  };
}

async function persistLocalSnapshot(config: GitHubDataSyncConfig, payload: SyncPayload): Promise<File> {
  const directory = new Directory(config.localDataDirectory);
  directory.create({ intermediates: true, idempotent: true });

  const snapshotFile = getSnapshotFile(config);
  if (!snapshotFile.exists) {
    snapshotFile.create({ intermediates: true });
  }

  snapshotFile.write(JSON.stringify(payload, null, 2), { encoding: EncodingType.UTF8 });
  return snapshotFile;
}

async function getRemoteFileSha(
  config: GitHubDataSyncConfig,
  token: string,
  repositoryPath: string
): Promise<{ sha: string | null; message?: string }> {
  // Ajout d'un paramètre timestamp pour éviter le cache de l'API GitHub
  const url = `https://api.github.com/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/contents/${repositoryPath}?ref=${encodeURIComponent(config.branch)}&t=${Date.now()}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      ...githubHeaders(token),
      'Cache-Control': 'no-cache'
    }
  });

  if (response.status === 404) {
    return { sha: null };
  }

  const result = await response.json() as GitHubContentResponse;
  if (!response.ok) {
    return { sha: null, message: result.message ?? `Erreur GitHub (${response.status})` };
  }

  return { sha: result.sha ?? null };
}

async function verifyGitHubAccess(config: GitHubDataSyncConfig, token: string): Promise<string | null> {
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}`,
    { headers: githubHeaders(token) }
  );

  if (response.ok) {
    return null;
  }

  const result = await response.json() as GitHubContentResponse;
  return result.message ?? `Erreur GitHub (${response.status})`;
}

/** Envoie une copie JSON des données de l'application vers GitHub. */
export async function syncDataToGitHub(
  description = 'Sauvegarde automatique des données'
): Promise<{ success: boolean; logs: string[]; uploadedFiles: number; failedFiles: number }> {
  const logs: string[] = [];

  try {
    const config = await getGitHubSyncConfig();
    if (await phoneShouldStandBy()) {
      return { success: true, logs: ['🖥️ Le serveur PC tourne : c\'est lui qui sauvegarde.'], uploadedFiles: 0, failedFiles: 0 };
    }
    if (!config.enabled) {
      return { success: true, logs: ['⏸️ Sauvegarde GitHub désactivée'], uploadedFiles: 0, failedFiles: 0 };
    }

    const token = await getGitHubToken();
    if (!token) {
      return {
        success: false,
        logs: ['❌ Token GitHub absent. Ajoutez-le dans Paramètres → Synchronisation GitHub.'],
        uploadedFiles: 0,
        failedFiles: 1,
      };
    }

    logs.push(`🔄 ${description}`);
    const accessError = await verifyGitHubAccess(config, token);
    if (accessError) {
      return {
        success: false,
        logs: [...logs, `❌ Impossible d'accéder au dépôt : ${accessError}`],
        uploadedFiles: 0,
        failedFiles: 1,
      };
    }

    const payload = await createSnapshot();
    const localFile = await persistLocalSnapshot(config, payload);
    const contentBase64 = await localFile.base64();
    const byteLength = Math.ceil((contentBase64.length * 3) / 4);

    if (byteLength > MAX_GITHUB_CONTENT_SIZE_BYTES) {
      return {
        success: false,
        logs: [
          ...logs,
          `❌ La sauvegarde fait environ ${Math.ceil(byteLength / 1024)} Ko, au-delà de la limite de sécurité de 900 Ko.`,
        ],
        uploadedFiles: 0,
        failedFiles: 1,
      };
    }

    const repositoryPath = `${normalizeFolderPath(config.dataFolderPath)}/app-adlane-data.json`;
    const remoteFile = await getRemoteFileSha(config, token, repositoryPath);
    if (remoteFile.message) {
      return {
        success: false,
        logs: [...logs, `❌ Impossible de vérifier la sauvegarde existante : ${remoteFile.message}`],
        uploadedFiles: 0,
        failedFiles: 1,
      };
    }

    const body: {
      branch: string;
      content: string;
      message: string;
      sha?: string;
    } = {
      branch: config.branch,
      content: contentBase64,
      message: `[APP adlane] ${description} — ${payload.exportedAt}`,
    };

    if (remoteFile.sha) {
      body.sha = remoteFile.sha;
    }

    const uploadResponse = await fetchWithTimeout(
      `https://api.github.com/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/contents/${repositoryPath}`,
      {
        method: 'PUT',
        headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const uploadResult = await uploadResponse.json() as GitHubContentResponse;

    if (!uploadResponse.ok) {
      return {
        success: false,
        logs: [...logs, `❌ GitHub a refusé la sauvegarde : ${uploadResult.message ?? uploadResponse.status}`],
        uploadedFiles: 0,
        failedFiles: 1,
      };
    }

    await AsyncStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    logs.push(`✅ Sauvegarde créée : ${repositoryPath}`);
    return { success: true, logs, uploadedFiles: 1, failedFiles: 0 };
  } catch (error) {
    return {
      success: false,
      logs: [`❌ Erreur pendant la sauvegarde : ${safeErrorMessage(error)}`],
      uploadedFiles: 0,
      failedFiles: 1,
    };
  }
}

/**
 * Télécharge la sauvegarde depuis GitHub et l'installe dans la base de données locale.
 * Cette action remplace les données actuelles de l'application.
 */
export async function syncDataFromGitHub(): Promise<{
  success: boolean;
  logs: string[];
  downloadedFiles: number;
  failedFiles: number;
  skippedFiles: number;
}> {
  const logs: string[] = [];
  try {
    const config = await getGitHubSyncConfig();
    const token = await getGitHubToken();

    if (!token) {
      return {
        success: false,
        logs: ['❌ Token GitHub absent. Ajoutez-le dans les paramètres.'],
        downloadedFiles: 0,
        failedFiles: 1,
        skippedFiles: 0,
      };
    }

    const repositoryPath = `${normalizeFolderPath(config.dataFolderPath)}/app-adlane-data.json`;
    logs.push(`🔄 Recherche de la sauvegarde sur GitHub...`);

    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/contents/${repositoryPath}?ref=${encodeURIComponent(config.branch)}`,
      {
        headers: {
          ...githubHeaders(token),
          Accept: 'application/vnd.github.v3.raw',
        },
      }
    );

    if (response.status === 404) {
      return {
        success: false,
        logs: [...logs, `❌ Aucune sauvegarde trouvée à l'emplacement : ${repositoryPath}`],
        downloadedFiles: 0,
        failedFiles: 1,
        skippedFiles: 0,
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      return {
        success: false,
        logs: [...logs, `❌ Erreur GitHub (${response.status}) : ${errorData.message}`],
        downloadedFiles: 0,
        failedFiles: 1,
        skippedFiles: 0,
      };
    }

    const payload = await response.json() as SyncPayload;

    if (payload.source !== 'APP adlane') {
      return {
        success: false,
        logs: [...logs, '❌ Le fichier trouvé n’est pas une sauvegarde Adlane valide.'],
        downloadedFiles: 0,
        failedFiles: 1,
        skippedFiles: 0,
      };
    }

    logs.push(`📥 Sauvegarde récupérée (datant du ${new Date(payload.exportedAt).toLocaleString()})`);
    logs.push('🔄 Restauration dans SQLite...');

    await restoreSnapshot(payload.data);

    logs.push('✅ Restauration terminée avec succès !');
    return {
      success: true,
      logs,
      downloadedFiles: 1,
      failedFiles: 0,
      skippedFiles: 0,
    };
  } catch (error) {
    console.error('Erreur restauration GitHub:', error);
    return {
      success: false,
      logs: [`❌ Erreur pendant la restauration : ${safeErrorMessage(error)}`],
      downloadedFiles: 0,
      failedFiles: 1,
      skippedFiles: 0,
    };
  }
}

// ==================== SAUVEGARDE COMPLÈTE (apprentissage) ====================
// Tout ce que l'app a appris (paris, compteurs, modèle, cotes saisies, échantillons…) est copié
// dans data/full-backup/, découpé en morceaux < 700 Ko (limite de l'API GitHub), uniquement
// quand un morceau a changé. Les clés contenant token / clé d'API / configuration sont exclues.

const FULL_BACKUP_HASHES_KEY = '@full_backup_hashes';
const FULL_BACKUP_LAST_KEY = '@full_backup_last';
let FULL_BACKUP_MIN_INTERVAL_MS = 3 * 3_600_000;
/** Serveur PC : sauvegarde complète plus fréquente (le téléphone y relit ses écrans). */
export function setFullBackupMinInterval(ms: number): void {
  FULL_BACKUP_MIN_INTERVAL_MS = ms;
}
const CHUNK_CHARS = 250_000; // ≈ 750 Ko en UTF-8 au pire des cas accentués
const SECRET_KEY = /key|token|secret|password|config|credential|auth|telegram|omniroute|api/i;
const LEARNING_KEY = /odds|bookie|delta|situation|learn|calib|market|strateg|expert|pending|missing|digest|stats|lesson|review|proposal|paper|pattern|venue|alias|players|lineup/i;

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

async function putRepoFile(config: GitHubDataSyncConfig, token: string, repositoryPath: string, text: string, message: string): Promise<boolean> {
  const directory = new Directory(config.localDataDirectory);
  directory.create({ intermediates: true, idempotent: true });
  const tmp = new File(directory, 'full-backup-chunk.tmp');
  if (!tmp.exists) tmp.create({ intermediates: true });
  tmp.write(text, { encoding: EncodingType.UTF8 });
  const content = await tmp.base64();
  const remote = await getRemoteFileSha(config, token, repositoryPath);
  if (remote.message) return false;
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/contents/${repositoryPath}`,
    {
      method: 'PUT',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: config.branch, content, message, ...(remote.sha ? { sha: remote.sha } : {}) }),
    },
    30_000
  );
  return response.ok;
}

/** Copie complète de l'apprentissage vers GitHub. `force` ignore le délai minimal de 3 h. */
export async function syncFullBackupToGitHub(force = false): Promise<{ uploaded: number; unchanged: number; failed: number; skipped?: string }> {
  try {
    // Serveur PC actif : c'est lui qui sauvegarde ; le téléphone écraserait ses données par une copie en retard.
    if (await phoneShouldStandBy()) return { uploaded: 0, unchanged: 0, failed: 0, skipped: 'serveur PC actif' };
    const config = await getGitHubSyncConfig();
    if (!config.enabled) return { uploaded: 0, unchanged: 0, failed: 0, skipped: 'désactivée' };
    const token = await getGitHubToken();
    if (!token) return { uploaded: 0, unchanged: 0, failed: 0, skipped: 'token absent' };
    const last = Number(await AsyncStorage.getItem(FULL_BACKUP_LAST_KEY)) || 0;
    if (!force && Date.now() - last < FULL_BACKUP_MIN_INTERVAL_MS) return { uploaded: 0, unchanged: 0, failed: 0, skipped: 'trop récent' };

    const entries: Array<{ name: string; text: string }> = readAllLearningFiles().map((f) => ({ name: `files/${f.name}`, text: f.text }));
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => LEARNING_KEY.test(k) && !SECRET_KEY.test(k));
    for (const [k, v] of await AsyncStorage.multiGet(keys)) if (v && v.length > 2) entries.push({ name: `storage/${k.replace(/[^A-Za-z0-9_.-]/g, '_')}`, text: v });

    const hashes: Record<string, string> = JSON.parse((await AsyncStorage.getItem(FULL_BACKUP_HASHES_KEY)) ?? '{}');
    const base = `${normalizeFolderPath(config.dataFolderPath)}/full-backup`;
    const manifest: Record<string, number> = {};
    let uploaded = 0, unchanged = 0, failed = 0;
    const deadline = Date.now() + 120_000;
    for (const entry of entries) {
      const parts = Math.max(1, Math.ceil(entry.text.length / CHUNK_CHARS));
      manifest[entry.name] = parts;
      for (let i = 0; i < parts; i++) {
        const chunk = entry.text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
        const id = `${entry.name}.part${i + 1}`;
        const h = hashText(chunk);
        if (hashes[id] === h) { unchanged++; continue; }
        if (Date.now() > deadline) { failed++; continue; }
        const ok = await putRepoFile(config, token, `${base}/${id}.txt`, chunk, `[APP adlane] Sauvegarde complète ${id}`).catch(() => false);
        if (ok) { hashes[id] = h; uploaded++; } else failed++;
      }
    }
    await AsyncStorage.setItem(FULL_BACKUP_HASHES_KEY, JSON.stringify(hashes));
    if (failed === 0) {
      await AsyncStorage.setItem(FULL_BACKUP_LAST_KEY, String(Date.now()));
      await putRepoFile(config, token, `${base}/manifest.json`, JSON.stringify({ updatedAt: new Date().toISOString(), parts: manifest }), '[APP adlane] Sauvegarde complète : manifeste').catch(() => false);
    }
    return { uploaded, unchanged, failed };
  } catch (error) {
    console.warn('Sauvegarde complète GitHub échouée:', safeErrorMessage(error));
    return { uploaded: 0, unchanged: 0, failed: 1 };
  }
}

/** Sauvegarde automatiquement toutes les 20 minutes lorsque l'option est activée. */
export async function startAutoSync(): Promise<void> {
  const config = await getGitHubSyncConfig();
  stopAutoSync();

  if (!config.enabled) {
    console.log('⏸️ Sauvegarde GitHub désactivée');
    return;
  }

  void syncDataToGitHub('Sauvegarde au démarrage').then(() => syncFullBackupToGitHub());
  syncIntervalId = setInterval(() => {
    void syncDataToGitHub('Sauvegarde planifiée').then(() => syncFullBackupToGitHub());
  }, config.interval * 60 * 1000);
}

export function stopAutoSync(): void {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}

export async function getLastSyncTime(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_SYNC_KEY);
}

/** À appeler après une écriture locale importante. */
export async function onRequestEnd(description: string): Promise<void> {
  const config = await getGitHubSyncConfig();
  if (!config.enabled || syncInProgress) {
    return;
  }

  syncInProgress = true;
  try {
    const result = await syncDataToGitHub(description);
    if (!result.success) {
      console.warn(result.logs.join('\n'));
    }
  } finally {
    syncInProgress = false;
  }
}
