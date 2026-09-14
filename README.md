# APP adlane - Suivi & Analyse Probabiliste Football

Application mobile Android personnelle de suivi et d'analyse de paris football, avec IA connectée via **Omniroute** et apprentissage automatique à partir des erreurs réelles.

## 🎯 Philosophie & Cadre Éthique

**Cette application ne recommande JAMAIS de jouer.**

- ✅ Constat et analyse probabiliste uniquement
- ✅ Zéro conseil de mise, zéro staking, zéro montant suggéré
- ✅ Vocabulaire de certitude strictement interdit (« sûr », « garanti », « sans risque », « banker », « lock »)
- ✅ Aucune donnée inventée : si une stat manque, elle est marquée `donnée indisponible`
- ✅ Aucun pronostic publié après le coup d'envoi

## 📊 État Actuel (Source de Vérité §7)

Données vérifiées au 13/09/2026 :
- **10 paris réglés** : 4 gagnés / 6 perdus (**40.0 %**)
- **Mise totale** : 54.4 unités
- **Retour** : 66.365 unités
- **Net P&L** : **+11.965 unités**
- **ROI** : **+22.0 %**

Journée du 13/09 : 6 réglés (2V / 4D), mise 29.4 → **Net +6.045** (ROI +20.6%)

## 🧠 Les 4 Leçons Apprises (Règles Bloquantes)

1. **BTTS biaisé à la hausse** (3 occurrences) : Taux réel 40% vs 65% annoncé. Malus automatique si équipe en disette ou gardien en forme.
2. **Jambe 1X2 < 50% interdite** (2 occurrences) : Toute jambe 1X2 ou nul sous 50% est rejetée par le validateur.
3. **Fausse diversification** (1 occurrence) : Si un match apparaît dans > 2 slips → alerte (exposition corrélée).
4. **Garde-fou kickoff** (3 occurrences) : Impossible de publier un pronostic après le coup d'envoi (`now >= kickoff` = blocage).

## 🚀 Installation & Lancement

### Prérequis
- Node.js 26+ (déjà installé sur ton PC)
- Téléphone Android avec l'application **Expo Go** installée depuis le Play Store
- Omniroute lancé localement ou accessible via une URL distante (optionnel pour le mode fallback)

### 1. Lancer l'application

```powershell
cd "C:\Users\PC\Desktop\APP adlane"
npx expo start
```

Un QR Code s'affichera dans le terminal.

### 2. Sur ton téléphone Android

1. Ouvre l'application **Expo Go**
2. Scanne le QR Code affiché
3. L'application se lance immédiatement sur ton téléphone
4. Toutes les données sont stockées localement en SQLite dans ton téléphone

## 📱 Les 5 Écrans de l'Application

### 1. **Dashboard / Bilan P&L**
- Bilan cumulé et journée sélectionnée
- Historique complet des paris avec statuts (`WON`, `LOST`, `NON JOUÉ`)
- Analyse factuelle de chaque perte (cause chiffrée, jambe fautive)
- Chiffres de référence : +6.045 et +11.965 validés par les tests

### 2. **Scouting & Analyse IA**
- Formulaire de saisie de match (équipes, compétition, cotes bookmaker)
- Appel à l'IA via Omniroute avec injection des leçons apprises
- Affichage des probabilités estimées par marché
- Alertes automatiques (1X2 < 50%, BTTS mal calibré, marchés non historisés)
- Mode fallback si Omniroute n'est pas encore lancé

### 3. **Rapports & Évolution IA**
- **Onglet Calibration** : Taux prédit vs taux réel par marché (graphiques d'étalonnage)
- **Onglet Leçons** : Liste des 4 leçons avec occurrences et règles bloquantes
- **Onglet Rapport** : Rapport quotidien au format §5.5 (bannière, détail, cumul, leçon)

### 4. **Configuration Omniroute**
- URL de ton endpoint Omniroute (local ou distant)
- Clé API (optionnelle)
- Ajout et sélection des modèles IA disponibles (Claude, GPT, DeepSeek, Llama, Qwen, etc.)
- Bouton de test de connexion
- Infos sur le stockage 100% local

## 🔌 Connexion Omniroute

L'application envoie les requêtes d'analyse à ton Omniroute local ou distant.

### Configuration par défaut
```
URL : http://localhost:8000/v1
Clé API : (vide par défaut)
Modèle actif : claude-3-5-sonnet
```

### Modèles supportés
- Claude (Opus 5, Sonnet 5, Haiku 4.5)
- GPT-4o / GPT-4o-mini
- DeepSeek R1 / V3
- Qwen 2.5 (72B)
- Llama 3.3 (70B)
- Tous les modèles configurés dans ton Omniroute

Tu peux ajouter d'autres modèles directement depuis l'écran **Paramètres** de l'application.

## 🧪 Tests Unitaires

Les tests Jest vérifient les calculs financiers et les règles de validation :

```powershell
npm test
```

**Résultats attendus :** 7/7 tests passent ✅
- Bilan du jour 13/09 : +6.045
- Bilan cumulé : +11.965 (40.0%)
- Jambe void recalcule la cote (div-1 → 2.906)
- Validateur rejette div-3 (jambe nul à 27%)
- Lint de contenu bannit les mots interdits

## 📂 Structure du Projet

```
APP adlane/
├── src/
│   ├── types/           # Types TypeScript centraux
│   ├── core/
│   │   ├── ledger.ts       # Calculs financiers P&L
│   │   ├── validator.ts    # Règles bloquantes (4 leçons)
│   │   ├── calibration.ts  # Boucle d'apprentissage
│   │   ├── omniroute.ts    # Connecteur multi-modèles IA
│   │   └── reporter.ts     # Rapports quotidiens et amélioration
│   ├── database/
│   │   └── storage.ts      # Persistance locale SQLite + AsyncStorage
│   ├── data/
│   │   └── historical.ts   # 12 paris historiques + 4 leçons + calibrations
│   └── screens/
│       ├── DashboardScreen.tsx   # Bilan P&L
│       ├── ScoutingScreen.tsx    # Analyse IA
│       ├── EvolutionScreen.tsx   # Rapports & Calibration
│       └── SettingsScreen.tsx    # Config Omniroute
├── __tests__/
│   └── acceptance.test.ts   # Tests de non-régression §7
├── App.tsx                   # Point d'entrée + Navigation
├── CLAUDE.md                 # Règles permanentes du projet
├── HANDOFF-PARIS-FOOT.md    # Dossier de transfert complet
└── README.md                 # Ce fichier
```

## 🐙 Exporter vers GitHub

### 1. Initialiser Git

```powershell
cd "C:\Users\PC\Desktop\APP adlane"
git init
git add .
git commit -m "Initial commit - APP adlane v1.0.0

- Application mobile Android de suivi et analyse de paris football
- Connecteur Omniroute multi-modèles IA
- 4 leçons apprises implémentées comme règles bloquantes
- Boucle d'apprentissage et calibration par marché
- Stockage 100% local SQLite
- Tests Jest validés (7/7 passent)
- Conforme HANDOFF-PARIS-FOOT.md §0-§7"
```

### 2. Créer le dépôt sur GitHub

1. Va sur https://github.com/new
2. Nomme le dépôt : `app-adlane` (ou `sports-betting-tracker`)
3. **Ne coche RIEN** (ni README, ni .gitignore, ni licence)
4. Clique sur **Create repository**

### 3. Pousser le code

GitHub te donnera les commandes exactes. Elles ressembleront à :

```powershell
git remote add origin https://github.com/TON_USERNAME/app-adlane.git
git branch -M main
git push -u origin main
```

Remplace `TON_USERNAME` par ton nom d'utilisateur GitHub.

## 📦 Build de l'APK Android (Production)

Pour créer un fichier `.apk` installable sur ton téléphone sans Expo Go :

```powershell
npx eas build --platform android --profile preview
```

Nécessite un compte Expo (gratuit). L'APK sera téléchargeable depuis le tableau de bord Expo.

## 🔒 Sécurité & Données

- **100% stockage local** : SQLite + AsyncStorage sur ton téléphone
- **Aucune télémétrie** : Zéro donnée envoyée à un serveur externe (hors appels Omniroute pour analyse)
- **Aucune dépendance cloud** : L'application fonctionne entièrement hors ligne (sauf appel IA)
- **Clé API Omniroute** : Stockée en `secureTextEntry` (AsyncStorage)

## 📝 Conformité HANDOFF-PARIS-FOOT.md

✅ Tous les interdits absolus (§0) sont implémentés  
✅ Les 4 leçons (§4) sont codées comme règles bloquantes  
✅ Les 10 tests d'acceptation (§7) passent  
✅ Le modèle de données corrige les 3 dérives (§2.1)  
✅ Les chiffres de référence sont validés (+6.045 et +11.965)  
✅ Le lint de contenu bannit les mots interdits  
✅ Le garde-fou kickoff empêche les pronostics tardifs  

## 🛠️ Technologies Utilisées

- **React Native** (Expo 57) : Framework mobile cross-platform
- **TypeScript** : Typage strict et sécurité
- **SQLite** (expo-sqlite) : Base de données locale
- **AsyncStorage** : Stockage clé-valeur sécurisé
- **React Navigation** : Navigation entre écrans
- **Jest** : Tests unitaires et de non-régression

## 📞 Support

Pour toute question ou amélioration, contacte directement Adlene.

---

**APP adlane v1.0.0** • Conçu pour Adlene • Conforme au cadre éthique strict du dossier HANDOFF-PARIS-FOOT.md
