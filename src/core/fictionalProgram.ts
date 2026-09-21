// Programme du jour de la boucle FICTIVE — 100 % Omniroute, zéro API payante.
//
// Une seule construction par jour (au premier tour après minuit) : Omniroute
// balaie pays par pays le calendrier du jour, TOUTES divisions confondues
// (élite, D2, D3..., et catégories jeunes U19/U20/U21/réserves), et renvoie
// les horaires de coup d'envoi. On en retient MAX_FICTIONAL_MATCHES_PER_DAY,
// répartis équitablement entre pays plutôt que concentrés sur les deux ou
// trois plus fournis.
//
// À quoi sert l'horaire : connaître le coup d'envoi suffit à savoir QUAND
// aller regarder un match (20e puis 60e minute) — plus besoin d'un relevé
// "tous les matchs en direct maintenant" côté fictif, ni donc d'API-Football.
// Le programme est la colonne vertébrale du pipeline fictif : sans lui, la
// boucle n'a aucun match à suivre.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { OmnirouteConfig } from '../types';
import { askOmnirouteUsable } from './omniroute';
import { syntheticFixtureId } from './halftimeMonitor';

const PROGRAM_KEY_PREFIX = '@fictional_program_';
const CHECKED_KEY_PREFIX = '@fictional_checked_';

/** Volume visé par jour (demande explicite). */
export const MAX_FICTIONAL_MATCHES_PER_DAY = 250;
/** Garde-fou par pays : au-delà, la réponse est probablement bavarde plutôt
 * que réellement exhaustive — on tronque sans bloquer. */
const MAX_MATCHES_PER_COUNTRY = 60;
/** Pays balayés par tour : chaque pays coûte au moins une requête d'agent
 * (plusieurs si les premiers ne ramènent rien), donc un tour doit rester
 * court — le programme se complète sur les tours suivants. */
const MAX_COUNTRIES_PER_RUN = 4;

/** 20 pays européens, toutes leurs divisions et catégories d'âge. */
export const FICTIONAL_COUNTRIES = [
  'Angleterre', 'Espagne', 'Italie', 'Allemagne', 'France',
  'Portugal', 'Pays-Bas', 'Belgique', 'Écosse', 'Turquie',
  'Grèce', 'Suisse', 'Autriche', 'Danemark', 'Norvège',
  'Suède', 'Pologne', 'République tchèque', 'Croatie', 'Serbie',
];

export interface FictionalMatch {
  /** Identifiant synthétique stable (aucun identifiant officiel ici). */
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  country: string;
  kickoff_utc: string;
}

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

function programKey(date: string): string {
  return `${PROGRAM_KEY_PREFIX}${date}`;
}

export async function readFictionalProgram(date: string = todayKey()): Promise<FictionalMatch[] | null> {
  try {
    const raw = await AsyncStorage.getItem(programKey(date));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Checkpoints déjà consommés (`${fixtureId}-${kind}`). Sans cette mémoire, un
 * match dont aucune jambe n'atteint le seuil serait réinterrogé à chaque tour
 * tant qu'il reste dans sa fenêtre — jusqu'à cinq requêtes Omniroute pour
 * une décision déjà prise.
 */
export async function readCheckedCheckpoints(date: string = todayKey()): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(`${CHECKED_KEY_PREFIX}${date}`);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set<string>();
  }
}

export async function writeCheckedCheckpoints(checked: Set<string>, date: string = todayKey()): Promise<void> {
  try {
    await AsyncStorage.setItem(`${CHECKED_KEY_PREFIX}${date}`, JSON.stringify([...checked]));
  } catch {
    // mémoire best-effort : au pire on réinterroge, jamais bloquant
  }
}

/**
 * Extrait une liste de rencontres d'une réponse d'agent. Tolérant sur la
 * forme (tableau nu, ou objet sous "matches"/"fixtures"/"games") parce que
 * les agents d'un déploiement Omniroute ne répondent pas tous pareil — mais
 * strict sur le fond : une rencontre sans équipes ou sans horaire lisible est
 * inexploitable (on ne saurait pas quand aller la regarder).
 *
 * Renvoie null quand la réponse n'apporte RIEN : c'est ce qui fait passer la
 * ronde à l'agent suivant (askOmnirouteUsable) plutôt que d'accepter le vide
 * d'un agent sans outil de navigation.
 */
function extractFixtures(text: string, country: string, dateKey: string): FictionalMatch[] | null {
  let parsed: any;
  try {
    const jsonMatch = text.match(/[[{][\s\S]*[\]}]/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    return null;
  }

  const raw: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.matches) ? parsed.matches
    : Array.isArray(parsed?.fixtures) ? parsed.fixtures
    : Array.isArray(parsed?.games) ? parsed.games
    : [];

  const matches: FictionalMatch[] = [];
  for (const m of raw.slice(0, MAX_MATCHES_PER_COUNTRY)) {
    const homeTeam = typeof m?.home_team === 'string' ? m.home_team.trim() : '';
    const awayTeam = typeof m?.away_team === 'string' ? m.away_team.trim() : '';
    const kickoff = typeof m?.kickoff_utc === 'string' ? m.kickoff_utc.trim() : '';
    if (!homeTeam || !awayTeam || !kickoff) continue;
    if (!Number.isFinite(Date.parse(kickoff))) continue;

    matches.push({
      fixtureId: syntheticFixtureId(homeTeam, awayTeam, dateKey),
      homeTeam,
      awayTeam,
      league: typeof m.competition === 'string' && m.competition.trim() ? m.competition.trim() : `${country} (division inconnue)`,
      country,
      kickoff_utc: kickoff,
    });
  }

  return matches.length > 0 ? matches : null;
}

/** Calendrier du jour d'un pays, toutes divisions — une requête Omniroute,
 * relancée sur l'agent suivant tant qu'aucun n'a ramené de rencontre. */
async function fetchCountryFixtures(
  config: OmnirouteConfig,
  country: string,
  dateKey: string
): Promise<FictionalMatch[]> {
  try {
    const result = await askOmnirouteUsable(
      'Tu es un outil de lecture de CALENDRIER de football, comme la page "matchs du jour" de Flashscore. ' +
        'Tu as accès à Internet : consulte une source de calendrier fiable avant de répondre. ' +
        "Réponds UNIQUEMENT par un JSON strict, sans texte autour. N'INVENTE RIEN : ne liste que des " +
        'rencontres réellement programmées à cette date, avec leur heure de coup d\'envoi en UTC.',
      `Liste les matchs de football programmés le ${dateKey} en ${country}.\n` +
        'Prends TOUTES les divisions disponibles : élite, 2e, 3e, 4e division, coupes nationales, ' +
        'ET les catégories jeunes et réserves (U19, U20, U21, équipes B).\n' +
        'Réponds avec ce JSON exact, sans rien autour :\n' +
        '{"matches": [{"home_team": string, "away_team": string, "competition": string, "kickoff_utc": "YYYY-MM-DDTHH:MM:SSZ"}]}',
      config,
      (text) => extractFixtures(text, country, dateKey)
    );
    return result?.value ?? [];
  } catch (error: any) {
    console.warn(`[Programme fictif] ${country} indisponible:`, error.message);
    return [];
  }
}

/**
 * Sélection équitable : on prend un match à tour de rôle dans chaque pays
 * jusqu'à la limite, plutôt que de remplir le quota avec les premiers pays
 * balayés. Un corpus d'apprentissage concentré sur 3 championnats mesurerait
 * surtout les particularités de ces 3 championnats.
 */
function selectBalanced(byCountry: Map<string, FictionalMatch[]>, limit: number): FictionalMatch[] {
  const queues = Array.from(byCountry.values()).map((list) =>
    [...list].sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc))
  );
  const selected: FictionalMatch[] = [];

  for (let round = 0; selected.length < limit; round++) {
    let addedThisRound = 0;
    for (const queue of queues) {
      if (round >= queue.length) continue;
      selected.push(queue[round]);
      addedThisRound++;
      if (selected.length >= limit) break;
    }
    if (addedThisRound === 0) break; // toutes les files épuisées
  }

  return selected.sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
}

interface StoredProgram {
  date: string;
  /** Rencontres retenues, par pays déjà balayé. */
  byCountry: Record<string, FictionalMatch[]>;
  /** Pays déjà interrogés aujourd'hui (même s'ils n'ont rien donné). */
  doneCountries: string[];
}

async function readStoredProgram(date: string): Promise<StoredProgram> {
  try {
    const raw = await AsyncStorage.getItem(programKey(date));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.byCountry && Array.isArray(parsed.doneCountries)) return parsed;
  } catch {
    // stockage illisible : on repart d'un programme vide plutôt que de planter
  }
  return { date, byCountry: {}, doneCountries: [] };
}

export interface FictionalProgramStatus {
  matches: number;
  countriesDone: number;
  countriesTotal: number;
}

export async function getFictionalProgramStatus(date: string = todayKey()): Promise<FictionalProgramStatus> {
  const stored = await readStoredProgram(date);
  return {
    matches: Object.values(stored.byCountry).reduce((sum, list) => sum + list.length, 0),
    countriesDone: stored.doneCountries.length,
    countriesTotal: FICTIONAL_COUNTRIES.length,
  };
}

/**
 * Construit (ou complète) le programme fictif du jour, puis renvoie la
 * sélection courante.
 *
 * Construction INCRÉMENTALE : quelques pays par tour seulement. Balayer les
 * 20 pays d'un coup, c'est 20 requêtes d'agent à la suite — plusieurs minutes
 * pendant lesquelles le tour entier est bloqué (et l'utilisateur qui vient
 * d'appuyer sur play attend devant un écran figé). Le programme se remplit
 * donc sur les premiers tours de la journée, et devient exploitable dès le
 * premier pays qui répond.
 *
 * Un pays interrogé est marqué comme fait même s'il n'a rien donné : sans ça,
 * les pays sans matchs du jour seraient réinterrogés indéfiniment et les
 * suivants jamais atteints.
 */
export async function ensureFictionalDailyProgram(
  config: OmnirouteConfig,
  date: string = todayKey(),
  maxCountriesPerRun: number = MAX_COUNTRIES_PER_RUN
): Promise<FictionalMatch[]> {
  const stored = await readStoredProgram(date);
  const done = new Set(stored.doneCountries);
  const pending = FICTIONAL_COUNTRIES.filter((c) => !done.has(c));

  for (const country of pending.slice(0, maxCountriesPerRun)) {
    const matches = await fetchCountryFixtures(config, country, date);
    if (matches.length > 0) stored.byCountry[country] = matches;
    stored.doneCountries.push(country);
  }

  if (pending.length > 0) {
    await AsyncStorage.setItem(programKey(date), JSON.stringify(stored));
  }

  // Dédoublonnage inter-pays : une même rencontre annoncée dans deux réponses
  // (coupe européenne, erreur de rattachement) ne doit être suivie qu'une fois.
  const seen = new Set<number>();
  const byCountry = new Map<string, FictionalMatch[]>();
  for (const [country, matches] of Object.entries(stored.byCountry)) {
    byCountry.set(
      country,
      matches.filter((m) => {
        if (seen.has(m.fixtureId)) return false;
        seen.add(m.fixtureId);
        return true;
      })
    );
  }

  return selectBalanced(byCountry, MAX_FICTIONAL_MATCHES_PER_DAY);
}
