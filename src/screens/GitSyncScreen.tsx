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
  stopAutoSync,
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
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [githubStatus, setGithubStatus] = useState<'connected' | 'disconnected' | 'checking'>('disconnected');

  const updateConfig = (updated: Partial<GitHubDataSyncConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...updated } : null));
  };

  const checkConnection = async () => {
    setGithubStatus('checking');
    try {
      const hasToken = await isGitHubTokenConfigured();
      if (hasToken) {
        setGithubStatus('connected');
      } else {
        setGithubStatus('disconnected');
      }
    } catch {
      setGithubStatus('disconnected');
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const loadData = async () => {
    try {
      const [storedConfig, hasToken, syncTime, storedGeminiKey] = await Promise.all([
        getGitHubSyncConfig(),
        isGitHubTokenConfigured(),
        getLastSyncTime(),
        SecureStore.getItemAsync(GEMINI_KEY_STORAGE)
      ]);
      setConfig(storedConfig);
      setTokenConfigured(hasToken);
      setLastSync(syncTime);
      setGeminiConfigured(!!storedGeminiKey);

      if (hasToken) {
        void checkConnection();
      }
    } catch (error) {
      console.error('Erreur chargement sauvegarde GitHub:', error);
    } finally {
      setLoading(false);
    }
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
      Alert.alert('✅ Configuration enregistrée', 'Les clés ont été mises à jour.');
    } catch (error) {
      Alert.alert('❌ Erreur', 'La configuration n’a pas pu être enregistrée.');
    } finally {
      setSaving(false);
    }
  };

  const handleManualBackup = async () => {
    if (!config?.enabled) {
      Alert.alert('⚠️ Sauvegarde désactivée', 'Activez la sauvegarde puis enregistrez la configuration avant de lancer une copie.');
      return;
    }

    setSyncing(true);
    setLogs([]);
    try {
      const result = await syncDataToGitHub('Sauvegarde manuelle');
      setLogs(result.logs);
      setLastSync(await getLastSyncTime());
      Alert.alert(
        result.success ? '✅ Sauvegarde terminée' : '⚠️ Sauvegarde non terminée',
        result.logs.join('\n')
      );
    } catch (error) {
      Alert.alert('❌ Erreur', error instanceof Error ? error.message : 'Une erreur inattendue est survenue.');
    } finally {
      setSyncing(false);
    }
  };

  const handleRestore = async () => {
    Alert.alert(
      '📥 Restaurer les données ?',
      'Cette action remplacera TOUS vos paris et leçons locaux par la version sur GitHub.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Restaurer',
          style: 'destructive',
          onPress: async () => {
            setSyncing(true);
            setLogs([]);
            try {
              const result = await syncDataFromGitHub();
              setLogs(result.logs);
              if (result.success) {
                Alert.alert('✅ Restauration terminée', 'Les données locales ont été mises à jour.');
              } else {
                Alert.alert('⚠️ Échec', result.logs.join('\n'));
              }
            } catch (error) {
              Alert.alert('❌ Erreur', error instanceof Error ? error.message : 'Erreur de restauration.');
            } finally {
              setSyncing(false);
            }
          },
        },
      ]
    );
  };

  const handleCheckUpdate = async () => {
    setUpdating(true);
    try {
      if (!Updates || !Updates.checkForUpdateAsync) {
        throw new Error('Le module expo-updates n’est pas disponible.');
      }
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        Alert.alert(
          '🚀 Mise à jour disponible',
          `Une nouvelle version est prête. Voulez-vous l’installer ?`,
          [
            { text: 'Plus tard', style: 'cancel' },
            {
              text: 'Mettre à jour',
              onPress: async () => {
                await Updates.fetchUpdateAsync();
                await Updates.reloadAsync();
              },
            },
          ]
        );
      } else {
        Alert.alert('✅ À jour', `Aucune mise à jour sur le canal "${Updates?.channel || 'production'}".`);
      }
    } catch (error) {
      console.error('Erreur check updates:', error);
      const detail = error instanceof Error ? error.message : String(error);

      Alert.alert(
        '❌ Erreur Mise à jour',
        `Détails techniques :\n` +
        `ID Projet : ${(Updates as any).easProjectId || (Updates as any).projectId || '6d5d5f8b-3c39-48c6-913f-204edebcb63f'}\n` +
        `Canal : ${Updates?.channel || 'production'}\n` +
        `Runtime : ${Updates?.runtimeVersion || '1.0.0'}\n\n` +
        `Erreur : ${detail}`
      );
    } finally {
      setUpdating(false);
    }
  };

  const handleDisable = () => {
    Alert.alert(
      'Désactiver la sauvegarde ?',
      'Les copies existantes sur GitHub ne seront pas supprimées.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Désactiver',
          style: 'destructive',
          onPress: async () => {
            updateConfig({ enabled: false });
            stopAutoSync();
            if (config) await saveGitHubSyncConfig({ ...config, enabled: false });
          },
        },
      ]
    );
  };

  if (loading || !config) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.mutedText}>Chargement de la configuration…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityLabel="Retour" onPress={() => navigation.goBack()}>
          <Ionicons color="#f8fafc" name="arrow-back" size={24} />
        </TouchableOpacity>
        <Text style={styles.title}>Sauvegarde GitHub</Text>
        <View style={[
          styles.statusLight,
          { backgroundColor: githubStatus === 'connected' ? '#10b981' : githubStatus === 'checking' ? '#f59e0b' : '#ef4444' }
        ]} />
        <View style={styles.backSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.notice}>
          <Ionicons color="#60a5fa" name="shield-checkmark-outline" size={22} />
          <Text style={styles.noticeText}>
            Les données restent sur votre téléphone. GitHub reçoit uniquement une copie JSON de secours.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeading}>
            <Ionicons color="#f59e0b" name="git-branch-outline" size={23} />
            <Text style={styles.cardTitle}>Configuration</Text>
          </View>

          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.label}>Activer la sauvegarde</Text>
              <Text style={styles.hint}>Copie automatique toutes les 20 min.</Text>
            </View>
            <Switch
              onValueChange={(enabled) => updateConfig({ enabled })}
              thumbColor={config.enabled ? '#ffffff' : '#94a3b8'}
              trackColor={{ false: '#334155', true: '#10b981' }}
              value={config.enabled}
            />
          </View>

          <Field label="Token d’accès GitHub">
            <View style={styles.tokenField}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setToken}
                placeholder={tokenConfigured ? 'Token enregistré' : 'ghp_...'}
                placeholderTextColor="#64748b"
                secureTextEntry={!showToken}
                style={styles.tokenInput}
                value={token}
              />
              <TouchableOpacity onPress={() => setShowToken((v) => !v)} style={styles.eyeButton}>
                <Ionicons color="#94a3b8" name={showToken ? 'eye-off-outline' : 'eye-outline'} size={20} />
              </TouchableOpacity>
            </View>
          </Field>

          <Field label="Clé API Google Gemini">
            <View style={styles.tokenField}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setGeminiKey}
                placeholder={geminiConfigured ? 'Clé Gemini enregistrée' : 'AIzaSy...'}
                placeholderTextColor="#64748b"
                secureTextEntry={!showToken}
                style={styles.tokenInput}
                value={geminiKey}
              />
            </View>
          </Field>

          <Field label="Propriétaire / Dépôt">
            <Text style={styles.statusValue}>{config.repoOwner}/{config.repoName}</Text>
          </Field>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeading}>
            <Ionicons color="#10b981" name="cloud-done-outline" size={23} />
            <Text style={styles.cardTitle}>État du Système</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Dernière sauvegarde</Text>
            <Text style={styles.statusValue}>{formatTimeAgo(lastSync)}</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Version App</Text>
            <Text style={styles.statusValue}>{Updates?.runtimeVersion || '1.0.0'}</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Canal</Text>
            <Text style={styles.statusValue}>{Updates?.channel || 'production'}</Text>
          </View>
        </View>

        <TouchableOpacity disabled={saving} onPress={() => void handleSave()} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Enregistrer les clés</Text>
        </TouchableOpacity>

        <TouchableOpacity disabled={syncing} onPress={() => void handleManualBackup()} style={styles.secondaryButton}>
          <Text style={styles.primaryButtonText}>Sauvegarder maintenant</Text>
        </TouchableOpacity>

        <TouchableOpacity disabled={syncing} onPress={() => void handleRestore()} style={styles.restoreButton}>
          <Text style={styles.primaryButtonText}>Restaurer depuis GitHub</Text>
        </TouchableOpacity>

        <TouchableOpacity disabled={updating} onPress={() => void handleCheckUpdate()} style={styles.otaButton}>
          <Text style={styles.primaryButtonText}>Vérifier les mises à jour</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  statusLight: { width: 10, height: 10, borderRadius: 5, marginLeft: 8 },
  backSpacer: { width: 24 },
  card: { backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: 12, borderWidth: 1, marginBottom: 16, padding: 16 },
  cardHeading: { alignItems: 'center', flexDirection: 'row', gap: 10, marginBottom: 16 },
  cardTitle: { color: '#f8fafc', fontSize: 18, fontWeight: '700' },
  centered: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  container: { backgroundColor: '#0f172a', flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  eyeButton: { padding: 12 },
  field: { marginBottom: 16 },
  fieldHint: { color: '#94a3b8', fontSize: 11, lineHeight: 16, marginTop: 6 },
  header: { alignItems: 'center', borderBottomColor: '#334155', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', padding: 16 },
  hint: { color: '#64748b', fontSize: 11, lineHeight: 16, marginTop: 3 },
  input: { backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: 8, borderWidth: 1, color: '#f8fafc', fontSize: 14, padding: 12 },
  label: { color: '#cbd5e1', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  primaryButton: { alignItems: 'center', backgroundColor: '#3b82f6', borderRadius: 12, marginBottom: 12, padding: 16 },
  primaryButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  secondaryButton: { alignItems: 'center', backgroundColor: '#10b981', borderRadius: 12, marginBottom: 12, padding: 16 },
  restoreButton: { alignItems: 'center', backgroundColor: '#f59e0b', borderRadius: 12, marginBottom: 12, padding: 16 },
  otaButton: { alignItems: 'center', backgroundColor: '#8b5cf6', borderRadius: 12, marginBottom: 12, padding: 16 },
  statusLabel: { color: '#94a3b8', fontSize: 13 },
  statusRow: { alignItems: 'center', borderBottomColor: '#334155', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 11 },
  statusValue: { color: '#f8fafc', fontSize: 12, fontWeight: '600', textAlign: 'right' },
  switchRow: { alignItems: 'center', borderBottomColor: '#334155', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16, paddingBottom: 14 },
  switchText: { flex: 1, paddingRight: 14 },
  title: { color: '#f8fafc', fontSize: 19, fontWeight: '700' },
  tokenField: { alignItems: 'center', backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: 8, borderWidth: 1, flexDirection: 'row' },
  tokenInput: { color: '#f8fafc', flex: 1, fontSize: 14, paddingHorizontal: 12, paddingVertical: 12 },
  mutedText: { color: '#94a3b8', fontSize: 14, marginTop: 12 },
  notice: { alignItems: 'flex-start', backgroundColor: 'rgba(59, 130, 246, 0.12)', borderColor: 'rgba(96, 165, 250, 0.35)', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 10, marginBottom: 16, padding: 14 },
  noticeText: { color: '#bfdbfe', flex: 1, fontSize: 12, lineHeight: 18 },
});
