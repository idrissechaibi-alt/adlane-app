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
  SafeAreaView,
  ActivityIndicator
} from 'react-native';
import { Bet } from '../types';
import { getAllBets } from '../database/storage';
import { calculateDailySummary, calculateLedgerSummary, LedgerSummary } from '../core/ledger';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import Hero from '../components/Hero';

export default function DashboardScreen() {
  const isFocused = useIsFocused();
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedDates, setExpandedDates] = useState<Set<string> | null>(null); // null = pas encore initialisé

  useEffect(() => {
    if (isFocused) {
      void loadBets();
    }
  }, [isFocused]);

  const loadBets = async () => {
    try {
      const data = await getAllBets();
      setBets(data);
    } catch (error) {
      console.error('Erreur chargement paris:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    void loadBets();
  };

  // Groupés par date, du plus récent au plus ancien — chaque groupe est une
  // ligne rétractable (seule la plus récente est dépliée par défaut, pour ne
  // pas charger tout l'historique à l'écran). Calculé avant le early-return
  // "loading" pour respecter l'ordre des hooks (le useEffect qui suit doit
  // s'exécuter à chaque rendu, jamais conditionnellement).
  const betsByDate = new Map<string, Bet[]>();
  for (const bet of bets) {
    const group = betsByDate.get(bet.date) ?? [];
    group.push(bet);
    betsByDate.set(bet.date, group);
  }
  const sortedDates = Array.from(betsByDate.keys()).sort((a, b) => b.localeCompare(a));

  useEffect(() => {
    if (expandedDates === null && sortedDates.length > 0) {
      setExpandedDates(new Set([sortedDates[0]]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedDates.length]);

  const toggleDate = (date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#F5B83D" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const cumulativeSummary: LedgerSummary = calculateLedgerSummary(bets);

  const renderProgressBar = (value: number, max: number, color: string) => {
    const percentage = Math.min(Math.max((value / max) * 100, 0), 100);
    return (
      <View style={styles.progressContainer}>
        <View style={[styles.progressBar, { width: `${percentage}%`, backgroundColor: color }]} />
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <Hero
        title="Bilan P&L"
        value={`${cumulativeSummary.net_pnl > 0 ? '+' : ''}${cumulativeSummary.net_pnl.toFixed(2)} u`}
        tone={cumulativeSummary.net_pnl >= 0 ? 'good' : 'bad'}
        caption={`ROI ${cumulativeSummary.roi.toFixed(1)} % · ${cumulativeSummary.bets_settled} réglé${cumulativeSummary.bets_settled > 1 ? 's' : ''}`}
      />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#F5B83D" />}
      >
        {/* Header */}
        {/* Bannière de posture légale & éthique */}
        <View style={styles.disclaimerBox}>
          <Ionicons name="information-circle-outline" size={18} color="#A39A8C" />
          <Text style={styles.disclaimerText}>
            Constat et analyse uniquement. Aucun conseil de mise ni de staking.
          </Text>
        </View>

        {/* Section Cumul Global (Source de Vérité §7) */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="stats-chart" size={20} color="#F5B83D" />
            <Text style={styles.cardTitle}>Bilan Cumulé ({cumulativeSummary.bets_settled} réglé{cumulativeSummary.bets_settled > 1 ? 's' : ''})</Text>
          </View>

          <View style={styles.statsGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>Net P&L</Text>
              <Text style={[styles.statValue, cumulativeSummary.net_pnl >= 0 ? styles.positive : styles.negative]}>
                {cumulativeSummary.net_pnl >= 0 ? '+' : ''}{cumulativeSummary.net_pnl.toFixed(3)} u
              </Text>
              {renderProgressBar(Math.abs(cumulativeSummary.net_pnl), 50, '#F5B83D')}
            </View>

            <View style={styles.statBox}>
              <Text style={styles.statLabel}>ROI Global</Text>
              <Text style={[styles.statValue, cumulativeSummary.roi >= 0 ? styles.positive : styles.negative]}>
                {cumulativeSummary.roi >= 0 ? '+' : ''}{cumulativeSummary.roi.toFixed(1)}%
              </Text>
              {renderProgressBar(Math.abs(cumulativeSummary.roi), 100, '#7BD88F')}
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

        {/* Historique des Paris, regroupé par date */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Historique des Paris par Journée</Text>
        </View>

        {sortedDates.length === 0 ? (
          <View style={styles.disclaimerBox}>
            <Ionicons name="information-circle-outline" size={18} color="#A39A8C" />
            <Text style={styles.disclaimerText}>Aucun pari enregistré pour l'instant.</Text>
          </View>
        ) : (
          sortedDates.map((date) => {
            const dayBets = betsByDate.get(date)!;
            const daySummary = calculateDailySummary(bets, date);
            const isExpanded = expandedDates?.has(date) ?? false;

            return (
              <View key={date} style={styles.dateGroupCard}>
                <TouchableOpacity style={styles.dateGroupHeader} onPress={() => toggleDate(date)}>
                  <View style={styles.dateGroupLeft}>
                    <Ionicons name="calendar" size={18} color="#7BD88F" />
                    <Text style={styles.dateGroupTitle}>{date}</Text>
                    <View style={styles.dateGroupBadge}>
                      <Text style={styles.dateGroupBadgeText}>{dayBets.length}</Text>
                    </View>
                  </View>
                  <View style={styles.dateGroupRight}>
                    <Text style={[styles.dateGroupSummary, daySummary.net_pnl >= 0 ? styles.positive : styles.negative]}>
                      {daySummary.net_pnl >= 0 ? '+' : ''}{daySummary.net_pnl.toFixed(2)} u
                    </Text>
                    <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={18} color="#A39A8C" />
                  </View>
                </TouchableOpacity>

                {isExpanded && (
                  <View style={styles.dateGroupBody}>
                    <View style={styles.dateGroupStatsRow}>
                      <Text style={styles.dateGroupStatText}>
                        {daySummary.bets_won}V / {daySummary.bets_lost}D sur {daySummary.bets_settled} réglé{daySummary.bets_settled > 1 ? 's' : ''}
                      </Text>
                      <Text style={styles.dateGroupStatText}>Mise {daySummary.total_stake.toFixed(1)} u</Text>
                    </View>

                    {dayBets.map((bet) => {
                      const isWon = bet.status === 'won';
                      const isLost = bet.status === 'lost';

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
                                {isWon ? 'GAGNÉ' : isLost ? 'PERDU' : bet.played ? 'EN ATTENTE' : 'NON JOUÉ'}
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
                                  color={leg.result === 'won' ? '#7BD88F' : leg.result === 'lost' ? '#F58A7E' : '#A39A8C'}
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
                              <Ionicons name="bulb-outline" size={14} color="#F5B83D" />
                              <Text style={styles.analysisText}>{bet.analysis}</Text>
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#141210',
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
    color: '#F5EFE6',
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#A39A8C',
    marginTop: 2,
  },
  disclaimerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E1B17',
    padding: 10,
    borderRadius: 8,
    marginBottom: 16,
    gap: 8,
  },
  disclaimerText: {
    fontSize: 12,
    color: '#A39A8C',
    flex: 1,
    fontStyle: 'italic',
  },
  card: {
    backgroundColor: '#1E1B17',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#3A352D',
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
    color: '#F5EFE6',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  progressContainer: {
    height: 4,
    backgroundColor: '#2E2A24',
    borderRadius: 2,
    marginTop: 8,
    width: '100%',
  },
  progressBar: {
    height: '100%',
    borderRadius: 2,
  },
  statBox: {
    width: '48%',
    backgroundColor: '#141210',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#3A352D',
  },
  statLabel: {
    fontSize: 12,
    color: '#A39A8C',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#F5EFE6',
  },
  statSub: {
    fontSize: 12,
    color: '#8C8376',
    marginTop: 2,
  },
  positive: {
    color: '#7BD88F',
  },
  negative: {
    color: '#F58A7E',
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
    color: '#F5EFE6',
  },
  dateGroupCard: {
    backgroundColor: '#1E1B17',
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#3A352D',
    overflow: 'hidden',
  },
  dateGroupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
  },
  dateGroupLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dateGroupTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#F5EFE6',
  },
  dateGroupBadge: {
    backgroundColor: '#2E2A24',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  dateGroupBadgeText: {
    fontSize: 12,
    color: '#D9D2C6',
    fontWeight: '600',
  },
  dateGroupRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dateGroupSummary: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  dateGroupBody: {
    borderTopWidth: 1,
    borderTopColor: '#3A352D',
    padding: 14,
  },
  dateGroupStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  dateGroupStatText: {
    fontSize: 12,
    color: '#A39A8C',
  },
  betCard: {
    backgroundColor: '#1E1B17',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#3A352D',
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
    color: '#F5EFE6',
  },
  betLeague: {
    fontSize: 12,
    color: '#A39A8C',
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
    borderColor: '#7BD88F',
  },
  badgeLost: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderWidth: 1,
    borderColor: '#F58A7E',
  },
  badgeUnplayed: {
    backgroundColor: 'rgba(148, 163, 184, 0.2)',
    borderWidth: 1,
    borderColor: '#6B6459',
  },
  statusText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#141210',
  },
  legsContainer: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#3A352D',
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
    color: '#D9D2C6',
    fontWeight: '500',
  },
  legSelection: {
    fontSize: 12,
    color: '#A39A8C',
    flex: 1,
  },
  voidTag: {
    fontSize: 12,
    color: '#FF9F5A',
    fontWeight: 'bold',
  },
  betFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 4,
  },
  betFooterText: {
    fontSize: 12,
    color: '#D9D2C6',
  },
  analysisBox: {
    flexDirection: 'row',
    backgroundColor: '#141210',
    padding: 8,
    borderRadius: 6,
    marginTop: 8,
    gap: 6,
    alignItems: 'center',
  },
  analysisText: {
    fontSize: 12,
    color: '#A39A8C',
    flex: 1,
    fontStyle: 'italic',
  },
});
