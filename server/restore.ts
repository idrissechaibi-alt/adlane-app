// Reprise des données depuis la dernière sauvegarde complète du téléphone (data/full-backup).
//
// Le téléphone envoie sa sauvegarde morceau par morceau, puis le manifeste en dernier : pendant un envoi, le dépôt mélange
// deux versions d'un même fichier. Chaque fichier est donc d'abord lu dans son état actuel ; s'il est illisible, il est
// relu tel qu'il était au commit du dernier manifeste (état cohérent, au prix de quelques heures de retard).
import * as fs from 'node:fs';
import * as path from 'node:path';
import kvStore from '../src/core/kvStore';
import { replaceLearningFile, readAllLearningFiles } from '../src/core/learnStore';
import { lastCommitTouching, repoText } from './github';
import { log } from './log';
import { serverRoot } from './paths';

const MANIFEST = 'data/full-backup/manifest.json';
const marker = () => path.join(serverRoot(), 'restored.json');

export function alreadyRestored(): boolean {
  return fs.existsSync(marker());
}

type Reader = (p: string) => Promise<string | null>;

async function assemble(read: Reader, name: string, parts: number): Promise<string | null> {
  let text = '';
  for (let i = 1; i <= parts; i++) {
    const chunk = await read(`data/full-backup/${name}.part${i}.txt`);
    if (chunk == null) return null;
    text += chunk;
  }
  // Un JSON coupé ou mélangé (envoi en cours) est refusé plutôt que gardé cassé.
  if (name.endsWith('.json') || (name.startsWith('storage/') && /^\s*[[{]/.test(text))) {
    try {
      JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

/**
 * `localRepo` : clone du dépôt sur le PC (lecture directe) ; sinon GitHub. `onlyMissing` : ne reprend que les fichiers
 * d'apprentissage absents du PC (réparation d'une reprise incomplète, à chaque démarrage).
 */
export async function restoreFromFullBackup(localRepo?: string, onlyMissing = false): Promise<{ files: number; keys: number; missing: string[] }> {
  const current: Reader = async (p) => {
    if (localRepo) {
      try {
        return fs.readFileSync(path.join(localRepo, p), 'utf8');
      } catch {
        // pas dans le clone : on tente GitHub
      }
    }
    return repoText(p).catch(() => null);
  };
  const manifestRaw = await current(MANIFEST);
  if (!manifestRaw) throw new Error('aucune sauvegarde complète dans le dépôt (data/full-backup/manifest.json)');
  const manifest: { updatedAt: string; parts: Record<string, number> } = JSON.parse(manifestRaw);

  let snapshot: Reader | null = null;
  const consistent = async (): Promise<Reader | null> => {
    if (snapshot) return snapshot;
    const sha = await lastCommitTouching(MANIFEST).catch(() => null);
    if (!sha) return null;
    snapshot = (p) => repoText(p, sha).catch(() => null);
    return snapshot;
  };

  const have = new Set(onlyMissing ? readAllLearningFiles().map((f) => `files/${f.name}`) : []);
  let files = 0;
  let keys = 0;
  const missing: string[] = [];
  for (const [name, parts] of Object.entries(manifest.parts)) {
    // Paris : un fichier présent mais bien plus petit que la sauvegarde (reprise ratée, puis quelques paris créés depuis)
    // est complété : sauvegarde + paris créés ici, sans doublon.
    const localProposals = name === 'files/inplay-proposals.json' && onlyMissing ? readAllLearningFiles().find((f) => f.name === 'inplay-proposals.json')?.text ?? null : null;
    const proposalsShort = localProposals != null && localProposals.length < parts * 250_000 * 0.3;
    if (onlyMissing && !proposalsShort && (!name.startsWith('files/') || have.has(name))) continue;
    let text = await assemble(current, name, parts);
    if (text == null) {
      const snap = await consistent();
      text = snap ? await assemble(snap, name, parts) : null;
      if (text != null) log(`Reprise : ${name} pris dans la dernière sauvegarde complète cohérente (${manifest.updatedAt}).`);
    }
    if (text == null) {
      log(`Reprise : ${name} illisible, ignoré`);
      missing.push(name);
      continue;
    }
    if (proposalsShort && localProposals) {
      try {
        const remote: Array<{ id: string }> = JSON.parse(text);
        const ids = new Set(remote.map((p) => p.id));
        const extra = (JSON.parse(localProposals) as Array<{ id: string }>).filter((p) => !ids.has(p.id));
        text = JSON.stringify([...remote, ...extra]);
        log(`Réparation des paris : ${remote.length} repris de la sauvegarde + ${extra.length} créés sur le PC.`);
      } catch {
        // fichier local illisible : la sauvegarde seule
      }
    }
    if (name.startsWith('files/')) {
      replaceLearningFile(name.slice('files/'.length), text);
      files++;
    } else if (name.startsWith('storage/')) {
      await kvStore.setItem(name.slice('storage/'.length).replace(/^_/, '@'), text);
      keys++;
    }
  }
  if (!onlyMissing) {
    fs.mkdirSync(serverRoot(), { recursive: true });
    fs.writeFileSync(marker(), JSON.stringify({ at: new Date().toISOString(), backupOf: manifest.updatedAt, files, keys, missing }, null, 2));
  }
  return { files, keys, missing };
}
