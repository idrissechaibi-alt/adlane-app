// Écran Dashboard & Bilan P&L
// Affiche le bilan du jour, le cumul, et l'historique complet des paris avec leurs analyses factuelles

import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  SafeAreaView
} from 'react-native';
import { Bet } from '../types';
import { HISTORICAL_BETS } from '../data/historical';
import { calculateDailySummary, calculateLedgerSummary, LedgerSummary } from '../core/ledger';
import { Ionicons } from '@expo/vector-icons';

export default function DashboardScreen() {
  const [bets, setBets] = useState<Bet[]>(HISTORICAL_BETS);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDate, setSelectedDate] = useState('2026-09-13');

  const dailySummary: LedgerSummary = calculateDailySummary(bets, selectedDate);
  const cumulativeSummary: LedgerSummary = calculateLedgerSummary(bets);

  const onRefresh = () => {
    setRefreshing(true);
    // Recharger
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3b82f6" />}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.appTitle}>APP adlane</Text>
          <Text style={styles.subtitle}>Suivi & Analyse Probabiliste Football</Text>
        </View>

        {/* Bannière de posture légale & éthique */}
        <View style={styles.disclaimerBox}>
          <Ionicons name="information-circle-outline" size={18} color="#94a3b8" />
          <Text style={styles.disclaimerText}>
            Constat et analyse uniquement. Aucun conseil de mise ni de staking.
          </Text>
        </View>

        {/* Section Cumul Global (Source de Vérité §7) */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="stats-chart" size={20} color="#3b82f6" />
            <Text style={styles.cardTitle}>Bilan Cumulé (10 réglés)</Text>
          </View>

          <View style={styles.statsGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>Net P&L</Text>
              <Text style={[styles.statValue, styles.positive]}>
                +{cumulativeSummary.net_pnl.toFixed(3)} u
              </Text>
            </View>

            <View style={styles.statBox}>
              <Text style={styles.statLabel}>ROI Global</Text>
              <Text style={[styles.statValue, styles.positive]}>
                +{cumulativeSummary.roi.toFixed(1)}%
              </Text>
            </View>

            <View style={styles.statBox}>
              <Text style={styles.statLabel}>Taux Victoires</Text>
              <Text style={styles.statValue}>
                {cumulativeSummary.win_rate.toFixed(1)}%
              </Text>
              <Text style={styles.statSub}>
                {cumulativeSummary.bets_won}V / {cumulativeSummary.bets_lost}D
              </Text>
            </View>

            <View style={styles.statBox}>
              <Text style={styles.statLabel}>Mise Totale</Text>
              <Text style={styles.statValue}>{cumulativeSummary.total_stake.toFixed(1)} u</Text>
            </View>
          </View>
        </View>

        {/* Section Bilan Journée Sélectionnée */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="calendar" size={20} color="#10b981" />
            <Text style={styles.cardTitle}>Journée du {selectedDate}</Text>
          </View>

          <View style={styles.statsGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>Net Jour</Text>
              <Text style={[styles.statValue, dailySummary.net_pnl >= 0 ? styles.positive : styles.negative]}>
                {dailySummary.net_pnl >= 0 ? '+' : ''}{dailySummary.net_pnl.toFixed(3)} u
              </Text>
            </View>

            <View style={styles.statBox}>
              <Text style={styles.statLabel}>ROI Jour</Text>
              <Text style={[styles.statValue, dailySummary.roi >= 0 ? styles.positive : styles.negative]}>
                {dailySummary.roi >= 0 ? '+' : ''}{dailySummary.roi.toFixed(1)}%
              </Text>
            </View>

            <View style={styles.statBox}>
              <Text style={styles.statLabel}>Paris Réglés</Text>
              <Text style={styles.statValue}>{dailySummary.bets_settled}</Text>
              <Text style={styles.statSub}>
                {dailySummary.bets_won}V / {dailySummary.bets_lost}D
              </Text>
            </View>

            <View style={styles.statBox}>
              <Text style={styles.statLabel}>Mises du Jour</Text>
              <Text style={styles.statValue}>{dailySummary.total_stake.toFixed(1)} u</Text>
            </View>
          </View>
        </View>

        {/* Historique des Paris */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Historique des Paris Réglés</Text>
        </View>

        {bets.map(bet => {
          const isWon = bet.status === 'won';
          const isLost = bet.status === 'lost';
          const isUnplayed = bet.excluded_from_pnl;

          return (
            <View key={bet.id} style={styles.betCard}>
              <View style={styles.betCardTop}>
                <View style={styles.betIdContainer}>
                  <Text style={styles.betId}>{bet.id}</Text>
                  <Text style={styles.betLeague}>{bet.league} • {bet.creneau_display}</Text>
                </View>

                <View style={[
                  styles.statusBadge,
                  isWon ? styles.badgeWon : isLost ? styles.badgeLost : styles.badgeUnplayed
                ]}>
                  <Text style={styles.statusText}>
                    {isWon ? 'GAGNÉ' : isLost ? 'PERDU' : 'NON JOUÉ'}
                  </Text>
                </View>
              </View>

              {/* Jambes du pari */}
              <View style={styles.legsContainer}>
                {bet.legs.map((leg, idx) => (
                  <View key={idx} style={styles.legRow}>
                    <Ionicons
                      name={leg.result === 'won' ? 'checkmark-circle' : leg.result === 'lost' ? 'close-circle' : 'time'}
                      size={16}
                      color={leg.result === 'won' ? '#10b981' : leg.result === 'lost' ? '#ef4444' : '#94a3b8'}
                    />
                    <Text style={styles.legMatch}>{leg.match} :</Text>
                    <Text style={styles.legSelection}>{leg.selection}</Text>
                    {leg.is_void && <Text style={styles.voidTag}>(VOID)</Text>}
                  </View>
                ))}
              </View>

              {/* Chiffres Financiers */}
              <View style={styles.betFooter}>
                <Text style={styles.betFooterText}>
                  Cote : <Text style={styles.bold}>{bet.odds?.toFixed(2) || 'N/A'}</Text>
                </Text>
                <Text style={styles.betFooterText}>
                  Mise : <Text style={styles.bold}>{bet.stake ? `${bet.stake} u` : 'N/A'}</Text>
                </Text>
                <Text style={[
                  styles.betFooterText,
                  (bet.net_pnl || 0) >= 0 ? styles.positive : styles.negative
                ]}>
                  Net : <Text style={styles.bold}>
                    {(bet.net_pnl || 0) >= 0 ? '+' : ''}{bet.net_pnl?.toFixed(2) || '0.00'} u
                  </Text>
                </Text>
              </View>

              {/* Analyse factuelle de cause */}
              {bet.analysis ? (
                <View style={styles.analysisBox}>
                  <Ionicons name="bulb-outline" size={14} color="#60a5fa" />
                  <Text style={styles.analysisText}>{bet.analysis}</Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 12,
  },
  appTitle: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#f8fafc',
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 2,
  },
  disclaimerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    padding: 10,
    borderRadius: 8,
    marginBottom: 16,
    gap: 8,
  },
  disclaimerText: {
    fontSize: 11,
    color: '#94a3b8',
    flex: 1,
    fontStyle: 'italic',
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f1f5f9',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  statBox: {
    width: '48%',
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statLabel: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  statSub: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  positive: {
    color: '#10b981',
  },
  negative: {
    color: '#ef4444',
  },
  bold: {
    fontWeight: 'bold',
  },
  sectionHeader: {
    marginTop: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  betCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  betCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  betIdContainer: {
    flex: 1,
  },
  betId: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  betLeague: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeWon: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderWidth: 1,
    borderColor: '#10b981',
  },
  badgeLost: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  badgeUnplayed: {
    backgroundColor: 'rgba(148, 163, 184, 0.2)',
    borderWidth: 1,
    borderColor: '#64748b',
  },
  statusText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  legsContainer: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#334155',
    paddingVertical: 8,
    marginBottom: 10,
    gap: 6,
  },
  legRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legMatch: {
    fontSize: 12,
    color: '#cbd5e1',
    fontWeight: '500',
  },
  legSelection: {
    fontSize: 12,
    color: '#94a3b8',
    flex: 1,
  },
  voidTag: {
    fontSize: 10,
    color: '#f59e0b',
    fontWeight: 'bold',
  },
  betFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 4,
  },
  betFooterText: {
    fontSize: 12,
    color: '#cbd5e1',
  },
  analysisBox: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    padding: 8,
    borderRadius: 6,
    marginTop: 8,
    gap: 6,
    alignItems: 'center',
  },
  analysisText: {
    fontSize: 11,
    color: '#94a3b8',
    flex: 1,
    fontStyle: 'italic',
  },
});
