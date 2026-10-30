// BANQUES DE DONNÉES (serveur PC, collecte seulement) : relit chaque jour les statistiques ouvertes de football-data.co.uk
// (cinq grands championnats, saison en cours et précédente) et publie les moyennes par club dans data/server/banks/club-stats.json.
// Le téléphone les lit (src/core/coaches/knowledgeFeed.ts) et les substitue aux chiffres embarqués dans l'app : les entraîneurs
// travaillent ainsi toujours sur des moyennes à jour, sans nouvelle version de l'app. Aucune analyse ici.
import * as crypto from 'node:crypto';
import { repoPut, repoText } from './github';
import { log } from './log';
import type { TeamWindow } from '../src/core/coaches/leagueStats';

export const BANKS_DIR = 'data/server/banks';
const LEAGUES: Array<{ code: string; name: string }> = [
  { code: 'E0', name: 'Premier League' },
  { code: 'SP1', name: 'La Liga' },
  { code: 'D1', name: 'Bundesliga' },
  { code: 'I1', name: 'Serie A' },
  { code: 'F1', name: 'Ligue 1' },
];

const seasonCodes = (now = new Date()): { current: string; previous: string; labels: Record<string, string> } => {
  const y = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const code = (s: number) => `${String(s % 100).padStart(2, '0')}${String((s + 1) % 100).padStart(2, '0')}`;
  return { current: code(y), previous: code(y - 1), labels: { [code(y)]: `${y}-${String(y + 1).slice(2)}`, [code(y - 1)]: `${y - 1}-${String(y).slice(2)}` } };
};

async function csv(season: string, code: string): Promise<Array<Record<string, string>>> {
  const res = await fetch(`https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`, { headers: { 'User-Agent': 'adlane-collector/1.0 (usage personnel)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${season}/${code}`);
  const lines = (await res.text()).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
  });
}

const num = (x: string | undefined): number | null => {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const avg = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
};

interface Row { gf: number; ga: number; corF: number | null; corA: number | null; fouF: number | null; fouA: number | null; yF: number | null; yA: number | null; rF: number | null; sF: number | null; sA: number | null; stF: number | null; stA: number | null }

function window(rows: Row[], btts: number[], over: number[], win: number[]): TeamWindow | undefined {
  if (!rows.length) return undefined;
  return {
    n: rows.length,
    gf: avg(rows.map((r) => r.gf)), ga: avg(rows.map((r) => r.ga)),
    cornersFor: avg(rows.map((r) => r.corF)), cornersAgainst: avg(rows.map((r) => r.corA)),
    foulsFor: avg(rows.map((r) => r.fouF)), foulsAgainst: avg(rows.map((r) => r.fouA)),
    yellowFor: avg(rows.map((r) => r.yF)), yellowAgainst: avg(rows.map((r) => r.yA)), redFor: avg(rows.map((r) => r.rF)),
    shotsFor: avg(rows.map((r) => r.sF)), shotsAgainst: avg(rows.map((r) => r.sA)),
    sotFor: avg(rows.map((r) => r.stF)), sotAgainst: avg(rows.map((r) => r.stA)),
    btts: avg(btts), over25: avg(over), win: avg(win),
  };
}

/** Moyennes par club : « courant » (saison en cours) et « deuxSaisons » (en cours + précédente). Clés = noms de football-data.co.uk. */
export async function computeClubStats(): Promise<Record<string, { league: string; courant?: TeamWindow; deuxSaisons?: TeamWindow }>> {
  const { current, previous } = seasonCodes();
  const out: Record<string, { league: string; courant?: TeamWindow; deuxSaisons?: TeamWindow }> = {};
  for (const lg of LEAGUES) {
    const perTeam = new Map<string, { cur: Row[]; all: Row[]; curB: number[]; allB: number[]; curO: number[]; allO: number[]; curW: number[]; allW: number[] }>();
    for (const season of [previous, current]) {
      let rows: Array<Record<string, string>> = [];
      try {
        rows = await csv(season, lg.code);
      } catch (e: any) {
        log(`Banques : ${lg.name} ${season} illisible (${e?.message ?? e}).`);
        continue;
      }
      for (const r of rows) {
        const hg = num(r.FTHG), ag = num(r.FTAG);
        if (hg == null || ag == null || !r.HomeTeam || !r.AwayTeam) continue;
        for (const side of ['H', 'A'] as const) {
          const opp = side === 'H' ? 'A' : 'H';
          const team = side === 'H' ? r.HomeTeam : r.AwayTeam;
          const gf = side === 'H' ? hg : ag, ga = side === 'H' ? ag : hg;
          const row: Row = { gf, ga, corF: num(r[`${side}C`]), corA: num(r[`${opp}C`]), fouF: num(r[`${side}F`]), fouA: num(r[`${opp}F`]), yF: num(r[`${side}Y`]), yA: num(r[`${opp}Y`]), rF: num(r[`${side}R`]), sF: num(r[`${side}S`]), sA: num(r[`${opp}S`]), stF: num(r[`${side}ST`]), stA: num(r[`${opp}ST`]) };
          const t = perTeam.get(team) ?? { cur: [], all: [], curB: [], allB: [], curO: [], allO: [], curW: [], allW: [] };
          const b = gf > 0 && ga > 0 ? 1 : 0, o = gf + ga > 2.5 ? 1 : 0, w = gf > ga ? 1 : 0;
          t.all.push(row); t.allB.push(b); t.allO.push(o); t.allW.push(w);
          if (season === current) { t.cur.push(row); t.curB.push(b); t.curO.push(o); t.curW.push(w); }
          perTeam.set(team, t);
        }
      }
    }
    for (const [team, t] of perTeam) out[team] = { league: lg.name, courant: window(t.cur, t.curB, t.curO, t.curW), deuxSaisons: window(t.all, t.allB, t.allO, t.allW) };
  }
  return out;
}

let lastHash = '';
let lastRun = 0;

/** Recalcule et publie les moyennes par club (une fois par jour, ou à la demande), seulement si elles ont changé. */
export async function refreshBanks(force = false): Promise<boolean> {
  if (!force && Date.now() - lastRun < 6 * 3_600_000) return false;
  lastRun = Date.now();
  const clubs = await computeClubStats();
  if (Object.keys(clubs).length < 60) {
    log(`Banques : seulement ${Object.keys(clubs).length} clubs lus, rien publié.`);
    return false;
  }
  const body = JSON.stringify({ updatedAt: new Date().toISOString(), source: 'football-data.co.uk', clubs });
  const hash = crypto.createHash('sha1').update(JSON.stringify(clubs)).digest('hex');
  if (hash === lastHash) return false;
  // Au démarrage, ne rien republier si le dépôt a déjà exactement ces chiffres.
  if (!lastHash) {
    const prev = await repoText(`${BANKS_DIR}/club-stats.json`).catch(() => null);
    try {
      if (prev && crypto.createHash('sha1').update(JSON.stringify(JSON.parse(prev).clubs)).digest('hex') === hash) {
        lastHash = hash;
        return false;
      }
    } catch {
      /* fichier illisible : republié */
    }
  }
  const ok = await repoPut(`${BANKS_DIR}/club-stats.json`, body, '[serveur PC] Banques de données : moyennes par club').catch(() => false);
  if (ok) {
    lastHash = hash;
    log(`Banques : moyennes de ${Object.keys(clubs).length} clubs publiées.`);
  }
  return ok;
}
