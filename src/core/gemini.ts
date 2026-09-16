// Connecteur direct Google Gemini API

import { Lesson } from '../types';
import { buildSystemPrompt, AIAnalysisOutput, MatchScoutInput } from './omniroute';

export async function analyzeMatchWithGemini(
  matchInput: MatchScoutInput,
  lessons: Lesson[],
  apiKey: string,
  model: string = 'gemini-1.5-flash'
): Promise<AIAnalysisOutput> {
  const systemPrompt = buildSystemPrompt(lessons);
  const userPrompt = `Analyse ce match de football :
Match : ${matchInput.homeTeam} vs ${matchInput.awayTeam}
Compétition : ${matchInput.league}
Coup d'envoi (UTC) : ${matchInput.kickoff_utc}
Cotes bookmakers fournies : ${JSON.stringify(matchInput.odds || 'donnée indisponible')}
Contexte (arbitre/compos/absences) : ${matchInput.contextInfo || 'donnée indisponible'}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
          }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Erreur Gemini API : ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(content);

    return {
      match: `${matchInput.homeTeam} - ${matchInput.awayTeam}`,
      kickoff_utc: matchInput.kickoff_utc,
      markets: parsed.markets || [],
      generalAnalysis: parsed.generalAnalysis || 'Analyse effectuée par Gemini.',
      lessonsApplied: parsed.lessonsApplied || [],
      rawResponse: content
    };
  } catch (error: any) {
    console.error('Erreur appel Gemini:', error);
    throw new Error(`Analyse Gemini échouée : ${error.message}`);
  }
}
