// Remplace expo-file-system sur le serveur (Node) : mêmes classes File / Directory / Paths, posées sur le disque du PC.
// Seule la partie de l'API utilisée par src/core est reproduite.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRoot } from '../paths';

export const EncodingType = { UTF8: 'utf8', Base64: 'base64' } as const;

type PathPart = string | Directory | File;

function toPath(part: PathPart): string {
  if (typeof part !== 'string') return part.path;
  return part.startsWith('file://') ? decodeURIComponent(part.slice('file://'.length)) : part;
}

function join(parts: PathPart[]): string {
  const [first, ...rest] = parts;
  return path.join(toPath(first), ...rest.map((p) => toPath(p)));
}

export class Directory {
  readonly path: string;
  constructor(...parts: PathPart[]) {
    this.path = join(parts);
  }
  get uri(): string {
    return `file://${this.path}`;
  }
  get name(): string {
    return path.basename(this.path);
  }
  get exists(): boolean {
    try {
      return fs.statSync(this.path).isDirectory();
    } catch {
      return false;
    }
  }
  create(_opts?: { intermediates?: boolean; idempotent?: boolean }): void {
    fs.mkdirSync(this.path, { recursive: true });
  }
  delete(): void {
    fs.rmSync(this.path, { recursive: true, force: true });
  }
  list(): Array<File | Directory> {
    return fs.readdirSync(this.path, { withFileTypes: true }).map((e) => (e.isDirectory() ? new Directory(this.path, e.name) : new File(this.path, e.name)));
  }
}

export class File {
  readonly path: string;
  constructor(...parts: PathPart[]) {
    this.path = join(parts);
  }
  get uri(): string {
    return `file://${this.path}`;
  }
  get name(): string {
    return path.basename(this.path);
  }
  get exists(): boolean {
    try {
      return fs.statSync(this.path).isFile();
    } catch {
      return false;
    }
  }
  get size(): number {
    try {
      return fs.statSync(this.path).size;
    } catch {
      return 0;
    }
  }
  get modificationTime(): number | null {
    try {
      return fs.statSync(this.path).mtimeMs;
    } catch {
      return null;
    }
  }
  create(_opts?: { intermediates?: boolean; overwrite?: boolean }): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) fs.writeFileSync(this.path, '');
  }
  write(content: string | Uint8Array, opts?: { encoding?: string }): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    // Écriture atomique (fichier temporaire puis renommage) : un arrêt brutal du PC ne laisse jamais un fichier à moitié écrit.
    const tmp = `${this.path}.tmp-${process.pid}`;
    if (typeof content === 'string') fs.writeFileSync(tmp, content, opts?.encoding === 'base64' ? 'base64' : 'utf8');
    else fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, this.path);
  }
  textSync(): string {
    return fs.readFileSync(this.path, 'utf8');
  }
  async text(): Promise<string> {
    return fs.promises.readFile(this.path, 'utf8');
  }
  async base64(): Promise<string> {
    return (await fs.promises.readFile(this.path)).toString('base64');
  }
  delete(): void {
    fs.rmSync(this.path, { force: true });
  }
}

export const Paths = {
  get document(): Directory {
    return new Directory(dataRoot());
  },
  get cache(): Directory {
    return new Directory(dataRoot(), 'cache');
  },
};
