// 🔄 Écran de sauvegarde locale vers GitHub
// Les données de l'application restent stockées localement sur le téléphone.

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import {
  getGitHubSyncConfig,
  getLastSyncTime,
  isGitHubTokenConfigured,
  saveGitHubSyncConfig,
  startAutoSync,
  syncDataToGitHub,
  syncDataFromGitHub,
  GitHubDataSyncConfig,
} from '../core/gitAutoSync';
import * as Updates from 'expo-updates';

const GEMINI_KEY_STORAGE = 'app-adlane.gemini-api-key';

export default function GitSyncScreen({ navigation }: any) {
  const [config, setConfig] = useState<GitHubDataSyncConfig | null>(null);
  const [token, setToken] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    void loadData();
  }, []);

  const loadData = async () => {
    try {
      const [storedConfig, hasToken, syncTime, storedGeminiKey] = await Promise.all([
        getGitHubSyncConfig().catch(() => null),
        isGitHubTokenConfigured().catch(() => false),
        getLastSyncTime().catch(() => null),
        SecureStore.getItemAsync(GEMINI_KEY_STORAGE).catch(() => null)
      ]);

      setConfig(storedConfig);
      setTokenConfigured(hasToken);
      setLastSync(syncTime);
      setGeminiConfigured(!!storedGeminiKey);
    } catch (error) {
      console.error('Erreur chargement GitSyncScreen:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = (updated: Partial<GitHubDataSyncConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...updated } : null));
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await saveGitHubSyncConfig({ ...config, token: token || undefined });
      if (geminiKey) {
        await SecureStore.setItemAsync(GEMINI_KEY_STORAGE, geminiKey.trim());
      }
      setToken('');
      setGeminiKey('');
      setTokenConfigured(await isGitHubTokenConfigured());
      setGeminiConfigured(!!(await SecureStore.getItemAsync(GEMINI_KEY_STORAGE)));
      await startAutoSync();
      Alert.alert('✅ OK', 'Configuration enregistrée.');
    } catch (error) {
      Alert.alert('❌ Erreur', 'Impossible d’enregistrer.');
    } finally {
      setSaving(false);
    }
  };

  const handleManualBackup = async () => {
    setSyncing(true);
    try {
      const result = await syncDataToGitHub('Manuelle');
      setLastSync(await getLastSyncTime());
      Alert.alert(result.success ? '✅ Succès' : '⚠️ Échec', result.logs.join('\n'));
    } catch (error) {
      Alert.alert('❌ Erreur', 'Échec de la sauvegarde.');
    } finally {
      setSyncing(false);
    }
  };

  const handleRestore = async () => {
    Alert.alert('📥 Restaurer ?', 'Ceci remplacera vos données locales.', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Confirmer',
        style: 'destructive',
        onPress: async () => {
          setSyncing(true);
          try {
            const result = await syncDataFromGitHub();
            if (result.success) Alert.alert('✅ OK', 'Données restaurées.');
            else Alert.alert('❌ Échec', result.logs.join('\n'));
          } catch (error) {
            Alert.alert('❌ Erreur', 'Restauration échouée.');
          } finally {
            setSyncing(false);
          }
        },
      },
    ]);
  };

  const handleCheckUpdate = async () => {
    setUpdating(true);
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        Alert.alert('🚀 Update disponible', 'Installer maintenant ?', [
          { text: 'Non', style: 'cancel' },
          { text: 'Oui', onPress: async () => { await Updates.fetchUpdateAsync(); await Updates.reloadAsync(); } }
        ]);
      } else {
        Alert.alert('✅ À jour', 'Vous avez la dernière version.');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      Alert.alert('❌ Info Update', `ID: ${(Updates as any).projectId || 'N/A'}\nCanal: ${Updates.channel || 'N/A'}\nErreur: ${msg}`);
    } finally {
      setUpdating(false);
    }
  };

  if (loading || !config) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}><ActivityIndicator color="#3b82f6" /><Text style={styles.mutedText}>Chargement...</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Sauvegarde & IA</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Sauvegarde Auto</Text>
          <Switch onValueChange={(enabled) => updateConfig({ enabled })} value={config.enabled} />

          <Text style={[styles.label, {marginTop: 15}]}>Token GitHub</Text>
          <TextInput onChangeText={setToken} secureTextEntry={!showToken} style={styles.input} value={token} placeholder="ghp_..." placeholderTextColor="#475569" />

          <Text style={[styles.label, {marginTop: 15}]}>Clé Google Gemini</Text>
          <TextInput onChangeText={setGeminiKey} secureTextEntry={!showToken} style={styles.input} value={geminiKey} placeholder="AIza..." placeholderTextColor="#475569" />

          <TouchableOpacity onPress={() => setShowToken(!showToken)}><Text style={styles.hint}>{showToken ? 'Masquer les clés' : 'Afficher les clés'}</Text></TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Infos Système</Text>
          <Text style={styles.mutedText}>Dépôt : {config.repoOwner}/{config.repoName}</Text>
          <Text style={styles.mutedText}>Version : {Updates.runtimeVersion || '1.0.0'}</Text>
          <Text style={styles.mutedText}>Canal : {Updates.channel || 'production'}</Text>
        </View>

        <TouchableOpacity onPress={handleSave} style={styles.button}><Text style={styles.buttonText}>Enregistrer</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleManualBackup} style={[styles.button, {backgroundColor: '#10b981'}]}><Text style={styles.buttonText}>Sauvegarder</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleRestore} style={[styles.button, {backgroundColor: '#f59e0b'}]}><Text style={styles.buttonText}>Restaurer</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleCheckUpdate} style={[styles.button, {backgroundColor: '#8b5cf6'}]}><Text style={styles.buttonText}>Mise à jour App</Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 20 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f8fafc', marginBottom: 20 },
  card: { backgroundColor: '#1e293b', borderRadius: 12, padding: 15, marginBottom: 15 },
  label: { color: '#94a3b8', fontSize: 13, marginBottom: 5 },
  input: { backgroundColor: '#0f172a', borderRadius: 8, padding: 12, color: '#f8fafc', borderWidth: 1, borderColor: '#334155' },
  hint: { color: '#3b82f6', fontSize: 12, marginTop: 10 },
  mutedText: { color: '#64748b', fontSize: 13, marginTop: 5 },
  button: { backgroundColor: '#2563eb', borderRadius: 10, padding: 15, alignItems: 'center', marginBottom: 10 },
  buttonText: { color: '#fff', fontWeight: 'bold' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' }
});
