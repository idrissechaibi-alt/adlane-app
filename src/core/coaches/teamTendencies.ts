// Tendances de jeu par équipe, tirées d'analyses vidéo (vague 1, novembre 2026) : style, réactions selon le score et l'adversaire.
// Chaque fiche porte sa confiance (une analyse de match unique = « faible », plusieurs sources concordantes = « moyenne »).
// Usage : lecture du duel (style contre style) avant et pendant le match, avis de l'entraîneur (mode ombre : rien n'est modifié tant que
// le pouvoir n'est pas activé, voir coachDesk.ts) et briefing remis à l'analyse IA (knowledgeBase.ts).
// Valeur absente = inconnu, jamais « neutre » : un indicateur n'existe que s'il est appuyé par une source.

import tendenciesData from './data/team-tendencies.json';
import { clubCoachOf } from './clubCoaches';

export type Conf = 'haute' | 'moyenne' | 'faible';

export interface TeamTendency {
  club: string;
  conf: Conf;
  /** Identifiants des vidéos sources. */
  sources: string[];
  shape?: string;
  /** Indicateurs de 0 à 1 (0,5 = moyenne de la ligue) : seuls ceux appuyés par une source existent. */
  tags: {
    /** 0 subit le ballon … 1 le monopolise. */
    possession?: number;
    /** Intensité et hauteur du pressing. */
    press?: number;
    /** Hauteur de la ligne défensive. */
    line?: number;
    /** Danger en contre-attaque et en transition. */
    counter?: number;
    /** Danger sur coups de pied arrêtés et touches longues. */
    setPieces?: number;
    /** Jeu sur les côtés, centres. */
    crosses?: number;
    /** Solidité défensive (1 = très solide). */
    solid?: number;
    /** 0 matchs fermés, peu de tirs … 1 matchs ouverts, beaucoup de buts. */
    tempo?: number;
  };
  /** Quand elle mène : se replie, continue d'attaquer, ou gère. */
  leading?: 'bloc_bas' | 'continue' | 'gere';
  /** Quand elle est menée. */
  trailing?: 'pousse' | 's_effondre' | 'jeu_direct' | 'inchange';
  /** Début de match (premières minutes). */
  start?: 'rapide' | 'fragile' | 'lent';
  /** Début de seconde période. */
  start2h?: 'mou' | 'fragile';
  /** Fin de match : l'intensité baisse (concède tard) ou monte (marque tard). */
  late?: 'baisse' | 'monte';
  /** Face à un pressing haut. */
  vsPress?: 'bien' | 'souffre';
  /** Face à un bloc bas. */
  vsBlock?: 'bien' | 'souffre';
  notes: string;
  patterns: string[];
}

const TENDENCIES = tendenciesData as unknown as TeamTendency[];

/** Poids d'une fiche selon sa confiance : une fiche faible ne pèse presque rien. */
export const CONF_WEIGHT: Record<Conf, number> = { haute: 1, moyenne: 0.6, faible: 0.25 };

/** Fiche de tendances d'une équipe (par nom d'équipe, quelle que soit la source), ou null. */
export function tendencyOf(team: string | undefined | null): TeamTendency | null {
  const entry = clubCoachOf(team);
  if (!entry) return null;
  return TENDENCIES.find((t) => t.club === entry.club) ?? null;
}

export interface Matchup {
  /** Schémas reconnus entre les deux styles (identifiants stables, lisibles). */
  flags: string[];
  /** -1 duel fermé … +1 duel ouvert ; 0 sans information. */
  tempoBias: number;
  /** Explications courtes en français, pour le briefing et le journal d'avis. */
  notes: string[];
  /** Poids total des fiches disponibles (0 = aucune information utile). */
  weight: number;
}

const has = (x: number | undefined): x is number => typeof x === 'number';
const w = (t: TeamTendency | null) => (t ? CONF_WEIGHT[t.conf] : 0);

/** Lecture du duel avant le match : quel style rencontre quel style. */
export function matchupOf(home: TeamTendency | null, away: TeamTendency | null): Matchup {
  const flags: string[] = [];
  const notes: string[] = [];
  const wh = w(home);
  const wa = w(away);
  // Rythme : moyenne pondérée des deux équipes (une seule fiche pèse deux fois moins).
  const tempos = [home?.tags.tempo != null ? { v: home.tags.tempo, w: wh } : null, away?.tags.tempo != null ? { v: away.tags.tempo, w: wa } : null].filter((x): x is { v: number; w: number } => !!x);
  const tw = tempos.reduce((s, x) => s + x.w, 0);
  const tempoBias = tw > 0 ? Math.max(-1, Math.min(1, (tempos.reduce((s, x) => s + (x.v - 0.5) * 2 * x.w, 0) / tw) * Math.min(1, tw / 1.2))) : 0;

  if (home && away) {
    const h = home.tags;
    const a = away.tags;
    const pair = (x: TeamTendency, y: TeamTendency, label: (n: string, o: string) => string, test: (xt: TeamTendency['tags'], yt: TeamTendency['tags'], x: TeamTendency, y: TeamTendency) => boolean, flag: string) => {
      if (test(x.tags, y.tags, x, y)) {
        flags.push(flag);
        notes.push(label(x.club, y.club));
      }
    };
    for (const [x, y] of [[home, away], [away, home]] as const) {
      // Une équipe qui domine le ballon contre un bloc bas qui défend en nombre.
      pair(x, y, (n, o) => `${n} domine le ballon contre le bloc bas de ${o} : beaucoup de tirs et de corners, peu de buts.`, (xt, yt) => has(xt.possession) && xt.possession >= 0.7 && has(yt.line) && yt.line <= 0.3 && (!has(yt.possession) || yt.possession <= 0.45), 'domine_contre_bloc_bas');
      // Contre-attaque contre ligne haute.
      pair(x, y, (n, o) => `${n} est dangereux en transition et ${o} défend haut : espaces dans son dos.`, (xt, yt) => has(xt.counter) && xt.counter >= 0.7 && has(yt.line) && yt.line >= 0.7, 'contre_contre_ligne_haute');
      // Pressing intense contre une équipe qui souffre sous pressing.
      pair(x, y, (n, o) => `${n} presse très haut et ${o} souffre sous pressing : erreurs de relance probables.`, (xt, _yt, _x, yy) => has(xt.press) && xt.press >= 0.8 && yy.vsPress === 'souffre', 'pressing_contre_relance_fragile');
      // Coups de pied arrêtés contre une défense fragile.
      pair(x, y, (n, o) => `${n} est dangereux sur coups de pied arrêtés et ${o} défend sans solidité : corners et buts de la tête.`, (xt, yt) => has(xt.setPieces) && xt.setPieces >= 0.75 && has(yt.solid) && yt.solid <= 0.45, 'coups_de_pied_arretes_contre_defense_fragile');
      // Équipe qui souffre contre un bloc bas, face à un bloc bas.
      pair(x, y, (n, o) => `${n} souffre contre les blocs bas et ${o} se replie : match fermé.`, (_xt, yt, xx) => xx.vsBlock === 'souffre' && has(yt.line) && yt.line <= 0.3, 'bloc_bas_contre_equipe_qui_souffre');
    }
    if (has(h.solid) && has(a.solid) && h.solid <= 0.4 && a.solid <= 0.4) {
      flags.push('deux_defenses_fragiles');
      notes.push('Deux défenses fragiles : les deux équipes ont de bonnes chances de marquer.');
    }
    if (has(h.tempo) && has(a.tempo) && h.tempo <= 0.35 && a.tempo <= 0.35) {
      flags.push('deux_equipes_fermees');
      notes.push('Deux équipes qui jouent des matchs fermés : peu de tirs, peu de buts.');
    }
    if (has(h.press) && has(a.press) && h.press >= 0.7 && a.press >= 0.7 && has(h.line) && has(a.line) && h.line >= 0.6 && a.line >= 0.6) {
      flags.push('deux_pressings_hauts');
      notes.push('Deux pressings hauts et deux lignes hautes : duel ouvert, transitions dans les deux sens.');
    }
  }
  return { flags, tempoBias: Math.round(tempoBias * 100) / 100, notes, weight: wh + wa };
}

/** Situation d'une équipe au moment du match, du point de vue de cette équipe. */
export interface TeamSituation {
  minute: number;
  /** Buts pour moins buts contre. */
  diff: number;
  /** Mi-temps passée. */
  secondHalf: boolean;
}

/** Comportement attendu d'une équipe dans la situation donnée : phrases courtes (vide si la fiche ne dit rien). */
export function expectedBehavior(t: TeamTendency | null, s: TeamSituation): string[] {
  if (!t) return [];
  const out: string[] = [];
  if (s.diff > 0) {
    if (t.leading === 'bloc_bas') out.push(`${t.club} mène : il recule en bloc bas.`);
    else if (t.leading === 'continue') out.push(`${t.club} mène : il continue d'attaquer.`);
    else if (t.leading === 'gere') out.push(`${t.club} mène : il gère le score.`);
  } else if (s.diff < 0) {
    if (t.trailing === 'pousse') out.push(`${t.club} est mené : il pousse fort.`);
    else if (t.trailing === 's_effondre') out.push(`${t.club} est mené : il a tendance à craquer.`);
    else if (t.trailing === 'jeu_direct') out.push(`${t.club} est mené : ballons longs et centres.`);
  }
  if (s.minute <= 25 && t.start === 'fragile') out.push(`${t.club} démarre souvent mal.`);
  if (s.minute <= 25 && t.start === 'rapide') out.push(`${t.club} démarre vite.`);
  if (s.secondHalf && s.minute <= 62 && t.start2h) out.push(`${t.club} entame mal la seconde période.`);
  if (s.minute >= 70 && t.late === 'baisse') out.push(`${t.club} baisse en fin de match.`);
  if (s.minute >= 70 && t.late === 'monte') out.push(`${t.club} monte en fin de match.`);
  return out;
}

/** Texte de briefing pour l'analyse IA : observations vidéo d'un club (borné). */
export function tendencyBlock(team: string): string {
  const t = tendencyOf(team);
  if (!t || (!t.notes && !t.patterns.length)) return '';
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const lines = [
    `Observations vidéo [confiance ${t.conf}, ${t.sources.length} source(s)]${t.shape ? ` — schéma ${t.shape}` : ''} : ${clip(t.notes, 520)}`,
    t.patterns.length ? `Schémas à surveiller : ${t.patterns.slice(0, 3).map((p) => clip(p, 200)).join(' | ')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/** Texte de briefing pour l'analyse IA : lecture du duel entre les deux équipes. */
export function matchupBlock(homeTeam: string, awayTeam: string): string {
  const m = matchupOf(tendencyOf(homeTeam), tendencyOf(awayTeam));
  if (!m.notes.length) return '';
  return `# Duel de styles (d'après les analyses vidéo)\n${m.notes.map((n) => `- ${n}`).join('\n')}`;
}
