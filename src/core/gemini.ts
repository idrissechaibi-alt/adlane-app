// Connecteur Google Gemini API Pro - Analyse Multi-Marchés Haute Précision

import { Lesson } from '../types';
import { buildSystemPrompt, AIAnalysisOutput, MatchScoutInput } from './omniroute';
import { fetchWithTimeout } from './httpTimeout';

// Google retire régulièrement les anciennes versions de Gemini. On pointe sur un
// modèle stable précis (recommandé par Google pour la prod), avec des secours
// en cas de retrait, pour ne pas dépendre d'un correctif manuel à chaque fois.
const GEMINI_MODEL_CANDIDATES = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];

function isModelUnavailableError(message: string): boolean {
  return /no longer available|not found|deprecated/i.test(message);
}

export interface GoogleSearchSource {
  title: string;
  url: string;
}

/**
 * Recherche Google en direct via l'outil natif "google_search" de Gemini
 * (le compte de l'utilisateur est déjà lié par sa clé API — aucune clé
 * supplémentaire nécessaire). Utilisé pour les recherches factuelles de base
 * (compositions probables, horaires, confrontations précédentes) avant de
 * lancer l'analyse structurée à 10 marchés.
 *
 * Appel séparé, en texte libre (pas de responseSchema/JSON strict) : l'outil
 * de recherche Google n'est pas garanti compatible avec la sortie JSON forcée
 * de generateContent, donc on ne mélange jamais les deux dans le même appel.
 */
export async function fetchGoogleSearchContext(
  homeTeam: string,
  awayTeam: string,
  apiKey: string
): Promise<{ contextText: string; sources: GoogleSearchSource[] }> {
  const prompt = `Recherche sur Google des informations factuelles et à jour pour le match de football ${homeTeam} vs ${awayTeam} :
1. Compositions probables / titulaires attendus des deux équipes
2. Horaire exact et lieu du match
3. Historique des confrontations précédentes (résultats des derniers face-à-face)
4. Blessures, suspensions ou absences notables

Réponds en français, sous forme de liste factuelle concise (pas de conseil de pari, pas de pronostic). Si une information n'est pas trouvée, dis-le simplement plutôt que d'inventer.`;

  let lastError: Error | null = null;

  for (const model of GEMINI_MODEL_CANDIDATES) {
    try {
      const response = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.1 }
          })
        },
        20000 // recherche Google + synthèse : plus long qu'un appel LLM simple
      );

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const message = err.error?.message || `HTTP ${response.status}`;
        if (isModelUnavailableError(message)) {
          lastError = new Error(message);
          continue;
        }
        throw new Error(message);
      }

      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const contextText = parts.map((p: any) => p.text || '').join('\n').trim();

      const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const sources: GoogleSearchSource[] = chunks
        .map((c: any) => ({ title: c.web?.title || '', url: c.web?.uri || '' }))
        .filter((s: GoogleSearchSource) => s.url);

      return { contextText, sources };
    } catch (error: any) {
      lastError = error;
      if (isModelUnavailableError(error.message || '')) continue;
      console.warn('[Gemini] Recherche Google échouée:', error.message);
      return { contextText: '', sources: [] };
    }
  }

  console.warn('[Gemini] Recherche Google indisponible sur tous les modèles candidats:', lastError?.message);
  return { contextText: '', sources: [] };
}

export async function analyzeMatchWithGemini(
  matchInput: MatchScoutInput,
  lessons: Lesson[],
  apiKey: string
): Promise<AIAnalysisOutput> {
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

  let lastError: Error | null = null;

  for (const model of GEMINI_MODEL_CANDIDATES) {
    try {
      const response = await fetchWithTimeout(
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
        },
        20000
      );

      if (!response.ok) {
        const err = await response.json();
        const message = err.error?.message || `HTTP ${response.status}`;
        if (isModelUnavailableError(message)) {
          console.warn(`[Gemini] Modèle "${model}" indisponible, tentative du suivant...`);
          lastError = new Error(`Erreur API Gemini Pro : ${message}`);
          continue;
        }
        throw new Error(`Erreur API Gemini Pro : ${message}`);
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
      if (isModelUnavailableError(error.message || '')) {
        lastError = error;
        continue;
      }
      console.error('Erreur Gemini Pro:', error);
      throw new Error(`Analyse IA échouée : ${error.message}`);
    }
  }

  console.error('Erreur Gemini Pro: tous les modèles candidats sont indisponibles', lastError);
  throw new Error(`Analyse IA échouée : ${lastError?.message || 'Aucun modèle Gemini disponible'}`);
}
