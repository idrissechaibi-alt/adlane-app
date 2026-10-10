// AllSportsApi (apiv2.allsportsapi.com) — source RÉSERVÉE au pipe réel : elle
// sert de repli pour régler les paris réels quand API-Football ne répond pas
// (quota épuisé). Jamais appelée par le pipe fictif. Le plan de l'utilisateur
// ne couvre que certaines compétitions : un match absent renvoie simplement null.

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
