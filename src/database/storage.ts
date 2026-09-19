// Module de stockage local - SQLite + AsyncStorage
// 100% des données stockées sur le téléphone Android

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import { Bet, Lesson, MarketCalibration, OmnirouteConfig, DailyReport } from '../types';
import { HISTORICAL_BETS, HISTORICAL_LESSONS, INITIAL_CALIBRATIONS } from '../data/historical';

const DB_NAME = 'app_adlane.db';

let db: SQLite.SQLiteDatabase | null = null;

export async function initDatabase(): Promise<void> {
  if (db) return;
  try {
    db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS bets (
        id TEXT PRIMARY KEY, version INTEGER, date TEXT, creneau_utc TEXT, creneau_display TEXT,
        league TEXT, legs TEXT, odds REAL, stake REAL, payout REAL, net_pnl REAL,
        excluded_from_pnl INTEGER, status TEXT, played INTEGER, confiance INTEGER,
        confidence_level TEXT, analysis TEXT, resultat_verif TEXT, validation_flags TEXT,
        createdAt TEXT, updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS lessons (
        doc_id TEXT PRIMARY KEY, motif TEXT, occurrences INTEGER, regle_validation TEXT, detail TEXT, derniere_maj TEXT
      );
      CREATE TABLE IF NOT EXISTS calibrations (
        market TEXT PRIMARY KEY, league TEXT, total_predictions INTEGER, predictions_won INTEGER,
        actual_success_rate REAL, avg_predicted_prob REAL, calibration_status TEXT, last_updated TEXT
      );
      CREATE TABLE IF NOT EXISTS daily_reports (
        date TEXT PRIMARY KEY, bets_settled INTEGER, bets_won INTEGER, bets_lost INTEGER,
        total_stake REAL, total_return REAL, net_pnl REAL, roi REAL, lessons_learned TEXT, details TEXT
      );
    `);
    console.log('✅ Base de données locale initialisée');
  } catch (error) {
    console.error('DB Init Error:', error);
  }
}

export async function seedDatabaseIfEmpty(): Promise<void> {
  if (!db) await initDatabase();
  const bets = await getAllBets();
  if (bets.length > 0) return;

  await db!.withExclusiveTransactionAsync(async (txn) => {
    for (const bet of HISTORICAL_BETS) {
      await txn.runAsync(`INSERT OR REPLACE INTO bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        bet.id, bet.version, bet.date, bet.creneau_utc, bet.creneau_display, bet.league, JSON.stringify(bet.legs),
        bet.odds, bet.stake, bet.payout ?? null, bet.net_pnl ?? null, bet.excluded_from_pnl ? 1 : 0, bet.status, bet.played ? 1 : 0,
        bet.confiance, bet.confidence_level, bet.analysis, bet.resultat_verif ?? null, JSON.stringify(bet.validation_flags),
        bet.createdAt, bet.updatedAt
      ]);
    }
  });
}

// ==================== BETS ====================

export async function saveBet(bet: Bet): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(`INSERT OR REPLACE INTO bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    bet.id, bet.version, bet.date, bet.creneau_utc, bet.creneau_display, bet.league, JSON.stringify(bet.legs),
    bet.odds, bet.stake, bet.payout ?? null, bet.net_pnl ?? null, bet.excluded_from_pnl ? 1 : 0, bet.status, bet.played ? 1 : 0,
    bet.confiance, bet.confidence_level, bet.analysis, bet.resultat_verif ?? null, JSON.stringify(bet.validation_flags),
    bet.createdAt, bet.updatedAt
  ]);
}

export async function getAllBets(): Promise<Bet[]> {
  if (!db) await initDatabase();
  const rows = await db!.getAllAsync('SELECT * FROM bets ORDER BY createdAt DESC');
  return rows.map((r: any) => ({
    ...r,
    legs: JSON.parse(r.legs),
    excluded_from_pnl: r.excluded_from_pnl === 1,
    played: r.played === 1,
    validation_flags: JSON.parse(r.validation_flags)
  }));
}

export async function getBetById(id: string): Promise<Bet | null> {
  if (!db) await initDatabase();
  const row = await db!.getFirstAsync('SELECT * FROM bets WHERE id = ?', [id]);
  if (!row) return null;
  const r = row as any;
  return {
    ...r,
    legs: JSON.parse(r.legs),
    excluded_from_pnl: r.excluded_from_pnl === 1,
    played: r.played === 1,
    validation_flags: JSON.parse(r.validation_flags)
  };
}

// ==================== LESSONS ====================

export async function saveLesson(lesson: Lesson): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(`INSERT OR REPLACE INTO lessons VALUES (?,?,?,?,?,?)`, [
    lesson.doc_id, lesson.motif, lesson.occurrences, lesson.regle_validation, lesson.detail, lesson.derniere_maj
  ]);
}

export async function getAllLessons(): Promise<Lesson[]> {
  if (!db) await initDatabase();
  return await db!.getAllAsync('SELECT * FROM lessons ORDER BY occurrences DESC');
}

// ==================== CALIBRATIONS ====================

export async function saveCalibration(cal: MarketCalibration): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(`INSERT OR REPLACE INTO calibrations VALUES (?,?,?,?,?,?,?,?)`, [
    cal.market, cal.league ?? null, cal.total_predictions, cal.predictions_won,
    cal.actual_success_rate, cal.avg_predicted_prob, cal.calibration_status, cal.last_updated
  ]);
}

export async function getAllCalibrations(): Promise<MarketCalibration[]> {
  if (!db) await initDatabase();
  return await db!.getAllAsync('SELECT * FROM calibrations');
}

// ==================== DAILY REPORTS ====================

export async function saveDailyReport(report: DailyReport): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(`INSERT OR REPLACE INTO daily_reports VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    report.date, report.bets_settled, report.bets_won, report.bets_lost,
    report.total_stake, report.total_return, report.net_pnl, report.roi,
    JSON.stringify(report.lessons_learned), report.details
  ]);
}

export async function getDailyReports(limit: number = 30): Promise<DailyReport[]> {
  if (!db) await initDatabase();
  const rows = await db!.getAllAsync('SELECT * FROM daily_reports ORDER BY date DESC LIMIT ?', [limit]);
  return rows.map((r: any) => ({ ...r, lessons_learned: JSON.parse(r.lessons_learned) }));
}

// ==================== RESTORE ====================

export async function restoreSnapshot(data: any): Promise<void> {
  if (!db) await initDatabase();
  await db!.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM bets');
    await txn.runAsync('DELETE FROM lessons');
    await txn.runAsync('DELETE FROM calibrations');
    await txn.runAsync('DELETE FROM daily_reports');

    for (const b of data.bets || []) {
      await txn.runAsync(`INSERT INTO bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        b.id, b.version, b.date, b.creneau_utc, b.creneau_display, b.league, JSON.stringify(b.legs),
        b.odds, b.stake, b.payout ?? null, b.net_pnl ?? null, b.excluded_from_pnl ? 1 : 0, b.status, b.played ? 1 : 0,
        b.confiance, b.confidence_level, b.analysis, b.resultat_verif ?? null, JSON.stringify(b.validation_flags),
        b.createdAt, b.updatedAt
      ]);
    }
    for (const l of data.lessons || []) {
      await txn.runAsync(`INSERT INTO lessons VALUES (?,?,?,?,?,?)`, [
        l.doc_id, l.motif, l.occurrences, l.regle_validation, l.detail, l.derniere_maj
      ]);
    }
    for (const c of data.calibrations || []) {
      await txn.runAsync(`INSERT INTO calibrations VALUES (?,?,?,?,?,?,?,?)`, [
        c.market, c.league ?? null, c.total_predictions, c.predictions_won,
        c.actual_success_rate, c.avg_predicted_prob, c.calibration_status, c.last_updated
      ]);
    }
    for (const r of data.dailyReports || []) {
      await txn.runAsync(`INSERT INTO daily_reports VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        r.date, r.bets_settled, r.bets_won, r.bets_lost, r.total_stake, r.total_return,
        r.net_pnl, r.roi, JSON.stringify(r.lessons_learned), r.details
      ]);
    }
  });
}

// CONFIG OMNIROUTE
const CONFIG_KEY = '@omniroute_config';
export async function saveOmnirouteConfig(config: OmnirouteConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
export async function getOmnirouteConfig(): Promise<OmnirouteConfig | null> {
  const json = await AsyncStorage.getItem(CONFIG_KEY);
  return json ? JSON.parse(json) : null;
}
