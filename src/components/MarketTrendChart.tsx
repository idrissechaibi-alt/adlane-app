// Courbe d'évolution du taux de réussite d'un marché, jour par jour.
//
// Une seule série par graphique (pas de légende nécessaire : le titre nomme la
// série), trait fin de 2px, points discrets, et une ligne de référence en
// pointillés au seuil d'acceptation. Seul le dernier point est étiqueté —
// un nombre sur chaque point rendrait la courbe illisible.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { MarketDayPoint } from '../core/learnStore';

const CHART_HEIGHT = 96;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 16;
const PADDING_LEFT = 6;
const PADDING_RIGHT = 34; // place pour l'étiquette du dernier point

const SERIES_COLOR = '#60a5fa';
const GRID_COLOR = '#334155';
const THRESHOLD_COLOR = '#64748b';

interface Props {
  label: string;
  points: MarketDayPoint[];
  /** Seuil d'acceptation affiché en pointillés (0 à 1). */
  threshold?: number;
  width: number;
}

export default function MarketTrendChart({ label, points, threshold = 0.6, width }: Props) {
  const totalPredictions = points.reduce((sum, p) => sum + p.predictions, 0);

  if (points.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.empty}>Aucune prédiction réglée pour l'instant.</Text>
      </View>
    );
  }

  const plotWidth = Math.max(1, width - PADDING_LEFT - PADDING_RIGHT);
  const plotHeight = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  // Échelle Y fixe de 0 à 100% : comparer deux marchés n'a de sens que sur la
  // même échelle (une échelle auto-ajustée exagérerait des écarts minuscules).
  const toY = (rate: number) => PADDING_TOP + (1 - rate) * plotHeight;
  const toX = (index: number) =>
    PADDING_LEFT + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);

  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${toX(index)} ${toY(point.hitRate)}`)
    .join(' ');

  const last = points[points.length - 1];
  const lastX = toX(points.length - 1);
  const lastY = toY(last.hitRate);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.subtitle}>
          {totalPredictions} prédiction{totalPredictions > 1 ? 's' : ''} réglée{totalPredictions > 1 ? 's' : ''}
        </Text>
      </View>

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

        <Path d={path} stroke={SERIES_COLOR} strokeWidth={2} fill="none" />

        {points.map((point, index) => (
          <Circle
            key={point.date}
            cx={toX(index)}
            cy={toY(point.hitRate)}
            r={2.5}
            fill={SERIES_COLOR}
          />
        ))}

        {/* Étiquette du dernier point uniquement */}
        <Circle cx={lastX} cy={lastY} r={4} fill={SERIES_COLOR} />
        <SvgText
          x={Math.min(lastX + 7, width - 2)}
          y={lastY + 4}
          fill="#e2e8f0"
          fontSize={11}
          fontWeight="bold"
        >
          {`${Math.round(last.hitRate * 100)}%`}
        </SvgText>
      </Svg>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          {points[0].date.slice(5)} → {last.date.slice(5)}
        </Text>
        <Text style={styles.footerText}>
          Annoncé {Math.round(last.meanPredicted * 100)}% · réalisé {Math.round(last.hitRate * 100)}%
          {' '}({last.correct}/{last.predictions})
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
