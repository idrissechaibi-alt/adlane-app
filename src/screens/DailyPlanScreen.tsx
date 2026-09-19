// Écran Planning & Propositions du Jour
// Affiche les créneaux chronologiques, compte à rebours T-90, et propositions validées/rejetées

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
import { Ionicons } from '@expo/vector-icons';
import { executeMorningScan, getDailyPlan, checkAndUpdateT90Status, DailyPlan } from '../core/scheduler';
import { generateDailyProposals, ScheduledMatch } from '../core/dailyWorkflow';
import { estimateExpectedGoalsFromMarket } from '../core/poisson';
import { getHalftimeAlertsLog, HalftimeAlertLogEntry } from '../core/halftimeMonitor';
import { DailyScheduleSlot, ScheduledMatchDetail } from '../types/database';
import { ProposedSlip } from '../core/dailyWorkflow';
import { HISTORICAL_BETS } from '../data/historical';

/**
 * Convertit les matchs planifiés en entrées exploitables par le moteur de
 * propositions. Les buts attendus sont dérivés des cotes du marché (jamais
 * inventés) ; un match sans cotes 1X2 + Over/Under exploitables est exclu
 * plutôt que de produire une "proposition" basée sur des données fictives.
 */
function buildScheduledMatches(slots: DailyScheduleSlot[]): { matches: ScheduledMatch[]; skippedNoOdds: number } {
  const matches: ScheduledMatch[] = [];
  let skippedNoOdds = 0;

  for (const slot of slots) {
    for (const m of slot.matches as ScheduledMatchDetail[]) {
      const estimated = estimateExpectedGoalsFromMarket(m.odds);
      if (!estimated) {
        skippedNoOdds++;
        continue;
      }
      matches.push({ ...m, expectedHomeGoals: estimated.home, expectedAwayGoals: estimated.away });
    }
  }

  return { matches, skippedNoOdds };
}

export default function DailyPlanScreen() {
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [proposals, setProposals] = useState<ProposedSlip[]>([]);
  const [matchesMissingOdds, setMatchesMissingOdds] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [halftimeAlerts, setHalftimeAlerts] = useState<HalftimeAlertLogEntry[]>([]);

  useEffect(() => {
    loadDailyPlan();
    loadHalftimeAlerts();

    // Vérifier T-90 toutes les 30 secondes, et relire les alertes mi-temps
    // au même rythme (le moniteur tourne en tâche de fond dans App.tsx).
    const interval = setInterval(() => {
      checkAndUpdateT90Status();
      loadDailyPlan();
      loadHalftimeAlerts();
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  const loadHalftimeAlerts = async () => {
    const log = await getHalftimeAlertsLog();
    const today = new Date().toISOString().split('T')[0];
    setHalftimeAlerts(log.filter((a) => a.timestamp.startsWith(today)));
  };

  const loadDailyPlan = async () => {
    const existing = await getDailyPlan();
    if (existing) {
      setPlan(existing);
      // Propositions générées dès que des matchs sont disponibles (pas besoin d'attendre T-90) :
      // le compte à rebours T-90 reste affiché à titre indicatif par créneau.
      const { matches, skippedNoOdds } = buildScheduledMatches(existing.slots);
      setMatchesMissingOdds(skippedNoOdds);
      setProposals(matches.length > 0 ? generateDailyProposals(matches, HISTORICAL_BETS) : []);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const newPlan = await executeMorningScan();
      setPlan(newPlan);
      const { matches, skippedNoOdds } = buildScheduledMatches(newPlan.slots);
      setMatchesMissingOdds(skippedNoOdds);
      setProposals(matches.length > 0 ? generateDailyProposals(matches, HISTORICAL_BETS) : []);
    } catch (error) {
      console.error('Erreur refresh:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleRunMorningScan = async () => {
    setLoading(true);
    try {
      const newPlan = await executeMorningScan();
      setPlan(newPlan);
      const { matches, skippedNoOdds } = buildScheduledMatches(newPlan.slots);
      setMatchesMissingOdds(skippedNoOdds);
      const generated = matches.length > 0 ? generateDailyProposals(matches, HISTORICAL_BETS) : [];
      setProposals(generated);
    } catch (error) {
      console.error('Erreur scan matinal:', error);
    } finally {
      setLoading(false);
    }
  };

  const getTimeUntilT90 = (kickoffUtc: string): string => {
    const now = new Date();
    const kickoff = new Date(kickoffUtc);
    const t90 = new Date(kickoff.getTime() - 90 * 60 * 1000);
    const diffMs = t90.getTime() - now.getTime();

    if (diffMs <= 0) return 'T-90 atteint';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) return `T-90 dans ${hours}h${minutes}`;
    return `T-90 dans ${minutes} min`;
  };

  const renderSlot = (slot: DailyScheduleSlot) => {
    const isSelected = selectedSlot === slot.slotId;
    const slotProposals = proposals.filter(p =>
      p.legs.some(leg => slot.matches.some(m => leg.match.includes(m.homeTeam)))
    );

    return (
      <View key={slot.slotId} style={styles.slotCard}>
        <TouchableOpacity
          style={styles.slotHeader}
          onPress={() => setSelectedSlot(isSelected ? null : slot.slotId)}
        >
          <View style={styles.slotLeft}>
            <Ionicons
              name="time-outline"
              size={20}
              color={slot.isT90Reached ? '#10b981' : '#60a5fa'}
            />
            <Text style={styles.slotTime}>{slot.slotTimeDisplay}</Text>
            <View style={styles.matchCountBadge}>
              <Text style={styles.matchCountText}>{slot.matchesCount} match{slot.matchesCount > 1 ? 's' : ''}</Text>
            </View>
          </View>

          <View style={styles.slotRight}>
            {slot.isT90Reached ? (
              <View style={styles.t90Badge}>
                <Ionicons name="checkmark-circle" size={16} color="#10b981" />
                <Text style={styles.t90Text}>T-90 ✓</Text>
              </View>
            ) : (
              <Text style={styles.countdownText}>{getTimeUntilT90(slot.slotKickoffUtc)}</Text>
            )}
            <Ionicons
              name={isSelected ? 'chevron-up' : 'chevron-down'}
              size={20}
              color="#94a3b8"
            />
          </View>
        </TouchableOpacity>

        {isSelected && (
          <View style={styles.slotContent}>
            {/* Liste des matchs */}
            {slot.matches.map((match, idx) => (
              <View key={idx} style={styles.matchRow}>
                <Text style={styles.matchFlag}>{match.flag}</Text>
                <Text style={styles.matchText}>
                  {match.homeTeam} vs {match.awayTeam}
                </Text>
              </View>
            ))}

            {/* Propositions si T-90 atteint */}
            {slotProposals.length > 0 && (
              <View style={styles.proposalsSection}>
                <Text style={styles.proposalsTitle}>💡 Propositions Générées :</Text>
                {slotProposals.map((prop, idx) => (
                  <View
                    key={idx}
                    style={[
                      styles.proposalCard,
                      prop.validation.valid ? styles.proposalValid : styles.proposalRejected
                    ]}
                  >
                    <View style={styles.proposalHeader}>
                      <View style={styles.proposalTypeTag}>
                        <Text style={styles.proposalTypeText}>
                          {prop.type === 'solo' ? '🎯 SOLO' : '🔗 COMBINÉ'}
                        </Text>
                      </View>
                      <View style={[
                        styles.validationBadge,
                        prop.validation.valid ? styles.validBadge : styles.rejectedBadge
                      ]}>
                        <Ionicons
                          name={prop.validation.valid ? 'checkmark-circle' : 'close-circle'}
                          size={14}
                          color={prop.validation.valid ? '#10b981' : '#ef4444'}
                        />
                        <Text style={[
                          styles.validationText,
                          prop.validation.valid ? styles.validText : styles.rejectedText
                        ]}>
                          {prop.validation.valid ? 'Validé' : 'Rejeté'}
                        </Text>
                      </View>
                    </View>

                    <Text style={styles.proposalTitle}>{prop.title}</Text>
                    <Text style={styles.proposalOdds}>Cote : {prop.totalOdds.toFixed(2)}</Text>
                    <Text style={styles.proposalAnalysis}>{prop.analysis}</Text>

                    {/* Affichage des jambes */}
                    {prop.legs.map((leg, lIdx) => (
                      <Text key={lIdx} style={styles.legText}>
                        • {leg.selection} ({(leg.estimated_prob! * 100).toFixed(1)}%)
                      </Text>
                    ))}

                    {/* Alertes et blocages */}
                    {prop.validation.blockers.length > 0 && (
                      <View style={styles.blockersBox}>
                        {prop.validation.blockers.map((block, bIdx) => (
                          <View key={bIdx} style={styles.blockerRow}>
                            <Ionicons name="alert-circle" size={12} color="#ef4444" />
                            <Text style={styles.blockerText}>{block}</Text>
                          </View>
                        ))}
                      </View>
                    )}

                    {prop.validation.warnings.length > 0 && (
                      <View style={styles.warningsBox}>
                        {prop.validation.warnings.map((warn, wIdx) => (
                          <View key={wIdx} style={styles.warningRow}>
                            <Ionicons name="warning" size={12} color="#f59e0b" />
                            <Text style={styles.warningText}>{warn}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Planning & Créneaux du Jour</Text>
        <Text style={styles.subtitle}>
          {plan ? `${plan.totalMatches} matchs • ${plan.slots.length} créneaux` : 'Chargement...'}
        </Text>
      </View>

      <TouchableOpacity style={styles.scanButton} onPress={handleRunMorningScan} disabled={loading}>
        {loading ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <>
            <Ionicons name="refresh" size={18} color="#ffffff" />
            <Text style={styles.scanButtonText}>Lancer le Scan Matinal</Text>
          </>
        )}
      </TouchableOpacity>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#3b82f6" />}
      >
        {halftimeAlerts.length > 0 && (
          <View style={styles.halftimeAlertsBox}>
            <View style={styles.halftimeAlertsHeader}>
              <Ionicons name="notifications" size={18} color="#a78bfa" />
              <Text style={styles.halftimeAlertsTitle}>
                Alertes mi-temps du jour ({halftimeAlerts.length})
              </Text>
            </View>
            {halftimeAlerts.map((alert, idx) => (
              <View key={`${alert.matchId}-${idx}`} style={styles.halftimeAlertRow}>
                <Text style={styles.halftimeAlertMatch}>
                  {alert.homeTeam} {alert.htScore.home}-{alert.htScore.away} {alert.awayTeam}
                </Text>
                <Text style={styles.halftimeAlertSelection}>
                  {alert.selection} — {(alert.estimated_prob * 100).toFixed(0)}% ({alert.confidence})
                </Text>
              </View>
            ))}
          </View>
        )}

        {matchesMissingOdds > 0 && (
          <View style={styles.oddsWarningBox}>
            <Ionicons name="information-circle" size={20} color="#f59e0b" />
            <Text style={styles.oddsWarningText}>
              {matchesMissingOdds} match{matchesMissingOdds > 1 ? 's' : ''} sans cotes exploitables (1X2 + Over/Under) —
              aucune proposition ne peut être calculée pour {matchesMissingOdds > 1 ? 'eux' : 'lui'}. Configurez TheOddsAPI
              ou API-Football dans Paramètres → Gestion des API pour des cotes réelles.
            </Text>
          </View>
        )}

        {plan && plan.slots.length > 0 ? (
          plan.slots.map(renderSlot)
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="calendar-outline" size={64} color="#64748b" />
            <Text style={styles.emptyText}>Aucun match programmé aujourd'hui</Text>
            <Text style={styles.emptySubText}>Lance le scan matinal pour détecter les matchs</Text>
          </View>
        )}
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
  scanButton: {
    backgroundColor: '#2563eb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 16,
    padding: 12,
    borderRadius: 8,
    gap: 8,
    marginBottom: 16,
  },
  scanButtonText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  scrollContent: {
    padding: 16,
    paddingTop: 0,
    paddingBottom: 40,
  },
  slotCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  slotHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
  },
  slotLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  slotTime: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  matchCountBadge: {
    backgroundColor: '#334155',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  matchCountText: {
    fontSize: 11,
    color: '#cbd5e1',
    fontWeight: '600',
  },
  slotRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  t90Badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  t90Text: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#10b981',
  },
  countdownText: {
    fontSize: 12,
    color: '#60a5fa',
    fontWeight: '600',
  },
  slotContent: {
    borderTopWidth: 1,
    borderColor: '#334155',
    padding: 14,
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  matchFlag: {
    fontSize: 16,
  },
  matchText: {
    fontSize: 13,
    color: '#cbd5e1',
    flex: 1,
  },
  proposalsSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: '#334155',
  },
  proposalsTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#f8fafc',
    marginBottom: 10,
  },
  proposalCard: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 1,
  },
  proposalValid: {
    backgroundColor: 'rgba(16, 185, 129, 0.05)',
    borderColor: '#10b981',
  },
  proposalRejected: {
    backgroundColor: 'rgba(239, 68, 68, 0.05)',
    borderColor: '#ef4444',
  },
  proposalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  proposalTypeTag: {
    backgroundColor: '#334155',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  proposalTypeText: {
    fontSize: 10,
    color: '#f8fafc',
    fontWeight: 'bold',
  },
  validationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  validBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  rejectedBadge: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  validationText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  validText: {
    color: '#10b981',
  },
  rejectedText: {
    color: '#ef4444',
  },
  proposalTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#f8fafc',
    marginBottom: 4,
  },
  proposalOdds: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 6,
  },
  proposalAnalysis: {
    fontSize: 11,
    color: '#94a3b8',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  legText: {
    fontSize: 11,
    color: '#cbd5e1',
    marginBottom: 3,
  },
  blockersBox: {
    marginTop: 8,
    padding: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 4,
  },
  blockerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  blockerText: {
    fontSize: 10,
    color: '#ef4444',
    fontWeight: '600',
    flex: 1,
  },
  warningsBox: {
    marginTop: 8,
    padding: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderRadius: 4,
  },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  warningText: {
    fontSize: 10,
    color: '#f59e0b',
    fontWeight: '600',
    flex: 1,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#94a3b8',
    marginTop: 16,
  },
  emptySubText: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 4,
  },
  oddsWarningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  oddsWarningText: {
    flex: 1,
    color: '#fde68a',
    fontSize: 12,
    lineHeight: 18,
  },
  halftimeAlertsBox: {
    backgroundColor: 'rgba(167, 139, 250, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(167, 139, 250, 0.35)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  halftimeAlertsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  halftimeAlertsTitle: {
    color: '#e9d5ff',
    fontSize: 13,
    fontWeight: 'bold',
  },
  halftimeAlertRow: {
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(167, 139, 250, 0.2)',
  },
  halftimeAlertMatch: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
  },
  halftimeAlertSelection: {
    color: '#c4b5fd',
    fontSize: 12,
    marginTop: 2,
  },
});
