// Écran de visualisation des données Football
// Affiche les matchs, cotes, et statistiques

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  RefreshControl
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { FootballAPIManager, createFootballAPIManager } from '../api';
import { FootballMatch, MarketOdds } from '../api/types';
import { getAPIConfig } from '../api/multiAPIManager';
import { EdgeCalculator, SurebetCalculator, ProbabilityCalculator } from '../calc/advancedCalculations';

export default function FootballDataScreen({ navigation }: any) {
  const [manager, setManager] = useState<FootballAPIManager | null>(null);
  const [fixtures, setFixtures] = useState<FootballMatch[]>([]);
  const [odds, setOdds] = useState<Record<string, MarketOdds[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedLeague, setSelectedLeague] = useState('39'); // Premier League par défaut
  const [error, setError] = useState<string | null>(null);
  const [hasConfiguredKeys, setHasConfiguredKeys] = useState(true);

  // Ligue disponibles
  const leagues = [
    { id: '39', name: 'Premier League', country: 'Angleterre' },
    { id: '140', name: 'La Liga', country: 'Espagne' },
    { id: '135', name: 'Serie A', country: 'Italie' },
    { id: '78', name: 'Bundesliga', country: 'Allemagne' },
    { id: '101', name: 'Ligue 1', country: 'France' },
    { id: '1', name: 'Champions League', country: 'Europe' },
  ];

  useEffect(() => {
    // Initialiser le manager API
    const initManager = async () => {
      const config = await getAPIConfig();
      setHasConfiguredKeys(Boolean(config.apiFootball || config.footballData || config.theOddsApi));
      const manager = createFootballAPIManager({
        ballDontLie: config.apiFootball ? { apiKey: config.apiFootball, apiHost: 'v3.football.api-sports.io' } : undefined,
        footballData: config.footballData ? { apiKey: config.footballData } : undefined,
        theOddsAPI: config.theOddsApi ? { apiKey: config.theOddsApi } : undefined,
      });
      setManager(manager);
      fetchFixtures(manager);
    };

    initManager();
  }, [selectedLeague]);

  useEffect(() => {
    // Recharge la config quand l'utilisateur revient de "Gestion des API"
    const unsubscribe = navigation.addListener('focus', () => {
      getAPIConfig().then((config) => {
        setHasConfiguredKeys(Boolean(config.apiFootball || config.footballData || config.theOddsApi));
      });
    });
    return unsubscribe;
  }, [navigation]);

  const fetchFixtures = async (mgr: FootballAPIManager, forceRefresh = false) => {
    if (!forceRefresh && fixtures.length > 0 && !refreshing) return;

    setLoading(true);
    setError(null);

    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await mgr.getFixturesByDate(selectedLeague, today);

      if (result.success && result.data) {
        setFixtures(result.data);

        // Fetch les cotes pour chaque match
        const oddsMap: Record<string, MarketOdds[]> = {};
        for (const match of result.data) {
          const oddsResult = await mgr.getMatchOdds(match.id);
          if (oddsResult.success && oddsResult.data) {
            oddsMap[match.id] = oddsResult.data;
          }
        }
        setOdds(oddsMap);
      } else {
        setError(result.error || 'Erreur lors du chargement des matchs');
      }
    } catch (err: any) {
      setError(err.message || 'Erreur inconnue');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    if (manager) {
      await fetchFixtures(manager, true);
    }
  };

  // Calculer les value bets
  const valueBets = React.useMemo(() => {
    if (!manager) return [];

    const edgeCalc = new EdgeCalculator();
    const bets: any[] = [];

    fixtures.forEach(match => {
      const matchOdds = odds[match.id] || [];
      const valueBets = edgeCalc.findValueBets(match, matchOdds);
      bets.push(...valueBets);
    });

    return bets.sort((a, b) => b.edge - a.edge);
  }, [fixtures, odds, manager]);

  // Calculer les surebets
  const surebets = React.useMemo(() => {
    if (!manager) return [];

    const surebetCalc = new SurebetCalculator();
    const allSurebets: any[] = [];

    fixtures.forEach(match => {
      // Pour cette démo, on utilise les mêmes odds pour tous les bookmakers
      // Dans une app réelle, on aurait plusieurs sources
      const oddsByBookmaker = {
        bookmaker1: odds[match.id] || [],
        bookmaker2: odds[match.id] || []
      };
      const surebets = surebetCalc.findSurebets(match, oddsByBookmaker);
      allSurebets.push(...surebets);
    });

    return allSurebets;
  }, [fixtures, odds, manager]);

  // Afficher un match
  const renderMatch = ({ item }: { item: FootballMatch }) => {
    const matchOdds = odds[item.id] || [];
    const homeOdds = matchOdds.find(o => o.market === '1X2')?.odds.home || '-';
    const drawOdds = matchOdds.find(o => o.market === '1X2')?.odds.draw || '-';
    const awayOdds = matchOdds.find(o => o.market === '1X2')?.odds.away || '-';

    return (
      <TouchableOpacity style={styles.matchCard} activeOpacity={0.7}>
        <View style={styles.matchHeader}>
          <Text style={styles.leagueName}>{item.leagueName}</Text>
          <Text style={styles.matchTime}>
            {new Date(item.kickoff_utc).toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit'
            })}
          </Text>
        </View>

        <View style={styles.matchTeams}>
          <View style={styles.teamContainer}>
            <Text style={styles.teamName}>{item.homeTeam}</Text>
            <Text style={styles.teamOdds}>{homeOdds}</Text>
          </View>
          <Text style={styles.vs}>VS</Text>
          <View style={styles.teamContainer}>
            <Text style={styles.teamName}>{item.awayTeam}</Text>
            <Text style={styles.teamOdds}>{awayOdds}</Text>
          </View>
        </View>

        {matchOdds.length > 0 && (
          <View style={styles.oddsRow}>
            <View style={styles.oddsBox}>
              <Text style={styles.oddsLabel}>Nul</Text>
              <Text style={styles.oddsValue}>{drawOdds}</Text>
            </View>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Afficher un value bet
  const renderValueBet = ({ item }: { item: any }) => (
    <View style={[styles.valueBetCard, styles.valueBetHigh]}>
      <View style={styles.valueBetHeader}>
        <Text style={styles.valueBetTeam}>{item.match.homeTeam}</Text>
        <Text style={styles.valueBetLabel}>vs</Text>
        <Text style={styles.valueBetTeam}>{item.match.awayTeam}</Text>
      </View>
      <View style={styles.valueBetBody}>
        <Text style={styles.valueBetSelection}>{item.selection.toUpperCase()}</Text>
        <Text style={styles.valueBetOdds}>@{item.odds.toFixed(2)}</Text>
        <Text style={styles.valueBetEdge}>Edge: {(item.edge * 100).toFixed(1)}%</Text>
      </View>
    </View>
  );

  if (loading && fixtures.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Chargement des matchs...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Football Data</Text>
        <TouchableOpacity onPress={() => navigation.navigate('Paramètres', { screen: 'APIManagement' })}>
          <Ionicons name="settings-outline" size={24} color="white" />
        </TouchableOpacity>
      </View>

      {!hasConfiguredKeys && (
        <TouchableOpacity
          style={styles.noKeysBanner}
          onPress={() => navigation.navigate('Paramètres', { screen: 'APIManagement' })}
        >
          <Ionicons name="key-outline" size={18} color="#fbbf24" />
          <Text style={styles.noKeysBannerText}>
            Aucune clé API configurée. Touchez ici pour ajouter API-Football ou Football-Data.org dans "Gestion des API".
          </Text>
        </TouchableOpacity>
      )}

      {/* League Selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.leagueSelector}>
        {leagues.map(league => (
          <TouchableOpacity
            key={league.id}
            style={[
              styles.leagueButton,
              selectedLeague === league.id && styles.leagueButtonActive
            ]}
            onPress={() => setSelectedLeague(league.id)}
          >
            <Text style={[
              styles.leagueButtonText,
              selectedLeague === league.id && styles.leagueButtonTextActive
            ]}>
              {league.name}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Error Message */}
      {error && (
        <View style={styles.errorContainer}>
          <Ionicons name="alert-circle" size={20} color="#ef4444" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Match List */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Matchs du jour</Text>
          <Text style={styles.sectionCount}>{fixtures.length} matchs</Text>
        </View>

        <FlatList
          data={fixtures}
          renderItem={renderMatch}
          keyExtractor={item => item.id}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          contentContainerStyle={styles.matchList}
        />
      </View>

      {/* Value Bets Section */}
      {valueBets.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Value Bets</Text>
            <Ionicons name="diamond" size={20} color="#fbbf24" />
          </View>

          <FlatList
            data={valueBets.slice(0, 5)}
            renderItem={renderValueBet}
            keyExtractor={(item, index) => `${item.match.id}-${index}`}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.valueBetList}
          />
        </View>
      )}

      {/* Surebets Section */}
      {surebets.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Surebets</Text>
            <Ionicons name="shield-checkmark" size={20} color="#10b981" />
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {surebets.map((surebet, index) => (
              <View key={index} style={styles.surebetCard}>
                <Text style={styles.surebetProfit}>
                  {(surebet.profitPercentage).toFixed(2)}%
                </Text>
                <Text style={styles.surebetLabel}>Profit garanti</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Quick Stats */}
      <View style={styles.statsContainer}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{fixtures.filter(m => m.status === 'live').length}</Text>
          <Text style={styles.statLabel}>En direct</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{fixtures.filter(m => m.status === 'finished').length}</Text>
          <Text style={styles.statLabel}>Terminés</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{valueBets.length}</Text>
          <Text style={styles.statLabel}>Value Bets</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a'
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155'
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: 'white'
  },
  leagueSelector: {
    paddingVertical: 12,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155'
  },
  leagueButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginRight: 8,
    backgroundColor: '#334155',
    borderRadius: 20
  },
  leagueButtonActive: {
    backgroundColor: '#3b82f6'
  },
  leagueButtonText: {
    color: '#94a3b8',
    fontWeight: '600'
  },
  leagueButtonTextActive: {
    color: 'white'
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    margin: 16,
    backgroundColor: '#ef444420',
    borderRadius: 8
  },
  errorText: {
    marginLeft: 8,
    color: '#ef4444',
    fontWeight: '500'
  },
  noKeysBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#78350f40',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fbbf2440',
    gap: 8
  },
  noKeysBannerText: {
    flex: 1,
    color: '#fde68a',
    fontSize: 12,
    lineHeight: 17
  },
  section: {
    padding: 16
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: 'white'
  },
  sectionCount: {
    fontSize: 14,
    color: '#94a3b8'
  },
  matchList: {
    paddingBottom: 8
  },
  matchCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12
  },
  matchHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12
  },
  leagueName: {
    fontSize: 14,
    color: '#94a3b8',
    fontWeight: '500'
  },
  matchTime: {
    fontSize: 14,
    color: '#60a5fa'
  },
  matchTeams: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  teamContainer: {
    alignItems: 'center',
    flex: 1
  },
  teamName: {
    fontSize: 16,
    fontWeight: '600',
    color: 'white',
    marginBottom: 4
  },
  teamOdds: {
    fontSize: 14,
    color: '#10b981',
    fontWeight: 'bold'
  },
  vs: {
    fontSize: 14,
    color: '#64748b',
    marginHorizontal: 8
  },
  oddsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 12
  },
  oddsBox: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#334155',
    borderRadius: 8
  },
  oddsLabel: {
    fontSize: 12,
    color: '#94a3b8'
  },
  oddsValue: {
    fontSize: 16,
    color: '#eab308',
    fontWeight: 'bold'
  },
  loadingText: {
    marginTop: 20,
    color: '#94a3b8'
  },
  valueBetList: {
    paddingBottom: 8
  },
  valueBetCard: {
    backgroundColor: '#334155',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12
  },
  valueBetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  valueBetTeam: {
    fontSize: 16,
    fontWeight: '600',
    color: 'white'
  },
  valueBetLabel: {
    fontSize: 12,
    color: '#94a3b8'
  },
  valueBetBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  valueBetSelection: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#eab308'
  },
  valueBetOdds: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#10b981'
  },
  valueBetEdge: {
    fontSize: 12,
    color: '#3b82f6',
    fontWeight: '500'
  },
  valueBetHigh: {
    borderLeftWidth: 4,
    borderLeftColor: '#fbbf24'
  },
  surebetCard: {
    backgroundColor: '#10b98120',
    borderRadius: 8,
    padding: 12,
    marginRight: 12,
    minWidth: 100
  },
  surebetProfit: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#10b981'
  },
  surebetLabel: {
    fontSize: 12,
    color: '#10b981'
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: 16,
    backgroundColor: '#1e293b'
  },
  statBox: {
    alignItems: 'center'
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: 'white'
  },
  statLabel: {
    fontSize: 12,
    color: '#94a3b8'
  }
});
