// Écran toujours allumé tant que l'app est au premier plan (comme une vidéo) : le scan de 60 s ne s'arrête plus quand le
// téléphone se met en veille. Module natif d'Expo (ExpoKeepAwake, livré avec expo) chargé en optionnel : si l'installation ne
// le contient pas, rien ne casse.

import { requireOptionalNativeModule } from 'expo-modules-core';

const TAG = 'adlane-live';
const native = (() => {
  try {
    return requireOptionalNativeModule<{ activate(tag: string): Promise<void>; deactivate(tag: string): Promise<void> }>('ExpoKeepAwake');
  } catch {
    return null;
  }
})();

export function keepScreenOn(): boolean {
  if (!native) return false;
  native.activate(TAG).catch(() => {});
  return true;
}

export function releaseScreen(): void {
  native?.deactivate(TAG).catch(() => {});
}

export const keepAwakeAvailable = (): boolean => native != null;
