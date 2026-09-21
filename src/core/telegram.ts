// Notifications Telegram — relais optionnel des mêmes alertes que les
// notifications locales (voir notifications.ts), vers un bot Telegram
// personnel. Intérêt : l'alerte arrive même écran éteint/app en arrière-plan,
// avec un historique conservé dans la conversation Telegram, et visible sur
// n'importe quel appareil connecté au même compte Telegram.
//
// Bot token et chat_id restent stockés localement (AsyncStorage) ; seul un
// appel HTTP direct vers api.telegram.org (API officielle des bots Telegram)
// est fait, jamais vers un autre service.

import AsyncStorage from '@react-native-async-storage/async-storage';

const TELEGRAM_CONFIG_KEY = '@telegram_config';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

export async function loadTelegramConfig(): Promise<TelegramConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(TELEGRAM_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.enabled || !parsed.botToken?.trim() || !parsed.chatId?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Envoie un message texte au chat Telegram configuré. Ne jette jamais : une
 * alerte Telegram manquée ne doit jamais faire échouer la détection
 * d'opportunité elle-même (la notification locale reste le canal garanti).
 */
export async function sendTelegramMessage(text: string): Promise<void> {
  const config = await loadTelegramConfig();
  if (!config) return;

  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[Telegram] Envoi échoué (HTTP ${response.status}):`, body);
    }
  } catch (error: any) {
    console.warn('[Telegram] Envoi échoué:', error?.message);
  }
}
