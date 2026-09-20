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
import { fetchGoogleSearchContext } from '../core/gemini';
import { recordScoutingAnalysis, reconcileScoutingAnalysisNow } from '../core/scoutingReview';
import { ScoutingRecord } from '../core/learnStore';
import { fetchMatchContext, PerplexitySearchResult } from '../core/perplexity';
import { getAgentLearningDigest } from '../core/autoLearn';
import { getFocusNoteByTeams, renderFocusNote } from '../core/focusEnrichment';
import { getHistoricalPriors } from '../core/footballDataCoUk';
import { getSecondOpinion } from '../core/eloRatings';
import { fetchLiveFixtures } from '../core/halftimeMonitor';
import { normalizeTeamName, namesLikelyMatch } from '../core/teamNameMatch';
import { getAPIConfig, getQuotaUsage, incrementRequestCount } from '../api/multiAPIManager';
import { HISTORICAL_LESSONS } from '../data/historical';
import { getDailyPlan } from '../core/scheduler';
import { ScheduledMatchDetail } from '../types/database';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const GEMINI_KEY_STORAGE = 'app-adlane.gemini-api-key';
// Même clé que celle utilisée par SettingsScreen pour sauvegarder la config Omniroute
const OMNIROUTE_CONFIG_KEY = '@omniroute_config';
// 90 min + mi-temps + arrêts de jeu, même marge que matchSettlement.ts/
// scoutingReview.ts : en dessous, un match encore en cours (juste absent du
// relevé live pour une raison quelconque) serait à tort traité comme terminé.
const MATCH_FINISHED_BUFFER_MS = 150 * 60 * 1000;

type Engine = 'gemini' | 'freeLLM' | 'omniroute' | 'aucun';

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
  const [calibrationOutcome, setCalibrationOutcome] = useState<ScoutingRecord['outcome'] | null>(null);
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
    setCalibrationOutcome(null);

    // Clé Gemini lue tôt : sert à la fois à la recherche Google (basique :
    // compos, horaires, confrontations précédentes) et à l'analyse structurée.
    const geminiApiKey = await SecureStore.getItemAsync(GEMINI_KEY_STORAGE);

    // Recherche web en direct : Google (via l'outil de recherche natif de
    // Gemini, gratuit avec le compte déjà lié) pour les infos basiques, et
    // Perplexity si une clé est configurée pour une recherche plus poussée.
    // Les deux sont interrogés en parallèle et leurs résultats fusionnés.
    let webContext = '';
    const combinedSources: PerplexitySearchResult[] = [];
    try {
      const apiConfig = await getAPIConfig();
      const perplexityQuota = apiConfig.perplexity ? await getQuotaUsage('perplexity', apiConfig) : null;
      const perplexityAvailable = Boolean(apiConfig.perplexity) && (!perplexityQuota || perplexityQuota.used < perplexityQuota.limit);

      const [googleResult, perplexityResult] = await Promise.allSettled([
        geminiApiKey
          ? fetchGoogleSearchContext(match.homeTeam, match.awayTeam, geminiApiKey)
          : Promise.resolve(null),
        perplexityAvailable
          ? fetchMatchContext(match.homeTeam, match.awayTeam, apiConfig.perplexity).then((r) => {
              void incrementRequestCount('perplexity');
              return r;
            })
          : Promise.resolve(null)
      ]);

      const contextParts: string[] = [];

      if (googleResult.status === 'fulfilled' && googleResult.value?.contextText) {
        contextParts.push(`Recherche Google (Gemini) :\n${googleResult.value.contextText}`);
        combinedSources.push(...googleResult.value.sources.map((s) => ({
          title: s.title, url: s.url, snippet: '', date: null
        })));
      }

      if (perplexityResult.status === 'fulfilled' && perplexityResult.value?.contextText) {
        contextParts.push(`Recherche Perplexity :\n${perplexityResult.value.contextText}`);
        combinedSources.push(...perplexityResult.value.sources);
      }

      webContext = contextParts.join('\n\n');
      setWebSources(combinedSources);
    } catch (error: any) {
      console.warn('Recherche web échouée:', error.message);
    }

    // Ce que la boucle d'auto-apprentissage a réellement observé en direct
    // (taux comptés, pas estimés) : injecté tel quel dans le prompt des agents.
    let learningDigest: string | null = null;
    try {
      learningDigest = getAgentLearningDigest();
    } catch (error: any) {
      console.warn('Digest auto-apprentissage indisponible:', error.message);
    }

    // Contexte qualitatif déjà collecté en fond (Gemini + Omniroute) sur ce
    // match, si c'est une ligue jouée (focusEnrichment.ts) — auparavant
    // récolté mais jamais réellement lu par aucun agent : gaspillé.
    let focusContext: string | null = null;
    try {
      focusContext = renderFocusNote(getFocusNoteByTeams(match.homeTeam, match.awayTeam));
    } catch (error: any) {
      console.warn('Contexte de fond (focusEnrichment) indisponible:', error.message);
    }

    // Priors pré-match (Football-Data.co.uk, item A) et second avis Elo
    // (item E) : deux sources gratuites, indépendantes du marché et de
    // Gemini/Omniroute. Étiquetées explicitement dans le prompt plutôt que
    // fondues dans les autres chiffres, pour que l'IA (et l'utilisateur) sache
    // d'où elles viennent. Silencieuses si la ligue/l'équipe n'est pas
    // couverte (5 grands championnats) — jamais d'estimation approximative.
    let priorsText = '';
    try {
      const [priors, eloOpinion] = await Promise.all([
        getHistoricalPriors(match.leagueId, match.homeTeam, match.awayTeam),
        getSecondOpinion(match.homeTeam, match.awayTeam),
      ]);

      const parts: string[] = [];
      if (priors) {
        parts.push(
          `Moyennes saison en cours (Football-Data.co.uk) — ${match.homeTeam} : ` +
          `${priors.home.cornersFor.toFixed(1)} corners/match, ${priors.home.cardsFor.toFixed(1)} cartons/match, ${priors.home.foulsFor.toFixed(1)} fautes/match ` +
          `(${priors.home.matchesPlayed} matchs) ; ${match.awayTeam} : ` +
          `${priors.away.cornersFor.toFixed(1)} corners/match, ${priors.away.cardsFor.toFixed(1)} cartons/match, ${priors.away.foulsFor.toFixed(1)} fautes/match ` +
          `(${priors.away.matchesPlayed} matchs)` +
          (priors.refereeCardAvg != null ? ` ; arbitre habituel : ${priors.refereeCardAvg.toFixed(1)} cartons/match en moyenne` : '')
        );
      }
      if (eloOpinion) {
        parts.push(
          `Second avis Elo (indépendant du marché, calculé sur les résultats réels) — ` +
          `1X2 estimé : ${match.homeTeam} ${(eloOpinion.home * 100).toFixed(0)}% / Nul ${(eloOpinion.draw * 100).toFixed(0)}% / ${match.awayTeam} ${(eloOpinion.away * 100).toFixed(0)}% ` +
          `(notes Elo : ${eloOpinion.ratingHome.toFixed(0)} vs ${eloOpinion.ratingAway.toFixed(0)}). ` +
          `Si cette estimation diverge fortement des cotes du marché, signale-le comme point de vigilance plutôt que de l'ignorer.`
        );
      }
      priorsText = parts.join('\n');
    } catch (error: any) {
      console.warn('Priors historiques/Elo indisponibles:', error.message);
    }

    // Match déjà en cours ? (règle explicite) Un seul appel qui couvre TOUS
    // les matchs en direct (fixtures?live=all), jamais un par match. En 1ère
    // mi-temps, les pronostics doivent porter sur la 1ère mi-temps
    // uniquement ; à la mi-temps ou en 2ème période (ou prolongations), sur
    // le RESTE du match (pas le match complet depuis le coup d'envoi, déjà
    // partiellement joué).
    //
    // Correspondance par nom d'équipe en 2 passes comme ailleurs dans l'app
    // (scheduler.ts) : l'égalité stricte échoue souvent hors Premier League
    // (noms officiels longs de football-data.org vs noms d'API-Football, qui
    // peuvent différer). Sans repli, la détection échouait silencieusement
    // et l'analyse tournait comme si le match n'avait pas commencé.
    let liveDirective = '';
    let liveStatusNote = 'match non détecté en direct (analyse standard)';
    let isFinishedMatch = false;
    try {
      const apiConfig = await getAPIConfig();
      if (!apiConfig.apiFootball) {
        liveStatusNote = 'vérification du direct impossible (clé API-Football manquante)';
      } else {
        const liveFixtures = await fetchLiveFixtures(apiConfig.apiFootball);
        const homeNorm = normalizeTeamName(match.homeTeam);
        const awayNorm = normalizeTeamName(match.awayTeam);
        const live = liveFixtures.find((f) => {
          const fHome = normalizeTeamName(f.homeTeam);
          const fAway = normalizeTeamName(f.awayTeam);
          return (fHome === homeNorm || namesLikelyMatch(fHome, homeNorm))
            && (fAway === awayNorm || namesLikelyMatch(fAway, awayNorm));
        });

        if (live) {
          // Score/statut = seule donnée injectée telle quelle (source
          // structurée API-Football, jamais contredite). Pour le RESTE —
          // cartons déjà donnés, blessures en cours de match, occasions
          // notables, changements tactiques, tournant du match — la
          // consigne demande explicitement à Omniroute d'aller les
          // chercher en direct avec ses outils de recherche/scraping
          // désormais configurés (Firecrawl/Jina/Tavily/TinyFish), plutôt
          // que de pronostiquer seulement à partir du score brut.
          const score = `${live.homeGoals}-${live.awayGoals}`;
          if (live.statusShort === '1H') {
            liveDirective = `⚠️ Ce match est ACTUELLEMENT EN DIRECT, en 1ère mi-temps (score actuel ${score} — donnée fiable, ne la remets pas en question). Utilise MAINTENANT tes outils de recherche/scraping pour trouver ce qui s'est passé depuis le coup d'envoi (cartons donnés, occasions notables, blessures, tournant du match, actualité en direct de ce match précis), puis donne les 10 marchés demandés en te basant sur cet état réel — ils doivent porter UNIQUEMENT sur ce qui peut encore se passer avant la pause, jamais sur le match complet depuis le coup d'envoi.`;
            liveStatusNote = `match en direct détecté — 1ère mi-temps (${score})`;
          } else if (['HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT'].includes(live.statusShort)) {
            const periodLabel = live.statusShort === 'HT' ? 'à la mi-temps' : 'en 2ème période ou plus';
            liveDirective = `⚠️ Ce match est ACTUELLEMENT EN DIRECT, ${periodLabel} (score actuel ${score} — donnée fiable, ne la remets pas en question). Utilise MAINTENANT tes outils de recherche/scraping pour trouver l'état réel du match à cet instant (cartons donnés, occasions notables, blessures, changements, tournant du match, actualité en direct de ce match précis), puis donne les 10 marchés demandés en te basant sur cet état réel — ils doivent porter sur le RESTE DU MATCH à partir de maintenant, jamais sur le match complet depuis le coup d'envoi (déjà partiellement joué).`;
            liveStatusNote = `match en direct détecté — ${periodLabel} (${score})`;
          } else {
            liveStatusNote = `match trouvé mais statut "${live.statusShort}" non géré (analyse standard)`;
          }
        } else if (Date.now() - new Date(match.kickoff_utc).getTime() > MATCH_FINISHED_BUFFER_MS) {
          // Match introuvable en direct ET son coup d'envoi remonte à plus de
          // 2h30 : très probablement déjà terminé. Demande explicite :
          // laisser Omniroute chercher le CONTEXTE (résumé, tournant du
          // match, forme du jour) via ses outils de recherche web
          // maintenant configurés — jamais lui demander de DEVINER le score
          // final lui-même, récupéré séparément via une source structurée
          // (football-data.org) juste après, pour ne jamais fausser la
          // calibration avec un chiffre halluciné.
          isFinishedMatch = true;
          liveDirective = `⚠️ Ce match est TERMINÉ (coup d'envoi ${new Date(match.kickoff_utc).toLocaleString('fr-FR')}). N'essaie PAS de deviner ou de vérifier toi-même le score final — il sera confronté séparément à une source structurée. Utilise plutôt tes outils de recherche web pour expliquer le CONTEXTE (résumé du match, tournant, décisions arbitrales, forme des équipes ce jour-là), et fournis quand même les 10 marchés comme une estimation A PRIORI (avant coup d'envoi), pour comparaison avec le résultat réel.`;
          liveStatusNote = 'match détecté comme terminé — analyse a priori + calibration immédiate';
        }
      }
    } catch (error: any) {
      liveStatusNote = `vérification du direct échouée (${error.message})`;
      console.warn('Statut live indisponible:', error.message);
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
      contextInfo: [
        liveDirective,
        match.context,
        webContext ? `Recherche web en direct :\n${webContext}` : '',
        priorsText ? `Données historiques & second avis (gratuites, indépendantes du marché) :\n${priorsText}` : '',
        learningDigest ? `Mémoire d'auto-apprentissage (marqueurs observés en direct) :\n${learningDigest}` : '',
        focusContext ? `Contexte déjà collecté en fond sur ce match (ligue jouée) :\n${focusContext}` : ''
      ]
        .filter(Boolean)
        .join('\n\n') || undefined
    };

    // Moteur d'analyse : Omniroute UNIQUEMENT (demande explicite) — Gemini
    // reste utilisé juste au-dessus pour la recherche web factuelle (gratuite,
    // sans lien avec ce choix), mais ne sert plus jamais à produire les 10
    // marchés eux-mêmes, ni le pool IA gratuit (Groq/OpenRouter/Cerebras).
    let omnirouteConfig: PersistedOmnirouteConfig | null = null;
    try {
      const raw = await AsyncStorage.getItem(OMNIROUTE_CONFIG_KEY);
      omnirouteConfig = raw ? JSON.parse(raw) : null;
    } catch {
      omnirouteConfig = null;
    }

    const omnirouteAvailable = Boolean(
      omnirouteConfig?.endpoint && omnirouteConfig.selectedModel?.trim()
    );

    if (!omnirouteAvailable) {
      setLoading(false);
      const message = "Omniroute non configuré. Renseigne un endpoint et au moins un agent dans Paramètres → Configuration Omniroute.";
      setAnalysisError(message);
      setDiagnostic({ engine: 'aucun', status: 'error', message, timestamp: new Date().toISOString() });
      return;
    }

    try {
      console.log('Utilisation de Omniroute...');
      const result = await analyzeMatchWithOmniroute(matchInput, HISTORICAL_LESSONS, {
        ...DEFAULT_OMNIROUTE_CONFIG,
        endpoint: omnirouteConfig!.endpoint,
        apiKey: omnirouteConfig!.apiKey,
        selectedModel: omnirouteConfig!.selectedModel || DEFAULT_OMNIROUTE_CONFIG.selectedModel,
      });
      setAnalysisResult(result);
      recordScoutingAnalysis(match, result, `omniroute:${result.agentsUsed?.[0] || 'inconnu'}`);
      const agentsNote = result.agentsUsed && result.agentsUsed.length > 0
        ? ` • ${result.agentsUsed.length} agent(s) : ${result.agentsUsed.join(', ')}${result.agentsFailed ? ` (${result.agentsFailed.length} échec(s))` : ''}`
        : '';

      // Match déjà terminé : règle IMMÉDIATEMENT contre le résultat réel
      // (source structurée, jamais la parole de l'agent) plutôt que
      // d'attendre le prochain passage de fond — demande explicite.
      let calibrationNote = '';
      if (isFinishedMatch) {
        try {
          const outcome = await reconcileScoutingAnalysisNow(match.id);
          setCalibrationOutcome(outcome);
          if (outcome) {
            const correct = outcome.settledLegs.filter((l) => l.correct).length;
            calibrationNote = ` • Calibration : ${correct}/${outcome.settledLegs.length} marché(s) réglable(s) correct(s), score réel ${outcome.goalsHome}-${outcome.goalsAway}.`;
          } else {
            calibrationNote = ' • Calibration impossible pour l\'instant (résultat pas encore disponible côté source structurée).';
          }
        } catch (error: any) {
          calibrationNote = ` • Calibration échouée (${error.message}).`;
        }
      }

      setDiagnostic({ engine: 'omniroute', status: 'success', message: `${result.markets.length} marché(s) reçu(s)${agentsNote} • ${liveStatusNote}${calibrationNote}`, timestamp: new Date().toISOString() });
    } catch (error: any) {
      const message = error?.message || 'Erreur inconnue';
      console.error('Omniroute a échoué:', message);
      setAnalysisError(message);
      setDiagnostic({ engine: 'omniroute', status: 'error', message, timestamp: new Date().toISOString() });
    } finally {
      setLoading(false);
    }
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
        onPress={() => { setSelectedMatch(null); setAnalysisResult(null); setAnalysisError(null); setDiagnostic(null); setWebSources([]); setCalibrationOutcome(null); }}
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
              Moteur : {diagnostic.engine === 'gemini' ? 'Google Gemini' : diagnostic.engine === 'freeLLM' ? 'Pool IA gratuit' : diagnostic.engine === 'omniroute' ? 'Omniroute' : 'Aucun'}
              {' • '}{new Date(diagnostic.timestamp).toLocaleTimeString('fr-FR')}
              {'\n'}{diagnostic.message}
            </Text>
          </View>
        )}

        {calibrationOutcome && (
          <View style={styles.calibrationBox}>
            <Text style={styles.sectionSubTitle}>
              Calibration vs réalité — score final {calibrationOutcome.goalsHome}-{calibrationOutcome.goalsAway}
            </Text>
            {calibrationOutcome.settledLegs.map((leg, idx) => (
              <View key={idx} style={styles.calibrationLegRow}>
                <Ionicons
                  name={leg.correct ? 'checkmark-circle' : 'close-circle'}
                  size={14}
                  color={leg.correct ? '#10b981' : '#ef4444'}
                />
                <Text style={styles.calibrationLegText}>
                  {leg.market} — {leg.selection} ({(leg.estimated_prob * 100).toFixed(0)}% annoncé)
                </Text>
              </View>
            ))}
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
  diagnosticBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#334155' },
  diagnosticText: { color: '#64748b', fontSize: 11, flex: 1 },
  calibrationBox: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#334155' },
  calibrationLegRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  calibrationLegText: { color: '#94a3b8', fontSize: 12, flex: 1 },
  webSourcesBox: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#334155' },
  webSourceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  webSourceText: { color: '#94a3b8', fontSize: 11, flex: 1 },
});
