// Connecteur Google Gemini API Pro - Analyse Multi-Marchés Haute Précision

import { Lesson } from '../types';
import { buildSystemPrompt, AIAnalysisOutput, MatchScoutInput } from './omniroute';

export async function analyzeMatchWithGemini(
  matchInput: MatchScoutInput,
  lessons: Lesson[],
  apiKey: string
): Promise<AIAnalysisOutput> {
  const model = 'gemini-1.5-pro'; // Utilisation obligatoire du modèle PRO
  const systemPrompt = buildSystemPrompt(lessons);

  const detailedPrompt = `Tu es l'IA Adlane Pro, expert mondial en data-scouting et analyse probabiliste.
Analyse ce match avec une précision mathématique.

DONNÉES DU MATCH :
- Équipes : ${matchInput.homeTeam} vs ${matchInput.awayTeam}
- Compétition : ${matchInput.league}
- Coup d'envoi : ${matchInput.kickoff_utc}
- Cotes : ${JSON.stringify(matchInput.odds || 'indisponible')}
- Contexte : ${matchInput.contextInfo}

TES MISSIONS (OBLIGATOIRE) :
Pour chaque marché ci-dessous, calcule la probabilité réelle (%) et justifie avec des stats (xG, cartons moyens, corners concédés) :
1. Résultat Final (1X2)
2. Les deux équipes marquent (BTTS)
3. Total de Buts (Over/Under 2.5 et Total exact estimé)
4. Corners (Estimation du nombre total basé sur le style de jeu)
5. Cartons Jaunes (Estimation basée sur l'arbitre et l'agressivité des équipes)
6. Buts en 1ère mi-temps (Probabilité d'au moins 1 but avant la pause)

FORMAT DE RÉPONSE : JSON Strict uniquement.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `${systemPrompt}\n\n${detailedPrompt}` }]
          }],
          generationConfig: {
            temperature: 0.1, // Stabilité maximale des résultats
            responseMimeType: "application/json",
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`Erreur API Gemini Pro : ${err.error?.message || 'Inconnue'}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(content);

    return {
      match: `${matchInput.homeTeam} - ${matchInput.awayTeam}`,
      kickoff_utc: matchInput.kickoff_utc,
      markets: parsed.markets || [],
      generalAnalysis: parsed.generalAnalysis || 'Analyse multi-marchés effectuée par Gemini Pro.',
      lessonsApplied: parsed.lessonsApplied || [],
      rawResponse: content
    };
  } catch (error: any) {
    console.error('Erreur Gemini Pro:', error);
    throw new Error(`Analyse IA échouée : ${error.message}`);
  }
}
