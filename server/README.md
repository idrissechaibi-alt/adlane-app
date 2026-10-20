# Serveur PC de l'app adlane (collecteur)

Tourne en continu sur un PC Windows allumé et **collecte** : stats de chaque match en direct minute par minute (matchs
réels des 5 grands championnats et de la Ligue des champions chaque minute, les autres toutes les 5 min), avec les
marqueurs avancés (xG, touches dans la surface, momentum…), et le résultat final de chaque match terminé. Il publie le
tout toutes les 2 min dans `data/server/live/<jour UTC>/` ; le téléphone le rapatrie à chacun de ses réveils (même app
fermée, `src/core/serverFeed.ts`).

Le **téléphone garde** l'analyse, les paris proposés, les notifications, le règlement, l'apprentissage et le rapport du
soir. Quand un match réel atteint la 20e ou la 60e minute, le serveur envoie une alerte Telegram : ouvrir l'app lance
l'analyse tout de suite.

Le serveur garde aussi sur le PC une archive quotidienne de toutes les données de l'app (copie de la sauvegarde du
téléphone + collecte).

## Installation (une fois)

1. Dans l'app : **Paramètres → Sauvegarde & IA → « CONFIGURER LE SERVEUR PC » → Envoyer la configuration**, et
   envoie-toi le texte (il contient tes clés : à ne partager avec personne).
2. Sur le PC, ouvre **PowerShell** et lance :

   ```powershell
   irm https://raw.githubusercontent.com/idrissechaibi-alt/adlane-app/main/server/bootstrap.ps1 | iex
   ```

   Le script installe Git et Node.js si besoin, récupère le code dans `%USERPROFILE%\adlane-app`, te demande de coller
   la configuration, crée la tâche planifiée **adlane-serveur** (démarre avec ta session Windows, relance automatique),
   désactive la mise en veille sur secteur et lance le serveur.

## Au quotidien

- Journal : `%USERPROFILE%\adlane-server\logs\` (`serveur-AAAA-MM-JJ.log` et `console.log`).
- Données : `%USERPROFILE%\adlane-server\data\` ; clés : `%USERPROFILE%\adlane-server\secrets.json`.
- Mises à jour : toutes les 30 min, le serveur regarde si du nouveau code a été publié ; si oui, il s'arrête et le
  lanceur (`run-server.cmd`) récupère le code, reconstruit et relance.
- Arrêter / relancer : Planificateur de tâches → adlane-serveur, ou `Stop-ScheduledTask adlane-serveur` /
  `Start-ScheduledTask adlane-serveur`.

## Fonctionnement technique

`build.mjs` assemble `main.ts`, `collector.ts` et les sources de `src/` avec esbuild ; les modules du téléphone sont
remplacés par des équivalents Node (`shims/`) : fichiers (expo-file-system), clés (expo-secure-store → secrets.json),
base SQLite (node:sqlite), notifications (journal ; les alertes passent par Telegram).

Test sans installer : `cd server && npm install && node build.mjs && node dist/server.js --once` (un passage de collecte).

## Icône du bureau et sauvegardes sur le PC

- **adlane serveur** (bureau) : état du serveur (en marche / arrêté), dernières lignes du journal, et boutons pour le
  relancer, faire une sauvegarde tout de suite, ouvrir les sauvegardes ou le journal.
- **Sauvegardes locales** : une archive .zip par jour de toutes les données (copie de la sauvegarde du téléphone :
  apprentissage, paris, motifs, cotes saisies ; et collecte du serveur), dans
  `%USERPROFILE%\adlane-server\sauvegardes`, 30 jours gardés. Les clés n'y sont pas (elles restent dans `secrets.json`).
  La copie du téléphone est dans le dossier `copie-telephone` de chaque archive.

## Lire des sites web (module de collecte)

Le serveur peut lire des sites que tu déclares dans `%USERPROFILE%\adlane-server\sites.json` (modèle :
`server/sites.example.json`). Chaque site est relevé toutes les 30 s (`"every"` pour espacer), seuls les changements sont
gardés, et le tout est envoyé au téléphone toutes les 60 s (`data/server/web/<id>/…`, lu par
`src/core/serverFeed.ts` → `readWebFeed(id)`). Les adresses des sites ne sont jamais publiées : seulement l'identifiant et
les valeurs lues. Les relevés de plus de 3 jours sont retirés du dépôt.

Pour chaque site : `url`, `format` (`json`, `html` ou `text`) et ce qu'il faut en extraire :
- json : `items` = chemin vers la liste (`"events"`), `fields` = nom → chemin relatif (`"odds.home"`) ;
- html : `items` = sélecteur CSS de chaque ligne, `fields` = nom → `"sélecteur"` (texte) ou `"sélecteur@attribut"` ;
- text : `regex` à groupes nommés.

**Limite volontaire** : si un site refuse la lecture (403, 429, captcha, « accès refusé », blocage par pays), le module
s'arrête pour ce site et réessaie plus tard (5 min, puis jusqu'à 1 h). Il ne contourne rien : pas de VPN, de proxy,
d'imitation de navigateur ni de connexion à un compte.

Le dépôt GitHub est public : tout ce que le serveur y publie est lisible par n'importe qui.
