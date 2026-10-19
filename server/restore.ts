// Premier démarrage : reprise de toutes les données depuis la dernière sauvegarde complète du téléphone (data/full-backup).
import * as fs from 'node:fs';
import * as path from 'node:path';
import kvStore from '../src/core/kvStore';
import { replaceLearningFile } from '../src/core/learnStore';
import { repoText } from './github';
import { log } from './log';
import { serverRoot } from './paths';

const marker = () => path.join(serverRoot(), 'restored.json');

export function alreadyRestored(): boolean {
  return fs.existsSync(marker());
}

/** `localRepo` : clone du dépôt sur le PC (lecture directe, sans jeton) ; sinon lecture sur GitHub. */
export async function restoreFromFullBackup(localRepo?: string): Promise<{ files: number; keys: number }> {
  const read = async (p: string): Promise<string | null> => {
    if (!localRepo) return repoText(p);
    try {
      return fs.readFileSync(path.join(localRepo, p), 'utf8');
    } catch {
      return null;
    }
  };
  const manifestRaw = await read('data/full-backup/manifest.json');
  if (!manifestRaw) throw new Error('aucune sauvegarde complète dans le dépôt (data/full-backup/manifest.json)');
  const manifest: { updatedAt: string; parts: Record<string, number> } = JSON.parse(manifestRaw);
  let files = 0;
  let keys = 0;
  for (const [name, parts] of Object.entries(manifest.parts)) {
    let text = '';
    let ok = true;
    for (let i = 1; i <= parts; i++) {
      const chunk = await read(`data/full-backup/${name}.part${i}.txt`);
      if (chunk == null) {
        ok = false;
        break;
      }
      text += chunk;
    }
    if (!ok) {
      log(`Reprise : ${name} incomplet, ignoré`);
      continue;
    }
    // Une sauvegarde en cours d'envoi peut mélanger deux versions : un JSON illisible est écarté plutôt que gardé cassé.
    if (name.endsWith('.json') || (name.startsWith('storage/') && /^\s*[[{]/.test(text))) {
      try {
        JSON.parse(text);
      } catch {
        log(`Reprise : ${name} illisible (sauvegarde en cours d'envoi ?), ignoré`);
        continue;
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
  fs.mkdirSync(serverRoot(), { recursive: true });
  fs.writeFileSync(marker(), JSON.stringify({ at: new Date().toISOString(), backupOf: manifest.updatedAt, files, keys }, null, 2));
  return { files, keys };
}
