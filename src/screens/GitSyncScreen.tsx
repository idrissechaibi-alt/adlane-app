// 🔄 Écran Sauvegarde & Configuration API Adlane
// Optimisé pour Gemini Pro et Football-Data

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, SafeAreaView, ScrollView, StyleSheet,
  Switch, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import {
  getGitHubSyncConfig, getLastSyncTime, isGitHubTokenConfigured,
  saveGitHubSyncConfig, startAutoSync, syncDataToGitHub, syncDataFromGitHub,
  GitHubDataSyncConfig,
} from '../core/gitAutoSync';
import * as Updates from 'expo-updates';

const GEMINI_KEY_STORAGE = 'app-adlane.gemini-api-key';
const FOOTBALL_DATA_KEY = 'app-adlane.football-data-api-key';

export default function GitSyncScreen({ navigation }: any) {
  const [config, setConfig] = useState<GitHubDataSyncConfig | null>(null);
  const [token, setToken] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [footballKey, setFootballKey] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => { void loadAllData(); }, []);

  const loadAllData = async () => {
    try {
      const [storedConfig, syncTime, gKey, fKey] = await Promise.all([
        getGitHubSyncConfig().catch(() => null),
        getLastSyncTime().catch(() => null),
        SecureStore.getItemAsync(GEMINI_KEY_STORAGE).catch(() => null),
        SecureStore.getItemAsync(FOOTBALL_DATA_KEY).catch(() => null)
      ]);
      setConfig(storedConfig);
      setLastSync(syncTime);
      if (gKey) setGeminiKey('********');
      if (fKey) setFootballKey('********');
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const handleSave = async () => {
    if (!config) return;
    setLoading(true);
    try {
      await saveGitHubSyncConfig({ ...config, token: token || undefined });
      if (geminiKey && geminiKey !== '********') await SecureStore.setItemAsync(GEMINI_KEY_STORAGE, geminiKey.trim());
      if (footballKey && footballKey !== '********') await SecureStore.setItemAsync(FOOTBALL_DATA_KEY, footballKey.trim());
      Alert.alert('✅ Succès', 'Toutes les clés ont été sécurisées.');
      await loadAllData();
      await startAutoSync();
    } catch (e) { Alert.alert('❌ Erreur', 'Échec de sauvegarde.'); }
    finally { setLoading(false); }
  };

  const handleManualBackup = async () => {
    setSyncing(true);
    try {
      const res = await syncDataToGitHub('Sauvegarde Manuelle');
      setLastSync(await getLastSyncTime());
      Alert.alert(res.success ? '✅ Réussi' : '⚠️ Erreur', res.logs.join('\n'));
    } catch (e) { Alert.alert('❌ Erreur', 'Connexion GitHub échouée.'); }
    finally { setSyncing(false); }
  };

  const handleCheckUpdate = async () => {
    setUpdating(true);
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        Alert.alert('🚀 Mise à jour !', 'Nouvelle version disponible.', [
          { text: 'Plus tard' },
          { text: 'Installer', onPress: async () => { await Updates.fetchUpdateAsync(); await Updates.reloadAsync(); } }
        ]);
      } else { Alert.alert('✅ À jour', 'L’application est déjà à la dernière version.'); }
    } catch (e) {
      Alert.alert('🔧 Diagnostic', `ID: ${(Updates as any).projectId || '6d5d5f...'}\nCanal: ${Updates.channel || 'production'}\nErreur: ${e instanceof Error ? e.message : 'Timeout'}`);
    } finally { setUpdating(false); }
  };

  if (loading || !config) {
    return <View style={styles.centered}><ActivityIndicator color="#3b82f6" /><Text style={styles.mutedText}>Chargement...</Text></View>;
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
            <TouchableOpacity onPress={() => navigation.goBack()}><Ionicons name="arrow-back" size={24} color="#fff" /></TouchableOpacity>
            <Text style={styles.title}>Configuration</Text>
            <View style={{width: 24}} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>🔑 Clés API & Sécurité</Text>

          <Text style={styles.label}>GITHUB TOKEN (BACKUP)</Text>
          <TextInput onChangeText={setToken} secureTextEntry={!showKeys} style={styles.input} value={token} placeholder="ghp_..." placeholderTextColor="#475569" />

          <Text style={styles.label}>GOOGLE GEMINI KEY (IA PRO)</Text>
          <TextInput onChangeText={setGeminiKey} secureTextEntry={!showKeys} style={styles.input} value={geminiKey} placeholder="AIza..." placeholderTextColor="#475569" />

          <Text style={styles.label}>FOOTBALL-DATA KEY (PLANNING)</Text>
          <TextInput onChangeText={setFootballKey} secureTextEntry={!showKeys} style={styles.input} value={footballKey} placeholder="Clé Football-Data..." placeholderTextColor="#475569" />

          <TouchableOpacity onPress={() => setShowKeys(!showKeys)}><Text style={styles.link}>{showKeys ? 'Cacher les clés' : 'Modifier les clés'}</Text></TouchableOpacity>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.cardTitle}>🔄 Sauvegarde Auto</Text>
            <Switch onValueChange={(enabled) => setConfig({...config, enabled})} value={config.enabled} />
          </View>
          <Text style={styles.mutedText}>Dépôt : {config.repoOwner}/{config.repoName}</Text>
          <Text style={styles.mutedText}>Canal OTA : {Updates.channel || 'production'}</Text>
        </View>

        <TouchableOpacity onPress={handleSave} style={styles.btnPrimary}><Text style={styles.btnText}>VALIDER LA CONFIGURATION</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleManualBackup} style={styles.btnSecondary}><Text style={styles.btnText}>SAUVEGARDER SUR GITHUB</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => syncDataFromGitHub()} style={styles.btnWarning}><Text style={styles.btnText}>RESTAURER LE JSON</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleCheckUpdate} style={styles.btnUpdate}><Text style={styles.btnText}>VÉRIFIER LES MISES À JOUR</Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  title: { fontSize: 22, fontWeight: 'bold', color: '#f8fafc' },
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: '#334155' },
  cardTitle: { color: '#f1f5f9', fontSize: 15, fontWeight: 'bold', marginBottom: 15 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: '#94a3b8', fontSize: 11, marginTop: 15, marginBottom: 5, fontWeight: 'bold' },
  input: { backgroundColor: '#0f172a', borderRadius: 10, padding: 12, color: '#f8fafc', borderWidth: 1, borderColor: '#334155' },
  link: { color: '#3b82f6', fontSize: 12, marginTop: 12, textAlign: 'right' },
  mutedText: { color: '#64748b', fontSize: 13, marginTop: 4 },
  btnPrimary: { backgroundColor: '#2563eb', borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 },
  btnSecondary: { backgroundColor: '#10b981', borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 },
  btnWarning: { backgroundColor: '#f59e0b', borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 },
  btnUpdate: { backgroundColor: '#8b5cf6', borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 },
  btnText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
});
