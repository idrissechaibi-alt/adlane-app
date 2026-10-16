// État d'un pari en direct pour l'affichage : en cours, réussi ou perdu —
// vérifié à chaque actualisation de l'écran, sans attendre le bilan horaire.
// Match terminé : même règlement que le bilan (dailyReview.ts). Match en
// cours : un pari déjà acquis ("Plus de 4.5 cartons" avec 5 cartons) ou déjà
// perdu ("Moins de 2.5 buts" à 3 buts) est annoncé tout de suite.

import { InPlayProposal, InPlayProposalLeg } from './learnStore';
import { FinalResult, settleReprojectedLeg } from './dailyReview';
import { HubPlayerShots, hubFinalResult, hubLiveConsensus, hubFirstHalfGoals, hubLiveStatus, hubPlayerShots, hubStats } from '../api/footballDataAPIs/liveDataHub';
import { playerSotFromSelection } from './playerShots';
import { getHalfTimeCounts, getHalfTimeGoals } from './liveStatsStore';

export type LegStatus = 'won' | 'lost' | 'pending';

function lineOf(selection: string): { side: 'plus' | 'moins'; line: number } | null {
  const m = /(plus|moins) de\s+(\d+(?:[.,]\d+)?)/i.exec(selection);
  return m ? { side: m[1].toLowerCase() as 'plus' | 'moins', line: Number(m[2].replace(',', '.')) } : null;
}

/** Verdict déjà certain pendant le match (comptage qui a franchi la ligne). */
function decidedEarly(leg: InPlayProposalLeg, live: { homeGoals: number; awayGoals: number; statusShort: string }, counts: { all?: { corners: number; cards: number; fouls: number } | null; firstHalf?: { corners: number; cards: number; fouls: number } | null; players?: HubPlayerShots[] | null; htGoals?: { goals: number; certain: boolean } | null }): LegStatus {
  const sel = leg.selection;
  const goals = live.homeGoals + live.awayGoals;
  if (leg.market === 'total_buts') {
    const line = lineOf(sel)?.line ?? 2.5;
    if (/moins/i.test(sel) && goals > line) return 'lost';
    if (!/moins/i.test(sel) && goals > line) return 'won';
  }
  if (leg.market === 'btts' && live.homeGoals > 0 && live.awayGoals > 0) {
    return /\(non\)|ne marquent pas/i.test(sel) ? 'lost' : 'won';
  }
  if (leg.market === 'buts_1ere_mt' && live.statusShort === '1H' && goals > 0) {
    return /0-0|pas de but/i.test(sel) ? 'lost' : 'won';
  }
  // Pause passée : le score de la mi-temps vient de nos relevés minute par minute (un but vu avant la 45e est acquis).
  if (leg.market === 'buts_1ere_mt' && live.statusShort !== '1H' && counts.htGoals) {
    const { goals: ht, certain } = counts.htGoals;
    const wantsNone = /0-0|pas de but/i.test(sel);
    if (ht > 0) return wantsNone ? 'lost' : 'won';
    if (certain) return wantsNone ? 'won' : 'lost';
  }
  if (leg.market === 'tirs_cadres') {
    const l = lineOf(sel);
    const value = playerSotFromSelection(sel, counts.players ?? null);
    if (!l || value == null) return 'pending';
    if (value > l.line) return l.side === 'plus' ? 'won' : 'lost';
    return 'pending';
  }
  if (leg.market === 'corners' || leg.market === 'cartons' || leg.market === 'fautes') {
    const l = lineOf(sel);
    if (!l) return 'pending';
    const fullMatch = /sur le match/i.test(sel);
    // 1ère MT : le compte du match vaut celui de la 1ère MT tant qu'on y est.
    const period = fullMatch ? counts.all : live.statusShort === '1H' ? counts.all : counts.firstHalf;
    if (!period) return 'pending';
    const value = leg.market === 'corners' ? period.corners : leg.market === 'cartons' ? period.cards : period.fouls;
    if (leg.market === 'fautes' && !value) return 'pending';
    if (value > l.line) return l.side === 'plus' ? 'won' : 'lost';
    // 1ère mi-temps terminée sans que la ligne soit franchie : « Moins de » gagné, « Plus de » perdu, dès la pause.
    if (!fullMatch && live.statusShort !== '1H') return l.side === 'plus' ? 'lost' : 'won';
  }
  return 'pending';
}

const cache = new Map<string, { at: number; status: LegStatus }>();
const CHECK_INTERVAL_MS = 50_000;

/**
 * Verdict déjà certain d'un pari PENDANT le match, d'après les sources live gratuites
 * uniquement (LiveScore, FotMob, 365Scores, ESPN, AllSportsApi, TheSportsDB) :
 * « Plus de 1.5 buts » à 2 buts est gagné, « Moins de 2.5 buts » à 3 buts est perdu.
 * 'pending' si le match n'est pas en cours ou si rien n'est encore acquis.
 */
export async function liveLegVerdict(leg: InPlayProposalLeg, dateKey: string): Promise<LegStatus> {
  const live0 = await hubLiveStatus(leg.homeTeam, leg.awayTeam).catch(() => null);
  if (!live0 || !['1H', 'HT', '2H'].includes(live0.statusShort)) return 'pending';
  // Score confirmé par AU MOINS 2 sources, sinon aucun verdict en cours de match (une source isolée peut se tromper :
  // « Plus de 2.5 buts » donné gagné sur un match fini à 2-0). Le règlement final, lui, recalcule toujours tout.
  const consensus = await hubLiveConsensus(leg.homeTeam, leg.awayTeam).catch(() => null);
  if (!consensus || consensus.agree < 2) return 'pending';
  const live = { ...live0, homeGoals: consensus.match.homeGoals, awayGoals: consensus.match.awayGoals };
  const stats = await hubStats(leg.homeTeam, leg.awayTeam, dateKey).catch(() => null);
  // Pari de 1ère mi-temps après la pause sans stats de 1ère MT chez les sources : notre relevé pris pendant la pause.
  if (stats && !stats.firstHalf && live.statusShort !== '1H' && ['corners', 'cartons', 'fautes'].includes(leg.market) && !/sur le match/i.test(leg.selection)) {
    const ht = await getHalfTimeCounts(`${leg.homeTeam} - ${leg.awayTeam}`).catch(() => null);
    if (ht) stats.firstHalf = ht as any;
  }
  const htFromSource = live.hasHalfTime ? { goals: live.homeGoalsHT + live.awayGoalsHT, certain: true } : null;
  const htEspn = leg.market === 'buts_1ere_mt' && live.statusShort !== '1H' && !htFromSource ? await hubFirstHalfGoals(leg.homeTeam, leg.awayTeam, dateKey).catch(() => null) : null;
  const htGoals = htFromSource ?? (htEspn != null ? { goals: htEspn, certain: true } : null) ?? (leg.market === 'buts_1ere_mt' && live.statusShort !== '1H' ? await getHalfTimeGoals(`${leg.homeTeam} - ${leg.awayTeam}`).catch(() => null) : null);
  const players = leg.market === 'tirs_cadres' ? await hubPlayerShots(leg.homeTeam, leg.awayTeam, dateKey).catch(() => null) : null;
  return decidedEarly(leg, live, { all: stats?.all, firstHalf: stats?.firstHalf, players, htGoals });
}

export async function checkLegStatus(leg: InPlayProposalLeg, dateKey: string): Promise<LegStatus> {
  const key = `${dateKey}|${leg.fixtureId}|${leg.market}|${leg.selection}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CHECK_INTERVAL_MS) return hit.status;

  let status: LegStatus = 'pending';
  try {
    const liveNow = await hubLiveStatus(leg.homeTeam, leg.awayTeam).catch(() => null);
    const inPlay = !!liveNow && ['1H', 'HT', '2H'].includes(liveNow.statusShort);
    if (inPlay) {
      // Match en cours : verdict certain d'après les sources gratuites, rien d'autre
      // (un verdict enregistré à tort ne s'affiche pas tant que le live ne le confirme pas).
      status = await liveLegVerdict(leg, dateKey);
    } else {
      // Match terminé : le verdict se RECALCULE toujours sur le résultat final des sources ; la valeur enregistrée (réglée en
      // cours de match) ne sert qu'aux jours passés sans résultat final disponible.
      // La mi-temps n'est exigée que des paris qui en dépendent : un score final suffit aux autres.
      const needsHalf = leg.market === 'buts_1ere_mt' || (['corners', 'cartons', 'fautes'].includes(leg.market) && !/sur le match/i.test(leg.selection));
      const final = await hubFinalResult(leg.homeTeam, leg.awayTeam, dateKey, { needHalfTime: needsHalf });
      if (final) {
        const result = { ...final } as FinalResult;
        if (['corners', 'cartons', 'fautes'].includes(leg.market) && /sur le match/i.test(leg.selection) && (leg.market === 'corners' ? result.cornersFT : leg.market === 'cartons' ? result.cardsFT : result.foulsFT) == null) {
          const st = await hubStats(leg.homeTeam, leg.awayTeam, dateKey).catch(() => null);
          result.cornersFT ??= st?.all?.corners;
          result.cardsFT ??= st?.all?.cards;
          result.foulsFT ??= st?.all?.fouls || undefined;
        }
        if (leg.market === 'tirs_cadres') result.playerSot = (await hubPlayerShots(leg.homeTeam, leg.awayTeam, dateKey).catch(() => null)) ?? undefined;
        const won = settleReprojectedLeg(leg.market, leg.selection, result);
        if (won != null) status = won ? 'won' : 'lost';
      } else if (leg.settled && leg.won != null && dateKey < new Date().toISOString().slice(0, 10)) {
        status = leg.won ? 'won' : 'lost';
      }
    }
  } catch {
    // reste "en cours" ; retenté à la prochaine actualisation
  }
  cache.set(key, { at: Date.now(), status });
  return status;
}

/** Combiné : perdu dès qu'une jambe l'est, réussi quand toutes le sont. */
export async function checkProposalStatus(proposal: InPlayProposal): Promise<LegStatus> {
  return combineLegStatuses(await checkLegStatuses(proposal));
}

/** État de chaque jambe, dans l'ordre du combiné. */
export async function checkLegStatuses(proposal: InPlayProposal): Promise<LegStatus[]> {
  const dateKey = proposal.createdAt.slice(0, 10);
  return Promise.all(proposal.legs.map((l) => checkLegStatus(l, dateKey).catch(() => 'pending' as LegStatus)));
}

export function combineLegStatuses(statuses: LegStatus[]): LegStatus {
  if (statuses.includes('lost')) return 'lost';
  return statuses.length > 0 && statuses.every((s) => s === 'won') ? 'won' : 'pending';
}

/** Compteur en direct d'une jambe : minute, score ou compteur du marché (domicile-extérieur), ligne à atteindre. */
export interface LegCounter {
  minute: number;
  status: string;
  /** Ce qui est compté, en clair (« Buts », « Corners », « Cartons jaunes », « Fautes », nom du joueur). */
  what: string;
  /** Domicile-extérieur, ou valeur du joueur. */
  label: string;
  current: number;
  /** Ligne du pari (2.5, 12.5…) ; null pour un pari sans ligne (BTTS, 1X2). */
  target: number | null;
  side: 'plus' | 'moins' | null;
}

const counterCache = new Map<string, { at: number; value: LegCounter | null }>();

export async function liveLegCounter(leg: InPlayProposalLeg, dateKey: string): Promise<LegCounter | null> {
  const key = `${dateKey}|${leg.homeTeam}|${leg.awayTeam}|${leg.selection}`;
  const hit = counterCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  let value: LegCounter | null = null;
  try {
    const consensus = await hubLiveConsensus(leg.homeTeam, leg.awayTeam).catch(() => null);
    const live = consensus?.match ?? (await hubLiveStatus(leg.homeTeam, leg.awayTeam).catch(() => null));
    if (live && ['1H', 'HT', '2H'].includes(live.statusShort)) {
      const l = lineOf(leg.selection);
      const base = { minute: live.minute, status: live.statusShort, target: l?.line ?? null, side: l?.side ?? null };
      if (['total_buts', 'btts', '1X2', 'buts_1ere_mt'].includes(leg.market)) {
        value = { ...base, what: 'Score', label: `${live.homeGoals}-${live.awayGoals}`, current: live.homeGoals + live.awayGoals };
      } else if (['corners', 'cartons', 'fautes'].includes(leg.market)) {
        const stats = await hubStats(leg.homeTeam, leg.awayTeam, dateKey).catch(() => null);
        const firstHalfBet = !/sur le match/i.test(leg.selection);
        const period = firstHalfBet && live.statusShort !== '1H' ? stats?.firstHalf : stats?.all;
        if (period) {
          const [h, a, what] =
            leg.market === 'corners' ? [period.cornersHome, period.cornersAway, 'Corners']
            : leg.market === 'cartons' ? [period.cardsHome, period.cardsAway, 'Cartons jaunes']
            : [period.foulsHome ?? 0, period.foulsAway ?? 0, 'Fautes'];
          value = { ...base, what: String(what), label: `${h}-${a}`, current: Number(h) + Number(a) };
        }
      } else if (leg.market === 'tirs_cadres') {
        const players = await hubPlayerShots(leg.homeTeam, leg.awayTeam, dateKey).catch(() => null);
        const sot = playerSotFromSelection(leg.selection, players);
        const who = /—\s*(.+?)\s*\(/.exec(leg.selection)?.[1] ?? 'Joueur';
        if (sot != null) value = { ...base, what: who, label: `${sot} tir(s) cadré(s)`, current: sot };
      }
    }
  } catch {
    value = null;
  }
  counterCache.set(key, { at: Date.now(), value });
  return value;
}
