// Écran de Gestion Avancée des API Multi-Sources
// Configure et teste toutes les sources de données, avec compteur de requêtes du jour

import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator, Alert, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getAPIConfig, saveAPIConfig, testAPIConnection, APIConfig,
  getAllRequestCounts, resetRequestCount
} from '../api/multiAPIManager';

const OMNIROUTE_CONFIG_KEY = '@omniroute_config';

interface PersistedOmnirouteConfig {
  endpoint: string;
  selectedModel: string;
  enabled: boolean;
}

interface APISourceMeta {
  id: keyof Omit<APIConfig, 'fallbackEnabled' | 'maxRetries'>;
  name: string;
  icon: string;
  color: string;
  desc: string;
  placeholder: string;
  testable: boolean;
}

const API_SOURCES: APISourceMeta[] = [
  {
    id: 'apiFootball', name: 'API-Football (RapidAPI)', icon: 'football', color: '#3b82f6',
    desc: 'Source principale • 100 req/jour gratuites', placeholder: 'x-rapidapi-key...', testable: true
  },
  {
    id: 'footballData', name: 'Football-Data.org', icon: 'trophy', color: '#10b981',
    desc: 'Gratuit 10 req/min • Top 5 ligues', placeholder: 'Votre token...', testable: true
  },
  {
    id: 'theOddsApi', name: 'TheOddsAPI', icon: 'trending-up', color: '#f59e0b',
    desc: 'Cotes temps réel • $30/mois', placeholder: 'Votre clé...', testable: true
  },
  {
    id: 'sportmonks', name: 'Sportmonks', icon: 'server', color: '#8b5cf6',
    desc: 'API complète pro • $40/mois', placeholder: 'Votre token...', testable: false
  },
  {
    id: 'sofaScore', name: 'SofaScore (secours)', icon: 'stats-chart', color: '#ec4899',
    desc: 'Scraping de secours, sans clé requise', placeholder: 'Non requis', testable: false
  }
];

export default function APIManagementScreen({ navigation }: any) {
  const [config, setConfig] = useState<APIConfig | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [omniroute, setOmniroute] = useState<PersistedOmnirouteConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [cfg, reqCounts, omniRaw] = await Promise.all([
        getAPIConfig(),
        getAllRequestCounts(),
        AsyncStorage.getItem(OMNIROUTE_CONFIG_KEY),
      ]);
      setConfig(cfg);
      setCounts(reqCounts);
      setOmniroute(omniRaw ? JSON.parse(omniRaw) : null);
    } catch {
      // conserve l'état précédent si la lecture échoue
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const unsubscribe = navigation.addListener('focus', loadAll);
    return unsubscribe;
  }, [navigation, loadAll]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await saveAPIConfig(config);
      Alert.alert('✅ Sauvegardé', 'Configuration API enregistrée. Elle sera utilisée par l\'onglet Données Foot.');
    } catch {
      Alert.alert('❌ Erreur', 'Sauvegarde échouée');
    }
    setSaving(false);
  };

  const handleTest = async (source: APISourceMeta) => {
    if (!config) return;
    setTesting(source.id);
    try {
      const ok = await testAPIConnection(source.id, config);
      Alert.alert(ok ? '✅ Connexion OK' : '⚠️ Échec', ok ? `${source.name} répond correctement.` : `Impossible de joindre ${source.name}. Vérifiez la clé.`);
    } catch (e: any) {
      Alert.alert('❌ Échec', e.message || `Impossible de joindre ${source.name}`);
    } finally {
      setTesting(null);
      const reqCounts = await getAllRequestCounts();
      setCounts(reqCounts);
    }
  };

  const handleResetCount = (source: APISourceMeta) => {
    Alert.alert(
      'Réinitialiser le compteur ?',
      `Remet à zéro le compteur de requêtes du jour pour ${source.name}.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Réinitialiser',
          style: 'destructive',
          onPress: async () => {
            await resetRequestCount(source.id);
            setCounts(await getAllRequestCounts());
          }
        }
      ]
    );
  };

  if (loading || !config) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator size="large" color="#3b82f6" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#f8fafc" />
        </TouchableOpacity>
        <Text style={styles.title}>🌐 Gestion des API</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.notice}>
          <Ionicons name="shield-checkmark" size={20} color="#60a5fa" />
          <Text style={styles.noticeText}>
            Clés stockées localement uniquement. Chiffrées sur Android. Jamais transmises à des tiers.
            Cette configuration alimente l'onglet "Données Foot".
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="flask" size={22} color="#3b82f6" />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.sourceName}>Omniroute (moteur IA de secours)</Text>
              <Text style={styles.sourceDesc}>
                Utilisé uniquement pour l'analyse Scouting IA, en secours si Gemini est absent ou échoue.
                Ne fournit jamais de données factuelles (calendriers, scores).
              </Text>
            </View>
          </View>

          <View style={styles.counterRow}>
            <View style={styles.counterLeft}>
              <Ionicons
                name={omniroute?.enabled && omniroute.endpoint ? 'checkmark-circle' : 'close-circle'}
                size={14}
                color={omniroute?.enabled && omniroute.endpoint ? '#10b981' : '#64748b'}
              />
              <Text style={styles.counterText}>
                {omniroute?.enabled && omniroute.endpoint
                  ? `Actif • ${omniroute.selectedModel || 'modèle par défaut'}`
                  : 'Non configuré / désactivé'}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.testBtn, { backgroundColor: '#3b82f6' }]}
            onPress={() => navigation.navigate('SettingsMain')}
          >
            <Ionicons name="settings-outline" size={16} color="#fff" />
            <Text style={styles.testBtnText}>Configurer dans Paramètres</Text>
          </TouchableOpacity>
        </View>

        {API_SOURCES.map((source) => {
          const count = counts[source.id] || 0;
          return (
            <View key={source.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name={source.icon as any} size={22} color={source.color} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.sourceName}>{source.name}</Text>
                  <Text style={styles.sourceDesc}>{source.desc}</Text>
                </View>
              </View>

              {source.id !== 'sofaScore' && (
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Clé / Token</Text>
                  <TextInput
                    style={styles.input}
                    value={config[source.id] as string}
                    onChangeText={(t) => setConfig({ ...config, [source.id]: t })}
                    placeholder={source.placeholder}
                    placeholderTextColor="#64748b"
                    secureTextEntry
                    autoCapitalize="none"
                  />
                </View>
              )}

              <View style={styles.counterRow}>
                <View style={styles.counterLeft}>
                  <Ionicons name="pulse-outline" size={14} color="#94a3b8" />
                  <Text style={styles.counterText}>{count} requête{count > 1 ? 's' : ''} aujourd'hui</Text>
                </View>
                <TouchableOpacity onPress={() => handleResetCount(source)} style={styles.counterResetBtn}>
                  <Ionicons name="refresh-outline" size={14} color="#64748b" />
                </TouchableOpacity>
              </View>

              {source.testable && (
                <TouchableOpacity
                  style={[styles.testBtn, { backgroundColor: source.color }, !config[source.id] && styles.testBtnDisabled]}
                  onPress={() => handleTest(source)}
                  disabled={testing === source.id || !config[source.id]}
                >
                  {testing === source.id
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <><Ionicons name="checkmark-circle" size={16} color="#fff" /><Text style={styles.testBtnText}>Tester</Text></>
                  }
                </TouchableOpacity>
              )}
            </View>
          );
        })}

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={saving}>
          {saving ? <ActivityIndicator color="#fff" />
            : <><Ionicons name="save" size={20} color="#fff" /><Text style={styles.saveBtnText}>Enregistrer</Text></>
          }
        </TouchableOpacity>

        <View style={styles.helpCard}>
          <Text style={styles.helpTitle}>📋 Guide rapide</Text>
          <Text style={styles.helpText}>
            • Config minimale : API-Football gratuite{'\n'}
            • Cotes temps réel : TheOddsAPI{'\n'}
            • Stats xG : API-Football Pro ($10/mois){'\n'}
            • Toutes les clés sont chiffrées sur le téléphone
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#334155' },
  title: { fontSize: 18, fontWeight: 'bold', color: '#f8fafc' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  notice: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(96,165,250,0.1)', borderRadius: 10, padding: 12, marginBottom: 16, gap: 10 },
  noticeText: { color: '#bfdbfe', fontSize: 12, flex: 1 },
  card: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#334155' },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
  sourceName: { fontSize: 15, fontWeight: 'bold', color: '#f8fafc' },
  sourceDesc: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  inputGroup: { marginBottom: 12 },
  label: { fontSize: 12, color: '#94a3b8', marginBottom: 6 },
  input: { backgroundColor: '#0f172a', borderRadius: 8, borderWidth: 1, borderColor: '#334155', padding: 12, color: '#f8fafc', fontSize: 14 },
  counterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#334155', marginBottom: 4 },
  counterLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  counterText: { color: '#94a3b8', fontSize: 12 },
  counterResetBtn: { padding: 6 },
  testBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 10, borderRadius: 8, marginTop: 4, gap: 6 },
  testBtnDisabled: { opacity: 0.4 },
  testBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  saveBtn: { backgroundColor: '#10b981', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 16, borderRadius: 12, gap: 10, marginBottom: 16 },
  saveBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  helpCard: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#334155' },
  helpTitle: { fontSize: 14, fontWeight: 'bold', color: '#f8fafc', marginBottom: 8 },
  helpText: { fontSize: 12, color: '#94a3b8', lineHeight: 20 }
});
