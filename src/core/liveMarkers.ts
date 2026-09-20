// Observation en direct + étiquetage automatique multi-événements.
//
// Objectif : apprendre quels marqueurs précèdent un BUT, un CORNER ou un
// CARTON, sur deux fenêtres :
//   - 10 minutes : signal court.
//   - 25 minutes : la fenêtre de pari visée (décision à la 20e, jusqu'à la pause).
//
// Économie de requêtes : le relevé /fixtures?live=all est fait UNE SEULE FOIS
// par tour, par backgroundTasks.ts, et partagé avec inPlayCombos.ts (même
// donnée, même requête) — avant ce partage, les deux modules la refaisaient
// chacun de leur côté, doublant la consommation du quota API-Football à
// chaque tour (jusqu'à épuiser le quota du jour avant la fin d'un match).
// Les statistiques détaillées (tirs, corners, cartons) restent un appel par
// match : elles sont réservées en priorité aux matchs des ligues sur
// lesquelles l'utilisateur joue vraiment.

import { getAPIConfig } from '../api/multiAPIManager';
import { spendBudget } from './requestBudget';
import { getStoredUniverse, UniverseMatch } from './matchUniverse';
import { fetchWithTimeout } from './httpTimeout';
import { LiveFixture, isSyntheticFixtureId } from './halftimeMonitor';
import {
  EventDeltas,
  LEARNING_HORIZONS,
  MarkerSet,
  PendingObservation,
  TrainingRow,
  CrossCheckSample,
  appendCrossCheckSamples,
  appendTrainingRows,
  readLearnedModel,
  readPendingSnapshots,
  writePendingSnapshots,
} from './learnStore';
import { maybePlacePaperBets } from './autoLearn';
import { loadOmnirouteConfig } from './focusEnrichment';
import { askOmnirouteLight } from './omniroute';
import { OmnirouteConfig } from '../types';

/** Nombre maximum de matchs enrichis en statistiques détaillées par tour (API-Football, quota limité). */
const MAX_DETAILED_STATS_PER_TICK = 10;
/**
 * Matchs supplémentaires couverts par Omniroute (scraping, pas soumis au
 * même quota) au-delà de ce que API-Football peut fournir dans le tour —
 * c'est ce qui permet de suivre bien plus que 10 matchs à la fois.
 */
const MAX_OMNIROUTE_STATS_PER_TICK = 10;
/** Matchs déjà couverts par API-Football redemandés à Omniroute, pour mesurer son accord avec la vérité terrain. */
const MAX_CROSSCHECK_PER_TICK = 3;
/** Écart toléré entre la lecture Omniroute et la vérité terrain API-Football pour juger qu'elles "sont d'accord". */
const MARKET_TOLERANCE: Record<'corners' | 'cards', number> = { corners: 1, cards: 1 };
const LONGEST_HORIZON = Math.max(...LEARNING_HORIZONS);

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': 'v3.football.api-sports.io',
    'x-apisports-key': apiKey,
  };
}

function parseStatValue(raw: unknown): number | undefined {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const parsed = parseInt(raw.replace('%', ''), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Statistiques détaillées d'un match (tirs cadrés, corners, cartons, fautes,
 * possession) via API-Football. Exportée pour être réutilisée par
 * inPlayCombos.ts : les tirs cadrés y servent à recalibrer les buts attendus
 * sur l'évolution RÉELLE du match (poisson.ts/recalibrateGoalsForWindow),
 * plutôt que de rester figés sur la moyenne pré-match.
 */
export async function fetchMarkers(apiKey: string, fixtureId: number): Promise<MarkerSet> {
  try {
    const response = await fetchWithTimeout(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
      { headers: buildHeaders(apiKey) }
    );
    if (!response.ok) return {};

    const data = await response.json();
    const entries: any[] = data.response || [];
    const [home, away] = entries;

    const pick = (entry: any, type: string) =>
      parseStatValue(entry?.statistics?.find((s: any) => s.type === type)?.value);

    const cardsOf = (entry: any) =>
      (pick(entry, 'Yellow Cards') ?? 0) + (pick(entry, 'Red Cards') ?? 0);

    return {
      shotsOnTargetHome: pick(home, 'Shots on Goal'),
      shotsOnTargetAway: pick(away, 'Shots on Goal'),
      shotsTotalHome: pick(home, 'Total Shots'),
      shotsTotalAway: pick(away, 'Total Shots'),
      cornersHome: pick(home, 'Corner Kicks'),
      cornersAway: pick(away, 'Corner Kicks'),
      possessionHome: pick(home, 'Ball Possession'),
      cardsHome: entries.length > 0 ? cardsOf(home) : undefined,
      cardsAway: entries.length > 1 ? cardsOf(away) : undefined,
      foulsHome: pick(home, 'Fouls'),
      foulsAway: pick(away, 'Fouls'),
    };
  } catch {
    return {};
  }
}

/**
 * Demande à Omniroute (scraping) les marqueurs live d'un match, pour couvrir
 * ce que le quota API-Football ne permet pas de suivre dans ce tour. Ne
 * renvoie que des valeurs numériques trouvées sur une vraie source live —
 * jamais une estimation : si l'agent ne trouve rien de fiable, il renvoie
 * null pour ce champ, et null globalement si rien n'est exploitable.
 */
async function fetchOmnirouteMarkers(
  config: OmnirouteConfig,
  homeTeam: string,
  awayTeam: string,
  league: string,
  minute: number
): Promise<MarkerSet | null> {
  let result: { text: string; model: string } | null;
  try {
    result = await askOmnirouteLight(
      "Tu es un outil de lecture de statistiques de match de football EN DIRECT. " +
        "Réponds UNIQUEMENT par un JSON strict, sans texte autour. N'invente RIEN : " +
        "si une valeur n'est pas trouvée sur une source de score en direct fiable " +
        "(Sofascore, Flashscore, l'API du diffuseur...), mets null pour ce champ " +
        "plutôt qu'une estimation.",
      `Match EN COURS, minute ${minute} : ${homeTeam} vs ${awayTeam} (${league}).\n` +
        'Cherche les statistiques live (corners, cartons cumulés) sur une source fiable.\n' +
        'Réponds avec ce JSON exact, sans rien autour :\n' +
        '{"corners_home": number|null, "corners_away": number|null, "cards_home": number|null, "cards_away": number|null}\n' +
        'cards_home/away = total cumulé cartons jaunes + rouges pour cette équipe à cet instant.',
      config
    );
  } catch (error: any) {
    console.warn('[Marqueurs live] Omniroute indisponible:', error.message);
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

  const toNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const markers: MarkerSet = {
    cornersHome: toNumber(parsed.corners_home),
    cornersAway: toNumber(parsed.corners_away),
    cardsHome: toNumber(parsed.cards_home),
    cardsAway: toNumber(parsed.cards_away),
  };

  const hasAnyValue = Object.values(markers).some((v) => v != null);
  return hasAnyValue ? markers : null;
}

function totalCorners(markers: MarkerSet): number | undefined {
  if (markers.cornersHome == null && markers.cornersAway == null) return undefined;
  return (markers.cornersHome ?? 0) + (markers.cornersAway ?? 0);
}

function totalCards(markers: MarkerSet): number | undefined {
  if (markers.cardsHome == null && markers.cardsAway == null) return undefined;
  return (markers.cardsHome ?? 0) + (markers.cardsAway ?? 0);
}

function totalFouls(markers: MarkerSet): number | undefined {
  if (markers.foulsHome == null && markers.foulsAway == null) return undefined;
  return (markers.foulsHome ?? 0) + (markers.foulsAway ?? 0);
}

/**
 * Met à jour les fenêtres ouvertes d'un instantané à la lumière de l'état
 * courant. Une fenêtre est figée dès que sa durée est écoulée, ou tronquée si
 * la mi-temps arrive avant (marquée comme telle, jamais complétée au hasard).
 */
function updateHorizons(
  pending: PendingObservation,
  live: LiveFixture | undefined,
  currentMarkers: MarkerSet | undefined,
  halfEnded: boolean
): PendingObservation {
  const goalsNow = live ? live.homeGoals + live.awayGoals : pending.goalsHome + pending.goalsAway;
  const cornersNow = currentMarkers ? totalCorners(currentMarkers) : undefined;
  const cardsNow = currentMarkers ? totalCards(currentMarkers) : undefined;
  const foulsNow = currentMarkers ? totalFouls(currentMarkers) : undefined;

  const deltas: EventDeltas = {
    goals: goalsNow - (pending.goalsHome + pending.goalsAway),
    corners: cornersNow != null ? cornersNow - pending.baselineCorners : 0,
    cards: cardsNow != null ? cardsNow - pending.baselineCards : 0,
    fouls: foulsNow != null ? foulsNow - pending.baselineFouls : 0,
    truncated: false,
  };

  const elapsed = live ? live.minute - pending.minute : LONGEST_HORIZON;
  const frozen = { ...pending.frozen };

  for (const horizon of LEARNING_HORIZONS) {
    const key = String(horizon);
    if (frozen[key]) continue;

    if (elapsed >= horizon) {
      frozen[key] = { ...deltas };
    } else if (halfEnded) {
      // Pause atteinte avant la fin de la fenêtre : on fige ce qu'on a en le
      // signalant tronqué, pour ne pas polluer l'apprentissage.
      frozen[key] = { ...deltas, truncated: true };
    }
  }

  return { ...pending, frozen };
}

function isClosed(pending: PendingObservation): boolean {
  return LEARNING_HORIZONS.every((h) => pending.frozen[String(h)] != null);
}

function toTrainingRow(pending: PendingObservation): TrainingRow {
  const { baselineCorners, baselineCards, baselineFouls, frozen, ...snapshot } = pending;
  return { ...snapshot, horizons: frozen, closedAt: new Date().toISOString() };
}

/**
 * Un tour d'observation. Appelé par la tâche de fond (toutes les ~15 min,
 * plancher imposé par Android) et par la boucle de premier plan (3 min).
 * `liveFixtures` est déjà récupéré par backgroundTasks.ts (un seul relevé
 * /fixtures?live=all par tour, partagé avec inPlayCombos.ts) — cette
 * fonction ne fait plus sa propre requête ni son propre spendBudget pour ça.
 */
export async function runLiveMarkerTick(liveFixtures: LiveFixture[]): Promise<{ observed: number; closed: number }> {
  if (liveFixtures.length === 0) return { observed: 0, closed: 0 };

  const config = await getAPIConfig();
  const universe = await getStoredUniverse();

  const live = liveFixtures;

  const model = readLearnedModel();
  const focusLeagues = new Set((model?.focusLeagues ?? []).map((l) => l.toLowerCase()));

  const universeById = new Map<number, UniverseMatch>((universe ?? []).map((m) => [m.fixtureId, m]));
  const liveByFixture = new Map<number, LiveFixture>(live.map((l) => [l.fixtureId, l]));

  // league/pays connus via matchUniverse quand ce fixtureId y figure, sinon
  // directement depuis la fixture (LiveFixture.league, déjà renseigné côté
  // découverte Omniroute) — jamais un filtre bloquant : un match découvert
  // par Omniroute (fixtureId synthétique, cf. halftimeMonitor.ts) n'a par
  // construction aucune entrée dans matchUniverse.
  const metaFor = (l: LiveFixture): { league: string; country: string; homeTeam: string; awayTeam: string } => {
    const known = universeById.get(l.fixtureId);
    if (known) return known;
    return { league: l.league || 'Inconnu', country: '', homeTeam: l.homeTeam, awayTeam: l.awayTeam };
  };

  // Matchs actuellement en 1ère mi-temps, ligues jouées d'abord : ce sont eux
  // qui méritent les requêtes de statistiques détaillées.
  const firstHalf = live
    .filter((l) => l.statusShort === '1H')
    .sort((a, b) => {
      const aFocus = focusLeagues.has(metaFor(a).league.toLowerCase()) ? 0 : 1;
      const bFocus = focusLeagues.has(metaFor(b).league.toLowerCase()) ? 0 : 1;
      return aFocus - bFocus;
    });

  // Statistiques détaillées API-Football : jamais pour un fixtureId
  // synthétique (repli Omniroute) — API-Football ne le connaît sous aucun
  // identifiant, l'appel échouerait pour rien.
  const eligibleForApiFootball = config.apiFootball ? firstHalf.filter((l) => !isSyntheticFixtureId(l.fixtureId)) : [];
  const topApiFootball = eligibleForApiFootball.slice(0, MAX_DETAILED_STATS_PER_TICK);
  const markersByFixture = new Map<number, MarkerSet>();
  for (const l of topApiFootball) {
    if (!(await spendBudget('apiFootball'))) break;
    markersByFixture.set(l.fixtureId, await fetchMarkers(config.apiFootball!, l.fixtureId));
  }

  // Couverture supplémentaire au-delà du quota API-Football, ET tous les
  // matchs découverts directement par Omniroute (fixtureId synthétique — ces
  // derniers ne PEUVENT être couverts que par Omniroute, jamais par
  // API-Football, quel que soit le budget restant). Sans ce deuxième cas, un
  // match du pipeline fictif découvert par Omniroute ne recevait jamais
  // d'instantané ici, donc n'alimentait jamais la boucle de règles apprises
  // malgré son règlement dans dailyReview.ts — seule la calibration
  // (Taux Réel affiché) progressait, jamais le modèle lui-même. Ses lignes
  // sont marquées 'omniroute' et ne rentrent dans les règles de calibrage
  // qu'une fois leur fiabilité prouvée par recoupement (cf. consolidateLearning
  // / omnirouteTrust).
  const omnirouteMarkersByFixture = new Map<number, MarkerSet>();
  const omnirouteConfig = await loadOmnirouteConfig();
  const crossCheckSamples: CrossCheckSample[] = [];

  if (omnirouteConfig) {
    const alreadyCovered = new Set(topApiFootball.map((l) => l.fixtureId));
    const beyondQuota = [
      ...eligibleForApiFootball.slice(MAX_DETAILED_STATS_PER_TICK),
      ...firstHalf.filter((l) => isSyntheticFixtureId(l.fixtureId)),
    ]
      .filter((l) => !alreadyCovered.has(l.fixtureId))
      .slice(0, MAX_OMNIROUTE_STATS_PER_TICK);
    // Pas de spendBudget ici : Omniroute est un serveur auto-hébergé par
    // l'utilisateur, sans quota gratuit externe à protéger — seul le nombre
    // de matchs par tour (MAX_OMNIROUTE_STATS_PER_TICK) le borne, pour ne
    // pas allonger le tour indéfiniment.
    for (const l of beyondQuota) {
      const meta = metaFor(l);
      const markers = await fetchOmnirouteMarkers(omnirouteConfig, meta.homeTeam, meta.awayTeam, meta.league, l.minute);
      if (markers) omnirouteMarkersByFixture.set(l.fixtureId, markers);
    }

    // Recoupement : redemande à Omniroute quelques matchs déjà couverts par
    // API-Football (vérité terrain), pour mesurer son taux d'accord réel.
    const crossCheckCandidates = topApiFootball
      .filter((l) => {
        const m = markersByFixture.get(l.fixtureId);
        return m && (totalCorners(m) != null || totalCards(m) != null);
      })
      .slice(0, MAX_CROSSCHECK_PER_TICK);

    for (const l of crossCheckCandidates) {
      const meta = metaFor(l);
      const omniMarkers = await fetchOmnirouteMarkers(omnirouteConfig, meta.homeTeam, meta.awayTeam, meta.league, l.minute);
      if (!omniMarkers) continue;

      const trueMarkers = markersByFixture.get(l.fixtureId)!;
      const ts = new Date().toISOString();

      const trueCorners = totalCorners(trueMarkers);
      const omniCorners = totalCorners(omniMarkers);
      if (trueCorners != null && omniCorners != null) {
        crossCheckSamples.push({
          ts,
          fixtureId: l.fixtureId,
          market: 'corners',
          apiFootballValue: trueCorners,
          omnirouteValue: omniCorners,
          agree: Math.abs(trueCorners - omniCorners) <= MARKET_TOLERANCE.corners,
        });
      }

      const trueCards = totalCards(trueMarkers);
      const omniCards = totalCards(omniMarkers);
      if (trueCards != null && omniCards != null) {
        crossCheckSamples.push({
          ts,
          fixtureId: l.fixtureId,
          market: 'cards',
          apiFootballValue: trueCards,
          omnirouteValue: omniCards,
          agree: Math.abs(trueCards - omniCards) <= MARKET_TOLERANCE.cards,
        });
      }
    }
  }

  if (crossCheckSamples.length > 0) appendCrossCheckSamples(crossCheckSamples);

  // Vue unifiée des marqueurs courants, quelle que soit leur source — une
  // valeur API-Football, quand elle existe, prime toujours sur Omniroute.
  const currentMarkersByFixture = new Map<number, MarkerSet>([
    ...omnirouteMarkersByFixture,
    ...markersByFixture,
  ]);
  const fixtureSource = new Map<number, 'api_football' | 'omniroute'>();
  for (const fixtureId of omnirouteMarkersByFixture.keys()) fixtureSource.set(fixtureId, 'omniroute');
  for (const fixtureId of markersByFixture.keys()) fixtureSource.set(fixtureId, 'api_football'); // priorité

  // 1) Avancer les fenêtres des instantanés déjà ouverts.
  const pending = readPendingSnapshots();
  const stillPending: PendingObservation[] = [];
  const closedRows: TrainingRow[] = [];

  for (const obs of pending) {
    const liveNow = liveByFixture.get(obs.fixtureId);
    const halfEnded = !liveNow || liveNow.statusShort !== '1H';
    const updated = updateHorizons(obs, liveNow, currentMarkersByFixture.get(obs.fixtureId), halfEnded);

    if (isClosed(updated)) closedRows.push(toTrainingRow(updated));
    else stillPending.push(updated);
  }

  if (closedRows.length > 0) appendTrainingRows(closedRows);

  // 2) Ouvrir de nouveaux instantanés.
  const openFixtures = new Set(stillPending.map((p) => `${p.fixtureId}-${p.minute}`));
  const newSnapshots: PendingObservation[] = [];

  for (const l of firstHalf) {
    const meta = metaFor(l);
    const key = `${l.fixtureId}-${l.minute}`;
    if (openFixtures.has(key)) continue;

    const markers = currentMarkersByFixture.get(l.fixtureId) ?? {};

    newSnapshots.push({
      ts: new Date().toISOString(),
      fixtureId: l.fixtureId,
      league: meta.league,
      country: meta.country,
      homeTeam: meta.homeTeam,
      awayTeam: meta.awayTeam,
      minute: l.minute,
      goalsHome: l.homeGoals,
      goalsAway: l.awayGoals,
      markers,
      focus: focusLeagues.has(meta.league.toLowerCase()),
      source: fixtureSource.get(l.fixtureId) ?? (isSyntheticFixtureId(l.fixtureId) ? 'omniroute' : 'api_football'),
      baselineCorners: totalCorners(markers) ?? 0,
      baselineCards: totalCards(markers) ?? 0,
      baselineFouls: totalFouls(markers) ?? 0,
      frozen: {},
    });
  }

  writePendingSnapshots([...stillPending, ...newSnapshots]);

  // Boucle silencieuse : le modèle parie sur ses propres instantanés, en
  // avance de phase (jamais de hindsight), et sera noté quand la vérité
  // terrain arrivera. Aucune notification, aucun argent.
  maybePlacePaperBets(newSnapshots, model);

  return { observed: newSnapshots.length, closed: closedRows.length };
}
