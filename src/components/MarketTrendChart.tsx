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

const CHART_HEIGHT = 96;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 16;
const PADDING_LEFT = 6;
const PADDING_RIGHT = 34; // place pour l'étiquette du dernier point

const REAL_COLOR = '#60a5fa';
const FICTIONAL_COLOR = '#a78bfa';
const GRID_COLOR = '#334155';
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

function renderSeries(
  points: MarketDayPoint[],
  allDates: string[],
  color: string,
  toX: (dateIndex: number) => number,
  toY: (rate: number) => number,
  width: number
) {
  if (points.length === 0) return null;

  const byDate = new Map(points.map((p) => [p.date, p]));
  const presentDates = allDates.filter((d) => byDate.has(d));

  const path = presentDates
    .map((date, i) => {
      const point = byDate.get(date)!;
      const x = toX(allDates.indexOf(date));
      return `${i === 0 ? 'M' : 'L'} ${x} ${toY(point.hitRate)}`;
    })
    .join(' ');

  const last = byDate.get(presentDates[presentDates.length - 1])!;
  const lastX = toX(allDates.indexOf(last.date));
  const lastY = toY(last.hitRate);

  return (
    <React.Fragment>
      <Path d={path} stroke={color} strokeWidth={2} fill="none" />
      {presentDates.map((date) => {
        const point = byDate.get(date)!;
        return (
          <Circle
            key={date}
            cx={toX(allDates.indexOf(date))}
            cy={toY(point.hitRate)}
            r={2.5}
            fill={color}
          />
        );
      })}
      <Circle cx={lastX} cy={lastY} r={4} fill={color} />
      <SvgText x={Math.min(lastX + 7, width - 2)} y={lastY + 4} fill={color} fontSize={11} fontWeight="bold">
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

  const allDates = Array.from(new Set([...points.map((p) => p.date), ...fictionalPoints.map((p) => p.date)])).sort();

  const plotWidth = Math.max(1, width - PADDING_LEFT - PADDING_RIGHT);
  const plotHeight = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  // Échelle Y fixe de 0 à 100% : comparer deux marchés n'a de sens que sur la
  // même échelle (une échelle auto-ajustée exagérerait des écarts minuscules).
  const toY = (rate: number) => PADDING_TOP + (1 - rate) * plotHeight;
  const toX = (index: number) =>
    PADDING_LEFT + (allDates.length === 1 ? plotWidth / 2 : (index / (allDates.length - 1)) * plotWidth);

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
        {/* Repères horizontaux discrets : 0%, 50%, 100% */}
        {[0, 0.5, 1].map((rate) => (
          <Line
            key={rate}
            x1={PADDING_LEFT}
            y1={toY(rate)}
            x2={PADDING_LEFT + plotWidth}
            y2={toY(rate)}
            stroke={GRID_COLOR}
            strokeWidth={1}
          />
        ))}

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
        <SvgText
          x={PADDING_LEFT + plotWidth + 4}
          y={toY(threshold) + 3}
          fill={THRESHOLD_COLOR}
          fontSize={9}
        >
          {`${Math.round(threshold * 100)}%`}
        </SvgText>

        {renderSeries(fictionalPoints, allDates, FICTIONAL_COLOR, toX, toY, width)}
        {renderSeries(points, allDates, REAL_COLOR, toX, toY, width)}
      </Svg>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          {allDates[0].slice(5)} → {allDates[allDates.length - 1].slice(5)}
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
