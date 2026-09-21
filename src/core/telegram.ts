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
 * Renvoie true seulement si le message est réellement parti — un appelant
 * qui marque un envoi comme "fait" (pour ne jamais le répéter, ex. un
 * calendrier envoyé une seule fois par fenêtre) DOIT vérifier ce retour :
 * sans ça, un échec réseau ponctuel serait à tort marqué "envoyé" et ne
 * serait plus jamais retenté.
 */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  const config = await loadTelegramConfig();
  if (!config) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[Telegram] Envoi échoué (HTTP ${response.status}):`, body);
      return false;
    }
    return true;
  } catch (error: any) {
    console.warn('[Telegram] Envoi échoué:', error?.message);
    return false;
  }
}
