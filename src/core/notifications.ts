// Notifications — alerte l'utilisateur dès qu'une opportunité de combinaison
// de 2ème mi-temps est détectée par le moniteur de mi-temps. Deux canaux en
// parallèle : la notification locale (garantie, aucune config requise) et,
// si l'utilisateur a configuré un bot dans Paramètres, un relais Telegram
// (voir telegram.ts) — utile pour garder un historique et recevoir l'alerte
// sur d'autres appareils.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { sendTelegramMessage } from './telegram';

const HALFTIME_CHANNEL_ID = 'halftime-opportunities';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let permissionRequested = false;

/**
 * Demande la permission d'envoyer des notifications (idempotent — ne
 * redemande pas si déjà accordée ou déjà refusée dans cette session).
 */
export async function ensureNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(HALFTIME_CHANNEL_ID, {
      name: 'Opportunités mi-temps',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;

  if (permissionRequested && !existing.canAskAgain) return false;
  permissionRequested = true;

  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Envoie une notification locale immédiate, et en parallèle un message
 * Telegram si un bot est configuré (voir telegram.ts) — les deux canaux sont
 * indépendants : l'échec de l'un n'empêche jamais l'autre.
 */
export async function sendLocalNotification(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  const granted = await ensureNotificationPermissions();
  if (granted) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data,
        ...(Platform.OS === 'android' ? { channelId: HALFTIME_CHANNEL_ID } : {}),
      },
      trigger: null, // immédiat
    });
  } else {
    console.warn('[Notifications] Permission refusée, notification locale non envoyée:', title);
  }

  await sendTelegramMessage(`${title}\n\n${body}`);
}
