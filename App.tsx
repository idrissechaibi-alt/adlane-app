// APP adlane - Point d'entrée principal
// Navigation entre les 5 écrans : Dashboard, Scouting, Evolution, Paramètres

import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { initDatabase } from './src/database/storage';
import DashboardScreen from './src/screens/DashboardScreen';
import ScoutingScreen from './src/screens/ScoutingScreen';
import EvolutionScreen from './src/screens/EvolutionScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Tab = createBottomTabNavigator();

export default function App() {
  useEffect(() => {
    // Initialiser la base de données locale au démarrage
    initDatabase().catch(console.error);
  }, []);

  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          tabBarIcon: ({ focused, color, size }) => {
            let iconName: keyof typeof Ionicons.glyphMap;

            if (route.name === 'Dashboard') {
              iconName = focused ? 'stats-chart' : 'stats-chart-outline';
            } else if (route.name === 'Scouting') {
              iconName = focused ? 'search' : 'search-outline';
            } else if (route.name === 'Évolution') {
              iconName = focused ? 'analytics' : 'analytics-outline';
            } else if (route.name === 'Paramètres') {
              iconName = focused ? 'settings' : 'settings-outline';
            } else {
              iconName = 'ellipse';
            }

            return <Ionicons name={iconName} size={size} color={color} />;
          },
          tabBarActiveTintColor: '#3b82f6',
          tabBarInactiveTintColor: '#64748b',
          tabBarStyle: {
            backgroundColor: '#1e293b',
            borderTopColor: '#334155',
            borderTopWidth: 1,
            paddingBottom: 8,
            paddingTop: 8,
            height: 65,
          },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '600',
          },
          headerStyle: {
            backgroundColor: '#1e293b',
            borderBottomColor: '#334155',
            borderBottomWidth: 1,
          },
          headerTintColor: '#f8fafc',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
        })}
      >
        <Tab.Screen
          name="Dashboard"
          component={DashboardScreen}
          options={{ title: 'Bilan P&L' }}
        />
        <Tab.Screen
          name="Scouting"
          component={ScoutingScreen}
          options={{ title: 'Analyse IA' }}
        />
        <Tab.Screen
          name="Évolution"
          component={EvolutionScreen}
          options={{ title: 'Rapports IA' }}
        />
        <Tab.Screen
          name="Paramètres"
          component={SettingsScreen}
          options={{ title: 'Config Omniroute' }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
