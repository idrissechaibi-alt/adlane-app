// Remplace expo-secure-store : clés et jetons dans <serveur>/secrets.json (jamais dans le dépôt).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { serverRoot } from '../paths';

const file = () => path.join(serverRoot(), 'secrets.json');

function readAll(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export async function getItemAsync(key: string): Promise<string | null> {
  return readAll()[key] ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  writeAll({ ...readAll(), [key]: value });
}

export async function deleteItemAsync(key: string): Promise<void> {
  const all = readAll();
  delete all[key];
  writeAll(all);
}
