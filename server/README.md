# Serveur PC de l'app adlane

Fait tourner en continu, sur un PC Windows allumé, le même moteur que le téléphone (`src/core`) : scan des matchs réels
chaque minute, tour complet toutes les 3 min (pipe fictif, marqueurs, motifs), bilan de minuit, rapport Telegram de
23h30, sauvegardes GitHub (complète toutes les 30 min).

Tant que le serveur envoie son battement de cœur (`data/server/heartbeat.json`, toutes les 5 min), le téléphone se met
en retrait : il relit les résultats du serveur quand l'app est ouverte et lui transmet les saisies (cotes, lignes,
paris posés) via `data/server/inbox/`. Si le PC s'arrête plus de 20 min, le téléphone reprend tout seul.

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

`build.mjs` assemble `main.ts` et `src/core` avec esbuild ; les modules du téléphone sont remplacés par des
équivalents Node (`shims/`) : fichiers (expo-file-system), clés (expo-secure-store → secrets.json), base SQLite
(node:sqlite), notifications (journal ; les alertes passent par Telegram). Premier démarrage : reprise de toutes les
données depuis la dernière sauvegarde complète du téléphone (`data/full-backup`).

Test sans installer : `cd server && npm install && node build.mjs && node dist/server.js --once`.

## Icône du bureau et sauvegardes sur le PC

- **adlane serveur** (bureau) : état du serveur (en marche / arrêté), dernières lignes du journal, et boutons pour le
  relancer, faire une sauvegarde tout de suite, ouvrir les sauvegardes ou le journal.
- **Sauvegardes locales** : une archive .zip par jour de toutes les données (apprentissage, paris, base), dans
  `%USERPROFILE%\adlane-server\sauvegardes`, 30 jours gardés. Les clés n'y sont pas (elles restent dans `secrets.json`).
  Pour revenir à une sauvegarde : arrêter le serveur, remplacer le dossier `%USERPROFILE%\adlane-server\data` par celui
  de l'archive, relancer.
