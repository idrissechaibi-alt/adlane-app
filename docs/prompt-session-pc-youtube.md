# Mission pour la session Claude sur le PC : transcrire les vidéos d'analyse football

À coller tel quel dans une session Claude ouverte **sur le PC Windows** (Claude Desktop ou `claude` dans un terminal du PC).
La session cloud ne peut pas le faire elle-même : YouTube bloque ses serveurs.

---

## Ta mission

Tu travailles pour l'app adlane : 5 entraîneurs IA analysent les matchs de foot (Guardiola en Premier League, Mourinho en Liga,
Klopp en Bundesliga, Ancelotti en Serie A, Luis Enrique en Ligue 1). Une autre session Claude, dans le cloud, construit leur savoir.
Elle a besoin du **contenu exact** de vidéos YouTube d'analyse de données et de tactique football.

Les résumés faits jusqu'ici n'ont pas servi : ils perdaient les définitions, les formules, les chiffres, les étapes de méthode et
les séquences tactiques. **Cette fois, tu ne résumes rien.** Tu produis la transcription exacte de chaque vidéo, mot pour mot,
horodatée, plus une description de ce qui est montré à l'écran (schémas, terrain, graphiques), parce que la parole seule ne suffit
pas pour une vidéo tactique.

Tu as l'autorisation de l'utilisateur pour installer tout ce qui est utile sur ce PC (Python, outils, skills). Travaille en
autonomie jusqu'au bout, sans poser de question, sauf blocage réel.

## Règles à respecter (non négociables)

1. **Tu ne pousses rien sur GitHub et tu ne publies rien.** Ce sont des œuvres protégées, gardées pour notre usage d'étude.
   Tout reste en local dans `%USERPROFILE%\adlane-recherche\`. L'utilisateur copiera lui-même les fichiers dans la
   conversation avec la session cloud, qui en fera la synthèse.
2. **Pas de contournement de blocage.** Pas de proxy, de VPN, de rotation d'adresse, de cookies volés ni de faux navigateur.
   Utilise la connexion normale du PC. Si YouTube limite (erreur 429, « confirm you're not a bot »), ralentis (pause de
   2 à 5 min, puis 30 à 60 s entre vidéos) et passe à la méthode suivante. Si une vidéo reste inaccessible, note-la et continue.
   Le navigateur intégré de Claude peut servir à ouvrir YouTube normalement, comme un utilisateur, pour lire le panneau
   « Transcription » ou voir les images. C'est l'usage prévu, pas un contournement.
3. **Aucun secret** (jeton GitHub, clés) dans un fichier, un commit ou ta réponse.
4. **Rien d'inventé.** Un passage inaudible s'écrit `[inaudible]`. Un mot douteux s'écrit `[?mot]`. Une transcription
   automatique non relue est marquée comme telle.

## Étape 0 : outillage (fais-le d'abord, vérifie chaque outil)

Installe et teste, dans cet ordre de préférence (outils libres et gratuits, aucune API payante) :

| Outil | Rôle | Installation |
|---|---|---|
| `yt-dlp` | métadonnées, sous-titres officiels ou automatiques, audio | `pip install -U yt-dlp` |
| `youtube-transcript-api` | sous-titres avec horodatage, sans télécharger la vidéo | `pip install -U youtube-transcript-api` |
| `ffmpeg` | extraction audio et images | `winget install Gyan.FFmpeg` |
| `faster-whisper` | transcription locale quand il n'y a aucun sous-titre (modèle `medium` ou `large-v3` si le PC suit, sinon `small`) | `pip install -U faster-whisper` |

Skills Claude à évaluer (lis leur SKILL.md avant d'installer, garde seulement ceux qui marchent sans clé payante) :
- `npx skills add marks97/youtube-transcribe@youtube-transcribe`
- `npx skills add zeropointrepo/youtube-skills@transcript` (écarte `transcriptapi` s'il exige une clé payante)
- `npx skills add shipshitdev/skills@youtube-video-analyst`
- `npx skills add kar2phi/video-lens@video-lens`
- les skills déjà disponibles dans le compte : `watch` (images + transcription d'une vidéo), `transcription-video-locale`
  (Whisper hors ligne), `crawl4ai` (pages web), `built-in-browser` (navigateur intégré de Claude).

Teste toute la chaîne sur une seule vidéo (par ex. `https://www.youtube.com/watch?v=Qkpr30zSpiE`) avant de lancer le reste.
Note dans `outils.md` ce qui marche, ce qui ne marche pas et pourquoi.

## Méthode pour chaque vidéo (dans cet ordre, la première qui réussit)

1. **Sous-titres manuels** (écrits par l'auteur) : `youtube-transcript-api`, ou `yt-dlp --write-subs --sub-langs "en,fr" --skip-download`.
2. **Sous-titres automatiques** : `yt-dlp --write-auto-subs`. Marque `source: sous-titres automatiques`.
3. **Panneau « Transcription » de YouTube** dans le navigateur intégré de Claude, copié tel quel.
4. **Whisper local** : `yt-dlp -x --audio-format m4a`, puis `faster-whisper` avec horodatage par segment. Marque
   `source: whisper <modèle>`. Supprime l'audio après la transcription.

Ensuite, pour toutes les vidéos de tactique ou de démonstration de données, **regarde les images** (skill `watch`, ou
`ffmpeg` avec une image toutes les 10 à 20 s, plus aux moments clés). Décris en tes propres mots ce que l'écran montre, avec
l'horodatage : le schéma de jeu (positions, flèches, mouvements), les graphiques (axes, valeurs, légende), le code affiché
(langage, bibliothèques, fonctions) et les formules. Ce sont souvent là que se trouvent les vraies leçons.

## Vitesse de Whisper (à régler avant de lancer un lot)

Mesure d'abord sur une vidéo de 9 min, puis garde le réglage le plus rapide dont la qualité reste bonne :
1. **GPU NVIDIA** (`nvidia-smi` répond) : `faster-whisper` avec `device="cuda"`, `compute_type="float16"`, modèle
   `distil-large-v3` ou `large-v3`. Compter 20 à 40 fois plus vite que la durée de la vidéo.
2. **Sans GPU** : `faster-whisper` avec `compute_type="int8"`, `cpu_threads` = nombre de cœurs, `beam_size=1`,
   `vad_filter=True`, modèle anglais `small.en` ou `distil-small.en`. Autre piste à mesurer : `whisper.cpp` (binaire Windows)
   avec un modèle quantifié `ggml-small.en-q5_1`, souvent plusieurs fois plus rapide que la durée de la vidéo sur un processeur
   récent.
3. Les sous-titres officiels restent la voie la plus rapide : réessaie-les **une fois par jour, sur une seule vidéo**. Si la
   limite (429) est levée, repasse dessus pour tout le reste. Jamais de contournement.

Produis `a-copier/lot-01.md` dès que les premières vidéos sont transcrites, sans attendre la fin de toute la phase : la
synthèse peut commencer pendant que la suite tourne.

## Format de sortie : un fichier par vidéo

`transcriptions/<chaine>/<AAAA-MM-JJ>_<id>_<titre-court>.md`

```markdown
---
id: Qkpr30zSpiE
url: https://www.youtube.com/watch?v=Qkpr30zSpiE
titre: <titre exact>
chaine: <nom de la chaîne>
publiee: <AAAA-MM-JJ>
duree: <hh:mm:ss>
langue: en
source_transcription: sous-titres manuels | sous-titres automatiques | panneau YouTube | whisper medium
relu: oui | non
themes: [xG, tracking, pressing, ...]
---

## Transcription exacte

[00:00:00] <texte mot pour mot du segment>
[00:00:27] <segment suivant>
...

## Ce qui est montré à l'écran

[00:03:12] <description du schéma, du graphique, du code ou de la formule affichés>
...

## Index technique (repérage, pas un résumé)

- Notions définies : <notion> → [horodatage]
- Formules et chiffres cités : <formule ou chiffre> → [horodatage]
- Données et outils : <jeu de données, bibliothèque, fonction> → [horodatage]
- Séquences de but ou de jeu décortiquées : <match, minute, mécanisme> → [horodatage]
```

L'index sert seulement à retrouver vite un passage. Il doit être exhaustif, pas sélectif.

Garde aussi un fichier `catalogue.csv` avec une ligne par vidéo trouvée : id, url, titre, chaîne, durée, date, thème, priorité
(A/B/C), état (à faire / transcrite / échec + raison), méthode utilisée.

## Ordre de travail (mis à jour le 02/11)

La liste à transcrire est dans `docs/videos-a-transcrire.md` : **priorité A d'abord, dans l'ordre du tableau**, puis B. Elle
remplace les phases 1 à 3 ci-dessous, qui restent pour mémoire. Saute la série de cours de mathématiques Friends of Tracking
(« Distance In R2 », « Euclidean Plane »…), sans apport football. Fais un lot `a-copier` toutes les 3 ou 4 vidéos.

## Phase 1 : les 13 vidéos Friends of Tracking manquantes

Commence par celles-ci : elles avaient échoué lors du premier passage.

```
Qkpr30zSpiE  aDARCLsWMBY  gwvG8vllkpw  tC2z28MjNl0  N9qZ-I63BL8  TCyahs5HRMM  Ep9wXQgAFaE
xyyZLs_N1F0  310_eW0hUqQ  wHOgINJ5g54  bpjLyFyLlXs  8TrleFklEsE  FZ_XTfezCH4
```

## Phase 2 : toute la chaîne Friends of Tracking, en transcription exacte

Les 33 vidéos déjà vues n'ont donné que des résumés : refais-les toutes au format ci-dessus. Liste complète de la chaîne :
`yt-dlp --flat-playlist --print "%(id)s|%(title)s|%(duration)s" https://www.youtube.com/@friendsoftracking755/videos`.

## Phase 3 : trouver d'autres vidéos du même genre

Cherche sur YouTube, dans le navigateur intégré ou avec `yt-dlp "ytsearch50:<requête>" --flat-playlist`, les vidéos qui
apprennent vraiment quelque chose de vérifiable sur :
- **l'analyse de données foot** : xG, xA, xT, VAEP, OBV, EPV, pitch control, PPDA, field tilt, modèles de passes, données de
  tracking et d'événements, StatsBomb, Opta, Wyscout, SkillCorner, Python (mplsoccer, kloppy, socceraction, databallpy), R ;
- **les mécanismes tactiques qui mènent aux buts** : construction depuis l'arrière, pressing et contre-pressing, troisième homme,
  demi-espaces, surcharges, transitions, coups de pied arrêtés, blocs défensifs, plans de jeu des entraîneurs (Guardiola,
  Mourinho, Klopp, Ancelotti, Luis Enrique, Arteta, De Zerbi, Xabi Alonso, Simeone…) ;
- **les conférences et cours** : StatsBomb Conference, OptaPro Forum, MIT Sloan Sports Analytics (football), cours
  Soccermatics, conférences universitaires.

Pistes de chaînes à explorer (vérifie chacune, ne te limite pas à elles) : Friends of Tracking, McKay Johns, Tifo Football,
Football Made Simple, Total Football Analysis, StatsBomb, The Coaches' Voice (masterclasses), conférences OptaPro et MIT Sloan.

Critères pour garder une vidéo (priorité A) : elle explique une méthode, une métrique, un modèle ou un mécanisme de jeu avec
des exemples concrets (données, schémas, séquences de match). Écarte le divertissement, les réactions, les résumés de match sans
analyse, les pronostics, les paris et les vidéos de moins de 4 min. Vise **150 vidéos au catalogue**, dont au moins **60 en
priorité A**. Transcris toutes les A, puis les B s'il reste du temps.

## Fichiers à copier pour la synthèse

L'utilisateur colle les résultats dans une conversation, qui a une taille limite. Prépare donc, en plus des fichiers par vidéo :
- `a-copier/lot-01.md`, `lot-02.md`… : les transcriptions mises bout à bout, **40 000 caractères au plus par lot**, sans couper
  une vidéo en deux sauf si elle dépasse seule cette taille (alors `lot-07a.md`, `lot-07b.md`). Chaque lot commence par la liste
  des vidéos qu'il contient. Priorité A et Friends of Tracking d'abord.
- `a-copier/SOMMAIRE.md` : la liste des lots, avec les vidéos et les thèmes de chacun.

## Suivi

- Tiens à jour `ETAT.md` : vidéos faites, échecs et leur cause, méthode utilisée, temps passé. En cas de coupure, reprends là où
  tu t'es arrêté grâce à `catalogue.csv`, sans refaire ce qui est déjà transcrit.
- À la fin, réponds en français avec :
  - combien de vidéos sont transcrites par méthode et combien ont échoué (avec la cause) ;
  - ce qui est relu et ce qui ne l'est pas ;
  - le nombre de lots dans `a-copier\` et le chemin du dossier.
  Ne colle aucune transcription dans ta réponse.

## Contrôle qualité de chaque fichier

- La transcription couvre toute la durée de la vidéo : le dernier horodatage est proche de la durée.
- Aucun segment résumé, reformulé ou sauté.
- Les termes techniques sont bien orthographiés (expected goals, Voronoi, Gaussian, logistic regression, half-space…). Si tu
  corriges une transcription automatique, tu ne corriges que les mots mal reconnus, jamais le sens.
- La partie « Ce qui est montré à l'écran » existe pour toute vidéo de tactique ou de démonstration de données.
