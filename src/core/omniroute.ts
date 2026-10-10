// Connecteur Omniroute Multi-Modèles
// Envoie les requêtes aux IA enregistrées sur Omniroute avec le prompt de cadrage strict

import { Lesson, OmnirouteConfig } from '../types';
import { lintContent } from './validator';
import { ChatMessage, LlmRoute, ToolCall, buildRoutes, callRoute, chatRoute, isWebCapableRoute, orderRoutes, routeLabel } from './llmRouter';
import { fetchPage, formatSearchContext, getRecentSearchSource, searchWeb } from './webSearch';

// Aucun nom de modèle deviné par défaut : le préfixe "in-ai/" testé
// précédemment s'est révélé faux sur le serveur réel de l'utilisateur (HTTP
// 401 "No active credentials for provider: inner-ai" sur les 5 modèles).
// Chaque déploiement Omniroute expose des noms d'agents différents (ex :
// "Clodiko", "inception/mercury-2", ...) — on force donc à passer par le
// sélecteur (Paramètres → "Choisir les agents dans la liste") qui charge la
// vraie liste depuis /models, plutôt que de shipper un préfixe deviné qui casse.
const ALL_DEFAULT_MODELS: string[] = [];

export const DEFAULT_OMNIROUTE_CONFIG: OmnirouteConfig = {
  endpoint: 'http://localhost:8000/v1', // URL par défaut modifiable dans les paramètres
  apiKey: '',
  // Vide par défaut — sélectionne tes agents réels via le picker dans
  // Paramètres. analyzeMatchWithOmniroute interroge en parallèle tous les
  // modèles listés ici (séparés par une virgule) et fusionne leurs réponses.
  selectedModel: ALL_DEFAULT_MODELS.join(', '),
  availableModels: ALL_DEFAULT_MODELS
};

export interface MatchScoutInput {
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoff_utc: string;
  homeStats?: Record<string, any>;
  awayStats?: Record<string, any>;
  odds?: {
    home?: number;
    draw?: number;
    away?: number;
    btts_yes?: number;
    btts_no?: number;
    over_2_5?: number;
    under_2_5?: number;
  };
  contextInfo?: string; // Arbitre, météo, compos probables
}

export interface AIAnalysisOutput {
  match: string;
  kickoff_utc: string;
  markets: Array<{
    market: string;
    selection: string;
    estimated_prob: number;
    odds: number | null;
    confidence: 'Faible' | 'Moyen' | 'Élevé';
    reasoning: string;
    warnings?: string[];
  }>;
  generalAnalysis: string;
  lessonsApplied: string[];
  rawResponse: string;
  // Renseigné quand plusieurs agents Omniroute ont été interrogés en parallèle.
  agentsUsed?: string[];
  agentsFailed?: Array<{ model: string; error: string }>;
}

/**
 * Construit le prompt système rigoureux avec injection de la mémoire des leçons
 */
export function buildSystemPrompt(lessons: Lesson[]): string {
  const lessonsText = lessons.map(l =>
    `- [${l.doc_id}] (Occurrences: ${l.occurrences}) : ${l.motif}\n  Correctif : ${l.detail}`
  ).join('\n');

  return `Tu es un expert en analyse de données sportives (Football) et tu pilotes des agents d'intelligence artificielle spécialisés. Ton but est de fournir une évaluation de probabilités la plus précise possible.

RÈGLES CRITIQUES :
1. AUCUN CONSEIL DE MISE. L'utilisateur prend ses propres décisions.
2. UTILISE TES AGENTS pour croiser les statistiques, les compositions d'équipe et l'historique des confrontations.
3. MÉMOIRE DES ERREURS PASSÉES (Injection Directe) :
${lessonsText}

CADRE DE RÉPONSE :
- BTTS : Si une équipe n'a pas marqué depuis 3 matchs, applique un malus de probabilité.
- 1X2 : Si la probabilité estimée est < 50%, signale un risque élevé.
- ANALYSE FACTUELLE : Cite des chiffres récents (xG, clean sheets, forme sur 5 matchs).

Le tableau "markets" DOIT contenir EXACTEMENT ces 10 marchés (un objet par marché, jamais moins) :
1. 1X2 (résultat final)
2. Double Chance
3. BTTS (les deux équipes marquent)
4. Over/Under 2.5 buts
5. Over/Under 1.5 buts
6. Over/Under 0.5 but en 1ère mi-temps
7. Résultat à la mi-temps (1X2 MT1)
8. Corners Over/Under
9. Cartons (jaunes + rouges) Over/Under
10. Handicap asiatique simplifié (-1/+1)

Format attendu (JSON strict) :
{
  "generalAnalysis": "Explication synthétique et chiffrée",
  "markets": [
    {
      "market": "1X2" | "double_chance" | "BTTS" | "OU_2_5" | "OU_1_5" | "1ere_mi_temps" | "mi_temps_1X2" | "corners" | "cartons" | "handicap",
      "selection": "string",
      "estimated_prob": number (0 à 1),
      "odds": number | null,
      "confidence": "Faible" | "Moyen" | "Élevé",
      "reasoning": "Détail chiffré",
      "warnings": ["string"]
    }
    // ... 10 objets au total, un par marché listé ci-dessus
  ],
  "lessonsApplied": ["doc_id des leçons utilisées"]
}`;
}

const CONFIDENCE_RANK: Record<string, number> = { 'Faible': 0, 'Moyen': 1, 'Élevé': 2 };

interface RawAgentResult {
  model: string;
  generalAnalysis: string;
  markets: AIAnalysisOutput['markets'];
  lessonsApplied: string[];
  rawResponse: string;
}

/**
 * Interroge une route (fournisseur + modèle) via son endpoint chat-completions.
 */
/** Outils web proposés à tous les modèles (exécutés par l'app, voir webSearch.ts). */
const WEB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Recherche sur internet (résultats du jour). À utiliser pour tout fait récent : score, minute, statistiques, résultat, calendrier.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Requête de recherche' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: "Lit le contenu texte d'une page web (par exemple une page de match trouvée par web_search).",
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Adresse de la page' } },
        required: ['url'],
      },
    },
  },
];
const WEB_TOOL_MAX_ROUNDS = 3;

async function runWebTool(call: ToolCall, config: OmnirouteConfig): Promise<string> {
  let args: any = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    args = {};
  }
  if (call.function.name === 'web_search' && typeof args.query === 'string') {
    const results = await searchWeb(config, args.query).catch(() => null);
    return results && results.length > 0 ? formatSearchContext(args.query, results) : 'Aucun résultat.';
  }
  if (call.function.name === 'fetch_page' && typeof args.url === 'string') {
    return (await fetchPage(config, args.url).catch(() => null)) ?? 'Page illisible.';
  }
  return 'Outil inconnu.';
}

/**
 * Donne internet à n'importe quel modèle : il reçoit les outils web_search et
 * fetch_page, l'app exécute ceux qu'il appelle et lui renvoie les résultats
 * (jusqu'à 3 allers-retours). Un fournisseur qui refuse les outils, ou un
 * modèle qui ne sait pas les utiliser, retombe sur un appel simple — la
 * question contient déjà les résultats de la recherche préalable.
 */
async function callWithWebTools(
  route: LlmRoute,
  systemPrompt: string,
  userPrompt: string,
  config: OmnirouteConfig | undefined
): Promise<string> {
  if (!config) return callRoute(route, systemPrompt, userPrompt);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  for (let round = 0; round < WEB_TOOL_MAX_ROUNDS; round++) {
    let reply: { content: string; toolCalls: ToolCall[] };
    try {
      reply = await chatRoute(route, messages, 30000, WEB_TOOLS);
    } catch (error: any) {
      if (round === 0 && /HTTP 4\d\d/.test(String(error?.message))) {
        return callRoute(route, systemPrompt, userPrompt); // outils refusés par ce fournisseur
      }
      throw error;
    }
    if (reply.toolCalls.length === 0) return reply.content;
    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: await runWebTool(call, config) });
    }
  }
  const { content } = await chatRoute(route, messages, 30000);
  if (!content.trim()) throw new Error('réponse vide après les recherches');
  return content;
}

async function callSingleAgent(
  route: LlmRoute,
  systemPrompt: string,
  userPrompt: string,
  webTools: boolean = false,
  webToolsConfig?: OmnirouteConfig
): Promise<RawAgentResult> {
  const model = routeLabel(route);
  const content = !webTools
    ? await callRoute(route, systemPrompt, userPrompt)
    : GOOGLE_SEARCH_MODEL_PATTERN.test(route.model)
      ? await callRoute(route, systemPrompt, userPrompt, undefined, [GOOGLE_SEARCH_TOOL])
      : await callWithWebTools(route, systemPrompt, userPrompt, webToolsConfig);

  const lint = lintContent(content);
  if (!lint.valid) {
    console.warn(`[LINT WARNING] (${model}) Mots interdits détectés :`, lint.bannedWords);
  }

  let parsed: any;
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
  } catch {
    parsed = { generalAnalysis: content, markets: [], lessonsApplied: [] };
  }

  return {
    model,
    generalAnalysis: parsed.generalAnalysis || 'Analyse effectuée.',
    markets: parsed.markets || [],
    lessonsApplied: parsed.lessonsApplied || [],
    rawResponse: content
  };
}

/**
 * Fusionne les marchés de plusieurs agents : moyenne des probabilités pour
 * un même marché, confiance la plus prudente retenue, avertissements cumulés.
 */
function mergeMarkets(results: RawAgentResult[]): AIAnalysisOutput['markets'] {
  const byMarket = new Map<string, { entries: AIAnalysisOutput['markets'][number][] }>();

  for (const result of results) {
    for (const m of result.markets) {
      const key = (m.market || '').toLowerCase();
      if (!byMarket.has(key)) byMarket.set(key, { entries: [] });
      byMarket.get(key)!.entries.push(m);
    }
  }

  const merged: AIAnalysisOutput['markets'] = [];
  for (const { entries } of byMarket.values()) {
    const avgProb = entries.reduce((sum, e) => sum + (e.estimated_prob || 0), 0) / entries.length;
    const odds = entries.find((e) => e.odds != null)?.odds ?? null;
    const worstConfidence = entries.reduce((worst, e) =>
      (CONFIDENCE_RANK[e.confidence] ?? 1) < (CONFIDENCE_RANK[worst] ?? 1) ? e.confidence : worst
    , entries[0].confidence);
    const warnings = Array.from(new Set(entries.flatMap((e) => e.warnings || [])));

    merged.push({
      market: entries[0].market,
      selection: entries[0].selection,
      estimated_prob: avgProb,
      odds,
      confidence: worstConfidence,
      reasoning: entries.length > 1
        ? `Consensus de ${entries.length} agent(s) : ${entries.map((e) => e.reasoning).join(' | ')}`
        : entries[0].reasoning,
      warnings: warnings.length > 0 ? warnings : undefined
    });
  }

  return merged;
}

/**
 * Requête légère (texte libre) au premier agent qui répond, en suivant la même
 * ronde de priorité que l'analyse complète et la même exclusion de
 * Claude/Anthropic. Sert à l'enrichissement de contexte des matchs suivis :
 * une réponse courte, pas les 10 marchés structurés.
 */
export function askOmnirouteLight(
  systemPrompt: string,
  userPrompt: string,
  config: OmnirouteConfig,
  options: { requiresWeb?: boolean; maxAttempts?: number; searchQuery?: string } = {}
): Promise<{ text: string; model: string } | null> {
  return withDeadline(askOmnirouteLightUnbounded(systemPrompt, userPrompt, config, options), ASK_DEADLINE_MS, null);
}

async function askOmnirouteLightUnbounded(
  systemPrompt: string,
  userPrompt: string,
  config: OmnirouteConfig,
  options: { requiresWeb?: boolean; maxAttempts?: number; searchQuery?: string } = {}
): Promise<{ text: string; model: string } | null> {
  const all = await buildRoutes(config);
  let routes = all;
  let prompt = userPrompt;
  if (options.requiresWeb) {
    const prepared = await prepareWebQuestion(config, all, userPrompt, options.searchQuery);
    if (!prepared) return null;
    routes = prepared.routes;
    prompt = prepared.userPrompt;
  }
  const ordered = (await orderRoutes(routes)).slice(0, options.maxAttempts ?? LIGHT_MAX_ATTEMPTS);

  for (const route of ordered) {
    try {
      const result = await callSingleAgent(route, systemPrompt, prompt, Boolean(options.requiresWeb), config);
      return { text: result.rawResponse, model: result.model };
    } catch (error: any) {
      console.warn(`[IA] Enrichissement "${routeLabel(route)}" a échoué:`, error?.message);
    }
  }

  return null;
}

/**
 * Comme askOmnirouteLight, mais la ronde continue tant qu'aucun agent n'a
 * renvoyé un contenu EXPLOITABLE — pas seulement un agent qui n'a pas planté.
 *
 * Indispensable pour les requêtes de collecte de données réelles (calendrier
 * du jour, score en direct) : un agent dépourvu d'outil de navigation répond
 * correctement "je n'ai rien trouvé" — une réponse valide, non fautive, mais
 * vide. askOmnirouteLight s'arrêtait là et renvoyait ce vide, si bien qu'un
 * seul agent sans outils en tête de ronde suffisait à rendre muets TOUS les
 * agents capables de scraper placés derrière lui.
 *
 * `extract` renvoie null quand la réponse n'apporte rien : on passe alors à
 * l'agent suivant.
 */
/** Ce qu'un agent a répondu, en clair — pour pouvoir MONTRER pourquoi une
 * requête n'a rien donné plutôt que d'afficher un 0 muet. */
export interface OmnirouteAttempt {
  model: string;
  outcome: 'exploitable' | 'sans_contenu_utile' | 'erreur';
  /** Début de la réponse brute, ou message d'erreur. Tronqué : sert à
   * reconnaître un refus, une prose hors format ou un souci d'accès. */
  detail: string;
}

const ATTEMPT_DETAIL_MAX_CHARS = 200;

/**
 * Agents branchés sur un moteur de recherche ou un outil de navigation,
 * reconnus à leur nom (firecrawl/web, serper-search/news, tavily, perplexity,
 * brave, exa...). Eux seuls peuvent répondre à une question portant sur des
 * faits du jour ; un modèle de langage seul répondra honnêtement qu'il n'a pas
 * accès au calendrier — réponse correcte et parfaitement inutile ici.
 */
const SEARCH_CAPABLE_PATTERN =
  /search|web|news|crawl|perplexity|tavily|serper|brave|exa|browse|sonar|jina|reader|fetch|tinyfish/i;

/**
 * Trace entièrement faite d'erreurs : la question n'a jamais vraiment été
 * posée (fournisseurs coupés, endpoint injoignable). À distinguer d'un "aucun
 * résultat" — ne pas confondre les deux évite de conclure "pas de match ce
 * jour-là" quand c'est l'infrastructure qui est tombée.
 */
/** FreeLLMAPI : outil qui active la recherche Google sur les modèles Gemini. */
const GOOGLE_SEARCH_TOOL = { type: 'function', function: { name: 'google_search', parameters: {} } };
const GOOGLE_SEARCH_MODEL_PATTERN = /gemini/i;

function isSearchCapable(route: LlmRoute): boolean {
  return (
    SEARCH_CAPABLE_PATTERN.test(route.model) ||
    GOOGLE_SEARCH_MODEL_PATTERN.test(route.model) ||
    isWebCapableRoute(route)
  );
}

/**
 * Prépare une question sur des faits du jour. Si une API de recherche est
 * disponible (OmniRoute /v1/search), l'app cherche elle-même et transmet les
 * résultats : tous les modèles peuvent alors répondre à partir de données
 * réelles. Sinon, seuls les modèles qui cherchent eux-mêmes sont interrogés
 * (accès web vérifié, Gemini avec l'outil google_search). null = aucun moyen
 * d'accéder au web : la question n'est pas posée, la réponse serait inventée.
 */
async function prepareWebQuestion(
  config: OmnirouteConfig,
  all: LlmRoute[],
  userPrompt: string,
  searchQuery: string | undefined
): Promise<{ routes: LlmRoute[]; userPrompt: string; source: string } | null> {
  if (searchQuery) {
    const results = await searchWeb(config, searchQuery).catch(() => null);
    if (results && results.length > 0) {
      return {
        routes: all,
        source: 'recherche web',
        userPrompt:
          `${formatSearchContext(searchQuery, results)}\n\n` +
          "Appuie-toi UNIQUEMENT sur ces résultats de recherche (n'invente rien ; si l'information n'y est pas, " +
          `mets null).\n\n${userPrompt}`,
      };
    }
  }
  // Recherche préalable vide, mais une source de recherche fonctionne : tous
  // les modèles restent interrogeables, avec les outils web_search/fetch_page
  // pour chercher eux-mêmes autrement (callWithWebTools).
  if (await getRecentSearchSource()) {
    return {
      routes: all,
      source: 'outils de recherche',
      userPrompt:
        "Utilise l'outil web_search (et fetch_page si besoin) pour trouver l'information à jour avant de répondre. " +
        `Si tu ne la trouves pas, mets null — n'invente rien.\n\n${userPrompt}`,
    };
  }
  const searchCapable = all.filter(isSearchCapable);
  if (searchCapable.length === 0) return null;
  return { routes: searchCapable, userPrompt, source: 'modèles avec accès web' };
}

/**
 * Plafond de routes essayées par question. Sans lui, une question à laquelle
 * AUCUN modèle ne sait répondre parcourait les 25 modèles configurés (jusqu'à
 * 20 s chacun, ~8 min) : le tour de fond dépassait le temps accordé par
 * Android et était coupé avant l'apprentissage. La rotation (llmRouter) met
 * de toute façon les routes les plus fiables en tête.
 */
const USABLE_MAX_ATTEMPTS = 4;
const LIGHT_MAX_ATTEMPTS = 3;

export function attemptsAllFailed(attempts: OmnirouteAttempt[]): boolean {
  return attempts.length > 0 && attempts.every((a) => a.outcome === 'erreur');
}

/** Durée maximale d'une question aux fournisseurs IA, recherche web et
 * essais successifs compris : au-delà, réponse "rien d'exploitable". Sans
 * cette borne, une question pouvait durer plusieurs minutes et bloquer tout
 * le tour (scan en direct figé plus de 20 min le 10/10). */
const ASK_DEADLINE_MS = 60_000;

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

export function askOmnirouteUsable<T>(
  systemPrompt: string,
  userPrompt: string,
  config: OmnirouteConfig,
  extract: (text: string) => T | null,
  trace?: OmnirouteAttempt[],
  web: boolean | string = false,
  maxAttempts: number = USABLE_MAX_ATTEMPTS
): Promise<{ value: T; model: string } | null> {
  return withDeadline(
    askOmnirouteUsableUnbounded(systemPrompt, userPrompt, config, extract, trace, web, maxAttempts),
    ASK_DEADLINE_MS,
    null
  );
}

async function askOmnirouteUsableUnbounded<T>(
  systemPrompt: string,
  userPrompt: string,
  config: OmnirouteConfig,
  extract: (text: string) => T | null,
  trace?: OmnirouteAttempt[],
  /** Question sur des faits du jour : true, ou directement la requête de
   * recherche web à lancer avant de poser la question (voir prepareWebQuestion). */
  web: boolean | string = false,
  maxAttempts: number = USABLE_MAX_ATTEMPTS
): Promise<{ value: T; model: string } | null> {
  const all = await buildRoutes(config);
  const preferSearchCapable = web !== false;
  let prompt = userPrompt;
  let candidates = all;

  if (preferSearchCapable) {
    const prepared = await prepareWebQuestion(config, all, userPrompt, typeof web === 'string' ? web : undefined);
    if (!prepared) {
      trace?.push({
        model: '(aucun)',
        outcome: 'erreur',
        detail:
          "Aucun accès web : ni API de recherche (OmniRoute /v1/search), ni modèle qui cherche lui-même — question sur des faits du jour non posée (la réponse serait inventée).",
      });
      return null;
    }
    candidates = prepared.routes;
    prompt = prepared.userPrompt;
  }

  const routes = (await orderRoutes(candidates)).slice(0, maxAttempts);

  if (routes.length === 0) {
    trace?.push({ model: '(aucun)', outcome: 'erreur', detail: 'Aucun fournisseur IA configuré dans Paramètres.' });
    return null;
  }

  for (const route of routes) {
    const model = routeLabel(route);
    try {
      const result = await callSingleAgent(route, systemPrompt, prompt, preferSearchCapable, config);
      const value = extract(result.rawResponse);
      if (value !== null) {
        trace?.push({ model, outcome: 'exploitable', detail: result.rawResponse.slice(0, ATTEMPT_DETAIL_MAX_CHARS) });
        return { value, model };
      }
      trace?.push({
        model,
        outcome: 'sans_contenu_utile',
        detail: (result.rawResponse || '(réponse vide)').slice(0, ATTEMPT_DETAIL_MAX_CHARS),
      });
      console.warn(`[IA] "${model}" a répondu sans rien d'exploitable, route suivante.`);
    } catch (error: any) {
      trace?.push({ model, outcome: 'erreur', detail: String(error?.message ?? error).slice(0, ATTEMPT_DETAIL_MAX_CHARS) });
      console.warn(`[IA] "${model}" a échoué:`, error?.message);
    }
  }

  return null;
}

/**
 * Envoie une requête d'analyse aux fournisseurs IA configurés. Les routes
 * (fournisseur + modèle) sont essayées UNE PAR UNE dans l'ordre de llmRouter
 * (rotation entre les plus rapides et fiables mesurées), en s'arrêtant au
 * premier succès — jamais d'appel parallèle qui coûterait un crédit par
 * route. Claude/Anthropic est toujours exclu.
 */
export async function analyzeMatchWithOmniroute(
  matchInput: MatchScoutInput,
  lessons: Lesson[],
  config: OmnirouteConfig
): Promise<AIAnalysisOutput> {
  const systemPrompt = buildSystemPrompt(lessons);
  const userPrompt = `Analyse ce match de football :
Match : ${matchInput.homeTeam} vs ${matchInput.awayTeam}
Compétition : ${matchInput.league}
Coup d'envoi (UTC) : ${matchInput.kickoff_utc}
Cotes bookmakers fournies : ${JSON.stringify(matchInput.odds || 'donnée indisponible')}
Contexte (arbitre/compos/absences) : ${matchInput.contextInfo || 'donnée indisponible'}
Stats disponibles :
- Domicile (${matchInput.homeTeam}) : ${JSON.stringify(matchInput.homeStats || 'donnée indisponible')}
- Extérieur (${matchInput.awayTeam}) : ${JSON.stringify(matchInput.awayStats || 'donnée indisponible')}`;

  const routes = await orderRoutes(await buildRoutes(config));
  if (routes.length === 0) {
    throw new Error(
      'Aucun fournisseur IA utilisable : renseigne au moins un endpoint et un modèle (hors Claude/Anthropic, exclu) dans Paramètres.'
    );
  }

  const failed: Array<{ model: string; error: string }> = [];

  for (const route of routes) {
    try {
      const result = await callSingleAgent(route, systemPrompt, userPrompt);
      return {
        match: `${matchInput.homeTeam} - ${matchInput.awayTeam}`,
        kickoff_utc: matchInput.kickoff_utc,
        markets: mergeMarkets([result]),
        generalAnalysis: result.generalAnalysis,
        lessonsApplied: result.lessonsApplied,
        rawResponse: result.rawResponse,
        agentsUsed: [result.model],
        agentsFailed: failed.length > 0 ? failed : undefined
      };
    } catch (error: any) {
      failed.push({ model: routeLabel(route), error: error?.message || String(error) });
      console.warn(`[IA] "${routeLabel(route)}" a échoué, route suivante:`, error);
    }
  }

  const summary = failed.map((f) => `${f.model} → ${f.error}`).join(' ; ');
  throw new Error(`Connexion IA échouée (${failed.length} route(s), ronde complète) : ${summary}`);
}
