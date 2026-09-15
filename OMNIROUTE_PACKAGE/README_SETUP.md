# Adlane — Guide de Configuration Omniroute (Termux)

## 📱 Ton Setup

```
[Adlane App] → [Omniroute sur Termux] → [Modèles IA (Claude, GPT, DeepSeek...)]
     Android              Ton tél
```

---

## 1. Trouver l'URL d'Omniroute

Quand tu lances Omniroute dans Termux, il t'affiche une URL. Exemples :

| Type | URL |
|------|-----|
| Local (même téléphone) | `http://localhost:8000/v1` |
| Ngrok (accès public) | `https://xxxx-xxxx.ngrok.io/v1` |
| Local network (autre appareil même WiFi) | `http://192.168.x.x:8000/v1` |

---

## 2. Modifier l'endpoint dans Adlane

Dans **APIManagementScreen** de l'app Adlane, tu peux changer l'URL Omniroute.

Ou crée un fichier `OMNICONFIG.json` à la racine de l'app :

```json
{
  "endpoint": "TON_URL_OMNIROUTE",
  "apiKey": "ta_cle_api_si_necessaire",
  "selectedModel": "claude-3-5-sonnet"
}
```

---

## 3. Configurer Omniroute sur Termux

### Démarrer Omniroute :
```bash
cd ~/omniroute
python main.py
```

### URL typique :
```
http://localhost:8000/v1
```

### Pour accès réseau (autre appareil même WiFi) :
Trouve d'abord ton IP :
```bash
ifconfig
# Cherche wlan0 → inet adr: 192.168.x.x
```

Puis lance avec :
```bash
python main.py --host 0.0.0.0 --port 8000
```

Accès depuis Adlane : `http://192.168.x.x:8000/v1`

### Pour accès public (ngrok) :
```bash
ngrok http 8000
# Copie l'URL https://xxxx.ngrok.io
```

Accès depuis Adlane : `https://xxxx.ngrok.io/v1`

---

## 4. Modèles Disponibles

Omniroute doit être configuré avec tes clés API :

| Modèle | Provider | Clé à configurer |
|--------|----------|-----------------|
| claude-3-5-sonnet | Anthropic | ANTHROPIC_API_KEY |
| gpt-4o | OpenAI | OPENAI_API_KEY |
| deepseek-r1 / v3 | DeepSeek | DEEPSEEK_API_KEY |
| qwen-2.5-72b | Alibaba | DASHSCOPE_API_KEY |
| llama-3.3-70b | Groq / Together | GROQ_API_KEY |

Dans le dashboard Omniroute :
1. Va dans **Settings** / **API Keys**
2. Ajoute tes clés pour les providers que tu veux utiliser
3. Sélectionne le modèle par défaut

---

## 5. Valider la connexion

Test rapide depuis Termux :
```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Dis 'OK' en un mot"}]
  }'
```

Si tu as `{"choices":...` en réponse → connexion OK ✅

---

## 6. Tracker le Build EAS

Build ID : `3092f538-6e10-4f4a-b55c-1b5257b584e0`

Vérifie le statut :
👉 https://expo.dev/accounts/adlane300/projects/adlane-app/builds/3092f538-6e10-4f4a-b55c-1b5257b584e0

---

## 7. Fichiers Adlane pour Omniroute

Les fichiers dans ce dossier (`OMNIROUTE_PACKAGE/`) :
- `CONFIG.json` — Configuration complète Adlane
- `PROMPT_SYSTEME_COMPLET.md` — Prompt système à charger dans Omniroute
- `LESSONS.json` — Leçons du terrain (mémoire des erreurs)
- `CONNEXION_OMNIROUTE.md` — Ce fichier

Tu peux importer le `PROMPT_SYSTEME_COMPLET.md` dans le dashboard Omniroute comme template de système.