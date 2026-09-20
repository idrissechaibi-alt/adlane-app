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
import { askOmnirouteLight } from './omniroute';
import { syntheticFixtureId } from './halftimeMonitor';

const PROGRAM_KEY_PREFIX = '@fictional_program_';
const CHECKED_KEY_PREFIX = '@fictional_checked_';

/** Volume visé par jour (demande explicite). */
export const MAX_FICTIONAL_MATCHES_PER_DAY = 250;
/** Garde-fou par pays : au-delà, la réponse est probablement bavarde plutôt
 * que réellement exhaustive — on tronque sans bloquer. */
const MAX_MATCHES_PER_COUNTRY = 60;

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

/** Calendrier du jour d'un pays, toutes divisions — une requête Omniroute. */
async function fetchCountryFixtures(
  config: OmnirouteConfig,
  country: string,
  dateKey: string
): Promise<FictionalMatch[]> {
  let result: { text: string; model: string } | null;
  try {
    result = await askOmnirouteLight(
      'Tu es un outil de lecture de CALENDRIER de football, comme la page "matchs du jour" de Flashscore. ' +
        "Réponds UNIQUEMENT par un JSON strict, sans texte autour. N'INVENTE RIEN : ne liste que des " +
        'rencontres réellement programmées à cette date, avec leur heure de coup d\'envoi en UTC. ' +
        "Si tu n'es pas sûr d'une rencontre ou de son horaire, ne l'inclus pas.",
      `Liste les matchs de football programmés le ${dateKey} en ${country}.\n` +
        'Prends TOUTES les divisions disponibles : élite, 2e, 3e, 4e division, coupes nationales, ' +
        'ET les catégories jeunes et réserves (U19, U20, U21, équipes B).\n' +
        'Réponds avec ce JSON exact, sans rien autour :\n' +
        '{"matches": [{"home_team": string, "away_team": string, "competition": string, "kickoff_utc": "YYYY-MM-DDTHH:MM:SSZ"}]}\n' +
        'Tableau vide si tu ne trouves aucune rencontre confirmée ce jour-là dans ce pays.',
      config
    );
  } catch (error: any) {
    console.warn(`[Programme fictif] ${country} indisponible:`, error.message);
    return [];
  }
  if (!result) return [];

  let parsed: any;
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result.text);
  } catch {
    return [];
  }

  const raw: any[] = Array.isArray(parsed.matches) ? parsed.matches : [];
  const matches: FictionalMatch[] = [];

  for (const m of raw.slice(0, MAX_MATCHES_PER_COUNTRY)) {
    const homeTeam = typeof m.home_team === 'string' ? m.home_team.trim() : '';
    const awayTeam = typeof m.away_team === 'string' ? m.away_team.trim() : '';
    const kickoff = typeof m.kickoff_utc === 'string' ? m.kickoff_utc.trim() : '';
    if (!homeTeam || !awayTeam || !kickoff) continue;
    // Un horaire illisible rend le match inexploitable (on ne saurait pas
    // quand aller le regarder) : mieux vaut l'écarter que de le suivre au
    // hasard.
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

  return matches;
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

/**
 * Construit (ou relit) le programme fictif du jour. Idempotent : une fois
 * construit et non vide, aucun nouvel appel Omniroute de la journée. Un
 * programme vide n'est jamais mis en cache comme définitif — il sera
 * retenté au tour suivant (Omniroute momentanément injoignable ne doit pas
 * condamner la journée entière).
 */
export async function ensureFictionalDailyProgram(
  config: OmnirouteConfig,
  date: string = todayKey()
): Promise<FictionalMatch[]> {
  const cached = await readFictionalProgram(date);
  if (cached && cached.length > 0) return cached;

  const byCountry = new Map<string, FictionalMatch[]>();
  for (const country of FICTIONAL_COUNTRIES) {
    const matches = await fetchCountryFixtures(config, country, date);
    if (matches.length > 0) byCountry.set(country, matches);
  }

  // Dédoublonnage inter-pays : une même rencontre annoncée dans deux
  // réponses (coupe européenne, erreur de rattachement) ne doit être suivie
  // qu'une fois.
  const seen = new Set<number>();
  for (const [country, matches] of byCountry) {
    byCountry.set(
      country,
      matches.filter((m) => {
        if (seen.has(m.fixtureId)) return false;
        seen.add(m.fixtureId);
        return true;
      })
    );
  }

  const program = selectBalanced(byCountry, MAX_FICTIONAL_MATCHES_PER_DAY);
  if (program.length === 0) return [];

  await AsyncStorage.setItem(programKey(date), JSON.stringify(program));
  return program;
}
