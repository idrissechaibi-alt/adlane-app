// Connecteur Omniroute Multi-Modèles
// Envoie les requêtes aux IA enregistrées sur Omniroute avec le prompt de cadrage strict

import { Lesson, OmnirouteConfig } from '../types';
import { lintContent } from './validator';

export const DEFAULT_OMNIROUTE_CONFIG: OmnirouteConfig = {
  endpoint: 'http://localhost:8000/v1', // URL par défaut modifiable dans les paramètres
  apiKey: '',
  selectedModel: 'claude-3-5-sonnet',
  availableModels: [
    'claude-3-5-sonnet',
    'claude-3-opus',
    'gpt-4o',
    'deepseek-r1',
    'deepseek-v3',
    'qwen-2.5-72b',
    'llama-3.3-70b'
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

  return `Tu es un analyste statistique de football spécialisé dans l'évaluation des probabilités de match.

CADRE NON NÉGOCIABLE :
1. AUCUN CONSEIL DE MISE. Tu ne recommandes jamais de jouer, tu ne suggères aucun montant ni aucune stratégie de mise.
2. AUCUN VOCABULAIRE DE CERTITUDE. Les mots suivants sont STRICTEMENT INTERDITS : "sûr", "garanti", "sans risque", "banker", "lock", "100%".
3. CONSTAT ET ANALYSE PROBABILISTE UNIQUEMENT.
4. ZÉRO DONNÉE INVENTÉE. Si une stat, compo ou cote manque, écris exactement "donnée indisponible".
5. MÉMOIRE DES ERREURS PASSÉES (LEÇONS DU TERRAIN) :
${lessonsText}

RÈGLES D'ANALYSE :
- Si une jambe 1X2 ou un match nul a une probabilité estimée < 50%, signale-la comme à risque élevé.
- Pour le BTTS : applique un malus si une équipe est à 3+ matchs sans marquer ou si le gardien adverse est en forme. Une expulsion adverse n'est PAS haussière pour le BTTS.
- Pour les marchés non historisés (corners, cartons, tirs), la confiance maximale autorisée est "Moyen" (jamais "Élevé").

Format de sortie attendu (JSON strict) :
{
  "generalAnalysis": "1 à 3 phrases factuelles et chiffrées",
  "markets": [
    {
      "market": "1X2" | "BTTS" | "OU_2_5" | "shots_on_target" | "corners",
      "selection": "string",
      "estimated_prob": number (0 à 1),
      "odds": number ou null,
      "confidence": "Faible" | "Moyen" | "Élevé",
      "reasoning": "Explication chiffrée",
      "warnings": ["string"]
    }
  ],
  "lessonsApplied": ["doc_id des leçons prises en compte"]
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
      throw new Error(`Erreur Omniroute HTTP ${response.status} : ${response.statusText}`);
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
