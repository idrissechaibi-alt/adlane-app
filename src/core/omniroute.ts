// Connecteur Omniroute Multi-Modèles
// Envoie les requêtes aux IA enregistrées sur Omniroute avec le prompt de cadrage strict

import { Lesson, OmnirouteConfig } from '../types';
import { lintContent } from './validator';

export const DEFAULT_OMNIROUTE_CONFIG: OmnirouteConfig = {
  endpoint: 'http://localhost:8000/v1', // URL par défaut modifiable dans les paramètres
  apiKey: '',
  selectedModel: 'gemini-2.5-flash', // Gemini par défaut (gemini-1.5-* a été retiré)
  availableModels: [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'claude-sonnet-5',
    'gpt-4o',
    'deepseek-r1'
  ]
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

/**
 * Envoie une requête d'analyse à Omniroute
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

  try {
    const response = await fetch(`${config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.selectedModel,
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
      throw new Error(`Erreur Omniroute HTTP ${response.status}${detail ? ` : ${detail}` : ` (${response.statusText})`}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Lint de contenu strict (§0)
    const lint = lintContent(content);
    if (!lint.valid) {
      console.warn(`[LINT WARNING] Mots interdits détectés dans la réponse IA :`, lint.bannedWords);
    }

    // Extraction du JSON de la réponse
    let parsed: any;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(content);
      }
    } catch {
      parsed = {
        generalAnalysis: content,
        markets: [],
        lessonsApplied: []
      };
    }

    return {
      match: `${matchInput.homeTeam} - ${matchInput.awayTeam}`,
      kickoff_utc: matchInput.kickoff_utc,
      markets: parsed.markets || [],
      generalAnalysis: parsed.generalAnalysis || 'Analyse effectuée.',
      lessonsApplied: parsed.lessonsApplied || [],
      rawResponse: content
    };
  } catch (error: any) {
    console.error('Erreur appel Omniroute:', error);
    throw new Error(`Connexion Omniroute échouée : ${error.message}`);
  }
}
