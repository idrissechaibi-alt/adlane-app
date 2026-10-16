// Stockage clé → valeur de l'app, dans des FICHIERS (un fichier par clé) au lieu d'AsyncStorage.
//
// Pourquoi : sur Android, AsyncStorage est une base SQLite plafonnée à 6 Mo. L'app y gardait ses chronologies de matchs,
// stats live, motifs, cotes saisies… : une fois le plafond atteint, chaque écriture qui grossit une clé échoue au hasard
// (« database or disk is full (code 13 SQLITE_FULL) ») — saisie d'une cote refusée, apprentissage perdu sans bruit.
// Les fichiers n'ont pas ce plafond (seul l'espace libre du téléphone compte).
//
// Même interface qu'AsyncStorage (getItem, setItem, removeItem, getAllKeys, multiGet, multiRemove) : remplacement direct.
// Migration automatique : une clé encore dans AsyncStorage est déplacée vers son fichier à la première lecture, et
// migrateAsyncStorage() déplace tout au démarrage, ce qui libère la base SQLite.

import RNAsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, EncodingType, File, Paths } from 'expo-file-system';

let dirMemo: Directory | null = null;
function kvDir(): Directory {
  if (dirMemo) return dirMemo;
  const dir = new Directory(Paths.document, 'app-adlane', 'kv');
  dir.create({ intermediates: true, idempotent: true });
  dirMemo = dir;
  return dir;
}

// Nom de fichier réversible : « % » → « _ » après avoir encodé les « _ » d'origine (%5F).
const toName = (key: string) => encodeURIComponent(key).replace(/_/g, '%5F').replace(/%/g, '_');
const fromName = (name: string) => decodeURIComponent(name.replace(/_/g, '%'));
const fileFor = (key: string) => new File(kvDir(), toName(key));

function readFile(key: string): string | null {
  try {
    const f = fileFor(key);
    return f.exists ? f.textSync() : null;
  } catch {
    return null;
  }
}

function writeFile(key: string, value: string): void {
  const f = fileFor(key);
  if (!f.exists) f.create({ intermediates: true });
  f.write(value, { encoding: EncodingType.UTF8 });
}

async function getItem(key: string): Promise<string | null> {
  const local = readFile(key);
  if (local != null || migrated) return local;
  // Clé pas encore migrée : lue dans AsyncStorage puis déplacée.
  try {
    const legacy = await RNAsyncStorage.getItem(key);
    if (legacy != null) {
      writeFile(key, legacy);
      await RNAsyncStorage.removeItem(key).catch(() => {});
    }
    return legacy;
  } catch {
    return null;
  }
}

async function setItem(key: string, value: string): Promise<void> {
  writeFile(key, value);
  // Une ancienne copie dans AsyncStorage masquerait rien (le fichier gagne) mais occuperait la base : retirée.
  if (!migrated) await RNAsyncStorage.removeItem(key).catch(() => {});
}

async function removeItem(key: string): Promise<void> {
  try {
    const f = fileFor(key);
    if (f.exists) f.delete();
  } catch {
    // déjà absent
  }
  if (!migrated) await RNAsyncStorage.removeItem(key).catch(() => {});
}

async function getAllKeys(): Promise<string[]> {
  const keys = new Set<string>();
  try {
    for (const entry of kvDir().list()) if (entry instanceof File) keys.add(fromName(entry.name));
  } catch {
    // dossier illisible : seulement les clés restantes d'AsyncStorage
  }
  if (!migrated) {
    try {
      for (const k of await RNAsyncStorage.getAllKeys()) keys.add(k);
    } catch {
      // base indisponible
    }
  }
  return Array.from(keys);
}

async function multiGet(keys: readonly string[]): Promise<Array<[string, string | null]>> {
  const out: Array<[string, string | null]> = [];
  for (const k of keys) out.push([k, await getItem(k)]);
  return out;
}

async function multiRemove(keys: readonly string[]): Promise<void> {
  for (const k of keys) await removeItem(k);
}

let migrated = false;
let migrating: Promise<number> | null = null;

/** Déplace toutes les clés restantes d'AsyncStorage vers des fichiers (au démarrage, une fois). Renvoie le nombre déplacé. */
export function migrateAsyncStorage(): Promise<number> {
  if (migrating) return migrating;
  migrating = (async () => {
    let moved = 0;
    let keys: readonly string[] = [];
    try {
      keys = await RNAsyncStorage.getAllKeys();
    } catch {
      return 0;
    }
    for (const k of keys) {
      try {
        const v = await RNAsyncStorage.getItem(k);
        // Une valeur déjà écrite en fichier depuis est plus récente : on ne l'écrase pas.
        if (v != null && readFile(k) == null) writeFile(k, v);
        await RNAsyncStorage.removeItem(k);
        moved++;
      } catch {
        // Valeur illisible (trop grosse pour le curseur SQLite) : déjà perdue pour l'app, on libère la place qu'elle occupe.
        await RNAsyncStorage.removeItem(k).catch(() => {});
      }
    }
    try {
      if ((await RNAsyncStorage.getAllKeys()).length === 0) migrated = true;
    } catch {
      // état inconnu : on continue de consulter AsyncStorage en repli
    }
    return moved;
  })();
  return migrating;
}

const kvStore = { getItem, setItem, removeItem, getAllKeys, multiGet, multiRemove };
export default kvStore;
