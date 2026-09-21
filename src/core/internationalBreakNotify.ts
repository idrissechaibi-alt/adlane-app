// Colle entre le calendrier de la trêve internationale (internationalBreak.ts,
// pur) et l'envoi Telegram (telegram.ts) — séparé pour que internationalBreak.ts
// reste testable sans réseau, et réutilisable à la fois par l'envoi
// automatique (une fois par fenêtre, voir inPlayCombos.ts) et par le bouton
// manuel de Paramètres.

import { INTERNATIONAL_BREAK_CALENDAR } from '../data/internationalBreakCalendar';
import { formatInternationalBreakCalendarMessages } from './internationalBreak';
import { sendTelegramMessage } from './telegram';

/**
 * Envoie le calendrier complet sur Telegram, sans condition (ni fenêtre de
 * dates, ni déduplication — c'est à l'appelant de gérer ça si besoin, voir
 * announceInternationalBreakCalendarIfDue dans inPlayCombos.ts). Renvoie
 * true seulement si TOUS les messages sont réellement partis.
 */
export async function sendInternationalBreakCalendarNow(): Promise<boolean> {
  if (INTERNATIONAL_BREAK_CALENDAR.matches.length === 0) return false;

  let allSucceeded = true;
  for (const message of formatInternationalBreakCalendarMessages(INTERNATIONAL_BREAK_CALENDAR)) {
    const sent = await sendTelegramMessage(message);
    if (!sent) allSucceeded = false;
  }
  return allSucceeded;
}
