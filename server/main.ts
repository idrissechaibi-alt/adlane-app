// SERVEUR PC de l'app adlane : fait tourner, en continu, le même moteur que le téléphone (src/core) — scan réel chaque
// minute, tour complet toutes les 3 min (fictif, marqueurs, bilan de minuit, rapport de 23h30, sauvegardes GitHub).
// Le téléphone se met en retrait tant que ce serveur envoie son battement de cœur (voir src/core/serverLink.ts).
//
//   node server/dist/server.js                      démarrage normal
//   node server/dist/server.js --import-config F    importe la configuration envoyée par le téléphone (fichier F)
//   node server/dist/server.js --once               un seul tour puis arrêt (test)
//   node server/dist/server.js --backup-now         sauvegarde locale immédiate (<serveur>/sauvegardes)
//   --restore-from <dossier du dépôt>               premier démarrage : reprise depuis le clone local plutôt que GitHub
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { setRunningOnServer } from '../src/core/serverMode';
setRunningOnServer();

import kvStore from '../src/core/kvStore';
import * as SecureStore from 'expo-secure-store';
import { initDatabase, seedDatabaseIfEmpty } from '../src/database/storage';
import { runAutoLearnTick, runRealFastTick } from '../src/core/backgroundTasks';
import { putRepoText, SERVER_HEARTBEAT_PATH, setFullBackupMinInterval, setSnapshotHealthProvider, startAutoSync, syncFullBackupToGitHub } from '../src/core/gitAutoSync';
import { buildAppHealth } from '../src/core/appHealth';
import { processInbox } from './inbox';
import { alreadyRestored, restoreFromFullBackup } from './restore';
import { log, pruneLogs } from './log';
import { dataRoot, serverRoot } from './paths';
import { backupDueToday, makeLocalBackup } from './backup';

const REAL_TICK_MS = 60_000;
const FULL_TICK_MS = 3 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const INBOX_MS = 2 * 60_000;

async function importConfig(file: string): Promise<void> {
  // PowerShell enregistre le texte collé avec une marque BOM en tête : retirée avant lecture.
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim());
  if (cfg?.format !== 'adlane-server-config') throw new Error("ce fichier n'est pas une configuration envoyée par l'app (bouton « Configurer le serveur PC »)");
  for (const [k, v] of Object.entries<string>(cfg.kv ?? {})) {
    let value = v;
    // Dossier local du téléphone : sans objet sur le PC (le serveur garde le sien).
    if (k === '@github_data_sync_config') {
      const c = JSON.parse(v);
      delete c.localDataDirectory;
      value = JSON.stringify(c);
    }
    await kvStore.setItem(k, value);
  }
  for (const [k, v] of Object.entries<string>(cfg.secure ?? {})) await SecureStore.setItemAsync(k, v);
  log(`Configuration importée : ${Object.keys(cfg.kv ?? {}).length} réglages, ${Object.keys(cfg.secure ?? {}).length} clés.`);
}

let lastTickAt: string | null = null;
let lastFullBackupAt: string | null = null;
const startedAt = new Date().toISOString();

async function heartbeat(): Promise<void> {
  const ok = await putRepoText(
    SERVER_HEARTBEAT_PATH,
    JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), startedAt, lastTickAt, lastFullBackupAt }, null, 2),
    '[serveur PC] Battement de cœur'
  ).catch(() => false);
  if (!ok) log('Battement de cœur non envoyé (réseau ou jeton GitHub ?)');
}

/** Lance `fn` toutes les `ms`, jamais deux fois en même temps, sans jamais laisser une erreur arrêter le serveur. */
function every(name: string, ms: number, fn: () => Promise<unknown>): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    const t0 = Date.now();
    try {
      await fn();
    } catch (e: any) {
      log(`${name} : erreur ${e?.message ?? e}`);
    } finally {
      running = false;
      const s = Math.round((Date.now() - t0) / 1000);
      if (s >= 60) log(`${name} : ${s} s`);
    }
  };
  void run();
  setInterval(run, ms);
}

/** Nouveau code (src/ ou server/) sur GitHub depuis le démarrage ? Le lanceur (run-server.cmd) met à jour et relance. */
function codeUpdateAvailable(): boolean {
  try {
    execSync('git fetch --depth 1 origin main', { stdio: 'ignore', timeout: 120_000 });
    execSync('git diff --quiet HEAD origin/main -- src server', { stdio: 'ignore' });
    return false;
  } catch (e: any) {
    // `git diff --quiet` sort en code 1 quand il y a une différence ; tout autre échec (pas de clone, réseau) : on reste.
    return e?.status === 1;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  fs.mkdirSync(serverRoot(), { recursive: true });
  log(`Serveur adlane — données dans ${dataRoot()}`);

  const imp = args.indexOf('--import-config');
  if (imp >= 0) {
    await importConfig(args[imp + 1]);
    return;
  }

  const from = args.indexOf('--restore-from');
  const localRepo = from >= 0 ? args[from + 1] : undefined;
  if (!alreadyRestored()) {
    log('Premier démarrage : reprise des données depuis la sauvegarde complète du téléphone…');
    const r = await restoreFromFullBackup(localRepo);
    log(`Reprise terminée : ${r.files} fichiers, ${r.keys} réglages d'apprentissage${r.missing.length ? ` ; illisibles : ${r.missing.join(', ')}` : ''}.`);
  } else {
    // Réparation : un fichier d'apprentissage absent (reprise faite pendant un envoi du téléphone) est repris.
    const r = await restoreFromFullBackup(localRepo, true).catch(() => null);
    if (r && r.files > 0) log(`Réparation : ${r.files} fichier(s) d'apprentissage repris.`);
  }

  await initDatabase();
  await seedDatabaseIfEmpty().catch(() => {});
  setSnapshotHealthProvider(buildAppHealth);
  // Sauvegarde complète toutes les 30 min (au lieu de 3 h) : le téléphone y relit ses écrans.
  setFullBackupMinInterval(30 * 60_000);

  if (args.includes('--backup-now')) {
    makeLocalBackup();
    return;
  }

  if (args.includes('--once')) {
    await runRealFastTick();
    const d = await runAutoLearnTick('all');
    log('Tour de test terminé', d);
    return;
  }

  await startAutoSync();
  every('Battement de cœur', HEARTBEAT_MS, heartbeat);
  every('Saisies du téléphone', INBOX_MS, processInbox);
  every('Scan réel', REAL_TICK_MS, () => runRealFastTick());
  every('Tour complet', FULL_TICK_MS, async () => {
    const d: any = await runAutoLearnTick('all');
    lastTickAt = new Date().toISOString();
    log(`Tour complet : ${d?.freshInPlayProposals ?? 0} nouveau(x) pari(s), ${d?.liveFixturesFound ?? 0} match(s) réel(s) et ${d?.fictionalLiveFixturesFound ?? 0} fictif(s) en direct${d?.nightlyReviewError ? `, bilan en erreur : ${d.nightlyReviewError}` : ''}.`);
  });
  every('Mise à jour du code', 30 * 60_000, async () => {
    if (codeUpdateAvailable()) {
      log('Nouveau code publié : arrêt pour mise à jour (relance automatique).');
      process.exit(0);
    }
  });
  every('Sauvegarde complète', 30 * 60_000, async () => {
    const r = await syncFullBackupToGitHub();
    if (!r.skipped) lastFullBackupAt = new Date().toISOString();
  });
  every('Nettoyage des journaux', 24 * 3_600_000, async () => pruneLogs());
  // Sauvegarde locale du jour (archive dans <serveur>/sauvegardes), vérifiée toutes les heures.
  every('Sauvegarde locale', 3_600_000, async () => {
    if (backupDueToday()) makeLocalBackup();
  });
  log('Serveur démarré.');
}

process.on('unhandledRejection', (e: any) => log('Rejet non géré :', e?.message ?? String(e)));
process.on('uncaughtException', (e: any) => log('Exception non gérée :', e?.message ?? String(e)));

main().then(
  () => {
    if (['--import-config', '--once', '--backup-now'].some((a) => process.argv.includes(a))) process.exit(0);
  },
  (e) => {
    log(`Arrêt : ${e?.message ?? e}`);
    process.exit(1);
  }
);
