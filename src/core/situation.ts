// Situation d'un match en direct : momentum, favori, état du match, cartons rouges, qualité des
// occasions. Ces variables (SITUATION_FEATURES, deltaLearning.ts) ne sont pas pondérées à la main :
// chaque projection les enregistre, et leurs effets sont appris sur les résultats (±25 % par variable,
// ±40 % au total ; pipe réel seulement après validation sur des matchs de test).
//
// Momentum : sur une fenêtre glissante de 10 et de 20 minutes, la vitesse à laquelle le match produit des
// tirs, tirs cadrés et corners, comparée à sa vitesse depuis le coup d'envoi (intensité récente), et le
// déséquilibre entre les deux équipes sur 15 minutes (domination). Les relevés sont pris à chaque lecture
// des statistiques live ; un match relevé rarement a simplement un momentum neutre (0), jamais inventé.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SofaPeriodStats } from '../api/footballDataAPIs/sofaScore';
import { getOpeningProbabilities } from '../api/footballDataAPIs/refOdds';
import { getSecondOpinion } from './eloRatings';
import { normalizeTeamName } from './teamNameMatch';
import { SITUATION_FEATURES } from './deltaLearning';

const KEY = '@situation_samples';
const KEEP_MS = 5 * 3_600_000;
const MAX_PER_MATCH = 40;
const MAX_MATCHES = 300;
const FLUSH_EVERY_MS = 60_000;

interface Sample {
  ts: number;
  minute: number;
  /** Événements offensifs cumulés par équipe : tirs + 2 × tirs cadrés + corners. */
  eH: number;
  eA: number;
  goalsH: number;
  goalsA: number;
}

const samples = new Map<string, Sample[]>();
let loaded = false;
let lastFlush = 0;

const keyOf = (home: string, away: string) => `${normalizeTeamName(home)}|${normalizeTeamName(away)}`;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Sample[]>)) samples.set(k, v);
  } catch {
    // rien de grave : le momentum repart de zéro
  }
}

async function flush(force = false): Promise<void> {
  if (!force && Date.now() - lastFlush < FLUSH_EVERY_MS) return;
  lastFlush = Date.now();
  const now = Date.now();
  const out: Record<string, Sample[]> = {};
  const entries = [...samples.entries()].map(([k, v]) => [k, v.filter((s) => now - s.ts < KEEP_MS)] as const).filter(([, v]) => v.length > 0);
  for (const [k, v] of entries.slice(-MAX_MATCHES)) out[k] = v.slice(-MAX_PER_MATCH);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // best-effort
  }
}

interface LiveLike {
  homeTeam: string;
  awayTeam: string;
  minute: number;
  homeGoals: number;
  awayGoals: number;
}

const events = (shots: number, sot: number, corners: number) => shots + 2 * sot + corners;

/** Relevé de la situation à chaque lecture des statistiques live. */
export async function noteSituation(live: LiveLike, all: SofaPeriodStats | null | undefined): Promise<void> {
  if (!all || live.minute <= 0) return;
  await load();
  const k = keyOf(live.homeTeam, live.awayTeam);
  const list = samples.get(k) ?? [];
  const last = list[list.length - 1];
  if (last && live.minute - last.minute < 2 && live.minute >= last.minute) return; // pas deux relevés dans la même minute
  list.push({
    ts: Date.now(),
    minute: live.minute,
    eH: events(all.shotsTotalHome, all.shotsOnTargetHome, all.cornersHome),
    eA: events(all.shotsTotalAway, all.shotsOnTargetAway, all.cornersAway),
    goalsH: live.homeGoals,
    goalsA: live.awayGoals,
  });
  samples.set(k, list.slice(-MAX_PER_MATCH));
  void flush();
}

/** Relevé le plus proche de « minute − fenêtre », s'il n'est pas trop éloigné. */
function sampleAround(list: Sample[], target: number, tolerance: number): Sample | null {
  let best: Sample | null = null;
  for (const s of list) {
    if (Math.abs(s.minute - target) <= tolerance && (!best || Math.abs(s.minute - target) < Math.abs(best.minute - target))) best = s;
  }
  return best;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Favori : probabilités d'ouverture bet365, sinon second avis Elo ; mis en cache par match.
const favouriteCache = new Map<string, { at: number; side: 'home' | 'away' | null; strength: number }>();

async function favourite(home: string, away: string): Promise<{ side: 'home' | 'away' | null; strength: number }> {
  const k = keyOf(home, away);
  const hit = favouriteCache.get(k);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit;
  let probs: { home: number; draw: number; away: number } | null = await getOpeningProbabilities(home, away).catch(() => null);
  if (!probs) probs = (await getSecondOpinion(home, away).catch(() => null)) as { home: number; draw: number; away: number } | null;
  const res: { at: number; side: 'home' | 'away' | null; strength: number } = { at: Date.now(), side: null, strength: 0 };
  if (probs) {
    const gap = probs.home - probs.away;
    // Un favori existe dès que l'écart de probabilité dépasse 10 points.
    if (Math.abs(gap) >= 0.1) {
      res.side = gap > 0 ? 'home' : 'away';
      res.strength = clamp(Math.abs(gap) * 1.6, 0, 1);
    }
  }
  favouriteCache.set(k, res);
  return res;
}

/**
 * Vecteur de situation (voir SITUATION_FEATURES), ou null si les statistiques manquent. Toutes les variables
 * valent 0 quand l'information n'existe pas : aucune valeur inventée.
 */
export async function situationFeatures(live: LiveLike, all: SofaPeriodStats | null | undefined): Promise<number[] | null> {
  if (!all || live.minute < 5) return null;
  await load();
  const list = samples.get(keyOf(live.homeTeam, live.awayTeam)) ?? [];
  const eH = events(all.shotsTotalHome, all.shotsOnTargetHome, all.cornersHome);
  const eA = events(all.shotsTotalAway, all.shotsOnTargetAway, all.cornersAway);
  const total = eH + eA;
  const overall = total / live.minute;

  const intensity = (window: number): number => {
    const past = sampleAround(list, live.minute - window, Math.max(4, window * 0.5));
    if (!past || live.minute - past.minute < 5 || overall <= 0) return 0;
    const recent = (total - (past.eH + past.eA)) / (live.minute - past.minute);
    return clamp(recent / overall - 1, -1, 2);
  };

  // Domination récente : écart entre les deux équipes sur ~15 minutes, 0 (équilibre) à 1 (une seule équipe).
  const past15 = sampleAround(list, live.minute - 15, 7);
  let momentum = 0;
  if (past15 && live.minute - past15.minute >= 5) {
    const dH = eH - past15.eH;
    const dA = eA - past15.eA;
    momentum = clamp(Math.abs(dH - dA) / Math.max(4, dH + dA), 0, 1);
  }

  const fav = await favourite(live.homeTeam, live.awayTeam);
  const favGoals = fav.side === 'home' ? live.homeGoals : live.awayGoals;
  const otherGoals = fav.side === 'home' ? live.awayGoals : live.homeGoals;
  const favTrailing = fav.side && favGoals < otherGoals ? Math.min(2, otherGoals - favGoals) / 2 : 0;
  const favLeading = fav.side && favGoals > otherGoals ? Math.min(2, favGoals - otherGoals) / 2 : 0;

  const goalDiff = Math.min(3, Math.abs(live.homeGoals - live.awayGoals)) / 3;
  const reds = Math.min(2, all.redCards ?? 0) / 2;

  // Qualité des occasions : xG en direct (FotMob) si publié, sinon tirs cadrés par rapport à ~8 par match.
  let quality = 0;
  if (all.xgHome != null && all.xgAway != null) quality = clamp(((all.xgHome + all.xgAway) / live.minute) * 90 / 2.6 - 1, -1, 2);
  else if (all.shotsOnTargetHome + all.shotsOnTargetAway > 0) quality = clamp(((all.shotsOnTargetHome + all.shotsOnTargetAway) / live.minute) * 90 / 8 - 1, -1, 2);

  const features = [intensity(10), intensity(20), momentum, fav.strength, favTrailing * (fav.strength > 0 ? 1 : 0), favLeading * (fav.strength > 0 ? 1 : 0), goalDiff, reds, quality];
  return features.length === SITUATION_FEATURES.length ? features : null;
}
