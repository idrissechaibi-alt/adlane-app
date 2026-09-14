# Sauvegarde locale sur GitHub

## Ce que fait l’application

L’application conserve ses données de travail **sur le téléphone** dans SQLite. La fonction GitHub crée une **copie JSON de secours** dans le dépôt `idrissechaibi-alt/adlane-app` :

```text
data/app-adlane-data.json
```

- Une copie est créée au démarrage si la fonction est activée.
- Une nouvelle copie est créée toutes les **20 minutes**.
- Les données GitHub **ne sont jamais restaurées automatiquement** et ne peuvent donc pas écraser la base locale par surprise.
- Le token GitHub est enregistré localement dans le stockage chiffré Android (Expo SecureStore), jamais dans le dépôt Git ni dans les fichiers synchronisés.

## Configuration dans l’app

1. Ouvrir **Paramètres**.
2. Toucher **🔄 Sauvegarde GitHub**.
3. Créer un token GitHub à accès limité :
   - GitHub → **Settings** → **Developer settings** → **Personal access tokens**.
   - Limiter son accès au dépôt `idrissechaibi-alt/adlane-app`.
   - Donner uniquement la permission de lecture/écriture des contenus du dépôt.
4. Coller le token dans l’écran de l’application.
5. Vérifier `idrissechaibi-alt`, `adlane-app`, `main` et le dossier `data`.
6. Activer la sauvegarde puis toucher **Enregistrer la configuration**.
7. Toucher **Créer une sauvegarde maintenant** pour vérifier la connexion.

## Sécurité et limites

- Ne partagez jamais le token et ne le collez jamais dans un fichier du projet.
- La sauvegarde JSON est limitée à environ 900 Ko pour éviter les transferts trop importants vers l’API GitHub.
- Les fichiers de données locaux et les bases SQLite sont ignorés par Git grâce à `.gitignore`.
- Pour restaurer une sauvegarde à l’avenir, il faudra une procédure explicite avec validation ; elle n’est volontairement pas automatique.

## Validation technique

Après la correction du système de sauvegarde :

- `npx tsc --noEmit` : réussi.
- `npm test -- --runInBand` : 7 tests réussis.
