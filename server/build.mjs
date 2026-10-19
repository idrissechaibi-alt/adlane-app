// Construit server/dist/server.js : le moteur de l'app (src/core) + les remplacements Node des modules du téléphone.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = (f) => path.join(here, 'shims', f);

await build({
  entryPoints: [path.join(here, 'main.ts')],
  outfile: path.join(here, 'dist', 'server.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'warning',
  alias: {
    'expo-file-system': shim('expo-file-system.ts'),
    'expo-secure-store': shim('expo-secure-store.ts'),
    'expo-sqlite': shim('expo-sqlite.ts'),
    '@react-native-async-storage/async-storage': shim('async-storage.ts'),
    'react-native': shim('react-native.ts'),
    'expo-notifications': shim('expo-misc.ts'),
    'expo-task-manager': shim('expo-misc.ts'),
    'expo-background-task': shim('expo-misc.ts'),
    'expo-modules-core': shim('expo-misc.ts'),
  },
  external: ['node:*'],
  // Sans le tsconfig de l'app (il dépend d'expo, absent du PC) : avertissements inutiles évités.
  tsconfigRaw: {},
});
console.log('server/dist/server.js prêt');
