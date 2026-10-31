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

/** Clé de comparaison d'un nom : « Moisés Caicedo », « Moises Caicedo » et « M. Caicedo » ont la même (nom de famille sans accent). */
export function nameKey(name: string): string {
  const plain = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .trim();
  const parts = plain.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const particles = new Set(['de', 'da', 'do', 'dos', 'van', 'von', 'der', 'den', 'di', 'del', 'la', 'le', 'el', 'al', 'ter', 'ten']);
  let i = parts.length - 1;
  // « de Ligt », « van Dijk », « ter Stegen » : la particule fait partie du nom de famille.
  while (i > 0 && particles.has(parts[i - 1])) i--;
  return parts.slice(i).join(' ');
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((k) => b.has(k)).length;

/** Réunit ce que les sources disent d'un côté (domicile ou extérieur). */
function mergeSide(sides: Array<SourceLineup['home']>): ConsensusSide | null {
  const n = sides.length;
  const need = Math.min(MIN_SOURCES, n);
  const count = new Map<string, { n: number; display: string }>();
  for (const s of sides) {
    for (const name of new Set(s.starters)) {
      const k = nameKey(name);
      if (!k) continue;
      const cur = count.get(k) ?? { n: 0, display: name };
      cur.n++;
      count.set(k, cur);
    }
  }
  const agreed = [...count.values()].filter((x) => x.n >= need);
  if (agreed.length !== 11) return null;
  const formations = new Map<string, number>();
  for (const s of sides) if (s.formation) formations.set(s.formation, (formations.get(s.formation) ?? 0) + 1);
  const formation = [...formations.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const startersKeys = new Set([...count.entries()].filter(([, v]) => v.n >= need).map(([k]) => k));
  const subsCount = new Map<string, { n: number; display: string }>();
  for (const s of sides) for (const name of new Set(s.subs)) {
    const k = nameKey(name);
    if (!k || startersKeys.has(k)) continue;
    const cur = subsCount.get(k) ?? { n: 0, display: name };
    cur.n++;
    subsCount.set(k, cur);
  }
  const miss = new Map<string, { name: string; reason: string | null; back: string | null; sources: number }>();
  for (const s of sides) for (const m of s.missing as MissingPlayer[]) {
    const k = nameKey(m.name);
    if (!k || startersKeys.has(k)) continue; // joué ≠ indisponible : une source en retard ne l'emporte pas sur le onze recoupé
    const cur = miss.get(k) ?? { name: m.name, reason: m.reason, back: m.back, sources: 0 };
    cur.sources++;
    cur.reason ??= m.reason;
    cur.back ??= m.back;
    miss.set(k, cur);
  }
  return {
    formation,
    starters: agreed.map((x) => x.display),
    subs: [...subsCount.values()].filter((x) => x.n >= Math.min(2, n)).map((x) => x.display),
    missing: [...miss.values()].sort((a, b) => b.sources - a.sources),
    disputed: [...count.values()].filter((x) => x.n < n && x.n >= 1).map((x) => ({ name: x.display, sources: x.n })),
  };
}

/** Recoupe les compositions de toutes les sources pour un match. `ok: false` tant que moins de 3 sources donnent le même onze. */
export function buildConsensus(lineups: SourceLineup[]): LineupConsensus {
  const names = lineups.map((l) => l.provider);
  if (lineups.length < MIN_SOURCES) return { ok: false, reason: `${lineups.length} source(s) seulement ont publié la composition (3 minimum)`, sources: names };
  // Une source qui range domicile / extérieur à l'envers est remise dans le bon sens d'après la première.
  const ref = lineups[0];
  const refHome = new Set(ref.home.starters.map(nameKey));
  const refAway = new Set(ref.away.starters.map(nameKey));
  const oriented = lineups.map((l) => {
    const h = new Set(l.home.starters.map(nameKey));
    const straight = overlap(h, refHome);
    const swapped = overlap(h, refAway);
    return swapped > straight ? { ...l, home: l.away, away: l.home } : l;
  });
  // Une source dont le onze ne ressemble pas du tout aux autres (onze prévu, mauvais match) est écartée.
  const keep = oriented.filter((l) => {
    const h = new Set(l.home.starters.map(nameKey));
    const others = oriented.filter((o) => o !== l);
    return others.filter((o) => overlap(h, new Set(o.home.starters.map(nameKey))) >= 8).length >= 1;
  });
  if (keep.length < MIN_SOURCES) return { ok: false, reason: `les sources ne donnent pas le même onze (${keep.length} concordantes sur ${lineups.length})`, sources: keep.map((l) => l.provider) };
  const home = mergeSide(keep.map((l) => l.home));
  const away = mergeSide(keep.map((l) => l.away));
  if (!home || !away) return { ok: false, reason: 'moins de 11 titulaires confirmés par 3 sources', sources: keep.map((l) => l.provider) };
  const notes: string[] = [];
  const dropped = lineups.filter((l) => !keep.includes(l)).map((l) => l.provider);
  if (dropped.length) notes.push(`source(s) écartée(s) car en désaccord : ${dropped.join(', ')}`);
  const unconfirmed = keep.filter((l) => l.official === false).map((l) => l.provider);
  if (unconfirmed.length) notes.push(`${unconfirmed.join(', ')} annonce(nt) encore un onze prévu`);
  return { ok: true, at: new Date().toISOString(), sources: keep.map((l) => l.provider), home, away, notes };
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
  const side = (s: ConsensusSide) => `${s.formation ?? ''}:${s.starters.map(nameKey).sort().join(',')}:${s.missing.map((m) => nameKey(m.name)).sort().join(',')}`;
  const text = `${side(c.home)}|${side(c.away)}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h);
}
