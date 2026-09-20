// APP adlane - Point d'entrée principal (Fix Football Data Button)

import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import { initDatabase, seedDatabaseIfEmpty } from './src/database/storage';
import { startAutoSync } from './src/core/gitAutoSync';
import { ensureNotificationPermissions } from './src/core/notifications';
import { registerBackgroundAutoLearn, runAutoLearnTick } from './src/core/backgroundTasks';
import DashboardScreen from './src/screens/DashboardScreen';
import DailyPlanScreen from './src/screens/DailyPlanScreen';
import ScoutingScreen from './src/screens/ScoutingScreen';
import EvolutionScreen from './src/screens/EvolutionScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import APIManagementScreen from './src/screens/APIManagementScreen';
import GitSyncScreen from './src/screens/GitSyncScreen';
import FootballDataScreen from './src/screens/FootballDataScreen';

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

function SettingsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: '#1e293b' }, headerTintColor: '#f8fafc', headerTitleStyle: { fontWeight: 'bold' } }}>
      <Stack.Screen name="SettingsMain" component={SettingsScreen} options={{ headerShown: false }} />
      <Stack.Screen name="APIManagement" component={APIManagementScreen} options={{ title: 'Gestion des API' }} />
      <Stack.Screen name="GitSync" component={GitSyncScreen} options={{ title: 'Sauvegarde & IA' }} />
    </Stack.Navigator>
  );
}

// Pas rapide de 3 minutes, actif seulement quand l'app est ouverte. En
// arrière-plan c'est la tâche native (backgroundTasks.ts) qui prend le relais,
// au plancher imposé par Android (~15 min).
const FOREGROUND_TICK_INTERVAL_MS = 3 * 60 * 1000;

/**
 * `checkAutomatically: "ON_LOAD"` (app.json) télécharge une mise à jour OTA
 * en arrière-plan au démarrage, mais ne l'applique QUE au prochain
 * redémarrage froid — sans ce bloc, un correctif publié n'apparaît jamais
 * tant que l'utilisateur ne ferme/rouvre pas l'app une seconde fois après le
 * téléchargement, ce qui donne l'impression qu'un correctif "ne marche pas".
 * On force ici la vérification + le rechargement immédiat si une mise à jour
 * est disponible.
 */
async function applyPendingUpdate(): Promise<void> {
  if (!Updates.isEnabled) return; // build de développement : pas d'OTA
  try {
    const check = await Updates.checkForUpdateAsync();
    if (check.isAvailable) {
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync(); // relance l'app sur le nouveau bundle
    }
  } catch (error: any) {
    console.warn('[OTA] Vérification/application de mise à jour échouée:', error.message);
  }
}

export default function App() {
  useEffect(() => {
    const setupApp = async () => {
      try {
        await applyPendingUpdate();
        await initDatabase();
        await seedDatabaseIfEmpty();
        await startAutoSync();
        await ensureNotificationPermissions();
        await registerBackgroundAutoLearn();
      } catch (error) { console.error('Erreur initialisation App:', error); }
    };
    setupApp();

    const runTick = () => {
      runAutoLearnTick().catch((error) =>
        console.warn('Erreur tour auto-apprentissage:', error)
      );
    };
    runTick();
    const interval = setInterval(runTick, FOREGROUND_TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          tabBarIcon: ({ focused, color, size }) => {
            let iconName: string = 'ellipse';
            if (route.name === 'Planning') iconName = focused ? 'calendar' : 'calendar-outline';
            else if (route.name === 'Dashboard') iconName = focused ? 'stats-chart' : 'stats-chart-outline';
            else if (route.name === 'Scouting') iconName = focused ? 'sparkles' : 'sparkles-outline';
            else if (route.name === 'Évolution') iconName = focused ? 'analytics' : 'analytics-outline';
            else if (route.name === 'Paramètres') iconName = focused ? 'settings' : 'settings-outline';
            else if (route.name === 'Football') iconName = focused ? 'football' : 'football-outline';
            return <Ionicons name={iconName as any} size={size} color={color} />;
          },
          tabBarActiveTintColor: '#3b82f6',
          tabBarInactiveTintColor: '#64748b',
          tabBarStyle: { backgroundColor: '#1e293b', borderTopColor: '#334155', height: 65, paddingBottom: 8 },
          headerStyle: { backgroundColor: '#1e293b', borderBottomWidth: 1, borderBottomColor: '#334155' },
          headerTintColor: '#f8fafc',
        })}
      >
        <Tab.Screen name="Planning" component={DailyPlanScreen} options={{ title: 'Planning du Jour' }} />
        <Tab.Screen name="Dashboard" component={DashboardScreen} options={{ title: 'Bilan P&L' }} />
        <Tab.Screen name="Scouting" component={ScoutingScreen} options={{ title: 'Scouting IA' }} />
        <Tab.Screen name="Évolution" component={EvolutionScreen} options={{ title: 'Analyses' }} />
        <Tab.Screen name="Football" component={FootballDataScreen} options={{ title: 'Données Foot' }} />
        <Tab.Screen name="Paramètres" component={SettingsStack} options={{ title: 'Paramètres', headerShown: false }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
