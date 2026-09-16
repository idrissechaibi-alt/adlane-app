// Module de stockage local - SQLite + AsyncStorage
// 100% des données stockées sur le téléphone Android

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import { Bet, Lesson, MarketCalibration, OmnirouteConfig, DailyReport } from '../types';
import { HISTORICAL_BETS, HISTORICAL_LESSONS, INITIAL_CALIBRATIONS } from '../data/historical';

const DB_NAME = 'app_adlane.db';

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Initialise la base de données locale
 */
export async function initDatabase(): Promise<void> {
  if (db) return;

  try {
    db = await SQLite.openDatabaseAsync(DB_NAME);

    // Table des paris
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS bets (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        date TEXT NOT NULL,
        creneau_utc TEXT NOT NULL,
        creneau_display TEXT NOT NULL,
        league TEXT NOT NULL,
        legs TEXT NOT NULL,
        odds REAL,
        stake REAL,
        payout REAL,
        net_pnl REAL,
        excluded_from_pnl INTEGER NOT NULL,
        status TEXT NOT NULL,
        played INTEGER NOT NULL,
        confiance INTEGER,
        confidence_level TEXT NOT NULL,
        analysis TEXT NOT NULL,
        resultat_verif TEXT,
        validation_flags TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);

    // Table des leçons
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS lessons (
        doc_id TEXT PRIMARY KEY,
        motif TEXT NOT NULL,
        occurrences INTEGER NOT NULL,
        regle_validation TEXT NOT NULL,
        detail TEXT NOT NULL,
        derniere_maj TEXT NOT NULL
      );
    `);

    // Table des calibrations
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS calibrations (
        market TEXT PRIMARY KEY,
        league TEXT,
        total_predictions INTEGER NOT NULL,
        predictions_won INTEGER NOT NULL,
        actual_success_rate REAL NOT NULL,
        avg_predicted_prob REAL NOT NULL,
        calibration_status TEXT NOT NULL,
        last_updated TEXT NOT NULL
      );
    `);

    // Table des rapports quotidiens
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS daily_reports (
        date TEXT PRIMARY KEY,
        bets_settled INTEGER NOT NULL,
        bets_won INTEGER NOT NULL,
        bets_lost INTEGER NOT NULL,
        total_stake REAL NOT NULL,
        total_return REAL NOT NULL,
        net_pnl REAL NOT NULL,
        roi REAL NOT NULL,
        lessons_learned TEXT NOT NULL,
        details TEXT NOT NULL
      );
    `);

    console.log('✅ Base de données locale initialisée');
  } catch (error) {
    console.error('Erreur initialisation base de données:', error);
    throw error;
  }
}

/**
 * Remplit la base de données avec les données historiques si elle est vide.
 */
export async function seedDatabaseIfEmpty(): Promise<void> {
  if (!db) await initDatabase();

  const bets = await getAllBets();
  if (bets.length > 0) {
    console.log('ℹ️ Base de données déjà alimentée');
    return;
  }

  console.log('🌱 Alimentation de la base de données...');

  await db!.withExclusiveTransactionAsync(async (txn) => {
    // Import des paris
    for (const bet of HISTORICAL_BETS) {
      await txn.runAsync(
        `INSERT INTO bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          bet.id, bet.version, bet.date, bet.creneau_utc, bet.creneau_display,
          bet.league, JSON.stringify(bet.legs), bet.odds ?? null, bet.stake ?? null,
          bet.payout ?? null, bet.net_pnl ?? null, bet.excluded_from_pnl ? 1 : 0,
          bet.status, bet.played ? 1 : 0, bet.confiance ?? null, bet.confidence_level,
          bet.analysis, bet.resultat_verif ?? null, JSON.stringify(bet.validation_flags),
          bet.createdAt, bet.updatedAt
        ]
      );
    }

    // Import des leçons
    for (const lesson of HISTORICAL_LESSONS) {
      await txn.runAsync(
        `INSERT INTO lessons VALUES (?,?,?,?,?,?)`,
        [lesson.doc_id, lesson.motif, lesson.occurrences, lesson.regle_validation, lesson.detail, lesson.derniere_maj]
      );
    }

    // Import des calibrations
    for (const cal of INITIAL_CALIBRATIONS) {
      await txn.runAsync(
        `INSERT INTO calibrations VALUES (?,?,?,?,?,?,?,?)`,
        [cal.market, cal.league ?? null, cal.total_predictions, cal.predictions_won,
         cal.actual_success_rate, cal.avg_predicted_prob, cal.calibration_status, cal.last_updated]
      );
    }
  });

  console.log('✅ Importation des données historiques terminée');
}

// ==================== BETS ====================

export async function saveBet(bet: Bet): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(
    `INSERT OR REPLACE INTO bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      bet.id, bet.version, bet.date, bet.creneau_utc, bet.creneau_display,
      bet.league, JSON.stringify(bet.legs), bet.odds ?? null, bet.stake ?? null,
      bet.payout ?? null, bet.net_pnl ?? null, bet.excluded_from_pnl ? 1 : 0,
      bet.status, bet.played ? 1 : 0, bet.confiance ?? null, bet.confidence_level,
      bet.analysis, bet.resultat_verif ?? null, JSON.stringify(bet.validation_flags),
      bet.createdAt, bet.updatedAt
    ]
  );
}

export async function getAllBets(): Promise<Bet[]> {
  if (!db) await initDatabase();
  const rows = await db!.getAllAsync('SELECT * FROM bets ORDER BY createdAt DESC');
  return rows.map((row: any) => ({
    id: row.id,
    version: row.version,
    date: row.date,
    creneau_utc: row.creneau_utc,
    creneau_display: row.creneau_display,
    league: row.league,
    legs: JSON.parse(row.legs),
    odds: row.odds,
    stake: row.stake,
    payout: row.payout,
    net_pnl: row.net_pnl,
    excluded_from_pnl: row.excluded_from_pnl === 1,
    status: row.status,
    played: row.played === 1,
    confiance: row.confiance,
    confidence_level: row.confidence_level,
    analysis: row.analysis,
    resultat_verif: row.resultat_verif,
    validation_flags: JSON.parse(row.validation_flags),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
}

export async function getBetById(id: string): Promise<Bet | null> {
  if (!db) await initDatabase();
  const row = await db!.getFirstAsync('SELECT * FROM bets WHERE id = ?', [id]);
  if (!row) return null;

  return {
    id: (row as any).id,
    version: (row as any).version,
    date: (row as any).date,
    creneau_utc: (row as any).creneau_utc,
    creneau_display: (row as any).creneau_display,
    league: (row as any).league,
    legs: JSON.parse((row as any).legs),
    odds: (row as any).odds,
    stake: (row as any).stake,
    payout: (row as any).payout,
    net_pnl: (row as any).net_pnl,
    excluded_from_pnl: (row as any).excluded_from_pnl === 1,
    status: (row as any).status,
    played: (row as any).played === 1,
    confiance: (row as any).confiance,
    confidence_level: (row as any).confidence_level,
    analysis: (row as any).analysis,
    resultat_verif: (row as any).resultat_verif,
    validation_flags: JSON.parse((row as any).validation_flags),
    createdAt: (row as any).createdAt,
    updatedAt: (row as any).updatedAt
  };
}

// ==================== LESSONS ====================

export async function saveLesson(lesson: Lesson): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(
    `INSERT OR REPLACE INTO lessons VALUES (?,?,?,?,?,?)`,
    [lesson.doc_id, lesson.motif, lesson.occurrences, lesson.regle_validation, lesson.detail, lesson.derniere_maj]
  );
}

export async function getAllLessons(): Promise<Lesson[]> {
  if (!db) await initDatabase();
  const rows = await db!.getAllAsync('SELECT * FROM lessons ORDER BY occurrences DESC');
  return rows.map((row: any) => ({
    doc_id: row.doc_id,
    motif: row.motif,
    occurrences: row.occurrences,
    regle_validation: row.regle_validation,
    detail: row.detail,
    derniere_maj: row.derniere_maj
  }));
}

// ==================== CALIBRATIONS ====================

export async function saveCalibration(cal: MarketCalibration): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(
    `INSERT OR REPLACE INTO calibrations VALUES (?,?,?,?,?,?,?,?)`,
    [cal.market, cal.league ?? null, cal.total_predictions, cal.predictions_won,
     cal.actual_success_rate, cal.avg_predicted_prob, cal.calibration_status, cal.last_updated]
  );
}

export async function getAllCalibrations(): Promise<MarketCalibration[]> {
  if (!db) await initDatabase();
  const rows = await db!.getAllAsync('SELECT * FROM calibrations');
  return rows.map((row: any) => ({
    market: row.market,
    league: row.league,
    total_predictions: row.total_predictions,
    predictions_won: row.predictions_won,
    actual_success_rate: row.actual_success_rate,
    avg_predicted_prob: row.avg_predicted_prob,
    calibration_status: row.calibration_status,
    last_updated: row.last_updated
  }));
}

// ==================== DAILY REPORTS ====================

export async function saveDailyReport(report: DailyReport): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(
    `INSERT OR REPLACE INTO daily_reports VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [report.date, report.bets_settled, report.bets_won, report.bets_lost,
     report.total_stake, report.total_return, report.net_pnl, report.roi,
     JSON.stringify(report.lessons_learned), report.details]
  );
}

export async function getDailyReports(limit: number = 30): Promise<DailyReport[]> {
  if (!db) await initDatabase();
  const rows = await db!.getAllAsync('SELECT * FROM daily_reports ORDER BY date DESC LIMIT ?', [limit]);
  return rows.map((row: any) => ({
    date: row.date,
    bets_settled: row.bets_settled,
    bets_won: row.bets_won,
    bets_lost: row.bets_lost,
    total_stake: row.total_stake,
    total_return: row.total_return,
    net_pnl: row.net_pnl,
    roi: row.roi,
    lessons_learned: JSON.parse(row.lessons_learned),
    details: row.details
  }));
}

// ==================== CONFIG OMNIROUTE (AsyncStorage) ====================

const CONFIG_KEY = '@omniroute_config';

export async function saveOmnirouteConfig(config: OmnirouteConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export async function getOmnirouteConfig(): Promise<OmnirouteConfig | null> {
  const json = await AsyncStorage.getItem(CONFIG_KEY);
  return json ? JSON.parse(json) : null;
}

// ==================== RESTORE SNAPSHOT ====================

export async function restoreSnapshot(data: {
  bets: Bet[];
  lessons: Lesson[];
  calibrations: MarketCalibration[];
  dailyReports: DailyReport[];
}): Promise<void> {
  if (!db) await initDatabase();

  await db!.withExclusiveTransactionAsync(async (txn) => {
    // Nettoyage complet
    await txn.runAsync('DELETE FROM bets');
    await txn.runAsync('DELETE FROM lessons');
    await txn.runAsync('DELETE FROM calibrations');
    await txn.runAsync('DELETE FROM daily_reports');

    // Restauration des paris
    for (const bet of data.bets) {
      await txn.runAsync(
        `INSERT INTO bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          bet.id, bet.version, bet.date, bet.creneau_utc, bet.creneau_display,
          bet.league, JSON.stringify(bet.legs), bet.odds ?? null, bet.stake ?? null,
          bet.payout ?? null, bet.net_pnl ?? null, bet.excluded_from_pnl ? 1 : 0,
          bet.status, bet.played ? 1 : 0, bet.confiance ?? null, bet.confidence_level,
          bet.analysis, bet.resultat_verif ?? null, JSON.stringify(bet.validation_flags),
          bet.createdAt, bet.updatedAt
        ]
      );
    }

    // Restauration des leçons
    for (const lesson of data.lessons) {
      await txn.runAsync(
        `INSERT INTO lessons VALUES (?,?,?,?,?,?)`,
        [lesson.doc_id, lesson.motif, lesson.occurrences, lesson.regle_validation, lesson.detail, lesson.derniere_maj]
      );
    }

    // Restauration des calibrations
    for (const cal of data.calibrations) {
      await txn.runAsync(
        `INSERT INTO calibrations VALUES (?,?,?,?,?,?,?,?)`,
        [cal.market, cal.league ?? null, cal.total_predictions, cal.predictions_won,
         cal.actual_success_rate, cal.avg_predicted_prob, cal.calibration_status, cal.last_updated]
      );
    }

    // Restauration des rapports
    for (const report of data.dailyReports) {
      await txn.runAsync(
        `INSERT INTO daily_reports VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [report.date, report.bets_settled, report.bets_won, report.bets_lost,
         report.total_stake, report.total_return, report.net_pnl, report.roi,
         JSON.stringify(report.lessons_learned), report.details]
      );
    }
  });

  console.log('✅ Base de données restaurée avec succès');
}
