// Observation en direct + étiquetage automatique multi-événements.
//
// Objectif : apprendre quels marqueurs précèdent un BUT, un CORNER ou un
// CARTON, sur deux fenêtres :
//   - 10 minutes : signal court.
//   - 25 minutes : la fenêtre de pari visée (décision à la 20e, jusqu'à la pause).
//
// Économie de requêtes : UN SEUL appel /fixtures?live=all ramène tous les
// matchs en direct de la planète. Les statistiques détaillées (tirs, corners,
// cartons) coûtent un appel par match : elles sont donc réservées en priorité
// aux matchs des ligues sur lesquelles l'utilisateur joue vraiment.

import { getAPIConfig } from '../api/multiAPIManager';
import { spendBudget } from './requestBudget';
import { getStoredUniverse, UniverseMatch } from './matchUniverse';
import { fetchWithTimeout } from './httpTimeout';
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

interface LiveSnapshotInput {
  fixtureId: number;
  minute: number;
  goalsHome: number;
  goalsAway: number;
  statusShort: string;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': 'v3.football.api-sports.io',
    'x-apisports-key': apiKey,
  };
}

async function fetchAllLive(apiKey: string): Promise<LiveSnapshotInput[]> {
  const response = await fetchWithTimeout('https://v3.football.api-sports.io/fixtures?live=all', {
    headers: buildHeaders(apiKey),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();

  // API-Football répond souvent HTTP 200 même en cas de problème de clé/plan
  // (ex: "Missing application key", déjà rencontré sur /standings avec ce
  // compte) — l'erreur réelle est dans data.errors, jamais dans le statut
  // HTTP. Sans cette vérification, cette fonction renvoyait silencieusement
  // un tableau vide dans ce cas précis : runLiveMarkerTick voyait "aucun
  // match en direct" à chaque tour, pour toujours, quel que soit le nombre
  // réel de matchs en cours — c'était indiscernable d'une vraie absence de
  // match en direct.
  const errors = data.errors;
  const hasErrors = errors && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors).length > 0);
  if (hasErrors) {
    const message = Array.isArray(errors) ? errors.join(', ') : Object.values(errors).join(', ');
    throw new Error(message || 'Erreur API-Football inconnue (data.errors non vide)');
  }

  return (data.response || []).map((item: any) => ({
    fixtureId: item.fixture?.id,
    minute: item.fixture?.status?.elapsed ?? 0,
    goalsHome: item.goals?.home ?? 0,
    goalsAway: item.goals?.away ?? 0,
    statusShort: item.fixture?.status?.short || '',
  }));
}

function parseStatValue(raw: unknown): number | undefined {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const parsed = parseInt(raw.replace('%', ''), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function fetchMarkers(apiKey: string, fixtureId: number): Promise<MarkerSet> {
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
  live: LiveSnapshotInput | undefined,
  currentMarkers: MarkerSet | undefined,
  halfEnded: boolean
): PendingObservation {
  const goalsNow = live ? live.goalsHome + live.goalsAway : pending.goalsHome + pending.goalsAway;
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
 */
export async function runLiveMarkerTick(): Promise<{ observed: number; closed: number }> {
  const config = await getAPIConfig();
  if (!config.apiFootball) return { observed: 0, closed: 0 };

  const universe = await getStoredUniverse();
  if (!universe || universe.length === 0) return { observed: 0, closed: 0 };

  if (!(await spendBudget('apiFootball'))) return { observed: 0, closed: 0 };

  let live: LiveSnapshotInput[];
  try {
    live = await fetchAllLive(config.apiFootball);
  } catch (error: any) {
    console.warn('[Marqueurs live] Échec du relevé:', error.message);
    return { observed: 0, closed: 0 };
  }

  const model = readLearnedModel();
  const focusLeagues = new Set((model?.focusLeagues ?? []).map((l) => l.toLowerCase()));

  const universeById = new Map<number, UniverseMatch>(universe.map((m) => [m.fixtureId, m]));
  const liveByFixture = new Map<number, LiveSnapshotInput>(live.map((l) => [l.fixtureId, l]));

  // Matchs de l'univers actuellement en 1ère mi-temps, ligues jouées d'abord :
  // ce sont eux qui méritent les requêtes de statistiques détaillées.
  const firstHalf = live
    .filter((l) => l.statusShort === '1H' && universeById.has(l.fixtureId))
    .sort((a, b) => {
      const aFocus = focusLeagues.has(universeById.get(a.fixtureId)!.league.toLowerCase()) ? 0 : 1;
      const bFocus = focusLeagues.has(universeById.get(b.fixtureId)!.league.toLowerCase()) ? 0 : 1;
      return aFocus - bFocus;
    });

  // Statistiques détaillées pour un nombre borné de matchs (budget API-Football).
  const topApiFootball = firstHalf.slice(0, MAX_DETAILED_STATS_PER_TICK);
  const markersByFixture = new Map<number, MarkerSet>();
  for (const l of topApiFootball) {
    if (!(await spendBudget('apiFootball'))) break;
    markersByFixture.set(l.fixtureId, await fetchMarkers(config.apiFootball, l.fixtureId));
  }

  // Couverture supplémentaire au-delà du quota API-Football : Omniroute
  // scrape les mêmes marqueurs pour d'autres matchs de l'univers, sans être
  // soumis au même plafond. Ses lignes sont marquées 'omniroute' et ne
  // rentrent dans les règles de calibrage qu'une fois leur fiabilité prouvée
  // par recoupement (cf. consolidateLearning / omnirouteTrust).
  const omnirouteMarkersByFixture = new Map<number, MarkerSet>();
  const omnirouteConfig = await loadOmnirouteConfig();
  const crossCheckSamples: CrossCheckSample[] = [];

  if (omnirouteConfig) {
    const beyondQuota = firstHalf.slice(
      MAX_DETAILED_STATS_PER_TICK,
      MAX_DETAILED_STATS_PER_TICK + MAX_OMNIROUTE_STATS_PER_TICK
    );
    for (const l of beyondQuota) {
      if (!(await spendBudget('omniroute'))) break;
      const meta = universeById.get(l.fixtureId)!;
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
      if (!(await spendBudget('omniroute'))) break;
      const meta = universeById.get(l.fixtureId)!;
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
    const meta = universeById.get(l.fixtureId)!;
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
      goalsHome: l.goalsHome,
      goalsAway: l.goalsAway,
      markers,
      focus: focusLeagues.has(meta.league.toLowerCase()),
      source: fixtureSource.get(l.fixtureId) ?? 'api_football',
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
