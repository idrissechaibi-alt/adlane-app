# Adlane — Guide de Configuration Omniroute & Providers

## 🎯 Objectif
Configurer **Omniroute** (déjà fonctionnel sur Termux) avec l'app **Adlane** pour maximiser l'analyse et l'autolearning.

---

## 📱 Prérequis
- [x] **App Adlane** installée et fonctionnelle sur le téléphone
- [x] **Omniroute** fonctionnel sur Termux (dashboard accessible)
- [x] **Clés API** des fournisseurs IA prêtes (voir section Providers)

---

## ⚙️ Étape 1 : Configurer l'Endpoint dans l'App Adlane

1. Ouvrir l'app **Adlane**
2. Aller dans **Paramètres** (engrenage)
3. Section **Configuration Omniroute** :
   - **Endpoint** : `http://localhost:8000/v1`
     *(Si Omniroute est en mode réseau sur WiFi, utiliser l'IP locale de ton téléphone, ex: `http://192.168.1.X:8000/v1`)*
   - **Clé API** : Laisser vide ou saisir la clé d'Omniroute (si requise)
   - **Modèle actif** : `claude-3-5-sonnet` (par défaut)
   - **Activer** : Basculer le toggle sur ON
   - **Tester la connexion** : Valider → doit retourner ✅

---

## 🔧 Étape 2 : Configurer les Providers dans Omniroute

Dans le **Dashboard Omniroute** (sur Termux, via l'URL) :

1. Aller dans **Settings** / **Providers**
2. Ajouter chaque fournisseur avec ses clés API
3. Définir les priorités de fallback (voir liste ci-dessous)

### Configuration des Clés API

| Fournisseur | Endpoint Type | Clé API à insérer |
|-------------|---------------|-------------------|
| Anthropic (Claude) | REST | `ANTHROPIC_API_KEY` |
| OpenAI (GPT) | REST | `OPENAI_API_KEY` |
| DeepSeek | REST | `DEEPSEEK_API_KEY` |
| Groq (Llama) | REST | `GROQ_API_KEY` |
| Ollama (Local) | Local | `/O` |

---

## 🤖 Étape 3 : Liste des Providers Recommandés

Pour maximiser **l'efficacité** et **l'autolearning**, cette configuration est recommandée :

| Priorité | Provider | Modèle | Rôle dans Adlane | Prix / Coût |
|----------|----------|--------|------------------|-------------|
| **1** | **Anthropic** | Claude 3.5 Sonnet | Analyse principale, reasoning, respect des règles de sécurité | ~$3/million tokens |
| **2** | **OpenAI** | GPT-4o | Analyse rapide, fallback si Claude indisponible | ~$5/million tokens |
| **3** | **DeepSeek** | DeepSeek-V3 | Analyse économique, traitement par lots (batches) | ~$0.15/million tokens |
| **4** | **Groq** | Llama 3.1 70B | Analyse ultra-rapide, temps réel, vérification rapide | ~$0.59/million tokens |
| **5** | **Ollama** | Llama 3 (local) | Fallback hors ligne, confidentialité maximale | Gratuit (CPU/GPU local) |

### 🧠 Pourquoi ce choix ?

| Provider | Point Fort pour Adlane |
|----------|------------------------|
| **Claude 3.5 Sonnet** | Meilleure compréhension du contexte "football", moins d'hallucinations, respecte strictement "no betting advice" |
| **GPT-4o** | Vitesse et cohérence, bon pour les analyses de match en temps réel |
| **DeepSeek** | Rapport qualité-prix optimal pour les ré-analyses de données historiques |
| **Groq (Llama)** | Vitesse extrême (500 tokens/sec), idéal pour le feedback immédiat |
| **Ollama** | Protection des données (analyse locale, pas d'envoi au cloud) |

---

## 🔄 Étape 4 : Comprendre le Flux Autolearning

### Le Cycle d'Apprentissage

```
1. Match analysé
        │
        ▼
2. Adlane envoie données + "Leçons du Terrain" → Omniroute
        │
        ▼
3. IA (Claude) génère analyse probabiliste (JSON)
        │
        ▼
4. Validator vérifie les règles (BLOCK/WARN)
        │
        ▼
5. Si erreur détectée (ex: proba <50% → 1X2)
   → Leçon créée : "btts-equipe-en-disette"
        │
        ▼
6. Leçon stockée dans la base locale
        │
        ▼
7. Prochain match : Leçon injectée dans le prompt IA
   → IA évite de reproduire l'erreur
```

### Configuration Autolearning dans Omniroute

Pour que l'autolearning fonctionne correctement, configure Omniroute pour :

1. **Rendre les réponses persistantes** : Conserver les réponses JSON dans la base locale
2. **Enregistrer les erreurs** : Stocker les cas où le Validator a bloqué
3. **Injecter les leçons** : S'assurer que le prompt système contient bien `{{lessons}}` avant chaque requête

---

## ✅ Étape 5 : Tests de Validation

### Test 1 : Connexion Omniroute
1. App → Paramètres → Tester connexion
2. Résultat attendu : `✅ Omniroute OK`

### Test 2 : Analyse de Match
1. Aller dans **Scouting**
2. Sélectionner un match fictif (ex: Arsenal vs Chelsea)
3. Cliquer sur **Analyser**
4. Résultat attendu : Analyse JSON complète avec probabilité, odds, warnings

### Test 3 : Vérification du Autolearning
1. Créer une "Leçon" manuelle dans l'app (ex: `test-lecon-1`)
2. Analyser un nouveau match
3. Vérifier dans l'analyse IA que la leçon a été appliquée

---

## 📊 Résumé des Configuration à Activer

| Item | Valeur | Endroit |
|------|--------|---------|
| Omniroute Endpoint | `http://localhost:8000/v1` | Adlane → Paramètres |
| Modèle principal | `claude-3-5-sonnet` | Adlane → Paramètres |
| Activation Omniroute | ON | Adlane → Paramètres |
| Fallback API | ON | Adlane → Paramètres (API Football) |
| Fallback IA | ON | Dashboard Omniroute |
| Logging des analyses | ON | Dashboard Omniroute |

---

## 🔐 Sécurité & Confidentialité

1. **Clés API** : Stockées uniquement en local (Android Secure Storage / Termux)
2. **Données de match** : Jamais envoyées à des tiers hors API choisies
3. **Analyse IA** : Via Omniroute (proxy centralisé) — tu contrôles qui voit quoi
4. **Leçons** : Stockées localement sur l'app → jamais partagées automatiquement

---

## 🚀 Prochaines Étapes

1. Configurer les clés API providers dans Omniroute
2. Activer les providers dans Adlane
3. Tester une analyse complète
4. Observer le flux d'apprentissage sur les 3 premiers matchs analysés

**Félicitations !** Tu as maintenant un système d'analyse de paris football **autonome, auto-apprenant et sécurisé**.