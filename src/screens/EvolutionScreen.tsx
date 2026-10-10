// Écran Rapports & Évolution IA
// Affiche la calibration des marchés, les leçons apprises, et génère les rapports quotidiens

import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
  Alert
} from 'react-native';
import { Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MarketTrendChart from '../components/MarketTrendChart';
import { MarketDayPoint, TRACKED_MARKETS, TrackedMarket, marketLabel, readInPlayProposals, readMarketSeries, readMarketSeriesReal, readMarketSeriesFictional, readPaperBets, readPredictionOutcomes } from '../core/learnStore';
import { getAllBets, getAllLessons, getAllCalibrations, getDailyReports } from '../database/storage';
import { computeMarketCalibrations } from '../core/calibration';
import { generateImprovementReport } from '../core/reporter';
import { MarketCalibration, Lesson, Bet, DailyReport } from '../types';
import { useIsFocused } from '@react-navigation/native';
import { runAutoLearnTick, AutoLearnTickDiagnostics, getNativeBackgroundTickStats, NativeBackgroundTickStats } from '../core/backgroundTasks';
import { sendTelegramMessage } from '../core/telegram';
import { loadOmnirouteConfig } from '../core/focusEnrichment';
import { getWebCapableRoutes } from '../core/llmRouter';
import { getHubStatus } from '../api/footballDataAPIs/liveDataHub';
import { ensureDeltaSamplesLoaded } from '../core/deltaLearning';
import { getRecentSearchSource, probeAnySearch } from '../core/webSearch';
import { getAgentLearningDigest, getAccuracyTrend, AccuracyTrend, buildMarketDayPointsFromPaperBets, buildLearningReport } from '../core/autoLearn';

export default function EvolutionScreen() {
  const isFocused = useIsFocused();
  const [calibrations, setCalibrations] = useState<MarketCalibration[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTab, setSelectedTab] = useState<'courbes' | 'calibration' | 'lessons' | 'report'>('courbes');
  const [marketSeries, setMarketSeries] = useState<MarketDayPoint[]>([]);
  /** Séries séparées réel/fictif — comparaison visuelle des deux pipelines
   * (voir learnStore.ts) ; marketSeries (combiné) reste utilisé uniquement
   * pour dater le dernier bilan effectué. */
  const [marketSeriesReal, setMarketSeriesReal] = useState<MarketDayPoint[]>([]);
  /** Taux d'erreur actuel + évolution vs hier — calculé sur les paris papier
   * (toujours fiable), pas sur les courbes par marché (qui dépendent du
   * règlement des scores finaux et peuvent rester vides plus longtemps). */
  const [accuracyTrend, setAccuracyTrend] = useState<AccuracyTrend | null>(null);
  const [marketSeriesFictional, setMarketSeriesFictional] = useState<MarketDayPoint[]>([]);
  /** Dérivée des paris papier déjà réglés (voir autoLearn.ts) — comble les
   * courbes (buts 1ère mi-temps/corners/cartons/fautes) avec un échantillon
   * déjà conséquent et fiable, sans attendre le système à checkpoints
   * (marketSeriesFictional) qui reste jeune après sa remise en état. Ne
   * remplace jamais un point déjà présent côté checkpoints, ne fait que
   * combler les dates manquantes (voir fictionalPointsFor plus bas). */
  const [paperBetDayPoints, setPaperBetDayPoints] = useState<MarketDayPoint[]>([]);
  const [paperBetsSummary, setPaperBetsSummary] = useState<{ total: number; settled: number; matches: number; won: number } | null>(null);
  const [dailyReports, setDailyReports] = useState<DailyReport[]>([]);
  /** Batterie de paris fictifs du scan 20e/60e minute (inPlayCombos.ts, real:false) — distincte de paperBetsSummary (règles apprises d'autoLearn.ts). */
  const [fictionalCounter, setFictionalCounter] = useState<{ matches: number; placed: number; won: number } | null>(null);
  const [forcingScan, setForcingScan] = useState(false);
  /** Fiabilité mesurée des pronos du scan 20e/60e — source distincte des paris
   * placés en base, que les cartes de calibration historiques lisent. */
  const [scanCalibration, setScanCalibration] = useState<
    Array<{ market: TrackedMarket; total: number; won: number; meanPredicted: number; hitRate: number }>
  >([]);

  /** Recharge les deux compteurs de la boucle fictive, sans toucher au reste
   * de l'écran — utilisé au focus ET après un lancement manuel du scan. */
  /** Modèles avec accès internet vérifié (llmRouter) : null = pas encore chargé. */
  const [webCapableModels, setWebCapableModels] = useState<string[] | null>(null);
  /** Fournisseurs dont l'API de recherche web (OmniRoute /v1/search) répond. */
  const [searchProviders, setSearchProviders] = useState<string[]>([]);

  const [liveSources, setLiveSources] = useState<Awaited<ReturnType<typeof getHubStatus>>>({});

  const refreshWebAccess = async () => {
    try {
      setLiveSources(await getHubStatus());
    } catch {
      /* statut SofaScore indisponible */
    }
    try {
      const config = await loadOmnirouteConfig();
      if (!config) {
        setWebCapableModels([]);
        setSearchProviders([]);
        return;
      }
      const source = (await getRecentSearchSource()) ?? (await probeAnySearch(config));
      setSearchProviders(source ? [source] : []);
      setWebCapableModels(await getWebCapableRoutes(config));
    } catch {
      setWebCapableModels([]);
    }
  };

  /** Voyant accès internet du pipe fictif : vert si au moins un modèle a
   * prouvé son accès au web, rouge sinon (le pipe fictif ne peut alors ni
   * relever les matchs en direct, ni régler ses paris). */
  const renderWebAccessIndicator = () => {
    if (webCapableModels == null) return null;
    const ok = webCapableModels.length > 0 || searchProviders.length > 0;
    const parts = [
      ...(searchProviders.length > 0 ? [`tous les modèles cherchent via ${searchProviders.join(', ')}`] : []),
      ...(webCapableModels.length > 0
        ? [`${webCapableModels.length} modèle${webCapableModels.length > 1 ? 's' : ''} qui cherche${webCapableModels.length > 1 ? 'nt' : ''} lui-même (${webCapableModels.slice(0, 3).map((m) => m.split(' · ').pop()).join(', ')}${webCapableModels.length > 3 ? '…' : ''})`]
        : []),
    ];
    const sourceNames = Object.keys(liveSources);
    const sourcesOk = sourceNames.filter((n) => liveSources[n].ok);
    const liveOk = sourcesOk.length > 0;
    return (
      <View>
        <View style={styles.webAccessRow}>
          <View style={[styles.webAccessDot, { backgroundColor: ok ? '#22c55e' : '#ef4444' }]} />
          <Text style={styles.webAccessText}>
            {ok
              ? `Accès internet : ${parts.join(' + ')}`
              : "Pas d'accès internet : aucune source de recherche ne répond (OmniRoute, Gemini, DuckDuckGo) et aucun modèle vérifié."}
          </Text>
        </View>
        <View style={styles.webAccessRow}>
          <View style={[styles.webAccessDot, { backgroundColor: liveOk ? '#22c55e' : '#ef4444' }]} />
          <Text style={styles.webAccessText}>
            {liveOk
              ? `Données live : ${sourcesOk.length}/${sourceNames.length} sources (${sourcesOk.map((n) => `${n} ${liveSources[n].count ?? 0}`).join(', ')})`
              : sourceNames.length === 0
                ? 'Données live : pas encore relevées (premier scan en attente)'
                : 'Données live injoignables : le pipe fictif utilise les fournisseurs IA'}
          </Text>
        </View>
      </View>
    );
  };

  const refreshLiveCounters = () => {
    void refreshWebAccess();
    try {
      const bets = readPaperBets();
      setPaperBetsSummary({
        total: bets.length,
        settled: bets.filter((b) => b.settled).length,
        matches: new Set(bets.map((b) => b.fixtureId)).size,
        won: bets.filter((b) => b.settled && b.won).length,
      });
      setPaperBetDayPoints(buildMarketDayPointsFromPaperBets(bets));
    } catch (error) {
      console.warn('Paris fictifs indisponibles:', error);
    }
    try {
      const byMarket = new Map<TrackedMarket, { total: number; won: number; predictedSum: number }>();
      for (const outcome of readPredictionOutcomes(30)) {
        const entry = byMarket.get(outcome.market) ?? { total: 0, won: 0, predictedSum: 0 };
        entry.total += 1;
        entry.predictedSum += outcome.predictedProb;
        if (outcome.won) entry.won += 1;
        byMarket.set(outcome.market, entry);
      }
      setScanCalibration(
        Array.from(byMarket.entries())
          .map(([market, e]) => ({
            market,
            total: e.total,
            won: e.won,
            meanPredicted: e.predictedSum / e.total,
            hitRate: e.won / e.total,
          }))
          .sort((a, b) => b.total - a.total)
      );
    } catch (error) {
      console.warn('Calibration du scan indisponible:', error);
    }
    try {
      const fictional = readInPlayProposals().filter((p) => p.real === false);
      setFictionalCounter({
        matches: new Set(fictional.map((p) => p.legs[0]?.fixtureId)).size,
        placed: fictional.length,
        won: fictional.filter((p) => p.legs[0]?.settled && p.legs[0]?.won).length,
      });
    } catch (error) {
      console.warn('Compteur de matchs fictifs indisponible:', error);
    }
  };

  useEffect(() => {
    if (isFocused) {
      void loadData();
      try {
        setMarketSeries(readMarketSeries());
        setMarketSeriesReal(readMarketSeriesReal());
        setMarketSeriesFictional(readMarketSeriesFictional());
      } catch (error) {
        console.warn('Série des marchés indisponible:', error);
      }
      try {
        setAccuracyTrend(getAccuracyTrend());
      } catch (error) {
        console.warn('Taux d\'erreur indisponible:', error);
      }
      refreshLiveCounters();
    }
  }, [isFocused]);

  /**
   * Résume en une phrase ce qui a bloqué le dernier pays interrogé, plutôt que
   * d'empiler une ligne par agent : ce qui compte, c'est de savoir S'IL FAUT
   * agir côté Omniroute (fournisseurs de recherche coupés, aucun agent
   * capable de naviguer) ou simplement attendre.
   */
  const summarizeTrace = (trace: { country: string; attempts: Array<{ model: string; outcome: string; detail: string }> }) => {
    const { country, attempts } = trace;
    if (attempts.length === 0) return `Dernier pays (${country}) : aucun agent interrogé.`;

    const errors = attempts.filter((a) => a.outcome === 'erreur');
    const blocked = errors.filter((a) => /circuit breaker|503/i.test(a.detail));

    if (blocked.length > 0 && errors.length === attempts.length) {
      const providers = Array.from(new Set(blocked.map((a) => a.model.split('/')[0]))).join(', ');
      return (
        `Dernier pays (${country}) : AUCUN agent de recherche disponible — ${providers} renvoient ` +
        `"circuit breaker open" côté Omniroute (clés de provider à vérifier). Les agents sans accès web ` +
        `ne peuvent pas lire un calendrier.`
      );
    }

    const searched = attempts.filter((a) => a.outcome !== 'erreur');
    if (searched.length > 0 && attempts.every((a) => a.outcome !== 'exploitable')) {
      return (
        `Dernier pays (${country}) : ${searched.length} agent(s) ont répondu sans calendrier exploitable` +
        (blocked.length > 0 ? `, et ${blocked.length} agent(s) de recherche sont coupés (circuit breaker).` : '.')
      );
    }

    return `Dernier pays (${country}) : ${attempts[attempts.length - 1].model} → ${attempts[attempts.length - 1].outcome}.`;
  };

  /**
   * Même texte pour l'alerte à l'écran ET pour l'envoi Telegram (voir
   * handleForceScan) — un seul format à tenir à jour.
   *
   * Volontairement COURT (demande explicite : le message empilait un
   * diagnostic par sous-système et devenait illisible) — seulement les 3
   * chiffres qui comptent vraiment (en direct maintenant / à venir
   * aujourd'hui / déjà joués aujourd'hui) + le résultat du bilan de minuit.
   * Le détail technique (Omniroute, Sportmonks, tâche de fond...) ne
   * ressort QUE s'il y a un vrai problème à signaler.
   */
  const formatScanDiagnostics = (diag: AutoLearnTickDiagnostics, nativeTickStats: NativeBackgroundTickStats): string => {
    const playedToday = Math.max(0, diag.fictionalProgramSize - diag.fictionalMatchesAhead);

    const lines = [
      '🔍 Scan terminé',
      `📡 En direct maintenant : ${diag.liveFixturesFound} match(s) 5 grands championnats (API-Football), ` +
        `${diag.fictionalLiveFixturesFound ?? 0} ailleurs (fournisseurs IA)`,
      `🕐 À venir aujourd'hui : ${diag.fictionalMatchesAhead} match(s)`,
      `✅ Déjà joués aujourd'hui : ${playedToday} match(s)`,
      `📈 Bilan : ${diag.nightlyReviewPointsCreated ?? 0} point(s) de courbe mis à jour ce tour`,
    ];

    const problems: string[] = [];
    if (!diag.omnirouteConfigured) {
      problems.push('Omniroute non configuré (Paramètres → endpoint + agents).');
    }
    if (diag.apiFootballError) {
      problems.push(`API-Football (relevé live) : ${diag.apiFootballError}.`);
    }
    if (diag.fictionalSportmonksError) {
      problems.push(`Sportmonks (programme du jour) : ${diag.fictionalSportmonksError}.`);
    }
    if (diag.nightlyReviewError) {
      problems.push(`Bilan de minuit ÉCHOUÉ : ${diag.nightlyReviewError}.`);
    }
    if (!nativeTickStats.lastTickAt) {
      problems.push(
        "Tâche de fond native jamais réveillée — vérifie Paramètres Android → Batterie → cette app → 'Sans restriction'."
      );
    }
    if (diag.fictionalProgramSize === 0 && diag.fictionalLastTrace) {
      problems.push(summarizeTrace(diag.fictionalLastTrace));
    }

    if (problems.length > 0) {
      lines.push('', '⚠️ ' + problems.join(' '));
    }

    return lines.join('\n');
  };

  /**
   * Lance le tour complet (univers du jour, relevé live + étiquetage,
   * consolidation du modèle d'auto-apprentissage, scan 20e/60e minute) tout
   * de suite, sans attendre le prochain tick automatique (15 min en arrière-
   * plan). Réutilise runAutoLearnTick telle quelle : le relevé live essaie
   * d'abord API-Football, puis bascule sur Omniroute si le quota est épuisé
   * ou la clé absente (voir backgroundTasks.ts/fetchSharedLiveFixtures) — et
   * alimente au passage la même boucle d'auto-apprentissage (consolidation
   * du modèle, paris papier) que le scan automatique, pas un chemin à part.
   *
   * Le résultat part AUSSI sur Telegram (demande explicite) : le scan peut
   * prendre du temps (Omniroute, appels API), et attendre l'alerte à l'écran
   * n'est pas toujours possible — le même diagnostic arrive sur Telegram dès
   * que le tour se termine, que l'app soit encore ouverte ou non.
   */
  const handleForceScan = () => {
    if (forcingScan) return;
    setForcingScan(true);
    // Ne BLOQUE plus l'écran jusqu'à la fin : avec de vrais appels IA
    // (FreeLLMAPI) qui réussissent désormais au lieu d'échouer instantanément
    // comme avec l'ancien Omniroute, un tour complet peut prendre plusieurs
    // minutes — rester devant un bouton qui tourne tout ce temps donnait
    // l'impression que le scan était bloqué. On confirme le lancement tout de
    // suite et on laisse le tick continuer en tâche de fond ; le résultat
    // arrive sur Telegram dès qu'il est prêt, sans qu'il faille rester sur
    // cet écran. runAutoLearnTick() se protège lui-même contre un double
    // lancement (verrou interne), donc pas de risque à relancer entre-temps.
    Alert.alert(
      'Scan lancé',
      "Il tourne en arrière-plan — ça peut prendre plusieurs minutes avec de vrais appels IA. Le résultat arrivera sur Telegram, pas besoin d'attendre ici."
    );
    runAutoLearnTick()
      .then(async (diag) => {
        refreshLiveCounters();
        const nativeTickStats = await getNativeBackgroundTickStats();
        const message = formatScanDiagnostics(diag, nativeTickStats);
        await sendTelegramMessage(message);
      })
      .catch(async (error: any) => {
        const message = `❌ Scan forcé échoué : ${error?.message || 'erreur inconnue'}.`;
        await sendTelegramMessage(message);
      })
      .finally(() => setForcingScan(false));
  };

  /**
   * Envoie sur Telegram le rapport RÉDIGÉ (leçons tirées des ratés,
   * corrections appliquées) puis le détail chiffré (taux de base, marqueurs,
   * facteurs de recalibrage). Telegram plutôt qu'une Alert : trop long pour
   * tenir dans une boîte de dialogue.
   */
  const handleShowLearningDigest = async () => {
    await ensureDeltaSamplesLoaded().catch(() => undefined);
    const report = buildLearningReport();
    const digest = getAgentLearningDigest();
    if (!report && !digest) {
      Alert.alert(
        'Pas encore de leçons',
        "Aucun pari fictif réglé ni règle apprise pour l'instant. Réessaie après quelques tours de fond."
      );
      return;
    }
    let sent = true;
    if (report) sent = await sendTelegramMessage(report);
    if (sent && digest) sent = await sendTelegramMessage(`📊 Détail chiffré\n\n${digest}`);
    Alert.alert(
      sent ? '✅ Envoyé' : '⚠️ Telegram indisponible',
      sent
        ? "Vérifie ton chat Telegram : le rapport écrit des leçons et corrections, puis le détail chiffré, viennent d'y arriver."
        : "Le message n'est pas parti (Telegram non configuré ou injoignable). Vérifie Paramètres → Telegram."
    );
  };

  const loadData = async () => {
    try {
      const [dbBets, dbLessons, dbCalibrations, reports] = await Promise.all([
        getAllBets(),
        getAllLessons(),
        getAllCalibrations(),
        getDailyReports(30),
      ]);

      setBets(dbBets);
      setLessons(dbLessons);
      setDailyReports(reports);

      // Recalculer la calibration à partir des paris réglés
      const freshCalibrations = computeMarketCalibrations(dbBets);
      setCalibrations(freshCalibrations.length > 0 ? freshCalibrations : dbCalibrations);
    } catch (error) {
      console.error('Erreur chargement Evolution:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#3b82f6" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const renderCalibrationView = () => (
    <View>
      {renderWebAccessIndicator()}
      {fictionalCounter && (
        <View style={styles.liveCounterRow}>
          <Ionicons name="radio-button-on" size={10} color="#4ade80" />
          <Text style={styles.liveCounterText}>
            <Text style={styles.liveCounterNumber}>{fictionalCounter.matches}</Text> match{fictionalCounter.matches > 1 ? 's' : ''} traité{fictionalCounter.matches > 1 ? 's' : ''}
            {'  •  '}
            <Text style={styles.liveCounterNumber}>{fictionalCounter.placed}</Text> pari{fictionalCounter.placed > 1 ? 's' : ''} placé{fictionalCounter.placed > 1 ? 's' : ''}
            {'  •  '}
            <Text style={styles.liveCounterNumber}>{fictionalCounter.won}</Text> réussi{fictionalCounter.won > 1 ? 's' : ''}
          </Text>
          <TouchableOpacity
            style={styles.forceScanButton}
            onPress={handleForceScan}
            disabled={forcingScan}
          >
            {forcingScan ? (
              <ActivityIndicator size="small" color="#4ade80" />
            ) : (
              <>
                <Ionicons name="play-circle" size={18} color="#4ade80" />
                <Text style={styles.forceScanButtonText}>Forcer le scan</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.infoBox}>
        <Ionicons name="information-circle" size={16} color="#60a5fa" />
        <Text style={styles.infoText}>
          La boucle d'apprentissage compare la probabilité moyenne annoncée par l'IA au taux de réussite réel.
          Un écart de +15 points ou plus indique un biais (ex: BTTS annoncé à 65% mais réel 40%).
        </Text>
      </View>

      {/* Paris fictifs en arrière-plan (boucle live, distincte de la calibration
          ci-dessous qui porte sur les VRAIS paris réglés) : affiché ici aussi,
          c'est là que la plupart des gens le cherchent en premier. */}
      <View style={styles.paperBetsBox}>
        <Ionicons name="pulse" size={16} color="#a78bfa" />
        <Text style={styles.paperBetsText}>
          {paperBetsSummary && paperBetsSummary.total > 0 ? (
            <>
              <Text style={styles.paperBetsNumber}>{paperBetsSummary.total}</Text> paris du modèle à marqueurs (« au moins 1 corner
              dans les 10 prochaines minutes »…), <Text style={styles.paperBetsNumber}>{paperBetsSummary.settled}</Text> réglés,{' '}
              <Text style={styles.paperBetsNumber}>{paperBetsSummary.won}</Text> réussis, sur{' '}
              <Text style={styles.paperBetsNumber}>{paperBetsSummary.matches}</Text> match{paperBetsSummary.matches > 1 ? 's' : ''} —
              distincts des paris fictifs du scan 20e/60e comptés plus haut.
            </>
          ) : (
            "0 pari fictif pour l'instant. Cette boucle observe des matchs EN DIRECT (1ère mi-temps) et n'active une règle qu'après au moins 30 échantillons réels — jamais de valeur inventée pour combler l'attente. Ça demande du temps réel avec des matchs suivis en direct, pas juste une mise à jour de l'app."
          )}
        </Text>
      </View>

      {/* Pronos du scan 20e/60e minute : ils ne passent JAMAIS par la table
          des paris (ils ne sont pas "placés"), donc les cartes plus bas ne
          peuvent pas les refléter — d'où cette section, alimentée par les
          résultats réellement mesurés de chaque proposition. */}
      <Text style={styles.sectionTitle}>Pronos du scan 20e/60e minute</Text>
      {scanCalibration.length === 0 ? (
        <View style={styles.infoBox}>
          <Ionicons name="information-circle" size={16} color="#60a5fa" />
          <Text style={styles.infoText}>
            Aucune proposition encore réglée. Chaque prono du scan est confronté au score réel
            en fin de match, et vient nourrir cette mesure.
          </Text>
        </View>
      ) : (
        scanCalibration.map((cal) => {
          const delta = (cal.meanPredicted - cal.hitRate) * 100;
          const statusColor = cal.total < 5 ? '#64748b' : delta > 15 ? '#f59e0b' : '#10b981';
          const statusLabel = cal.total < 5 ? 'Échantillon faible' : delta > 15 ? 'Suspect' : 'Calibré';

          return (
            <View key={cal.market} style={styles.calibrationCard}>
              <View style={styles.calibrationHeader}>
                <Text style={styles.marketLabel}>{marketLabel(cal.market)}</Text>
                <View style={[styles.statusBadge, { borderColor: statusColor }]}>
                  <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                </View>
              </View>

              <View style={styles.calibrationStats}>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Prédictions</Text>
                  <Text style={styles.statValue}>{cal.total}</Text>
                  <Text style={styles.statSub}>{cal.won} gagnées</Text>
                </View>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Taux Prédit</Text>
                  <Text style={styles.statValue}>{(cal.meanPredicted * 100).toFixed(1)}%</Text>
                </View>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Taux Réel</Text>
                  <Text style={[styles.statValue, { color: statusColor }]}>{(cal.hitRate * 100).toFixed(1)}%</Text>
                </View>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Écart</Text>
                  <Text style={[styles.statValue, delta > 0 ? styles.negative : styles.positive]}>
                    {delta > 0 ? '+' : ''}{delta.toFixed(1)}
                  </Text>
                </View>
              </View>
            </View>
          );
        })
      )}

      <Text style={styles.sectionTitle}>Paris réellement placés</Text>
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

  const renderReportView = () => {
    if (dailyReports.length === 0) {
      return (
        <View style={styles.infoBox}>
          <Ionicons name="information-circle" size={16} color="#60a5fa" />
          <Text style={styles.infoText}>
            Aucun bilan quotidien pour l'instant. Il est généré automatiquement à la clôture de chaque
            journée (premier tour de fond après minuit), à partir des paris réellement placés ce jour-là.
          </Text>
        </View>
      );
    }

    // Le plus récent en premier (getDailyReports trie déjà createdAt DESC côté stockage).
    const sorted = [...dailyReports].sort((a, b) => b.date.localeCompare(a.date));

    return (
      <View>
        {sorted.map((report) => (
          <View key={report.date} style={styles.reportCard}>
            <View style={styles.reportHeader}>
              <Ionicons name="document-text" size={20} color="#10b981" />
              <Text style={styles.reportTitle}>Rapport Quotidien - {report.date}</Text>
            </View>

            <Text style={styles.reportContent}>{report.details}</Text>
          </View>
        ))}
      </View>
    );
  };

  /**
   * Série fictive affichée pour un marché : les points à checkpoints
   * (marketSeriesFictional, voir dailyReview.ts) en priorité, comblés par les
   * points dérivés des paris papier déjà réglés (buts 1ère mi-temps/corners/
   * cartons/fautes uniquement, voir buildMarketDayPointsFromPaperBets) sur
   * les dates où les checkpoints n'ont encore rien à montrer. Ne masque
   * jamais un point à checkpoints déjà présent : une fois ce système de
   * nouveau alimenté (voir le correctif du suivi en direct), c'est lui qui
   * prime, les paris papier ne servant plus qu'à combler les trous restants.
   */
  const fictionalPointsFor = (market: TrackedMarket): MarketDayPoint[] => {
    const checkpointPoints = marketSeriesFictional.filter((p) => p.market === market);
    const coveredDates = new Set(checkpointPoints.map((p) => p.date));
    const paperPoints = paperBetDayPoints.filter((p) => p.market === market && !coveredDates.has(p.date));
    return [...checkpointPoints, ...paperPoints].sort((a, b) => a.date.localeCompare(b.date));
  };

  const renderCurvesView = () => {
    const chartWidth = Dimensions.get('window').width - 32 - 24; // marges écran + carte
    const lastUpdate = marketSeries.length > 0
      ? marketSeries[marketSeries.length - 1].date
      : null;

    return (
      <View>
        {accuracyTrend ? (
          <View style={styles.accuracyTrendBox}>
            <View style={styles.accuracyTrendCol}>
              <Text style={styles.accuracyTrendValue}>{accuracyTrend.errorRatePercent.toFixed(1)}%</Text>
              <Text style={styles.accuracyTrendLabel}>Taux d'erreur actuel</Text>
            </View>
            <View style={styles.accuracyTrendDivider} />
            <View style={styles.accuracyTrendCol}>
              {accuracyTrend.evolutionVsYesterdayPoints != null ? (
                <Text
                  style={[
                    styles.accuracyTrendValue,
                    { color: accuracyTrend.evolutionVsYesterdayPoints >= 0 ? '#4ade80' : '#f87171' },
                  ]}
                >
                  {accuracyTrend.evolutionVsYesterdayPoints >= 0 ? '+' : ''}
                  {accuracyTrend.evolutionVsYesterdayPoints.toFixed(1)} pts
                </Text>
              ) : (
                <Text style={styles.accuracyTrendValueMuted}>—</Text>
              )}
              <Text style={styles.accuracyTrendLabel}>
                Évolution du taux de réussite vs hier
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.infoBox}>
            <Ionicons name="information-circle" size={16} color="#60a5fa" />
            <Text style={styles.infoText}>
              Pas encore assez de paris papier réglés pour calculer un taux d'erreur. Ça vient avec les
              premiers tours de fond.
            </Text>
          </View>
        )}

        {renderWebAccessIndicator()}
        {paperBetsSummary && paperBetsSummary.total > 0 && (
          <View style={styles.paperBetsBox}>
            <Ionicons name="pulse" size={16} color="#a78bfa" />
            <Text style={styles.paperBetsText}>
              <Text style={styles.paperBetsNumber}>{paperBetsSummary.total}</Text> paris du modèle à marqueurs (fenêtres de 10 et 25 min)
              {' '}(<Text style={styles.paperBetsNumber}>{paperBetsSummary.settled}</Text> réglés,{' '}
              <Text style={styles.paperBetsNumber}>{paperBetsSummary.won}</Text> réussis) sur{' '}
              <Text style={styles.paperBetsNumber}>{paperBetsSummary.matches}</Text> match{paperBetsSummary.matches > 1 ? 's' : ''} —
              ce qui est réglé alimente déjà les courbes buts 1ère mi-temps/corners/cartons/fautes ci-dessous.
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.learningDigestButton} onPress={handleShowLearningDigest}>
          <Ionicons name="bulb" size={16} color="#a78bfa" />
          <Text style={styles.learningDigestButtonText}>
            Rapport des leçons apprises et corrections (sur Telegram)
          </Text>
        </TouchableOpacity>

        <View style={styles.curvesIntro}>
          <Text style={styles.curvesIntroTitle}>Évolution de l'IA, marché par marché</Text>
          <Text style={styles.curvesIntroText}>
            Taux de réussite des prédictions réglées. Bleu = paris réels (bilan de minuit), violet =
            boucle d'auto-apprentissage (paris fictifs) — deux courbes séparées pour comparer leur
            progression. Le pointillé marque le seuil de 60%. Pour buts 1ère mi-temps/corners/cartons/
            fautes, la courbe violette inclut les paris papier réglés en direct (pas besoin d'attendre
            le bilan) ; pour 1X2/total de buts/BTTS, seul le bilan de minuit peut régler un point (score
            final requis). Chaque point compte uniquement les prédictions dont le résultat est connu.
            {lastUpdate ? ` Dernier bilan : ${lastUpdate}.` : ' Aucun bilan encore effectué.'}
          </Text>
        </View>

        {TRACKED_MARKETS.map((market) => (
          <MarketTrendChart
            key={market.key}
            label={market.label}
            width={chartWidth}
            points={marketSeriesReal.filter((p) => p.market === market.key)}
            fictionalPoints={fictionalPointsFor(market.key)}
          />
        ))}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Rapports & Évolution IA</Text>
        <Text style={styles.subtitle}>Calibration, leçons apprises, amélioration continue</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, selectedTab === 'courbes' && styles.activeTab]}
          onPress={() => setSelectedTab('courbes')}
        >
          <Ionicons
            name="trending-up"
            size={18}
            color={selectedTab === 'courbes' ? '#3b82f6' : '#64748b'}
          />
          <Text style={[styles.tabText, selectedTab === 'courbes' && styles.activeTabText]}>
            Courbes
          </Text>
        </TouchableOpacity>

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
        {selectedTab === 'courbes' && renderCurvesView()}
        {selectedTab === 'calibration' && renderCalibrationView()}
        {selectedTab === 'lessons' && renderLessonsView()}
        {selectedTab === 'report' && renderReportView()}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  curvesIntro: {
    backgroundColor: 'rgba(96, 165, 250, 0.08)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.25)',
    padding: 12,
    marginBottom: 12,
  },
  curvesIntroTitle: {
    color: '#bfdbfe',
    fontSize: 13,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  curvesIntroText: {
    color: '#94a3b8',
    fontSize: 11,
    lineHeight: 16,
  },
  liveCounterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  liveCounterText: {
    flex: 1,
    color: '#94a3b8',
    fontSize: 11,
  },
  liveCounterNumber: {
    fontWeight: 'bold',
    color: '#e2e8f0',
  },
  forceScanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(74, 222, 128, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.3)',
  },
  forceScanButtonText: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '600',
  },
  paperBetsBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(167, 139, 250, 0.08)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(167, 139, 250, 0.3)',
    padding: 12,
    marginBottom: 12,
  },
  accuracyTrendBox: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 14,
    marginBottom: 12,
  },
  accuracyTrendCol: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  accuracyTrendDivider: {
    width: 1,
    backgroundColor: '#334155',
  },
  accuracyTrendValue: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: 'bold',
  },
  accuracyTrendValueMuted: {
    color: '#64748b',
    fontSize: 22,
    fontWeight: 'bold',
  },
  accuracyTrendLabel: {
    color: '#94a3b8',
    fontSize: 11,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  webAccessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  webAccessDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  webAccessText: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 12,
  },
  learningDigestButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(167, 139, 250, 0.12)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(167, 139, 250, 0.35)',
    paddingVertical: 10,
    marginBottom: 12,
  },
  learningDigestButtonText: {
    color: '#ddd6fe',
    fontSize: 12,
    fontWeight: '600',
  },
  paperBetsText: {
    flex: 1,
    color: '#ddd6fe',
    fontSize: 12,
    lineHeight: 17,
  },
  paperBetsNumber: {
    fontWeight: 'bold',
    color: '#f8fafc',
  },
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
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
  sectionTitle: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: 'bold',
    marginTop: 8,
    marginBottom: 8,
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
