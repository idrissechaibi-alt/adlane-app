// Marché « tirs cadrés d'un joueur » (« Plus de » 0.5 / 1.5 / 2.5, seules lignes offertes par les bookmakers).
// Source gratuite : ESPN, relevé joueur par joueur (tirs cadrés / tirs totaux),
// en direct comme au règlement. Le taux de tir observé est mêlé à un taux a priori
// par poste (équivalent de 30 minutes de jeu) — un joueur sans tir n'est donc ni
// condamné ni survendu. La probabilité passe ensuite par la même calibration que
// les autres marchés (marché « tirs_cadres »).

import { HubPlayerShots, hubPlayerShots } from '../api/footballDataAPIs/liveDataHub';
import { poissonProb } from './poisson';

/** Tirs cadrés par 90 min d'un titulaire moyen, selon le poste. */
const PRIOR_SOT_PER_90: Record<string, number> = { F: 0.6, M: 0.28, D: 0.09, G: 0 };
const PRIOR_WEIGHT_MINUTES = 30;
const MATCH_END = 94;

export interface PlayerShotLeg {
  selection: string;
  prob: number;
  evidence: string;
}

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();
}

/** P(N ≤ k) pour N ~ Poisson(lambda). */
function cdf(lambda: number, k: number): number {
  let p = 0;
  for (let i = 0; i <= k; i++) p += poissonProb(lambda, i);
  return Math.min(1, p);
}

function legsForPlayer(p: HubPlayerShots, elapsed: number, teamName: string): PlayerShotLeg[] {
  const prior90 = PRIOR_SOT_PER_90[p.position] ?? PRIOR_SOT_PER_90.M;
  if (prior90 <= 0) return [];
  const priorPm = prior90 / 90;
  const rate = (p.sot + priorPm * PRIOR_WEIGHT_MINUTES) / (elapsed + PRIOR_WEIGHT_MINUTES);
  const lambda = rate * Math.max(0, MATCH_END - elapsed);
  const evidence = `${p.name} : ${p.sot} tir(s) cadré(s) sur ${p.shots} tir(s) à la ${elapsed}e minute, ${lambda.toFixed(2)} cadré(s) attendu(s) d'ici la fin (taux observé mêlé au taux moyen du poste ${p.position || 'M'}).`;
  const who = `${p.name} (${teamName})`;
  const out: PlayerShotLeg[] = [];
  const need = (line: number) => Math.floor(line) + 1 - p.sot; // tirs encore à marquer pour dépasser la ligne
  // Les bookmakers n'offrent que « Plus de » 0.5 / 1.5 / 2.5 sur ce marché (pas de « Moins de »).
  for (const line of [0.5, 1.5, 2.5]) {
    const stillNeeded = need(line);
    if (stillNeeded >= 1) out.push({ selection: `Plus de ${line} tir cadré — ${who}`, prob: 1 - cdf(lambda, stillNeeded - 1), evidence });
  }
  return out;
}

/**
 * Meilleures jambes « tirs cadrés joueur » d'un match en cours (titulaires seulement).
 * `minProb` : seuil de qualité ; au plus `max` jambes, les plus sûres d'abord.
 */
export async function playerShotLegs(
  homeTeam: string,
  awayTeam: string,
  dateKey: string,
  elapsed: number,
  options: { minProb?: number; maxProb?: number; max?: number } = {}
): Promise<PlayerShotLeg[]> {
  if (elapsed < 15 || elapsed > 75) return [];
  const players = await hubPlayerShots(homeTeam, awayTeam, dateKey).catch(() => null);
  if (!players) return [];
  const minProb = options.minProb ?? 0.6;
  const maxProb = options.maxProb ?? 0.9; // au-delà : cote ridicule
  const legs: PlayerShotLeg[] = [];
  for (const p of players) {
    if (!p.starter) continue;
    legs.push(...legsForPlayer(p, elapsed, p.team === 'home' ? homeTeam : awayTeam).filter((l) => l.prob >= minProb && l.prob <= maxProb));
  }
  return legs.sort((a, b) => b.prob - a.prob).slice(0, options.max ?? 3);
}

/** Tirs cadrés actuels du joueur nommé dans la sélection (null si introuvable). */
export function playerSotFromSelection(selection: string, players: HubPlayerShots[] | null): number | null {
  if (!players) return null;
  const m = /—\s*(.+?)\s*\(/.exec(selection);
  if (!m) return null;
  const wanted = norm(m[1]);
  const found = players.find((p) => norm(p.name) === wanted) ?? players.find((p) => norm(p.name).includes(wanted) || wanted.includes(norm(p.name)));
  return found ? found.sot : null;
}
