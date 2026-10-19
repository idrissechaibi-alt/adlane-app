# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Préférences de l'utilisateur

- **Grill me / questions de cadrage** : poser les questions sous forme de cartes/fenêtres cliquables (outil AskUserQuestion) avec des choix à cliquer ou un champ à remplir (« Autre »), jamais un long texte à lire et à retaper. Recommandation en premier choix, libellés courts.

# PC de l'utilisateur (serveur de l'app)

- L'utilisateur a un PC **Windows** allumé et connecté en permanence, sur lequel il veut faire tourner le serveur de l'app (scans, règlement, bilans, rapports) pour ne plus dépendre du téléphone ouvert. Il donne l'accès complet à ce PC pour ça.
- Une session Claude **dans le cloud** (machine Linux « vm », effacée après inactivité) n'est PAS ce PC : ne jamais y installer un serveur « permanent ». Le serveur s'installe depuis une session Claude ouverte sur le PC lui-même (app Claude Desktop, ou `claude remote-control` dans un terminal du PC).
- Le serveur est dans `server/` (voir `server/README.md`) : installation sur le PC par `server/bootstrap.ps1`, tâche planifiée « adlane-serveur », icône « adlane serveur » sur le bureau, archive quotidienne dans `%USERPROFILE%\adlane-server\sauvegardes`.
- Choix de l'utilisateur (20/10) : le serveur ne fait que COLLECTER (stats minute par minute, résultats finaux, alerte Telegram 20e/60e des matchs réels) ; le téléphone garde l'analyse, les paris, les notifications, le règlement, l'apprentissage et le rapport du soir (`src/core/serverFeed.ts`).
