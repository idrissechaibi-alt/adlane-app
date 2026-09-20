// Garde-fou réseau partagé : un fetch() sans timeout qui reste bloqué (DNS
// lent, serveur qui ne répond jamais) gèle tout ce qui l'attend. Sur un
// écran, ça fige juste cet écran (déjà vu avec SofaScore). Sur la tâche de
// fond, ça bloque TOUT le tour suivant pour toujours — paris fictifs, bilan
// de minuit, tout s'arrête silencieusement. D'où ce wrapper générique,
// utilisé partout où un fetch() a été ajouté depuis (Gemini, Omniroute,
// football-data.org, Football-Data.co.uk).

const DEFAULT_TIMEOUT_MS = 10000;

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
