// Remplace expo-sqlite par le SQLite intégré à Node (node:sqlite) : même interface asynchrone que celle utilisée par
// src/database/storage.ts (execAsync, runAsync, getAllAsync, getFirstAsync, withExclusiveTransactionAsync).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRoot } from '../paths';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');

type Params = unknown[] | Record<string, unknown> | undefined;

const norm = (args: unknown[]): unknown[] => {
  if (args.length === 1 && Array.isArray(args[0])) return (args[0] as unknown[]).map(fix);
  return args.map(fix);
};
// node:sqlite refuse undefined et les booléens : convertis comme le fait expo-sqlite.
const fix = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export class SQLiteDatabase {
  private db: any;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
  }
  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  async runAsync(sql: string, ...args: unknown[]): Promise<{ lastInsertRowId: number; changes: number }> {
    const r = this.db.prepare(sql).run(...norm(args));
    return { lastInsertRowId: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) };
  }
  async getAllAsync<T = any>(sql: string, ...args: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...norm(args)) as T[];
  }
  async getFirstAsync<T = any>(sql: string, ...args: unknown[]): Promise<T | null> {
    return (this.db.prepare(sql).get(...norm(args)) as T) ?? null;
  }
  async withExclusiveTransactionAsync(fn: (txn: SQLiteDatabase) => Promise<void>): Promise<void> {
    this.db.exec('BEGIN EXCLUSIVE');
    try {
      await fn(this);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
    return this.withExclusiveTransactionAsync(async () => fn());
  }
  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

export async function openDatabaseAsync(name: string): Promise<SQLiteDatabase> {
  return new SQLiteDatabase(path.join(dataRoot(), 'SQLite', name));
}

export type { Params };
