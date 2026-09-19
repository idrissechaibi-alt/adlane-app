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
import {
  EventDeltas,
  LEARNING_HORIZONS,
  MarkerSet,
  PendingObservation,
  TrainingRow,
  appendTrainingRows,
  readLearnedModel,
  readPendingSnapshots,
  writePendingSnapshots,
} from './learnStore';
import { maybePlacePaperBets } from './autoLearn';

/** Nombre maximum de matchs enrichis en statistiques détaillées par tour. */
const MAX_DETAILED_STATS_PER_TICK = 10;
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
  const response = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
    headers: buildHeaders(apiKey),
  });
  if (!response.ok) return [];

  const data = await response.json();
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
    const response = await fetch(
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

  // Statistiques détaillées pour un nombre borné de matchs (budget API).
  const markersByFixture = new Map<number, MarkerSet>();
  for (const l of firstHalf.slice(0, MAX_DETAILED_STATS_PER_TICK)) {
    if (!(await spendBudget('apiFootball'))) break;
    markersByFixture.set(l.fixtureId, await fetchMarkers(config.apiFootball, l.fixtureId));
  }

  // 1) Avancer les fenêtres des instantanés déjà ouverts.
  const pending = readPendingSnapshots();
  const stillPending: PendingObservation[] = [];
  const closedRows: TrainingRow[] = [];

  for (const obs of pending) {
    const liveNow = liveByFixture.get(obs.fixtureId);
    const halfEnded = !liveNow || liveNow.statusShort !== '1H';
    const updated = updateHorizons(obs, liveNow, markersByFixture.get(obs.fixtureId), halfEnded);

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

    const markers = markersByFixture.get(l.fixtureId) ?? {};

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
