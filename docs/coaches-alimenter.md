# Alimenter les entraîneurs IA

Les entraîneurs se nourrissent de quatre sources, sans nouvelle version de l'app :

1. **Banques de données (automatique)** : le serveur PC relit chaque jour les statistiques ouvertes de football-data.co.uk (5 grands championnats) et publie les moyennes par club dans `data/server/banks/club-stats.json`. Le téléphone les rapatrie toutes les 6 h au plus et les préfère aux chiffres embarqués.
2. **Nouveaux savoirs (dépôt)** : tout fichier `.json` déposé dans `scripts/coaches/inbox/` (liste de faits avec `topic` et `fact_fr`, comme `wave4-friendsoftracking.json`) est rapatrié par le téléphone et ajouté aux faits des dossiers. Les doublons sont ignorés.
3. **Leurs propres bilans** : après chaque match des 5 ligues, l'entraîneur note ce qu'il retient de chaque équipe, de certains joueurs, et ses leçons générales de ligue. Ces notes entrent dans le dossier des matchs suivants.
4. **Résultats de leurs verdicts** : les paris réglés mesurent si l'entraîneur avait raison ; son pouvoir ne s'active qu'avec des preuves.

Sauvegarde sur le PC : `<serveur>/base-equipes-joueurs/` (dossier daté + dossier « dernier »), créée chaque jour avec l'archive locale, ou à la demande avec `node server/dist/server.js --base-now`.
