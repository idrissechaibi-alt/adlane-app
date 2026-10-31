// Recoupement des compositions : un onze n'est tenu pour officiel que si AU MOINS 3 sources indépendantes (FotMob, 365Scores, ESPN,
// LiveScore) donnent les mêmes titulaires. Un onze prévu ou une source isolée ne suffit jamais : l'entraîneur attend. Le recoupement
// donne aussi le système, les remplaçants et les indisponibles (blessés, suspendus) avec leur cause, pour que « absent » ne soit plus
// confondu avec « laissé sur le banc ».

import { hubDateKey, hubLineups, type MissingPlayer, type SourceLineup } from '../../api/footballDataAPIs/liveDataHub';
import { namesLikelyMatch, normalizeTeamName } from '../teamNameMatch';
import { fetchRepoJson } from '../gitAutoSync';
import { SERVER_LINEUPS_DIR } from '../serverFeed';

/** Nombre minimal de sources concordantes. */
export const MIN_SOURCES = 3;
/** Le recoupement n'est tenté que dans l'heure qui précède le coup d'envoi (compos officielles publiées vers T-60 min). */
export const LINEUP_WINDOW_MIN = 55;

export interface ConsensusSide {
  formation: string | null;
  starters: string[];
  subs: string[];
  /** Blessés / suspendus signalés par au moins une source (le nombre de sources qui le disent est dans `sources`). */
  missing: Array<{ name: string; reason: string | null; back: string | null; sources: number }>;
  /** Titulaires que toutes les sources ne donnent pas (nom → nombre de sources qui le donnent). */
  disputed: Array<{ name: string; sources: number }>;
}

export type LineupConsensus =
  | { ok: true; at: string; sources: string[]; home: ConsensusSide; away: ConsensusSide; notes: string[] }
  | { ok: false; reason: string; sources: string[] };

const PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'van', 'von', 'der', 'den', 'di', 'del', 'la', 'le', 'el', 'al', 'ter', 'ten', 'jr', 'junior']);

/** Mots d'un nom sans accent ni ponctuation (« Pascal Groß » → pascal, gross ; « Lewis-Potter » → lewis, potter). */
function tokens(name: string): string[] {
  return name
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 2 && !PARTICLES.has(t));
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * Ressemblance de deux noms de joueur (0 à 1). Les sources écrivent le même joueur de façons très différentes : « Hwang Hee-chan » /
 * « Hee-Chan Hwang », « Rômulo » / « Rômulo José Cardoso da Cruz », « Florentino » / « Florentino Luis », « El Khannous » /
 * « El Khannouss » / « El Khanouss », « Jair » / « Jair Cunha ». Un mot en commun (ou presque : une lettre d'écart) suffit, la
 * comparaison se faisant toujours entre joueurs de la même équipe.
 */
export function playerSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  let best = 0;
  let hits = 0;
  let onlyFirstNames = true;
  ta.forEach((x, i) => tb.forEach((y, j) => {
    let sim = 0;
    if (x === y) sim = x.length >= 3 ? 1 : 0.5;
    else if (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x))) sim = 0.9;
    else if (Math.min(x.length, y.length) >= 5 && editDistance(x, y) <= (Math.max(x.length, y.length) >= 8 ? 2 : 1)) sim = 0.85;
    if (sim <= 0) return;
    hits++;
    if (i !== 0 || j !== 0) onlyFirstNames = false;
    best = Math.max(best, sim);
  }));
  // « Harry Maguire » / « Harry Kane » : seul le prénom est commun, ce sont deux joueurs différents.
  if (ta.length >= 2 && tb.length >= 2 && onlyFirstNames) return Math.min(best, 0.6);
  // Plusieurs mots en commun départagent deux candidats (« Jordan Henderson » plutôt que « Jordan » seul).
  return best + Math.min(hits - 1, 3) * 0.01;
}

export const samePlayer = (a: string, b: string): boolean => playerSimilarity(a, b) >= 0.85;


/** Ce joueur figure-t-il dans la liste ? */
export const inPlayers = (name: string, list: string[]): boolean => list.some((x) => samePlayer(name, x));

/** Appariement glouton des deux listes (meilleures ressemblances d'abord, chaque joueur pris une fois) : paires [i, j]. */
function pairUp(a: string[], b: string[]): Array<[number, number]> {
  const cand: Array<[number, number, number]> = [];
  a.forEach((x, i) => b.forEach((y, j) => {
    const sim = playerSimilarity(x, y);
    if (sim >= 0.85) cand.push([sim, i, j]);
  }));
  cand.sort((p, q) => q[0] - p[0]);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const [, i, j] of cand) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    pairs.push([i, j]);
  }
  return pairs;
}

const overlap = (a: string[], b: string[]) => pairUp(a, b).length;

/** Regroupe les noms donnés par plusieurs sources : un groupe par joueur, avec le nombre de sources qui le citent. */
function cluster<T extends { name: string }>(lists: T[][], prefer: number): Array<{ items: T[]; sources: number; display: string }> {
  const groups: Array<{ items: T[]; sources: number; display: string; from: Set<number> }> = [];
  lists.forEach((list, src) => {
    const free = groups.filter((g) => !g.from.has(src));
    const pairs = pairUp(free.map((g) => g.display), list.map((x) => x.name));
    const taken = new Set<number>();
    for (const [gi, li] of pairs) {
      const g = free[gi];
      g.items.push(list[li]);
      g.sources++;
      g.from.add(src);
      if (src === prefer) g.display = list[li].name;
      taken.add(li);
    }
    list.forEach((x, li) => {
      if (!taken.has(li)) groups.push({ items: [x], sources: 1, display: x.name, from: new Set([src]) });
    });
  });
  return groups.map(({ items, sources, display }) => ({ items, sources, display }));
}

/** Réunit ce que les sources disent d'un côté (domicile ou extérieur). `prefer` : index de la source dont on garde l'orthographe. */
function mergeSide(sides: Array<SourceLineup['home']>, prefer: number): ConsensusSide | null {
  const n = sides.length;
  const need = Math.min(MIN_SOURCES, n);
  const starters = cluster(sides.map((s) => s.starters.map((name) => ({ name }))), prefer);
  const agreed = starters.filter((g) => g.sources >= need);
  if (agreed.length !== 11) return null;
  const formations = new Map<string, number>();
  for (const s of sides) if (s.formation) formations.set(s.formation, (formations.get(s.formation) ?? 0) + 1);
  const formation = [...formations.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const starterNames = agreed.map((g) => g.display);

  const subs = cluster(sides.map((s) => s.subs.filter((x) => !inPlayers(x, starterNames)).map((name) => ({ name }))), prefer)
    .filter((g) => g.sources >= Math.min(2, n))
    .map((g) => g.display);
  // Joué ≠ indisponible : une source en retard qui le dit blessé ne l'emporte pas sur le onze recoupé.
  const missing = cluster(sides.map((s) => (s.missing as MissingPlayer[]).filter((m) => !inPlayers(m.name, starterNames))), prefer)
    .map((g) => ({
      name: g.display,
      reason: g.items.find((x) => x.reason)?.reason ?? null,
      back: g.items.find((x) => x.back)?.back ?? null,
      sources: g.sources,
    }))
    .sort((a, b) => b.sources - a.sources);
  return {
    formation,
    starters: starterNames,
    subs,
    missing,
    disputed: starters.filter((g) => g.sources < n).map((g) => ({ name: g.display, sources: g.sources })),
  };
}

/** Recoupe les compositions de toutes les sources pour un match. `ok: false` tant que moins de 3 sources donnent le même onze. */
export function buildConsensus(lineups: SourceLineup[]): LineupConsensus {
  const names = lineups.map((l) => l.provider);
  if (lineups.length < MIN_SOURCES) return { ok: false, reason: `${lineups.length} source(s) seulement ont publié la composition (3 minimum)`, sources: names };
  // Une source qui range domicile / extérieur à l'envers est remise dans le bon sens d'après la première.
  const ref = lineups[0];
  const oriented = lineups.map((l) => (overlap(l.home.starters, ref.away.starters) > overlap(l.home.starters, ref.home.starters) ? { ...l, home: l.away, away: l.home } : l));
  // Une source dont le onze ne ressemble pas aux autres (onze prévu, mauvais match) est écartée : il lui faut 8 titulaires en commun
  // avec au moins une autre source, des deux côtés.
  const keep = oriented.filter((l) => oriented.some((o) => o !== l && overlap(l.home.starters, o.home.starters) >= 8 && overlap(l.away.starters, o.away.starters) >= 8));
  const kept = keep.map((l) => l.provider);
  if (keep.length < MIN_SOURCES) return { ok: false, reason: `les sources ne donnent pas le même onze (${keep.length} concordantes sur ${lineups.length})`, sources: kept };
  const prefer = Math.max(0, keep.findIndex((l) => l.provider === 'FotMob'));
  const home = mergeSide(keep.map((l) => l.home), prefer);
  const away = mergeSide(keep.map((l) => l.away), prefer);
  if (!home || !away) return { ok: false, reason: 'moins de 11 titulaires confirmés par 3 sources', sources: kept };
  const notes: string[] = [];
  const dropped = lineups.filter((l) => !kept.includes(l.provider)).map((l) => l.provider);
  if (dropped.length) notes.push(`source(s) écartée(s) car en désaccord : ${dropped.join(', ')}`);
  const unconfirmed = keep.filter((l) => l.official === false).map((l) => l.provider);
  if (unconfirmed.length) notes.push(`${unconfirmed.join(', ')} annonce(nt) encore un onze prévu`);
  return { ok: true, at: new Date().toISOString(), sources: kept, home, away, notes };
}

const memo = new Map<string, { at: number; value: LineupConsensus }>();

let serverMemo: { day: string; at: number; matches: Record<string, any> } | null = null;

/** Composition recoupée par le serveur PC pour ce match (data/server/lineups/<jour>.json), si elle est récente. */
async function fromServer(home: string, away: string, day: string): Promise<LineupConsensus | null> {
  try {
    if (!serverMemo || serverMemo.day !== day || Date.now() - serverMemo.at > 60_000) {
      const json = await fetchRepoJson<{ matches?: Record<string, any> }>(`${SERVER_LINEUPS_DIR}/${day}.json`);
      serverMemo = { day, at: Date.now(), matches: json?.matches ?? {} };
    }
    const h = normalizeTeamName(home);
    const a = normalizeTeamName(away);
    const hit = Object.values(serverMemo.matches).find((m: any) => m?.ok && namesLikelyMatch(h, normalizeTeamName(m.home_team ?? '')) && namesLikelyMatch(a, normalizeTeamName(m.away_team ?? '')));
    if (!hit || Date.now() - Date.parse(hit.at) > 15 * 60_000 * 4) return null;
    return { ok: true, at: hit.at, sources: [...hit.sources, 'serveur PC'], home: hit.home, away: hit.away, notes: hit.notes ?? [] };
  } catch {
    return null;
  }
}

/** Compositions recoupées d'un match (mémoire 2 min : l'écran et la tâche de fond n'interrogent pas les sources à chaque passage). */
export async function getLineupConsensus(home: string, away: string, force = false): Promise<LineupConsensus> {
  const day = hubDateKey();
  const key = `${day}|${normalizeTeamName(home)}|${normalizeTeamName(away)}`;
  const hit = memo.get(key);
  if (!force && hit && Date.now() - hit.at < 2 * 60_000) return hit.value;
  const lineups = await hubLineups(home, away, day).catch(() => [] as SourceLineup[]);
  let value = buildConsensus(lineups);
  // Les sources du téléphone ne suffisent pas : on prend ce que le serveur PC a recoupé (au plus 15 min).
  if (!value.ok) value = (await fromServer(home, away, day)) ?? value;
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** Empreinte d'une composition recoupée : l'avis est refait si elle change. */
export function consensusHash(c: Extract<LineupConsensus, { ok: true }>): string {
  const key = (name: string) => tokens(name).sort().join(' ');
  const side = (s: ConsensusSide) => `${s.formation ?? ''}:${s.starters.map(key).sort().join(',')}:${s.missing.map((m) => key(m.name)).sort().join(',')}`;
  const text = `${side(c.home)}|${side(c.away)}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h);
}
