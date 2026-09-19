// Stockage du corpus d'auto-apprentissage (boucle silencieuse).
//
// Trois fichiers, dans le dossier documents de l'app :
//   learning/markers-YYYY-MM-DD.jsonl  -> lignes d'entraînement étiquetées
//   learning/pending.json              -> instantanés en attente d'étiquetage
//   learning/model.json                -> poids appris + bilan des paris papier
//   learning/agent-digest.md           -> résumé lisible injecté aux agents IA
//
// Le format JSONL (une ligne = un JSON) permet d'ajouter des observations en
// continu sans relire/réécrire tout le fichier.

import { Directory, EncodingType, File, Paths } from 'expo-file-system';

const LEARNING_DIR_NAME = 'learning';

export interface MarkerSet {
  shotsOnTargetHome?: number;
  shotsOnTargetAway?: number;
  shotsTotalHome?: number;
  shotsTotalAway?: number;
  cornersHome?: number;
  cornersAway?: number;
  dangerousAttacksHome?: number;
  dangerousAttacksAway?: number;
  possessionHome?: number;
  cardsHome?: number;
  cardsAway?: number;
}

/** Instantané d'un match en cours, pris pendant la 1ère mi-temps. */
export interface MarkerSnapshot {
  ts: string;
  fixtureId: number;
  league: string;
  country: string;
  homeTeam: string;
  awayTeam: string;
  minute: number;
  goalsHome: number;
  goalsAway: number;
  markers: MarkerSet;
}

/** Instantané + étiquette : un but est-il tombé dans les minutes qui suivent ? */
export interface TrainingRow extends MarkerSnapshot {
  label_goal_next_10: 0 | 1;
  labelledAt: string;
}

export interface PaperBet {
  id: string;
  placedAt: string;
  fixtureId: number;
  league: string;
  country: string;
  market: string;
  selection: string;
  modelProb: number;
  minuteAtPlacement: number;
  settled: boolean;
  won?: boolean;
  settledAt?: string;
}

export interface LearnedModel {
  updatedAt: string;
  totalRows: number;
  baselineGoalRate: number;
  /** Chaque règle : un seuil observé sur un marqueur, et le taux de but constaté derrière. */
  markerRules: Array<{
    marker: string;
    threshold: number;
    samples: number;
    goalRate: number;
    lift: number; // goalRate / baseline
  }>;
  paperBets: {
    total: number;
    settled: number;
    won: number;
    hitRate: number;
    /** Facteur de recalibrage : <1 si le modèle est trop optimiste. */
    calibrationFactor: number;
  };
  /** Ligues sur lesquelles l'utilisateur joue réellement (priorité d'apprentissage). */
  focusLeagues: string[];
}

function learningDirectory(): Directory {
  const dir = new Directory(Paths.document, 'app-adlane', LEARNING_DIR_NAME);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function fileIn(name: string): File {
  return new File(learningDirectory(), name);
}

function readTextSafe(file: File): string | null {
  try {
    if (!file.exists) return null;
    return file.textSync();
  } catch {
    return null;
  }
}

function writeText(file: File, content: string): void {
  if (!file.exists) file.create({ intermediates: true });
  file.write(content, { encoding: EncodingType.UTF8 });
}

function dayKey(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

// ==================== LIGNES D'ENTRAÎNEMENT ====================

export function appendTrainingRows(rows: TrainingRow[]): void {
  if (rows.length === 0) return;
  const file = fileIn(`markers-${dayKey()}.jsonl`);
  const existing = readTextSafe(file) ?? '';
  const added = rows.map((r) => JSON.stringify(r)).join('\n');
  writeText(file, existing ? `${existing}\n${added}` : added);
}

/** Relit les lignes des N derniers jours (corpus glissant). */
export function readTrainingRows(days: number = 14): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.now() - i * 86_400_000);
    const content = readTextSafe(fileIn(`markers-${dayKey(date)}.jsonl`));
    if (!content) continue;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // ligne corrompue (écriture interrompue) : on l'ignore sans casser la lecture
      }
    }
  }
  return rows;
}

// ==================== INSTANTANÉS EN ATTENTE ====================

export function readPendingSnapshots(): MarkerSnapshot[] {
  const content = readTextSafe(fileIn('pending.json'));
  if (!content) return [];
  try {
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export function writePendingSnapshots(snapshots: MarkerSnapshot[]): void {
  writeText(fileIn('pending.json'), JSON.stringify(snapshots));
}

// ==================== PARIS PAPIER (boucle silencieuse) ====================

export function readPaperBets(): PaperBet[] {
  const content = readTextSafe(fileIn('paper-bets.json'));
  if (!content) return [];
  try {
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export function writePaperBets(bets: PaperBet[]): void {
  // Corpus glissant : on garde les 1000 derniers pour ne pas gonfler le fichier.
  writeText(fileIn('paper-bets.json'), JSON.stringify(bets.slice(-1000)));
}

// ==================== MODÈLE APPRIS + DIGEST AGENTS ====================

export function readLearnedModel(): LearnedModel | null {
  const content = readTextSafe(fileIn('model.json'));
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function writeLearnedModel(model: LearnedModel): void {
  writeText(fileIn('model.json'), JSON.stringify(model, null, 2));
}

export function writeAgentDigest(markdown: string): void {
  writeText(fileIn('agent-digest.md'), markdown);
}

export function readAgentDigest(): string | null {
  return readTextSafe(fileIn('agent-digest.md'));
}

/** Chemin du dossier, pour la synchronisation GitHub et le débogage. */
export function learningDirectoryUri(): string {
  return learningDirectory().uri;
}
