// Mémoire des avis d'avant-match, lue par l'analyse en direct (20e / 60e) et par le bilan d'après-match : l'entraîneur confronte ce
// qu'il avait annoncé (compositions officielles à l'appui) à ce que le match montre, puis au résultat. Module séparé pour que
// l'analyse et le bilan la lisent sans dépendre de coachPreMatch (qui dépend lui-même de l'analyse).

import AsyncStorage from '../kvStore';
import { namesLikelyMatch, normalizeTeamName } from '../teamNameMatch';

export const PREMATCH_STORE_KEY = '@coach_prematch_v2';

interface StoredOpinion {
  day: string;
  home: string;
  away: string;
  summary_fr: string;
  lineup_fr?: string;
  lineup_text?: string;
  opinions?: Array<{ market: string; direction: string; stance: string; confidence: number }>;
}

/** Résumé de l'avis d'avant-match d'un match (null s'il n'y en a pas eu), noms d'équipes rapprochés d'une source à l'autre. */
export async function readPreMatchBrief(home: string, away: string, day: string): Promise<string | null> {
  try {
    const all: Record<string, StoredOpinion> = JSON.parse((await AsyncStorage.getItem(PREMATCH_STORE_KEY)) ?? '{}');
    const h = normalizeTeamName(home);
    const a = normalizeTeamName(away);
    const op = Object.values(all).find((o) => o.day === day && namesLikelyMatch(h, normalizeTeamName(o.home)) && namesLikelyMatch(a, normalizeTeamName(o.away)));
    if (!op) return null;
    const grid = (op.opinions ?? []).slice(0, 6).map((o) => `${o.market} ${o.direction} : ${o.stance} (${Math.round(o.confidence * 100)} %)`).join(' · ');
    const clip = (s: string | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : '');
    return [
      `Avis : ${clip(op.summary_fr, 600)}`,
      op.lineup_text ? `Compositions officielles : ${clip(op.lineup_text, 700)}` : '',
      op.lineup_fr ? `Effet des compositions selon toi : ${clip(op.lineup_fr, 300)}` : '',
      grid ? `Tes avis par marché : ${grid}` : '',
    ].filter(Boolean).join('\n');
  } catch {
    return null;
  }
}
