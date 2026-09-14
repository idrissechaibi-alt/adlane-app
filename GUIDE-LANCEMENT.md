# 🚀 Guide de Lancement - APP adlane

## Étape 1 : Préparer ton téléphone Android

1. **Télécharge l'application Expo Go** depuis le Google Play Store
2. Ouvre l'application (tu n'as pas besoin de créer de compte)
3. Assure-toi que ton téléphone et ton PC sont sur le **même réseau WiFi**

## Étape 2 : Lancer le serveur de développement

Sur ton PC, ouvre PowerShell et lance :

```powershell
cd "C:\Users\PC\Desktop\APP adlane"
npx expo start
```

**Ce qui va se passer :**
- Le serveur Metro Bundler va démarrer
- Un **QR Code** va s'afficher dans le terminal
- L'application va se compiler (première fois : ~30 secondes)

## Étape 3 : Scanner le QR Code

1. **Sur ton téléphone**, ouvre l'application **Expo Go**
2. Appuie sur **"Scan QR Code"**
3. Scanne le QR Code affiché dans le terminal de ton PC
4. L'application **APP adlane** se lance directement sur ton téléphone !

## Étape 4 : Vérifier que tout fonctionne

### Écran Dashboard
- Tu devrais voir le bilan cumulé : **Net +11.965 u** (ROI +22.0%)
- Les 12 paris historiques s'affichent avec leurs statuts (GAGNÉ / PERDU / NON JOUÉ)
- Les analyses factuelles des pertes sont visibles

### Écran Scouting
- Teste avec un match exemple (Manchester City vs Arsenal)
- Clique sur **"Lancer l'Analyse Probabiliste"**
- Si Omniroute n'est pas lancé, un mode fallback local s'active automatiquement

### Écran Évolution
- Onglet **Calibration** : Tu vois les taux réels vs prédits (BTTS en statut "Suspect")
- Onglet **Leçons** : Les 4 leçons apprises s'affichent avec leurs occurrences
- Onglet **Rapport** : Le rapport quotidien du 13/09/2026

### Écran Paramètres
- Configure l'URL de ton Omniroute (ex: `http://192.168.1.X:8000/v1`)
- Teste la connexion avec le bouton "Tester la Connexion"
- Ajoute ou sélectionne des modèles IA

## 🔧 Résolution des Problèmes Courants

### Le QR Code ne s'affiche pas
```powershell
# Arrête le serveur (Ctrl+C) et relance avec :
npx expo start --clear
```

### "Unable to connect to Metro"
- Vérifie que ton téléphone et ton PC sont sur le même réseau WiFi
- Désactive temporairement le pare-feu Windows si nécessaire

### L'application plante au démarrage
```powershell
# Supprime le cache et relance :
npx expo start --clear
```

### Erreur de compilation TypeScript
```powershell
# Vérifie que tout compile :
npx tsc --noEmit
```

## 📱 Mode Production (APK Standalone)

Pour créer un fichier `.apk` installable sans Expo Go :

1. Crée un compte gratuit sur https://expo.dev
2. Installe EAS CLI :
```powershell
npm install -g eas-cli
eas login
```

3. Build l'APK :
```powershell
eas build --platform android --profile preview
```

L'APK sera disponible sur ton tableau de bord Expo (tu recevras un lien de téléchargement).

## 🧪 Lancer les Tests

Pour vérifier que les calculs financiers et les règles de validation fonctionnent :

```powershell
npm test
```

**Résultat attendu :** 7 tests passent ✅

## 🔌 Connecter Omniroute

### Option 1 : Omniroute en Local (sur ton PC)

1. Lance Omniroute sur ton PC (ex: port 8000)
2. Trouve l'adresse IP de ton PC sur le réseau local :
```powershell
ipconfig
# Cherche "Adresse IPv4" (ex: 192.168.1.15)
```

3. Dans l'app, va dans **Paramètres** → Configure :
```
URL : http://192.168.1.15:8000/v1
```

### Option 2 : Omniroute Distant (Tunnel / Cloud)

Si tu as exposé Omniroute via Cloudflare, Tailscale, ngrok, etc. :

```
URL : https://ton-domaine.com/v1
Clé API : ta_cle_si_necessaire
```

### Option 3 : Mode Fallback (Sans Omniroute)

Si Omniroute n'est pas accessible, l'application utilise automatiquement un mode d'analyse locale basé sur les règles et leçons apprises. Les calculs restent fonctionnels.

## 📊 Données de Test

L'application contient déjà :
- **12 paris historiques** (dont 10 réglés)
- **4 leçons apprises** avec leurs occurrences
- **5 calibrations de marchés** (1X2, BTTS, OU_2_5, corners, shots_on_target)

Tout est stocké dans `src/data/historical.ts` et chargé au démarrage.

## 🎯 Commandes Utiles

| Commande | Description |
|----------|-------------|
| `npm start` | Lance le serveur Expo |
| `npm test` | Exécute les tests Jest |
| `npm run android` | Lance directement sur un appareil Android connecté en USB |
| `npx tsc --noEmit` | Vérifie la compilation TypeScript |
| `npx expo start --clear` | Lance en nettoyant le cache |

## ✅ Checklist de Vérification

- [ ] Expo Go installé sur ton téléphone Android
- [ ] PC et téléphone sur le même WiFi
- [ ] `npx expo start` lancé sans erreur
- [ ] QR Code scanné et application ouverte
- [ ] Dashboard affiche +11.965 u (10 réglés, 40.0%)
- [ ] Les 4 écrans sont navigables (Dashboard, Scouting, Évolution, Paramètres)
- [ ] Les tests Jest passent (`npm test`)

## 📞 Besoin d'Aide ?

Si tu rencontres un problème :
1. Vérifie les erreurs affichées dans le terminal PowerShell
2. Vérifie les erreurs dans l'application Expo Go (secoue ton téléphone pour ouvrir le menu développeur)
3. Lance `npx expo start --clear` pour nettoyer le cache

---

**APP adlane v1.0.0** • Prêt à l'emploi sur ton téléphone Android
