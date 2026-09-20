// Écran de visualisation des données Football
// Affiche les matchs, cotes, et statistiques

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Image
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { FootballAPIManager, createFootballAPIManager } from '../api';
import { FootballMatch, MarketOdds } from '../api/types';
import { StandingEntry } from '../api/footballDataAPIs/ballDontLie';
import { getAPIConfig, incrementRequestCount } from '../api/multiAPIManager';
import { fetchCompetitionOdds, LEAGUE_ID_TO_ODDS_SPORT_KEY } from '../api/footballDataAPIs/theOddsAPI';
import { normalizeTeamName } from '../core/teamNameMatch';
import { EdgeCalculator, SurebetCalculator, ProbabilityCalculator } from '../calc/advancedCalculations';

/**
 * Heure de coup d'envoi lisible. Une source qui ne fournit pas de date
 * exploitable doit le dire, pas afficher "Invalid Date".
 */
function formatKickoff(kickoffUtc: string): string {
  if (!kickoffUtc) return 'Horaire inconnu';
  const date = new Date(kickoffUtc);
  if (Number.isNaN(date.getTime())) return 'Horaire inconnu';
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

type FormResult = 'V' | 'N' | 'D';

/** V/N/D d'une équipe pour un match terminé donné, vu de son côté (domicile ou extérieur). */
function resultFor(match: FootballMatch, teamId: string): FormResult | null {
  if (!match.scoreFulltime) return null;
  const isHome = String(match.homeTeamId) === teamId;
  const goalsFor = isHome ? match.scoreFulltime.home : match.scoreFulltime.away;
  const goalsAgainst = isHome ? match.scoreFulltime.away : match.scoreFulltime.home;
  if (goalsFor > goalsAgainst) return 'V';
  if (goalsFor < goalsAgainst) return 'D';
  return 'N';
}

export default function FootballDataScreen({ navigation }: any) {
  const [manager, setManager] = useState<FootballAPIManager | null>(null);
  const [fixtures, setFixtures] = useState<FootballMatch[]>([]);
  const [odds, setOdds] = useState<Record<string, MarketOdds[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedLeague, setSelectedLeague] = useState('39'); // Premier League par défaut
  const [error, setError] = useState<string | null>(null);
  const [hasConfiguredKeys, setHasConfiguredKeys] = useState(true);
  const [standings, setStandings] = useState<StandingEntry[]>([]);
  const [standingsError, setStandingsError] = useState<string | null>(null);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [teamForm, setTeamForm] = useState<Record<string, FormResult[]>>({});

  // Ligues disponibles — IDs API-Football réels (v3.football.api-sports.io).
  // "101" et "1" étaient utilisés ici pour Ligue 1 / Champions League : ce
  // sont en réalité d'AUTRES compétitions dans la numérotation API-Football
  // (61 et 2 sont les bons IDs, confirmés par footballDataCoUk.ts/eloRatings.ts
  // qui utilisent déjà "61" pour Ligue 1 ailleurs dans l'app) — ce qui faisait
  // remonter 0 ou les mauvais matchs pour ces deux boutons.
  const leagues = [
    { id: '39', name: 'Premier League', country: 'Angleterre', logo: 'https://media.api-sports.io/football/leagues/39.png' },
    { id: '140', name: 'La Liga', country: 'Espagne', logo: 'https://media.api-sports.io/football/leagues/140.png' },
    { id: '135', name: 'Serie A', country: 'Italie', logo: 'https://media.api-sports.io/football/leagues/135.png' },
    { id: '78', name: 'Bundesliga', country: 'Allemagne', logo: 'https://media.api-sports.io/football/leagues/78.png' },
    { id: '61', name: 'Ligue 1', country: 'France', logo: 'https://media.api-sports.io/football/leagues/61.png' },
    { id: '2', name: 'Champions League', country: 'Europe', logo: 'https://media.api-sports.io/football/leagues/2.png' },
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
      loadStandings(manager);
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

  /** Classement réel de la ligue sélectionnée (API-Football), affiché sous "Matchs du jour". */
  const loadStandings = async (mgr: FootballAPIManager) => {
    setStandingsLoading(true);
    setStandingsError(null);
    try {
      const result = await mgr.getStandings(selectedLeague);
      if (result.success && result.data) {
        setStandings(result.data);
      } else {
        setStandings([]);
        setStandingsError(result.error || 'Classement indisponible.');
      }
    } catch (err: any) {
      setStandings([]);
      setStandingsError(err.message || 'Classement indisponible.');
    } finally {
      setStandingsLoading(false);
    }
  };

  /**
   * 3 derniers résultats de chaque équipe présente dans les matchs du jour
   * (affichés sous son nom dans "Matchs du jour"). Une requête par équipe,
   * mais mise en cache côté ballDontLie.ts (30 min) : rechargement de
   * l'écran ou changement de ligue n'implique pas de nouveaux appels tant
   * que le cache est valide.
   */
  const loadTeamForm = async (mgr: FootballAPIManager, matches: FootballMatch[]) => {
    const teams = new Map<string, string>();
    matches.forEach((m) => {
      if (m.homeTeamId) teams.set(m.homeTeamId, m.homeTeam);
      if (m.awayTeamId) teams.set(m.awayTeamId, m.awayTeam);
    });
    if (teams.size === 0) return;

    const entries = await Promise.all(
      Array.from(teams.keys()).map(async (teamId) => {
        try {
          const result = await mgr.getTeamLastMatches(teamId, 3);
          if (!result.success || !result.data) return null;
          const form = result.data
            .map((m) => resultFor(m, teamId))
            .filter((r): r is FormResult => r !== null);
          return [teamId, form] as const;
        } catch {
          return null;
        }
      })
    );

    const map: Record<string, FormResult[]> = {};
    entries.forEach((entry) => {
      if (entry) map[entry[0]] = entry[1];
    });
    setTeamForm(map);
  };

  /**
   * Cotes de TOUS les matchs de la ligue en UNE requête.
   *
   * L'ancienne version bouclait match par match sur getMatchOdds, qui tombait
   * d'abord sur SofaScore (8 s de timeout chacun) puis sur un endpoint
   * TheOddsAPI paramétré pour le football américain : la page restait bloquée
   * des dizaines de secondes et aucune cote n'arrivait jamais.
   */
  const loadOddsForLeague = async (matches: FootballMatch[]) => {
    const sportKey = LEAGUE_ID_TO_ODDS_SPORT_KEY[selectedLeague];
    if (!sportKey) return;

    const config = await getAPIConfig();
    if (!config.theOddsApi) return;

    try {
      await incrementRequestCount('theOddsApi');
      const result = await fetchCompetitionOdds(config.theOddsApi, sportKey);
      if (!result.success || !result.data) return;

      const index = new Map(
        result.data.map((entry) => [
          `${normalizeTeamName(entry.homeTeam)}|${normalizeTeamName(entry.awayTeam)}`,
          entry,
        ])
      );

      const oddsMap: Record<string, MarketOdds[]> = {};
      for (const match of matches) {
        const found = index.get(
          `${normalizeTeamName(match.homeTeam)}|${normalizeTeamName(match.awayTeam)}`
        );
        if (!found) continue;

        const markets: MarketOdds[] = [];
        if (found.home != null || found.draw != null || found.away != null) {
          markets.push({
            market: '1X2',
            odds: { home: found.home, draw: found.draw, away: found.away },
            timestamp: new Date().toISOString(),
            source: 'theOddsAPI',
          });
        }
        if (found.over_2_5 != null || found.under_2_5 != null) {
          markets.push({
            market: 'OU_2_5',
            odds: { over: found.over_2_5, under: found.under_2_5, total: 2.5 },
            timestamp: new Date().toISOString(),
            source: 'theOddsAPI',
          });
        }
        if (markets.length > 0) oddsMap[match.id] = markets;
      }

      setOdds(oddsMap);
    } catch (error: any) {
      console.warn('[Données Foot] Cotes indisponibles:', error.message);
    }
  };

  const fetchFixtures = async (mgr: FootballAPIManager, forceRefresh = false) => {
    if (!forceRefresh && fixtures.length > 0 && !refreshing) return;

    setLoading(true);
    setError(null);

    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await mgr.getFixturesByDate(selectedLeague, today);

      if (result.success && result.data) {
        setFixtures(result.data);
        // Les cotes et les formes récentes arrivent après : on n'attend pas
        // qu'elles soient là pour rendre la liste de matchs exploitable.
        void loadOddsForLeague(result.data);
        void loadTeamForm(mgr, result.data);
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

  /** Rang au classement par nom d'équipe normalisé, pour l'afficher sous le nom dans les cartes de match. */
  const rankByTeam = React.useMemo(() => {
    const map = new Map<string, number>();
    standings.forEach((row) => map.set(normalizeTeamName(row.teamName), row.rank));
    return map;
  }, [standings]);

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
  /** Badges V/N/D (plus récent en dernier), ou rien si l'historique n'est pas encore chargé. */
  const renderForm = (form: FormResult[] | undefined) => {
    if (!form || form.length === 0) return null;
    return (
      <View style={styles.formRow}>
        {form.map((r, i) => (
          <View key={i} style={[styles.formBadge, styles[`formBadge${r}` as const]]}>
            <Text style={styles.formBadgeText}>{r}</Text>
          </View>
        ))}
      </View>
    );
  };

  const renderMatch = ({ item }: { item: FootballMatch }) => {
    const matchOdds = odds[item.id] || [];
    const homeOdds = matchOdds.find(o => o.market === '1X2')?.odds.home || '-';
    const drawOdds = matchOdds.find(o => o.market === '1X2')?.odds.draw || '-';
    const awayOdds = matchOdds.find(o => o.market === '1X2')?.odds.away || '-';
    const homeRank = rankByTeam.get(normalizeTeamName(item.homeTeam));
    const awayRank = rankByTeam.get(normalizeTeamName(item.awayTeam));

    return (
      <TouchableOpacity style={styles.matchCard} activeOpacity={0.7}>
        <View style={styles.matchHeader}>
          <Text style={styles.leagueName}>{item.leagueName}</Text>
          <Text style={styles.matchTime}>{formatKickoff(item.kickoff_utc)}</Text>
        </View>

        <View style={styles.matchTeams}>
          <View style={styles.teamContainer}>
            <Text style={styles.teamName}>{item.homeTeam}</Text>
            {homeRank != null && <Text style={styles.teamRank}>{homeRank}e au classement</Text>}
            {renderForm(item.homeTeamId ? teamForm[item.homeTeamId] : undefined)}
            <Text style={styles.teamOdds}>{homeOdds}</Text>
          </View>
          <Text style={styles.vs}>VS</Text>
          <View style={styles.teamContainer}>
            <Text style={styles.teamName}>{item.awayTeam}</Text>
            {awayRank != null && <Text style={styles.teamRank}>{awayRank}e au classement</Text>}
            {renderForm(item.awayTeamId ? teamForm[item.awayTeamId] : undefined)}
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

      {/* League Selector — icônes des compétitions plutôt que des rectangles de texte */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.leagueSelector}>
        {leagues.map(league => (
          <TouchableOpacity
            key={league.id}
            style={[
              styles.leagueIconButton,
              selectedLeague === league.id && styles.leagueIconButtonActive
            ]}
            onPress={() => setSelectedLeague(league.id)}
          >
            <Image source={{ uri: league.logo }} style={styles.leagueIcon} resizeMode="contain" />
            <Text style={[
              styles.leagueIconLabel,
              selectedLeague === league.id && styles.leagueIconLabelActive
            ]} numberOfLines={1}>
              {league.name}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/*
        Tout le reste défile dans UN SEUL ScrollView vertical (comme les
        autres écrans de l'app). Auparavant, la liste "Matchs du jour" était
        une FlatList posée directement dans la SafeAreaView sans conteneur
        défilant qui la borne : elle s'étirait pour occuper tout l'espace
        restant et masquait Value Bets/Surebets/Stats en dessous, donnant
        l'impression d'un panneau resté "ouvert" et impossible à réduire.
      */}
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
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

          {fixtures.map((item) => (
            <View key={item.id}>{renderMatch({ item })}</View>
          ))}

          {/* Classement réel de la ligue sélectionnée (API-Football) */}
          <View style={styles.standingsBox}>
            <Text style={styles.standingsTitle}>
              Classement — {leagues.find((l) => l.id === selectedLeague)?.name}
            </Text>

            {standingsLoading ? (
              <ActivityIndicator size="small" color="#3b82f6" style={{ marginVertical: 12 }} />
            ) : standingsError ? (
              <Text style={styles.standingsError}>{standingsError}</Text>
            ) : standings.length === 0 ? (
              <Text style={styles.standingsError}>Classement indisponible pour cette compétition.</Text>
            ) : (
              <View>
                <View style={styles.standingsHeaderRow}>
                  <Text style={[styles.standingsCell, styles.standingsRankCell, styles.standingsHeaderText]}>#</Text>
                  <Text style={[styles.standingsCell, styles.standingsTeamCell, styles.standingsHeaderText]}>Équipe</Text>
                  <Text style={[styles.standingsCell, styles.standingsHeaderText]}>J</Text>
                  <Text style={[styles.standingsCell, styles.standingsHeaderText]}>Diff</Text>
                  <Text style={[styles.standingsCell, styles.standingsHeaderText]}>Pts</Text>
                </View>
                {standings.map((row) => (
                  <View key={row.rank} style={styles.standingsRow}>
                    <Text style={[styles.standingsCell, styles.standingsRankCell]}>{row.rank}</Text>
                    <Text style={[styles.standingsCell, styles.standingsTeamCell]} numberOfLines={1}>{row.teamName}</Text>
                    <Text style={styles.standingsCell}>{row.played}</Text>
                    <Text style={styles.standingsCell}>{row.goalsDiff > 0 ? `+${row.goalsDiff}` : row.goalsDiff}</Text>
                    <Text style={[styles.standingsCell, styles.standingsPointsCell]}>{row.points}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>

        {/* Value Bets Section */}
        {valueBets.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Value Bets</Text>
              <Ionicons name="diamond" size={20} color="#fbbf24" />
            </View>

            {valueBets.slice(0, 5).map((item, index) => (
              <View key={`${item.match.id}-${index}`}>{renderValueBet({ item })}</View>
            ))}
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
      </ScrollView>
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
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
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
  leagueIconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 72,
    paddingVertical: 8,
    marginRight: 10,
    borderRadius: 12,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  leagueIconButtonActive: {
    backgroundColor: '#1d3a63',
    borderColor: '#3b82f6',
  },
  leagueIcon: {
    width: 32,
    height: 32,
    marginBottom: 4,
  },
  leagueIconLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
  },
  leagueIconLabelActive: {
    color: '#f8fafc',
  },
  standingsBox: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  standingsTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#f1f5f9',
    marginBottom: 10,
  },
  standingsError: {
    color: '#64748b',
    fontSize: 12,
    fontStyle: 'italic',
  },
  standingsHeaderRow: {
    flexDirection: 'row',
    paddingBottom: 8,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  standingsRow: {
    flexDirection: 'row',
    paddingVertical: 6,
  },
  standingsCell: {
    flex: 1,
    color: '#cbd5e1',
    fontSize: 12,
    textAlign: 'center',
  },
  standingsHeaderText: {
    color: '#64748b',
    fontWeight: '700',
    fontSize: 10,
    textTransform: 'uppercase',
  },
  standingsRankCell: {
    flex: 0.5,
    fontWeight: '700',
    color: '#f8fafc',
  },
  standingsTeamCell: {
    flex: 3,
    textAlign: 'left',
    color: '#f8fafc',
    fontWeight: '600',
  },
  standingsPointsCell: {
    fontWeight: '700',
    color: '#10b981',
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
  teamRank: {
    fontSize: 11,
    color: '#94a3b8',
    marginBottom: 4
  },
  formRow: {
    flexDirection: 'row',
    marginBottom: 6,
    gap: 3
  },
  formBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center'
  },
  formBadgeV: {
    backgroundColor: '#10b981'
  },
  formBadgeN: {
    backgroundColor: '#64748b'
  },
  formBadgeD: {
    backgroundColor: '#ef4444'
  },
  formBadgeText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: 'white'
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
