// Base de connaissances des entraîneurs : fiches de clubs, dossiers de ligue, faits issus de thèses / articles / rapports officiels et
// glossaire. Les données viennent de scripts/coaches/build-knowledge.py (recherche du 25-26/10/2026, sources dans chaque entrée) et sont
// rafraîchies par ce script ; rien n'est tiré d'internet à l'exécution.

import clubsData from './data/clubs.json';
import leaguesData from './data/leagues.json';
import factsData from './data/facts.json';
import glossaryData from './data/glossary.json';
import { CLUB_STATS, type TeamWindow } from './leagueStats';
import { clubCoachOf } from './clubCoaches';
import { coachForLeague, coachSystemPrompt, type CoachProfile } from './knowledge';

export interface ClubProfile {
  club: string;
  coach: string;
  formation_main: string | null;
  formations_alt?: string[] | null;
  style_fr: string | null;
  build_up_fr: string | null;
  pressing_fr: string | null;
  transitions_fr: string | null;
  set_pieces_fr: string | null;
  strengths_fr?: string[] | null;
  weaknesses_fr?: string[] | null;
  key_players?: string[] | null;
  betting_relevant_fr?: string[] | null;
  coach_profile_fr: string | null;
  absents_dates?: unknown;
  confidence: 'haute' | 'moyenne' | 'faible' | null;
  asOf?: string;
}
export interface KnowledgeFact {
  id: string;
  topic: string;
  fact_fr: string;
  use_fr?: string | null;
  caveat_fr?: string | null;
  confidence?: string | null;
  source?: { citation?: string; url?: string; read?: string } | null;
}
export interface LeagueDossier {
  league: string;
  trends_fr?: string[];
  rules_changes_fr?: string[];
  referee_notes_fr?: string[];
  typical_game_script_fr?: string;
  confidence?: string;
  asOf?: string;
}

const CLUBS = clubsData as unknown as ClubProfile[];
const LEAGUES = leaguesData as unknown as Record<string, LeagueDossier>;
const FACTS = factsData as unknown as KnowledgeFact[];

export const KNOWLEDGE_STATS = () => ({ clubs: CLUBS.length, facts: FACTS.length, glossary: (glossaryData as unknown[]).length, leagues: Object.keys(LEAGUES).length });

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Fiche tactique du club (par nom d'équipe), ou null. */
export function clubProfileOf(team: string | undefined | null): ClubProfile | null {
  const entry = clubCoachOf(team);
  if (!entry) return null;
  return CLUBS.find((c) => c.club === entry.club) ?? null;
}

export function leagueDossierOf(league: string | undefined | null): LeagueDossier | null {
  if (!league) return null;
  const l = strip(league);
  const key = Object.keys(LEAGUES).find((k) => strip(k).includes(l) || l.includes(strip(k)) || strip(LEAGUES[k].league ?? '').includes(l));
  return key ? LEAGUES[key] : null;
}

type Tag = 'corners' | 'cartons' | 'buts' | 'remplacements' | 'rouge' | 'arbitrage' | 'temps' | 'formation' | 'pressing' | 'transition' | 'cotes' | 'xg' | 'domicile' | 'score';
const TAG_PATTERNS: Array<[Tag, RegExp]> = [
  ['corners', /corner|coup[s]? de pied arr|touche[s]? longue|set[- ]piece/i],
  ['cartons', /carton|jaune|faute|discipl/i],
  ['rouge', /rouge|infériorité|supériorité numérique/i],
  ['buts', /\bbuts?\b|score|marqu|poisson|dixon|btts|2,5/i],
  ['remplacements', /remplac|substitut/i],
  ['arbitrage', /arbitr|var\b|referee/i],
  ['temps', /temps additionnel|arrêts de jeu|temps perdu|gaspillage de temps/i],
  ['formation', /formation|système|3-4|4-2-3|4-3-3|défense à 3/i],
  ['pressing', /pressing|ppda|récupération|bloc/i],
  ['transition', /transition|contre-attaque|contre|rest defense/i],
  ['cotes', /cote|bookmaker|marché|efficience|betfair|pinnacle|handicap/i],
  ['xg', /\bxg\b|expected/i],
  ['domicile', /domicile|huis clos|public/i],
  ['score', /état du score|menant|mené|score/i],
];
const tagsOf = (f: KnowledgeFact): Set<Tag> => {
  const text = `${f.topic} ${f.fact_fr}`;
  return new Set(TAG_PATTERNS.filter(([, re]) => re.test(text)).map(([t]) => t));
};
const FACT_TAGS = new Map<string, Set<Tag>>();
const factTags = (f: KnowledgeFact) => {
  let t = FACT_TAGS.get(f.id);
  if (!t) FACT_TAGS.set(f.id, (t = tagsOf(f)));
  return t;
};

export function factsFor(tags: Tag[], limit = 8): KnowledgeFact[] {
  const scored = FACTS.map((f) => {
    const ft = factTags(f);
    const hits = tags.filter((t) => ft.has(t)).length;
    const conf = f.confidence === 'haute' ? 1 : f.confidence === 'moyenne' ? 0.5 : 0;
    return { f, s: hits * 2 + conf + (f.source?.read === 'texte intégral' ? 0.5 : 0) };
  })
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.f);
}

const marketTags = (markets: string[]): Tag[] => {
  const tags = new Set<Tag>(['buts', 'score']);
  for (const m of markets) {
    if (/corner/i.test(m)) { tags.add('corners'); }
    if (/carton|faute/i.test(m)) { tags.add('cartons'); tags.add('arbitrage'); tags.add('rouge'); }
    if (/1X2|buts|btts/i.test(m)) { tags.add('formation'); tags.add('transition'); tags.add('rouge'); }
  }
  return [...tags];
};

const fmtWindow = (w: TeamWindow | undefined, label: string): string => {
  if (!w) return '';
  const v = (x: number | null) => (x == null ? '?' : String(x));
  return `${label} (${w.n} m.) : buts ${v(w.gf)}-${v(w.ga)}, corners ${v(w.cornersFor)}-${v(w.cornersAgainst)}, fautes ${v(w.foulsFor)}-${v(w.foulsAgainst)}, jaunes ${v(w.yellowFor)}-${v(w.yellowAgainst)}, tirs cadrés ${v(w.sotFor)}-${v(w.sotAgainst)}`;
};

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : '');

function clubBlock(team: string): string {
  const p = clubProfileOf(team);
  const entry = clubCoachOf(team);
  if (!p && !entry) return `# ${team}\n(aucune fiche)`;
  const st = CLUB_STATS[p?.club ?? entry!.club];
  const lines = [
    `# ${p?.club ?? entry!.club} — entraîneur ${p?.coach ?? entry!.coach}${entry?.since ? ` (depuis le ${entry.since})` : ''} [fiabilité ${p?.confidence ?? 'inconnue'}]`,
    p?.formation_main ? `Formation : ${p.formation_main}` : '',
    clip(p?.style_fr, 600) && `Style : ${clip(p?.style_fr, 600)}`,
    clip(p?.pressing_fr, 400) && `Pressing : ${clip(p?.pressing_fr, 400)}`,
    clip(p?.transitions_fr, 350) && `Transitions : ${clip(p?.transitions_fr, 350)}`,
    clip(p?.set_pieces_fr, 450) && `Coups de pied arrêtés : ${clip(p?.set_pieces_fr, 450)}`,
    p?.weaknesses_fr?.length ? `Faiblesses : ${p.weaknesses_fr.slice(0, 3).map((x) => clip(x, 160)).join(' | ')}` : '',
    p?.betting_relevant_fr?.length ? `À retenir pour les marchés : ${p.betting_relevant_fr.slice(0, 3).map((x) => clip(x, 200)).join(' | ')}` : '',
    fmtWindow(st?.deuxSaisons, 'Moyennes pour-contre sur 2 saisons'),
    fmtWindow(st?.courant, 'Saison en cours'),
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Dossier remis à l'entraîneur d'une ligue avant une analyse (20e / 60e minute) : fiches des deux clubs, dossier de ligue, faits de
 * recherche utiles aux marchés concernés. Borné (~9 000 caractères) pour les modèles gratuits.
 */
export function coachBriefing(homeTeam: string, awayTeam: string, league: string | undefined | null, markets: string[] = []): { coach: CoachProfile | null; system: string; context: string } {
  const coach = coachForLeague(league ?? clubCoachOf(homeTeam)?.league ?? null);
  const dossier = leagueDossierOf(league ?? clubCoachOf(homeTeam)?.league ?? null);
  const facts = factsFor(marketTags(markets), 8);
  const league_ = dossier
    ? [
        `# Ligue — ${dossier.league}`,
        dossier.typical_game_script_fr ? `Scénario type : ${clip(dossier.typical_game_script_fr, 500)}` : '',
        dossier.trends_fr?.length ? `Tendances : ${dossier.trends_fr.slice(0, 4).map((x) => clip(x, 220)).join(' | ')}` : '',
        dossier.rules_changes_fr?.length ? `Règles : ${dossier.rules_changes_fr.slice(0, 3).map((x) => clip(x, 200)).join(' | ')}` : '',
        dossier.referee_notes_fr?.length ? `Arbitrage : ${dossier.referee_notes_fr.slice(0, 3).map((x) => clip(x, 200)).join(' | ')}` : '',
      ].filter(Boolean).join('\n')
    : '';
  const factText = facts.map((f) => `- [${f.id}] ${clip(f.fact_fr, 380)}${f.caveat_fr ? ` (limite : ${clip(f.caveat_fr, 120)})` : ''}`).join('\n');
  const context = [clubBlock(homeTeam), clubBlock(awayTeam), league_, factText ? `# Faits de recherche (thèses, articles, rapports officiels)\n${factText}` : ''].filter(Boolean).join('\n\n');
  return { coach, system: coach ? coachSystemPrompt(coach) : '', context };
}
