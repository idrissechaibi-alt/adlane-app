# 🤖 Workflow Automatique - APP adlane

## Vue d'ensemble

L'application implémente un workflow automatisé en 3 phases quotidiennes :

1. **📊 Phase 1 : Scouting Initial** - Base de connaissances équipes avec patterns temporels
2. **🌅 Phase 2 : Scan Matinal (8h00 Algérie)** - Détection des matchs et regroupement par créneaux
3. **⚡ Phase 3 : Propositions T-90** - Génération automatique de combinés et solos validés

---

## Phase 1 : Base de Connaissance Équipes

### Objectif
Constituer une base de données locale sur le téléphone contenant toutes les statistiques nécessaires aux prédictions.

### Données stockées (`src/database/teamDatabase.ts`)
- **Stats globales** : overall / home / away (matchs joués, buts, xG, xGA, clean sheets, corners, fautes, cartons, tirs, possession)
- **Déroulé temporel des buts** : distribution par tranches de 15 minutes (0-15, 16-30, 31-45, 46-60, 61-75, 76-90+)
- **Patterns pré-événements** : contexte moyen avant un but/carton (nombre de tirs, index de pression, minute moyenne)
- **Forme récente** : 5 derniers matchs avec xG/xGA et résultats
- **Contexte actuel** : blessures, suspensions, style tactique, coach

### Équipes pré-chargées
- **Premier League** : Manchester City, Arsenal
- **Ligue 1** : PSG
- **Serie A** : Atalanta

### Exemple de pattern temporel
**Manchester City** : 25% de ses buts marqués entre 46-60 min (début 2e mi-temps), pression soutenue avec 3+ tirs dans les 8 minutes précédentes.

**Arsenal** : 25% de ses buts en fin de 1ère période (31-45 min), 45% sur coups de pied arrêtés.

---

## Phase 2 : Scan Matinal Automatique

### Déclenchement
🕗 **7h00 UTC = 8h00 heure Algérie** (fonction `executeMorningScan()`)

### Étapes
1. **Récupération des matchs** du jour pour les 5 championnats (PL, LL, SA, BL, L1)
2. **Actualisation de la data** : mise à jour des blessures/suspensions via API
3. **Regroupement par créneaux** : tolérance ±15 minutes pour les matchs synchronisés
4. **Stockage local** : `daily_schedule.json` en AsyncStorage

### Créneaux identifiés
Chaque créneau contient :
- `slotTimeDisplay` : "15:00", "20:00", etc. (heure Algérie)
- `matchesCount` : nombre de matchs dans le créneau
- `matches[]` : liste des matchs avec cotes 1X2, BTTS, O/U 2.5
- `isT90Reached` : false au scan, devient true à T-90 min
- `lineupsConfirmed` : devient true quand les compos officielles sont publiées

### Monitoring T-90
Vérification toutes les 30 secondes (`checkAndUpdateT90Status()`) :
- Compare `now >= kickoff - 90 min`
- Met à jour `isT90Reached = true` dès que l'heure est atteinte
- Déclenche la génération des propositions

---

## Phase 3 : Propositions T-90 (En cours)

### Déclenchement
⏰ **90 minutes avant chaque créneau**, dès que les compositions officielles sont disponibles

### Génération des propositions (`src/core/dailyWorkflow.ts`)

#### Étape 1 : Analyse Poisson individuelle
Pour chaque match :
- Calcul des probabilités via modèle de Poisson (expectedHomeGoals, expectedAwayGoals)
- Devigging des cotes (élimination de la marge bookmaker) pour obtenir les probabilités "justes"
- Calcul de l'edge : `edgeRatio = modelProb / fairMarketProb`

#### Étape 2 : Sélection des jambes candidates
Critères d'inclusion :
- **1X2 Domicile/Extérieur** : proba modèle ≥ 50% ET edge positif
- **Over 2.5** : proba modèle ≥ 55% ET edge positif
- **BTTS** : proba modèle ≥ 58% ET edge positif (mais confiance toujours "Faible" - §4.1)

#### Étape 3 : Construction des slips

**SOLOS** (1 jambe) :
- Générés pour chaque sélection validée individuellement
- Idéal pour les matchs isolés dans un créneau

**COMBINÉS** (2-4 jambes max) :
- Générés pour les créneaux avec ≥2 matchs synchronisés (±15 min)
- Sélection des jambes les plus solides (proba ≥ 55%, hors BTTS)
- Cote combinée = produit des cotes individuelles
- Respecte la règle : **max 4 jambes par combiné**

#### Étape 4 : Validation automatique
Chaque proposition passe par le validateur (`src/core/validator.ts`) :

**Règles de BLOCAGE** (slip rejeté ❌) :
- `BLOCK_1X2_SOUS_50` : jambe 1X2 avec proba < 50%
- `BLOCK_KICKOFF_DEPASSE` : match déjà commencé
- `BLOCK_COTE_MANQUANTE` : cote individuelle manquante

**Règles d'ALERTE** (slip accepté mais signalé ⚠️) :
- `WARN_BTTS_NON_CALIBRE` : BTTS avec historique de sous-performance
- `WARN_EXPOSITION_MATCH` : même match présent dans >2 slips
- `ERROR_AUTO_ANNULATION` : deux slips avec sélections opposées sur le même match

### Affichage dans l'app (`src/screens/DailyPlanScreen.tsx`)

L'écran **Planning du Jour** affiche :
- 📅 **Créneaux chronologiques** avec compte à rebours jusqu'à T-90
- 🎯 **Propositions SOLO** : badge bleu, 1 jambe, analyse de l'edge
- 🔗 **Propositions COMBINÉ** : badge violet, 2-4 jambes, cote totale
- ✅ **Slips validés** : bordure verte, prêts à être joués
- ❌ **Slips rejetés** : bordure rouge, motifs de blocage affichés
- ⚠️ **Alertes** : encadré orange avec les avertissements

---

## Phase 4 : Intégration Omniroute (À venir)

### Objectif
Connecter plusieurs modèles IA via Omniroute pour enrichir l'analyse et augmenter la puissance de prédiction.

### Outils AI prévus
1. **Vision par ordinateur** : analyse vidéo des 5 derniers matchs (intensité, pressing, transitions)
2. **Analyse de sentiment** : parsing des conférences de presse et actualités équipes
3. **Simulations Monte Carlo** : 10 000 simulations par match pour affiner les probabilités
4. **Modèles d'ensemble** : combinaison de plusieurs approches (Poisson, xG, réseaux de neurones)

### Configuration (`src/screens/SettingsScreen.tsx`)
- URL Omniroute : `https://api.omniroute.io` (ou instance locale)
- API Key : stockée en AsyncStorage sécurisé
- Sélection des modèles actifs : GPT-4, Claude, Gemini, Llama, etc.
- Mode fallback : si Omniroute indisponible, utilise uniquement Poisson local

---

## Règles métier intégrées (CLAUDE.md)

### Les 4 leçons apprises (issues de pertes réelles)

1. **Jambe 1X2 sous 50% = REJET TOTAL**
   - Occurrence : 3 fois sur les pertes historiques
   - Règle : `BLOCK_1X2_SOUS_50`

2. **BTTS non calibré = CONFIANCE DÉGRADÉE**
   - Occurrence : 5 fois (40% réel vs 57-67% prédit)
   - Règle : `WARN_BTTS_NON_CALIBRE`

3. **Exposition corrélée = ALERTE**
   - Occurrence : 2 fois (même match dans 3+ slips)
   - Règle : `WARN_EXPOSITION_MATCH`

4. **Auto-annulation = ERREUR DE CONSTRUCTION**
   - Occurrence : 1 fois (O2.5 Real Sociedad + U2.5 Sassuolo)
   - Règle : `ERROR_AUTO_ANNULATION`

### Interdits absolus (jamais négociables)
❌ Aucun conseil de mise, aucun vocabulaire de certitude, aucune donnée inventée, aucun pronostic après coup d'envoi

---

## Validation financière (Tests automatisés)

### Chiffres de référence
- **Journée 13/09/2026** : 6 réglés, 2 gagnés → +6.045 unités
- **Cumul** : 10 réglés, 4 gagnés (40.0%) → +11.965 unités

### Tests Jest (`__tests__/acceptance.test.ts`)
✅ **7 tests passent** :
1. Net jour +6.045 et cumul +11.965
2. Calcul automatique des cotes effectives
3. Jambe void recalcule la cote (div-1 : 2.906)
4. Blocage jambe 1X2 sous 50% (div-3)
5. Cote combinée = produit des jambes non-void
6. Analyse factuelle des pertes (sans données inventées)
7. Lint de contenu bloque les termes de certitude

---

## Architecture technique

### Stack
- **React Native** avec Expo SDK 51
- **TypeScript** pour la sécurité des types
- **SQLite** (expo-sqlite) pour le stockage local persistant
- **AsyncStorage** pour les fichiers JSON (daily_schedule, teams_database, config)
- **React Navigation** (bottom tabs) pour la navigation
- **Jest** pour les tests unitaires et de validation

### Fichiers clés
```
src/
├── core/
│   ├── poisson.ts           # Modèle probabiliste (Poisson, devigging, edge)
│   ├── validator.ts         # Règles de blocage et alertes
│   ├── dailyWorkflow.ts     # Génération des propositions
│   └── scheduler.ts         # Scan matinal et monitoring T-90
├── database/
│   ├── storage.ts           # Persistence SQLite
│   └── teamDatabase.ts      # Base de connaissances équipes
├── screens/
│   ├── DailyPlanScreen.tsx  # 🆕 Planning & Propositions du jour
│   ├── DashboardScreen.tsx  # Bilan P&L historique
│   ├── ScoutingScreen.tsx   # Analyse IA manuelle (Omniroute)
│   ├── EvolutionScreen.tsx  # Calibration & Leçons apprises
│   └── SettingsScreen.tsx   # Configuration Omniroute
└── types/
    ├── index.ts             # Types métier (Bet, BetLeg, Market)
    └── database.ts          # Types base équipes (TeamKnowledge, Patterns)
```

---

## Prochaines étapes

### Court terme (Phase 3 complète)
- [ ] Connecter une vraie API football (API-Football, TheOddsAPI, Football-Data)
- [ ] Récupérer les compositions officielles à T-90
- [ ] Implémenter le calcul dynamique de `expectedHomeGoals/awayGoals` depuis la base équipes
- [ ] Ajouter un système de notifications push à T-90

### Moyen terme (Phase 4)
- [ ] Intégrer Omniroute avec plusieurs modèles IA
- [ ] Enrichir la base équipes avec plus d'équipes des 5 ligues
- [ ] Ajouter l'analyse vidéo et sentiment pour affiner les prédictions
- [ ] Créer un écran "Analyse détaillée" par match avec tous les indicateurs

### Long terme
- [ ] Historiser toutes les propositions pour mesurer la précision réelle
- [ ] Affiner le calibrage par marché (1X2, O/U, BTTS) avec feedback automatique
- [ ] Implémenter un système de backtesting sur saisons passées
- [ ] Ajouter des graphiques de performance par championnat/équipe/marché

---

## Commandes utiles

```bash
# Lancer l'app en dev
cd "C:\Users\PC\Desktop\APP adlane"
npx expo start

# Vérifier TypeScript
npx tsc --noEmit

# Lancer les tests
npm test

# Build Android
eas build --platform android

# Mettre à jour GitHub
git add .
git commit -m "Phase 3: DailyPlanScreen + T-90 proposals"
git push origin main
```

---

## Contact & Support

Projet personnel pour **Adlane** (idrissechaibi-alt)  
Repo GitHub : https://github.com/idrissechaibi-alt/adlane-app

**Rappel éthique** : Cette application est un outil d'analyse et de suivi. Elle ne conseille jamais de jouer, ne garantit aucun résultat, et ne recommande aucune mise. L'utilisateur reste seul responsable de ses décisions.
