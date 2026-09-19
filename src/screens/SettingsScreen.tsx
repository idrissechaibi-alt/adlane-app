// Écran Paramètres : Configuration Omniroute + API Football
// Configure Omniroute, clés API football, et préférences système

import React, { useState, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TextInput,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  Switch,
  ActivityIndicator,
  Modal,
  FlatList
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getAPIConfig, saveAPIConfig, APIConfig, incrementRequestCount } from '../api/multiAPIManager';
import { DEFAULT_OMNIROUTE_CONFIG } from '../core/omniroute';
import AsyncStorage from '@react-native-async-storage/async-storage';

const OMNIROUTE_CONFIG_KEY = '@omniroute_config';

interface OmnirouteConfig {
  endpoint: string;
  apiKey: string;
  selectedModel: string;
  enabled: boolean;
}

// Mêmes valeurs par défaut que src/core/omniroute.ts (endpoint Termux local +
// les 5 agents de base), pour que le premier écran affiché avant toute
// sauvegarde corresponde à ce que ScoutingScreen utilisera réellement.
const DEFAULT_OMNIROUTE: OmnirouteConfig = {
  endpoint: DEFAULT_OMNIROUTE_CONFIG.endpoint,
  apiKey: '',
  selectedModel: DEFAULT_OMNIROUTE_CONFIG.selectedModel,
  enabled: false
};

export default function SettingsScreen({ navigation }: any) {
  // Omniroute
  const [omniroute, setOmniroute] = useState<OmnirouteConfig>(DEFAULT_OMNIROUTE);

  // API Football
  const [apiConfig, setApiConfig] = useState<APIConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Sélecteur de modèles Omniroute (endpoint /models expose parfois 1000+ agents,
  // impossible à taper à la main : on charge la liste et on coche dedans)
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [pendingSelection, setPendingSelection] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    try {
      // Charger config Omniroute
      const omniRaw = await AsyncStorage.getItem(OMNIROUTE_CONFIG_KEY);
      if (omniRaw) {
        setOmniroute(JSON.parse(omniRaw));
      }

      // Charger config API
      const apiConf = await getAPIConfig();
      setApiConfig(apiConf);
    } catch (error) {
      console.error('Erreur chargement configs:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Sauvegarder Omniroute
      await AsyncStorage.setItem(OMNIROUTE_CONFIG_KEY, JSON.stringify(omniroute));

      // Sauvegarder API config
      if (apiConfig) {
        await saveAPIConfig(apiConfig);
      }

      Alert.alert('✅ Sauvegardé', 'Configuration enregistrée avec succès');
    } catch (error) {
      Alert.alert('❌ Erreur', 'Impossible de sauvegarder la configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleTestOmniroute = async () => {
    setTesting(true);
    try {
      const response = await fetch(`${omniroute.endpoint}/models`, {
        headers: omniroute.apiKey ? { 'Authorization': `Bearer ${omniroute.apiKey}` } : {},
        timeout: 10000
      } as any);

      if (response.ok) {
        const data = await response.json();
        Alert.alert('✅ Omniroute OK', `Connexion réussie. ${data.data?.length || 0} modèles disponibles.`);
      } else {
        Alert.alert('⚠️ Erreur', `HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error: any) {
      Alert.alert('❌ Échec', error.message || 'Impossible de joindre Omniroute');
    } finally {
      setTesting(false);
    }
  };

  /**
   * Charge la liste réelle des agents exposés par ce serveur Omniroute
   * (endpoint OpenAI-compatible GET /models) et ouvre le sélecteur à cocher,
   * pour éviter de devoir taper à la main les 1000+ noms de modèles.
   */
  const handleOpenModelPicker = async () => {
    setLoadingModels(true);
    try {
      const response = await fetch(`${omniroute.endpoint}/models`, {
        headers: omniroute.apiKey ? { 'Authorization': `Bearer ${omniroute.apiKey}` } : {},
        timeout: 15000
      } as any);

      if (!response.ok) {
        Alert.alert('⚠️ Erreur', `HTTP ${response.status}: ${response.statusText}`);
        return;
      }

      const data = await response.json();
      const ids: string[] = (data.data || data.models || [])
        .map((m: any) => (typeof m === 'string' ? m : m.id || m.name))
        .filter(Boolean)
        // Claude/Anthropic jamais proposé : consommerait les crédits Anthropic
        // de l'utilisateur au lieu des autres providers déjà payés sur Omniroute.
        .filter((id: string) => !/claude|anthropic/i.test(id))
        .sort();

      if (ids.length === 0) {
        Alert.alert('⚠️ Liste vide', "Omniroute n'a renvoyé aucun modèle utilisable (hors Claude/Anthropic, exclu). Vérifie l'endpoint et la clé API.");
        return;
      }

      setAvailableModels(ids);
      setPendingSelection(new Set(
        omniroute.selectedModel.split(/[,\n]/).map((m) => m.trim()).filter(Boolean)
      ));
      setModelSearch('');
      setModelPickerVisible(true);
    } catch (error: any) {
      Alert.alert('❌ Échec', error.message || 'Impossible de charger la liste des modèles Omniroute');
    } finally {
      setLoadingModels(false);
    }
  };

  const toggleModelSelection = (modelId: string) => {
    setPendingSelection((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const handleApplyModelSelection = () => {
    setOmniroute({ ...omniroute, selectedModel: Array.from(pendingSelection).join(', ') });
    setModelPickerVisible(false);
  };

  /** Sélectionne tous les agents actuellement affichés (respecte la recherche en cours). */
  const handleSelectAllFiltered = () => {
    setPendingSelection((prev) => new Set([...prev, ...filteredModels]));
  };

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter((m) => m.toLowerCase().includes(q));
  }, [availableModels, modelSearch]);

  const handleTestAPIFootball = async () => {
    if (!apiConfig?.apiFootball) {
      Alert.alert('⚠️ Clé manquante', 'Veuillez d\'abord configurer votre clé API-Football');
      return;
    }

    setTesting(true);
    try {
      await incrementRequestCount('apiFootball');
      const response = await fetch('https://v3.football.api-sports.io/status', {
        headers: {
          'x-rapidapi-key': apiConfig.apiFootball,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const account = data.response?.account;
        Alert.alert(
          '✅ API-Football OK',
          `Plan: ${account?.firstname || 'Free'}\nRequêtes restantes: ${account?.requests?.current || 'N/A'}`
        );
      } else {
        Alert.alert('⚠️ Erreur', `Clé invalide ou quota dépassé (HTTP ${response.status})`);
      }
    } catch (error: any) {
      Alert.alert('❌ Échec', error.message || 'Impossible de joindre API-Football');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text style={styles.loadingText}>Chargement configuration...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>

        {/* Bouton Gestion Avancée des API */}
        <TouchableOpacity
          style={styles.apiManagementButton}
          onPress={() => navigation.navigate('APIManagement')}
        >
          <View style={styles.apiManagementLeft}>
            <Ionicons name="server" size={28} color="#10b981" />
            <View>
              <Text style={styles.apiManagementTitle}>🌐 Gestion des API</Text>
              <Text style={styles.apiManagementSubtitle}>
                20+ sources disponibles • Fixtures, Cotes, Stats xG, Live, IA, Scouting
              </Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={24} color="#60a5fa" />
        </TouchableOpacity>

        {/* Bouton de sauvegarde des données sur GitHub */}
        <TouchableOpacity
          style={styles.gitSyncButton}
          onPress={() => navigation.navigate('GitSync')}
        >
          <View style={styles.apiManagementLeft}>
            <Ionicons name="git-branch" size={28} color="#f59e0b" />
            <View>
              <Text style={styles.apiManagementTitle}>🔄 Sauvegarde GitHub</Text>
              <Text style={styles.apiManagementSubtitle}>
                Copie locale vers GitHub toutes les 20 min • Données conservées sur le téléphone
              </Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={24} color="#60a5fa" />
        </TouchableOpacity>

        {/* Section Omniroute */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="flask" size={24} color="#3b82f6" />
            <Text style={styles.sectionTitle}>Configuration Omniroute</Text>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Endpoint</Text>
            <TextInput
              style={styles.input}
              value={omniroute.endpoint}
              onChangeText={(text) => setOmniroute({ ...omniroute, endpoint: text })}
              placeholder="https://api.omniroute.io"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Clé API (optionnel)</Text>
            <TextInput
              style={styles.input}
              value={omniroute.apiKey}
              onChangeText={(text) => setOmniroute({ ...omniroute, apiKey: text })}
              placeholder="sk-..."
              placeholderTextColor="#64748b"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Modèles actifs (séparés par une virgule)</Text>
            <TextInput
              style={styles.input}
              value={omniroute.selectedModel}
              onChangeText={(text) => setOmniroute({ ...omniroute, selectedModel: text })}
              placeholder="Utilise le bouton ci-dessous pour choisir tes agents"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              multiline
            />
            <Text style={styles.fieldHint}>
              Système de ronde : les modèles sont essayés un par un, du meilleur connu au moins bon, et le premier qui répond est utilisé (pas d'appel parallèle qui consommerait un crédit par agent). Claude/Anthropic est toujours exclu, même si sélectionné. Les noms exacts dépendent de ton serveur Omniroute : utilise le sélecteur ci-dessous plutôt que de deviner un préfixe.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.testButton, styles.testButtonPurple, loadingModels && styles.testButtonDisabled]}
            onPress={handleOpenModelPicker}
            disabled={loadingModels}
          >
            {loadingModels ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <>
                <Ionicons name="list" size={18} color="#ffffff" />
                <Text style={styles.testButtonText}>Choisir les agents dans la liste (1000+)</Text>
              </>
            )}
          </TouchableOpacity>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Activer Omniroute</Text>
            <Switch
              value={omniroute.enabled}
              onValueChange={(value) => setOmniroute({ ...omniroute, enabled: value })}
              trackColor={{ false: '#334155', true: '#3b82f6' }}
              thumbColor={omniroute.enabled ? '#ffffff' : '#94a3b8'}
            />
          </View>

          <TouchableOpacity
            style={[styles.testButton, testing && styles.testButtonDisabled]}
            onPress={handleTestOmniroute}
            disabled={testing}
          >
            {testing ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <>
                <Ionicons name="checkmark-circle-outline" size={18} color="#ffffff" />
                <Text style={styles.testButtonText}>Tester la connexion</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Section API Football */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="football" size={24} color="#10b981" />
            <Text style={styles.sectionTitle}>API Football</Text>
          </View>

          <View style={styles.inputGroup}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>API-Football (RapidAPI) ⭐</Text>
              <TouchableOpacity onPress={() => Alert.alert('ℹ️ Info', 'Source principale recommandée.\n100 requêtes/jour gratuites.\n\nInscription: rapidapi.com/api-sports/api/api-football')}>
                <Ionicons name="information-circle-outline" size={18} color="#60a5fa" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              value={apiConfig?.apiFootball || ''}
              onChangeText={(text) => setApiConfig({ ...apiConfig!, apiFootball: text })}
              placeholder="Votre clé RapidAPI"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.inputGroup}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>TheOddsAPI</Text>
              <TouchableOpacity onPress={() => Alert.alert('ℹ️ Info', 'Spécialisé cotes temps réel.\n$30/mois (10k requêtes)\n\nInscription: the-odds-api.com')}>
                <Ionicons name="information-circle-outline" size={18} color="#60a5fa" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              value={apiConfig?.theOddsApi || ''}
              onChangeText={(text) => setApiConfig({ ...apiConfig!, theOddsApi: text })}
              placeholder="Clé TheOddsAPI (optionnel)"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.inputGroup}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>Football-Data.org</Text>
              <TouchableOpacity onPress={() => Alert.alert('ℹ️ Info', 'Gratuit (10 req/min).\nTop 5 ligues européennes.\n\nInscription: football-data.org/client/register')}>
                <Ionicons name="information-circle-outline" size={18} color="#60a5fa" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              value={apiConfig?.footballData || ''}
              onChangeText={(text) => setApiConfig({ ...apiConfig!, footballData: text })}
              placeholder="Clé Football-Data (optionnel)"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.inputGroup}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>Sportmonks</Text>
              <TouchableOpacity onPress={() => Alert.alert('ℹ️ Info', 'API complète pro.\n$40/mois (Classic)\n\nInscription: sportmonks.com/register')}>
                <Ionicons name="information-circle-outline" size={18} color="#60a5fa" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              value={apiConfig?.sportmonks || ''}
              onChangeText={(text) => setApiConfig({ ...apiConfig!, sportmonks: text })}
              placeholder="Clé Sportmonks (optionnel)"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Fallback automatique</Text>
            <Switch
              value={apiConfig?.fallbackEnabled ?? true}
              onValueChange={(value) => setApiConfig({ ...apiConfig!, fallbackEnabled: value })}
              trackColor={{ false: '#334155', true: '#10b981' }}
              thumbColor={apiConfig?.fallbackEnabled ? '#ffffff' : '#94a3b8'}
            />
          </View>

          <TouchableOpacity
            style={[styles.testButton, styles.testButtonGreen, testing && styles.testButtonDisabled]}
            onPress={handleTestAPIFootball}
            disabled={testing}
          >
            {testing ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <>
                <Ionicons name="checkmark-circle-outline" size={18} color="#ffffff" />
                <Text style={styles.testButtonText}>Tester API-Football</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Section Informations */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="help-circle" size={24} color="#f59e0b" />
            <Text style={styles.sectionTitle}>Aide</Text>
          </View>

          <View style={styles.infoBox}>
            <Text style={styles.infoText}>
              <Text style={styles.infoBold}>Configuration minimale :</Text>{'\n'}
              • API-Football gratuite (100 req/jour){'\n'}
              • Suffit pour tester l'app{'\n\n'}

              <Text style={styles.infoBold}>Configuration optimale :</Text>{'\n'}
              • API-Football Pro ($10/mois){'\n'}
              • TheOddsAPI ($30/mois){'\n'}
              • Cotes temps réel + fallback{'\n\n'}

              <Text style={styles.infoBold}>Sécurité :</Text>{'\n'}
              • Clés stockées localement uniquement{'\n'}
              • Jamais envoyées à des tiers{'\n'}
              • Chiffrées au repos sur Android
            </Text>
          </View>

          <TouchableOpacity
            style={styles.linkButton}
            onPress={() => Alert.alert('📖 Documentation', 'Consultez API-INTEGRATION-GUIDE.md dans le projet pour la liste complète des API disponibles et leurs tarifs.')}
          >
            <Ionicons name="document-text-outline" size={18} color="#60a5fa" />
            <Text style={styles.linkButtonText}>Voir le guide complet des API</Text>
          </TouchableOpacity>
        </View>

        {/* Bouton Sauvegarder */}
        <TouchableOpacity
          style={[styles.saveButton, saving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <>
              <Ionicons name="save" size={20} color="#ffffff" />
              <Text style={styles.saveButtonText}>Sauvegarder la configuration</Text>
            </>
          )}
        </TouchableOpacity>

      </ScrollView>

      <Modal
        visible={modelPickerVisible}
        animationType="slide"
        onRequestClose={() => setModelPickerVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              Agents Omniroute ({pendingSelection.size} sélectionné{pendingSelection.size > 1 ? 's' : ''} / {availableModels.length})
            </Text>
            <TouchableOpacity onPress={() => setModelPickerVisible(false)}>
              <Ionicons name="close" size={26} color="#f8fafc" />
            </TouchableOpacity>
          </View>

          <TextInput
            style={[styles.input, styles.modalSearchInput]}
            value={modelSearch}
            onChangeText={setModelSearch}
            placeholder="Rechercher un agent (ex: gpt, gemini, deepseek...)"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <FlatList
            data={filteredModels}
            keyExtractor={(item) => item}
            style={styles.modalList}
            renderItem={({ item }) => {
              const checked = pendingSelection.has(item);
              return (
                <TouchableOpacity
                  style={styles.modelRow}
                  onPress={() => toggleModelSelection(item)}
                >
                  <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={checked ? '#3b82f6' : '#64748b'}
                  />
                  <Text style={styles.modelRowText}>{item}</Text>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.modalEmptyText}>Aucun agent ne correspond à cette recherche.</Text>
            }
          />

          <View style={styles.modalFooter}>
            <TouchableOpacity
              style={styles.modalClearButton}
              onPress={handleSelectAllFiltered}
            >
              <Text style={styles.modalClearButtonText}>
                Tout sélectionner{modelSearch.trim() ? ' (filtré)' : ''}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalClearButton}
              onPress={() => setPendingSelection(new Set())}
            >
              <Text style={styles.modalClearButtonText}>Tout désélectionner</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.modalApplyButton}
            onPress={handleApplyModelSelection}
          >
            <Ionicons name="checkmark" size={18} color="#ffffff" />
            <Text style={styles.testButtonText}>Valider la sélection</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 14,
    color: '#94a3b8',
    marginTop: 12,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  apiManagementButton: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 2,
    borderColor: '#10b981',
  },
  gitSyncButton: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 2,
    borderColor: '#f59e0b',
  },
  apiManagementLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  apiManagementTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#f8fafc',
    marginBottom: 4,
  },
  apiManagementSubtitle: {
    fontSize: 11,
    color: '#94a3b8',
    lineHeight: 16,
  },
  section: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  inputGroup: {
    marginBottom: 16,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#cbd5e1',
    marginBottom: 8,
  },
  fieldHint: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 6,
    lineHeight: 16,
  },
  input: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#f8fafc',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    marginTop: 8,
  },
  switchLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  testButton: {
    backgroundColor: '#3b82f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    gap: 8,
  },
  testButtonGreen: {
    backgroundColor: '#10b981',
  },
  testButtonPurple: {
    backgroundColor: '#7c3aed',
  },
  testButtonDisabled: {
    opacity: 0.6,
  },
  testButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  infoBox: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  infoText: {
    fontSize: 12,
    color: '#94a3b8',
    lineHeight: 18,
  },
  infoBold: {
    fontWeight: 'bold',
    color: '#cbd5e1',
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    marginTop: 12,
    gap: 8,
  },
  linkButtonText: {
    color: '#60a5fa',
    fontSize: 13,
    fontWeight: '600',
  },
  saveButton: {
    backgroundColor: '#10b981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    gap: 10,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#0f172a',
    padding: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#f8fafc',
    flex: 1,
    marginRight: 12,
  },
  modalSearchInput: {
    marginBottom: 12,
  },
  modalList: {
    flex: 1,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  modelRowText: {
    color: '#e2e8f0',
    fontSize: 14,
    flex: 1,
  },
  modalEmptyText: {
    color: '#64748b',
    textAlign: 'center',
    marginTop: 40,
    fontSize: 13,
  },
  modalFooter: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  modalClearButton: {
    flex: 1,
    backgroundColor: '#334155',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalClearButtonText: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '600',
  },
  modalApplyButton: {
    backgroundColor: '#3b82f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderRadius: 8,
    gap: 8,
    marginTop: 10,
  },
});
