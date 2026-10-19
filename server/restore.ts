// Copie sur le PC de la dernière sauvegarde complète du téléphone (data/full-backup) : elle entre dans l'archive locale
// quotidienne (backup.ts), pour que toutes les données de l'app soient aussi gardées sur le PC.
//
// Le téléphone envoie sa sauvegarde morceau par morceau, puis le manifeste en dernier : pendant un envoi, le dépôt mélange
// deux versions d'un même fichier. Chaque fichier est donc d'abord lu dans son état actuel ; s'il est illisible, il est
// relu tel qu'il était au commit du dernier manifeste (état cohérent).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lastCommitTouching, repoText } from './github';
import { log } from './log';
import { dataRoot } from './paths';

const MANIFEST = 'data/full-backup/manifest.json';

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

export async function mirrorPhoneBackup(): Promise<{ files: number; missing: string[]; backupOf: string }> {
  const current: Reader = (p) => repoText(p).catch(() => null);
  const manifestRaw = await current(MANIFEST);
  if (!manifestRaw) throw new Error('aucune sauvegarde complète du téléphone dans le dépôt');
  const manifest: { updatedAt: string; parts: Record<string, number> } = JSON.parse(manifestRaw);
  let snapshot: Reader | null = null;
  const consistent = async (): Promise<Reader | null> => {
    if (snapshot) return snapshot;
    const sha = await lastCommitTouching(MANIFEST).catch(() => null);
    if (!sha) return null;
    snapshot = (p) => repoText(p, sha).catch(() => null);
    return snapshot;
  };
  const out = path.join(dataRoot(), 'copie-telephone');
  let files = 0;
  const missing: string[] = [];
  for (const [name, parts] of Object.entries(manifest.parts)) {
    let text = await assemble(current, name, parts);
    if (text == null) {
      const snap = await consistent();
      text = snap ? await assemble(snap, name, parts) : null;
      if (text != null) log(`Copie du téléphone : ${name} pris dans la dernière sauvegarde cohérente (${manifest.updatedAt}).`);
    }
    if (text == null) {
      missing.push(name);
      continue;
    }
    const file = path.join(out, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    files++;
  }
  fs.writeFileSync(path.join(out, 'copie.json'), JSON.stringify({ at: new Date().toISOString(), backupOf: manifest.updatedAt, files, missing }, null, 2));
  return { files, missing, backupOf: manifest.updatedAt };
}
