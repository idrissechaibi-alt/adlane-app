// Lecture des matchs en direct (API-Football /fixtures?live=all) — utilisée
// par le scan Scouting (détection live) et par le scan 20e/60e minute
// (src/core/inPlayCombos.ts). Le combo de mi-temps qui vivait ici a été
// retiré (remplacé par le scan unifié 20e/60e minute).

import { fetchWithTimeout } from './httpTimeout';
import { askOmnirouteLight } from './omniroute';
import { OmnirouteConfig } from '../types';

export interface LiveFixture {
  statusShort: string; // '1H', 'HT', '2H', 'FT', ...
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  /** Identifiant API-Football réel côté source API-Football ; côté repli
   * Omniroute (aucun identifiant officiel à disposition), un identifiant
   * synthétique stable dérivé des noms d'équipe — voir syntheticFixtureId. */
  fixtureId: number;
  /** Minute de jeu actuelle (temps additionnel compris dans le décompte API-Football). */
  minute: number;
  /** Nom de la compétition, quand connu — absent historiquement côté
   * API-Football (jamais lu avant), toujours renseigné côté repli Omniroute. */
  league?: string;
}

export function buildApiFootballHeaders(apiKey: string): Record<string, string> {
  return {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': 'v3.football.api-sports.io',
    'x-apisports-key': apiKey
  };
}

/**
 * Récupère TOUS les matchs actuellement en direct dans le monde (une seule
 * requête, filtrée ensuite côté client par nom d'équipe) — API-Football
 * n'offre pas de recherche live par équipe.
 */
export async function fetchLiveFixtures(apiKey: string): Promise<LiveFixture[]> {
  const response = await fetchWithTimeout('https://v3.football.api-sports.io/fixtures?live=all', {
    headers: buildApiFootballHeaders(apiKey)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();

  // API-Football répond souvent HTTP 200 même en cas de problème de clé/plan
  // (ex: "Missing application key", déjà rencontré sur /standings avec ce
  // compte) — l'erreur réelle est dans data.errors, jamais dans le statut
  // HTTP. Sans cette vérification, "aucun match en direct trouvé" et "l'appel
  // a échoué" sont indiscernables : impossible de savoir si un match
  // réellement en cours a juste été raté, ou si l'API a refusé la requête.
  const errors = data.errors;
  const hasErrors = errors && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors).length > 0);
  if (hasErrors) {
    const message = Array.isArray(errors) ? errors.join(', ') : Object.values(errors).join(', ');
    throw new Error(message || 'Erreur API-Football inconnue (data.errors non vide)');
  }

  return (data.response || []).map((item: any) => ({
    statusShort: item.fixture?.status?.short || '',
    homeTeam: item.teams?.home?.name || '',
    awayTeam: item.teams?.away?.name || '',
    homeGoals: item.goals?.home ?? 0,
    awayGoals: item.goals?.away ?? 0,
    fixtureId: item.fixture?.id,
    minute: item.fixture?.status?.elapsed ?? 0,
    league: item.league?.name || undefined
  }));
}

/** Espace d'identifiants réservé aux matchs découverts par Omniroute (pas
 * d'identifiant officiel API-Football à disposition) : assez haut pour ne
 * jamais chevaucher un vrai fixtureId API-Football (actuellement de l'ordre
 * du million), assez de marge (jusqu'à 999 999 999) pour un hash sans souci
 * de collision pratique sur le volume de matchs traité par jour. */
export const SYNTHETIC_FIXTURE_ID_BASE = 900_000_000;
const SYNTHETIC_FIXTURE_ID_RANGE = 90_000_000;

/** Un fixtureId dans cet espace vient du repli Omniroute, jamais d'API-Football
 * — donc jamais interrogeable via /fixtures/statistics ou /fixtures?ids=. */
export function isSyntheticFixtureId(fixtureId: number): boolean {
  return fixtureId >= SYNTHETIC_FIXTURE_ID_BASE;
}

/** Hash FNV-1a 32 bits — déterministe, donc la même paire d'équipes le même
 * jour retombe toujours sur le même identifiant synthétique (indispensable
 * pour le dédoublonnage entre tours et le règlement en fin de match). */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function syntheticFixtureId(homeTeam: string, awayTeam: string, dateKey: string): number {
  const key = `${homeTeam.trim().toLowerCase()}|${awayTeam.trim().toLowerCase()}|${dateKey}`;
  return SYNTHETIC_FIXTURE_ID_BASE + (fnv1aHash(key) % SYNTHETIC_FIXTURE_ID_RANGE);
}

/** Un match halluciné de plus dans une liste déjà longue coûte peu ; une
 * liste sans borne coûterait un temps de tour imprévisible. */
const MAX_OMNIROUTE_DISCOVERED_LIVE_FIXTURES = 40;
const OMNIROUTE_LIVE_STATUS_SET = new Set(['1H', 'HT', '2H']);

/**
 * Reconstruit la liste des matchs actuellement en direct SANS passer par
 * API-Football ET sans dépendre d'un programme du jour pré-construit
 * (matchUniverse) — contrairement à une première version de ce repli qui
 * ne faisait que RE-VÉRIFIER des matchs déjà connus, et se retrouvait donc
 * sans aucun candidat à interroger si matchUniverse n'avait jamais pu se
 * construire (lui-même entièrement gated derrière le budget API-Football).
 * Omniroute (auto-hébergé, scraping, sans quota) découvre ICI lui-même,
 * en une seule requête, tous les matchs actuellement en cours dans les
 * grands championnats — exactement ce qu'un site de scores en direct
 * affiche sur sa page d'accueil. N'invente rien : tableau vide si rien
 * n'est confirmé.
 *
 * Sans fixtureId API-Football officiel pour ces matchs découverts, un
 * identifiant synthétique stable (syntheticFixtureId) est dérivé des noms
 * d'équipe — assez pour dédoublonner et régler ces paris fictifs entre eux
 * d'un tour à l'autre, dans un espace d'identifiants qui ne chevauche
 * jamais les vrais fixtureId API-Football.
 */
export async function fetchOmnirouteAllLiveFixtures(config: OmnirouteConfig): Promise<LiveFixture[]> {
  let result: { text: string; model: string } | null;
  try {
    result = await askOmnirouteLight(
      'Tu es un outil de lecture de scores de football EN DIRECT, comme la page d\'accueil de Flashscore ou ' +
        "Sofascore. Réponds UNIQUEMENT par un JSON strict, sans texte autour. N'INVENTE RIEN : ne liste QUE des " +
        'matchs que tu peux confirmer être actuellement en cours sur une source de score en direct fiable. Si tu ' +
        "n'es pas sûr d'un match, ne l'inclus pas plutôt que de deviner.",
      'Liste TOUS les matchs de football actuellement EN COURS (1ère mi-temps, mi-temps, ou 2ème mi-temps — ' +
        'ni terminés, ni pas encore commencés) dans les grands championnats nationaux européens et sud-' +
        "américains (Angleterre, Espagne, Italie, Allemagne, France, et les autres grandes ligues).\n" +
        'Réponds avec ce JSON exact, sans rien autour :\n' +
        '{"matches": [{"home_team": string, "away_team": string, "competition": string, ' +
        '"status": "1H"|"HT"|"2H", "minute": number, "home_goals": number, "away_goals": number}]}\n' +
        'Tableau vide si tu ne trouves aucun match en cours confirmé.',
      config
    );
  } catch (error: any) {
    console.warn('[Découverte live Omniroute] Échec:', error.message);
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

  const rawMatches: any[] = Array.isArray(parsed.matches) ? parsed.matches : [];
  const dateKey = new Date().toISOString().split('T')[0];

  const fixtures: LiveFixture[] = [];
  for (const m of rawMatches.slice(0, MAX_OMNIROUTE_DISCOVERED_LIVE_FIXTURES)) {
    const homeTeam = typeof m.home_team === 'string' ? m.home_team.trim() : '';
    const awayTeam = typeof m.away_team === 'string' ? m.away_team.trim() : '';
    if (!homeTeam || !awayTeam) continue;
    if (!OMNIROUTE_LIVE_STATUS_SET.has(m.status)) continue;

    fixtures.push({
      statusShort: m.status,
      homeTeam,
      awayTeam,
      homeGoals: typeof m.home_goals === 'number' && Number.isFinite(m.home_goals) ? m.home_goals : 0,
      awayGoals: typeof m.away_goals === 'number' && Number.isFinite(m.away_goals) ? m.away_goals : 0,
      fixtureId: syntheticFixtureId(homeTeam, awayTeam, dateKey),
      minute: typeof m.minute === 'number' && Number.isFinite(m.minute) ? m.minute : 0,
      league: typeof m.competition === 'string' && m.competition.trim() ? m.competition.trim() : undefined,
    });
  }
  return fixtures;
}

const OMNIROUTE_MATCH_STATUS_MAP: Record<string, string> = { '1H': '1H', HT: 'HT', '2H': '2H' };

/** Relevé complet d'un match : son état ET ses statistiques de déroulement,
 * ramenés par UNE seule requête Omniroute (les tirs cadrés servent ensuite à
 * recalibrer les buts attendus sur l'évolution réelle du match — cf.
 * poisson.ts/recalibrateGoalsForWindow). Les demander dans la même requête
 * que le score évite de payer deux allers-retours par match et par
 * checkpoint. */
export interface LiveFixtureDetail extends LiveFixture {
  shotsOnTargetHome?: number;
  shotsOnTargetAway?: number;
  /** Corners/cartons cumulés depuis le coup d'envoi : suffisent à projeter
   * le reste de la mi-temps au rythme observé, sans aucune moyenne de saison
   * externe (le pipeline fictif n'a que Omniroute). */
  cornersTotal?: number;
  cardsTotal?: number;
}

/**
 * Statut EN CE MOMENT d'UN match précis, via Omniroute — contrairement à
 * fetchOmnirouteAllLiveFixtures (une liste large, best-effort), cette requête
 * cible un seul match connu par avance et est donc bien plus fiable :
 * demander "liste-moi tout ce qui est en cours" peut en oublier un ;
 * demander "CE match précis est-il en cours" ne peut que confirmer ou
 * infirmer.
 *
 * C'est le relevé de base des DEUX pipelines quand Omniroute travaille seul :
 * le pipeline fictif interroge ainsi chacun des matchs de son programme du
 * jour à l'approche de ses checkpoints, et le pipeline réel s'en sert en
 * secours quand un match programmé n'apparaît pas dans le relevé live
 * partagé — pour ne jamais rater une notification de pari réel.
 */
export async function fetchOmnirouteMatchStatus(
  config: OmnirouteConfig,
  homeTeam: string,
  awayTeam: string,
  league: string
): Promise<LiveFixtureDetail | null> {
  let result: { text: string; model: string } | null;
  try {
    result = await askOmnirouteLight(
      'Tu es un outil de lecture de score de football EN DIRECT. Réponds UNIQUEMENT par un JSON strict, ' +
        "sans texte autour. N'invente RIEN : si tu ne trouves pas ce match sur une source de score en direct " +
        'fiable (Sofascore, Flashscore, l\'API du diffuseur...), réponds avec status "not_found" ; si seul le ' +
        'détail des tirs manque, mets null pour ces champs-là.',
      `Match : ${homeTeam} vs ${awayTeam} (${league}).\n` +
        'Cherche son statut EN CE MOMENT sur une source de score en direct fiable, avec les statistiques ' +
        'cumulées depuis le coup d\'envoi.\n' +
        'Réponds avec ce JSON exact, sans rien autour :\n' +
        '{"status": "not_started"|"1H"|"HT"|"2H"|"finished"|"not_found", "minute": number|null, ' +
        '"home_goals": number|null, "away_goals": number|null, ' +
        '"shots_on_target_home": number|null, "shots_on_target_away": number|null, ' +
        '"corners_total": number|null, "cards_total": number|null}',
      config
    );
  } catch (error: any) {
    console.warn('[Statut live Omniroute] Échec:', error.message);
    return null;
  }
  if (!result) return null;

  let parsed: any;
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result.text);
  } catch {
    return null;
  }

  const statusShort = OMNIROUTE_MATCH_STATUS_MAP[parsed.status];
  if (!statusShort) return null; // not_started / finished / not_found : rien à observer maintenant

  const numberOrUndefined = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  return {
    statusShort,
    homeTeam,
    awayTeam,
    homeGoals: numberOrUndefined(parsed.home_goals) ?? 0,
    awayGoals: numberOrUndefined(parsed.away_goals) ?? 0,
    fixtureId: syntheticFixtureId(homeTeam, awayTeam, new Date().toISOString().split('T')[0]),
    minute: numberOrUndefined(parsed.minute) ?? 0,
    league,
    shotsOnTargetHome: numberOrUndefined(parsed.shots_on_target_home),
    shotsOnTargetAway: numberOrUndefined(parsed.shots_on_target_away),
    cornersTotal: numberOrUndefined(parsed.corners_total),
    cardsTotal: numberOrUndefined(parsed.cards_total),
  };
}
