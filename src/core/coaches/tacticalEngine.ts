// Moteur tactique local des entraîneurs : lit les relevés minute par minute d'un match (serveur PC + téléphone) et en tire
// une lecture (qui domine, rythme, phase, transitions, tension), puis un avis sur une jambe de pari. Gratuit, instantané,
// sans IA : l'IA ne passe qu'aux 20e / 60e minutes (étape 2).

import type { LiveStatsSample } from '../liveStatsStore';
import type { CoachProfile } from './knowledge';

export interface TacticalRead {
  minute: number;
  diff: number;
  state: 'nul' | 'domicile_devant' | 'exterieur_devant';
  /** -1 (extérieur écrase) → +1 (domicile écrase), 0 = équilibre. Mélange possession, tirs, xG, touches dans la surface, passes dans le camp adverse, momentum. */
  dominance: number;
  /** Même mesure sur les ~10 dernières minutes seulement. */
  recentDominance: number | null;
  /** Rythme récent (tirs + corners par minute) rapporté au rythme depuis le coup d'envoi (1 = inchangé). */
  tempoTrend: number | null;
  /** Tirs + corners + fautes par minute depuis le coup d'envoi. */
  eventsPerMin: number;
  /** Fautes + cartons par minute (tension). */
  tension: number;
  phase: 'ouverture' | 'installation' | 'avant_pause' | 'reprise' | 'fenetre_changements' | 'finale';
  /** Profil de jeu : ouvert (beaucoup de tirs des deux côtés), fermé (peu), unilatéral (un camp pousse), haché (beaucoup de fautes). */
  profile: 'ouvert' | 'ferme' | 'unilateral' | 'hache' | 'indetermine';
  momentum: number | null;
  momentumShift: number | null;
  reds: number;
  /** Sources assez complètes pour juger ? (au moins un marqueur avancé ou le détail par équipe) */
  reliable: boolean;
  flags: string[];
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const share = (h: number | undefined, a: number | undefined): number | null => {
  if (h == null || a == null) return null;
  const t = h + a;
  return t <= 0 ? null : (h - a) / t;
};

function dominanceOf(s: LiveStatsSample, base?: LiveStatsSample): number | null {
  const sub = (cur: number | undefined, prev: number | undefined) => (cur == null ? undefined : Math.max(0, cur - (prev ?? 0)));
  const parts: Array<{ v: number; w: number }> = [];
  const add = (v: number | null, w: number) => {
    if (v != null) parts.push({ v, w });
  };
  if (s.side) {
    add(share(sub(s.side.h[0], base?.side?.h[0]), sub(s.side.a[0], base?.side?.a[0])), 1.0);
    add(share(sub(s.side.h[1], base?.side?.h[1]), sub(s.side.a[1], base?.side?.a[1])), 1.2);
    add(share(sub(s.side.h[2], base?.side?.h[2]), sub(s.side.a[2], base?.side?.a[2])), 0.7);
  }
  if (s.possessionHome != null && !base) add((s.possessionHome - 50) / 50, 0.6);
  if (s.adv?.mom != null) add(clamp(s.adv.mom / 100, -1, 1), 1.0);
  if (!parts.length) return null;
  const tw = parts.reduce((a, p) => a + p.w, 0);
  return clamp(parts.reduce((a, p) => a + p.v * p.w, 0) / tw, -1, 1);
}

function phaseOf(minute: number): TacticalRead['phase'] {
  if (minute <= 15) return 'ouverture';
  if (minute <= 30) return 'installation';
  if (minute <= 47) return 'avant_pause';
  if (minute <= 60) return 'reprise';
  if (minute <= 75) return 'fenetre_changements';
  return 'finale';
}

/** Lit le match à partir de ses relevés (triés par minute). Null si aucun relevé exploitable. */
export function readMatch(samples: LiveStatsSample[]): TacticalRead | null {
  const last = [...samples].reverse().find((s) => s.minute >= 1);
  if (!last || last.minute < 1) return null;
  const minute = last.minute;
  const past = [...samples].reverse().find((s) => s.minute <= minute - 8 && s.minute >= minute - 14);
  const diff = last.home - last.away;
  const dominance = dominanceOf(last) ?? 0;
  const recentDominance = past ? dominanceOf(last, past) : null;

  const rate = (s: LiveStatsSample) => (s.shots ?? 0) + (s.corners ?? 0);
  const eventsPerMin = (rate(last) + (last.fouls ?? 0)) / Math.max(1, minute);
  const tempoTrend = past && minute - past.minute > 0 && rate(last) > 0
    ? clamp(((rate(last) - rate(past)) / (minute - past.minute)) / Math.max(0.05, rate(last) / minute), 0, 4)
    : null;
  const tension = ((last.fouls ?? 0) + 3 * (last.cards ?? 0)) / Math.max(1, minute);

  const mom = last.adv?.mom ?? null;
  const momPast = past?.adv?.mom ?? null;
  const momentumShift = mom != null && momPast != null ? mom - momPast : null;

  const shotsPerMin = (last.shots ?? 0) / Math.max(1, minute);
  const foulsPerMin = (last.fouls ?? 0) / Math.max(1, minute);
  let profile: TacticalRead['profile'] = 'indetermine';
  if (last.shots != null) {
    if (Math.abs(dominance) > 0.45) profile = 'unilateral';
    else if (foulsPerMin > 0.34 && shotsPerMin < 0.2) profile = 'hache';
    else if (shotsPerMin >= 0.22) profile = 'ouvert';
    else if (shotsPerMin < 0.14) profile = 'ferme';
  }

  const flags: string[] = [];
  if ((last.reds ?? 0) > 0) flags.push('expulsion');
  if (diff === 0 && Math.abs(dominance) > 0.4 && minute >= 25) flags.push('domination_sans_but');
  if (diff !== 0 && Math.sign(diff) !== Math.sign(dominance) && Math.abs(dominance) > 0.3) flags.push('mene_sans_dominer');
  if (Math.abs(diff) >= 3) flags.push('match_scelle');
  if (tempoTrend != null && tempoTrend >= 1.5) flags.push('rythme_en_hausse');
  if (tempoTrend != null && tempoTrend <= 0.5) flags.push('rythme_en_baisse');
  if (momentumShift != null && Math.abs(momentumShift) >= 40) flags.push('bascule_momentum');
  if (minute >= 75 && Math.abs(diff) === 1) flags.push('dernier_quart_serre');

  return {
    minute,
    diff,
    state: diff === 0 ? 'nul' : diff > 0 ? 'domicile_devant' : 'exterieur_devant',
    dominance: Math.round(dominance * 100) / 100,
    recentDominance: recentDominance == null ? null : Math.round(recentDominance * 100) / 100,
    tempoTrend: tempoTrend == null ? null : Math.round(tempoTrend * 100) / 100,
    eventsPerMin: Math.round(eventsPerMin * 1000) / 1000,
    tension: Math.round(tension * 1000) / 1000,
    phase: phaseOf(minute),
    profile,
    momentum: mom,
    momentumShift,
    reds: last.reds ?? 0,
    reliable: !!(last.side || last.adv),
    flags,
  };
}

export type Stance = 'soutient' | 'neutre' | 'conteste';

export interface CoachOpinion {
  stance: Stance;
  /** Ajustement de confiance proposé (-0.1 → +0.05), appliqué seulement une fois le pouvoir activé (étape 3). */
  adjust: number;
  reasons: string[];
}

const NEUTRAL = (why: string): CoachOpinion => ({ stance: 'neutre', adjust: 0, reasons: [why] });

/** Avis de l'entraîneur sur une jambe : score entre -1 (contre) et +1 (pour) selon la lecture tactique, filtré par sa ligue. */
export function opinionOn(read: TacticalRead | null, coach: CoachProfile, leg: { market: string; selection: string; homeTeam?: string; awayTeam?: string }): CoachOpinion {
  if (!read) return NEUTRAL('Pas de relevé tactique du match.');
  if (!read.reliable) return NEUTRAL('Statistiques trop pauvres pour une lecture tactique.');
  const over = /^plus de/i.test(leg.selection);
  const under = /^moins de/i.test(leg.selection);
  const reasons: string[] = [];
  let score = 0;
  const lens = coach.lens;

  const pushingTeamBehind = read.diff !== 0 && Math.sign(read.diff) !== Math.sign(read.recentDominance ?? read.dominance) && Math.abs(read.recentDominance ?? read.dominance) > 0.25;

  if (leg.market === 'total_buts' || leg.market === 'buts_1ere_mt' || leg.market === 'btts' || leg.market === 'buts_equipe') {
    const wantsMore = leg.market === 'btts' ? !/non/i.test(leg.selection) : over || /oui/i.test(leg.selection);
    const wantsLess = leg.market === 'btts' ? /non/i.test(leg.selection) : under || /0-0|pas de but/i.test(leg.selection);
    let open = 0;
    if (read.profile === 'ouvert') { open += 0.5 * lens.tempo; reasons.push('match ouvert'); }
    if (read.profile === 'ferme') { open -= 0.5 / lens.tempo; reasons.push('match fermé'); }
    if (read.profile === 'hache') { open -= 0.3; reasons.push('match haché'); }
    if (read.flags.includes('rythme_en_hausse')) { open += 0.3; reasons.push('rythme en hausse'); }
    if (read.flags.includes('rythme_en_baisse')) { open -= 0.3; reasons.push('rythme en baisse'); }
    if (read.flags.includes('domination_sans_but')) { open += 0.25 * lens.control; reasons.push('domination sans but'); }
    if (read.flags.includes('match_scelle')) { open -= 0.4; reasons.push('match scellé'); }
    if (pushingTeamBehind) { open += 0.25 * lens.pressing; reasons.push('l’équipe menée pousse'); }
    if (read.flags.includes('expulsion')) { open += 0.1; reasons.push('expulsion'); }
    if (read.minute >= 75 && Math.abs(read.diff) <= 1) { open += 0.15; reasons.push('fin de match serrée'); }
    score = wantsMore ? open : wantsLess ? -open : 0;
  } else if (leg.market === 'corners' || leg.market === 'corners_equipe') {
    let pressure = 0;
    if (Math.abs(read.recentDominance ?? read.dominance) > 0.35) { pressure += 0.4 * lens.setPieces; reasons.push('un camp pousse'); }
    if (pushingTeamBehind) { pressure += 0.3 * lens.pressing; reasons.push('l’équipe menée pousse'); }
    if (read.profile === 'ferme') { pressure -= 0.3; reasons.push('match fermé'); }
    if (read.flags.includes('rythme_en_hausse')) { pressure += 0.25; reasons.push('rythme en hausse'); }
    if (read.flags.includes('rythme_en_baisse')) { pressure -= 0.25; reasons.push('rythme en baisse'); }
    if (read.flags.includes('match_scelle')) { pressure -= 0.3; reasons.push('match scellé'); }
    score = over ? pressure : under ? -pressure : 0;
  } else if (leg.market === 'cartons' || leg.market === 'fautes') {
    let heat = 0;
    if (read.profile === 'hache') { heat += 0.5 * lens.discipline; reasons.push('match haché'); }
    if (read.tension >= 0.45) { heat += 0.3 * lens.discipline; reasons.push('tension élevée'); }
    if (read.tension <= 0.25) { heat -= 0.3; reasons.push('match calme'); }
    if (read.flags.includes('expulsion')) { heat += 0.2; reasons.push('expulsion'); }
    if (read.flags.includes('dernier_quart_serre')) { heat += 0.15; reasons.push('fin de match serrée'); }
    if (read.flags.includes('match_scelle')) { heat -= 0.2; reasons.push('match scellé'); }
    score = over ? heat : under ? -heat : 0;
  } else if (leg.market === '1X2') {
    const sel = leg.selection.toLowerCase();
    const mentions = (t?: string) => !!t && sel.includes(t.toLowerCase());
    const homePick = mentions(leg.homeTeam) && !mentions(leg.awayTeam);
    const awayPick = mentions(leg.awayTeam) && !mentions(leg.homeTeam);
    const side = homePick ? 1 : awayPick ? -1 : 0;
    if (side) {
      const dom = (read.recentDominance ?? read.dominance) * side;
      const ahead = read.diff * side;
      score = clamp(dom * 0.6 * lens.control + clamp(ahead, -2, 2) * 0.15, -1, 1);
      reasons.push(dom > 0.2 ? 'l’équipe choisie domine' : dom < -0.2 ? 'l’équipe choisie subit' : 'équilibre sur le terrain');
      if (ahead < 0 && dom > 0.3) reasons.push('menée mais dominante');
    } else return NEUTRAL('Sélection 1X2 non reconnue.');
  } else {
    return NEUTRAL('Marché sans lecture tactique dédiée.');
  }

  score = clamp(score, -1, 1);
  const stance: Stance = score >= 0.25 ? 'soutient' : score <= -0.25 ? 'conteste' : 'neutre';
  const adjust = stance === 'soutient' ? Math.min(0.05, score * 0.06) : stance === 'conteste' ? Math.max(-0.1, score * 0.12) : 0;
  return { stance, adjust: Math.round(adjust * 1000) / 1000, reasons: reasons.length ? reasons.slice(0, 3) : ['aucun signal marqué'] };
}
