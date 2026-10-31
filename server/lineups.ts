// COMPOSITIONS (serveur PC) : dans l'heure qui précède chaque match du plan du jour, relève les compositions chez toutes les sources
// (FotMob, 365Scores, ESPN, LiveScore), les recoupe (3 sources identiques minimum) et publie le résultat dans
// data/server/lineups/<jour UTC>.json. Le téléphone s'en sert quand ses propres sources ne répondent pas assez ; il ne fait aucune
// analyse ici : le serveur ne fait que collecter et envoyer.
import { hubDateKey, hubLineups } from '../src/api/footballDataAPIs/liveDataHub';
import { buildConsensus, LINEUP_WINDOW_MIN, type LineupConsensus } from '../src/core/coaches/lineupConsensus';
import { SERVER_LINEUPS_DIR } from '../src/core/serverFeed';
import { plannedMatches } from './collector';
import { repoPut } from './github';
import { log } from './log';

const published = new Map<string, string>();
const current: Record<string, Record<string, LineupConsensus & { home_team: string; away_team: string }>> = {};

export async function collectLineups(): Promise<void> {
  const day = hubDateKey();
  const soon = plannedMatches().filter((m) => {
    const minutes = (Date.parse(m.kickoff ?? '') - Date.now()) / 60_000;
    return Number.isFinite(minutes) && minutes <= LINEUP_WINDOW_MIN + 5 && minutes >= -15;
  });
  if (!soon.length) return;
  const mine = (current[day] ??= {});
  let changed = false;
  for (const m of soon) {
    const key = `${m.home} - ${m.away}`;
    if (mine[key]?.ok) continue; // déjà recoupé : les compositions ne bougent plus
    const consensus = buildConsensus(await hubLineups(m.home, m.away, day).catch(() => []));
    const stamp = JSON.stringify(consensus.ok ? [consensus.sources, consensus.home.starters, consensus.away.starters] : consensus.reason);
    if (published.get(key) === stamp) continue;
    published.set(key, stamp);
    mine[key] = { ...consensus, home_team: m.home, away_team: m.away };
    changed = true;
  }
  if (!changed) return;
  const path = `${SERVER_LINEUPS_DIR}/${day}.json`;
  const ok = await repoPut(path, JSON.stringify({ day, updatedAt: new Date().toISOString(), matches: mine }), `[serveur PC] compositions ${day}`).catch(() => false);
  log(`Compositions recoupées : ${Object.values(mine).filter((x) => x.ok).length}/${soon.length} match(s) publié(s) (${ok ? 'ok' : 'échec'}).`);
}
