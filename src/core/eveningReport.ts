// Les 4 messages Telegram du soir (23h30), envoyés SÉPARÉMENT :
//   1. bilan des paris réels et fictifs du jour
//   2. rapport du calibrage des cotes
//   3. leçons apprises aujourd'hui
//   4. confirmation de la mise à jour du fichier de stats des équipes

import { getAllBets, getAllLessons } from '../database/storage';
import { fetchRepoJson } from './gitAutoSync';
import { InPlayProposal, readInPlayProposals, readMarketSeries, marketLabel } from './learnStore';
import { buildFictionalMarketStats, formatFictionalDigestMessage } from './dailyDigest';
import { readOddsLoopFile } from './oddsLoop';
import { getDeltaReport, getSituationReport } from './deltaLearning';
import { getPatternLessons, getTodaysMatchLessons } from './matchDigest';
import { describePattern, getPatterns, readExplanations } from './patternEngine';

export type EveningPart = 'bilan' | 'cotes' | 'lecons' | 'stats';
export const EVENING_PARTS: EveningPart[] = ['bilan', 'cotes', 'lecons', 'stats'];

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function legSummary(proposals: InPlayProposal[]): { legs: number; settled: number; won: number } {
  const legs = proposals.flatMap((p) => p.legs);
  const settled = legs.filter((l) => l.settled);
  return { legs: legs.length, settled: settled.length, won: settled.filter((l) => l.won).length };
}

const pc = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : '—');

async function bilanMessage(day: string, todays: InPlayProposal[]): Promise<string> {
  const real = todays.filter((p) => p.real !== false);
  const fictional = todays.filter((p) => p.real === false);
  const r = legSummary(real);
  const f = legSummary(fictional);
  const lines = [`📊 Bilan du ${day} — paris réels et fictifs`, ''];

  lines.push(`🎯 RÉELS : ${real.length} proposition(s), ${r.settled}/${r.legs} jambes réglées, ${r.won} gagnée(s) (${pc(r.won, r.settled)})`);
  for (const p of real.slice(0, 12)) {
    const status = p.legs.some((l) => l.settled && !l.won) ? '❌' : p.legs.every((l) => l.settled && l.won) ? '✅' : '⏳';
    lines.push(`${status} ${p.legs.map((l) => `${l.homeTeam}-${l.awayTeam} : ${l.selection}`).join(' + ')}${p.legs[0]?.estOdds ? ` (cote ≈ ${p.legs.reduce((a, l) => a * (l.estOdds ?? 1), 1).toFixed(2)})` : ''}`);
  }
  if (real.length > 12) lines.push(`… et ${real.length - 12} autre(s)`);
  try {
    const bets = (await getAllBets()).filter((b) => b.played && localDay(new Date(b.createdAt)) === day);
    if (bets.length > 0) {
      const settled = bets.filter((b) => b.status === 'won' || b.status === 'lost');
      const pnl = settled.reduce((acc, b) => acc + (b.net_pnl ?? 0), 0);
      lines.push(`💰 Paris posés par vous : ${bets.length} (${settled.filter((b) => b.status === 'won').length} gagné(s), ${settled.filter((b) => b.status === 'lost').length} perdu(s)), net ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}`);
    }
  } catch {
    // base indisponible : on s'en passe
  }

  lines.push('', `🧪 FICTIFS : ${fictional.length} paris, ${f.settled} jambes réglées, ${f.won} gagnée(s) (${pc(f.won, f.settled)})`);
  const detail = formatFictionalDigestMessage(day, buildFictionalMarketStats(todays), readMarketSeries().filter((p) => p.date < day));
  if (detail) lines.push('', detail.split('\n').slice(1).join('\n'));
  return lines.join('\n');
}

async function cotesMessage(day: string): Promise<string> {
  const f = await readOddsLoopFile(true);
  const lines = [`📐 Calibrage des cotes — ${day}`, ''];
  if (!f || f.score == null) {
    lines.push(`Pas encore assez de cotes de votre bookmaker comparées (${f?.observations ?? 0} saisies, ${f?.scored ?? 0} comparées). Donnez la cote de chaque pari pour que l'app apprenne.`);
    return lines.join('\n');
  }
  lines.push(`Score d'alignement : ${f.score}/100 (tendance : ${f.trend}${f.recentScore != null ? `, 15 dernières saisies : ${f.recentScore}/100` : ''})`);
  lines.push(`Écart moyen : ${f.meanAbsDeltaPct ?? '—'} % (biais ${f.biasPct != null ? `${f.biasPct > 0 ? '+' : ''}${f.biasPct} %` : '—'} : ${f.biasPct != null && f.biasPct > 0 ? "les cotes de l'app sont trop hautes" : f.biasPct != null && f.biasPct < 0 ? "les cotes de l'app sont trop basses" : 'équilibré'})`);
  lines.push(`Saisies : ${f.observations} au total, ${f.scored} comparées à l'estimation de l'app.`);
  const b = f.vsBet365 as any;
  if (b && (b.n ?? b.samples)) lines.push(`Face à bet365 (1X2 / total de buts, lues automatiquement) : ${JSON.stringify(b).slice(0, 200)}`);
  const worst = [...(f.bySegment ?? [])].sort((x: any, y: any) => Math.abs(y.meanAbsDeltaPct ?? y.meanAbsPct ?? 0) - Math.abs(x.meanAbsDeltaPct ?? x.meanAbsPct ?? 0)).slice(0, 3);
  if (worst.length) lines.push('', 'Marchés les moins alignés :', ...worst.map((w: any) => `• ${w.label ?? w.key}: ${w.meanAbsDeltaPct ?? w.meanAbsPct ?? '?'} % d'écart (${w.n} saisies)`));
  if (f.reasons?.length) lines.push('', 'Pourquoi cela diverge encore :', ...f.reasons.slice(0, 4).map((r) => `- ${r}`));
  return lines.join('\n');
}

async function leconsMessage(day: string): Promise<string> {
  const lines = [`🧠 Leçons apprises — ${day}`, ''];
  try {
    const today = (await getAllLessons()).filter((l) => l.derniere_maj === day);
    if (today.length) lines.push('Pièges identifiés aujourd\'hui :', ...today.slice(0, 6).map((l) => `• ${l.motif} (${l.occurrences}×) — ${l.detail.slice(0, 160)}`), '');
  } catch {
    // base indisponible
  }
  const deltas = getDeltaReport().filter((r) => r.verified >= 5).sort((a, b) => b.meanAbsError - a.meanAbsError).slice(0, 4);
  if (deltas.length) {
    lines.push('Écarts exacts prédit / réel (ce que l\'app corrige) :');
    for (const r of deltas) lines.push(`• ${r.label} : prédit ${r.meanPredicted.toFixed(1)} vs réel ${r.meanActual.toFixed(1)} (erreur moyenne ${r.meanError >= 0 ? '+' : ''}${r.meanError.toFixed(2)}, ${r.verified} mesures, ${r.bigMisses} gros écarts)`);
    lines.push('');
  }
  const sit = getSituationReport().filter((r) => r.samples >= 20);
  if (sit.length) {
    lines.push('Effets de la situation du match appris :');
    for (const r of sit.slice(0, 4)) lines.push(`• ${r.label} (${r.samples} matchs${r.promoted ? ', activé' : ', pas encore activé'}) : ${r.effects.slice(0, 3).map((e) => `${e.name} ${e.pct >= 0 ? '+' : ''}${e.pct} %`).join(', ') || 'aucun effet net'}`);
    lines.push('');
  }
  try {
    const matches = await getTodaysMatchLessons(day);
    if (matches.length) lines.push('Matchs suivis minute par minute aujourd\'hui :', ...matches.slice(0, 10).map((m) => `• ${m}`), '');
    const patterns = await getPatternLessons();
    if (patterns.length) lines.push('Motifs appris (cumul, versés dans la boucle) :', ...patterns.map((m) => `• ${m}`), '');
  } catch {
    // lecture impossible : on s'en passe
  }
  try {
    const ps = (await getPatterns(50)).filter((p) => p.validated).slice(0, 6);
    if (ps.length) lines.push('Motifs validés (corrigent les pronos) :', ...ps.map((p) => `• ${describePattern(p)}`), '');
    const ex = (await readExplanations()).filter((e) => e.day === day && !e.won).slice(-5);
    if (ex.length) lines.push('Pourquoi des paris ont raté aujourd\'hui :', ...ex.map((e) => `• ${e.match} — ${e.selection} : ${e.text}`), '');
  } catch {
    // best-effort
  }
  const series = readMarketSeries().filter((p) => p.date === day);
  if (series.length) lines.push('Fiabilité du jour par marché :', ...series.filter((p) => p.predictions >= 5).sort((a, b) => b.predictions - a.predictions).slice(0, 7).map((p) => `• ${marketLabel(p.market)} : ${p.correct}/${p.predictions} (${Math.round(p.hitRate * 100)} % réel pour ${Math.round(p.meanPredicted * 100)} % annoncé)`));
  if (lines.length <= 2) lines.push("Pas assez de résultats réglés aujourd'hui pour dégager une leçon.");
  return lines.join('\n');
}

async function statsMessage(day: string): Promise<string> {
  const index = await fetchRepoJson<{ updatedAt?: string; teams?: Array<{ name: string; matches: number; lastMatch?: string }> }>('data/team-stats/index.json');
  if (!index?.updatedAt || !index.teams) return `📁 Fichier des stats d'équipes — ${day}\n\n⚠️ Impossible de lire le fichier sur GitHub depuis l'app ce soir : mise à jour non confirmée.`;
  const updated = new Date(index.updatedAt);
  const playedToday = index.teams.filter((t) => t.lastMatch && localDay(new Date(t.lastMatch)) === day);
  const lastKick = playedToday.reduce((m, t) => Math.max(m, Date.parse(t.lastMatch!)), 0);
  const upToDate = playedToday.length > 0 && updated.getTime() > lastKick + 2 * 3_600_000;
  const ageH = Math.round((Date.now() - updated.getTime()) / 3_600_000);
  const lines = [`📁 Fichier des stats d'équipes — ${day}`, ''];
  lines.push(`Dernière mise à jour : ${index.updatedAt.replace('T', ' ').slice(0, 16)} UTC (il y a ${ageH} h)`);
  lines.push(`${index.teams.length} équipes, ${index.teams.reduce((a, t) => a + t.matches, 0)} matchs-équipes enregistrés.`);
  lines.push(`Équipes dont le dernier match enregistré date d'aujourd'hui : ${playedToday.length}.`);
  lines.push(upToDate ? '✅ Les matchs d\'aujourd\'hui sont dans le fichier.' : '⏳ Les matchs de ce soir seront ajoutés à la mise à jour de 03 h (heure d\'Algérie) : confirmation demain.');
  return lines.join('\n');
}

/** Texte d'un des 4 messages. */
export async function buildEveningMessage(part: EveningPart, day: string): Promise<string> {
  const todays = readInPlayProposals().filter((p) => localDay(new Date(p.createdAt)) === day);
  if (part === 'bilan') return bilanMessage(day, todays);
  if (part === 'cotes') return cotesMessage(day);
  if (part === 'lecons') return leconsMessage(day);
  return statsMessage(day);
}
