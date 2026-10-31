// SERVEUR PC de l'app adlane : COLLECTEUR. Relève les stats de chaque match en direct minute par minute et le résultat
// final de chaque match terminé, et les publie pour le téléphone (data/server/live, lu par src/core/serverFeed.ts).
// L'analyse, les paris, les notifications, le règlement et l'apprentissage restent sur le téléphone (choix du 20/10).
// Garde aussi sur le PC une archive quotidienne de toutes les données de l'app (copie de la sauvegarde du téléphone +
// collecte du serveur).
//
//   node server/dist/server.js                      démarrage normal
//   node server/dist/server.js --import-config F    importe la configuration envoyée par le téléphone (fichier F)
//   node server/dist/server.js --once               un passage de collecte puis arrêt (test)
//   node server/dist/server.js --backup-now         archive locale immédiate (<serveur>/sauvegardes)
//   node server/dist/server.js --base-now           base équipes et joueurs immédiate (<serveur>/base-equipes-joueurs)
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { setRunningOnServer, setServerHttp } from '../src/core/serverMode';
import { curlGet } from './curl';
setRunningOnServer();
setServerHttp(curlGet);

import kvStore from '../src/core/kvStore';
import * as SecureStore from 'expo-secure-store';
import { putRepoText, SERVER_HEARTBEAT_PATH } from '../src/core/gitAutoSync';
import { collectOnce, publish } from './collector';
import { collectLineups } from './lineups';
import { collectDueSites, loadSites, publishWeb, pruneWebFeed, webStatus } from './webCollector';
import { mirrorPhoneBackup } from './restore';
import { log, pruneLogs } from './log';
import { dataRoot, serverRoot } from './paths';
import { backupDueToday, makeLocalBackup } from './backup';
import { backupPlayersAndTeams } from './baseEquipesJoueurs';
import { refreshBanks } from './banks';

async function importConfig(file: string): Promise<void> {
  // PowerShell enregistre le texte collé avec une marque BOM en tête : retirée avant lecture.
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim());
  if (cfg?.format !== 'adlane-server-config') throw new Error("ce fichier n'est pas une configuration envoyée par l'app (bouton « Configurer le serveur PC »)");
  for (const [k, v] of Object.entries<string>(cfg.kv ?? {})) {
    let value = v;
    // Dossier local du téléphone : sans objet sur le PC.
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

const startedAt = new Date().toISOString();
let lastCollectAt: string | null = null;
let lastPublishAt: string | null = null;
let liveNow = 0;
let samplesSinceStart = 0;

/** Etat lu par l'icône « adlane serveur » : le journal reste silencieux quand rien ne change, ce fichier non. */
function writeStatus(): void {
  try {
    fs.writeFileSync(
      path.join(serverRoot(), 'statut.json'),
      JSON.stringify({ at: new Date().toISOString(), startedAt, lastCollectAt, lastPublishAt, liveMatches: liveNow, samplesSinceStart, sites: webStatus() })
    );
  } catch {
    // disque inaccessible : l'icône retombera sur le journal
  }
}

async function heartbeat(): Promise<void> {
  const ok = await putRepoText(
    SERVER_HEARTBEAT_PATH,
    JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), role: 'collecte', startedAt, lastTickAt: lastCollectAt, liveMatches: liveNow, sites: webStatus() }, null, 2),
    '[serveur PC] Battement de cœur'
  ).catch(() => false);
  if (!ok) log('Battement de cœur non envoyé (réseau ou jeton GitHub ?)');
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

/** Lance `fn` toutes les `ms`, jamais deux fois en même temps, sans jamais laisser une erreur arrêter le serveur. */
function every(name: string, ms: number, fn: () => Promise<unknown>, runNow = true): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e: any) {
      log(`${name} : erreur ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  };
  if (runNow) void run();
  setInterval(run, ms);
}

/** Archive locale du jour : copie à jour de la sauvegarde du téléphone, puis archive de tout le dossier de données. */
async function dailyArchive(force = false): Promise<void> {
  if (!force && !backupDueToday()) return;
  const r = await mirrorPhoneBackup().catch((e) => {
    log(`Copie de la sauvegarde du téléphone impossible : ${e?.message ?? e}`);
    return null;
  });
  if (r) log(`Copie de la sauvegarde du téléphone : ${r.files} fichiers${r.missing.length ? ` (illisibles : ${r.missing.join(', ')})` : ''}.`);
  makeLocalBackup();
  try {
    backupPlayersAndTeams();
  } catch (e: any) {
    log(`Base équipes et joueurs échouée : ${e?.message ?? e}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  fs.mkdirSync(serverRoot(), { recursive: true });
  log(`Serveur adlane (collecte) — données dans ${dataRoot()}`);

  const imp = args.indexOf('--import-config');
  if (imp >= 0) {
    await importConfig(args[imp + 1]);
    return;
  }
  if (args.includes('--base-now')) {
    backupPlayersAndTeams();
    return;
  }
  if (args.includes('--backup-now')) {
    await dailyArchive(true);
    return;
  }
  if (args.includes('--once')) {
    const r = await collectOnce();
    log(`Passage de test : ${r.live} match(s) en direct, ${r.sampled} relevé(s).`);
    return;
  }

  every('Collecte', 30_000, async () => {
    const r = await collectOnce();
    lastCollectAt = new Date().toISOString();
    samplesSinceStart += r.sampled;
    if (r.live !== liveNow || r.finals) log(`Collecte : ${r.live} match(s) en direct, ${r.sampled} relevé(s)${r.finals ? `, ${r.finals} résultat(s) final(aux)` : ''}.`);
    liveNow = r.live;
    writeStatus();
  });
  every('Publication', 30_000, async () => {
    if (await publish()) lastPublishAt = new Date().toISOString();
    writeStatus();
  }, false);
  // Une ligne de journal toutes les 15 min même quand rien ne change : on voit que le serveur est vivant.
  every('Pouls', 15 * 60_000, async () => log(`Serveur actif : ${liveNow} match(s) en direct, ${samplesSinceStart} relevé(s) depuis le démarrage.`), false);
  // Sites web déclarés dans <serveur>/sites.json : relevés toutes les 30 s (échéance propre à chaque site), publiés toutes
  // les 60 s pour le téléphone.
  log(`Sites web à lire : ${loadSites().length}.`);
  // Compositions de l'heure à venir, recoupées (3 sources minimum) et publiées pour le téléphone.
  every('Compositions', 3 * 60_000, collectLineups, false);
  every('Sites web', 10_000, collectDueSites);
  every('Publication web', 30_000, publishWeb, false);
  every('Nettoyage des relevés web', 24 * 3_600_000, pruneWebFeed, false);
  every('Battement de cœur', 5 * 60_000, heartbeat);
  every('Mise à jour du code', 30 * 60_000, async () => {
    if (codeUpdateAvailable()) {
      await publish().catch(() => false);
      log('Nouveau code publié : arrêt pour mise à jour (relance automatique).');
      process.exit(0);
    }
  }, false);
  every('Banques de données', 6 * 3_600_000, () => refreshBanks());
  every('Sauvegarde locale', 3_600_000, () => dailyArchive());
  every('Nettoyage des journaux', 24 * 3_600_000, async () => pruneLogs());
  log('Serveur démarré.');
}

process.on('unhandledRejection', (e: any) => log('Rejet non géré :', e?.message ?? String(e)));
process.on('uncaughtException', (e: any) => log('Exception non gérée :', e?.message ?? String(e)));

main().then(
  () => {
    if (['--import-config', '--once', '--backup-now', '--base-now'].some((a) => process.argv.includes(a))) process.exit(0);
  },
  (e) => {
    log(`Arrêt : ${e?.message ?? e}`);
    process.exit(1);
  }
);
