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
  foulsHome?: number;
  foulsAway?: number;
}

/**
 * Marchés suivis dans la courbe d'évolution. Chaque prédiction émise par l'IA
 * est rattachée à l'un d'eux pour qu'on puisse juger sa fiabilité marché par
 * marché, et pas seulement globalement.
 */
export const TRACKED_MARKETS = [
  { key: '1X2', label: 'Victoire (1X2)' },
  { key: 'total_buts', label: 'Total de buts' },
  { key: 'btts', label: 'Les deux marquent' },
  { key: 'buts_1ere_mt', label: 'Buts 1ère mi-temps' },
  { key: 'corners', label: 'Corners' },
  { key: 'cartons', label: 'Cartons' },
  { key: 'fautes', label: 'Fautes' },
] as const;

export type TrackedMarket = (typeof TRACKED_MARKETS)[number]['key'];

export function marketLabel(key: string): string {
  return TRACKED_MARKETS.find((m) => m.key === key)?.label ?? key;
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
  /** true si le match appartient à une ligue sur laquelle l'utilisateur joue. */
  focus?: boolean;
}

/** Ce qui s'est réellement produit pendant une fenêtre d'observation. */
export interface EventDeltas {
  goals: number;
  corners: number;
  cards: number;
  fouls: number;
  /** true si la fenêtre a été coupée (mi-temps atteinte avant son terme). */
  truncated: boolean;
}

/**
 * Horizons d'apprentissage, en minutes de jeu.
 * 10 = signal court (alerte immédiate).
 * 25 = fenêtre de pari visée : décision à la 20e, portant jusqu'à la pause.
 */
export const LEARNING_HORIZONS = [10, 25] as const;
export type LearningHorizon = (typeof LEARNING_HORIZONS)[number];

/**
 * Instantané encore ouvert : on cumule ce qui se passe après lui, fenêtre par
 * fenêtre, jusqu'à ce que chaque horizon soit atteint.
 */
export interface PendingObservation extends MarkerSnapshot {
  baselineCorners: number;
  baselineCards: number;
  baselineFouls: number;
  /** Horizon (en minutes, clé texte) -> ce qui s'est produit pendant celui-ci. */
  frozen: Record<string, EventDeltas>;
}

/** Instantané clôturé : toutes les fenêtres sont figées, prêt pour l'apprentissage. */
export interface TrainingRow extends MarkerSnapshot {
  horizons: Record<string, EventDeltas>;
  closedAt: string;
}

export interface PaperBet {
  id: string;
  placedAt: string;
  fixtureId: number;
  league: string;
  country: string;
  /** Cible apprise, ex: 'goals>=1', 'corners>=2', 'cards>=1'. */
  target: string;
  horizon: number;
  selection: string;
  modelProb: number;
  minuteAtPlacement: number;
  settled: boolean;
  won?: boolean;
  settledAt?: string;
}

/** Une règle apprise : un marqueur franchi -> un événement observé derrière. */
export interface MarkerRule {
  /** Ex: 'shots_on_target_total>=4'. */
  marker: string;
  threshold: number;
  /** Ex: 'goals>=1', 'corners>=2'. */
  target: string;
  horizon: number;
  samples: number;
  hitRate: number;
  baseline: number;
  lift: number;
}

export interface LearnedModel {
  updatedAt: string;
  totalRows: number;
  /** Taux de base par cible et horizon, ex: 'goals>=1@25' -> 0.42. */
  baselines: Record<string, number>;
  markerRules: MarkerRule[];
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

export function readPendingSnapshots(): PendingObservation[] {
  const content = readTextSafe(fileIn('pending.json'));
  if (!content) return [];
  try {
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export function writePendingSnapshots(snapshots: PendingObservation[]): void {
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

// ==================== NOTES D'ENRICHISSEMENT (matchs suivis) ====================

/** Contexte récolté par Gemini/Google et/ou Omniroute sur un match suivi. */
export interface FocusNote {
  fixtureId: number;
  league: string;
  homeTeam: string;
  awayTeam: string;
  collectedAt: string;
  googleContext?: string;
  googleSources?: Array<{ title: string; url: string }>;
  omnirouteContext?: string;
  omnirouteAgent?: string;
}

export function readFocusNotes(): FocusNote[] {
  const content = readTextSafe(fileIn('focus-notes.json'));
  if (!content) return [];
  try {
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export function writeFocusNotes(notes: FocusNote[]): void {
  // On ne garde qu'une fenêtre glissante : ces notes périment vite.
  const cutoff = Date.now() - 12 * 3_600_000;
  const fresh = notes.filter((n) => new Date(n.collectedAt).getTime() > cutoff);
  writeText(fileIn('focus-notes.json'), JSON.stringify(fresh.slice(-100)));
}

// ==================== PROPOSITIONS EN COURS DE MATCH ====================

/** Combo proposé en direct (20e minute, ou mi-temps). */
export interface InPlayProposal {
  id: string;
  kind: 'minute20' | 'halftime';
  createdAt: string;
  fixtureId: number;
  league: string;
  homeTeam: string;
  awayTeam: string;
  minute: number;
  scoreLabel: string;
  /** Fenêtre couverte, en clair ("20e → 45e", "2ème mi-temps + fin de match"). */
  window: string;
  legs: Array<{
    /** Marché suivi auquel cette jambe est rattachée (voir TRACKED_MARKETS). */
    market: TrackedMarket;
    selection: string;
    prob: number;
    evidence: string;
    /** Rempli au bilan de minuit : la jambe est-elle passée ? */
    settled?: boolean;
    won?: boolean;
  }>;
  combinedProb: number;
  /** true une fois la journée close et les jambes réglées. */
  reviewed?: boolean;
}

// ==================== COURBE D'ÉVOLUTION PAR MARCHÉ ====================

/** Un point de courbe : une journée, un marché. */
export interface MarketDayPoint {
  date: string;
  market: TrackedMarket;
  predictions: number;
  correct: number;
  hitRate: number;
  /** Probabilité moyenne annoncée ce jour-là (pour juger la calibration). */
  meanPredicted: number;
}

export function readMarketSeries(): MarketDayPoint[] {
  const content = readTextSafe(fileIn('market-series.json'));
  if (!content) return [];
  try {
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export function writeMarketSeries(points: MarketDayPoint[]): void {
  writeText(fileIn('market-series.json'), JSON.stringify(points.slice(-400)));
}

export function readInPlayProposals(): InPlayProposal[] {
  const content = readTextSafe(fileIn('inplay-proposals.json'));
  if (!content) return [];
  try {
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export function writeInPlayProposals(proposals: InPlayProposal[]): void {
  const cutoff = Date.now() - 48 * 3_600_000;
  const fresh = proposals.filter((p) => new Date(p.createdAt).getTime() > cutoff);
  writeText(fileIn('inplay-proposals.json'), JSON.stringify(fresh.slice(-100)));
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
