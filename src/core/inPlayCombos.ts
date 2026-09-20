// Scan en direct — deux points de décision fixes, plus rentables que les
// cotes d'avant-match (devenues trop basses, demande explicite) :
//
//   - 20e minute (milieu de 1ère mi-temps) : but 1ère MT ou pas, corners et
//     cartons 1ère MT (projection statistique Poisson recalibrée sur les
//     moyennes de saison Football-Data.co.uk), BTTS et total du match
//     (projection sur le match ENTIER, pas seulement la 1ère MT).
//   - 60e minute : reste du match (résultat, BTTS, total buts), recalibré
//     avec tout ce qui s'est passé depuis le coup d'envoi.
//
// Les probabilités sont TOUJOURS calculées statistiquement (poisson.ts),
// jamais devinées par une IA. Omniroute n'intervient qu'ENSUITE, pour
// enrichir le raisonnement de chaque jambe avec le contexte disponible
// (mémoire d'auto-apprentissage, forme des équipes) — il ne touche jamais
// aux chiffres. Remplace l'ancien combo de la 20e minute (règles apprises
// seules) et le moniteur mi-temps (45e minute).
//
// Aucune proposition n'est émise si moins de 2 jambes passent le seuil : un
// combo, jamais un pari sec fondé sur une seule estimation incertaine.

import { getDailyPlan } from './scheduler';
import { buildScheduledMatches, ScheduledMatch } from './dailyWorkflow';
import { fetchLiveFixtures, LiveFixture } from './halftimeMonitor';
import { getAPIConfig } from '../api/multiAPIManager';
import { getHistoricalPriors } from './footballDataCoUk';
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

/** Probabilité minimale pour qu'une jambe entre dans le combo. */
const MIN_LEG_PROB = 0.55;
/** Probabilité combinée minimale pour émettre le combo. */
const MIN_COMBINED_PROB = 0.25;
const MAX_LEGS_20 = 5;
const MAX_LEGS_60 = 3;
/** Seuil interne utilisé pour choisir la ligne over/under la plus haute encore fiable (corners/cartons). */
const LINE_PICK_THRESHOLD = 0.55;

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
 * 1ère MT (si moyennes de saison disponibles), BTTS et total du match.
 */
async function buildLegs20(match: ScheduledMatch, live: LiveFixture): Promise<CandidateLeg[]> {
  const legs: CandidateLeg[] = [];
  const preMatchExpectedGoals = { home: match.expectedHomeGoals, away: match.expectedAwayGoals };
  const currentScore = { home: live.homeGoals, away: live.awayGoals };
  const elapsedMinutes = live.minute;

  // 1) But 1ère mi-temps ou pas — rien à prédire si déjà marqué (certain).
  if (currentScore.home + currentScore.away === 0) {
    const est = estimateRemainingFirstHalfMarket({ preMatchExpectedGoals, elapsedMinutes, currentScore });
    const m = est.markets[0];
    legs.push({ market: 'buts_1ere_mt', selection: 'Oui, un but avant la pause', prob: m.estimated_prob, evidence: m.reasoning });
  }

  // 2) Corners / 3) Cartons 1ère mi-temps — projection sur le reste de la 1ère
  // MT + ce qui est déjà compté en direct (best-effort, jamais bloquant).
  const priors = await getHistoricalPriors(match.leagueId, match.homeTeam, match.awayTeam).catch(() => null);
  if (priors) {
    const fraction = remainingFirstHalfEventFraction(elapsedMinutes);
    const observed = observedFirstHalfCounts(live.fixtureId);

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
  const fullEst = estimateRemainingMatchMarket({ preMatchExpectedGoals, elapsedMinutes, currentScore });
  const bttsMarket = fullEst.markets.find((m) => m.market === 'FT_btts_reprojete');
  if (bttsMarket && !(currentScore.home > 0 && currentScore.away > 0)) {
    legs.push(pickBinarySide('btts', bttsMarket, 'Les deux équipes ne marquent pas toutes les deux (Non)'));
  }
  const overMarket = fullEst.markets.find((m) => m.market === 'FT_over_2_5_reprojete');
  if (overMarket && !(currentScore.home + currentScore.away > 2.5)) {
    legs.push(pickBinarySide('total_buts', overMarket, 'Moins de 2.5 buts (total match)'));
  }

  return legs;
}

/** Jambes candidates du checkpoint 60e minute : reste du match uniquement. */
function buildLegs60(match: ScheduledMatch, live: LiveFixture): CandidateLeg[] {
  const legs: CandidateLeg[] = [];
  const preMatchExpectedGoals = { home: match.expectedHomeGoals, away: match.expectedAwayGoals };
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

/**
 * Enrichit le raisonnement de chaque jambe via Omniroute, à partir du
 * contexte déjà disponible (mémoire d'auto-apprentissage, forme des
 * équipes) — ne modifie JAMAIS les probabilités calculées. Best-effort :
 * toute panne (config absente, réseau, JSON invalide) renvoie les jambes
 * telles quelles, jamais bloquant.
 */
async function formulateWithOmniroute(
  match: ScheduledMatch,
  live: LiveFixture,
  legs: CandidateLeg[],
  checkpointLabel: string
): Promise<CandidateLeg[]> {
  if (legs.length === 0) return legs;

  const omnirouteConfig = await loadOmnirouteConfig();
  if (!omnirouteConfig) return legs;

  let digest: string | null = null;
  try { digest = getAgentLearningDigest(); } catch { /* pas encore de règle apprise : silencieux */ }

  let focusContext: string | null = null;
  try { focusContext = renderFocusNote(getFocusNoteByTeams(match.homeTeam, match.awayTeam)); } catch { /* silencieux */ }

  const legsText = legs
    .map((l, i) => `${i + 1}. [${l.market}] ${l.selection} — probabilité calculée : ${(l.prob * 100).toFixed(0)}% (${l.evidence})`)
    .join('\n');

  const systemPrompt =
    "Tu formules des pronostics de football EN COURS DE MATCH à partir de probabilités DÉJÀ CALCULÉES statistiquement (modèle de Poisson recalibré en direct). " +
    "RÈGLE ABSOLUE : ne recalcule jamais ces probabilités, ne les remets jamais en question, ne les modifie jamais — reprends-les EXACTEMENT telles quelles. " +
    "Ton seul rôle : enrichir le raisonnement de chaque jambe avec le contexte fourni (mémoire d'auto-apprentissage, forme des équipes), en français, factuel, sans invention. " +
    'Réponds en JSON strict, rien autour : {"legs": [{"market": "string", "reasoning": "string"}]} — un objet par jambe, EXACTEMENT dans le même ordre, le même nombre, et le même identifiant de marché.';

  const userPrompt =
    `Match en cours : ${match.homeTeam} vs ${match.awayTeam} (${match.leagueName}), minute ${live.minute}, score ${live.homeGoals}-${live.awayGoals}.\n` +
    `Checkpoint : ${checkpointLabel}\n\n` +
    `Jambes calculées (NE PAS changer les probabilités) :\n${legsText}\n` +
    (digest ? `\n${digest}\n` : '') +
    (focusContext ? `\nContexte déjà collecté sur ce match :\n${focusContext}\n` : '');

  try {
    const result = await askOmnirouteLight(systemPrompt, userPrompt, omnirouteConfig);
    if (!result) return legs;

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result.text);
    const enrichedLegs: Array<{ market: string; reasoning: string }> = parsed.legs || [];

    return legs.map((leg, i) => {
      const enriched = enrichedLegs[i];
      // Garde-fou : si l'ordre/le marché renvoyé ne correspond pas exactement,
      // on garde le raisonnement d'origine plutôt que de risquer un mélange.
      if (!enriched?.reasoning || enriched.market !== leg.market) return leg;
      return { ...leg, evidence: enriched.reasoning };
    });
  } catch (error: any) {
    console.warn('[Scan en direct] Enrichissement Omniroute échoué (chiffres calculés conservés):', error.message);
    return legs;
  }
}

function buildProposal(
  kind: 'minute20' | 'minute60',
  live: LiveFixture,
  match: ScheduledMatch,
  legs: CandidateLeg[],
  window: string
): InPlayProposal | null {
  if (legs.length < 2) return null; // un combo, pas un pari sec — mieux vaut se taire

  const combinedProb = legs.reduce((product, leg) => product * leg.prob, 1);
  if (combinedProb < MIN_COMBINED_PROB) return null;

  return {
    id: `inplay-${kind}-${live.fixtureId}`,
    kind,
    createdAt: new Date().toISOString(),
    fixtureId: live.fixtureId,
    league: match.leagueName,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    minute: live.minute,
    scoreLabel: `${live.homeGoals}-${live.awayGoals}`,
    window,
    legs: legs.map((l) => ({ market: l.market, selection: l.selection, prob: l.prob, evidence: l.evidence })),
    combinedProb,
  };
}

async function notifyProposal(proposal: InPlayProposal): Promise<void> {
  const legsText = proposal.legs.map((l) => `• ${l.selection} (${(l.prob * 100).toFixed(0)}%)`).join('\n');
  const emoji = proposal.kind === 'minute20' ? '⚡' : '⏱️';
  await sendLocalNotification(
    `${emoji} ${proposal.minute}e — ${proposal.homeTeam} ${proposal.scoreLabel} ${proposal.awayTeam}`,
    `${proposal.window} — ${(proposal.combinedProb * 100).toFixed(0)}% combiné\n${legsText}`,
    { fixtureId: proposal.fixtureId, kind: proposal.kind }
  );
}

/**
 * Un tour de scan. Appelé par la tâche de fond (toutes les ~15 min) et par
 * la boucle de premier plan (3 min). Ne notifie jamais deux fois le même
 * match pour le même checkpoint.
 */
export async function runInPlayComboTick(): Promise<number> {
  const apiConfig = await getAPIConfig();
  if (!apiConfig.apiFootball) return 0;

  const plan = await getDailyPlan();
  if (!plan) return 0;
  const { matches } = buildScheduledMatches(plan.slots);
  if (matches.length === 0) return 0;

  if (!(await spendBudget('apiFootball'))) return 0;

  let liveFixtures: LiveFixture[];
  try {
    liveFixtures = await fetchLiveFixtures(apiConfig.apiFootball);
  } catch (error: any) {
    console.warn('[Scan en direct] Relevé live échoué:', error.message);
    return 0;
  }

  const existing = readInPlayProposals();
  const alreadyProposed = new Set(existing.map((p) => `${p.fixtureId}-${p.kind}`));
  const fresh: InPlayProposal[] = [];

  for (const live of liveFixtures) {
    if (live.statusShort !== '1H' && live.statusShort !== '2H') continue;

    const match = matches.find((m) => {
      const mHome = normalizeTeamName(m.homeTeam);
      const mAway = normalizeTeamName(m.awayTeam);
      const lHome = normalizeTeamName(live.homeTeam);
      const lAway = normalizeTeamName(live.awayTeam);
      return (mHome === lHome || namesLikelyMatch(mHome, lHome)) && (mAway === lAway || namesLikelyMatch(mAway, lAway));
    });
    if (!match) continue; // hors des 5 grands championnats suivis par le Planning du Jour (buts attendus indisponibles sinon)

    if (
      live.statusShort === '1H' &&
      live.minute >= CHECKPOINT20_MIN_MINUTE && live.minute <= CHECKPOINT20_MAX_MINUTE &&
      !alreadyProposed.has(`${live.fixtureId}-minute20`)
    ) {
      let legs = (await buildLegs20(match, live)).filter((l) => l.prob >= MIN_LEG_PROB);
      legs = legs.sort((a, b) => b.prob - a.prob).slice(0, MAX_LEGS_20);
      legs = await formulateWithOmniroute(match, live, legs, '20e minute — 1ère mi-temps + BTTS/total du match');

      const proposal = buildProposal('minute20', live, match, legs, `${live.minute}e → pause + match complet`);
      if (proposal) {
        fresh.push(proposal);
        alreadyProposed.add(`${live.fixtureId}-minute20`);
        await notifyProposal(proposal);
      }
    }

    if (
      live.statusShort === '2H' &&
      live.minute >= CHECKPOINT60_MIN_MINUTE && live.minute <= CHECKPOINT60_MAX_MINUTE &&
      !alreadyProposed.has(`${live.fixtureId}-minute60`)
    ) {
      let legs = buildLegs60(match, live).filter((l) => l.prob >= MIN_LEG_PROB);
      legs = legs.sort((a, b) => b.prob - a.prob).slice(0, MAX_LEGS_60);
      legs = await formulateWithOmniroute(match, live, legs, '60e minute — reste du match');

      const proposal = buildProposal('minute60', live, match, legs, `${live.minute}e → fin de match`);
      if (proposal) {
        fresh.push(proposal);
        alreadyProposed.add(`${live.fixtureId}-minute60`);
        await notifyProposal(proposal);
      }
    }
  }

  if (fresh.length > 0) writeInPlayProposals([...existing, ...fresh]);
  return fresh.length;
}
