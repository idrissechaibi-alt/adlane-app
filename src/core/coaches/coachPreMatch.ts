// Avis technique d'avant-match de l'entraîneur de la ligue. Un entraîneur ne se prononce que sur les matchs de SA ligue, et seulement
// une fois la composition OFFICIELLE publiée (en général une heure avant le coup d'envoi) : avant, rien n'est généré. L'avis réunit
// toutes les ressources de l'app : dossier des deux clubs, dossier de ligue, faits de recherche, moyennes à jour, compositions
// officielles comparées au onze habituel, arbitre, météo, cotes du jour, tendances des équipes.

import AsyncStorage from '../kvStore';
import { askOmnirouteUsable } from '../omniroute';
import { hubDateKey, hubLineup, hubReferee, type HubLineup } from '../../api/footballDataAPIs/liveDataHub';
import { checkLineup, type LineupCheck } from '../lineupCheck';
import { getMatchWeather } from '../weather';
import { getMatchTrend, describeMatchTrend } from '../teamStats';
import { normalizeTeamName } from '../teamNameMatch';
import { coachForLeague, type CoachProfile } from './knowledge';
import { clubCoachOf } from './clubCoaches';
import { coachBriefing } from './knowledgeBase';
import { loadNotes } from './clubNotes';
import { loadKnowledgeFeed } from './knowledgeFeed';
import { parseAnalysis, loadConfig, takeBudget, type AiOpinion } from './coachAnalysis';

const STORE_KEY = '@coach_prematch_v1';
const MAX_STORED = 200;

export interface PreMatchOpinion {
  key: string;
  day: string;
  home: string;
  away: string;
  league: string;
  coach: CoachProfile['id'];
  coachName: string;
  kickoff: string;
  /** Empreinte des compositions : l'avis est refait si elles changent après sa rédaction. */
  lineupHash: string;
  at: string;
  model: string;
  summary_fr: string;
  matchup_fr: string;
  key_duels_fr: string[];
  script_fr: string;
  lineup_fr: string;
  risks_fr: string[];
  opinions: AiOpinion[];
}

export type PreMatchStatus =
  | { state: 'hors_ligue' }
  | { state: 'attente_compo'; coachName: string }
  | { state: 'en_cours'; coachName: string }
  | { state: 'pret'; opinion: PreMatchOpinion }
  | { state: 'indisponible'; coachName: string; reason: string };

export const preMatchKey = (home: string, away: string, day: string) => `${day}|${normalizeTeamName(home)}|${normalizeTeamName(away)}`;

let memo: Record<string, PreMatchOpinion> | null = null;
const inFlight = new Map<string, Promise<PreMatchOpinion | null>>();
const lastFailure = new Map<string, { at: number; reason: string }>();

async function load(): Promise<Record<string, PreMatchOpinion>> {
  if (memo) return memo;
  try {
    memo = JSON.parse((await AsyncStorage.getItem(STORE_KEY)) ?? '{}');
  } catch {
    memo = {};
  }
  return memo!;
}

async function save(): Promise<void> {
  if (!memo) return;
  const entries = Object.entries(memo);
  if (entries.length > MAX_STORED) {
    entries.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
    memo = Object.fromEntries(entries.slice(0, MAX_STORED));
  }
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(memo)).catch(() => {});
}

export async function getPreMatchOpinion(home: string, away: string, day: string): Promise<PreMatchOpinion | null> {
  return (await load())[preMatchKey(home, away, day)] ?? null;
}

const hashOf = (lu: HubLineup): string => {
  const s = (t: HubLineup['home']) => `${t.formation ?? ''}:${t.starters.map((p) => p.id).sort((a, b) => a - b).join(',')}`;
  const text = `${s(lu.home)}|${s(lu.away)}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h);
};

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : '');

function systemPrompt(coach: CoachProfile): string {
  return [
    `Tu es ${coach.name}, entraîneur de très haut niveau et analyste de la ligue « ${coach.league} ». ${coach.style}`,
    `Particularités de ta ligue : ${coach.leagueNotes}`,
    "Tu rédiges ton AVIS TECHNIQUE GLOBAL d'avant-match, juste après la publication des compositions officielles. Tu t'appuies sur TOUT le dossier fourni (fiches des deux clubs, dossier de ligue, compositions officielles comparées au onze habituel, arbitre, météo, cotes, tendances, moyennes, faits de recherche) et sur rien d'autre. Si une donnée manque ou si une fiche est marquée de fiabilité « faible », tu le dis au lieu de l'inventer. Tu ne garantis rien et tu ne donnes aucun pari ferme.",
    "Structure de ton avis : le duel tactique (systèmes, phases fortes et faibles de chaque équipe), les duels clés et les joueurs à surveiller d'après les compositions, l'effet des absences ou des changements de système, le scénario le plus probable de la rencontre, les risques qui le renverseraient, et ton avis par marché (buts, corners, cartons, résultat).",
    'Réponds en JSON strict, rien autour : {"summary_fr":"avis technique global en 4 à 6 phrases","matchup_fr":"duel tactique en 2 à 4 phrases","key_duels_fr":["duel ou joueur clé","…"],"script_fr":"scénario le plus probable en 2 à 3 phrases","lineup_fr":"ce que changent les compositions (absences, système, rotation)","risks_fr":["risque","…"],"opinions":[{"market":"total_buts|buts_1ere_mt|btts|corners|cartons|fautes|1X2","direction":"plus|moins|domicile|nul|exterieur|oui|non","stance":"soutient|neutre|conteste","confidence":0.0,"why_fr":"raison courte chiffrée"}]}',
    'Donne au moins 4 avis par marché (total de buts plus/moins, corners plus/moins, cartons plus/moins, résultat 1X2). « plus » et « moins » parlent de tout le match, sans ligne chiffrée précise.',
  ].join('\n\n');
}

const sideLine = (c: LineupCheck['home'], names: string[]) =>
  `${c.team} : système ${c.formation ?? '?'}${c.usualFormation ? ` (habituel ${c.usualFormation}${c.formationChanged ? ', CHANGÉ' : ''})` : ''} · onze : ${names.join(', ')}${c.absentKey.length ? ` · joueurs clés habituels HORS du onze (cause inconnue : blessure, suspension ou rotation) : ${c.absentKey.join(', ')}` : c.absentUsual.length ? ` · titulaires habituels hors du onze (cause inconnue) : ${c.absentUsual.slice(0, 5).join(', ')}` : ' · onze habituel'}`;

export interface PreMatchInput {
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoff: string;
  odds?: { home?: number; draw?: number; away?: number; btts_yes?: number; over_2_5?: number };
  context?: string;
}

/** Lit la réponse de l'IA : la même grille d'avis par marché que l'analyse de la 20e / 60e. */
export function parsePreMatch(raw: string): Pick<PreMatchOpinion, 'summary_fr' | 'matchup_fr' | 'key_duels_fr' | 'script_fr' | 'lineup_fr' | 'risks_fr' | 'opinions'> | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    const summary = typeof j.summary_fr === 'string' ? j.summary_fr.trim().slice(0, 1200) : '';
    // Les avis par marché suivent le format de l'analyse en direct : on réutilise sa lecture en lui donnant read_fr.
    const common = parseAnalysis(JSON.stringify({ read_fr: summary || 'x', momentum_fr: '', risks_fr: j.risks_fr ?? [], opinions: j.opinions ?? [] }));
    if (!summary || !common) return null;
    const list = (x: unknown, n: number, max: number): string[] => (Array.isArray(x) ? x.map((v) => (typeof v === 'string' ? v.trim().slice(0, max) : '')).filter(Boolean).slice(0, n) : []);
    const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
    return {
      summary_fr: summary,
      matchup_fr: str(j.matchup_fr, 700),
      key_duels_fr: list(j.key_duels_fr, 5, 220),
      script_fr: str(j.script_fr, 600),
      lineup_fr: str(j.lineup_fr, 600),
      risks_fr: common.risks_fr,
      opinions: common.opinions,
    };
  } catch {
    return null;
  }
}

/**
 * Rédige l'avis d'avant-match d'un match de la ligue d'un entraîneur, SI la composition officielle est publiée. Null sinon (ligue
 * sans entraîneur, compo pas encore publiée, aucune IA configurée, budget épuisé ou réponse inexploitable).
 */
export async function generatePreMatchOpinion(input: PreMatchInput): Promise<PreMatchOpinion | null> {
  const coach = coachForLeague(input.league) ?? coachForLeague(clubCoachOf(input.homeTeam)?.league);
  const home = clubCoachOf(input.homeTeam);
  const away = clubCoachOf(input.awayTeam);
  // Un entraîneur ne juge que sa ligue : les deux clubs doivent en être (pas de coupe d'Europe croisée).
  if (!coach || !home || !away || home.league !== coach.league || away.league !== coach.league) return null;
  const day = hubDateKey();
  const key = preMatchKey(input.homeTeam, input.awayTeam, day);
  const lineup = await hubLineup(input.homeTeam, input.awayTeam, day).catch(() => null);
  if (!lineup) return null;
  const hash = hashOf(lineup);
  const store = await load();
  if (store[key]?.lineupHash === hash) return store[key];
  const failed = lastFailure.get(key);
  if (failed && Date.now() - failed.at < 10 * 60_000) return null;
  if (inFlight.has(key)) return inFlight.get(key)!;

  const job = (async () => {
    const config = await loadConfig();
    if (!config) {
      lastFailure.set(key, { at: Date.now(), reason: "aucune IA configurée dans Paramètres" });
      return null;
    }
    if (!(await takeBudget())) {
      lastFailure.set(key, { at: Date.now(), reason: "budget d'appels IA du jour épuisé" });
      return null;
    }
    await Promise.all([loadNotes(), loadKnowledgeFeed()]);
    const [check, referee, weather, trend] = await Promise.all([
      checkLineup(input.homeTeam, input.awayTeam).catch(() => null),
      hubReferee(input.homeTeam, input.awayTeam, day).catch(() => null),
      getMatchWeather(input.homeTeam, input.awayTeam).catch(() => null),
      getMatchTrend(input.homeTeam, input.awayTeam).catch(() => null),
    ]);
    const briefing = coachBriefing(input.homeTeam, input.awayTeam, coach.league, ['total_buts', 'corners', 'cartons', '1X2'], 6);
    const parts: string[] = [`Match : ${input.homeTeam} (domicile) contre ${input.awayTeam}, ${coach.league}, coup d'envoi ${input.kickoff}.`];
    parts.push(
      check
        ? `COMPOSITIONS OFFICIELLES\n${sideLine(check.home, lineup.home.starters.map((p) => p.name))}\n${sideLine(check.away, lineup.away.starters.map((p) => p.name))}`
        : `COMPOSITIONS OFFICIELLES\n${input.homeTeam} (${lineup.home.formation ?? '?'}) : ${lineup.home.starters.map((p) => p.name).join(', ')}\n${input.awayTeam} (${lineup.away.formation ?? '?'}) : ${lineup.away.starters.map((p) => p.name).join(', ')}\n(comparaison au onze habituel indisponible)`
    );
    if (referee) parts.push(`ARBITRE : ${referee.name}${referee.country ? ` (${referee.country})` : ''}${referee.matches ? `, ${referee.matches} matchs connus` : ''}${referee.yellowPerMatch != null ? `, ${referee.yellowPerMatch} jaunes et ${referee.foulsPerMatch ?? '?'} fautes par match (moyenne de la compétition : ${referee.leagueYellowAvg ?? '?'} et ${referee.leagueFoulsAvg ?? '?'})` : ''}${referee.penalties != null ? `, ${referee.penalties} penaltys` : ''}${referee.reds != null ? `, ${referee.reds} rouges` : ''}.`);
    if (weather) parts.push(`MÉTÉO : ${weather.city}, ${Math.round(weather.temperatureC)} °C, pluie ${weather.rainMm} mm, vent ${Math.round(weather.windKmh)} km/h.`);
    if (input.odds) parts.push(`COTES DU JOUR : 1 ${input.odds.home ?? '?'} · N ${input.odds.draw ?? '?'} · 2 ${input.odds.away ?? '?'} · les deux marquent ${input.odds.btts_yes ?? '?'} · plus de 2,5 buts ${input.odds.over_2_5 ?? '?'}.`);
    if (trend) parts.push(`TENDANCES DES ÉQUIPES : ${clip(describeMatchTrend(trend), 900)}`);
    if (input.context) parts.push(`CONTEXTE DU SCAN MATINAL : ${clip(input.context, 700)}`);
    parts.push(`DOSSIER DU MATCH\n${briefing.context}`);

    const res = await askOmnirouteUsable(systemPrompt(coach), parts.join('\n\n'), config, (raw) => parsePreMatch(raw));
    if (!res) {
      lastFailure.set(key, { at: Date.now(), reason: 'aucune réponse exploitable des IA' });
      return null;
    }
    const opinion: PreMatchOpinion = {
      key,
      day,
      home: input.homeTeam,
      away: input.awayTeam,
      league: coach.league,
      coach: coach.id,
      coachName: coach.name,
      kickoff: input.kickoff,
      lineupHash: hash,
      at: new Date().toISOString(),
      model: res.model,
      ...res.value,
    };
    const all = await load();
    all[key] = opinion;
    lastFailure.delete(key);
    await save();
    return opinion;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

/** État affichable d'un match de la ligue d'un entraîneur (sans réseau : lit seulement ce qui est déjà en mémoire). */
export async function preMatchStatus(m: { homeTeam: string; awayTeam: string; leagueName: string }): Promise<PreMatchStatus> {
  const coach = coachForLeague(m.leagueName);
  const home = clubCoachOf(m.homeTeam);
  const away = clubCoachOf(m.awayTeam);
  if (!coach || !home || !away || home.league !== coach.league || away.league !== coach.league) return { state: 'hors_ligue' };
  const key = preMatchKey(m.homeTeam, m.awayTeam, hubDateKey());
  const done = (await load())[key];
  if (done) return { state: 'pret', opinion: done };
  if (inFlight.has(key)) return { state: 'en_cours', coachName: coach.name };
  const failed = lastFailure.get(key);
  if (failed) return { state: 'indisponible', coachName: coach.name, reason: failed.reason };
  return { state: 'attente_compo', coachName: coach.name };
}

/**
 * Passe sur les matchs du jour : pour ceux dont le coup d'envoi approche (dans les 3 heures) ou vient de passer, tente l'avis dès que
 * la composition officielle est publiée. Renvoie le nombre d'avis rédigés. À appeler depuis la tâche de fond et à l'ouverture de l'écran.
 */
export async function runPreMatchOpinions(matches: Array<PreMatchInput & { id?: string }>, maxPerPass = 3): Promise<number> {
  let done = 0;
  for (const m of matches) {
    if (done >= maxPerPass) break;
    const minutes = (Date.parse(m.kickoff) - Date.now()) / 60_000;
    if (!Number.isFinite(minutes) || minutes > 180 || minutes < -20) continue;
    const before = (await getPreMatchOpinion(m.homeTeam, m.awayTeam, hubDateKey()))?.at;
    const op = await generatePreMatchOpinion(m).catch(() => null);
    if (op && op.at !== before) done++;
  }
  return done;
}
