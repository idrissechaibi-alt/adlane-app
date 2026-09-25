// Planning du jour de la boucle FICTIVE — les matchs à suivre et leurs
// horaires. C'est la colonne vertébrale du pipeline fictif : sans lui, la
// boucle n'a aucun match à suivre.
//
// TROIS sources, dans cet ordre :
//
//   1. Le planning TRANSMIS (data/programme-du-jour/<date>.json dans le
//      dépôt), préparé chaque matin en dehors de l'application.
//   2. Sportmonks (/fixtures/date/{date}) — calendrier MONDIAL de la date en
//      un flux de données structuré, découverte PRIMAIRE en l'absence de
//      planning transmis. Remplace le balayage Omniroute pays-par-pays sur
//      ce point précis : plus de "circuit breaker" possible puisqu'il n'y a
//      plus d'agent de recherche dans la boucle.
//   3. À défaut seulement (clé Sportmonks absente, quota épuisé, ou pays que
//      Sportmonks n'a pas couverts ce jour-là), un balayage du calendrier par
//      les agents Omniroute, pays par pays — dernier recours (demande
//      explicite), plus filet de sécurité que source normale désormais.
//
// Dans tous les cas, Omniroute garde ensuite le travail qu'il fait bien :
// suivre match par match des rencontres déjà connues (score, tirs, corners,
// cartons) et appliquer le protocole 20e/60e minute — ce fichier ne fait que
// construire la LISTE des matchs à surveiller, jamais leur suivi en direct.
//
// À quoi sert l'horaire : connaître le coup d'envoi suffit à savoir QUAND
// surveiller un match, sans dépendre d'un relevé "tous les matchs en direct
// maintenant" ni d'API-Football.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { OmnirouteConfig } from '../types';
import { OmnirouteAttempt, askOmnirouteUsable, attemptsAllFailed } from './omniroute';
import { syntheticFixtureId } from './halftimeMonitor';
import { fetchRepoJson } from './gitAutoSync';
import { mapWithConcurrency } from './concurrency';
import { fetchSportmonksFixturesByDate } from '../api/footballDataAPIs/sportmonks';
import { spendBudget } from './requestBudget';
import { getAPIConfig } from '../api/multiAPIManager';

const PROGRAM_KEY_PREFIX = '@fictional_program_';
const CHECKED_KEY_PREFIX = '@fictional_checked_';
const TIMELINE_KEY_PREFIX = '@fictional_timeline_';
/** Clé sous laquelle le planning transmis est rangé, à part des pays balayés
 * par les agents : il a sa propre provenance et ses propres règles. */
const FEED_SOURCE_KEY = '__transmis__';

/** Volume visé par jour (demande explicite). */
export const MAX_FICTIONAL_MATCHES_PER_DAY = 250;
/** Garde-fou par pays : au-delà, la réponse est probablement bavarde plutôt
 * que réellement exhaustive — on tronque sans bloquer. */
const MAX_MATCHES_PER_COUNTRY = 60;
/** Pays balayés par tour : chaque pays coûte au moins une requête d'agent
 * (plusieurs si les premiers ne ramènent rien), donc un tour doit rester
 * court — le programme se complète sur les tours suivants. */
const MAX_COUNTRIES_PER_RUN = 6;
/** Essais accordés à un pays par passe de balayage : une réponse vide vient
 * plus souvent d'un agent qui n'a pas su chercher que d'un pays sans match. */
const MAX_ATTEMPTS_PER_COUNTRY = 3;
/** Pays interrogés simultanément pendant un balayage : assez pour accélérer
 * nettement (25 candidats à concurrence 6 ~ 4-5x plus vite qu'en séquentiel),
 * assez peu pour ne pas saturer un serveur Omniroute auto-hébergé. */
const COUNTRY_SWEEP_CONCURRENCY = 6;
/** Périodicité de reprise du balayage : toutes les heures, les pays sans match
 * à venir connu sont réinterrogés, pour que le planning suive les annonces de
 * la journée au lieu de figer celle du premier tour. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Pays balayés, toutes divisions et catégories d'âge confondues. Couverture
 * large volontairement : le corpus d'apprentissage gagne à voir des contextes
 * de jeu très différents (rythmes, arbitrage, nombre de buts), pas seulement
 * les grands championnats européens. Les fuseaux asiatiques ont en plus le bon
 * goût de jouer quand l'Europe dort — la boucle tourne donc aussi la nuit.
 */
export const FICTIONAL_COUNTRIES = [
  // Europe de l'Ouest et du Sud
  'Angleterre', 'Écosse', 'Pays de Galles', 'Irlande', 'Irlande du Nord',
  'Espagne', 'Portugal', 'France', 'Italie', 'Allemagne',
  'Autriche', 'Suisse', 'Pays-Bas', 'Belgique', 'Grèce', 'Chypre',
  // Europe du Nord
  'Danemark', 'Norvège', 'Suède', 'Finlande', 'Islande',
  // Europe centrale et de l'Est
  'Pologne', 'République tchèque', 'Slovaquie', 'Hongrie', 'Roumanie',
  'Bulgarie', 'Croatie', 'Serbie', 'Slovénie', 'Bosnie-Herzégovine',
  'Ukraine', 'Russie', 'Turquie', 'Israël',
  // Asie et Océanie
  'Japon', 'Corée du Sud', 'Chine', 'Arabie saoudite', 'Qatar',
  'Émirats arabes unis', 'Iran', 'Irak', 'Ouzbékistan', 'Inde',
  'Thaïlande', 'Vietnam', 'Indonésie', 'Malaisie', 'Australie',
  // Amériques
  'Brésil', 'Argentine', 'Mexique', 'États-Unis', 'Colombie',
  'Chili', 'Uruguay', 'Pérou', 'Équateur', 'Paraguay',
];

export interface FictionalMatch {
  /** Identifiant synthétique stable (aucun identifiant officiel ici). */
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  country: string;
  kickoff_utc: string;
  /** D'où vient cette rencontre — absent pour le planning transmis (déjà
   * distingué par sa propre clé de stockage). Sert uniquement au diagnostic
   * affiché (quelle source alimente réellement le programme du jour). */
  source?: 'sportmonks' | 'omniroute';
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
 * Un relevé d'un match à un instant donné. Le suivi commence au COUP D'ENVOI
 * et se poursuit jusqu'au checkpoint : au moment de pronostiquer, on ne
 * dispose donc pas d'une photo isolée mais de l'évolution réelle de la
 * rencontre (rythme des corners, montée en puissance des tirs, score qui
 * bouge). Deux relevés valent bien mieux qu'un seul : un match à 4 corners
 * dont 3 dans les cinq dernières minutes ne se projette pas comme un match à
 * 4 corners répartis depuis le début.
 */
export interface MatchSample {
  ts: string;
  minute: number;
  statusShort: string;
  homeGoals: number;
  awayGoals: number;
  shotsOnTargetHome?: number;
  shotsOnTargetAway?: number;
  cornersTotal?: number;
  cardsTotal?: number;
}

export async function readMatchTimelines(date: string = todayKey()): Promise<Record<number, MatchSample[]>> {
  try {
    const raw = await AsyncStorage.getItem(`${TIMELINE_KEY_PREFIX}${date}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function writeMatchTimelines(
  timelines: Record<number, MatchSample[]>,
  date: string = todayKey()
): Promise<void> {
  try {
    await AsyncStorage.setItem(`${TIMELINE_KEY_PREFIX}${date}`, JSON.stringify(timelines));
  } catch {
    // suivi best-effort : perdre un relevé dégrade la finesse, ne casse rien
  }
}

/** Emplacement, dans le dépôt, du planning préparé chaque matin hors de
 * l'app. Un fichier par jour : pas de conflit avec la sauvegarde
 * quotidienne, et l'historique reste lisible. */
function feedPath(date: string): string {
  return `data/programme-du-jour/${date}.json`;
}

interface TransmittedProgram {
  date: string;
  generatedAt?: string;
  matches: Array<{
    home_team: string;
    away_team: string;
    competition?: string;
    country?: string;
    kickoff_utc: string;
  }>;
}

/**
 * Planning transmis à l'app : liste des matchs du jour avec leurs horaires,
 * préparée le matin même en dehors de l'application puis déposée dans le
 * dépôt.
 *
 * Pourquoi hors de l'app : lire un calendrier complet demande de vraies
 * recherches web, et les agents Omniroute du téléphone n'y arrivent pas de
 * façon fiable (fournisseurs de recherche en panne, agents sans accès
 * Internet). Préparer la liste à l'extérieur et la déposer ici met le
 * planning à l'abri de ces aléas ; Omniroute n'a plus qu'à appliquer le
 * protocole de suivi sur des matchs déjà connus, ce qu'il fait match par
 * match — une tâche bien plus simple qu'un balayage de calendrier.
 */
async function loadTransmittedProgram(date: string): Promise<FictionalMatch[] | null> {
  const payload = await fetchRepoJson<TransmittedProgram>(feedPath(date));
  if (!payload || !Array.isArray(payload.matches)) return null;

  const matches: FictionalMatch[] = [];
  for (const m of payload.matches) {
    const homeTeam = typeof m?.home_team === 'string' ? m.home_team.trim() : '';
    const awayTeam = typeof m?.away_team === 'string' ? m.away_team.trim() : '';
    const kickoff = typeof m?.kickoff_utc === 'string' ? m.kickoff_utc.trim() : '';
    if (!homeTeam || !awayTeam || !kickoff) continue;
    if (!Number.isFinite(Date.parse(kickoff))) continue;

    matches.push({
      fixtureId: syntheticFixtureId(homeTeam, awayTeam, date),
      homeTeam,
      awayTeam,
      league: m.competition?.trim() || 'Compétition inconnue',
      country: m.country?.trim() || 'Inconnu',
      kickoff_utc: kickoff,
    });
  }

  return matches.length > 0 ? matches.slice(0, MAX_FICTIONAL_MATCHES_PER_DAY) : null;
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
      source: 'omniroute',
    });
  }

  return matches.length > 0 ? matches : null;
}

/** Alias anglais (tels que renvoyés par Sportmonks) vers le libellé français
 * canonique utilisé dans FICTIONAL_COUNTRIES. Plusieurs alias possibles par
 * pays : les fournisseurs de données n'orthographient pas tous pareil (ex.
 * "Czech Republic" vs "Czechia"). Un pays absent de cette table n'est pas
 * retenu depuis Sportmonks (hors périmètre choisi), mais reste éligible au
 * balayage Omniroute si jamais il y figurait par erreur. */
const SPORTMONKS_COUNTRY_ALIASES: Record<string, string[]> = {
  'Angleterre': ['England'],
  'Écosse': ['Scotland'],
  'Pays de Galles': ['Wales'],
  'Irlande': ['Republic of Ireland', 'Ireland'],
  'Irlande du Nord': ['Northern Ireland'],
  'Espagne': ['Spain'],
  'Portugal': ['Portugal'],
  'France': ['France'],
  'Italie': ['Italy'],
  'Allemagne': ['Germany'],
  'Autriche': ['Austria'],
  'Suisse': ['Switzerland'],
  'Pays-Bas': ['Netherlands'],
  'Belgique': ['Belgium'],
  'Grèce': ['Greece'],
  'Chypre': ['Cyprus'],
  'Danemark': ['Denmark'],
  'Norvège': ['Norway'],
  'Suède': ['Sweden'],
  'Finlande': ['Finland'],
  'Islande': ['Iceland'],
  'Pologne': ['Poland'],
  'République tchèque': ['Czech Republic', 'Czechia'],
  'Slovaquie': ['Slovakia'],
  'Hongrie': ['Hungary'],
  'Roumanie': ['Romania'],
  'Bulgarie': ['Bulgaria'],
  'Croatie': ['Croatia'],
  'Serbie': ['Serbia'],
  'Slovénie': ['Slovenia'],
  'Bosnie-Herzégovine': ['Bosnia and Herzegovina'],
  'Ukraine': ['Ukraine'],
  'Russie': ['Russia'],
  'Turquie': ['Turkey', 'Türkiye'],
  'Israël': ['Israel'],
  'Japon': ['Japan'],
  'Corée du Sud': ['South Korea', 'Korea Republic'],
  'Chine': ['China', 'China PR'],
  'Arabie saoudite': ['Saudi Arabia'],
  'Qatar': ['Qatar'],
  'Émirats arabes unis': ['United Arab Emirates'],
  'Iran': ['Iran'],
  'Irak': ['Iraq'],
  'Ouzbékistan': ['Uzbekistan'],
  'Inde': ['India'],
  'Thaïlande': ['Thailand'],
  'Vietnam': ['Vietnam'],
  'Indonésie': ['Indonesia'],
  'Malaisie': ['Malaysia'],
  'Australie': ['Australia'],
  'Brésil': ['Brazil'],
  'Argentine': ['Argentina'],
  'Mexique': ['Mexico'],
  'États-Unis': ['United States', 'USA'],
  'Colombie': ['Colombia'],
  'Chili': ['Chile'],
  'Uruguay': ['Uruguay'],
  'Pérou': ['Peru'],
  'Équateur': ['Ecuador'],
  'Paraguay': ['Paraguay'],
};

const SPORTMONKS_ENGLISH_TO_FRENCH_COUNTRY = new Map<string, string>();
for (const [french, aliases] of Object.entries(SPORTMONKS_COUNTRY_ALIASES)) {
  for (const alias of aliases) SPORTMONKS_ENGLISH_TO_FRENCH_COUNTRY.set(alias.toLowerCase(), french);
}

/** Pages Sportmonks à lire au maximum pour une date : garde-fou contre une
 * pagination qui ne se terminerait jamais, pas un plafond qu'on s'attend à
 * atteindre (quelques pages suffisent pour couvrir les 60 pays visés). */
const MAX_SPORTMONKS_PAGES_PER_FETCH = 40;

/**
 * Calendrier mondial du jour lu directement chez Sportmonks (une date, tous
 * pays et divisions couverts) — remplace le balayage pays-par-pays par agent
 * comme découverte PRIMAIRE : un flux de données structuré, donc plus de
 * "circuit breaker" possible. Ne garde que les pays de FICTIONAL_COUNTRIES
 * (les autres élargiraient le corpus sans qu'on les ait choisis).
 *
 * Chaque page coûte une requête de quota (spendBudget) : la boucle s'arrête
 * dès que le budget du jour est épuisé, avec ce qui a déjà été lu — jamais
 * bloquant, jamais une erreur remontée à l'appelant (au pire la Map est
 * partielle ou vide, et le balayage Omniroute prend le relais pour les pays
 * manquants).
 */
async function fetchWorldFixturesViaSportmonks(
  apiToken: string,
  dateKey: string
): Promise<Map<string, FictionalMatch[]>> {
  const byCountry = new Map<string, FictionalMatch[]>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_SPORTMONKS_PAGES_PER_FETCH; page++) {
    if (!(await spendBudget('sportmonks'))) break; // quota du jour épuisé

    let result;
    try {
      result = await fetchSportmonksFixturesByDate(apiToken, dateKey, cursor);
    } catch (error: any) {
      console.warn('[Programme fictif] Sportmonks indisponible:', error?.message);
      break;
    }

    for (const fixture of result.fixtures) {
      const french = SPORTMONKS_ENGLISH_TO_FRENCH_COUNTRY.get(fixture.country.toLowerCase());
      if (!french) continue; // pays hors périmètre FICTIONAL_COUNTRIES

      const list = byCountry.get(french) ?? [];
      if (list.length >= MAX_MATCHES_PER_COUNTRY) continue;
      list.push({
        fixtureId: syntheticFixtureId(fixture.homeTeam, fixture.awayTeam, dateKey),
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        league: fixture.league,
        country: french,
        kickoff_utc: fixture.kickoffUtc,
        source: 'sportmonks',
      });
      byCountry.set(french, list);
    }

    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  return byCountry;
}

/** Calendrier du jour d'un pays, toutes divisions — une requête Omniroute,
 * relancée sur l'agent suivant tant qu'aucun n'a ramené de rencontre. */
async function fetchCountryFixtures(
  config: OmnirouteConfig,
  country: string,
  dateKey: string,
  trace?: OmnirouteAttempt[]
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
      (text) => extractFixtures(text, country, dateKey),
      trace,
      true // calendrier du jour : seuls les agents capables de chercher peuvent répondre
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
  /** Nombre de tentatives par pays aujourd'hui. */
  attempts: Record<string, number>;
  /** Ce que les agents ont répondu au dernier pays interrogé — conservé pour
   * pouvoir montrer POURQUOI un balayage ne ramène rien (refus, prose hors
   * format, agent sans accès Internet, endpoint injoignable...) au lieu
   * d'afficher un 0 sans explication. */
  lastTrace?: { country: string; attempts: OmnirouteAttempt[] };
  /** Début de la passe de balayage en cours — voir SWEEP_INTERVAL_MS. */
  sweepStartedAt?: string;
  /** Dernière lecture réussie du planning transmis. */
  feedLoadedAt?: string;
  /** Dernière lecture réussie (même partielle) du calendrier Sportmonks —
   * même rythme de rafraîchissement que le planning transmis. */
  sportmonksLoadedAt?: string;
}

/**
 * Un pays n'est plus interrogé tant qu'on lui connaît un match À VENIR : son
 * planning est déjà fait. Dès que ses matchs connus sont tous joués, il
 * redevient candidat — c'est ce qui fait que le programme continue de se
 * remplir au fil de la journée au lieu de figer la photo du matin.
 */
function hasUpcomingMatch(stored: StoredProgram, country: string, now: number): boolean {
  return (stored.byCountry[country] ?? []).some((m) => Date.parse(m.kickoff_utc) > now);
}

async function readStoredProgram(date: string): Promise<StoredProgram> {
  try {
    const raw = await AsyncStorage.getItem(programKey(date));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.byCountry) {
      if (parsed.attempts) return parsed;
      // Ancien format (liste de pays "faits") : une tentative déjà consommée
      // chacun, donc ceux restés vides gardent droit à un nouvel essai.
      const attempts: Record<string, number> = {};
      for (const country of parsed.doneCountries ?? []) attempts[country] = 1;
      return { date, byCountry: parsed.byCountry, attempts };
    }
  } catch {
    // stockage illisible : on repart d'un programme vide plutôt que de planter
  }
  return { date, byCountry: {}, attempts: {} };
}

/**
 * Pays restant à interroger, les jamais-tentés d'abord. Un pays qui n'a rien
 * donné garde droit à d'autres essais (jusqu'à MAX_ATTEMPTS_PER_COUNTRY) :
 * une réponse vide vient plus souvent d'un agent qui n'a pas su chercher que
 * d'un pays réellement sans match ce jour-là — le marquer définitivement fait
 * du premier coup suffisait à condamner la journée entière.
 */
function pendingCountries(stored: StoredProgram, now: number = Date.now()): string[] {
  const eligible = FICTIONAL_COUNTRIES.filter(
    (c) => !hasUpcomingMatch(stored, c, now) && (stored.attempts[c] ?? 0) < MAX_ATTEMPTS_PER_COUNTRY
  );
  return eligible.sort((a, b) => (stored.attempts[a] ?? 0) - (stored.attempts[b] ?? 0));
}

export interface FictionalProgramStatus {
  matches: number;
  /** true quand le planning vient du fichier transmis, false quand il a été
   * bâti par le balayage de secours. */
  fromFeed: boolean;
  /** Matchs du programme dont le coup d'envoi est encore à venir, et heure du
   * prochain : une nuit sans proposition n'est pas la même chose selon que la
   * boucle n'a rien à suivre ou qu'elle attend le premier coup d'envoi. */
  matchesAhead: number;
  nextKickoffUtc?: string;
  /** Pays interrogés au moins une fois aujourd'hui — l'avancement visible du
   * balayage, et non le nombre de pays définitivement clos (qui resterait à 0
   * tant qu'aucun n'a ni livré de match ni épuisé ses essais). */
  countriesTried: number;
  countriesTotal: number;
  /** Réponses des agents au dernier pays interrogé, pour diagnostic. */
  lastTrace?: { country: string; attempts: OmnirouteAttempt[] };
  /** Répartition par provenance (hors planning transmis) — pour vérifier
   * concrètement que Sportmonks alimente bien le programme plutôt que de
   * deviner à partir du seul décompte total. */
  sportmonksMatches: number;
  omnirouteMatches: number;
}

export async function getFictionalProgramStatus(date: string = todayKey()): Promise<FictionalProgramStatus> {
  const stored = await readStoredProgram(date);
  const all = Object.values(stored.byCountry).flat();
  const now = Date.now();
  const ahead = all
    .filter((m) => Date.parse(m.kickoff_utc) > now)
    .sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));

  return {
    matches: all.length,
    fromFeed: (stored.byCountry[FEED_SOURCE_KEY]?.length ?? 0) > 0,
    matchesAhead: ahead.length,
    nextKickoffUtc: ahead[0]?.kickoff_utc,
    countriesTried: Object.keys(stored.attempts).length,
    countriesTotal: FICTIONAL_COUNTRIES.length,
    lastTrace: stored.lastTrace,
    sportmonksMatches: all.filter((m) => m.source === 'sportmonks').length,
    omnirouteMatches: all.filter((m) => m.source === 'omniroute').length,
  };
}

/**
 * Construit, complète et RAFRAÎCHIT le planning du jour, puis renvoie la
 * sélection courante. Appelée à chaque tour de fond : il n'y a rien à lancer
 * à la main, le planning se tient à jour tout seul.
 *
 * Construction INCRÉMENTALE : quelques pays par tour seulement. Balayer les
 * 60 pays d'un coup, c'est 60 requêtes d'agent à la suite — plusieurs minutes
 * pendant lesquelles le tour entier est bloqué (et l'utilisateur qui vient
 * d'appuyer sur play attend devant un écran figé). Le planning se remplit
 * donc sur les premiers tours, et devient exploitable dès le premier pays qui
 * répond.
 *
 * Rafraîchissement HORAIRE : une fois par heure, les pays sans match à venir
 * connu repassent dans la file. C'est ce qui fait qu'un match annoncé en cours
 * de journée finit par entrer au planning, et qu'une panne d'agents à 8h ne
 * condamne pas la soirée.
 */
export async function ensureFictionalDailyProgram(
  config: OmnirouteConfig | null,
  date: string = todayKey(),
  maxCountriesPerRun: number = MAX_COUNTRIES_PER_RUN
): Promise<FictionalMatch[]> {
  const stored = await readStoredProgram(date);
  const now = Date.now();

  // 1) Planning transmis : la source normale. Relu à chaque tour tant qu'il
  // n'a pas été reçu, et rafraîchi ensuite au rythme des passes — un match
  // ajouté en cours de journée au fichier déposé entre ainsi au planning.
  if (!stored.feedLoadedAt || now - Date.parse(stored.feedLoadedAt) >= SWEEP_INTERVAL_MS) {
    const transmitted = await loadTransmittedProgram(date);
    if (transmitted) {
      const merged = new Map((stored.byCountry[FEED_SOURCE_KEY] ?? []).map((m) => [m.fixtureId, m]));
      for (const match of transmitted) if (!merged.has(match.fixtureId)) merged.set(match.fixtureId, match);
      stored.byCountry[FEED_SOURCE_KEY] = [...merged.values()];
      stored.feedLoadedAt = new Date(now).toISOString();
      await AsyncStorage.setItem(programKey(date), JSON.stringify(stored));
    }
  }

  // 2) Sportmonks / Omniroute : inutiles tous les deux si un planning transmis
  // couvre déjà la journée.
  if ((stored.byCountry[FEED_SOURCE_KEY]?.length ?? 0) > 0) {
    return selectFromStored(stored);
  }

  // 3) Sportmonks — découverte PRIMAIRE en l'absence de planning transmis :
  // un flux de données structuré (calendrier mondial de la date), donc plus
  // de risque de "circuit breaker" côté agents de recherche. Même rythme de
  // rafraîchissement horaire que le planning transmis, pour ne pas reconsommer
  // du quota à chaque tour de 3 minutes.
  const apiConfig = await getAPIConfig();
  if (
    apiConfig.sportmonks &&
    (!stored.sportmonksLoadedAt || now - Date.parse(stored.sportmonksLoadedAt) >= SWEEP_INTERVAL_MS)
  ) {
    const bySportmonksCountry = await fetchWorldFixturesViaSportmonks(apiConfig.sportmonks, date);
    for (const [country, matches] of bySportmonksCountry) {
      // Fusion, jamais remplacement : un match déjà au planning peut être en
      // cours de suivi (checkpoint 20e passé, 60e à venir).
      const merged = new Map((stored.byCountry[country] ?? []).map((m) => [m.fixtureId, m]));
      for (const match of matches) if (!merged.has(match.fixtureId)) merged.set(match.fixtureId, match);
      stored.byCountry[country] = [...merged.values()];
    }
    stored.sportmonksLoadedAt = new Date(now).toISOString();
    await AsyncStorage.setItem(programKey(date), JSON.stringify(stored));
  }

  // 4) Balayage Omniroute — DERNIER RECOURS (demande explicite) : ne sert
  // plus qu'à combler les pays que Sportmonks n'a pas couverts ce jour-là
  // (clé absente, quota épuisé, championnat hors couverture) — pendingCountries
  // exclut déjà tout pays pour lequel Sportmonks vient de trouver un match.
  // Sans configuration Omniroute, cette étape est simplement sautée : le
  // programme reste alimenté par le planning transmis et/ou Sportmonks.
  if (!config) {
    return selectFromStored(stored);
  }

  // Passe horaire : toutes les heures, on rend de nouveau interrogeables les
  // pays dont on ne connaît aucun match à venir (jamais répondu, agents
  // momentanément coupés, ou tous leurs matchs déjà joués). Sans cette
  // relance, le planning resterait figé sur la photo prise au premier tour de
  // la journée, et une panne passagère des agents condamnerait un pays
  // jusqu'au lendemain.
  const sweepAge = stored.sweepStartedAt ? now - Date.parse(stored.sweepStartedAt) : Infinity;
  const sweepOpened = !Number.isFinite(sweepAge) || sweepAge >= SWEEP_INTERVAL_MS;
  if (sweepOpened) {
    stored.sweepStartedAt = new Date(now).toISOString();
    for (const country of FICTIONAL_COUNTRIES) {
      if (!hasUpcomingMatch(stored, country, now)) delete stored.attempts[country];
    }
  }

  const pending = pendingCountries(stored, now);

  // Les pays sont interrogés en PARALLÈLE (bornés à COUNTRY_SWEEP_CONCURRENCY
  // à la fois) : chaque calendrier est indépendant des autres, rien ne
  // justifiait de les attendre un par un — c'était l'essentiel du temps
  // d'attente d'un tour manuel. La concurrence reste bornée pour ne pas
  // envoyer d'un coup une rafale de requêtes au serveur Omniroute
  // auto-hébergé, qui l'encaisserait mal.
  await mapWithConcurrency(pending.slice(0, maxCountriesPerRun), COUNTRY_SWEEP_CONCURRENCY, async (country) => {
    const trace: OmnirouteAttempt[] = [];
    let matches: FictionalMatch[] = [];
    try {
      matches = await fetchCountryFixtures(config, country, date, trace);
    } catch (error: any) {
      console.warn(`[Programme fictif] ${country} a échoué pendant le balayage parallèle:`, error?.message);
    }
    if (matches.length > 0) {
      // Fusion, jamais remplacement : un match déjà au planning peut être en
      // cours de suivi (checkpoint 20e passé, 60e à venir) — le faire
      // disparaître d'une réponse à l'autre interromprait son suivi.
      const merged = new Map((stored.byCountry[country] ?? []).map((m) => [m.fixtureId, m]));
      for (const match of matches) if (!merged.has(match.fixtureId)) merged.set(match.fixtureId, match);
      stored.byCountry[country] = [...merged.values()];
    }
    // Une tentative n'est comptée que si un agent a VRAIMENT répondu. Quand
    // tous échouent (fournisseurs de recherche coupés côté Omniroute,
    // endpoint injoignable), la question n'a jamais été posée : compter ça
    // comme un essai épuiserait les trois tentatives de chaque pays sur une
    // panne passagère et condamnerait la journée sans qu'aucun calendrier
    // n'ait été consulté.
    if (!attemptsAllFailed(trace)) {
      stored.attempts[country] = (stored.attempts[country] ?? 0) + 1;
    }
    stored.lastTrace = { country, attempts: trace };
  });

  // L'horodatage de la passe doit être enregistré même quand il n'y avait rien
  // à interroger, sinon la prochaine lecture le croit expiré et rouvre une
  // passe à chaque tour au lieu d'une par heure.
  if (pending.length > 0 || sweepOpened) {
    await AsyncStorage.setItem(programKey(date), JSON.stringify(stored));
  }

  return selectFromStored(stored);
}

/**
 * Planning exploitable à partir de ce qui est stocké. Dédoublonne d'abord
 * entre sources (une même rencontre peut figurer dans le planning transmis ET
 * dans une réponse d'agent, ou dans deux pays pour une coupe européenne), puis
 * répartit équitablement jusqu'au plafond du jour.
 *
 * Un planning transmis est déjà cadré (250 matchs, répartition voulue) et
 * arrive sous une source unique : le répartir "équitablement entre pays" le
 * viderait de tout sauf des premiers. Il est donc rendu tel quel.
 */
function selectFromStored(stored: StoredProgram): FictionalMatch[] {
  const feed = stored.byCountry[FEED_SOURCE_KEY] ?? [];
  if (feed.length > 0) {
    return [...feed].sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
  }

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
