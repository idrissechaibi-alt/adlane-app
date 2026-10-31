// Avis technique d'avant-match de l'entraîneur de la ligue. Un entraîneur ne se prononce que sur les matchs de SA ligue, et seulement
// une fois la composition OFFICIELLE publiée (en général une heure avant le coup d'envoi) : avant, rien n'est généré. L'avis réunit
// toutes les ressources de l'app : dossier des deux clubs, dossier de ligue, faits de recherche, moyennes à jour, compositions
// officielles comparées au onze habituel, arbitre, météo, cotes du jour, tendances des équipes.

import AsyncStorage from '../kvStore';
import { askOmnirouteUsable, type OmnirouteAttempt } from '../omniroute';
import { hubDateKey, hubReferee } from '../../api/footballDataAPIs/liveDataHub';
import { consensusHash, getLineupConsensus, inPlayers, LINEUP_WINDOW_MIN, type ConsensusSide } from './lineupConsensus';
import { getMatchWeather } from '../weather';
import { getMatchTrend, describeMatchTrend, getTeamProfile } from '../teamStats';
import { normalizeTeamName } from '../teamNameMatch';
import { coachForLeague, type CoachProfile } from './knowledge';
import { clubCoachOf } from './clubCoaches';
import { coachBriefing } from './knowledgeBase';
import { loadNotes } from './clubNotes';
import { loadKnowledgeFeed } from './knowledgeFeed';
import { parseAnalysis, loadConfig, takeBudget, type AiOpinion } from './coachAnalysis';
import { gatherMatchWebContext, type WebSource } from './coachWeb';
import { PREMATCH_STORE_KEY } from './preMatchMemory';

// v2 : les avis rédigés avant le recoupement des compositions (3 sources) sont écartés et refaits.
const STORE_KEY = PREMATCH_STORE_KEY;
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
  /** Ce que les sources web ajoutent (actualité, absents annoncés, attentes de la presse), recoupé avec les données du dossier. */
  web_fr: string;
  /** Sources web consultées pour cet avis. */
  webSources: WebSource[];
  /** Compositions recoupées au moment de l'avis (systèmes, onzes, indisponibles), relues à la 20e, à la 60e et au bilan. */
  lineup_text?: string;
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
/** Dernier état de chaque match du jour (diagnostic exporté) : pourquoi un avis n'est pas encore là. */
const trail = new Map<string, { match: string; state: string; detail?: string; at: string }>();
const note = (key: string, match: string, state: string, detail?: string) => trail.set(key, { match, state, detail, at: new Date().toISOString() });

export function getPreMatchDiagnostics(): Array<{ match: string; state: string; detail?: string; at: string }> {
  const day = hubDateKey();
  return [...trail.entries()].filter(([k]) => k.startsWith(day)).map(([, v]) => v);
}

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

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : '');

function systemPrompt(coach: CoachProfile): string {
  return [
    `Tu es ${coach.name}, entraîneur de très haut niveau et analyste de la ligue « ${coach.league} ». ${coach.style}`,
    `Particularités de ta ligue : ${coach.leagueNotes}`,
    "Tu rédiges ton AVIS TECHNIQUE GLOBAL d'avant-match, juste après la publication des compositions officielles, recoupées entre au moins 3 sources. Les INDISPONIBLES listés (avec leur cause) sont des absents CERTAINS : tu ne les décris jamais comme « laissés de côté » ni « cause inconnue ». Seuls les titulaires habituels signalés « SANS être signalés indisponibles » sont des choix de l'entraîneur ou une rotation. Tu t'appuies sur TOUT le dossier fourni (fiches des deux clubs, dossier de ligue, compositions officielles comparées au onze habituel, arbitre, météo, cotes, tendances, moyennes, faits de recherche) ET sur les SOURCES WEB du jour (actualité, absents annoncés, attentes de la presse). Les sources web sont secondaires : la composition officielle et les données du dossier priment, et si le web les contredit tu le signales au lieu de choisir en silence. Tu précises ce qui vient du web (« selon la presse… ») et tu n'inventes rien au-delà de ces sources. Si une donnée manque ou si une fiche est marquée de fiabilité « faible », tu le dis au lieu de l'inventer. Tu ne garantis rien et tu ne donnes aucun pari ferme.",
    "Structure de ton avis : le duel tactique (systèmes, phases fortes et faibles de chaque équipe), les duels clés et les joueurs à surveiller d'après les compositions, l'effet des absences ou des changements de système, le scénario le plus probable de la rencontre, les risques qui le renverseraient, et ton avis par marché (buts, corners, cartons, résultat).",
    'Réponds en JSON strict, rien autour : {"summary_fr":"avis technique global en 4 à 6 phrases","matchup_fr":"duel tactique en 2 à 4 phrases","key_duels_fr":["duel ou joueur clé","…"],"script_fr":"scénario le plus probable en 2 à 3 phrases","lineup_fr":"ce que changent les compositions (absences, système, rotation)","risks_fr":["risque","…"],"web_fr":"ce que les sources web apportent ou contredisent, en 2 à 3 phrases (vide si aucune source)","opinions":[{"market":"total_buts|buts_1ere_mt|btts|corners|cartons|fautes|1X2","direction":"plus|moins|domicile|nul|exterieur|oui|non","stance":"soutient|neutre|conteste","confidence":0.0,"why_fr":"raison courte chiffrée"}]}',
    'Donne au moins 4 avis par marché (total de buts plus/moins, corners plus/moins, cartons plus/moins, résultat 1X2). « plus » et « moins » parlent de tout le match, sans ligne chiffrée précise.',
  ].join('\n\n');
}

type Profile = Awaited<ReturnType<typeof getTeamProfile>>;

/** Texte de composition d'un côté : onze recoupé, système, banc, indisponibles AVEC leur cause, et ce qui reste sans explication. */
export function sideText(team: string, cs: ConsensusSide, profile: Profile): string {
  const missingNames = cs.missing.map((m) => m.name);
  const usual = (profile?.usualXI ?? []).map((id) => profile?.players.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  const benchedUsual = usual.filter((p) => !inPlayers(p.name, cs.starters) && !inPlayers(p.name, missingNames));
  const usualFormation = profile?.usualFormation ?? null;
  const lines = [`${team} : système ${cs.formation ?? '?'}${usualFormation ? ` (habituel ${usualFormation}${cs.formation && cs.formation !== usualFormation ? ', CHANGÉ' : ''})` : ''}`];
  lines.push(`  Onze de départ (confirmé par les sources) : ${cs.starters.join(', ')}`);
  if (cs.subs.length) lines.push(`  Remplaçants : ${cs.subs.join(', ')}`);
  lines.push(
    cs.missing.length
      ? `  INDISPONIBLES (blessés ou suspendus, signalés par les sources) : ${cs.missing.map((m) => `${m.name}${m.reason ? ` — ${m.reason}` : ''}${m.back ? `, retour : ${m.back}` : ''}`).join(' ; ')}`
      : '  Aucun indisponible signalé par les sources.'
  );
  if (benchedUsual.length) lines.push(`  Titulaires habituels laissés hors du onze SANS être signalés indisponibles (choix de l'entraîneur ou rotation) : ${benchedUsual.slice(0, 6).map((p) => p.name).join(', ')}`);
  else if (usual.length) lines.push("  Onze habituel (aucun titulaire habituel laissé de côté sans raison connue).");
  if (cs.disputed.length) lines.push(`  À noter : ${cs.disputed.map((d) => `${d.name} (${d.sources} source${d.sources > 1 ? 's' : ''})`).join(', ')} ne figure pas chez toutes les sources.`);
  return lines.join('\n');
}

export interface PreMatchInput {
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoff: string;
  odds?: { home?: number; draw?: number; away?: number; btts_yes?: number; over_2_5?: number };
  context?: string;
}

/** Lit la réponse de l'IA : la même grille d'avis par marché que l'analyse de la 20e / 60e. */
export function parsePreMatch(raw: string): Pick<PreMatchOpinion, 'summary_fr' | 'matchup_fr' | 'key_duels_fr' | 'script_fr' | 'lineup_fr' | 'risks_fr' | 'web_fr' | 'opinions'> | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    // Certains modèles gardent le fond mais changent les clés (« match », « analysis »…) : on retrouve le texte au lieu de tout perdre.
    const strings: Array<{ key: string; text: string }> = [];
    const walk = (o: unknown, key: string, depth: number) => {
      if (depth > 4 || o == null) return;
      if (typeof o === 'string') strings.push({ key, text: o.trim() });
      else if (Array.isArray(o)) o.forEach((x) => walk(x, key, depth + 1));
      else if (typeof o === 'object') Object.entries(o as Record<string, unknown>).forEach(([k, v]) => walk(v, k, depth + 1));
    };
    walk(j, '', 0);
    const salvage = strings.find((x) => /summary|r[eé]sum|avis|analys|synth|conclusion|overview|assessment/i.test(x.key) && x.text.length > 60)?.text
      ?? strings.filter((x) => x.text.length > 120).sort((p, q) => q.text.length - p.text.length)[0]?.text
      ?? '';
    const summary = typeof j.summary_fr === 'string' ? j.summary_fr.trim().slice(0, 1200) : salvage.slice(0, 1200);
    // Les avis par marché suivent le format de l'analyse en direct : on réutilise sa lecture en lui donnant read_fr.
    if (!summary) return null;
    // Avis par marché mal formés : l'avis écrit reste valable (sans la grille), il ne faut pas tout perdre pour un champ.
    const common = parseAnalysis(JSON.stringify({ read_fr: summary, momentum_fr: '', risks_fr: j.risks_fr ?? [], opinions: j.opinions ?? [] }))
      ?? { risks_fr: (Array.isArray(j.risks_fr) ? j.risks_fr : []).map((x: unknown) => (typeof x === 'string' ? x.trim().slice(0, 200) : '')).filter(Boolean).slice(0, 5), opinions: [] as AiOpinion[] };
    const list = (x: unknown, n: number, max: number): string[] => (Array.isArray(x) ? x.map((v) => (typeof v === 'string' ? v.trim().slice(0, max) : '')).filter(Boolean).slice(0, n) : []);
    const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
    return {
      summary_fr: summary,
      matchup_fr: str(j.matchup_fr, 700),
      key_duels_fr: list(j.key_duels_fr, 5, 220),
      script_fr: str(j.script_fr, 600),
      lineup_fr: str(j.lineup_fr, 600),
      web_fr: str(j.web_fr, 700),
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
  const label = `${input.homeTeam} - ${input.awayTeam}`;
  // Pas d'avis avant T-55 min : c'est le moment où les compositions officielles sont publiées et se recoupent.
  const minutesToKickoff = (Date.parse(input.kickoff) - Date.now()) / 60_000;
  if (Number.isFinite(minutesToKickoff) && minutesToKickoff > LINEUP_WINDOW_MIN) return null;
  // Compositions recoupées : au moins 3 sources avec le même onze, sinon l'entraîneur attend.
  const consensus = await getLineupConsensus(input.homeTeam, input.awayTeam).catch(() => null);
  if (!consensus || !consensus.ok) {
    note(key, label, 'attente_compo', consensus && !consensus.ok ? `${consensus.reason} (${consensus.sources.join(', ') || 'aucune source'})` : 'recoupement impossible');
    return null;
  }
  const hash = consensusHash(consensus);
  const store = await load();
  if (store[key]?.lineupHash === hash) return store[key];
  const failed = lastFailure.get(key);
  if (failed && Date.now() - failed.at < 3 * 60_000) return null;
  if (inFlight.has(key)) return inFlight.get(key)!;

  const job = (async () => {
    const config = await loadConfig();
    note(key, label, 'en_cours', `compositions recoupées : ${consensus.sources.join(', ')}`);
    if (!config) {
      lastFailure.set(key, { at: Date.now(), reason: "aucune IA configurée dans Paramètres" });
      return null;
    }
    if (!(await takeBudget())) {
      lastFailure.set(key, { at: Date.now(), reason: "budget d'appels IA du jour épuisé" });
      return null;
    }
    await Promise.all([loadNotes(), loadKnowledgeFeed()]);
    const [homeProfile, awayProfile, referee, weather, trend, web] = await Promise.all([
      getTeamProfile(input.homeTeam).catch(() => null),
      getTeamProfile(input.awayTeam).catch(() => null),
      hubReferee(input.homeTeam, input.awayTeam, day).catch(() => null),
      getMatchWeather(input.homeTeam, input.awayTeam).catch(() => null),
      getMatchTrend(input.homeTeam, input.awayTeam).catch(() => null),
      gatherMatchWebContext(input.homeTeam, input.awayTeam, config).catch(() => null),
    ]);
    const briefing = coachBriefing(input.homeTeam, input.awayTeam, coach.league, ['total_buts', 'corners', 'cartons', '1X2'], 6);
    const parts: string[] = [`Match : ${input.homeTeam} (domicile) contre ${input.awayTeam}, ${coach.league}, coup d'envoi ${input.kickoff}.`];
    parts.push(`COMPOSITIONS OFFICIELLES (recoupées entre ${consensus.sources.length} sources : ${consensus.sources.join(', ')})\n${sideText(input.homeTeam, consensus.home, homeProfile)}\n${sideText(input.awayTeam, consensus.away, awayProfile)}${consensus.notes.length ? `\nRemarque : ${consensus.notes.join(' ; ')}` : ''}`);
    if (referee) parts.push(`ARBITRE : ${referee.name}${referee.country ? ` (${referee.country})` : ''}${referee.matches ? `, ${referee.matches} matchs connus` : ''}${referee.yellowPerMatch != null ? `, ${referee.yellowPerMatch} jaunes et ${referee.foulsPerMatch ?? '?'} fautes par match (moyenne de la compétition : ${referee.leagueYellowAvg ?? '?'} et ${referee.leagueFoulsAvg ?? '?'})` : ''}${referee.penalties != null ? `, ${referee.penalties} penaltys` : ''}${referee.reds != null ? `, ${referee.reds} rouges` : ''}.`);
    if (weather) parts.push(`MÉTÉO : ${weather.city}, ${Math.round(weather.temperatureC)} °C, pluie ${weather.rainMm} mm, vent ${Math.round(weather.windKmh)} km/h.`);
    if (input.odds) parts.push(`COTES DU JOUR : 1 ${input.odds.home ?? '?'} · N ${input.odds.draw ?? '?'} · 2 ${input.odds.away ?? '?'} · les deux marquent ${input.odds.btts_yes ?? '?'} · plus de 2,5 buts ${input.odds.over_2_5 ?? '?'}.`);
    if (trend) parts.push(`TENDANCES DES ÉQUIPES : ${clip(describeMatchTrend(trend), 500)}`);
    if (input.context) parts.push(`CONTEXTE DU SCAN MATINAL : ${clip(input.context, 400)}`);
    parts.push(web?.text ? `SOURCES WEB DU JOUR (${web.engines.join(', ')} ; non vérifiées : la composition recoupée et la liste des indisponibles ci-dessus priment, ne reprends jamais du web un blessé ou un titulaire qu'elles contredisent)\n${clip(web.text, 1600)}` : 'SOURCES WEB DU JOUR : aucune source web n\'a répondu pour ce match.');
    parts.push(`DOSSIER DU MATCH\n${clip(briefing.context, 3200)}`);
    // Rappel en fin de message : plusieurs modèles répondent en prose Markdown quand la consigne JSON n'est qu'au début d'un long texte.
    parts.push("RÉPONDS UNIQUEMENT par l'objet JSON demandé, avec EXACTEMENT les clés summary_fr, matchup_fr, key_duels_fr, script_fr, lineup_fr, risks_fr, web_fr, opinions (aucune autre clé, pas d'objet « match »). Commence par { et finis par }, sans titre, sans Markdown, sans texte autour.");

    // Avis long (dossier + compositions + web) : plus de temps et d'essais qu'une analyse en direct, et la cause de l'échec est gardée.
    const trace: OmnirouteAttempt[] = [];
    const res = await askOmnirouteUsable(systemPrompt(coach), parts.join('\n\n'), config, (raw) => parsePreMatch(raw), trace, false, 6, 150_000);
    if (!res) {
      const why = trace.slice(0, 3).map((a) => `${a.model} : ${a.outcome === 'erreur' ? 'erreur' : a.outcome === 'sans_contenu_utile' ? 'réponse inexploitable' : a.outcome} — ${String(a.detail ?? '').replace(/\s+/g, ' ').slice(0, 90)}`).join(' | ');
      lastFailure.set(key, { at: Date.now(), reason: why ? `aucune réponse exploitable des IA (${why})` : 'aucune réponse exploitable des IA (délai dépassé)' });
      note(key, label, 'echec_ia', lastFailure.get(key)!.reason);
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
      webSources: web?.sources ?? [],
      lineup_text: [consensus.home, consensus.away].map((cs, i) => `${i ? input.awayTeam : input.homeTeam} (${cs.formation ?? '?'}) : ${cs.starters.join(', ')}${cs.missing.length ? ` — indisponibles : ${cs.missing.map((m) => m.name).join(', ')}` : ''}`).join(' | '),
      ...res.value,
    };
    const all = await load();
    all[key] = opinion;
    lastFailure.delete(key);
    note(key, label, 'pret', `${res.model} · ${consensus.sources.join(', ')}`);
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
let passRunning: Promise<number> | null = null;
/** Avis déjà rédigés : composition revérifiée au plus toutes les 10 min (avant le coup d'envoi), pour refaire l'avis si elle change. */
const lastRecheck = new Map<string, number>();
const CONCURRENCY = 3;

/**
 * Passe sur les matchs du jour dont le coup d'envoi est dans moins de 55 min (ou vient de passer, 20 min au plus) : rédige l'avis de
 * chaque match dès que sa composition est recoupée. TOUS les matchs concernés sont traités à chaque passe, 3 à la fois, les plus
 * proches du coup d'envoi d'abord ; un avis déjà rédigé ou en échec récent ne prend pas la place d'un autre. Une seule passe à la fois
 * (l'écran et la tâche de fond partagent la même). Renvoie le nombre d'avis rédigés.
 */
export function runPreMatchOpinions(matches: Array<PreMatchInput & { id?: string }>): Promise<number> {
  if (passRunning) return passRunning;
  passRunning = (async () => {
    const day = hubDateKey();
    const store = await load();
    const due = matches
      .map((m) => ({ m, key: preMatchKey(m.homeTeam, m.awayTeam, day), minutes: (Date.parse(m.kickoff) - Date.now()) / 60_000 }))
      .filter(({ m, key, minutes }) => {
        if (!Number.isFinite(minutes) || minutes > LINEUP_WINDOW_MIN || minutes < -20) return false;
        if (inFlight.has(key)) return false;
        const failed = lastFailure.get(key);
        if (failed && Date.now() - failed.at < 3 * 60_000) return false;
        if (store[key]) {
          if (minutes < 0 || Date.now() - (lastRecheck.get(key) ?? 0) < 10 * 60_000) return false;
          lastRecheck.set(key, Date.now());
        }
        return !!m.homeTeam && !!m.awayTeam;
      })
      .sort((a, b) => Math.abs(a.minutes) - Math.abs(b.minutes));
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const { m, key } = due[next++];
        const before = store[key]?.at;
        const op = await generatePreMatchOpinion(m).catch(() => null);
        if (op && op.at !== before) done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
    return done;
  })().finally(() => {
    passRunning = null;
  });
  return passRunning;
}
