// Connecteur Google Gemini API Pro - Analyse Haute Précision

import { Lesson } from '../types';
import { buildSystemPrompt, AIAnalysisOutput, MatchScoutInput } from './omniroute';

export async function analyzeMatchWithGemini(
  matchInput: MatchScoutInput,
  lessons: Lesson[],
  apiKey: string
): Promise<AIAnalysisOutput> {
  const model = 'gemini-1.5-pro'; // PASSAGE EN VERSION PRO
  const systemPrompt = buildSystemPrompt(lessons);

  const detailedPrompt = `Tu es l'IA Adlane, un expert mondial en probabilités sportives.
Analyse ce match avec une précision mathématique en utilisant les données fournies et tes connaissances sur les dynamiques d'équipes.

DONNÉES DU MATCH :
- Équipes : ${matchInput.homeTeam} vs ${matchInput.awayTeam}
- Ligue : ${matchInput.league}
- Coup d'envoi : ${matchInput.kickoff_utc}
- Cotes actuelles : ${JSON.stringify(matchInput.odds)}
- Contexte : ${matchInput.contextInfo}

CONSIGNES :
1. Calcule la probabilité réelle (%) pour la Victoire Domicile, Nul et Extérieur.
2. Identifie si une "Value" existe par rapport aux cotes du bookmaker.
3. Applique les leçons apprises (historique fourni dans le system prompt).
4. Retourne une analyse synthétique et tes marchés recommandés.`;

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
            temperature: 0.15, // Plus précis, moins créatif
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
      generalAnalysis: parsed.generalAnalysis || 'Analyse effectuée par Gemini Pro.',
      lessonsApplied: parsed.lessonsApplied || [],
      rawResponse: content
    };
  } catch (error: any) {
    console.error('Erreur Gemini Pro:', error);
    throw new Error(`Analyse IA échouée : ${error.message}`);
  }
}
