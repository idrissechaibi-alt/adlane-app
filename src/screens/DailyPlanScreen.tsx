// Écran Planning & Propositions du Jour
// Affiche les créneaux chronologiques, compte à rebours T-90, et propositions validées/rejetées

import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  SafeAreaView,
  ActivityIndicator,
  Alert
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { executeMorningScan, getDailyPlan, checkAndUpdateT90Status, DailyPlan } from '../core/scheduler';
import { buildScheduledMatches, ProposedSlip } from '../core/dailyWorkflow';
import { InPlayProposal, readInPlayProposals } from '../core/learnStore';
import { getLineupRefresh, isT90Reached, LineupRefresh } from '../core/lineupRefresh';
import { getAllBets, saveBet } from '../database/storage';
import { DailyScheduleSlot } from '../types/database';
import { Bet, Market } from '../types';
import { TrackedMarket } from '../core/learnStore';
import { namesLikelyMatch, normalizeTeamName } from '../core/teamNameMatch';
import { LegStatus, checkProposalStatus } from '../core/liveBetStatus';

export default function DailyPlanScreen() {
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [proposals, setProposals] = useState<ProposedSlip[]>([]);
  const [matchesMissingOdds, setMatchesMissingOdds] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [inPlayProposals, setInPlayProposals] = useState<InPlayProposal[]>([]);
  const [lineupRefreshes, setLineupRefreshes] = useState<Record<string, LineupRefresh | null>>({});
  const [placedBetIds, setPlacedBetIds] = useState<Set<string>>(new Set());
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [stakeInput, setStakeInput] = useState('');
  const [oddsInput, setOddsInput] = useState('');
  const [placing, setPlacing] = useState(false);
  const [proposalStatus, setProposalStatus] = useState<Record<string, LegStatus>>({});

  // État de chaque pari (en cours / réussi / perdu) revérifié à chaque
  // actualisation de la liste (toutes les 30 s).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        inPlayProposals.map(async (p) => [p.id, await checkProposalStatus(p).catch(() => 'pending' as LegStatus)] as const)
      );
      if (!cancelled) setProposalStatus(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [inPlayProposals]);

  useEffect(() => {
    loadDailyPlan();
    loadInPlayProposals();
    loadPlacedBets();

    // Vérifier T-90 toutes les 30 secondes, et relire les alertes mi-temps
    // au même rythme (le moniteur tourne en tâche de fond dans App.tsx).
    const interval = setInterval(() => {
      checkAndUpdateT90Status();
      loadDailyPlan();
      loadInPlayProposals();
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  const loadPlacedBets = async () => {
    try {
      const bets = await getAllBets();
      setPlacedBetIds(new Set(bets.filter((b) => b.played).map((b) => b.id)));
    } catch (error) {
      console.warn('Paris placés indisponibles:', error);
    }
  };

  const loadInPlayProposals = () => {
    const today = new Date().toISOString().split('T')[0];
    // real !== false : les paris fictifs (boucle d'auto-apprentissage, tout
    // l'univers européen) ne sont jamais affichés ici, seulement les vrais
    // paris sur les 5 grands championnats.
    setInPlayProposals(readInPlayProposals().filter((p) => p.createdAt.startsWith(today) && p.real !== false));
  };

  // Planning du Jour (solos/combinés pré-match) désactivé : les cotes
  // avant-match ne sont plus jugées rentables (demande explicite). Le
  // planning (créneaux, cotes, buts attendus) reste construit — c'est la
  // base dont dépend le scan en direct 20e/60e minute (voir inPlayCombos.ts)
  // — mais plus aucune proposition solo/combiné n'est générée à partir de lui.
  const loadDailyPlan = async () => {
    try {
      const existing = await getDailyPlan();
      if (existing) {
        setPlan(existing);
        const { skippedNoOdds } = buildScheduledMatches(existing.slots);
        setMatchesMissingOdds(skippedNoOdds);
        setProposals([]);
      }
    } catch (error: any) {
      console.error('Erreur chargement planning:', error.message);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const newPlan = await executeMorningScan();
      setPlan(newPlan);
      const { skippedNoOdds } = buildScheduledMatches(newPlan.slots);
      setMatchesMissingOdds(skippedNoOdds);
      setProposals([]);
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
      const { skippedNoOdds } = buildScheduledMatches(newPlan.slots);
      setMatchesMissingOdds(skippedNoOdds);
      setProposals([]);
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

  /**
   * Un pari n'est plaçable qu'une fois le T-90 atteint POUR TOUS ses matchs
   * (un combiné ne porte que sur un seul créneau donc c'est simultané) ET
   * qu'une compo/actu fraîche a été trouvée pour chacun d'eux — jamais avec
   * les seules données du matin.
   */
  const isProposalReadyToPlace = (proposal: ProposedSlip): boolean => {
    return proposal.legs.every((leg) => {
      if (!leg.matchId) return false;
      if (!isT90Reached(leg.kickoff_utc)) return false;
      return Boolean(lineupRefreshes[leg.matchId]);
    });
  };

  /** Marché d'une jambe en direct, dans le vocabulaire des paris enregistrés. */
  const LIVE_MARKET_TO_BET_MARKET: Record<TrackedMarket, Market> = {
    '1X2': '1X2',
    total_buts: 'OU_2_5',
    btts: 'BTTS',
    buts_1ere_mt: '1ere_mi_temps',
    corners: 'corners',
    cartons: 'cards',
    fautes: 'fouls',
  };

  /**
   * Enregistre un combo en direct comme pari réellement joué (cote du
   * bookmaker + mise). Identifiant `live-<proposition>` : le bilan
   * (dailyReview.ts) le règle en même temps que la proposition elle-même,
   * avec les mêmes résultats vérifiés (score final, corners/cartons à la 45e).
   */
  const handleConfirmPlaceLiveBet = async (proposal: InPlayProposal) => {
    const stake = Number(stakeInput.replace(',', '.'));
    if (!Number.isFinite(stake) || stake <= 0) {
      Alert.alert('Mise invalide', 'Entre un montant de mise valide avant de confirmer.');
      return;
    }
    const odds = Number(oddsInput.replace(',', '.'));
    if (!Number.isFinite(odds) || odds <= 1) {
      Alert.alert('Cote invalide', 'Entre la cote réelle donnée par ton bookmaker avant de confirmer.');
      return;
    }

    setPlacing(true);
    try {
      const now = new Date().toISOString();
      const bet: Bet = {
        id: `live-${proposal.id}`,
        version: 1,
        date: proposal.createdAt.slice(0, 10),
        creneau_utc: proposal.createdAt,
        creneau_display: new Date(proposal.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        league: proposal.legs.length === 1 ? proposal.legs[0].league : 'Combo en direct',
        legs: proposal.legs.map((leg, index) => ({
          id: `live-${proposal.id}-${index}`,
          match: `${leg.homeTeam} - ${leg.awayTeam}`,
          kickoff_utc: proposal.createdAt,
          league: leg.league,
          market: LIVE_MARKET_TO_BET_MARKET[leg.market],
          selection: leg.selection,
          odds: null,
          oddsSource: 'estimated',
          estimated_prob: leg.prob,
          is_void: false,
          result: 'pending',
        })),
        odds,
        stake,
        excluded_from_pnl: false,
        status: 'pending',
        played: true,
        confiance: Math.round(proposal.combinedProb * 100),
        confidence_level: proposal.combinedProb >= 0.7 ? 'Élevé' : proposal.combinedProb >= 0.55 ? 'Moyen' : 'Faible',
        analysis: `${proposal.window} — ${proposal.legs.map((l) => `${l.selection} (${Math.round(l.prob * 100)}%)`).join(' + ')}`,
        validation_flags: [],
        createdAt: now,
        updatedAt: now,
      };
      await saveBet(bet);
      setPlacedBetIds((prev) => new Set(prev).add(bet.id));
      setPlacingId(null);
      setStakeInput('');
      setOddsInput('');
      Alert.alert('Pari placé', `Enregistré dans le Bilan P&L : cote ${odds}, mise ${stake}. Réglé automatiquement à la fin du match.`);
    } catch (error: any) {
      Alert.alert('Erreur', `Impossible d'enregistrer le pari : ${error.message}`);
    } finally {
      setPlacing(false);
    }
  };

  const handleConfirmPlaceBet = async (proposal: ProposedSlip) => {
    const stake = Number(stakeInput.replace(',', '.'));
    if (!Number.isFinite(stake) || stake <= 0) {
      Alert.alert('Mise invalide', 'Entre un montant de mise valide avant de confirmer.');
      return;
    }

    const odds = Number(oddsInput.replace(',', '.'));
    if (!Number.isFinite(odds) || odds <= 1) {
      Alert.alert('Cote invalide', 'Entre la cote réelle donnée par ton bookmaker avant de confirmer.');
      return;
    }

    setPlacing(true);
    try {
      const bet = {
        ...proposal.sourceBet,
        odds,
        stake,
        played: true,
        status: 'pending' as const,
        excluded_from_pnl: false,
        updatedAt: new Date().toISOString(),
      };
      await saveBet(bet);
      setPlacedBetIds((prev) => new Set(prev).add(bet.id));
      setPlacingId(null);
      setStakeInput('');
      setOddsInput('');
      Alert.alert('Pari placé', `Enregistré dans le Bilan P&L avec une cote de ${odds} et une mise de ${stake}.`);
    } catch (error: any) {
      Alert.alert('Erreur', `Impossible d'enregistrer le pari : ${error.message}`);
    } finally {
      setPlacing(false);
    }
  };

  /** Un pari en direct (simple ou combiné) avec son bouton "Placer". */
  const renderLiveProposal = (proposal: InPlayProposal) => {
    const played = placedBetIds.has(`live-${proposal.id}`);
    const status = proposalStatus[proposal.id] ?? 'pending';
    const minuteLabel = proposal.kind === 'minute60' ? '60e' : proposal.kind === 'halftime' ? 'Mi-temps' : '20e';
    const confidence = Math.round(proposal.combinedProb * 100);
    const first = proposal.legs[0];
    return (
      <View key={proposal.id} style={styles.liveBetRow}>
        <Text style={styles.liveBetTitle}>
          {minuteLabel} · {proposal.legs.length === 1 ? first.selection : `Combiné ${proposal.legs.length} matchs`} — {confidence}%
        </Text>
        {proposal.legs.length > 1 &&
          proposal.legs.map((leg, i) => (
            <Text key={i} style={styles.liveBetLeg}>
              • {leg.homeTeam} - {leg.awayTeam} : {leg.selection} ({Math.round(leg.prob * 100)}%)
            </Text>
          ))}
        <View style={styles.liveBetStatusRow}>
          <Text style={[styles.liveBetBadge, played ? styles.badgePlayed : styles.badgeNotPlayed]}>
            {played ? 'Joué' : 'Non joué'}
          </Text>
          <Text
            style={[
              styles.liveBetBadge,
              status === 'won' ? styles.badgeWon : status === 'lost' ? styles.badgeLost : styles.badgePending,
            ]}
          >
            {status === 'won' ? '✅ Réussi' : status === 'lost' ? '❌ Perdu' : '⏳ En cours'}
          </Text>
          {!played && status === 'pending' && placingId !== `live-${proposal.id}` && (
            <TouchableOpacity
              style={styles.liveBetPlaceButton}
              onPress={() => {
                setOddsInput('');
                setPlacingId(`live-${proposal.id}`);
              }}
            >
              <Text style={styles.placeBetButtonText}>Placer</Text>
            </TouchableOpacity>
          )}
        </View>
        {placingId === `live-${proposal.id}` && (
          <View style={styles.placeStakeRow}>
            <TextInput
              style={styles.stakeInput}
              value={oddsInput}
              onChangeText={setOddsInput}
              placeholder="Cote réelle"
              placeholderTextColor="#64748b"
              keyboardType="decimal-pad"
              autoFocus
            />
            <TextInput
              style={styles.stakeInput}
              value={stakeInput}
              onChangeText={setStakeInput}
              placeholder="Mise (ex: 10)"
              placeholderTextColor="#64748b"
              keyboardType="decimal-pad"
            />
            <TouchableOpacity
              style={styles.confirmStakeButton}
              disabled={placing}
              onPress={() => handleConfirmPlaceLiveBet(proposal)}
            >
              {placing ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.confirmStakeText}>OK</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelStakeButton} onPress={() => { setPlacingId(null); setStakeInput(''); setOddsInput(''); }}>
              <Ionicons name="close" size={16} color="#94a3b8" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  /** Paris en direct rattachés à un créneau : au moins une jambe sur un de ses matchs. */
  const liveProposalsForSlot = (slot: DailyScheduleSlot) =>
    inPlayProposals.filter((p) =>
      p.legs.some((leg) =>
        slot.matches.some(
          (m) =>
            namesLikelyMatch(normalizeTeamName(leg.homeTeam), normalizeTeamName(m.homeTeam)) &&
            namesLikelyMatch(normalizeTeamName(leg.awayTeam), normalizeTeamName(m.awayTeam))
        )
      )
    );

  const renderSlot = (slot: DailyScheduleSlot) => {
    const isSelected = selectedSlot === slot.slotId;
    const slotLive = liveProposalsForSlot(slot);
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

        {slotLive.length > 0 && !isSelected && (
          <TouchableOpacity onPress={() => setSelectedSlot(slot.slotId)}>
            <Text style={styles.slotLiveSummary}>
              ⚡ {slotLive.length} pari{slotLive.length > 1 ? 's' : ''} en direct
              {(() => {
                const won = slotLive.filter((p) => proposalStatus[p.id] === 'won').length;
                const lost = slotLive.filter((p) => proposalStatus[p.id] === 'lost').length;
                const pending = slotLive.length - won - lost;
                return ` · ${won} ✅ · ${lost} ❌ · ${pending} ⏳`;
              })()}
              {' '}— touche pour voir
            </Text>
          </TouchableOpacity>
        )}

        {slotLive.length > 0 && isSelected && (
          <View style={[styles.halftimeAlertsBox, styles.slotLiveBox]}>
            <View style={styles.halftimeAlertsHeader}>
              <Ionicons name="flash" size={18} color="#a78bfa" />
              <Text style={styles.halftimeAlertsTitle}>Paris en direct ({slotLive.length})</Text>
            </View>
            {slotLive.map(renderLiveProposal)}
          </View>
        )}

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

                    {(() => {
                      const hasEstimatedOdds = prop.legs.some((leg) => leg.oddsSource === 'estimated');
                      const legLines = prop.legs.map((leg) => {
                        const oddsPart = leg.oddsSource === 'market' && leg.odds
                          ? `cote ${leg.odds.toFixed(2)}`
                          : 'cote à compléter (pas de marché publié)';
                        return `• ${leg.match} — ${leg.selection} (${(leg.estimated_prob! * 100).toFixed(1)}% — ${oddsPart})`;
                      });

                      return (
                        <>
                          <Text style={styles.proposalTitle}>{prop.title}</Text>
                          <Text style={styles.proposalOdds}>
                            {hasEstimatedOdds
                              ? `Cote estimée : ${prop.totalOdds.toFixed(2)} (au moins une jambe sans cote de marché — ajuste avec la cote réelle de ton bookmaker)`
                              : `Cote : ${prop.totalOdds.toFixed(2)}`}
                          </Text>
                          <Text style={styles.proposalAnalysis}>{prop.analysis}</Text>

                          {/* Bloc sélectionnable en un seul Text : copiable directement (appui long) */}
                          <Text style={styles.legText} selectable>
                            {legLines.join('\n')}
                          </Text>
                        </>
                      );
                    })()}

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

                    {prop.validation.valid && (() => {
                      const alreadyPlaced = placedBetIds.has(prop.sourceBet.id);
                      const ready = isProposalReadyToPlace(prop);

                      if (alreadyPlaced) {
                        return (
                          <View style={styles.placedBadge}>
                            <Ionicons name="checkmark-done-circle" size={14} color="#10b981" />
                            <Text style={styles.placedBadgeText}>Pari placé — dans le Bilan P&L</Text>
                          </View>
                        );
                      }

                      if (!ready) {
                        return (
                          <Text style={styles.placeLockedText}>
                            🔒 Placement disponible à T-90, une fois les dernières compos/actus vérifiées.
                          </Text>
                        );
                      }

                      if (placingId === prop.id) {
                        return (
                          <View style={styles.placeStakeRow}>
                            <TextInput
                              style={styles.stakeInput}
                              value={oddsInput}
                              onChangeText={setOddsInput}
                              placeholder="Cote réelle"
                              placeholderTextColor="#64748b"
                              keyboardType="decimal-pad"
                              autoFocus
                            />
                            <TextInput
                              style={styles.stakeInput}
                              value={stakeInput}
                              onChangeText={setStakeInput}
                              placeholder="Mise (ex: 10)"
                              placeholderTextColor="#64748b"
                              keyboardType="decimal-pad"
                            />
                            <TouchableOpacity
                              style={styles.confirmStakeButton}
                              disabled={placing}
                              onPress={() => handleConfirmPlaceBet(prop)}
                            >
                              {placing ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.confirmStakeText}>OK</Text>}
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.cancelStakeButton} onPress={() => { setPlacingId(null); setStakeInput(''); setOddsInput(''); }}>
                              <Ionicons name="close" size={16} color="#94a3b8" />
                            </TouchableOpacity>
                          </View>
                        );
                      }

                      return (
                        <TouchableOpacity
                          style={styles.placeBetButton}
                          onPress={() => {
                            const hasEstimatedOdds = prop.legs.some((leg) => leg.oddsSource === 'estimated');
                            setOddsInput(hasEstimatedOdds ? '' : prop.totalOdds.toFixed(2));
                            setPlacingId(prop.id);
                          }}
                        >
                          <Ionicons name="checkmark-circle-outline" size={16} color="#ffffff" />
                          <Text style={styles.placeBetButtonText}>Placer ce pari</Text>
                        </TouchableOpacity>
                      );
                    })()}
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </View>
    );
  };

  const orphanLive = inPlayProposals.filter((p) => !(plan?.slots ?? []).some((slot) => liveProposalsForSlot(slot).includes(p)));

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

        <Text style={styles.infoLine}>
          ℹ️ Pronostics en direct (20e / 60e) dans chaque créneau
          {matchesMissingOdds > 0 ? ` · ${matchesMissingOdds} match${matchesMissingOdds > 1 ? 's' : ''} sans cotes (xG estimés par l'IA)` : ''}
        </Text>

        {orphanLive.length > 0 && (
          <View style={styles.halftimeAlertsBox}>
            <View style={styles.halftimeAlertsHeader}>
              <Ionicons name="flash" size={18} color="#a78bfa" />
              <Text style={styles.halftimeAlertsTitle}>Autres paris en direct ({orphanLive.length})</Text>
            </View>
            {orphanLive.map(renderLiveProposal)}
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
  placeLockedText: {
    marginTop: 10,
    fontSize: 11,
    color: '#64748b',
    fontStyle: 'italic',
  },
  placeBetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: '#10b981',
    borderRadius: 8,
    paddingVertical: 10,
  },
  placeBetButtonText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  placedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    paddingVertical: 8,
  },
  placedBadgeText: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '600',
  },
  placeStakeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  stakeInput: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#f8fafc',
    fontSize: 13,
  },
  confirmStakeButton: {
    backgroundColor: '#10b981',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  confirmStakeText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  cancelStakeButton: {
    padding: 8,
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
  liveBetRow: {
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(167, 139, 250, 0.2)',
  },
  liveBetTitle: { color: '#ede9fe', fontSize: 14, fontWeight: '600' },
  liveBetLeg: { color: '#c4b5fd', fontSize: 12, marginTop: 2 },
  liveBetStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  liveBetBadge: { fontSize: 12, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  badgePlayed: { backgroundColor: 'rgba(59,130,246,0.25)', color: '#bfdbfe' },
  badgeNotPlayed: { backgroundColor: 'rgba(100,116,139,0.25)', color: '#cbd5e1' },
  badgeWon: { backgroundColor: 'rgba(16,185,129,0.25)', color: '#6ee7b7' },
  badgeLost: { backgroundColor: 'rgba(239,68,68,0.25)', color: '#fca5a5' },
  badgePending: { backgroundColor: 'rgba(245,158,11,0.2)', color: '#fde68a' },
  liveBetPlaceButton: { backgroundColor: '#10b981', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8, marginLeft: 'auto' },
  slotLiveSummary: {
    color: '#c4b5fd',
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  slotLiveBox: {
    marginHorizontal: 12,
    marginBottom: 12,
  },
  infoLine: {
    color: '#94a3b8',
    fontSize: 12,
    marginBottom: 10,
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
  halftimeAlertWindow: {
    color: '#ddd6fe',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  halftimeAlertSelection: {
    color: '#c4b5fd',
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },
});
