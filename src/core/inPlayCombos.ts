// Scan en direct — deux points de décision fixes, plus rentables que les
// cotes d'avant-match seules (devenues trop basses, demande explicite) :
//
//   - 20e minute (milieu de 1ère mi-temps) : but 1ère MT ou pas, corners et
//     cartons 1ère MT (projection statistique Poisson recalibrée sur les
//     moyennes de saison Football-Data.co.uk), BTTS et total du match
//     (projection sur le match ENTIER, pas seulement la 1ère MT).
//   - 60e minute : reste du match (résultat, BTTS, total buts), recalibré
//     avec tout ce qui s'est passé depuis le coup d'envoi.
//
// DEUX pipelines séparés, sur le même principe mais des ressources et une
// présentation différentes (demande explicite) :
//
//   A) Paris RÉELS — les 5 grands championnats seulement, ceux sur lesquels
//      de l'argent réel est misé. Utilise TOUTES les ressources disponibles
//      (cotes de marché, Football-Data.co.uk, mémoire d'auto-apprentissage,
//      contexte déjà collecté). Présentation calquée sur l'ancien Planning
//      du Jour : par CRÉNEAU HORAIRE (pas par match isolé) — un créneau de
//      moins de 3 matchs propose un pari SIMPLE par match (sa meilleure
//      jambe) ; un créneau de 3 matchs ou plus propose des COMBOS de 3
//      jambes (une par match DIFFÉRENT du créneau, jamais plusieurs marchés
//      du même match combinés ensemble), jusqu'à 2 combos par créneau et par
//      checkpoint. Seules ces propositions sont notifiées et affichées dans
//      "Combos en direct du jour".
//   B) Paris FICTIFS — tout l'univers de matchs suivi (matchUniverse, ~28
//      pays), UNIQUEMENT avec des ressources libres de droit (Football-
//      Data.co.uk pour les buts attendus ET les corners/cartons, aucune
//      cote, aucune API payante). AUCUN combo : une batterie de paris
//      SIMPLES indépendants, un par marché qualifié (le maximum possible),
//      jamais enrichis par Omniroute — juste une mesure statistique brute
//      pour comparer estimation vs réalité marché par marché et affûter le
//      modèle utilisé ensuite sur les vrais matchs. Jamais notifié, jamais
//      affiché comme un vrai pari. Ne retraite jamais un match déjà couvert
//      par le pipeline réel.
//
// Dans les deux cas, les probabilités sont TOUJOURS calculées
// statistiquement (poisson.ts), jamais devinées par une IA. Omniroute
// n'intervient QUE pour le pipeline réel, pour enrichir le raisonnement de
// chaque jambe avec le contexte disponible — il ne touche jamais aux
// chiffres.

import { getDailyPlan } from './scheduler';
import { buildScheduledMatches, ScheduledMatch } from './dailyWorkflow';
import { fetchLiveFixtures, LiveFixture } from './halftimeMonitor';
import { getAPIConfig } from '../api/multiAPIManager';
import { getHistoricalPriors, estimateExpectedGoalsFromHistory } from './footballDataCoUk';
import { getStoredUniverse, UniverseMatch } from './matchUniverse';
import {
  estimateRemainingMatchMarket,
  estimateRemainingFirstHalfMarket,
  remainingFirstHalfEventFraction,
  pickHighestConfidentOverLine,
  SecondHalfMarket,
} from './poisson';
import { getAgentLearningDigest } from './autoLearn';
import { getFocusNoteByTeams, renderFocusNote, loadOmnirouteConfig } from './focusEnrichment';
import { askOmnirouteLight } from './omniroute';
import {
  InPlayProposal,
  InPlayProposalLeg,
  TrackedMarket,
  readInPlayProposals,
  readPendingSnapshots,
  writeInPlayProposals,
} from './learnStore';
import { sendLocalNotification } from './notifications';
import { normalizeTeamName, namesLikelyMatch } from './teamNameMatch';
import { spendBudget } from './requestBudget';

const CHECKPOINT20_MIN_MINUTE = 18;
const CHECKPOINT20_MAX_MINUTE = 24;
const CHECKPOINT60_MIN_MINUTE = 58;
const CHECKPOINT60_MAX_MINUTE = 64;

/** Probabilité minimale pour qu'une jambe soit retenue (solo, combo, ou pari fictif). */
const MIN_LEG_PROB = 0.55;
/** Seuil interne utilisé pour choisir la ligne over/under la plus haute encore fiable (corners/cartons). */
const LINE_PICK_THRESHOLD = 0.55;
/** Au-delà de ce nombre de matchs dans le créneau : combos plutôt que paris simples (paris réels). */
const SLOT_COMBO_THRESHOLD = 3;
/** Nombre maximum de combos émis par créneau et par checkpoint (paris réels). */
const MAX_COMBOS_PER_SLOT = 2;

/** Identité minimale d'un match, commune aux deux pipelines. */
interface MatchRef {
  homeTeam: string;
  awayTeam: string;
  league: string;
  leagueId: string;
}

interface CandidateLeg {
  market: TrackedMarket;
  selection: string;
  prob: number;
  evidence: string;
}

/**
 * Choisit le bon côté (Oui/Non, Over/Under) d'un marché binaire déjà projeté
 * par poisson.ts : le côté favorisé si sa proba dépasse 50%, sinon son
 * inverse — jamais les deux à la fois (redondant).
 */
function pickBinarySide(market: TrackedMarket, projected: SecondHalfMarket, invertedSelection: string): CandidateLeg {
  if (projected.estimated_prob >= 0.5) {
    return { market, selection: projected.selection, prob: projected.estimated_prob, evidence: projected.reasoning };
  }
  return {
    market,
    selection: invertedSelection,
    prob: 1 - projected.estimated_prob,
    evidence: `Probabilité inverse (${(projected.estimated_prob * 100).toFixed(0)}% pour "${projected.selection}") : ${projected.reasoning}`
  };
}

/** Corners/cartons déjà comptés en 1ère mi-temps, si un instantané liveMarkers récent existe pour ce match (best-effort, jamais bloquant). */
function observedFirstHalfCounts(fixtureId: number): { corners?: number; cards?: number } {
  const snapshot = readPendingSnapshots()
    .filter((o) => o.fixtureId === fixtureId)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!snapshot) return {};

  const corners = snapshot.markers.cornersHome != null || snapshot.markers.cornersAway != null
    ? (snapshot.markers.cornersHome ?? 0) + (snapshot.markers.cornersAway ?? 0)
    : undefined;
  const cards = snapshot.markers.cardsHome != null || snapshot.markers.cardsAway != null
    ? (snapshot.markers.cardsHome ?? 0) + (snapshot.markers.cardsAway ?? 0)
    : undefined;

  return { corners, cards };
}

/**
 * Jambes candidates du checkpoint 20e minute : but 1ère MT, corners/cartons
 * 1ère MT (si moyennes de saison disponibles), BTTS et total du match. Les
 * jambes buts/BTTS/total ne sont tentées que si preMatchExpectedGoals est
 * disponible ; les jambes corners/cartons sont indépendantes et toujours
 * tentées (Football-Data.co.uk, libre d'accès dans les deux pipelines).
 */
async function buildLegs20(
  match: MatchRef,
  fixtureId: number,
  live: LiveFixture,
  preMatchExpectedGoals: { home: number; away: number } | null
): Promise<CandidateLeg[]> {
  const legs: CandidateLeg[] = [];
  const currentScore = { home: live.homeGoals, away: live.awayGoals };
  const elapsedMinutes = live.minute;

  // 1) But 1ère mi-temps ou pas — rien à prédire si déjà marqué (certain).
  if (preMatchExpectedGoals && currentScore.home + currentScore.away === 0) {
    const est = estimateRemainingFirstHalfMarket({ preMatchExpectedGoals, elapsedMinutes, currentScore });
    const m = est.markets[0];
    legs.push({ market: 'buts_1ere_mt', selection: 'Oui, un but avant la pause', prob: m.estimated_prob, evidence: m.reasoning });
  }

  // 2) Corners / 3) Cartons 1ère mi-temps — projection sur le reste de la 1ère
  // MT + ce qui est déjà compté en direct (best-effort, jamais bloquant).
  const priors = await getHistoricalPriors(match.leagueId, match.homeTeam, match.awayTeam).catch(() => null);
  if (priors) {
    const fraction = remainingFirstHalfEventFraction(elapsedMinutes);
    const observed = observedFirstHalfCounts(fixtureId);

    const cornersLambda = (priors.home.cornersFor + priors.away.cornersFor) * fraction;
    const cornersLine = pickHighestConfidentOverLine(cornersLambda, LINE_PICK_THRESHOLD, observed.corners ?? 0);
    if (cornersLine) {
      legs.push({
        market: 'corners',
        selection: `Plus de ${cornersLine.line} corners en 1ère mi-temps`,
        prob: cornersLine.prob,
        evidence: `${observed.corners ?? 0} corner(s) déjà compté(s) + ${cornersLambda.toFixed(1)} attendus sur le reste de la 1ère MT (moyennes de saison Football-Data.co.uk).`
      });
    }

    const cardsLambda = (priors.home.cardsFor + priors.away.cardsFor) * fraction;
    const cardsLine = pickHighestConfidentOverLine(cardsLambda, LINE_PICK_THRESHOLD, observed.cards ?? 0);
    if (cardsLine) {
      legs.push({
        market: 'cartons',
        selection: `Plus de ${cardsLine.line} cartons en 1ère mi-temps`,
        prob: cardsLine.prob,
        evidence: `${observed.cards ?? 0} carton(s) déjà compté(s) + ${cardsLambda.toFixed(1)} attendus sur le reste de la 1ère MT (moyennes de saison Football-Data.co.uk).`
      });
    }
  }

  // 4) BTTS / 5) Total du match — projection sur le match ENTIER, pas
  // seulement la 1ère MT (déjà acquis si les deux ont déjà marqué / si le
  // total dépasse déjà la ligne : rien à prédire, on ne propose pas).
  if (preMatchExpectedGoals) {
    const fullEst = estimateRemainingMatchMarket({ preMatchExpectedGoals, elapsedMinutes, currentScore });
    const bttsMarket = fullEst.markets.find((m) => m.market === 'FT_btts_reprojete');
    if (bttsMarket && !(currentScore.home > 0 && currentScore.away > 0)) {
      legs.push(pickBinarySide('btts', bttsMarket, 'Les deux équipes ne marquent pas toutes les deux (Non)'));
    }
    const overMarket = fullEst.markets.find((m) => m.market === 'FT_over_2_5_reprojete');
    if (overMarket && !(currentScore.home + currentScore.away > 2.5)) {
      legs.push(pickBinarySide('total_buts', overMarket, 'Moins de 2.5 buts (total match)'));
    }
  }

  return legs;
}

/**
 * Jambes candidates du checkpoint 60e minute : reste du match uniquement —
 * toutes basées sur les buts, donc rien à construire si preMatchExpectedGoals
 * est indisponible.
 */
function buildLegs60(
  live: LiveFixture,
  preMatchExpectedGoals: { home: number; away: number } | null
): CandidateLeg[] {
  if (!preMatchExpectedGoals) return [];

  const legs: CandidateLeg[] = [];
  const currentScore = { home: live.homeGoals, away: live.awayGoals };
  const elapsedMinutes = live.minute;

  const est = estimateRemainingMatchMarket({ preMatchExpectedGoals, elapsedMinutes, currentScore });

  const resultMarket = est.markets.find((m) => m.market === 'FT_1X2_reprojete');
  if (resultMarket) {
    legs.push({ market: '1X2', selection: resultMarket.selection, prob: resultMarket.estimated_prob, evidence: resultMarket.reasoning });
  }

  const bttsMarket = est.markets.find((m) => m.market === 'FT_btts_reprojete');
  if (bttsMarket && !(currentScore.home > 0 && currentScore.away > 0)) {
    legs.push(pickBinarySide('btts', bttsMarket, 'Les deux équipes ne marquent pas toutes les deux (Non)'));
  }
  const overMarket = est.markets.find((m) => m.market === 'FT_over_2_5_reprojete');
  if (overMarket && !(currentScore.home + currentScore.away > 2.5)) {
    legs.push(pickBinarySide('total_buts', overMarket, 'Moins de 2.5 buts (total match)'));
  }

  return legs;
}

interface LegWithContext {
  leg: CandidateLeg;
  fixtureId: number;
  match: MatchRef;
  live: LiveFixture;
}

function toProposalLeg(item: LegWithContext): InPlayProposalLeg {
  return {
    market: item.leg.market,
    selection: item.leg.selection,
    prob: item.leg.prob,
    evidence: item.leg.evidence,
    fixtureId: item.fixtureId,
    league: item.match.league,
    homeTeam: item.match.homeTeam,
    awayTeam: item.match.awayTeam,
    scoreLabel: `${item.live.homeGoals}-${item.live.awayGoals}`,
  };
}

/**
 * Enrichit le raisonnement de chaque jambe via Omniroute, à partir du
 * contexte déjà disponible (mémoire d'auto-apprentissage, forme des
 * équipes) — ne modifie JAMAIS les probabilités calculées. Fonctionne aussi
 * bien pour un pari simple (1 jambe) qu'un combo multi-matchs (plusieurs).
 * Best-effort : toute panne (config absente, réseau, JSON invalide) renvoie
 * les jambes telles quelles, jamais bloquant.
 */
async function formulateWithOmniroute(items: LegWithContext[], checkpointLabel: string): Promise<LegWithContext[]> {
  if (items.length === 0) return items;

  const omnirouteConfig = await loadOmnirouteConfig();
  if (!omnirouteConfig) return items;

  let digest: string | null = null;
  try { digest = getAgentLearningDigest(); } catch { /* pas encore de règle apprise : silencieux */ }

  const focusContexts = items
    .map((item) => {
      try {
        const note = renderFocusNote(getFocusNoteByTeams(item.match.homeTeam, item.match.awayTeam));
        return note ? `${item.match.homeTeam} vs ${item.match.awayTeam} : ${note}` : null;
      } catch {
        return null;
      }
    })
    .filter((n): n is string => Boolean(n));

  const legsText = items
    .map((item, i) =>
      `${i + 1}. ${item.match.homeTeam} vs ${item.match.awayTeam} (${item.match.league}, minute ${item.live.minute}, score ${item.live.homeGoals}-${item.live.awayGoals}) — ` +
      `[${item.leg.market}] ${item.leg.selection} — probabilité calculée : ${(item.leg.prob * 100).toFixed(0)}% (${item.leg.evidence})`
    )
    .join('\n');

  const systemPrompt =
    "Tu formules des pronostics de football EN COURS DE MATCH à partir de probabilités DÉJÀ CALCULÉES statistiquement (modèle de Poisson recalibré en direct). " +
    "RÈGLE ABSOLUE : ne recalcule jamais ces probabilités, ne les remets jamais en question, ne les modifie jamais — reprends-les EXACTEMENT telles quelles. " +
    "Ton seul rôle : enrichir le raisonnement de chaque jambe avec le contexte fourni (mémoire d'auto-apprentissage, forme des équipes), en français, factuel, sans invention. " +
    'Réponds en JSON strict, rien autour : {"legs": [{"market": "string", "reasoning": "string"}]} — un objet par jambe, EXACTEMENT dans le même ordre, le même nombre, et le même identifiant de marché.';

  const userPrompt =
    `Checkpoint : ${checkpointLabel}${items.length > 1 ? ` — combo de ${items.length} matchs du même créneau` : ' — pari simple'}\n\n` +
    `Jambes calculées (NE PAS changer les probabilités) :\n${legsText}\n` +
    (digest ? `\n${digest}\n` : '') +
    (focusContexts.length > 0 ? `\nContexte déjà collecté sur ces matchs :\n${focusContexts.join('\n')}\n` : '');

  try {
    const result = await askOmnirouteLight(systemPrompt, userPrompt, omnirouteConfig);
    if (!result) return items;

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result.text);
    const enrichedLegs: Array<{ market: string; reasoning: string }> = parsed.legs || [];

    return items.map((item, i) => {
      const enriched = enrichedLegs[i];
      // Garde-fou : si l'ordre/le marché renvoyé ne correspond pas exactement,
      // on garde le raisonnement d'origine plutôt que de risquer un mélange.
      if (!enriched?.reasoning || enriched.market !== item.leg.market) return item;
      return { ...item, leg: { ...item.leg, evidence: enriched.reasoning } };
    });
  } catch (error: any) {
    console.warn('[Scan en direct] Enrichissement Omniroute échoué (chiffres calculés conservés):', error.message);
    return items;
  }
}

function buildProposalFromItems(
  kind: 'minute20' | 'minute60',
  items: LegWithContext[],
  window: string,
  real: boolean
): InPlayProposal | null {
  if (items.length === 0) return null;

  const combinedProb = items.reduce((product, item) => product * item.leg.prob, 1);

  return {
    id: `inplay-${kind}-${items.map((i) => i.fixtureId).join('-')}`,
    kind,
    createdAt: new Date().toISOString(),
    minute: items[0].live.minute,
    window,
    legs: items.map(toProposalLeg),
    combinedProb,
    real,
  };
}

async function notifyProposal(proposal: InPlayProposal): Promise<void> {
  const legsText = proposal.legs
    .map((l) => `• ${l.homeTeam} ${l.scoreLabel} ${l.awayTeam} — ${l.selection} (${(l.prob * 100).toFixed(0)}%)`)
    .join('\n');
  const emoji = proposal.kind === 'minute20' ? '⚡' : '⏱️';
  const title = proposal.legs.length === 1
    ? `${emoji} ${proposal.minute}e — ${proposal.legs[0].homeTeam} ${proposal.legs[0].scoreLabel} ${proposal.legs[0].awayTeam}`
    : `${emoji} ${proposal.minute}e — Combo (${proposal.legs.length} matchs)`;
  await sendLocalNotification(
    title,
    `${proposal.window} — ${(proposal.combinedProb * 100).toFixed(0)}% combiné\n${legsText}`,
    { kind: proposal.kind }
  );
}

function findLiveFixture(scheduled: { homeTeam: string; awayTeam: string }, liveFixtures: LiveFixture[]): LiveFixture | undefined {
  const sHome = normalizeTeamName(scheduled.homeTeam);
  const sAway = normalizeTeamName(scheduled.awayTeam);
  return liveFixtures.find((f) => {
    const fHome = normalizeTeamName(f.homeTeam);
    const fAway = normalizeTeamName(f.awayTeam);
    return (fHome === sHome || namesLikelyMatch(fHome, sHome)) && (fAway === sAway || namesLikelyMatch(fAway, sAway));
  });
}

function matchRefOfScheduled(m: ScheduledMatch): MatchRef {
  return { homeTeam: m.homeTeam, awayTeam: m.awayTeam, league: m.leagueName, leagueId: m.leagueId };
}

/**
 * Meilleure jambe (la plus probable, seuil MIN_LEG_PROB) d'un match candidat
 * à un checkpoint donné, ou null si aucune ne qualifie.
 */
async function bestLegFor(
  kind: 'minute20' | 'minute60',
  scheduled: ScheduledMatch,
  live: LiveFixture
): Promise<LegWithContext | null> {
  const match = matchRefOfScheduled(scheduled);
  const preMatchExpectedGoals = { home: scheduled.expectedHomeGoals, away: scheduled.expectedAwayGoals };

  const rawLegs = kind === 'minute20'
    ? await buildLegs20(match, live.fixtureId, live, preMatchExpectedGoals)
    : buildLegs60(live, preMatchExpectedGoals);

  const eligible = rawLegs.filter((l) => l.prob >= MIN_LEG_PROB).sort((a, b) => b.prob - a.prob);
  if (eligible.length === 0) return null;

  return { leg: eligible[0], fixtureId: live.fixtureId, match, live };
}

/**
 * Paris RÉELS d'un créneau, pour un checkpoint donné : pari simple par match
 * si le créneau a moins de SLOT_COMBO_THRESHOLD matchs (avec cotes
 * exploitables), sinon combos de 3 jambes (une par match différent),
 * jusqu'à MAX_COMBOS_PER_SLOT.
 */
async function processRealSlotCheckpoint(
  kind: 'minute20' | 'minute60',
  slotMatchCount: number,
  candidates: Array<{ scheduled: ScheduledMatch; live: LiveFixture }>,
  window: string,
  checkpointLabel: string,
  alreadyProposed: Set<string>,
  fresh: InPlayProposal[]
): Promise<void> {
  if (candidates.length === 0) return;

  const perMatch: LegWithContext[] = [];
  for (const { scheduled, live } of candidates) {
    const best = await bestLegFor(kind, scheduled, live);
    if (best) perMatch.push(best);
  }
  if (perMatch.length === 0) return;

  if (slotMatchCount < SLOT_COMBO_THRESHOLD) {
    // Paris simples : un par match candidat.
    for (const item of perMatch) {
      const [enriched] = await formulateWithOmniroute([item], checkpointLabel);
      const proposal = buildProposalFromItems(kind, [enriched], window, true);
      if (proposal) {
        fresh.push(proposal);
        alreadyProposed.add(`${item.fixtureId}-${kind}`);
        await notifyProposal(proposal);
      }
    }
    return;
  }

  // Combos : jusqu'à MAX_COMBOS_PER_SLOT, 3 jambes (matchs différents)
  // chacun, en partant des matchs les plus probables, sans jamais réutiliser
  // un même match dans deux combos du même créneau.
  if (perMatch.length < 3) return; // pas assez de matchs simultanément en direct pour former un combo

  const sorted = [...perMatch].sort((a, b) => b.leg.prob - a.leg.prob);
  for (let i = 0; i + 3 <= sorted.length && (i / 3) < MAX_COMBOS_PER_SLOT; i += 3) {
    const group = sorted.slice(i, i + 3);
    const enriched = await formulateWithOmniroute(group, checkpointLabel);
    const proposal = buildProposalFromItems(kind, enriched, window, true);
    if (proposal) {
      fresh.push(proposal);
      for (const item of group) alreadyProposed.add(`${item.fixtureId}-${kind}`);
      await notifyProposal(proposal);
    }
  }
}

/**
 * Un tour de scan. Appelé par la tâche de fond (toutes les ~15 min) et par
 * la boucle de premier plan (3 min). Ne notifie jamais deux fois le même
 * match pour le même checkpoint.
 */
export async function runInPlayComboTick(): Promise<number> {
  const apiConfig = await getAPIConfig();
  if (!apiConfig.apiFootball) return 0;

  if (!(await spendBudget('apiFootball'))) return 0;

  let liveFixtures: LiveFixture[];
  try {
    liveFixtures = await fetchLiveFixtures(apiConfig.apiFootball);
  } catch (error: any) {
    console.warn('[Scan en direct] Relevé live échoué:', error.message);
    return 0;
  }
  if (liveFixtures.length === 0) return 0;

  const existing = readInPlayProposals();
  // Réel : une jambe proposée bloque TOUT le match pour ce checkpoint (peu
  // importe le marché). Fictif : chaque marché est une jambe indépendante
  // (voir plus bas), donc seul CE marché précis est bloqué pour ce match.
  const alreadyProposed = new Set(
    existing.flatMap((p) =>
      p.real === false
        ? p.legs.map((l) => `${l.fixtureId}-${p.kind}-${l.market}`)
        : p.legs.map((l) => `${l.fixtureId}-${p.kind}`)
    )
  );
  const fresh: InPlayProposal[] = [];
  const claimedFixtureIds = new Set<number>();

  // A) Paris RÉELS — 5 grands championnats, par créneau horaire, toutes les
  // ressources disponibles.
  const plan = await getDailyPlan();
  if (plan) {
    for (const slot of plan.slots) {
      const { matches: slotMatches } = buildScheduledMatches([slot]);
      if (slotMatches.length === 0) continue;

      const candidates20: Array<{ scheduled: ScheduledMatch; live: LiveFixture }> = [];
      const candidates60: Array<{ scheduled: ScheduledMatch; live: LiveFixture }> = [];

      for (const scheduled of slotMatches) {
        const live = findLiveFixture(scheduled, liveFixtures);
        if (!live) continue;
        claimedFixtureIds.add(live.fixtureId);

        if (
          live.statusShort === '1H' &&
          live.minute >= CHECKPOINT20_MIN_MINUTE && live.minute <= CHECKPOINT20_MAX_MINUTE &&
          !alreadyProposed.has(`${live.fixtureId}-minute20`)
        ) {
          candidates20.push({ scheduled, live });
        }

        if (
          live.statusShort === '2H' &&
          live.minute >= CHECKPOINT60_MIN_MINUTE && live.minute <= CHECKPOINT60_MAX_MINUTE &&
          !alreadyProposed.has(`${live.fixtureId}-minute60`)
        ) {
          candidates60.push({ scheduled, live });
        }
      }

      await processRealSlotCheckpoint(
        'minute20', slotMatches.length, candidates20,
        `20e → pause + match complet`, '20e minute — 1ère mi-temps + BTTS/total du match',
        alreadyProposed, fresh
      );
      await processRealSlotCheckpoint(
        'minute60', slotMatches.length, candidates60,
        `60e → fin de match`, '60e minute — reste du match',
        alreadyProposed, fresh
      );
    }
  }

  // B) Paris FICTIFS (boucle d'auto-apprentissage) — tout l'univers de
  // matchs suivi, UNIQUEMENT des ressources libres de droit. AUCUN combo :
  // une batterie de paris SIMPLES indépendants, un par marché qualifié
  // (le maximum possible), pour comparer estimation vs réalité marché par
  // marché et affûter le modèle utilisé ensuite sur les vrais matchs — pas
  // pour imiter la présentation des vrais paris. Jamais notifié, jamais
  // affiché comme un vrai pari, jamais enrichi par Omniroute (juste une
  // mesure statistique). Ne retraite pas un match déjà couvert par le
  // pipeline réel ci-dessus.
  const universe = await getStoredUniverse();
  if (universe) {
    const universeById = new Map<number, UniverseMatch>(universe.map((m) => [m.fixtureId, m]));

    for (const live of liveFixtures) {
      if (live.statusShort !== '1H' && live.statusShort !== '2H') continue;
      if (claimedFixtureIds.has(live.fixtureId)) continue;

      const universeMatch = universeById.get(live.fixtureId);
      if (!universeMatch) continue; // hors de l'univers suivi (pays non ciblés)

      const match: MatchRef = {
        homeTeam: universeMatch.homeTeam,
        awayTeam: universeMatch.awayTeam,
        league: universeMatch.league,
        leagueId: String(universeMatch.leagueId),
      };
      const preMatchExpectedGoals = await estimateExpectedGoalsFromHistory(
        match.leagueId, match.homeTeam, match.awayTeam
      ).catch(() => null);

      if (
        live.statusShort === '1H' &&
        live.minute >= CHECKPOINT20_MIN_MINUTE && live.minute <= CHECKPOINT20_MAX_MINUTE
      ) {
        const rawLegs = (await buildLegs20(match, live.fixtureId, live, preMatchExpectedGoals)).filter((l) => l.prob >= MIN_LEG_PROB);
        for (const leg of rawLegs) {
          const dedupKey = `${live.fixtureId}-minute20-${leg.market}`;
          if (alreadyProposed.has(dedupKey)) continue;
          const proposal = buildProposalFromItems('minute20', [{ leg, fixtureId: live.fixtureId, match, live }], '20e → pause + match complet', false);
          if (proposal) {
            fresh.push(proposal);
            alreadyProposed.add(dedupKey);
          }
        }
      }

      if (
        live.statusShort === '2H' &&
        live.minute >= CHECKPOINT60_MIN_MINUTE && live.minute <= CHECKPOINT60_MAX_MINUTE
      ) {
        const rawLegs = buildLegs60(live, preMatchExpectedGoals).filter((l) => l.prob >= MIN_LEG_PROB);
        for (const leg of rawLegs) {
          const dedupKey = `${live.fixtureId}-minute60-${leg.market}`;
          if (alreadyProposed.has(dedupKey)) continue;
          const proposal = buildProposalFromItems('minute60', [{ leg, fixtureId: live.fixtureId, match, live }], '60e → fin de match', false);
          if (proposal) {
            fresh.push(proposal);
            alreadyProposed.add(dedupKey);
          }
        }
      }
    }
  }

  if (fresh.length > 0) writeInPlayProposals([...existing, ...fresh]);
  return fresh.length;
}
