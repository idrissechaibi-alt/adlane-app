// ENTRAÎNEMENT AUX COMBINÉS (pipe fictif) — ce qui décide si le pipe RÉEL a le droit de proposer des combinés.
//
// Constat (20/10) : les combinés réels ne gagnent que 30 % (20 sur 67) quand les paris simples réels gagnent 61 %. Le réel
// ne propose donc plus de combiné tant que le fictif n'a pas PROUVÉ qu'une façon de les choisir (une « recette ») dépasse
// 50 % sur 200 combinés ou plus.
//
// Comment le fictif s'entraîne : à partir de ses paris simples (aucun pari de plus, aucun doublon dans les courbes ni la
// calibration), il compose des combinés VIRTUELS créneau par créneau (matchs du même moment, une jambe par match) avec
// chacune des recettes ci-dessous, et note si chaque combiné serait passé. Seuls comptent les matchs suivis EN DIRECT à
// partir du démarrage de l'entraînement (choix de l'utilisateur, 23/10) : aucun rattrapage sur l'historique, les 200 combinés
// se font sur des matchs à venir. Une recette =
//   taille (2 ou 3 jambes) · probabilité minimale d'une jambe · familles de marchés autorisées · sens (moins / plus).
// Les jambes sont choisies pour maximiser la probabilité du combiné, avec la cote minimale de l'utilisateur : cote ≥ 1,4,
// donc probabilité combinée ≤ 71 % (en dessous de 1,4 le combiné n'est pas jouable).
//
// Une recette est VALIDÉE pour le réel quand : au moins 200 combinés réglés, plus de 50 % réussis, et plus de 50 % sur les
// 100 derniers (pas seulement dans le passé). Elle perd sa validation si, après l'avoir obtenue, elle tombe sous 45 % sur 100
// combinés ou plus. Le réel utilise la validée dont la borne basse de réussite (intervalle de Wilson) est la plus haute.
// La même fonction de choix (pickCombos) sert à l'entraînement et au réel : ce qui est mesuré est ce qui est proposé.

import AsyncStorage from './kvStore';
import { readInPlayProposals } from './learnStore';

export type ComboFamily = 'tous' | 'buts' | 'compteurs' | 'sans1x2';
export type ComboSide = 'tous' | 'moins' | 'plus';

export interface ComboRecipe {
  id: string;
  size: 2 | 3;
  minProb: number;
  family: ComboFamily;
  side: ComboSide;
}

export const MIN_COMBOS = 200;
export const MIN_RATE = 0.5;
/** Cote minimale d'un combiné jouable : probabilité combinée au plus 1 / 1,4. */
export const MAX_COMBINED_PROB = 1 / 1.4;

const SIZES: Array<2 | 3> = [2, 3];
const MIN_PROBS = [0.6, 0.65, 0.7, 0.75];
const FAMILIES: ComboFamily[] = ['tous', 'buts', 'compteurs', 'sans1x2'];
const SIDES: ComboSide[] = ['tous', 'moins', 'plus'];

export const RECIPES: ComboRecipe[] = SIZES.flatMap((size) =>
  MIN_PROBS.flatMap((minProb) => FAMILIES.flatMap((family) => SIDES.map((side) => ({ id: `${size}j|${Math.round(minProb * 100)}|${family}|${side}`, size, minProb, family, side }))))
);

export interface ComboLeg {
  fixtureId: number;
  market: string;
  selection: string;
  prob: number;
}

const GOALS = new Set(['total_buts', 'buts_equipe', 'buts_1ere_mt', 'btts']);
const COUNTS = new Set(['corners', 'corners_equipe', 'cartons', 'fautes']);

/** Marchés suspendus au réel (mesurés trop surestimés) : jamais dans un combiné. */
function isWeak(l: ComboLeg): boolean {
  if (l.market === 'tirs_cadres') return true;
  if (l.market === 'buts_1ere_mt' && !/0-0|pas de but/i.test(l.selection)) return true;
  if (l.market === 'corners' && /^moins/i.test(l.selection) && /sur le match/i.test(l.selection)) return true;
  return false;
}

function sideOf(l: ComboLeg): 'moins' | 'plus' | 'autre' {
  if (/^(moins|btts non|0-0)/i.test(l.selection)) return 'moins';
  if (/^(plus|oui|btts oui)/i.test(l.selection)) return 'plus';
  return 'autre';
}

function eligible(r: ComboRecipe, l: ComboLeg): boolean {
  if (isWeak(l) || l.prob < r.minProb) return false;
  if (r.family === 'buts' && !GOALS.has(l.market)) return false;
  if (r.family === 'compteurs' && !COUNTS.has(l.market)) return false;
  if (r.family === 'sans1x2' && l.market === '1X2') return false;
  if (r.side !== 'tous' && sideOf(l) !== r.side) return false;
  return true;
}

/**
 * Combinés qu'une recette compose dans un créneau : au plus `maxCombos`, sur des matchs distincts (aucun match dans deux
 * combinés), chacun de la probabilité la plus haute possible sous le plafond de cote 1,4.
 */
export function pickCombos<T extends ComboLeg>(recipe: ComboRecipe, legs: T[], maxCombos = 3): T[][] {
  const pool = legs.filter((l) => eligible(recipe, l)).sort((a, b) => b.prob - a.prob).slice(0, 12);
  const out: T[][] = [];
  const used = new Set<number>();
  for (let round = 0; round < maxCombos; round++) {
    let best: T[] | null = null;
    let bestProb = 0;
    const search = (start: number, chosen: T[], prob: number) => {
      if (chosen.length === recipe.size) {
        if (prob <= MAX_COMBINED_PROB && prob > bestProb) {
          bestProb = prob;
          best = [...chosen];
        }
        return;
      }
      for (let i = start; i < pool.length; i++) {
        const l = pool[i];
        if (used.has(l.fixtureId) || chosen.some((c) => c.fixtureId === l.fixtureId)) continue;
        chosen.push(l);
        search(i + 1, chosen, prob * l.prob);
        chosen.pop();
      }
    };
    search(0, [], 1);
    if (!best) break;
    out.push(best);
    for (const l of best as T[]) used.add(l.fixtureId);
  }
  return out;
}

// ---------------------------------------------------------------- état

export interface RecipeStats {
  n: number;
  won: number;
  /** 200 derniers résultats (1 = réussi), le plus récent en dernier. */
  recent: string;
  /** Date de la première validation (puis suivi hors échantillon : combinés réglés depuis). */
  qualifiedAt?: string;
  postN: number;
  postWon: number;
}

interface TrainerState {
  /** Début de l'entraînement : seuls les paris simples créés après comptent. */
  startedAt: string;
  recipes: Record<string, RecipeStats>;
  /** Créneaux déjà comptés. */
  done: string[];
}

const KEY = '@combo_trainer_v2';
/** Première version (entraînement sur l'historique) : abandonnée, jamais relue. */
const OLD_KEY = '@combo_trainer';
const SLOT_MS = 20 * 60_000;
let memo: TrainerState | null = null;

async function load(): Promise<TrainerState> {
  if (memo) return memo;
  try {
    memo = JSON.parse((await AsyncStorage.getItem(KEY)) ?? 'null');
  } catch {
    memo = null;
  }
  if (!memo) {
    memo = { startedAt: new Date().toISOString(), recipes: {}, done: [] };
    await AsyncStorage.setItem(KEY, JSON.stringify(memo));
    await AsyncStorage.removeItem(OLD_KEY).catch(() => {});
  }
  return memo;
}

const wilsonLow = (won: number, n: number): number => {
  if (n === 0) return 0;
  const z = 1.96;
  const p = won / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
};

const rateOf = (s: { won: number; n: number }) => (s.n > 0 ? s.won / s.n : 0);
const recentRate = (s: RecipeStats): number => {
  const r = s.recent.slice(-100);
  return r.length ? r.split('').filter((c) => c === '1').length / r.length : 0;
};

/** Une recette est-elle validée pour le réel ? */
export function isValidated(s: RecipeStats | undefined): boolean {
  if (!s || s.n < MIN_COMBOS) return false;
  if (rateOf(s) <= MIN_RATE) return false;
  if (s.recent.length >= 100 && recentRate(s) <= MIN_RATE) return false;
  if (s.qualifiedAt && s.postN >= 100 && s.postWon / s.postN < 0.45) return false;
  return true;
}

/** La recette validée la plus fiable (borne basse de Wilson), ou null : le réel ne propose alors aucun combiné. */
export async function bestValidatedRecipe(): Promise<{ recipe: ComboRecipe; stats: RecipeStats } | null> {
  const st = await load();
  let best: { recipe: ComboRecipe; stats: RecipeStats; low: number } | null = null;
  for (const recipe of RECIPES) {
    const stats = st.recipes[recipe.id];
    if (!isValidated(stats)) continue;
    const low = wilsonLow(stats.won, stats.n);
    if (!best || low > best.low) best = { recipe, stats, low };
  }
  return best ? { recipe: best.recipe, stats: best.stats } : null;
}

// ---------------------------------------------------------------- entraînement

/**
 * Compte les créneaux terminés du fictif dans les statistiques des recettes. Un créneau (matchs dont le checkpoint tombe
 * dans la même tranche de 20 min) est compté quand toutes ses jambes sont réglées ou annulées, ou 72 h après (les jambes
 * restées sans verdict sont alors annulées : un combiné qui en contient une est écarté, jamais compté comme perdu).
 */
export async function trainCombos(maxSlots = 800): Promise<{ slots: number; combos: number }> {
  const st = await load();
  const done = new Set(st.done);
  const slots = new Map<string, Array<{ leg: ComboLeg & { state: 'won' | 'lost' | 'void' | 'pending' }; at: number }>>();
  for (const p of readInPlayProposals()) {
    if (p.real !== false || p.strategy || p.legs.length !== 1 || (p.kind !== 'minute20' && p.kind !== 'minute60')) continue;
    const l = p.legs[0];
    const at = Date.parse(p.createdAt);
    if (!Number.isFinite(at) || at < Date.parse(st.startedAt)) continue;
    const key = `${p.kind}|${Math.floor(at / SLOT_MS)}`;
    if (done.has(key)) continue;
    const state = l.voided ? 'void' : !l.settled ? 'pending' : l.won ? 'won' : 'lost';
    const list = slots.get(key) ?? [];
    list.push({ leg: { fixtureId: l.fixtureId, market: l.market, selection: l.selection, prob: l.prob, state }, at });
    slots.set(key, list);
  }
  const now = Date.now();
  const ready = [...slots.entries()]
    .filter(([key, list]) => {
      const end = (Number(key.split('|')[1]) + 1) * SLOT_MS;
      if (now < end + 40 * 60_000) return false;
      return now > end + 72 * 3_600_000 || list.every((x) => x.leg.state !== 'pending');
    })
    .sort((a, b) => Number(a[0].split('|')[1]) - Number(b[0].split('|')[1]))
    .slice(0, maxSlots);

  let combos = 0;
  for (const [key, list] of ready) {
    done.add(key);
    const legs = list.map((x) => x.leg);
    if (new Set(legs.map((l) => l.fixtureId)).size < 2) continue;
    for (const recipe of RECIPES) {
      for (const combo of pickCombos(recipe, legs)) {
        if (combo.some((l) => l.state === 'void' || l.state === 'pending')) continue;
        const won = combo.every((l) => l.state === 'won');
        const s = (st.recipes[recipe.id] ??= { n: 0, won: 0, recent: '', postN: 0, postWon: 0 });
        if (s.qualifiedAt) {
          s.postN++;
          if (won) s.postWon++;
        }
        s.n++;
        if (won) s.won++;
        s.recent = (s.recent + (won ? '1' : '0')).slice(-200);
        if (!s.qualifiedAt && isValidated(s)) s.qualifiedAt = new Date().toISOString();
        combos++;
      }
    }
  }
  if (ready.length) {
    st.done = [...done].slice(-20_000);
    await AsyncStorage.setItem(KEY, JSON.stringify(st));
  }
  return { slots: ready.length, combos };
}

/** Avancée vers la règle des combinés (plus de 50 % sur 200 combinés ou plus) : meilleure recette du moment, même très jeune. */
export async function getComboProgress(): Promise<{
  leader: { id: string; n: number; won: number; rate: number; recentRate: number | null } | null;
  needed: number;
  target: number;
  validated: number;
  recipes: number;
  slotsDone: number;
  since: string;
}> {
  const st = await load();
  let leader: { id: string; n: number; won: number; rate: number; recentRate: number | null } | null = null;
  for (const r of RECIPES) {
    const s = st.recipes[r.id];
    if (!s || s.n === 0) continue;
    // Meilleure borne basse de Wilson : une recette à 3 sur 3 ne passe pas devant une recette à 60 % sur 150.
    if (!leader || wilsonLow(s.won, s.n) > wilsonLow(leader.won, leader.n)) leader = { id: r.id, n: s.n, won: s.won, rate: rateOf(s), recentRate: s.recent.length >= 20 ? recentRate(s) : null };
  }
  return { leader, needed: MIN_COMBOS, target: MIN_RATE, validated: RECIPES.filter((r) => isValidated(st.recipes[r.id])).length, recipes: RECIPES.length, slotsDone: st.done.length, since: st.startedAt };
}

/** Résumé pour le rapport du soir et le diagnostic : meilleure recette (même non validée) et recettes validées. */
export async function getComboTrainerStatus(): Promise<{
  validated: Array<{ id: string; n: number; rate: number }>;
  best: { id: string; n: number; rate: number; recentRate: number } | null;
  slotsDone: number;
  since: string;
}> {
  const st = await load();
  const validated = RECIPES.filter((r) => isValidated(st.recipes[r.id])).map((r) => ({ id: r.id, n: st.recipes[r.id].n, rate: rateOf(st.recipes[r.id]) }));
  let best: { id: string; n: number; rate: number; recentRate: number } | null = null;
  for (const r of RECIPES) {
    const s = st.recipes[r.id];
    if (!s || s.n < 50) continue;
    if (!best || wilsonLow(s.won, s.n) > wilsonLow(Math.round(best.rate * best.n), best.n)) best = { id: r.id, n: s.n, rate: rateOf(s), recentRate: recentRate(s) };
  }
  return { validated, best, slotsDone: st.done.length, since: st.startedAt };
}
