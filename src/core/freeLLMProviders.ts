// Pool de moteurs IA gratuits de secours (rapport, item G).
//
// Contexte : une panne réelle de crédits Gemini a bloqué l'analyse pendant
// cette session, alors qu'Omniroute n'était configuré chez l'utilisateur
// qu'avec des agents payants/personnels. Ce module ajoute 2-3 API gratuites
// bien connues (voir mnfst/awesome-free-llm-apis) comme secours automatique
// AVANT Omniroute — elles ne coûtent rien et ne dépendent pas de la config
// personnelle de l'utilisateur, juste d'une clé gratuite à créer une fois.
//
// Toutes les trois exposent une API "chat completions" compatible OpenAI —
// exactement ce que sait déjà appeler analyzeMatchWithOmniroute (endpoint +
// clé + nom de modèle). On réutilise donc cette fonction telle quelle plutôt
// que de dupliquer l'appel HTTP/le parsing JSON : chaque provider n'est
// qu'une "config Omniroute" avec un endpoint et un modèle différents.

import * as SecureStore from 'expo-secure-store';
import { Lesson } from '../types';
import { analyzeMatchWithOmniroute, AIAnalysisOutput, MatchScoutInput } from './omniroute';

export interface FreeLLMProvider {
  id: string;
  label: string;
  endpoint: string;
  defaultModel: string;
  keyStorageKey: string;
  /** Où créer une clé gratuite, affiché dans Paramètres. */
  signupHint: string;
}

export const FREE_LLM_PROVIDERS: FreeLLMProvider[] = [
  {
    id: 'groq',
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyStorageKey: 'app-adlane.groq-api-key',
    signupHint: 'Clé gratuite sur console.groq.com',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    keyStorageKey: 'app-adlane.openrouter-api-key',
    signupHint: 'Clé gratuite sur openrouter.ai (modèles suffixés ":free")',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    endpoint: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
    keyStorageKey: 'app-adlane.cerebras-api-key',
    signupHint: 'Clé gratuite sur cloud.cerebras.ai',
  },
];

export async function getFreeLLMKey(provider: FreeLLMProvider): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(provider.keyStorageKey);
  } catch {
    return null;
  }
}

export async function setFreeLLMKey(provider: FreeLLMProvider, apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(provider.keyStorageKey, apiKey);
}

/** Providers pour lesquels l'utilisateur a effectivement renseigné une clé. */
export async function getConfiguredFreeLLMProviders(): Promise<Array<{ provider: FreeLLMProvider; apiKey: string }>> {
  const configured: Array<{ provider: FreeLLMProvider; apiKey: string }> = [];
  for (const provider of FREE_LLM_PROVIDERS) {
    const apiKey = await getFreeLLMKey(provider);
    if (apiKey) configured.push({ provider, apiKey });
  }
  return configured;
}

/**
 * Essaie chaque provider gratuit configuré, dans l'ordre, jusqu'au premier
 * succès. Renvoie null (jamais une exception) si aucun n'est configuré, pour
 * que l'appelant puisse passer silencieusement au secours suivant (Omniroute)
 * sans traiter "aucune clé" comme une erreur d'analyse.
 */
export async function analyzeMatchWithFreeLLMPool(
  matchInput: MatchScoutInput,
  lessons: Lesson[]
): Promise<{ result: AIAnalysisOutput; providerLabel: string } | null> {
  const configured = await getConfiguredFreeLLMProviders();
  if (configured.length === 0) return null;

  const failed: Array<{ provider: string; error: string }> = [];

  for (const { provider, apiKey } of configured) {
    try {
      const result = await analyzeMatchWithOmniroute(matchInput, lessons, {
        endpoint: provider.endpoint,
        apiKey,
        selectedModel: provider.defaultModel,
        availableModels: [provider.defaultModel],
      });
      return { result, providerLabel: provider.label };
    } catch (error: any) {
      failed.push({ provider: provider.label, error: error?.message || String(error) });
      console.warn(`[Pool IA gratuit] ${provider.label} a échoué, passage au suivant:`, error?.message);
    }
  }

  console.warn('[Pool IA gratuit] Tous les providers configurés ont échoué:', failed);
  return null;
}
