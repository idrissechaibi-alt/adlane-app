// 🔄 Écran Sauvegarde & IA Adlane
// Totalement sécurisé contre les crashs système.

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
      console.error('Erreur chargement GitSync:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setLoading(true);
    try {
      await saveGitHubSyncConfig({ ...config, token: token || undefined });
      if (geminiKey) await SecureStore.setItemAsync(GEMINI_KEY_STORAGE, geminiKey.trim());
      setToken('');
      setGeminiKey('');
      await loadData();
      await startAutoSync();
      Alert.alert('✅ Enregistré', 'Vos paramètres ont été mis à jour.');
    } catch (e) {
      Alert.alert('❌ Erreur', 'Impossible de sauvegarder.');
    } finally {
      setLoading(false);
    }
  };

  const handleManualBackup = async () => {
    setSyncing(true);
    try {
      const res = await syncDataToGitHub('Sauvegarde Manuelle');
      setLastSync(await getLastSyncTime());
      Alert.alert(res.success ? '✅ Réussi' : '⚠️ Erreur', res.logs.join('\n'));
    } catch (e) {
      Alert.alert('❌ Erreur', 'Échec de la connexion.');
    } finally {
      setSyncing(false);
    }
  };

  const handleRestore = async () => {
    Alert.alert('📥 Restaurer ?', 'Ceci effacera vos données locales.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Confirmer', style: 'destructive', onPress: async () => {
          setSyncing(true);
          try {
            const res = await syncDataFromGitHub();
            if (res.success) Alert.alert('✅ OK', 'Données restaurées.');
            else Alert.alert('❌ Échec', res.logs.join('\n'));
          } catch (e) { Alert.alert('❌ Erreur', 'Restauration impossible.'); }
          finally { setSyncing(false); }
      }}
    ]);
  };

  const handleCheckUpdate = async () => {
    setUpdating(true);
    try {
      if (!Updates.isEnabled) throw new Error('Mises à jour désactivées.');
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        Alert.alert('🚀 Mise à jour !', 'Nouvelle version prête.', [
          { text: 'Plus tard' },
          { text: 'Installer', onPress: async () => { await Updates.fetchUpdateAsync(); await Updates.reloadAsync(); } }
        ]);
      } else { Alert.alert('✅ À jour', 'Vous utilisez la dernière version.'); }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      Alert.alert('🔧 Diagnostic OTA', `Projet: ${(Updates as any).projectId || '6d5d5f...'}\nCanal: ${Updates.channel || 'production'}\nErreur: ${msg}`);
    } finally { setUpdating(false); }
  };

  if (loading || !config) {
    return <View style={styles.centered}><ActivityIndicator color="#3b82f6" /><Text style={styles.mutedText}>Synchronisation...</Text></View>;
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Sauvegarde & IA</Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Sauvegarde Auto</Text>
            <Switch onValueChange={(enabled) => setConfig({...config, enabled})} value={config.enabled} />
          </View>

          <Text style={styles.fieldLabel}>Token GitHub</Text>
          <TextInput onChangeText={setToken} secureTextEntry={!showToken} style={styles.input} value={token} placeholder="ghp_..." placeholderTextColor="#475569" />

          <Text style={styles.fieldLabel}>Clé Gemini (Google)</Text>
          <TextInput onChangeText={setGeminiKey} secureTextEntry={!showToken} style={styles.input} value={geminiKey} placeholder="AIza..." placeholderTextColor="#475569" />

          <TouchableOpacity onPress={() => setShowToken(!showToken)}><Text style={styles.link}>{showToken ? 'Masquer les clés' : 'Afficher les clés'}</Text></TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Système</Text>
          <Text style={styles.mutedText}>Dépôt : {config.repoOwner}/{config.repoName}</Text>
          <Text style={styles.mutedText}>Canal : {Updates.channel || 'production'}</Text>
          <Text style={styles.mutedText}>Dernière Sync : {lastSync ? new Date(lastSync).toLocaleTimeString() : 'Jamais'}</Text>
        </View>

        <TouchableOpacity onPress={handleSave} style={styles.btnPrimary}><Text style={styles.btnText}>ENREGISTRER LES CLÉS</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleManualBackup} style={styles.btnSecondary}><Text style={styles.btnText}>LANCER UNE SAUVEGARDE</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleRestore} style={styles.btnWarning}><Text style={styles.btnText}>RESTAURER LES DONNÉES</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleCheckUpdate} style={styles.btnUpdate}><Text style={styles.btnText}>MISE À JOUR DE L'APP</Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 20 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  title: { fontSize: 26, fontWeight: 'bold', color: '#f8fafc', marginBottom: 20 },
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 20, marginBottom: 20, borderWidth: 1, borderColor: '#334155' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  label: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  fieldLabel: { color: '#94a3b8', fontSize: 12, marginTop: 15, marginBottom: 5, textTransform: 'uppercase' },
  input: { backgroundColor: '#0f172a', borderRadius: 10, padding: 14, color: '#f8fafc', borderWidth: 1, borderColor: '#334155' },
  link: { color: '#3b82f6', fontSize: 13, marginTop: 12, fontWeight: '600' },
  mutedText: { color: '#64748b', fontSize: 14, marginTop: 5 },
  btnPrimary: { backgroundColor: '#2563eb', borderRadius: 12, padding: 18, alignItems: 'center', marginBottom: 12 },
  btnSecondary: { backgroundColor: '#10b981', borderRadius: 12, padding: 18, alignItems: 'center', marginBottom: 12 },
  btnWarning: { backgroundColor: '#f59e0b', borderRadius: 12, padding: 18, alignItems: 'center', marginBottom: 12 },
  btnUpdate: { backgroundColor: '#8b5cf6', borderRadius: 12, padding: 18, alignItems: 'center', marginBottom: 12 },
  btnText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
});
