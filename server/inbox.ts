// Saisies de l'utilisateur déposées par le téléphone (src/core/serverLink.ts) : appliquées ici avec les mêmes fonctions.
import { SERVER_INBOX_DIR, UserAction } from '../src/core/serverLink';
import { setLegBookOdds } from '../src/core/learnStore';
import { recordOddsAndLearn } from '../src/core/oddsLoop';
import { markLineAvailable, markLineUnavailable, markMarketOff } from '../src/core/lineLimits';
import { saveBet } from '../src/database/storage';
import { repoDelete, repoList, repoText } from './github';
import { log } from './log';

const HANDLERS: Record<UserAction['name'], (...args: any[]) => unknown> = {
  saveBet: (bet) => saveBet(bet),
  setLegBookOdds: (id, odds) => setLegBookOdds(id, odds),
  recordOddsAndLearn: (proposal, odds, ctx) => recordOddsAndLearn(proposal, odds, ctx),
  markLineAvailable: (unit, line, expected) => markLineAvailable(unit, line, expected),
  markLineUnavailable: (unit, line, expected) => markLineUnavailable(unit, line, expected),
  markMarketOff: (fixtureId, key) => markMarketOff(fixtureId, key),
};

/** Applique les saisies en attente, dans l'ordre où elles ont été faites. Renvoie le nombre appliqué. */
export async function processInbox(): Promise<number> {
  const files = (await repoList(SERVER_INBOX_DIR)).filter((f) => f.type === 'file' && f.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
  let done = 0;
  for (const f of files) {
    try {
      const raw = await repoText(f.path);
      const action: UserAction | null = raw ? JSON.parse(raw) : null;
      const handler = action ? HANDLERS[action.name] : undefined;
      if (action && handler) {
        await handler(...action.args);
        log(`Saisie du téléphone appliquée : ${action.name} (${action.at})`);
        done++;
      } else {
        log(`Saisie ignorée (format inconnu) : ${f.name}`);
      }
    } catch (e: any) {
      log(`Saisie ${f.name} en échec : ${e?.message ?? e}`);
    }
    await repoDelete(f.path, f.sha, `[serveur PC] Saisie traitée : ${f.name}`).catch(() => false);
  }
  return done;
}
