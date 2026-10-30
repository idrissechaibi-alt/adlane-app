// Notes durables des entraîneurs sur les clubs et les joueurs (issues de leurs bilans de fin de match, voir coachReview.ts).
// Module séparé pour que le dossier d'un match (knowledgeBase.ts) puisse les lire sans dépendre des appels à l'IA.

import AsyncStorage from '../kvStore';

export const NOTES_KEY = '@coach_team_notes_v1';

export interface TeamNotes {
  /** Observations par club (les plus récentes en dernier). */
  teams: Record<string, Array<{ day: string; vs: string; lessons: string[] }>>;
  /** Notes par joueur (clé « club|joueur »). */
  players: Record<string, Array<{ day: string; note: string }>>;
  /** Leçons générales de la ligue. */
  general: Array<{ day: string; league: string; lesson: string }>;
}

const emptyNotes = (): TeamNotes => ({ teams: {}, players: {}, general: [] });
let notesMemo: TeamNotes | null = null;

export async function loadNotes(): Promise<TeamNotes> {
  if (notesMemo) return notesMemo;
  try {
    notesMemo = { ...emptyNotes(), ...JSON.parse((await AsyncStorage.getItem(NOTES_KEY)) ?? '{}') };
  } catch {
    notesMemo = emptyNotes();
  }
  return notesMemo!;
}

/** Observations récentes d'un club (dossier d'un prochain match) ; vide sans bilan ou avant le chargement (voir loadNotes). */
export function recentClubNotes(club: string, limit = 3): string[] {
  const list = notesMemo?.teams[club] ?? [];
  return list.slice(-limit).flatMap((n) => n.lessons.slice(0, 2).map((l) => `${n.day} contre ${n.vs} : ${l}`));
}

/** Notes les plus récentes sur les joueurs d'un club. */
export function recentPlayerNotes(club: string, limit = 4): string[] {
  const out: Array<{ day: string; text: string }> = [];
  for (const [k, list] of Object.entries(notesMemo?.players ?? {})) {
    if (!k.startsWith(`${club}|`) || !list.length) continue;
    const last = list[list.length - 1];
    out.push({ day: last.day, text: `${k.slice(club.length + 1)} : ${last.note}` });
  }
  return out.sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit).map((x) => x.text);
}

/** Leçons générales les plus récentes de la ligue, tirées des bilans des entraîneurs. */
export function recentLeagueLessons(league: string, limit = 3): string[] {
  return (notesMemo?.general ?? []).filter((g) => g.league === league).slice(-limit).map((g) => `${g.day} : ${g.lesson}`);
}

export async function saveNotes(): Promise<void> {
  if (!notesMemo) return;
  await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(notesMemo)).catch(() => {});
}
