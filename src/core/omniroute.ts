// Connecteur Omniroute Multi-Modèles
// Envoie les requêtes aux IA enregistrées sur Omniroute avec le prompt de cadrage strict

import { Lesson, OmnirouteConfig } from '../types';
import { lintContent } from './validator';

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
 * Interroge un seul modèle/agent via l'endpoint chat-completions d'Omniroute.
 */
async function callSingleAgent(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  config: OmnirouteConfig
): Promise<RawAgentResult> {
  const response = await fetch(`${config.endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    let detail = bodyText;
    try {
      const parsedError = JSON.parse(bodyText);
      detail = parsedError.error?.message || parsedError.detail || parsedError.message || bodyText;
    } catch {
      // corps non-JSON : on garde le texte brut
    }
    throw new Error(`HTTP ${response.status}${detail ? ` : ${detail}` : ` (${response.statusText})`}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

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

// Modèles jamais utilisés (consomment les crédits Anthropic de l'utilisateur
// via son propre compte relié à Omniroute, contrairement aux autres providers).
const NEVER_USE_PATTERN = /claude|anthropic/i;

// Heuristique de qualité pour prioriser les "meilleurs" modèles dans la ronde :
// on reconnaît les familles de modèles haut de gamme connues par leur nom
// (peu importe le préfixe/provider exact du déploiement Omniroute de
// l'utilisateur) et on leur donne un score plus élevé. Les noms non reconnus
// (agents custom type "Clodiko") gardent un score neutre et restent dans
// l'ordre où l'utilisateur les a sélectionnés.
const QUALITY_PATTERNS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /gpt-?5|o3|gpt-4\.5/i, score: 100 },
  { pattern: /gemini-?3|gemini-2\.5-pro/i, score: 95 },
  { pattern: /gpt-4o|gemini-2\.5-flash|mercury-2\.5|deepseek-r1/i, score: 85 },
  { pattern: /llama-3\.1-405b|mixtral-8x22b|qwen-?2\.5-72b/i, score: 80 },
  { pattern: /mercury-2|gemini-flash|gpt-4-turbo/i, score: 70 },
];

function scoreModel(model: string): number {
  for (const { pattern, score } of QUALITY_PATTERNS) {
    if (pattern.test(model)) return score;
  }
  return 50; // score neutre pour un agent non reconnu
}

/**
 * Trie les modèles du plus prioritaire (meilleure qualité connue) au moins
 * prioritaire, en conservant l'ordre de sélection de l'utilisateur pour les
 * égalités (tri stable).
 */
function rankModels(models: string[]): string[] {
  return models
    .map((model, index) => ({ model, index, score: scoreModel(model) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((m) => m.model);
}

/**
 * Requête légère (texte libre) au premier agent qui répond, en suivant la même
 * ronde de priorité que l'analyse complète et la même exclusion de
 * Claude/Anthropic. Sert à l'enrichissement de contexte des matchs suivis :
 * une réponse courte, pas les 10 marchés structurés.
 */
export async function askOmnirouteLight(
  systemPrompt: string,
  userPrompt: string,
  config: OmnirouteConfig
): Promise<{ text: string; model: string } | null> {
  const models = rankModels(
    config.selectedModel
      .split(/[,\n]/)
      .map((m) => m.trim())
      .filter(Boolean)
      .filter((m) => !NEVER_USE_PATTERN.test(m))
  );

  for (const model of models) {
    try {
      const result = await callSingleAgent(model, systemPrompt, userPrompt, config);
      return { text: result.rawResponse, model };
    } catch (error: any) {
      console.warn(`[Omniroute] Enrichissement "${model}" a échoué:`, error?.message);
    }
  }

  return null;
}

/**
 * Envoie une requête d'analyse à Omniroute. Système de "ronde" : les modèles
 * configurés dans config.selectedModel sont essayés UN PAR UN, dans l'ordre
 * de priorité (meilleurs modèles connus en premier), en s'arrêtant au premier
 * succès — pas d'appel parallèle à tous les agents (ça coûterait un crédit
 * par agent à chaque analyse pour rien). Si un agent échoue, on passe au
 * suivant dans la ronde. Claude/Anthropic est systématiquement exclu pour ne
 * jamais consommer les crédits Anthropic de l'utilisateur.
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

  const allModels = config.selectedModel
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter(Boolean);

  const models = rankModels(allModels.filter((m) => !NEVER_USE_PATTERN.test(m)));
  const excludedClaude = allModels.filter((m) => NEVER_USE_PATTERN.test(m));

  if (models.length === 0) {
    throw new Error(
      excludedClaude.length > 0
        ? 'Aucun modèle Omniroute utilisable : seuls des modèles Claude/Anthropic sont configurés, et ils sont exclus pour ne pas consommer tes crédits.'
        : 'Aucun modèle Omniroute configuré.'
    );
  }

  const failed: Array<{ model: string; error: string }> = [];

  for (const model of models) {
    try {
      const result = await callSingleAgent(model, systemPrompt, userPrompt, config);
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
      failed.push({ model, error: error?.message || String(error) });
      console.warn(`[Omniroute] Agent "${model}" a échoué, passage au suivant dans la ronde:`, error);
    }
  }

  const summary = failed.map((f) => `${f.model} → ${f.error}`).join(' ; ');
  throw new Error(`Connexion Omniroute échouée (${failed.length} agent(s), ronde complète) : ${summary}`);
}
