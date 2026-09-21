// 🔄 Sauvegarde des données locales vers GitHub
// La base de données reste sur le téléphone. Cette option crée seulement une copie JSON chiffrée en transit.

import { Directory, EncodingType, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAllBets, getAllCalibrations, getAllLessons, getDailyReports, restoreSnapshot } from '../database/storage';

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

async function getGitHubToken(): Promise<string | null> {
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

    const response = await fetch(
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

async function createSnapshot(): Promise<SyncPayload> {
  const [bets, lessons, calibrations, dailyReports] = await Promise.all([
    getAllBets(),
    getAllLessons(),
    getAllCalibrations(),
    getDailyReports(365),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    formatVersion: 1,
    source: 'APP adlane',
    data: { bets, calibrations, dailyReports, lessons },
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

  const response = await fetch(url, {
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
  const response = await fetch(
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

    const uploadResponse = await fetch(
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

    const response = await fetch(
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

/** Sauvegarde automatiquement toutes les 20 minutes lorsque l'option est activée. */
export async function startAutoSync(): Promise<void> {
  const config = await getGitHubSyncConfig();
  stopAutoSync();

  if (!config.enabled) {
    console.log('⏸️ Sauvegarde GitHub désactivée');
    return;
  }

  void syncDataToGitHub('Sauvegarde au démarrage');
  syncIntervalId = setInterval(() => {
    void syncDataToGitHub('Sauvegarde planifiée');
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
