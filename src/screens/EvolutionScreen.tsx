// Écran Rapports & Évolution IA
// Affiche la calibration des marchés, les leçons apprises, et génère les rapports quotidiens

import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  SafeAreaView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HISTORICAL_BETS, HISTORICAL_LESSONS, INITIAL_CALIBRATIONS } from '../data/historical';
import { computeMarketCalibrations } from '../core/calibration';
import { generateDailyReport, generateImprovementReport } from '../core/reporter';
import { MarketCalibration, Lesson } from '../types';

export default function EvolutionScreen() {
  const [calibrations, setCalibrations] = useState<MarketCalibration[]>(INITIAL_CALIBRATIONS);
  const [lessons, setLessons] = useState<Lesson[]>(HISTORICAL_LESSONS);
  const [selectedTab, setSelectedTab] = useState<'calibration' | 'lessons' | 'report'>('calibration');

  const dailyReport = generateDailyReport('2026-09-13', HISTORICAL_BETS);
  const improvementReport = generateImprovementReport(calibrations, lessons);

  useEffect(() => {
    // Recalculer la calibration à partir des paris réglés
    const freshCalibrations = computeMarketCalibrations(HISTORICAL_BETS);
    setCalibrations(freshCalibrations);
  }, []);

  const renderCalibrationView = () => (
    <View>
      <View style={styles.infoBox}>
        <Ionicons name="information-circle" size={16} color="#60a5fa" />
        <Text style={styles.infoText}>
          La boucle d'apprentissage compare la probabilité moyenne annoncée par l'IA au taux de réussite réel.
          Un écart de +15 points ou plus indique un biais (ex: BTTS annoncé à 65% mais réel 40%).
        </Text>
      </View>

      {calibrations.map((cal, idx) => {
        if (cal.total_predictions === 0) return null;

        const statusColor =
          cal.calibration_status === 'calibre' ? '#10b981' :
          cal.calibration_status === 'suspect' ? '#f59e0b' : '#ef4444';

        const statusIcon =
          cal.calibration_status === 'calibre' ? 'checkmark-circle' :
          cal.calibration_status === 'suspect' ? 'warning' : 'close-circle';

        const statusLabel =
          cal.calibration_status === 'calibre' ? 'Calibré' :
          cal.calibration_status === 'suspect' ? 'Suspect' : 'Non calibré';

        const predictedPct = (cal.avg_predicted_prob * 100).toFixed(1);
        const actualPct = (cal.actual_success_rate * 100).toFixed(1);
        const delta = ((cal.avg_predicted_prob - cal.actual_success_rate) * 100).toFixed(1);

        return (
          <View key={idx} style={styles.calibrationCard}>
            <View style={styles.calibrationHeader}>
              <Text style={styles.marketLabel}>{cal.market}</Text>
              <View style={[styles.statusBadge, { borderColor: statusColor }]}>
                <Ionicons name={statusIcon} size={12} color={statusColor} />
                <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
              </View>
            </View>

            <View style={styles.calibrationStats}>
              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Prédictions</Text>
                <Text style={styles.statValue}>{cal.total_predictions}</Text>
                <Text style={styles.statSub}>{cal.predictions_won} gagnées</Text>
              </View>

              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Taux Prédit</Text>
                <Text style={styles.statValue}>{predictedPct}%</Text>
              </View>

              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Taux Réel</Text>
                <Text style={[styles.statValue, { color: statusColor }]}>{actualPct}%</Text>
              </View>

              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Écart</Text>
                <Text style={[styles.statValue, parseFloat(delta) > 0 ? styles.negative : styles.positive]}>
                  {delta > '0' ? '+' : ''}{delta}
                </Text>
              </View>
            </View>

            {cal.calibration_status === 'suspect' && (
              <View style={styles.warningBox}>
                <Ionicons name="alert-circle" size={14} color="#f59e0b" />
                <Text style={styles.warningText}>
                  Biais détecté : l'IA surestime ce marché. Confiance automatiquement dégradée.
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );

  const renderLessonsView = () => (
    <View>
      <View style={styles.infoBox}>
        <Ionicons name="bulb" size={16} color="#f59e0b" />
        <Text style={styles.infoText}>
          Ces règles dures sont issues des pertes réelles. Elles sont appliquées automatiquement par le validateur.
        </Text>
      </View>

      {lessons.map((lesson, idx) => (
        <View key={idx} style={styles.lessonCard}>
          <View style={styles.lessonHeader}>
            <Text style={styles.lessonOccurrences}>{lesson.occurrences}× occurrences</Text>
            <View style={styles.ruleTag}>
              <Text style={styles.ruleText}>{lesson.regle_validation}</Text>
            </View>
          </View>

          <Text style={styles.lessonMotif}>{lesson.motif}</Text>
          <Text style={styles.lessonDetail}>{lesson.detail.substring(0, 200)}...</Text>

          <Text style={styles.lessonDate}>Dernière maj : {lesson.derniere_maj}</Text>
        </View>
      ))}
    </View>
  );

  const renderReportView = () => (
    <View>
      <View style={styles.reportCard}>
        <View style={styles.reportHeader}>
          <Ionicons name="document-text" size={20} color="#10b981" />
          <Text style={styles.reportTitle}>Rapport Quotidien - {dailyReport.date}</Text>
        </View>

        <Text style={styles.reportContent}>{dailyReport.details}</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Rapports & Évolution IA</Text>
        <Text style={styles.subtitle}>Calibration, leçons apprises, amélioration continue</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, selectedTab === 'calibration' && styles.activeTab]}
          onPress={() => setSelectedTab('calibration')}
        >
          <Ionicons
            name="analytics"
            size={18}
            color={selectedTab === 'calibration' ? '#3b82f6' : '#64748b'}
          />
          <Text style={[styles.tabText, selectedTab === 'calibration' && styles.activeTabText]}>
            Calibration
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tab, selectedTab === 'lessons' && styles.activeTab]}
          onPress={() => setSelectedTab('lessons')}
        >
          <Ionicons
            name="school"
            size={18}
            color={selectedTab === 'lessons' ? '#3b82f6' : '#64748b'}
          />
          <Text style={[styles.tabText, selectedTab === 'lessons' && styles.activeTabText]}>
            Leçons
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tab, selectedTab === 'report' && styles.activeTab]}
          onPress={() => setSelectedTab('report')}
        >
          <Ionicons
            name="newspaper"
            size={18}
            color={selectedTab === 'report' ? '#3b82f6' : '#64748b'}
          />
          <Text style={[styles.tabText, selectedTab === 'report' && styles.activeTabText]}>
            Rapport
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {selectedTab === 'calibration' && renderCalibrationView()}
        {selectedTab === 'lessons' && renderLessonsView()}
        {selectedTab === 'report' && renderReportView()}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  header: {
    padding: 16,
    paddingBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 2,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 12,
    gap: 8,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    gap: 6,
  },
  activeTab: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderColor: '#3b82f6',
  },
  tabText: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '500',
  },
  activeTabText: {
    color: '#3b82f6',
    fontWeight: 'bold',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(96, 165, 250, 0.1)',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.3)',
  },
  infoText: {
    fontSize: 11,
    color: '#94a3b8',
    flex: 1,
    lineHeight: 16,
  },
  calibrationCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  calibrationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  marketLabel: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    gap: 4,
  },
  statusText: {
    fontSize: 11,
    fontWeight: 'bold',
  },
  calibrationStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  statItem: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 6,
    padding: 8,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 10,
    color: '#64748b',
    marginBottom: 2,
  },
  statValue: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  statSub: {
    fontSize: 9,
    color: '#64748b',
    marginTop: 1,
  },
  positive: {
    color: '#10b981',
  },
  negative: {
    color: '#ef4444',
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    padding: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderRadius: 6,
    gap: 6,
  },
  warningText: {
    fontSize: 11,
    color: '#f59e0b',
    flex: 1,
  },
  lessonCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  lessonHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  lessonOccurrences: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#f59e0b',
  },
  ruleTag: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  ruleText: {
    fontSize: 10,
    color: '#60a5fa',
    fontFamily: 'monospace',
  },
  lessonMotif: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#f8fafc',
    marginBottom: 6,
  },
  lessonDetail: {
    fontSize: 12,
    color: '#94a3b8',
    lineHeight: 17,
    marginBottom: 8,
  },
  lessonDate: {
    fontSize: 10,
    color: '#64748b',
    fontStyle: 'italic',
  },
  reportCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  reportHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  reportTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#f1f5f9',
  },
  reportContent: {
    fontSize: 12,
    color: '#cbd5e1',
    lineHeight: 18,
  },
});
