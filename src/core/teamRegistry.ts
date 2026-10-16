// REGISTRE DES ÉQUIPES : une seule identité par équipe, quel que soit le nom donné par la source du moment.
//
// Chaque nom rencontré (planning, sources du direct, fichier des équipes) est comparé aux équipes déjà connues. S'il désigne
// sans ambiguïté une équipe connue (mêmes mots une fois retirés sigles et articles : « Atalanta BC » = « Atalanta »,
// « RC Deportivo La Coruña » = « Deportivo La Coruna »), l'alias est appris DÉFINITIVEMENT (teamAliasStore) : partout dans
// l'app, normalizeTeamName renvoie alors la même équipe (relevés, résumés de match, dossiers d'équipe, tendances, paris).
// Sinon le nom devient une nouvelle équipe du registre. Les cas douteux (Real Madrid / Real Madrid Castilla) ne fusionnent pas.

import AsyncStorage from './kvStore';
import { normalizeTeamName, sameTeamStrict, teamCoreKey } from './teamNameMatch';
import { learnAlias, loadLearnedAliases } from './teamAliasStore';

const KEY = '@team_registry';
let registry: Record<string, string> | null = null; // nom normalisé → nom affiché de référence
let dirty = false;
// Index pour retrouver une équipe sans parcourir tout le registre : clé d'identité exacte, et seau (nb de mots + 2 lettres)
// pour les écritures voisines.
let byCore: Map<string, string> | null = null;
let buckets: Map<string, string[]> | null = null;
const bucketOf = (core: string) => `${core.split(' ').length}|${core.slice(core.indexOf('|') + 1, core.indexOf('|') + 3)}`;
function index(norm: string, display: string): void {
  const core = teamCoreKey(norm);
  if (!core) return;
  if (!byCore!.has(core)) byCore!.set(core, display);
  const b = bucketOf(core);
  (buckets!.get(b) ?? buckets!.set(b, []).get(b)!).push(norm);
}
function ensureIndex(reg: Record<string, string>): void {
  if (byCore) return;
  byCore = new Map();
  buckets = new Map();
  for (const [k, v] of Object.entries(reg)) index(k, v);
}

export async function loadTeamRegistry(): Promise<void> {
  await loadLearnedAliases();
  if (registry) return;
  try {
    registry = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}');
  } catch {
    registry = {};
  }
}

export async function saveTeamRegistry(): Promise<void> {
  if (!dirty || !registry) return;
  dirty = false;
  await AsyncStorage.setItem(KEY, JSON.stringify(registry)).catch(() => {});
}

/** Nom de référence d'une équipe (enregistre le nom s'il est nouveau, apprend l'alias s'il désigne une équipe connue). */
export function canonicalTeam(raw: string): string {
  if (!raw) return raw;
  const reg = registry ?? (registry = {});
  const norm = normalizeTeamName(raw);
  if (!norm) return raw;
  const known = reg[norm];
  if (known) return known;
  ensureIndex(reg);
  const core = teamCoreKey(norm);
  let match: string | undefined = core ? byCore!.get(core) : undefined;
  if (!match && core) {
    const k = (buckets!.get(bucketOf(core)) ?? []).find((x) => sameTeamStrict(norm, x));
    if (k) match = reg[k];
  }
  if (match) {
    // Même équipe sous un autre nom : retenu pour toujours (toute l'app le voit via normalizeTeamName).
    learnAlias(match, raw).catch(() => {});
    return match;
  }
  reg[norm] = raw;
  index(norm, raw);
  dirty = true;
  return raw;
}

/** Enregistre une liste de noms de référence (fichier des équipes, planning) avant les sources du direct. */
export function registerTeams(names: string[]): void {
  for (const n of names) canonicalTeam(n);
}

/** Applique les noms de référence aux deux équipes d'une liste de matchs (sur place). */
export function canonicalizeFixtures<T extends { homeTeam: string; awayTeam: string }>(fixtures: T[]): T[] {
  for (const f of fixtures) {
    f.homeTeam = canonicalTeam(f.homeTeam);
    f.awayTeam = canonicalTeam(f.awayTeam);
  }
  return fixtures;
}

export function teamRegistrySize(): number {
  return Object.keys(registry ?? {}).length;
}
