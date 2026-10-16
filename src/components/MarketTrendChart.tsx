// Courbe d'évolution du taux de réussite d'un marché, jour par jour.
//
// DEUX séries possibles sur le même graphique — réel et fictif — pour
// comparer visuellement la progression du pipeline réel face à la boucle
// d'auto-apprentissage (paris fictifs), qui accumule beaucoup plus
// d'échantillons et progresse donc plus vite à lire. Axe X construit sur
// l'UNION des dates des deux séries (jamais interpolé : un jour sans point
// pour une série reste un vrai trou, pas une valeur devinée), trait fin de
// 2px, points discrets, et une ligne de référence en pointillés au seuil
// d'acceptation. Seul le dernier point de chaque série est étiqueté.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { MarketDayPoint } from '../core/learnStore';

const CHART_HEIGHT = 170;
const PADDING_TOP = 12;
const PADDING_BOTTOM = 34; // graduations de dates + titre de l'axe
const PADDING_LEFT = 34; // graduations en %
const PADDING_RIGHT = 36; // étiquette du dernier point
const DAY_MS = 86_400_000;
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const REAL_COLOR = '#60a5fa';
const FICTIONAL_COLOR = '#a78bfa';
const GRID_COLOR = '#334155';
const AXIS_TEXT = '#94a3b8';
const THRESHOLD_COLOR = '#64748b';

interface Props {
  label: string;
  /** Série réelle (5 grands championnats + trêve internationale). */
  points: MarketDayPoint[];
  /** Série fictive (boucle d'auto-apprentissage) — omise si non fournie, le
   * graphique redevient une courbe unique comme avant. */
  fictionalPoints?: MarketDayPoint[];
  /** Seuil d'acceptation affiché en pointillés (0 à 1). */
  threshold?: number;
  width: number;
}

const dayNum = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const fromDayNum = (n: number) => new Date(n * DAY_MS);
const ddmm = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Graduations de l'axe des dates, adaptées à la durée couverte : chaque jour au début, puis chaque semaine (lundis),
 * puis chaque mois quand l'historique s'allonge. Les étiquettes trop serrées sont espacées automatiquement.
 */
function dateTicks(first: number, last: number, plotWidth: number): Array<{ day: number; label: string }> {
  const span = Math.max(1, last - first);
  const maxLabels = Math.max(2, Math.floor(plotWidth / 38));
  let ticks: Array<{ day: number; label: string }> = [];
  if (span <= 21) {
    const step = Math.max(1, Math.ceil((span + 1) / maxLabels));
    for (let d = first; d <= last; d += step) ticks.push({ day: d, label: ddmm(fromDayNum(d)) });
  } else if (span <= 120) {
    // Lundis (le 1er janvier 1970 était un jeudi : jour n → (n + 3) % 7 = 0 pour un lundi).
    let d = first + ((7 - ((first + 3) % 7)) % 7);
    const weekStep = Math.max(1, Math.ceil(span / 7 / maxLabels));
    for (; d <= last; d += 7 * weekStep) ticks.push({ day: d, label: ddmm(fromDayNum(d)) });
  } else {
    const start = fromDayNum(first);
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth() + 1;
    const all: Array<{ day: number; label: string }> = [];
    for (;;) {
      if (m > 11) { m = 0; y++; }
      const d = Math.round(Date.UTC(y, m, 1) / DAY_MS);
      if (d > last) break;
      all.push({ day: d, label: m === 0 ? `${MONTHS[m]} ${String(y).slice(2)}` : MONTHS[m] });
      m++;
    }
    const step = Math.max(1, Math.ceil(all.length / maxLabels));
    ticks = all.filter((_, i) => i % step === 0);
  }
  return ticks;
}

function renderSeries(
  points: MarketDayPoint[],
  color: string,
  toX: (day: number) => number,
  toY: (rate: number) => number,
  width: number,
  labelDy: number
) {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  // Un jour sans point reste un trou : la ligne est coupée au-delà d'un jour manquant.
  let path = '';
  let prev: number | null = null;
  for (const p of sorted) {
    const d = dayNum(p.date);
    path += `${prev == null || d - prev > 1 ? 'M' : 'L'} ${toX(d)} ${toY(p.hitRate)} `;
    prev = d;
  }
  const last = sorted[sorted.length - 1];
  const lastX = toX(dayNum(last.date));
  const lastY = toY(last.hitRate);
  const dot = sorted.length > 60 ? 1.5 : 2.5;

  return (
    <React.Fragment>
      <Path d={path} stroke={color} strokeWidth={2} fill="none" />
      {sorted.map((p) => (
        <Circle key={p.date} cx={toX(dayNum(p.date))} cy={toY(p.hitRate)} r={dot} fill={color} />
      ))}
      <Circle cx={lastX} cy={lastY} r={4} fill={color} />
      <SvgText x={Math.min(lastX + 7, width - 30)} y={lastY + 4 + labelDy} fill={color} fontSize={11} fontWeight="bold">
        {`${Math.round(last.hitRate * 100)}%`}
      </SvgText>
    </React.Fragment>
  );
}

export default function MarketTrendChart({ label, points, fictionalPoints = [], threshold = 0.6, width }: Props) {
  const totalPredictions = points.reduce((sum, p) => sum + p.predictions, 0);
  const totalFictionalPredictions = fictionalPoints.reduce((sum, p) => sum + p.predictions, 0);
  const totalFictionalCorrect = fictionalPoints.reduce((sum, p) => sum + p.correct, 0);
  const fictionalHitRatePercent =
    totalFictionalPredictions > 0 ? Math.round((totalFictionalCorrect / totalFictionalPredictions) * 100) : null;

  if (points.length === 0 && fictionalPoints.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.empty}>Aucune prédiction réglée pour l'instant.</Text>
      </View>
    );
  }

  const allDays = [...points, ...fictionalPoints].map((p) => dayNum(p.date));
  const first = Math.min(...allDays);
  const last = Math.max(...allDays);

  const plotWidth = Math.max(1, width - PADDING_LEFT - PADDING_RIGHT);
  const plotHeight = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  // Échelle Y fixe de 0 à 100% : comparer deux marchés n'a de sens que sur la
  // même échelle (une échelle auto-ajustée exagérerait des écarts minuscules).
  const toY = (rate: number) => PADDING_TOP + (1 - rate) * plotHeight;
  // Axe X proportionnel au temps : l'écart entre deux points correspond aux jours réellement écoulés.
  const toX = (day: number) => PADDING_LEFT + (last === first ? plotWidth / 2 : ((day - first) / (last - first)) * plotWidth);
  const ticks = dateTicks(first, last, plotWidth);

  // Les deux étiquettes de fin ne doivent pas se chevaucher.
  const lastOf = (pts: MarketDayPoint[]) => (pts.length ? [...pts].sort((a, b) => a.date.localeCompare(b.date))[pts.length - 1] : null);
  const lr = lastOf(points);
  const lf = lastOf(fictionalPoints);
  const clash = lr && lf && Math.abs(toY(lr.hitRate) - toY(lf.hitRate)) < 12;
  const realBelow = clash && lr!.hitRate <= lf!.hitRate;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{label}</Text>
        <View style={styles.legendRow}>
          {points.length > 0 && (
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: REAL_COLOR }]} />
              <Text style={styles.subtitle}>
                Réel ({totalPredictions})
              </Text>
            </View>
          )}
          {fictionalPoints.length > 0 && (
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: FICTIONAL_COLOR }]} />
              <Text style={styles.subtitle}>
                Fictif ({totalFictionalPredictions})
              </Text>
            </View>
          )}
        </View>
      </View>

      {fictionalHitRatePercent != null && (
        <Text style={styles.fictionalStats}>
          Fictif : <Text style={styles.fictionalStatsNumber}>{totalFictionalPredictions}</Text> traité
          {totalFictionalPredictions > 1 ? 's' : ''} ·{' '}
          <Text style={styles.fictionalStatsNumber}>{totalFictionalCorrect}</Text> réussi
          {totalFictionalCorrect > 1 ? 's' : ''} ·{' '}
          <Text style={styles.fictionalStatsNumber}>{fictionalHitRatePercent}%</Text>
        </Text>
      )}

      <Svg width={width} height={CHART_HEIGHT}>
        {/* Axe Y : % de paris réussis ce jour-là */}
        {[0, 0.25, 0.5, 0.75, 1].map((rate) => (
          <React.Fragment key={rate}>
            <Line x1={PADDING_LEFT} y1={toY(rate)} x2={PADDING_LEFT + plotWidth} y2={toY(rate)} stroke={GRID_COLOR} strokeWidth={1} />
            <SvgText x={PADDING_LEFT - 5} y={toY(rate) + 3} fill={AXIS_TEXT} fontSize={9} textAnchor="end">
              {`${Math.round(rate * 100)}%`}
            </SvgText>
          </React.Fragment>
        ))}

        {/* Axe X : dates, graduées par jour, semaine ou mois selon la durée */}
        {ticks.map((t) => (
          <React.Fragment key={t.day}>
            <Line x1={toX(t.day)} y1={PADDING_TOP} x2={toX(t.day)} y2={PADDING_TOP + plotHeight + 4} stroke={GRID_COLOR} strokeWidth={1} strokeDasharray="2 3" />
            <SvgText x={toX(t.day)} y={PADDING_TOP + plotHeight + 15} fill={AXIS_TEXT} fontSize={9} textAnchor="middle">
              {t.label}
            </SvgText>
          </React.Fragment>
        ))}
        <SvgText x={PADDING_LEFT + plotWidth / 2} y={CHART_HEIGHT - 3} fill={THRESHOLD_COLOR} fontSize={9} textAnchor="middle">
          {last - first > 120 ? 'mois' : last - first > 21 ? 'semaines (lundis)' : 'jours'}
        </SvgText>

        {/* Seuil d'acceptation */}
        <Line
          x1={PADDING_LEFT}
          y1={toY(threshold)}
          x2={PADDING_LEFT + plotWidth}
          y2={toY(threshold)}
          stroke={THRESHOLD_COLOR}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <SvgText x={PADDING_LEFT + plotWidth + 4} y={toY(threshold) + 3} fill={THRESHOLD_COLOR} fontSize={9}>
          {`${Math.round(threshold * 100)}%`}
        </SvgText>

        {renderSeries(fictionalPoints, FICTIONAL_COLOR, toX, toY, width, clash ? (realBelow ? -6 : 6) : 0)}
        {renderSeries(points, REAL_COLOR, toX, toY, width, clash ? (realBelow ? 6 : -6) : 0)}
      </Svg>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          % de paris réussis chaque jour · du {ddmm(fromDayNum(first))} au {ddmm(fromDayNum(last))} ({last - first + 1} jours)
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 12,
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 6,
  },
  title: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: 'bold',
  },
  subtitle: {
    color: '#64748b',
    fontSize: 11,
  },
  legendRow: {
    flexDirection: 'row',
    gap: 10,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  fictionalStats: {
    color: '#c4b5fd',
    fontSize: 12,
    marginBottom: 8,
  },
  fictionalStatsNumber: {
    fontWeight: 'bold',
    color: FICTIONAL_COLOR,
  },
  empty: {
    color: '#64748b',
    fontSize: 12,
    paddingVertical: 12,
  },
  footer: {
    marginTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 6,
  },
  footerText: {
    color: '#94a3b8',
    fontSize: 11,
  },
});
