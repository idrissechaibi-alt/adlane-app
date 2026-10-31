// Analyses IA des entraîneurs à la 20e et à la 60e minute (étape 2). Une analyse par match réel et par moment : le coach de la
// ligue reçoit son dossier (fiches des deux clubs, dossier de ligue, faits de recherche) et la fenêtre de stats du match, et rend
// un verdict structuré par marché. Les fournisseurs IA sont ceux de l'app (Omniroute / FreeLLMAPI, jamais Claude/Anthropic).
// Le verdict n'est QUE consigné (mode ombre) : il ne bloque ni ne change aucun pari avant l'étape 3.

import AsyncStorage from '../kvStore';
import type { OmnirouteConfig } from '../../types';
import { askOmnirouteUsable, DEFAULT_OMNIROUTE_CONFIG } from '../omniroute';
import { hasConfiguredRoutes } from '../llmRouter';
import { normalizeTeamName } from '../teamNameMatch';
import type { LiveStatsSample } from '../liveStatsStore';
import { coachBriefing } from './knowledgeBase';
import { loadNotes } from './clubNotes';
import { loadKnowledgeFeed } from './knowledgeFeed';
import { coachForLeague, type CoachProfile } from './knowledge';
import { readMatch, type Stance, type TacticalRead } from './tacticalEngine';
import { readPreMatchBrief } from './preMatchMemory';

export type Checkpoint = '20' | '60';
export type AiMarket = 'total_buts' | 'buts_1ere_mt' | 'btts' | 'corners' | 'cartons' | 'fautes' | '1X2';
export type AiDirection = 'plus' | 'moins' | 'domicile' | 'nul' | 'exterieur' | 'oui' | 'non';

export interface AiOpinion {
  market: AiMarket;
  direction: AiDirection;
  stance: Stance;
  /** 0 à 1. */
  confidence: number;
  why_fr: string;
}

export interface CoachAnalysis {
  key: string;
  day: string;
  home: string;
  away: string;
  league: string;
  coach: CoachProfile['id'];
  checkpoint: Checkpoint;
  minute: number;
  at: string;
  model: string;
  read_fr: string;
  momentum_fr: string;
  risks_fr: string[];
  opinions: AiOpinion[];
  source: 'telephone';
}

const STORE_KEY = '@coach_analyses_v1';
const BUDGET_KEY = '@coach_ai_budget_v1';
const MAX_STORED = 600;
/** Plafond d'appels IA par jour : au-delà, le coach local reste seul (quotas gratuits protégés). */
export const DAILY_AI_BUDGET = 160;

const MARKETS: AiMarket[] = ['total_buts', 'buts_1ere_mt', 'btts', 'corners', 'cartons', 'fautes', '1X2'];
const DIRECTIONS: AiDirection[] = ['plus', 'moins', 'domicile', 'nul', 'exterieur', 'oui', 'non'];
const STANCES: Stance[] = ['soutient', 'neutre', 'conteste'];

export const analysisKey = (home: string, away: string, day: string, checkpoint: Checkpoint): string =>
  `${day}|${normalizeTeamName(home)}|${normalizeTeamName(away)}|${checkpoint}`;

let memo: Record<string, CoachAnalysis> | null = null;

async function load(): Promise<Record<string, CoachAnalysis>> {
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
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(memo));
  } catch {
    /* le prochain passage réenregistrera */
  }
}

export async function getAnalysis(key: string): Promise<CoachAnalysis | null> {
  return (await load())[key] ?? null;
}

export async function listAnalyses(): Promise<CoachAnalysis[]> {
  return Object.values(await load());
}

// ---------------------------------------------------------------- lecture de la réponse de l'IA

const clamp01 = (x: unknown) => Math.max(0, Math.min(1, Number(x) || 0));
const text = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** Lit la réponse JSON de l'IA ; null si elle n'est pas exploitable (l'agent suivant est alors essayé). */
export function parseAnalysis(raw: string): Pick<CoachAnalysis, 'read_fr' | 'momentum_fr' | 'risks_fr' | 'opinions'> | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    const read = text(j.read_fr, 900);
    if (!read) return null;
    const opinions: AiOpinion[] = [];
    for (const o of Array.isArray(j.opinions) ? j.opinions : []) {
      const market = String(o?.market ?? '') as AiMarket;
      const direction = String(o?.direction ?? '') as AiDirection;
      const stance = String(o?.stance ?? '') as Stance;
      if (!MARKETS.includes(market) || !DIRECTIONS.includes(direction) || !STANCES.includes(stance)) continue;
      opinions.push({ market, direction, stance, confidence: clamp01(o?.confidence), why_fr: text(o?.why_fr, 300) });
    }
    if (!opinions.length) return null;
    return {
      read_fr: read,
      momentum_fr: text(j.momentum_fr, 400),
      risks_fr: (Array.isArray(j.risks_fr) ? j.risks_fr : []).map((x: unknown) => text(x, 200)).filter(Boolean).slice(0, 5),
      opinions: opinions.slice(0, 16),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- avis d'une analyse sur une jambe de pari

const opposite: Partial<Record<AiDirection, AiDirection>> = { plus: 'moins', moins: 'plus', oui: 'non', non: 'oui', domicile: 'exterieur', exterieur: 'domicile' };
const flip = (s: Stance): Stance => (s === 'soutient' ? 'conteste' : s === 'conteste' ? 'soutient' : 'neutre');

/** Direction d'une jambe (« Plus de 9.5 corners » → plus, « BTTS Non » → non, 1X2 d'après le nom de l'équipe). */
export function legDirection(leg: { market: string; selection: string; homeTeam?: string; awayTeam?: string }): AiDirection | null {
  const sel = leg.selection.toLowerCase();
  if (leg.market === '1X2') {
    if (/match nul|\bnul\b/.test(sel)) return 'nul';
    const has = (t?: string) => !!t && sel.includes(t.toLowerCase());
    if (has(leg.homeTeam) && !has(leg.awayTeam)) return 'domicile';
    if (has(leg.awayTeam) && !has(leg.homeTeam)) return 'exterieur';
    return null;
  }
  if (leg.market === 'btts') return /\bnon\b/.test(sel) ? 'non' : 'oui';
  if (leg.market === 'buts_1ere_mt') return /^oui/.test(sel) ? 'plus' : /0-0|pas de but/.test(sel) ? 'moins' : null;
  if (/^plus de/.test(sel)) return 'plus';
  if (/^moins de/.test(sel)) return 'moins';
  return null;
}

/** Ce que l'analyse pense d'une jambe : soutient / neutre / conteste, avec la confiance de l'IA et sa raison. */
export function aiOpinionOnLeg(
  analysis: CoachAnalysis | null,
  leg: { market: string; selection: string; homeTeam?: string; awayTeam?: string }
): { stance: Stance; confidence: number; why_fr: string } | null {
  if (!analysis) return null;
  const dir = legDirection(leg);
  if (!dir) return null;
  const market = (leg.market === 'cartons' ? 'cartons' : leg.market) as AiMarket;
  const same = analysis.opinions.find((o) => o.market === market && o.direction === dir);
  if (same) return { stance: same.stance, confidence: same.confidence, why_fr: same.why_fr };
  const opp = opposite[dir];
  const other = opp ? analysis.opinions.find((o) => o.market === market && o.direction === opp) : undefined;
  if (other) return { stance: flip(other.stance), confidence: other.confidence, why_fr: other.why_fr };
  return null;
}

// ---------------------------------------------------------------- appel de l'IA

export async function loadConfig(): Promise<OmnirouteConfig | null> {
  try {
    const raw = await AsyncStorage.getItem('@omniroute_config');
    if (!raw) return null;
    const config = { ...DEFAULT_OMNIROUTE_CONFIG, ...JSON.parse(raw) } as OmnirouteConfig;
    return hasConfiguredRoutes(config) ? config : null;
  } catch {
    return null;
  }
}

export async function takeBudget(): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const b = JSON.parse((await AsyncStorage.getItem(BUDGET_KEY)) ?? 'null');
    const used = b?.day === day ? b.used : 0;
    if (used >= DAILY_AI_BUDGET) return false;
    await AsyncStorage.setItem(BUDGET_KEY, JSON.stringify({ day, used: used + 1 }));
    return true;
  } catch {
    return false;
  }
}

/** Consigne courte (les modèles gratuits ont un contexte limité) : style du coach, règles du verdict, format de réponse. */
function compactSystemPrompt(coach: CoachProfile): string {
  return [
    `Tu es ${coach.name}, entraîneur de très haut niveau et analyste de la ligue « ${coach.league} ». ${coach.style}`,
    `Particularités de ta ligue : ${coach.leagueNotes}`,
    "Tu analyses un match EN DIRECT d'après les seules statistiques fournies (stats minute par minute, momentum, marqueurs avancés) et le dossier du match. Aucune information en dehors de ces données : si une donnée manque, dis-le au lieu de l'inventer. Tu ne garantis rien.",
    "Règles : un marché est SOUTENU si la situation tactique actuelle le rend plus probable que ne le dit la seule statistique chiffrée, CONTESTÉ si elle le rend moins probable ou si les indicateurs se contredisent, NEUTRE sans information fiable. Cite 2 ou 3 faits mesurés (minute, état du match, indicateur). Tiens compte de l'état du score, des cartons rouges, de la fenêtre récente (10 dernières minutes) et de la fiabilité du dossier (fiches « faible » = prudence).",
    'Réponds en JSON strict, rien autour : {"read_fr":"lecture du match en 2 à 4 phrases","momentum_fr":"qui a l\'emprise et comment elle évolue","risks_fr":["risque","…"],"opinions":[{"market":"total_buts|buts_1ere_mt|btts|corners|cartons|fautes|1X2","direction":"plus|moins|domicile|nul|exterieur|oui|non","stance":"soutient|neutre|conteste","confidence":0.0,"why_fr":"raison courte chiffrée"}]}',
    'Donne un avis (au moins 4) sur : total de buts plus/moins, corners plus/moins, cartons plus/moins, et le résultat final (1X2) ; ajoute btts ou fautes si les données le permettent. « plus » et « moins » parlent de la suite du match, sans ligne chiffrée précise.',
  ].join('\n\n');
}

const line = (s: LiveStatsSample) => {
  const side = s.side;
  const sh = side ? `tirs ${side.h[0]}(${side.h[1]})-${side.a[0]}(${side.a[1]})` : `tirs ${s.shots ?? '?'}(${s.sot ?? '?'})`;
  const co = side ? `corners ${side.h[2]}-${side.a[2]}` : `corners ${s.corners ?? '?'}`;
  const ca = side ? `cartons ${side.h[3]}-${side.a[3]}` : `cartons ${s.cards ?? '?'}`;
  const fo = side ? `fautes ${side.h[4]}-${side.a[4]}` : `fautes ${s.fouls ?? '?'}`;
  const poss = s.possessionHome != null ? `poss ${s.possessionHome}%` : '';
  const a = s.adv ? [s.adv.xg != null ? `xG ${s.adv.xg}` : '', s.adv.box != null ? `surface ${s.adv.box}` : '', s.adv.opp != null ? `camp adv. ${s.adv.opp}` : '', s.adv.mom != null ? `momentum ${s.adv.mom}` : ''].filter(Boolean).join(' ') : '';
  const heat = s.heat ? ` · chaleur : bloc dom. x̄ ${s.heat.h.avgX} (dernier tiers ${Math.round(s.heat.h.att * 100)} %, surface ${Math.round(s.heat.h.box * 100)} %) / ext. x̄ ${s.heat.a.avgX} (${Math.round(s.heat.a.att * 100)} %, ${Math.round(s.heat.a.box * 100)} %)` : '';
  return `${s.minute}' ${s.home}-${s.away} · ${sh} · ${co} · ${ca} · ${fo}${poss ? ` · ${poss}` : ''}${s.reds ? ` · rouges ${s.reds}` : ''}${a ? ` · ${a}` : ''}${heat}`;
};

function windowText(samples: LiveStatsSample[]): string {
  const sorted = [...samples].sort((x, y) => x.minute - y.minute);
  // Un relevé toutes les ~5 minutes (le dernier toujours) : assez pour voir la tendance sans noyer le modèle.
  const picked: LiveStatsSample[] = [];
  let lastMin = -99;
  for (const s of sorted) if (s.minute - lastMin >= 5) { picked.push(s); lastMin = s.minute; }
  const last = sorted[sorted.length - 1];
  if (last && picked[picked.length - 1] !== last) picked.push(last);
  return picked.slice(-12).map(line).join('\n');
}

const readText = (r: TacticalRead | null) =>
  r
    ? `Lecture du moteur local : dominance ${r.dominance} (récente ${r.recentDominance ?? '?'}), rythme ${r.tempoTrend ?? '?'}× le rythme moyen, profil « ${r.profile} », phase « ${r.phase} »${r.flags.length ? `, signaux : ${r.flags.join(', ')}` : ''}.`
    : 'Lecture du moteur local : indisponible (stats insuffisantes).';

export interface AnalyzeInput {
  homeTeam: string;
  awayTeam: string;
  league: string;
  day: string;
  checkpoint: Checkpoint;
  minute: number;
  samples: LiveStatsSample[];
}

/**
 * Lance (une seule fois par match et par moment) l'analyse IA du coach de la ligue. Null si : pas de coach pour cette ligue,
 * analyse déjà là, aucune IA configurée, budget du jour épuisé, pas de stats, ou aucune réponse exploitable.
 */
export async function runCoachAnalysis(input: AnalyzeInput): Promise<CoachAnalysis | null> {
  const coach = coachForLeague(input.league);
  if (!coach || input.samples.length === 0) return null;
  const key = analysisKey(input.homeTeam, input.awayTeam, input.day, input.checkpoint);
  const existing = await getAnalysis(key);
  if (existing) return existing;
  const config = await loadConfig();
  if (!config) return null;
  if (inFlight.has(key)) return inFlight.get(key)!;
  const job = (async () => {
    if (!(await takeBudget())) return null;
    await Promise.all([loadNotes(), loadKnowledgeFeed()]);
    const briefing = coachBriefing(input.homeTeam, input.awayTeam, input.league, ['total_buts', 'corners', 'cartons', '1X2'], 5);
    // Ce que l'entraîneur avait annoncé avant le match, compositions officielles à l'appui : il dit si le jeu le confirme ou le dément.
    const before = await readPreMatchBrief(input.homeTeam, input.awayTeam, input.day).catch(() => null);
    const last = [...input.samples].sort((a, b) => a.minute - b.minute).slice(-1)[0];
    const heat = [...input.samples].sort((a, b) => b.minute - a.minute).find((x) => x.heat)?.heat;
    const heatPlayers = heat ? `\nCartes de chaleur (terrain 0-105 dans le sens de l'attaque de chaque équipe ; x̄ = hauteur moyenne ; joueurs les plus avancés) :\n${heat.players.slice(0, 8).map((p) => `${p.name ?? p.id} (${p.team === 'h' ? 'dom.' : 'ext.'}) x̄ ${p.mx}, camp adverse ${Math.round(p.att * 100)} %, surface ${Math.round(p.box * 100)} %`).join('\n')}` : '';
    const user =
      `Match : ${input.homeTeam} (domicile) contre ${input.awayTeam}, ${input.league}. Moment : ${input.checkpoint}e minute (relevé à la ${last.minute}e, score ${last.home}-${last.away}).\n\n` +
      `${readText(readMatch(input.samples))}\n\nFenêtre de stats (domicile-extérieur ; tirs total(cadrés)) :\n${windowText(input.samples)}${heatPlayers}\n\n` +
      (before ? `TON AVIS D'AVANT-MATCH (à confronter au jeu observé : dis ce qui se confirme et ce qui est démenti)\n${before}\n\n` : '') +
      `DOSSIER DU MATCH\n${briefing.context}`;
    const result = await askOmnirouteUsable(compactSystemPrompt(coach), user, config, (raw) => parseAnalysis(raw));
    if (!result) return null;
    const analysis: CoachAnalysis = {
      key,
      day: input.day,
      home: input.homeTeam,
      away: input.awayTeam,
      league: input.league,
      coach: coach.id,
      checkpoint: input.checkpoint,
      minute: last.minute,
      at: new Date().toISOString(),
      model: result.model,
      source: 'telephone',
      ...result.value,
    };
    const all = await load();
    all[key] = analysis;
    await save();
    return analysis;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

const inFlight = new Map<string, Promise<CoachAnalysis | null>>();
