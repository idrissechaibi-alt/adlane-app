// Connecteur Google Gemini API Pro - Analyse Multi-Marchés Haute Précision

import { Lesson } from '../types';
import { buildSystemPrompt, AIAnalysisOutput, MatchScoutInput } from './omniroute';

export async function analyzeMatchWithGemini(
  matchInput: MatchScoutInput,
  lessons: Lesson[],
  apiKey: string
): Promise<AIAnalysisOutput> {
  const model = 'gemini-2.5-flash'; // Modèle Gemini actif (gemini-1.5-* a été retiré par Google)
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
Le tableau "markets" de ta réponse JSON DOIT contenir EXACTEMENT ces 10 marchés (un objet par marché, dans cet ordre), chacun avec une probabilité réelle (%) justifiée par des stats (xG, forme, cartons moyens, corners concédés) :
1. Résultat Final (1X2) — victoire la plus probable
2. Double Chance (1X ou X2 ou 12)
3. Les deux équipes marquent (BTTS Oui/Non)
4. Total de buts Over/Under 2.5
5. Total de buts Over/Under 1.5
6. Buts en 1ère mi-temps : Over/Under 0.5 but avant la pause
7. Résultat à la mi-temps (1X2 mi-temps)
8. Corners : Over/Under (choisis une ligne réaliste, ex. 9.5)
9. Cartons (jaunes + rouges) : Over/Under (choisis une ligne réaliste, ex. 3.5)
10. Handicap asiatique simplifié (-1 ou +1 sur l'équipe la plus probable)

Ne renvoie JAMAIS moins de 10 marchés. Si une donnée manque, estime prudemment et baisse la confiance à "Faible" plutôt que d'omettre le marché.

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
