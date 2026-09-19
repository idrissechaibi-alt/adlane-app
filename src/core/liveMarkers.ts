// Observation en direct + étiquetage automatique.
//
// Objectif : apprendre QUELS MARQUEURS précèdent un but de 1ère mi-temps.
// À chaque tour, on prend un instantané des matchs de l'univers du jour qui
// sont en 1ère mi-temps, puis on étiquette a posteriori les instantanés
// précédents : "un but est-il tombé dans les 10 minutes qui ont suivi ?".
//
// Économie de requêtes : UN SEUL appel /fixtures?live=all ramène tous les
// matchs en direct de la planète. Les statistiques détaillées (tirs, corners)
// coûtent un appel par match : elles ne sont donc récupérées que pour un
// nombre borné de rencontres prioritaires à chaque tour.

import { getAPIConfig } from '../api/multiAPIManager';
import { spendBudget } from './requestBudget';
import { getStoredUniverse, UniverseMatch } from './matchUniverse';
import {
  MarkerSet,
  MarkerSnapshot,
  TrainingRow,
  appendTrainingRows,
  readLearnedModel,
  readPendingSnapshots,
  writePendingSnapshots,
} from './learnStore';
import { maybePlacePaperBets } from './autoLearn';

/** Fenêtre d'étiquetage : un but dans les N minutes suivant l'instantané. */
const GOAL_WINDOW_MINUTES = 10;
/** Nombre maximum de matchs enrichis en statistiques détaillées par tour. */
const MAX_DETAILED_STATS_PER_TICK = 8;

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

    return {
      shotsOnTargetHome: pick(home, 'Shots on Goal'),
      shotsOnTargetAway: pick(away, 'Shots on Goal'),
      shotsTotalHome: pick(home, 'Total Shots'),
      shotsTotalAway: pick(away, 'Total Shots'),
      cornersHome: pick(home, 'Corner Kicks'),
      cornersAway: pick(away, 'Corner Kicks'),
      possessionHome: pick(home, 'Ball Possession'),
      cardsHome: pick(home, 'Yellow Cards'),
      cardsAway: pick(away, 'Yellow Cards'),
    };
  } catch {
    return {};
  }
}

/**
 * Étiquette les instantanés en attente à la lumière de l'observation courante.
 * Renvoie les lignes d'entraînement prêtes + les instantanés encore en attente.
 */
function labelPending(
  pending: MarkerSnapshot[],
  liveByFixture: Map<number, LiveSnapshotInput>
): { rows: TrainingRow[]; stillPending: MarkerSnapshot[] } {
  const rows: TrainingRow[] = [];
  const stillPending: MarkerSnapshot[] = [];
  const now = new Date().toISOString();

  for (const snap of pending) {
    const live = liveByFixture.get(snap.fixtureId);

    // Match disparu du direct (mi-temps atteinte, ou fini) : on clôt
    // l'observation avec ce qu'on sait, sans inventer.
    if (!live) {
      const tooOld = Date.now() - new Date(snap.ts).getTime() > 45 * 60_000;
      if (tooOld) {
        rows.push({ ...snap, label_goal_next_10: 0, labelledAt: now });
      } else {
        stillPending.push(snap);
      }
      continue;
    }

    const goalsAtSnapshot = snap.goalsHome + snap.goalsAway;
    const goalsNow = live.goalsHome + live.goalsAway;
    const elapsedSinceSnapshot = live.minute - snap.minute;

    if (goalsNow > goalsAtSnapshot && elapsedSinceSnapshot <= GOAL_WINDOW_MINUTES) {
      rows.push({ ...snap, label_goal_next_10: 1, labelledAt: now });
      continue;
    }

    // Fenêtre écoulée sans but, ou 1ère mi-temps terminée : étiquette négative.
    if (elapsedSinceSnapshot > GOAL_WINDOW_MINUTES || live.statusShort !== '1H') {
      rows.push({ ...snap, label_goal_next_10: 0, labelledAt: now });
      continue;
    }

    stillPending.push(snap);
  }

  return { rows, stillPending };
}

/**
 * Un tour d'observation. Appelé par la tâche de fond (toutes les ~15 min,
 * plancher imposé par Android) et par la boucle de premier plan (3 min).
 * Ne fait rien si aucun match de l'univers n'est en 1ère mi-temps.
 */
export async function runLiveMarkerTick(): Promise<{ observed: number; labelled: number }> {
  const config = await getAPIConfig();
  if (!config.apiFootball) return { observed: 0, labelled: 0 };

  const universe = await getStoredUniverse();
  if (!universe || universe.length === 0) return { observed: 0, labelled: 0 };

  if (!(await spendBudget('apiFootball'))) return { observed: 0, labelled: 0 };

  let live: LiveSnapshotInput[];
  try {
    live = await fetchAllLive(config.apiFootball);
  } catch (error: any) {
    console.warn('[Marqueurs live] Échec du relevé:', error.message);
    return { observed: 0, labelled: 0 };
  }

  const universeById = new Map<number, UniverseMatch>(universe.map((m) => [m.fixtureId, m]));
  const liveByFixture = new Map<number, LiveSnapshotInput>(live.map((l) => [l.fixtureId, l]));

  // 1) Étiqueter ce qui était en attente, avec les scores qu'on vient de lire.
  const pending = readPendingSnapshots();
  const { rows, stillPending } = labelPending(pending, liveByFixture);
  if (rows.length > 0) appendTrainingRows(rows);

  // 2) Prendre de nouveaux instantanés sur les matchs en 1ère mi-temps.
  const firstHalfMatches = live.filter(
    (l) => l.statusShort === '1H' && universeById.has(l.fixtureId)
  );

  const enrichCount = Math.min(MAX_DETAILED_STATS_PER_TICK, firstHalfMatches.length);
  const newSnapshots: MarkerSnapshot[] = [];

  for (let i = 0; i < firstHalfMatches.length; i++) {
    const l = firstHalfMatches[i];
    const meta = universeById.get(l.fixtureId)!;

    // Statistiques détaillées seulement pour les premiers matchs (budget),
    // les autres sont enregistrés avec score + minute uniquement.
    let markers: MarkerSet = {};
    if (i < enrichCount && (await spendBudget('apiFootball'))) {
      markers = await fetchMarkers(config.apiFootball, l.fixtureId);
    }

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
    });
  }

  writePendingSnapshots([...stillPending, ...newSnapshots]);

  // Boucle silencieuse : le modèle parie sur ses propres instantanés, en
  // avance de phase (jamais de hindsight), et sera noté quand la vérité
  // terrain arrivera au tour suivant. Aucune notification, aucun argent.
  maybePlacePaperBets(newSnapshots, readLearnedModel());

  return { observed: newSnapshots.length, labelled: rows.length };
}
