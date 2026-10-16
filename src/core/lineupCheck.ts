// Composition officielle, vérifiée ~15 minutes avant chaque match RÉEL : elle est comparée au fichier des équipes (titulaires
// habituels, système habituel, joueurs clés de la saison). Ce qui en sort :
//  - les titulaires habituels absents, en particulier les joueurs clés (buts + passes décisives + xG de la saison) ;
//  - un changement de système (4-3-3 habituel, 5-3-2 aligné…) ;
//  - un facteur sur les buts attendus de l'équipe (part des buts de la saison portée par les absents, plafonné à -25 %) ;
//  - une note jointe à l'argumentaire de chaque pari du match, et deux déclencheurs pour les motifs (absences, système).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { hubDateKey, hubLineup } from '../api/footballDataAPIs/liveDataHub';
import { getTeamProfile, TeamPlayer } from './teamStats';
import { normalizeTeamName } from './teamNameMatch';

const KEY = '@lineup_checks';
const MAX_GOAL_FACTOR_DROP = 0.25;

export interface SideCheck {
  team: string;
  formation: string | null;
  usualFormation: string | null;
  formationChanged: boolean;
  /** Titulaires habituels absents du onze de départ. */
  absentUsual: string[];
  /** Parmi eux, les joueurs clés (au moins 2 buts + passes cette saison). */
  absentKey: string[];
  /** Multiplicateur des buts attendus de l'équipe (1 = aucun effet). */
  goalFactor: number;
}

export interface LineupCheck {
  at: string;
  match: string;
  home: SideCheck;
  away: SideCheck;
  note: string;
}

let memo: Record<string, LineupCheck> | null = null;

async function load(): Promise<Record<string, LineupCheck>> {
  if (memo) return memo;
  try {
    memo = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}');
  } catch {
    memo = {};
  }
  return memo!;
}

const keyOf = (home: string, away: string) => `${hubDateKey()}|${normalizeTeamName(home)}|${normalizeTeamName(away)}`;

function compareSide(team: string, lineup: { formation: string | null; starters: Array<{ id: number; name: string }> }, profile: { usualXI: number[]; usualFormation: string | null; players: TeamPlayer[] } | null): SideCheck {
  const starting = new Set(lineup.starters.map((p) => p.id));
  const players = profile?.players ?? [];
  const byId = new Map(players.map((p) => [p.id, p]));
  const absentUsual = (profile?.usualXI ?? []).filter((id) => !starting.has(id)).map((id) => byId.get(id)).filter((p): p is TeamPlayer => !!p);
  const key = absentUsual.filter((p) => p.goals + p.assists >= 2);
  // Part des buts + passes de la saison portée par les joueurs clés absents → baisse des buts attendus (plafonnée).
  const totalContrib = players.reduce((s, p) => s + p.goals + p.assists * 0.5, 0);
  const missing = key.reduce((s, p) => s + p.goals + p.assists * 0.5, 0);
  const drop = totalContrib > 0 ? Math.min(MAX_GOAL_FACTOR_DROP, (missing / totalContrib) * 0.6) : 0;
  const usualFormation = profile?.usualFormation ?? null;
  return {
    team,
    formation: lineup.formation,
    usualFormation,
    formationChanged: !!(usualFormation && lineup.formation && usualFormation !== lineup.formation),
    absentUsual: absentUsual.map((p) => p.name),
    absentKey: key.map((p) => p.name),
    goalFactor: Math.round((1 - drop) * 100) / 100,
  };
}

function describe(c: SideCheck): string {
  const parts: string[] = [];
  if (c.formation) parts.push(c.formationChanged ? `système ${c.formation} au lieu de son ${c.usualFormation} habituel` : `système ${c.formation} habituel`);
  if (c.absentKey.length) parts.push(`absents clés : ${c.absentKey.join(', ')}`);
  else if (c.absentUsual.length) parts.push(`${c.absentUsual.length} titulaire(s) habituel(s) absent(s) (${c.absentUsual.slice(0, 3).join(', ')})`);
  else parts.push('onze habituel');
  if (c.goalFactor < 1) parts.push(`buts attendus ×${c.goalFactor.toFixed(2)}`);
  return `${c.team} : ${parts.join(', ')}`;
}

/** Vérifie la compo d'un match (une fois, dès qu'elle est publiée) ; renvoie la vérification (en mémoire ensuite). */
export async function checkLineup(homeTeam: string, awayTeam: string): Promise<LineupCheck | null> {
  const store = await load();
  const k = keyOf(homeTeam, awayTeam);
  if (store[k]) return store[k];
  const lineup = await hubLineup(homeTeam, awayTeam, hubDateKey()).catch(() => null);
  if (!lineup) return null;
  const [hp, ap] = await Promise.all([getTeamProfile(homeTeam).catch(() => null), getTeamProfile(awayTeam).catch(() => null)]);
  const home = compareSide(homeTeam, lineup.home, hp);
  const away = compareSide(awayTeam, lineup.away, ap);
  const check: LineupCheck = { at: new Date().toISOString(), match: `${homeTeam} - ${awayTeam}`, home, away, note: ` Compo officielle — ${describe(home)} ; ${describe(away)}.` };
  store[k] = check;
  // Les vérifications de plus de 3 jours sont retirées (elles ont déjà servi).
  const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  for (const key of Object.keys(store)) if (key.slice(0, 10) < cutoff) delete store[key];
  await AsyncStorage.setItem(KEY, JSON.stringify(store)).catch(() => {});
  return check;
}

/** Vérification déjà faite pour ce match (sans réseau). */
export async function getLineupCheck(homeTeam: string, awayTeam: string): Promise<LineupCheck | null> {
  return (await load())[keyOf(homeTeam, awayTeam)] ?? null;
}

/**
 * À appeler à chaque tour rapide : vérifie la compo des matchs réels qui commencent dans les 20 prochaines minutes (ou viennent
 * de commencer), dès qu'elle est publiée.
 */
export async function runLineupChecks(planned: Array<{ homeTeam: string; awayTeam: string; kickoff_utc: string }>): Promise<number> {
  let done = 0;
  for (const m of planned) {
    const minutes = (Date.parse(m.kickoff_utc) - Date.now()) / 60_000;
    if (minutes > 20 || minutes < -10) continue;
    if (await getLineupCheck(m.homeTeam, m.awayTeam)) continue;
    if (await checkLineup(m.homeTeam, m.awayTeam).catch(() => null)) done++;
  }
  return done;
}
