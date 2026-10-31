// Bilan de fin de match de l'entraîneur de la ligue (étape 2) : relit le match terminé (score, buts, totaux, joueurs) et ses
// propres analyses de la 20e / 60e, puis consigne ce qu'il en retient pour chaque équipe et chaque joueur. Ces notes alimentent le
// dossier des matchs suivants (coachBriefing) et la boucle d'apprentissage ; elles ne reposent que sur les données du résumé du
// match : l'IA n'a pas le droit d'inventer un fait absent des données.

import AsyncStorage from '../kvStore';
import { askOmnirouteUsable } from '../omniroute';
import { readMatchDigests, type MatchDigest } from '../matchDigest';
import { normalizeTeamName } from '../teamNameMatch';
import { coachForLeague, type CoachProfile } from './knowledge';
import { clubCoachOf } from './clubCoaches';
import { analysisKey, getAnalysis, loadConfig, takeBudget, type CoachAnalysis } from './coachAnalysis';
import { loadNotes, saveNotes } from './clubNotes';
import { readPreMatchBrief } from './preMatchMemory';

const REVIEWS_KEY = '@coach_reviews_v1';
const MAX_REVIEWS = 400;

export interface CoachReview {
  key: string;
  day: string;
  match: string;
  coach: CoachProfile['id'];
  at: string;
  model: string;
  summary_fr: string;
  home_lessons_fr: string[];
  away_lessons_fr: string[];
  player_notes: Array<{ player: string; team: 'home' | 'away'; note_fr: string }>;
  analysis_check: Array<{ checkpoint: 'avant' | '20' | '60'; verdict: 'juste' | 'fausse' | 'partielle' | 'sans_objet'; why_fr: string }>;
  general_lessons_fr: string[];
}

let reviewsMemo: Record<string, CoachReview> | null = null;

async function loadReviews(): Promise<Record<string, CoachReview>> {
  if (reviewsMemo) return reviewsMemo;
  try {
    reviewsMemo = JSON.parse((await AsyncStorage.getItem(REVIEWS_KEY)) ?? '{}');
  } catch {
    reviewsMemo = {};
  }
  return reviewsMemo!;
}

export async function getReviewStats(): Promise<{ reviews: number; clubsWithNotes: number; playerNotes: number }> {
  const [r, n] = await Promise.all([loadReviews(), loadNotes()]);
  return { reviews: Object.keys(r).length, clubsWithNotes: Object.keys(n.teams).length, playerNotes: Object.keys(n.players).length };
}

const text = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const strs = (x: unknown, n: number, max: number) => (Array.isArray(x) ? x.map((v) => text(v, max)).filter(Boolean).slice(0, n) : []);

export function parseReview(raw: string): Omit<CoachReview, 'key' | 'day' | 'match' | 'coach' | 'at' | 'model'> | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    const summary = text(j.summary_fr, 900);
    if (!summary) return null;
    const verdicts = ['juste', 'fausse', 'partielle', 'sans_objet'];
    return {
      summary_fr: summary,
      home_lessons_fr: strs(j.home_lessons_fr, 4, 260),
      away_lessons_fr: strs(j.away_lessons_fr, 4, 260),
      player_notes: (Array.isArray(j.player_notes) ? j.player_notes : [])
        .filter((p: any) => text(p?.player, 80) && (p?.team === 'home' || p?.team === 'away') && text(p?.note_fr, 240))
        .slice(0, 10)
        .map((p: any) => ({ player: text(p.player, 80), team: p.team, note_fr: text(p.note_fr, 240) })),
      analysis_check: (Array.isArray(j.analysis_check) ? j.analysis_check : [])
        .filter((a: any) => (a?.checkpoint === 'avant' || a?.checkpoint === '20' || a?.checkpoint === '60') && verdicts.includes(a?.verdict))
        .slice(0, 3)
        .map((a: any) => ({ checkpoint: a.checkpoint, verdict: a.verdict, why_fr: text(a.why_fr, 240) })),
      general_lessons_fr: strs(j.general_lessons_fr, 3, 260),
    };
  } catch {
    return null;
  }
}

const SYSTEM = (coach: CoachProfile) =>
  [
    `Tu es ${coach.name}, entraîneur de très haut niveau et analyste de la ligue « ${coach.league} ». ${coach.style}`,
    "Tu fais le BILAN d'un match terminé à partir UNIQUEMENT des données fournies (score, minutes des buts, totaux et détail par équipe, stats des joueurs si présentes, tes analyses de la 20e et de la 60e, et ton avis d'avant-match rédigé sur les compositions officielles). Tu n'inventes aucun fait, aucun nom de joueur, aucune cause absente des données : quand tu ne peux pas conclure, tu l'écris ou tu omets l'entrée.",
    "Pour chaque équipe, retiens des leçons durables et vérifiables dans ces données (rythme, tirs, corners, cartons, moment des buts, effet du score ou d'un carton). Juge ton analyse : « juste », « fausse », « partielle » ou « sans_objet », en citant ce que le match a montré. Juge aussi ton avis d'avant-match (checkpoint « avant ») : ce que tu avais bien lu des compositions et des forces en présence, et ce que tu avais mal lu, pour ne pas refaire la même erreur.",
    'Réponds en JSON strict, rien autour : {"summary_fr":"bilan du match en 2 à 4 phrases","home_lessons_fr":["…"],"away_lessons_fr":["…"],"player_notes":[{"player":"nom exact des données","team":"home|away","note_fr":"…"}],"analysis_check":[{"checkpoint":"avant|20|60","verdict":"juste|fausse|partielle|sans_objet","why_fr":"…"}],"general_lessons_fr":["leçon valable pour la ligue, seulement si le match la montre clairement"]}',
  ].join('\n\n');

function digestText(d: MatchDigest, home: string, away: string): string {
  const goals = d.goals.length ? d.goals.map((g) => `${g[0]}' ${g[1] === 'h' ? home : away}`).join(', ') : 'aucun but';
  const side = (n: number[] | undefined) => (n ? `tirs ${n[0]} (cadrés ${n[1]}), corners ${n[2]}, cartons ${n[3]}, fautes ${n[4]}` : 'détail non disponible');
  const players = d.players
    ? [...d.players.h.map((p) => ({ p, t: home })), ...d.players.a.map((p) => ({ p, t: away }))]
        .filter(({ p }) => p[3] > 0 || p[5] > 0 || p[6] > 0 || p[8] > 0 || p[9] > 0)
        .sort((x, y) => y.p[5] * 5 + y.p[4] * 2 + y.p[3] - (x.p[5] * 5 + x.p[4] * 2 + x.p[3]))
        .slice(0, 14)
        .map(({ p, t }) => `${p[0]} (${t}, ${p[1] || '?'}) : ${p[3]} tirs, ${p[4]} cadrés, ${p[5]} but(s), ${p[6]} passe(s) déc., ${p[8]} jaune(s), ${p[9]} rouge(s)`)
        .join('\n')
    : 'stats des joueurs non disponibles';
  const periods = d.periods.map((x, i) => `${i * 15}-${i * 15 + 15}' : corners ${x[0]}, cartons ${x[1]}, tirs ${x[2]}`).join(' | ');
  return `Match : ${home} (domicile) ${d.score[0]}-${d.score[1]} ${away}. Buts : ${goals}.\nTotaux : tirs ${d.totals.shots} (cadrés ${d.totals.sot}), corners ${d.totals.corners}, cartons ${d.totals.cards}, fautes ${d.totals.fouls}, rouges ${d.totals.reds}.\n${home} : ${side(d.sides?.h)}\n${away} : ${side(d.sides?.a)}\nPar tranche : ${periods}\nJoueurs :\n${players}`;
}

const analysisText = (a: CoachAnalysis | null, cp: string) =>
  a ? `Ton analyse de la ${cp}e (minute ${a.minute}) : ${a.read_fr} Avis : ${a.opinions.map((o) => `${o.market} ${o.direction} ${o.stance}`).join(', ')}.` : `Pas d'analyse de la ${cp}e.`;

/** Fait le bilan des matchs terminés récents des cinq ligues (3 au plus par passage). Renvoie le nombre de bilans faits. */
export async function runCoachReviews(maxPerPass = 3): Promise<number> {
  const config = await loadConfig();
  if (!config) return 0;
  const [digests, reviews, notes] = await Promise.all([readMatchDigests(), loadReviews(), loadNotes()]);
  const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  let done = 0;
  for (const [dk, d] of Object.entries(digests).sort((a, b) => b[1].day.localeCompare(a[1].day))) {
    if (done >= maxPerPass) break;
    if (d.day < cutoff) continue;
    const i = d.match.indexOf(' - ');
    if (i < 0) continue;
    const homeName = d.match.slice(0, i);
    const awayName = d.match.slice(i + 3);
    const hc = clubCoachOf(homeName);
    const ac = clubCoachOf(awayName);
    if (!hc || !ac || hc.league !== ac.league) continue;
    const coach = coachForLeague(hc.league);
    if (!coach) continue;
    const key = `${d.day}|${normalizeTeamName(hc.club)}|${normalizeTeamName(ac.club)}`;
    if (reviews[key]) continue;
    if (!(await takeBudget())) break;
    const [a20, a60] = await Promise.all([getAnalysis(analysisKey(homeName, awayName, d.day, '20')), getAnalysis(analysisKey(homeName, awayName, d.day, '60'))]);
    const before = await readPreMatchBrief(homeName, awayName, d.day).catch(() => null);
    const user = `${digestText(d, hc.club, ac.club)}\n\n${before ? `TON AVIS D'AVANT-MATCH\n${before}\n\n` : ''}${analysisText(a20, '20')}\n${analysisText(a60, '60')}`;
    const res = await askOmnirouteUsable(SYSTEM(coach), user, config, (raw) => parseReview(raw));
    if (!res) continue;
    const review: CoachReview = { key, day: d.day, match: `${hc.club} - ${ac.club}`, coach: coach.id, at: new Date().toISOString(), model: res.model, ...res.value };
    reviews[key] = review;
    (notes.teams[hc.club] ??= []).push({ day: d.day, vs: ac.club, lessons: review.home_lessons_fr });
    (notes.teams[ac.club] ??= []).push({ day: d.day, vs: hc.club, lessons: review.away_lessons_fr });
    for (const c of [hc.club, ac.club]) if (notes.teams[c].length > 8) notes.teams[c] = notes.teams[c].slice(-8);
    for (const p of review.player_notes) {
      const club = p.team === 'home' ? hc.club : ac.club;
      const arr = (notes.players[`${club}|${p.player}`] ??= []);
      arr.push({ day: d.day, note: p.note_fr });
      if (arr.length > 5) notes.players[`${club}|${p.player}`] = arr.slice(-5);
    }
    for (const g of review.general_lessons_fr) notes.general.push({ day: d.day, league: hc.league, lesson: g });
    if (notes.general.length > 60) notes.general = notes.general.slice(-60);
    done++;
    void dk;
  }
  if (done) {
    const entries = Object.entries(reviews);
    if (entries.length > MAX_REVIEWS) {
      entries.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
      reviewsMemo = Object.fromEntries(entries.slice(0, MAX_REVIEWS));
    }
    await AsyncStorage.setItem(REVIEWS_KEY, JSON.stringify(reviewsMemo ?? reviews)).catch(() => {});
    await saveNotes();
  }
  return done;
}
