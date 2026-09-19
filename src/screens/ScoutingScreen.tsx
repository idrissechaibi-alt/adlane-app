// Écran Scouting & Analyse IA
// Affiche la liste des matchs du jour. Cliquez sur un match pour lancer l'analyse IA.

import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  Alert,
  RefreshControl
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { analyzeMatchWithOmniroute, DEFAULT_OMNIROUTE_CONFIG, AIAnalysisOutput } from '../core/omniroute';
import { analyzeMatchWithGemini } from '../core/gemini';
import { fetchMatchContext, PerplexitySearchResult } from '../core/perplexity';
import { getAPIConfig } from '../api/multiAPIManager';
import { HISTORICAL_LESSONS } from '../data/historical';
import { getDailyPlan } from '../core/scheduler';
import { ScheduledMatchDetail } from '../types/database';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const GEMINI_KEY_STORAGE = 'app-adlane.gemini-api-key';
// Même clé que celle utilisée par SettingsScreen pour sauvegarder la config Omniroute
const OMNIROUTE_CONFIG_KEY = '@omniroute_config';

type Engine = 'gemini' | 'omniroute' | 'aucun';

interface PersistedOmnirouteConfig {
  endpoint: string;
  apiKey: string;
  selectedModel: string;
  enabled: boolean;
}

interface AIDiagnostic {
  engine: Engine;
  status: 'success' | 'error';
  message: string;
  timestamp: string;
}

export default function ScoutingScreen() {
  const [matches, setMatches] = useState<ScheduledMatchDetail[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<ScheduledMatchDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [planLoading, setPlanLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AIAnalysisOutput | null>(null);
  const [diagnostic, setDiagnostic] = useState<AIDiagnostic | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [webSources, setWebSources] = useState<PerplexitySearchResult[]>([]);

  // Formulaire (caché mais utilisé pour l'auto-remplissage/ajustement)
  const [oddsHome, setOddsHome] = useState('');
  const [oddsDraw, setOddsDraw] = useState('');
  const [oddsAway, setOddsAway] = useState('');
  const [oddsBTTS, setOddsBTTS] = useState('');
  const [contextInfo, setContextInfo] = useState('');

  useEffect(() => {
    void loadMatches();
  }, []);

  const loadMatches = async () => {
    try {
      const plan = await getDailyPlan();
      if (plan) {
        setMatches(plan.slots.flatMap(s => s.matches));
      }
    } catch (error) {
      console.error('Erreur chargement matchs scouting:', error);
    } finally {
      setPlanLoading(false);
      setRefreshing(false);
    }
  };

  const handleSelectMatch = (match: ScheduledMatchDetail) => {
    setSelectedMatch(match);
    setOddsHome(match.odds.home?.toString() || '');
    setOddsDraw(match.odds.draw?.toString() || '');
    setOddsAway(match.odds.away?.toString() || '');
    setOddsBTTS(match.odds.btts_yes?.toString() || '');
    setContextInfo(match.context || '');

    // Lancer l'analyse immédiatement
    void triggerAnalysis(match);
  };

  const triggerAnalysis = async (match: ScheduledMatchDetail) => {
    setLoading(true);
    setAnalysisResult(null);
    setAnalysisError(null);
    setWebSources([]);

    // Recherche web en direct (compositions probables, actualités/blessures)
    // via Perplexity si une clé est configurée, pour donner à l'IA de vraies
    // infos à jour plutôt que sa seule connaissance figée.
    let webContext = '';
    try {
      const apiConfig = await getAPIConfig();
      if (apiConfig.perplexity) {
        const { contextText, sources } = await fetchMatchContext(match.homeTeam, match.awayTeam, apiConfig.perplexity);
        webContext = contextText;
        setWebSources(sources);
      }
    } catch (error: any) {
      console.warn('Recherche web Perplexity échouée:', error.message);
    }

    const matchInput = {
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      league: match.leagueName,
      kickoff_utc: match.kickoff_utc,
      odds: {
        home: match.odds.home || undefined,
        draw: match.odds.draw || undefined,
        away: match.odds.away || undefined,
        btts_yes: match.odds.btts_yes || undefined,
      },
      contextInfo: [match.context, webContext ? `Recherche web en direct :\n${webContext}` : '']
        .filter(Boolean)
        .join('\n\n') || undefined
    };

    // Détermine le moteur IA à utiliser : Gemini (clé directe) en priorité,
    // sinon Omniroute si configuré ET activé dans Paramètres, sinon aucun.
    const geminiApiKey = await SecureStore.getItemAsync(GEMINI_KEY_STORAGE);
    let omnirouteConfig: PersistedOmnirouteConfig | null = null;
    try {
      const raw = await AsyncStorage.getItem(OMNIROUTE_CONFIG_KEY);
      omnirouteConfig = raw ? JSON.parse(raw) : null;
    } catch {
      omnirouteConfig = null;
    }

    const omnirouteAvailable = Boolean(omnirouteConfig?.enabled && omnirouteConfig.endpoint);

    if (!geminiApiKey && !omnirouteAvailable) {
      setLoading(false);
      const message = "Aucun moteur IA configuré. Renseignez une clé Google Gemini (Paramètres → Sauvegarde & IA) ou activez Omniroute (Paramètres → Configuration Omniroute).";
      setAnalysisError(message);
      setDiagnostic({ engine: 'aucun', status: 'error', message, timestamp: new Date().toISOString() });
      return;
    }

    // Cascade : Gemini d'abord si une clé est configurée, puis Omniroute en
    // dernier recours si Gemini est absent ou échoue (jamais l'inverse : on
    // ne remplace jamais une donnée factuelle par une invention de l'IA,
    // ceci reste une analyse probabiliste de scouting).
    let lastEngine: Engine = 'aucun';
    let lastMessage = '';

    if (geminiApiKey) {
      lastEngine = 'gemini';
      try {
        console.log('Utilisation de Gemini Direct...');
        const result = await analyzeMatchWithGemini(matchInput, HISTORICAL_LESSONS, geminiApiKey);
        setAnalysisResult(result);
        setDiagnostic({ engine: 'gemini', status: 'success', message: `${result.markets.length} marché(s) reçu(s).`, timestamp: new Date().toISOString() });
        setLoading(false);
        return;
      } catch (error: any) {
        lastMessage = error?.message || 'Erreur inconnue';
        console.warn('Gemini a échoué, tentative Omniroute si disponible:', lastMessage);
      }
    }

    if (omnirouteAvailable) {
      lastEngine = 'omniroute';
      try {
        console.log('Utilisation de Omniroute...');
        const result = await analyzeMatchWithOmniroute(matchInput, HISTORICAL_LESSONS, {
          ...DEFAULT_OMNIROUTE_CONFIG,
          endpoint: omnirouteConfig!.endpoint,
          apiKey: omnirouteConfig!.apiKey,
          selectedModel: omnirouteConfig!.selectedModel || DEFAULT_OMNIROUTE_CONFIG.selectedModel,
        });
        setAnalysisResult(result);
        setDiagnostic({ engine: 'omniroute', status: 'success', message: `${result.markets.length} marché(s) reçu(s)${geminiApiKey ? ' (via secours Omniroute)' : ''}.`, timestamp: new Date().toISOString() });
        setLoading(false);
        return;
      } catch (error: any) {
        lastMessage = error?.message || 'Erreur inconnue';
        console.error('Omniroute a également échoué:', lastMessage);
      }
    }

    console.error(`Erreur analyse IA (${lastEngine}):`, lastMessage);
    setAnalysisError(lastMessage);
    setDiagnostic({ engine: lastEngine, status: 'error', message: lastMessage, timestamp: new Date().toISOString() });
    setLoading(false);
  };

  const renderMatchList = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Matchs du Jour (Scan Matinal)</Text>
      {matches.length > 0 ? (
        matches.map((m) => (
          <TouchableOpacity
            key={m.id}
            style={styles.matchItem}
            onPress={() => handleSelectMatch(m)}
          >
            <View style={styles.matchLeft}>
              <Text style={styles.flag}>{m.flag}</Text>
              <View>
                <Text style={styles.teamsText}>{m.homeTeam} - {m.awayTeam}</Text>
                <Text style={styles.leagueText}>{m.leagueName} • {m.creneau_display}</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#475569" />
          </TouchableOpacity>
        ))
      ) : (
        <View style={styles.emptyContainer}>
          <Ionicons name="calendar-outline" size={40} color="#475569" />
          <Text style={styles.emptyText}>Aucun match détecté. Lancez le scan matinal dans l'onglet Planning.</Text>
        </View>
      )}
    </View>
  );

  const renderAnalysis = () => (
    <View>
      <TouchableOpacity
        style={styles.backButton}
        onPress={() => { setSelectedMatch(null); setAnalysisResult(null); setAnalysisError(null); setDiagnostic(null); setWebSources([]); }}
      >
        <Ionicons name="arrow-back" size={20} color="#3b82f6" />
        <Text style={styles.backButtonText}>Retour à la liste</Text>
      </TouchableOpacity>

      <View style={styles.resultCard}>
        <View style={styles.resultHeader}>
          <Ionicons name="sparkles" size={20} color="#10b981" />
          <Text style={styles.resultTitle}>Analyse : {selectedMatch?.homeTeam} vs {selectedMatch?.awayTeam}</Text>
        </View>

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text style={styles.loadingText}>L'IA Adlane analyse le match...</Text>
          </View>
        ) : analysisError ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={22} color="#ef4444" />
            <Text style={styles.errorTitle}>Analyse impossible</Text>
            <Text style={styles.errorMessage}>{analysisError}</Text>
            {selectedMatch && (
              <TouchableOpacity style={styles.retryButton} onPress={() => triggerAnalysis(selectedMatch)}>
                <Ionicons name="refresh" size={16} color="#ffffff" />
                <Text style={styles.retryButtonText}>Réessayer</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : analysisResult ? (
          <View>
            <Text style={styles.generalAnalysisText}>{analysisResult.generalAnalysis}</Text>

            <Text style={styles.sectionSubTitle}>Probabilités par Marché ({analysisResult.markets.length}) :</Text>
            {analysisResult.markets.map((m, idx) => (
              <View key={idx} style={styles.marketBox}>
                <View style={styles.marketTop}>
                  <Text style={styles.marketName}>[{m.market}] {m.selection}</Text>
                  <Text style={styles.marketProb}>{(m.estimated_prob * 100).toFixed(1)}%</Text>
                </View>
                <Text style={styles.marketReason}>{m.reasoning}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {webSources.length > 0 && (
          <View style={styles.webSourcesBox}>
            <Text style={styles.sectionSubTitle}>Sources web utilisées ({webSources.length}) :</Text>
            {webSources.map((s, idx) => (
              <View key={idx} style={styles.webSourceRow}>
                <Ionicons name="globe-outline" size={12} color="#14b8a6" />
                <Text style={styles.webSourceText} numberOfLines={2}>{s.title}</Text>
              </View>
            ))}
          </View>
        )}

        {diagnostic && (
          <View style={styles.diagnosticBox}>
            <Ionicons
              name={diagnostic.status === 'success' ? 'checkmark-circle' : 'close-circle'}
              size={14}
              color={diagnostic.status === 'success' ? '#10b981' : '#ef4444'}
            />
            <Text style={styles.diagnosticText}>
              Moteur : {diagnostic.engine === 'gemini' ? 'Google Gemini' : diagnostic.engine === 'omniroute' ? 'Omniroute' : 'Aucun'}
              {' • '}{new Date(diagnostic.timestamp).toLocaleTimeString('fr-FR')}
            </Text>
          </View>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadMatches(); }} tintColor="#3b82f6" />}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Scouting & Analyse IA</Text>
          <Text style={styles.subtitle}>Cliquez sur un match pour lancer l'analyse probabiliste</Text>
        </View>

        {selectedMatch ? renderAnalysis() : renderMatchList()}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  scrollContent: { padding: 16, paddingBottom: 40 },
  header: { marginBottom: 16 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f8fafc' },
  subtitle: { fontSize: 13, color: '#94a3b8', marginTop: 2 },
  card: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#334155' },
  cardTitle: { fontSize: 15, fontWeight: '600', color: '#f1f5f9', marginBottom: 12 },
  matchItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#334155' },
  matchLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flag: { fontSize: 20 },
  teamsText: { color: '#f8fafc', fontSize: 14, fontWeight: '600' },
  leagueText: { color: '#64748b', fontSize: 11, marginTop: 2 },
  emptyContainer: { alignItems: 'center', paddingVertical: 30 },
  emptyText: { color: '#64748b', fontSize: 13, textAlign: 'center', marginTop: 10, lineHeight: 18 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 },
  backButtonText: { color: '#3b82f6', fontWeight: '600', fontSize: 14 },
  resultCard: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#10b981' },
  resultHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  resultTitle: { fontSize: 15, fontWeight: 'bold', color: '#f1f5f9' },
  loadingBox: { paddingVertical: 40, alignItems: 'center', gap: 16 },
  loadingText: { color: '#94a3b8', fontSize: 14, fontStyle: 'italic' },
  generalAnalysisText: { fontSize: 13, color: '#cbd5e1', lineHeight: 20, marginBottom: 16 },
  sectionSubTitle: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 10, textTransform: 'uppercase' },
  marketBox: { backgroundColor: '#0f172a', borderRadius: 8, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  marketTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  marketName: { fontSize: 13, fontWeight: 'bold', color: '#f8fafc' },
  marketProb: { fontSize: 13, fontWeight: 'bold', color: '#10b981' },
  marketReason: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },
  errorBox: { alignItems: 'center', paddingVertical: 20, gap: 8 },
  errorTitle: { color: '#ef4444', fontSize: 14, fontWeight: 'bold' },
  errorMessage: { color: '#94a3b8', fontSize: 12, textAlign: 'center', lineHeight: 18, paddingHorizontal: 8 },
  retryButton: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#3b82f6', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 18, marginTop: 8 },
  retryButtonText: { color: '#ffffff', fontSize: 13, fontWeight: 'bold' },
  diagnosticBox: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#334155' },
  diagnosticText: { color: '#64748b', fontSize: 11 },
  webSourcesBox: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#334155' },
  webSourceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  webSourceText: { color: '#94a3b8', fontSize: 11, flex: 1 },
});
