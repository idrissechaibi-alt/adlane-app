// Ancien stockage du téléphone (AsyncStorage) : vide sur le serveur, tout est déjà dans les fichiers de kvStore.
const AsyncStorage = {
  getItem: async (_k: string): Promise<string | null> => null,
  setItem: async (_k: string, _v: string): Promise<void> => {},
  removeItem: async (_k: string): Promise<void> => {},
  getAllKeys: async (): Promise<string[]> => [],
  multiGet: async (keys: readonly string[]): Promise<Array<[string, string | null]>> => keys.map((k) => [k, null]),
  multiRemove: async (_k: readonly string[]): Promise<void> => {},
  clear: async (): Promise<void> => {},
};
export default AsyncStorage;
