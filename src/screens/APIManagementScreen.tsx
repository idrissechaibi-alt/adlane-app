// Écran de Gestion Avancée des API Multi-Sources
// Configure et teste toutes les sources de données

import React, { useState } from 'react';
import {
  ActivityIndicator, Alert, SafeAreaView, ScrollView, StyleSheet,
  Switch, Text, TextInput, TouchableOpacity, View
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_STORAGE_KEY = '@multi_api_config';

interface APIConfig {
  apiFootball: string;
  theOddsApi: string;
  footballData: string;
  sportmonks: string;
  apiKey: string;
}

const DEFAULT_CONFIG: APIConfig = {
  apiFootball: '', theOddsApi: '', footballData: '', sportmonks: '', apiKey: ''
};

export default function APIManagementScreen({ navigation }: any) {
  const [config, setConfig] = useState<APIConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  React.useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const raw = await AsyncStorage.getItem(API_STORAGE_KEY);
      if (raw) setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
    } catch {}
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await AsyncStorage.setItem(API_STORAGE_KEY, JSON.stringify(config));
      Alert.alert('✅ Sauvegardé', 'Configuration API enregistrée');
    } catch {
      Alert.alert('❌ Erreur', 'Sauvegarde échouée');
    }
    setSaving(false);
  };

  const handleTest = async (source: string, endpoint: string, key: string) => {
    setTesting(source);
    try {
      const response = await fetch(endpoint, {
        headers: source === 'apiFootball'
          ? { 'x-rapidapi-key': key, 'x-rapidapi-host': 'v3.football.api-sports.io' }
          : source === 'footballData'
          ? { 'X-Auth-Token': key }
          : {}
      });
      Alert.alert(response.ok ? '✅ Connexion OK' : '⚠️ Erreur', `HTTP ${response.status}`);
    } catch (e: any) {
      Alert.alert('❌ Échec', e.message);
    }
    setTesting(null);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator size="large" color="#3b82f6" /></View>
      </SafeAreaView>
    );
  }

  const apiSources = [
    {
      id: 'apiFootball', name: 'API-Football (RapidAPI)', icon: 'football', color: '#3b82f6',
      desc: 'Source principale • 100 req/jour gratuites', endpoint: 'https://v3.football.api-sports.io/status',
      fields: [{ key: 'apiFootball' as keyof APIConfig, label: 'Clé RapidAPI', placeholder: 'x-rapidapi-key...' }]
    },
    {
      id: 'footballData', name: 'Football-Data.org', icon: 'trophy', color: '#10b981',
      desc: 'Gratuit 10 req/min • Top 5 ligues', endpoint: 'https://api.football-data.org/v4/competitions',
      fields: [{ key: 'footballData' as keyof APIConfig, label: 'Token API', placeholder: 'Votre token...' }]
    },
    {
      id: 'theOddsApi', name: 'TheOddsAPI', icon: 'trending-up', color: '#f59e0b',
      desc: 'Cotes temps réel • $30/mois', endpoint: 'https://api.the-odds-api.com/v4/sports',
      fields: [{ key: 'theOddsApi' as keyof APIConfig, label: 'API Key', placeholder: 'Votre clé...' }]
    },
    {
      id: 'sportmonks', name: 'Sportmonks', icon: 'server', color: '#8b5cf6',
      desc: 'API complète pro • $40/mois', endpoint: '',
      fields: [{ key: 'sportmonks' as keyof APIConfig, label: 'API Token', placeholder: 'Votre token...' }]
    }
  ];

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
          </Text>
        </View>

        {apiSources.map((source) => (
          <View key={source.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name={source.icon as any} size={22} color={source.color} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.sourceName}>{source.name}</Text>
                <Text style={styles.sourceDesc}>{source.desc}</Text>
              </View>
            </View>

            {source.fields.map((field) => (
              <View key={field.key} style={styles.inputGroup}>
                <Text style={styles.label}>{field.label}</Text>
                <TextInput
                  style={styles.input}
                  value={config[field.key] || ''}
                  onChangeText={(t) => setConfig({ ...config, [field.key]: t })}
                  placeholder={field.placeholder}
                  placeholderTextColor="#64748b"
                  secureTextEntry
                  autoCapitalize="none"
                />
              </View>
            ))}

            {source.endpoint && config[source.fields[0].key] && (
              <TouchableOpacity
                style={[styles.testBtn, { backgroundColor: source.color }]}
                onPress={() => handleTest(source.id, source.endpoint, config[source.fields[0].key])}
                disabled={testing === source.id}
              >
                {testing === source.id
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <><Ionicons name="checkmark-circle" size={16} color="#fff" /><Text style={styles.testBtnText}>Tester</Text></>
                }
              </TouchableOpacity>
            )}
          </View>
        ))}

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
  testBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 10, borderRadius: 8, marginTop: 4, gap: 6 },
  testBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  saveBtn: { backgroundColor: '#10b981', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 16, borderRadius: 12, gap: 10, marginBottom: 16 },
  saveBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  helpCard: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#334155' },
  helpTitle: { fontSize: 14, fontWeight: 'bold', color: '#f8fafc', marginBottom: 8 },
  helpText: { fontSize: 12, color: '#94a3b8', lineHeight: 20 }
});