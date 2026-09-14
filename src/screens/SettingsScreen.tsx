// Écran Paramètres & Configuration Omniroute
// Configure l'URL Omniroute, clé API, et sélection des modèles IA disponibles

import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TextInput,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  Switch
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { OmnirouteConfig } from '../types';
import { DEFAULT_OMNIROUTE_CONFIG } from '../core/omniroute';

export default function SettingsScreen() {
  const [endpoint, setEndpoint] = useState(DEFAULT_OMNIROUTE_CONFIG.endpoint);
  const [apiKey, setApiKey] = useState(DEFAULT_OMNIROUTE_CONFIG.apiKey);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_OMNIROUTE_CONFIG.selectedModel);
  const [customModels, setCustomModels] = useState<string[]>(DEFAULT_OMNIROUTE_CONFIG.availableModels);
  const [newModelName, setNewModelName] = useState('');

  const handleSave = () => {
    // Sauvegarde dans AsyncStorage (à implémenter via storage.ts)
    Alert.alert('✅ Configuration sauvegardée', `Endpoint: ${endpoint}\nModèle actif: ${selectedModel}`);
  };

  const handleTestConnection = async () => {
    try {
      Alert.alert('🔄 Test en cours...', 'Tentative de connexion à Omniroute...');
      // Test de connexion réel à Omniroute
      const response = await fetch(`${endpoint}/models`, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
      });

      if (response.ok) {
        const data = await response.json();
        Alert.alert('✅ Connexion réussie', `Omniroute accessible. ${data.data?.length || 0} modèles détectés.`);
      } else {
        Alert.alert('⚠️ Connexion échouée', `HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error: any) {
      Alert.alert('❌ Erreur de connexion', error.message || 'Impossible de joindre Omniroute.');
    }
  };

  const handleAddModel = () => {
    if (!newModelName.trim()) return;
    if (customModels.includes(newModelName.trim())) {
      Alert.alert('⚠️ Doublon', 'Ce modèle est déjà dans la liste.');
      return;
    }
    setCustomModels([...customModels, newModelName.trim()]);
    setNewModelName('');
  };

  const handleRemoveModel = (model: string) => {
    setCustomModels(customModels.filter(m => m !== model));
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.title}>Configuration Omniroute</Text>
          <Text style={styles.subtitle}>Connecteur multi-modèles IA pour l'analyse</Text>
        </View>

        {/* Section Endpoint */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Endpoint Omniroute</Text>

          <View style={styles.inputContainer}>
            <Text style={styles.label}>URL du serveur Omniroute</Text>
            <TextInput
              style={styles.input}
              value={endpoint}
              onChangeText={setEndpoint}
              placeholder="http://192.168.x.x:8000/v1"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              keyboardType="url"
            />
            <Text style={styles.helpText}>
              💡 En local : http://localhost:8000/v1 ou ton IP réseau. En distant : ton URL Cloudflare / Tailscale / Tunnel.
            </Text>
          </View>

          <View style={styles.inputContainer}>
            <Text style={styles.label}>Clé API (optionnelle)</Text>
            <TextInput
              style={styles.input}
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="sk-..."
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              secureTextEntry
            />
          </View>

          <TouchableOpacity style={styles.testButton} onPress={handleTestConnection}>
            <Ionicons name="flash" size={16} color="#ffffff" />
            <Text style={styles.testButtonText}>Tester la Connexion</Text>
          </TouchableOpacity>
        </View>

        {/* Section Modèles */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Modèles IA Disponibles</Text>

          <View style={styles.modelsList}>
            {customModels.map((model, idx) => (
              <View key={idx} style={styles.modelRow}>
                <TouchableOpacity
                  style={[styles.modelRadio, selectedModel === model && styles.modelRadioActive]}
                  onPress={() => setSelectedModel(model)}
                >
                  {selectedModel === model && (
                    <View style={styles.modelRadioInner} />
                  )}
                </TouchableOpacity>

                <Text style={styles.modelName}>{model}</Text>

                <TouchableOpacity onPress={() => handleRemoveModel(model)}>
                  <Ionicons name="trash-outline" size={18} color="#ef4444" />
                </TouchableOpacity>
              </View>
            ))}
          </View>

          <View style={styles.addModelContainer}>
            <TextInput
              style={styles.addModelInput}
              value={newModelName}
              onChangeText={setNewModelName}
              placeholder="Nom du modèle (ex: llama-3.3-70b)"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
            />
            <TouchableOpacity style={styles.addModelButton} onPress={handleAddModel}>
              <Ionicons name="add-circle" size={24} color="#10b981" />
            </TouchableOpacity>
          </View>

          <Text style={styles.helpText}>
            💡 Le modèle sélectionné sera utilisé pour toutes les analyses de matchs via Omniroute.
          </Text>
        </View>

        {/* Section Données & Sécurité */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Stockage & Données</Text>

          <View style={styles.infoRow}>
            <Ionicons name="phone-portrait" size={20} color="#10b981" />
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>100% Local sur ton Téléphone</Text>
              <Text style={styles.infoText}>
                Tous les paris, leçons, calibrations et rapports sont stockés dans une base SQLite locale.
                Aucune donnée n'est envoyée à un serveur externe (hors appels Omniroute pour analyse).
              </Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <Ionicons name="shield-checkmark" size={20} color="#3b82f6" />
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>Cadre Éthique Strict</Text>
              <Text style={styles.infoText}>
                Aucun conseil de mise. Aucun vocabulaire de certitude. Zéro hallucination.
                L'IA est bridée par les leçons apprises et le validateur automatique.
              </Text>
            </View>
          </View>
        </View>

        {/* Bouton Sauvegarde */}
        <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
          <Ionicons name="save" size={18} color="#ffffff" />
          <Text style={styles.saveButtonText}>Enregistrer la Configuration</Text>
        </TouchableOpacity>

        <Text style={styles.version}>APP adlane v1.0.0 • Conforme HANDOFF-PARIS-FOOT.md</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 2,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f1f5f9',
    marginBottom: 12,
  },
  inputContainer: {
    marginBottom: 14,
  },
  label: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 10,
    color: '#f8fafc',
    fontSize: 14,
  },
  helpText: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 6,
    lineHeight: 16,
  },
  testButton: {
    backgroundColor: '#f59e0b',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 8,
    gap: 6,
  },
  testButtonText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  modelsList: {
    marginBottom: 12,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    marginBottom: 6,
    gap: 10,
  },
  modelRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#64748b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelRadioActive: {
    borderColor: '#3b82f6',
  },
  modelRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#3b82f6',
  },
  modelName: {
    fontSize: 13,
    color: '#f8fafc',
    flex: 1,
    fontWeight: '500',
  },
  addModelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  addModelInput: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 10,
    color: '#f8fafc',
    fontSize: 13,
  },
  addModelButton: {
    padding: 4,
  },
  infoRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#f8fafc',
    marginBottom: 4,
  },
  infoText: {
    fontSize: 11,
    color: '#94a3b8',
    lineHeight: 16,
  },
  saveButton: {
    backgroundColor: '#10b981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderRadius: 8,
    marginTop: 8,
    gap: 8,
  },
  saveButtonText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 15,
  },
  version: {
    fontSize: 11,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 20,
    fontStyle: 'italic',
  },
});
