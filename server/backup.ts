// Sauvegarde LOCALE sur le PC : une archive par jour de tout ce que l'app sait (données d'apprentissage, paris, réglages
// d'apprentissage, base SQLite), dans <serveur>/sauvegardes. 30 jours gardés. Les clés (secrets.json) n'y sont pas.
// Windows 10+ fournit tar.exe, qui écrit des .zip (ouvrables d'un double-clic) ; ailleurs, archive .tar.gz.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRoot, serverRoot } from './paths';
import { log } from './log';

const KEEP_DAYS = 30;
export const backupDir = () => path.join(serverRoot(), 'sauvegardes');

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}`;
};

export function makeLocalBackup(): string | null {
  fs.mkdirSync(backupDir(), { recursive: true });
  const win = process.platform === 'win32';
  const file = path.join(backupDir(), `adlane-${stamp()}.${win ? 'zip' : 'tar.gz'}`);
  try {
    const parent = path.dirname(dataRoot());
    const name = path.basename(dataRoot());
    execFileSync('tar', win ? ['-a', '-c', '-f', file, '-C', parent, name] : ['-czf', file, '-C', parent, name], { stdio: 'ignore', timeout: 10 * 60_000 });
    const mb = (fs.statSync(file).size / 1_048_576).toFixed(1);
    log(`Sauvegarde locale : ${file} (${mb} Mo)`);
  } catch (e: any) {
    log(`Sauvegarde locale échouée : ${e?.message ?? e}`);
    fs.rmSync(file, { force: true });
    return null;
  }
  // Rotation : au-delà de 30 jours, les plus anciennes partent.
  const limit = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of fs.readdirSync(backupDir())) {
    const p = path.join(backupDir(), f);
    if (f.startsWith('adlane-') && fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { force: true });
  }
  return file;
}

/** Vrai s'il n'y a pas encore de sauvegarde locale aujourd'hui. */
export function backupDueToday(): boolean {
  try {
    const today = stamp().slice(0, 10);
    return !fs.readdirSync(backupDir()).some((f) => f.startsWith(`adlane-${today}`));
  } catch {
    return true;
  }
}
