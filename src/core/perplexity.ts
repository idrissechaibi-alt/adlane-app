// Connecteur Perplexity Search API — recherche web en direct
// Utilisé pour enrichir le Scouting IA avec des infos réelles et récentes
// (compositions probables, actualités/blessures) que les LLM seuls n'ont pas.
// Documentation : https://docs.perplexity.ai/docs/search/quickstart

const SEARCH_ENDPOINT = 'https://api.perplexity.ai/search';

export interface PerplexitySearchResult {
  title: string;
  url: string;
  snippet: string;
  date: string | null;
}

export interface PerplexitySearchResponse {
  results: PerplexitySearchResult[];
}

/**
 * Effectue une recherche web via Perplexity et renvoie les extraits pertinents.
 */
export async function searchWeb(
  query: string,
  apiKey: string,
  maxResults: number = 5
): Promise<PerplexitySearchResponse> {
  const response = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_context_size: 'medium'
    })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Erreur Perplexity HTTP ${response.status}${bodyText ? ` : ${bodyText}` : ''}`);
  }

  const data = await response.json();
  return {
    results: (data.results || []).map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.snippet || '',
      date: r.date || null
    }))
  };
}

/**
 * Recherche les compositions probables et l'actualité (blessures/suspensions)
 * d'un match, pour enrichir le contexte fourni à l'analyse IA.
 * Renvoie un texte prêt à injecter dans le prompt, plus les sources utilisées.
 */
export async function fetchMatchContext(
  homeTeam: string,
  awayTeam: string,
  apiKey: string
): Promise<{ contextText: string; sources: PerplexitySearchResult[] }> {
  const queries = [
    `composition probable ${homeTeam} vs ${awayTeam}`,
    `blessures suspensions ${homeTeam} ${awayTeam} actualité`
  ];

  const allResults: PerplexitySearchResult[] = [];

  for (const query of queries) {
    try {
      const { results } = await searchWeb(query, apiKey, 4);
      allResults.push(...results);
    } catch (error: any) {
      console.warn('[Perplexity] Recherche échouée pour', query, ':', error.message);
    }
  }

  if (allResults.length === 0) {
    return { contextText: '', sources: [] };
  }

  const contextText = allResults
    .map((r) => `- [${r.date || 'date inconnue'}] ${r.title} : ${r.snippet} (source : ${r.url})`)
    .join('\n');

  return { contextText, sources: allResults };
}
