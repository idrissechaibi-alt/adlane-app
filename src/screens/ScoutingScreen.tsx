// Ecran Scouting & Analyse IA
// Liste des matches de la journee + rapport au clic

import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  RefreshControl
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { analyzeMatchWithOmniroute, DEFAULT_OMNIROUTE_CONFIG, AIAnalysisOutput } from '../core/omniroute';
import { HISTORICAL_LESSONS } from '../data/historical';
import { Bet, BetLeg } from '../types';

interface TodayMatch {
  id: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoff_utc: string;
  odds?: {
    home?: number;
    draw?: number;
    away?: number;
    btts_yes?: number;
  };
}

const MOCK_MATCHES: TodayMatch[] = [
  {
    id: 'm1',
    homeTeam: 'Real Madrid',
    awayTeam: 'Barcelona',
    league: 'La Liga',
    kickoff_utc: '2026-09-16T20:00:00Z',
    odds: { home: 2.10, draw: 3.40, away: 3.20, btts_yes: 1.65 }
  },
  {
    id: 'm2',
    homeTeam: 'PSG',
    awayTeam: 'Marseille',
    league: 'Ligue 1',
    kickoff_utc: '2026-09-16T21:00:00Z',
    odds: { home: 1.75, draw: 3.80, away: 4.50, btts_yes: 1.72 }
  },
  {
    id: 'm3',
    homeTeam: 'Bayern Munich',
    awayTeam: 'Borussia Dortmund',
    league: 'Bundesliga',
    kickoff_utc: '2026-09-16T18:30:00Z',
    odds: { home: 1.85, draw: 4.00, away: 3.80, btts_yes: 1.55 }
  }
];

export default function ScoutingScreen() {
  const [matches, setMatches] = useState<TodayMatch[]>(MOCK_MATCHES);
  const [selectedMatch, setSelectedMatch] = useState<TodayMatch | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AIAnalysisOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Charger les matches de la journee
  useEffect(() => {
    // Ici tu pourrais appeler une API pour obtenir les vrais matches
    setMatches(MOCK_MATCHES);
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    // Rafraichir les matches de la journee
    setMatches(MOCK_MATCHES);
    setRefreshing(false);
  };

  const handleViewReport = async (match: TodayMatch) => {
    setSelectedMatch(match);
    setLoading(true);
    try {
      const matchInput = {
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league,
        kickoff_utc: match.kickoff_utc,
        odds: match.odds,
        contextInfo: undefined
      };

      const result = await analyzeMatchWithOmniroute(
        matchInput,
        HISTORICAL_LESSONS,
        DEFAULT_OMNIROUTE_CONFIG
      );

      setAnalysisResult(result);
    } catch (error: any) {
      // Fallback analyse locale
      console.log('Mode fallback analyse locale');
      setAnalysisResult({
        match: `${match.homeTeam} - ${match.awayTeam}`,
        kickoff_utc: match.kickoff_utc,
        generalAnalysis: `Analyse statistique pour ${match.league}. Donnees en cours de traitement.`,
        markets: [],
        lessonsApplied: [],
        rawResponse: ''
      });
    } finally {
      setLoading(false);
    }
  };

  const resetSelection = () => {
    setSelectedMatch(null);
    setAnalysisResult(null);
  };

  if (selectedMatch && analysisResult) {
    // AFFICHAGE DU RAPPORT
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <TouchableOpacity onPress={resetSelection} style={styles.backButton}>
              <Ionicons name="arrow-back" size={24} color="#f8fafc" />
            </TouchableOpacity>
            <Text style={styles.title}>Rapport d'Analyse</Text>
          </View>

          <View style={styles.matchCard}>
            <Text style={styles.matchTitle}>{selectedMatch.homeTeam} vs {selectedMatch.awayTeam}</Text>
            <Text style={styles.matchLeague}>{selectedMatch.league}</Text>
            <Text style={styles.matchKickoff}>Kickoff: {selectedMatch.kickoff_utc}</Text>
          </View>

          <View style={styles.resultCard}>
            <View style={styles.resultHeader}>
              <Ionicons name="analytics" size={20} color="#10b981" />
              <Text style={styles.resultTitle}>Analyse</Text>
            </View>

            <Text style={styles.generalAnalysisText}>{analysisResult.generalAnalysis}</Text>

            {analysisResult.markets.length > 0 && (
              <>
                <Text style={styles.sectionSubTitle}>Marches analyses :</Text>
                {analysisResult.markets.map((m, idx) => (
                  <View key={idx} style={styles.marketBox}>
                    <View style={styles.marketTop}>
                      <Text style={styles.marketName}>[{m.market}] {m.selection}</Text>
                      <Text style={styles.marketProb}>{(m.estimated_prob * 100).toFixed(1)}%</Text>
                    </View>
                    <Text style={styles.marketReason}>{m.reasoning}</Text>
                    {m.confidence && (
                      <View style={[styles.confidenceBadge, { backgroundColor:
                        m.confidence === 'Élevé' ? '#10b981' :
                        m.confidence === 'Moyen' ? '#3b82f6' : '#f59e0b'
                      }]}>
                        <Text style={styles.confidenceText}>{m.confidence}</Text>
                      </View>
                    )}
                  </View>
                ))}
              </>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // AFFICHAGE DE LA LISTE DES MATCHES
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>Matches de la Journee</Text>
          <Text style={styles.subtitle}>Clique sur un match pour voir l'analyse</Text>
        </View>

        {matches.map((match) => (
          <TouchableOpacity
            key={match.id}
            style={styles.matchCard}
            onPress={() => handleViewReport(match)}
          >
            <View style={styles.matchHeader}>
              <Text style={styles.matchTitle}>{match.homeTeam} vs {match.awayTeam}</Text>
              <Ionicons name="chevron-forward" size={20} color="#60a5fa" />
            </View>
            <Text style={styles.matchLeague}>{match.league}</Text>
            <View style={styles.matchFooter}>
              <Text style={styles.matchKickoff}>
                <Ionicons name="time" size={14} color="#94a3b8" />
                {' '}{match.kickoff_utc}
              </Text>
              {match.odds && (
                <View style={styles.oddsRow}>
                  <Text style={styles.oddsText}>1: {match.odds.home?.toFixed(2)}</Text>
                  <Text style={styles.oddsText}>N: {match.odds.draw?.toFixed(2)}</Text>
                  <Text style={styles.oddsText}>2: {match.odds.away?.toFixed(2)}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        ))}

        <View style={styles.infoBox}>
          <Ionicons name="information-circle" size={20} color="#60a5fa" />
          <Text style={styles.infoText}>
            Pour ajouter des matches personnalisés, utilise l'écran Planning.
          </Text>
        </View>
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
    marginBottom: 16,
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
  matchCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  matchHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  matchTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#f8fafc',
    flex: 1,
  },
  matchLeague: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 8,
  },
  matchFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  matchKickoff: {
    fontSize: 11,
    color: '#64748b',
    flexDirection: 'row',
    alignItems: 'center',
  },
  oddsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  oddsText: {
    fontSize: 11,
    color: '#60a5fa',
    fontWeight: '600',
  },
  backButton: {
    position: 'absolute',
    left: 0,
    top: 0,
    padding: 8,
  },
  resultCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  resultTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#f1f5f9',
  },
  generalAnalysisText: {
    fontSize: 14,
    color: '#cbd5e1',
    lineHeight: 20,
    marginBottom: 16,
  },
  sectionSubTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94a3b8',
    marginBottom: 10,
  },
  marketBox: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  marketTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  marketName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#f8fafc',
    flex: 1,
  },
  marketProb: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#10b981',
  },
  marketReason: {
    fontSize: 11,
    color: '#94a3b8',
    marginBottom: 8,
  },
  confidenceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  confidenceText: {
    fontSize: 10,
    color: '#ffffff',
    fontWeight: '600',
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(96, 165, 250, 0.1)',
    padding: 12,
    borderRadius: 8,
    gap: 10,
    marginTop: 16,
  },
  infoText: {
    fontSize: 12,
    color: '#94a3b8',
    flex: 1,
  },
});
