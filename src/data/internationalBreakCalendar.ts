// Calendrier compilé à la main (sources officielles : uefa.com, cafonline.com,
// pages Wikipédia des compétitions) pour la trêve internationale de
// septembre-octobre 2026 — UEFA Nations League 2026-27 (phase de ligue) et
// qualifications CAN 2027 (journées 1-2). Voir src/core/internationalBreak.ts
// pour la logique qui l'utilise (fenêtre de dates, filtrage par jour,
// formatage Telegram).
//
// Mis à jour manuellement à chaque nouvelle fenêtre de trêve (prochaine :
// journées 3-4 CAN + suite Nations League, 9-17 novembre 2026).

import { InternationalBreakCalendar } from '../core/internationalBreak';

export const INTERNATIONAL_BREAK_CALENDAR: InternationalBreakCalendar = {
  windowStart: '2026-09-21',
  windowEnd: '2026-10-06',
  matches: [],
};
