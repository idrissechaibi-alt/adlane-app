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
  fixtureId: number;
  /** Minute de jeu actuelle (temps additionnel compris dans le décompte API-Football). */
  minute: number;
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
    minute: item.fixture?.status?.elapsed ?? 0
  }));
}

/** Nombre de matchs interrogés par tour en repli Omniroute — chaque appel est
 * une requête IA (quelques secondes), pas une simple lecture JSON. */
const MAX_OMNIROUTE_LIVE_FIXTURES_PER_TICK = 12;
/** Durée après laquelle un match dont le coup d'envoi théorique est passé
 * n'est plus considéré comme potentiellement en direct (90 min + pause +
 * marge pour prolongations/retard d'envoi). */
const ASSUMED_MATCH_DURATION_MS = 130 * 60 * 1000;

const OMNIROUTE_STATUS_MAP: Record<string, string> = { '1H': '1H', HT: 'HT', '2H': '2H' };

interface UniverseMatchLike {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoff_utc: string;
}

async function fetchOneOmnirouteLiveFixture(
  config: OmnirouteConfig,
  m: UniverseMatchLike
): Promise<LiveFixture | null> {
  let result: { text: string; model: string } | null;
  try {
    result = await askOmnirouteLight(
      'Tu es un outil de lecture de score de football EN DIRECT. Réponds UNIQUEMENT par un JSON strict, ' +
        "sans texte autour. N'invente RIEN : si tu ne trouves pas ce match sur une source de score en direct " +
        'fiable (Sofascore, Flashscore, l\'API du diffuseur...), réponds avec status "not_found".',
      `Match : ${m.homeTeam} vs ${m.awayTeam} (${m.league}).\n` +
        'Cherche son statut EN CE MOMENT sur une source de score en direct fiable.\n' +
        'Réponds avec ce JSON exact, sans rien autour :\n' +
        '{"status": "not_started"|"1H"|"HT"|"2H"|"finished"|"not_found", "minute": number|null, "home_goals": number|null, "away_goals": number|null}',
      config
    );
  } catch {
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

  const statusShort = OMNIROUTE_STATUS_MAP[parsed.status];
  if (!statusShort) return null; // not_started / finished / not_found : rien à observer maintenant

  const minute = typeof parsed.minute === 'number' && Number.isFinite(parsed.minute) ? parsed.minute : 0;
  const homeGoals = typeof parsed.home_goals === 'number' && Number.isFinite(parsed.home_goals) ? parsed.home_goals : 0;
  const awayGoals = typeof parsed.away_goals === 'number' && Number.isFinite(parsed.away_goals) ? parsed.away_goals : 0;

  return { statusShort, homeTeam: m.homeTeam, awayTeam: m.awayTeam, homeGoals, awayGoals, fixtureId: m.fixtureId, minute };
}

/**
 * Reconstruit la liste des matchs actuellement en direct SANS passer par
 * API-Football, en repli quand sa clé est absente ou son quota du jour est
 * épuisé — Omniroute (auto-hébergé, scraping, sans quota) "prend le relais"
 * à partir du programme du jour déjà connu (matchUniverse) : on ne retient
 * que les matchs dont le coup d'envoi théorique est passé depuis moins de
 * ASSUMED_MATCH_DURATION_MS, puis on demande à Omniroute la minute et le
 * score actuels de chacun (bornage à MAX_OMNIROUTE_LIVE_FIXTURES_PER_TICK par
 * tour). Sans ce repli, un quota API-Football épuisé arrêtait TOUT le scan en
 * direct — y compris le pipeline fictif, qui n'est pourtant censé dépendre
 * d'aucune ressource payante.
 */
export async function fetchOmnirouteLiveFixtures(
  config: OmnirouteConfig,
  universe: UniverseMatchLike[]
): Promise<LiveFixture[]> {
  const now = Date.now();
  const candidates = universe
    .filter((m) => {
      const kickoff = Date.parse(m.kickoff_utc);
      if (!Number.isFinite(kickoff)) return false;
      const elapsedMs = now - kickoff;
      return elapsedMs >= 0 && elapsedMs <= ASSUMED_MATCH_DURATION_MS;
    })
    .slice(0, MAX_OMNIROUTE_LIVE_FIXTURES_PER_TICK);

  const results: LiveFixture[] = [];
  for (const m of candidates) {
    const live = await fetchOneOmnirouteLiveFixture(config, m);
    if (live) results.push(live);
  }
  return results;
}
