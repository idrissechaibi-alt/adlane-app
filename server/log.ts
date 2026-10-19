// Journal du serveur : console + <serveur>/logs/serveur-AAAA-MM-JJ.log (14 jours gardés).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { serverRoot } from './paths';

const dir = () => path.join(serverRoot(), 'logs');

export function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(path.join(dir(), `serveur-${line.slice(0, 10)}.log`), line + '\n');
  } catch {
    // disque plein ou dossier inaccessible : la console suffit
  }
}

export function pruneLogs(): void {
  try {
    const limit = Date.now() - 14 * 86_400_000;
    for (const f of fs.readdirSync(dir())) {
      const p = path.join(dir(), f);
      if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { force: true });
    }
  } catch {
    // rien à nettoyer
  }
}
