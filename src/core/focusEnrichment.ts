// Couche d'enrichissement réservée aux matchs des ligues sur lesquelles
// l'utilisateur joue réellement. Deux moteurs, appelés seulement si leur
// budget de la journée le permet :
//
//   1. Gemini + recherche Google (gratuit avec la clé déjà reliée) : compos,
//      absences, actualité, tendance arbitre.
//   2. Omniroute (agents configurés par l'utilisateur, hors Claude) : lecture
//      qualitative du contexte, en complément.
//
// Les notes récoltées alimentent le prompt des agents ET le moteur de combos
// en cours de match. Budget épuisé = on passe, jamais de blocage ni de retry.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { fetchGoogleSearchContext } from './gemini';
import { askOmnirouteLight } from './omniroute';
import { OmnirouteConfig } from '../types';
import { DEFAULT_OMNIROUTE_CONFIG } from './omniroute';
import { spendBudget } from './requestBudget';
import { getStoredUniverse } from './matchUniverse';
import { FocusNote, readFocusNotes, readLearnedModel, writeFocusNotes } from './learnStore';

const GEMINI_KEY_STORAGE = 'app-adlane.gemini-api-key';
const OMNIROUTE_CONFIG_KEY = '@omniroute_config';

/** Nombre de matchs enrichis par tour : l'enrichissement coûte cher en tokens. */
const MAX_MATCHES_PER_TICK = 3;
/** Fenêtre d'enrichissement autour du coup d'envoi (minutes). */
const ENRICH_FROM_MINUTES_BEFORE = 180;
const ENRICH_UNTIL_MINUTES_AFTER = 60;
/** Un match n'est ré-enrichi qu'au-delà de ce délai. */
const REFRESH_AFTER_MINUTES = 120;

export async function loadOmnirouteConfig(): Promise<OmnirouteConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(OMNIROUTE_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.enabled || !parsed.endpoint || !parsed.selectedModel) return null;
    return { ...DEFAULT_OMNIROUTE_CONFIG, ...parsed };
  } catch {
    return null;
  }
}

function isWithinEnrichWindow(kickoffUtc: string): boolean {
  const kickoff = new Date(kickoffUtc).getTime();
  if (!Number.isFinite(kickoff)) return false;
  const minutesToKickoff = (kickoff - Date.now()) / 60_000;
  return minutesToKickoff <= ENRICH_FROM_MINUTES_BEFORE && minutesToKickoff >= -ENRICH_UNTIL_MINUTES_AFTER;
}

/**
 * Enrichit quelques matchs suivis. Appelé à chaque tour de fond ; ne fait rien
 * si aucun match des ligues jouées n'est dans la fenêtre, ou si les budgets
 * IA du jour sont déjà consommés.
 */
export async function enrichFocusMatches(): Promise<number> {
  const model = readLearnedModel();
  const focusLeagues = new Set((model?.focusLeagues ?? []).map((l) => l.toLowerCase()));
  if (focusLeagues.size === 0) return 0;

  const universe = await getStoredUniverse();
  if (!universe || universe.length === 0) return 0;

  const notes = readFocusNotes();
  const lastSeen = new Map<number, number>();
  for (const note of notes) {
    lastSeen.set(note.fixtureId, new Date(note.collectedAt).getTime());
  }

  const candidates = universe
    .filter((m) => focusLeagues.has(m.league.toLowerCase()))
    .filter((m) => isWithinEnrichWindow(m.kickoff_utc))
    .filter((m) => {
      const seen = lastSeen.get(m.fixtureId);
      return !seen || Date.now() - seen > REFRESH_AFTER_MINUTES * 60_000;
    })
    .slice(0, MAX_MATCHES_PER_TICK);

  if (candidates.length === 0) return 0;

  const geminiKey = await SecureStore.getItemAsync(GEMINI_KEY_STORAGE);
  const omnirouteConfig = await loadOmnirouteConfig();
  const collected: FocusNote[] = [];

  for (const match of candidates) {
    const note: FocusNote = {
      fixtureId: match.fixtureId,
      league: match.league,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      collectedAt: new Date().toISOString(),
    };

    // 1) Gemini + recherche Google : faits vérifiables et datés.
    if (geminiKey && (await spendBudget('gemini'))) {
      try {
        const { contextText, sources } = await fetchGoogleSearchContext(
          match.homeTeam,
          match.awayTeam,
          geminiKey
        );
        if (contextText) {
          note.googleContext = contextText;
          note.googleSources = sources;
        }
      } catch (error: any) {
        console.warn('[Enrichissement] Gemini/Google indisponible:', error.message);
      }
    }

    // 2) Omniroute : lecture qualitative par les agents configurés.
    if (omnirouteConfig && (await spendBudget('omniroute'))) {
      try {
        const result = await askOmnirouteLight(
          "Tu es un analyste football. Réponds en français, en 5 puces factuelles maximum. " +
            "Aucun conseil de mise, aucune certitude : uniquement des éléments de contexte " +
            "vérifiables (forme, absences, style de jeu, tendance corners/cartons, arbitre). " +
            "Si tu ne sais pas, dis-le plutôt que d'inventer.",
          `Contexte utile avant ${match.homeTeam} vs ${match.awayTeam} (${match.league}) ?` +
            (note.googleContext ? `\n\nFaits déjà collectés :\n${note.googleContext}` : ''),
          omnirouteConfig
        );
        if (result) {
          note.omnirouteContext = result.text;
          note.omnirouteAgent = result.model;
        }
      } catch (error: any) {
        console.warn('[Enrichissement] Omniroute indisponible:', error.message);
      }
    }

    if (note.googleContext || note.omnirouteContext) collected.push(note);
  }

  if (collected.length > 0) writeFocusNotes([...notes, ...collected]);
  return collected.length;
}

/** Note d'enrichissement la plus récente pour un match donné. */
export function getFocusNote(fixtureId: number): FocusNote | null {
  const notes = readFocusNotes().filter((n) => n.fixtureId === fixtureId);
  if (notes.length === 0) return null;
  return notes.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
}

/** Bloc de contexte prêt à injecter dans un prompt (null si rien de collecté). */
export function renderFocusNote(note: FocusNote | null): string | null {
  if (!note) return null;

  const parts: string[] = [];
  if (note.googleContext) parts.push(`Recherche Google (Gemini) :\n${note.googleContext}`);
  if (note.omnirouteContext) {
    parts.push(`Lecture agent Omniroute (${note.omnirouteAgent}) :\n${note.omnirouteContext}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}
