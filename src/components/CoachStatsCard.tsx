// Statistiques des cinq entraîneurs IA : verdicts en mode ombre, avis de l'IA, analyses du jour, bilans de fin de match.
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { getCoachStatus, COACH_MIN_SETTLED, type CoachRecord } from '../core/coaches/coachDesk';
import { getReviewStats } from '../core/coaches/coachReview';
import { listAnalyses, DAILY_AI_BUDGET } from '../core/coaches/coachAnalysis';

interface Info {
  coaches: CoachRecord[];
  analyses: number;
  todayAnalyses: number;
  reviews: number;
  notedClubs: number;
}

const pct = (b: { n: number; won: number }) => (b.n ? `${Math.round((b.won / b.n) * 100)} % (${b.won}/${b.n})` : '—');
const edge = (x: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x} pts`);

export default function CoachStatsCard() {
  const focused = useIsFocused();
  const [info, setInfo] = useState<Info | null>(null);

  useEffect(() => {
    if (!focused) return;
    let alive = true;
    const load = async () => {
      try {
        const [status, analyses, reviews] = await Promise.all([getCoachStatus(), listAnalyses(), getReviewStats()]);
        const today = new Date().toISOString().slice(0, 10);
        if (alive) setInfo({ coaches: status.coaches, analyses: analyses.length, todayAnalyses: analyses.filter((a) => a.day === today).length, reviews: reviews.reviews, notedClubs: reviews.clubsWithNotes });
      } catch (error) {
        console.warn('Suivi des entraîneurs indisponible:', error);
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [focused]);

  if (!info) return null;
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Entraîneurs IA</Text>
      <Text style={styles.text}>
        Mode ombre : leurs avis sont notés sur chaque pari réel, sans rien bloquer. Analyses IA : {info.analyses} ({info.todayAnalyses} aujourd'hui, {DAILY_AI_BUDGET} au plus par jour) · bilans de fin de match : {info.reviews} · clubs avec notes : {info.notedClubs}.
      </Text>
      {info.coaches.map((c) => (
        <View key={c.coach} style={styles.row}>
          <Text style={styles.name}>
            {c.coach} · {c.league}
          </Text>
          <Text style={styles.text}>
            {c.verdicts} verdict{c.verdicts > 1 ? 's' : ''} · {c.settledLegs}/{COACH_MIN_SETTLED} jambes réglées{'\n'}
            Soutenus : {pct(c.supported)} · Contestés : {pct(c.contested)} · Écart : {edge(c.edge)}
            {c.ai.legs > 0 ? `\nAvis de l'IA (${c.ai.legs} jambes) : soutenus ${pct(c.ai.supported)} · contestés ${pct(c.ai.contested)} · écart ${edge(c.ai.edge)}` : ''}
            {c.ready ? '\nPreuve suffisante : pouvoir activable.' : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: '#0f172a', borderRadius: 10, borderWidth: 1, borderColor: '#334155', padding: 12, marginBottom: 12, gap: 6 },
  title: { color: '#e2e8f0', fontSize: 14, fontWeight: '700' },
  name: { color: '#e2e8f0', fontSize: 12, fontWeight: '600' },
  row: { borderTopWidth: 1, borderTopColor: '#1e293b', paddingTop: 6, gap: 2 },
  text: { color: '#94a3b8', fontSize: 12, lineHeight: 17 },
});
