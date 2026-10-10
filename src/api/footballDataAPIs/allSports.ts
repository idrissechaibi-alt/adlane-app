// AllSportsApi (apiv2.allsportsapi.com) — le plan de l'utilisateur ne couvre
// aucun des 5 grands championnats : la clé alimente donc le pipe FICTIF
// (flux en direct, règlement) ; elle reste un repli de règlement pour le réel.
// Un match absent du plan renvoie simplement null / liste vide.

import { fetchWithTimeout } from '../../core/httpTimeout';
import { namesLikelyMatch, normalizeTeamName } from '../../core/teamNameMatch';

const BASE_URL = 'https://apiv2.allsportsapi.com/football/';

export interface AllSportsResult {
  goalsHome: number;
  goalsAway: number;
  htHome: number;
  htAway: number;
  cards1H?: number;
}

function parseScore(text: unknown): [number, number] | null {
  const m = /(\d+)\s*-\s*(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export interface AllSportsLive {
  eventKey: number;
  statusShort: '1H' | 'HT' | '2H';
  minute: number;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  league: string;
  corners?: number;
  cards?: number;
  shotsOnTarget?: [number, number];
}

function statPair(stats: any[] | undefined, type: string): [number, number] | null {
  const row = Array.isArray(stats) ? stats.find((x) => x?.type === type) : undefined;
  if (!row) return null;
  return [Number(row.home) || 0, Number(row.away) || 0];
}

/** Matchs en cours couverts par le plan (1 requête). */
export async function fetchAllSportsLive(apiKey: string): Promise<AllSportsLive[]> {
  const response = await fetchWithTimeout(`${BASE_URL}?met=Livescore&APIkey=${encodeURIComponent(apiKey)}`);
  if (!response.ok) throw new Error(`AllSportsApi HTTP ${response.status}`);
  const data = await response.json();
  const rows: any[] = Array.isArray(data?.result) ? data.result : [];
  const live: AllSportsLive[] = [];
  for (const x of rows) {
    if (String(x.event_live) !== '1') continue;
    const status = String(x.event_status ?? '');
    const score = parseScore(x.event_final_result);
    if (!score) continue;
    let statusShort: AllSportsLive['statusShort'];
    let minute: number;
    if (/half\s*time/i.test(status)) {
      statusShort = 'HT';
      minute = 45;
    } else {
      minute = parseInt(status, 10);
      if (!Number.isFinite(minute)) continue;
      statusShort = /2nd/i.test(String(x.event_status_info ?? '')) || minute > 45 ? '2H' : '1H';
    }
    const corners = statPair(x.statistics, 'Corners');
    const onTarget = statPair(x.statistics, 'On Target');
    live.push({
      eventKey: Number(x.event_key),
      statusShort,
      minute,
      homeTeam: String(x.event_home_team),
      awayTeam: String(x.event_away_team),
      homeGoals: score[0],
      awayGoals: score[1],
      league: [x.league_name, x.country_name].filter(Boolean).join(' · '),
      corners: corners ? corners[0] + corners[1] : undefined,
      cards: Array.isArray(x.cards) ? x.cards.length : undefined,
      shotsOnTarget: onTarget ?? undefined,
    });
  }
  return live;
}

export async function fetchAllSportsFixtures(apiKey: string, dateKey: string): Promise<any[]> {
  const url = `${BASE_URL}?met=Fixtures&APIkey=${encodeURIComponent(apiKey)}&from=${dateKey}&to=${dateKey}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`AllSportsApi HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.result) ? data.result : [];
}

/** Résultat final d'un match terminé (null si inconnu du plan ou pas fini). */
export function findAllSportsResult(fixtures: any[], homeTeam: string, awayTeam: string): AllSportsResult | null {
  const home = normalizeTeamName(homeTeam);
  const away = normalizeTeamName(awayTeam);
  const f = fixtures.find(
    (x) =>
      namesLikelyMatch(home, normalizeTeamName(String(x.event_home_team ?? ''))) &&
      namesLikelyMatch(away, normalizeTeamName(String(x.event_away_team ?? '')))
  );
  if (!f) return null;
  const status = String(f.event_status ?? '');
  if (!/^(finished|after|full)/i.test(status)) return null;
  const ft = parseScore(f.event_final_result);
  if (!ft) return null;
  const ht = parseScore(f.event_halftime_result) ?? [0, 0];
  const cards = Array.isArray(f.cards)
    ? f.cards.filter((c: any) => parseInt(String(c.time), 10) <= 45).length
    : undefined;
  return { goalsHome: ft[0], goalsAway: ft[1], htHome: ht[0], htAway: ht[1], cards1H: cards };
}
