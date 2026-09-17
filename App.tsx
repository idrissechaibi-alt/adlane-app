// APP adlane - Point d'entrée principal (Fix Football Data Button)

import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { initDatabase, seedDatabaseIfEmpty } from './src/database/storage';
import { startAutoSync } from './src/core/gitAutoSync';
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

export default function App() {
  useEffect(() => {
    const setupApp = async () => {
      try {
        await initDatabase();
        await seedDatabaseIfEmpty();
        await startAutoSync();
      } catch (error) { console.error('Erreur initialisation App:', error); }
    };
    setupApp();
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
