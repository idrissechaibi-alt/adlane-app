// Compétitions internationales pendant la trêve (Ligue des Nations UEFA,
// qualifications CAN) — le calendrier est connu à l'avance (contrairement au
// programme fictif, qui doit le découvrir jour par jour) : compilé UNE FOIS
// depuis des sources officielles (uefa.com, cafonline.com, Wikipédia) et
// embarqué comme fichier statique (voir data/international-break-*.json).
//
// Traité comme les 5 grands championnats (notifié, combos par créneau,
// toutes les ressources) — c'est la seule chose qui se joue pendant la
// trêve. Actif UNIQUEMENT entre windowStart et windowEnd du calendrier
// fourni : en dehors, aucun effet, aucun appel réseau (voir inPlayCombos.ts).
//
// Logique pure ici (aucun accès réseau/disque) pour rester testable sans les
// modules natifs qu'Omniroute/AsyncStorage entraînent ailleurs.

export interface InternationalBreakMatch {
  /** YYYY-MM-DD, date locale du coup d'envoi. */
  date: string;
  /** ISO 8601 UTC, ou null si l'heure n'était pas confirmée à la compilation du calendrier. */
  kickoff_utc: string | null;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  group: string;
}

export interface InternationalBreakCalendar {
  windowStart: string;
  windowEnd: string;
  matches: InternationalBreakMatch[];
}

export function isWithinBreakWindow(calendar: InternationalBreakCalendar, date: string): boolean {
  return date >= calendar.windowStart && date <= calendar.windowEnd;
}

/** Matchs d'une date donnée, uniquement si cette date tombe dans la fenêtre
 * de la trêve — hors fenêtre, toujours vide, quel que soit le contenu du
 * calendrier (garde-fou "seulement durant cette trêve"). */
export function matchesForDate(calendar: InternationalBreakCalendar, date: string): InternationalBreakMatch[] {
  if (!isWithinBreakWindow(calendar, date)) return [];
  return calendar.matches.filter((m) => m.date === date);
}

/** Telegram refuse un message au-delà de 4096 caractères. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

function formatKickoff(match: InternationalBreakMatch): string {
  if (!match.kickoff_utc) return `${match.date} (heure à confirmer)`;
  const time = new Date(match.kickoff_utc).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${match.date} ${time} UTC`;
}

/**
 * Un message Telegram par compétition (le calendrier complet dépasserait
 * largement la limite Telegram sur une seule compétition, a fortiori deux) —
 * groupé par groupe/ligue puis trié par date, pour rester lisible.
 */
export function formatInternationalBreakCalendarMessages(calendar: InternationalBreakCalendar): string[] {
  const byCompetition = new Map<string, InternationalBreakMatch[]>();
  for (const m of calendar.matches) {
    const arr = byCompetition.get(m.competition) ?? [];
    arr.push(m);
    byCompetition.set(m.competition, arr);
  }

  const messages: string[] = [];
  for (const [competition, matches] of byCompetition.entries()) {
    const byGroup = new Map<string, InternationalBreakMatch[]>();
    for (const m of matches) {
      const arr = byGroup.get(m.group) ?? [];
      arr.push(m);
      byGroup.set(m.group, arr);
    }

    const lines = [
      `🏆 ${competition} — trêve internationale du ${calendar.windowStart} au ${calendar.windowEnd}`,
      `${matches.length} match(s), pronos 20e/60e activés pour chacun.`,
    ];
    for (const [group, groupMatches] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push('', `📋 ${group}`);
      for (const m of [...groupMatches].sort((a, b) => (a.kickoff_utc ?? a.date).localeCompare(b.kickoff_utc ?? b.date))) {
        lines.push(`${formatKickoff(m)} — ${m.homeTeam} - ${m.awayTeam}`);
      }
    }

    const text = lines.join('\n');
    messages.push(
      text.length > TELEGRAM_MAX_MESSAGE_LENGTH
        ? `${text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH)}\n… (liste tronquée, voir l'app pour le détail complet)`
        : text
    );
  }

  return messages;
}
