// Exécution parallèle bornée — utilisée partout où plusieurs appels Omniroute
// indépendants s'enchaînaient un par un (balayage des pays, vérification des
// matchs fictifs à chaque checkpoint) : chaque appel peut prendre plusieurs
// secondes sur un serveur auto-hébergé, et les faire un par un pouvait faire
// durer un tour manuel plusieurs minutes alors que rien ne les liait entre eux.
//
// La limite de concurrence évite en retour d'envoyer une rafale de dizaines de
// requêtes d'un coup à ce même serveur, qui l'encaisserait mal et pourrait
// elle-même rouvrir un disjoncteur.

/**
 * Applique `fn` à chaque élément de `items`, au plus `limit` exécutions en vol
 * simultanément. Renvoie les résultats dans l'ORDRE DE `items` (pas l'ordre
 * de complétion), comme Promise.all — un appelant qui trie ou dédoublonne
 * ensuite sur la position n'est jamais surpris par un réordonnancement.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
