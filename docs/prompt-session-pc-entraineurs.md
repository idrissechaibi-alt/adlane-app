# Mission pour la session Claude sur le PC : le jeu des 96 entraîneurs, saison 2026-27

À coller tel quel dans une session Claude ouverte **sur le PC Windows** (Claude Desktop ou `claude` dans un terminal du PC).
La liste des vidéos est dans `docs/videos-entraineurs-2026-27.md` (même dépôt). Fais d'abord `git pull` dans le dossier de l'app
pour l'avoir à jour, puis lis-la en entier.

---

## Ta mission

L'app adlane analyse les matchs des 5 grands championnats (Premier League, Liga, Serie A, Bundesliga, Ligue 1). Pour chaque
équipe, elle doit connaître le jeu **réel** de son entraîneur **cette saison** : schémas, construction, pressing, transitions,
réactions aux différentes tactiques adverses, effet des changements en cours de match, et ce que tout cela donne dans les stats,
les compositions, le placement des joueurs et les cartes de chaleur.

Pour chacune des 96 équipes, la liste donne jusqu'à 10 vidéos **les plus récentes** qui analysent ou commentent ses matchs de
cette saison (analyses d'après-match, analyses tactiques, comptes rendus commentés, explications de l'entraîneur après le match),
réparties sur plusieurs matchs. Tu en produis la
**transcription exacte, mot pour mot, horodatée**, avec **la description de l'écran intercalée dans la transcription**. Tu ne
résumes rien. Une autre session Claude, dans le cloud, fera la synthèse à partir de tes fichiers.

Tu as l'autorisation de l'utilisateur d'installer ce qui est utile sur ce PC. Travaille en autonomie jusqu'au bout, sans poser de
question, sauf blocage réel.

## Règles non négociables

1. **Rien ne part sur GitHub, rien n'est publié.** Les vidéos sont des œuvres protégées, gardées pour un usage d'étude. Tout reste
   dans `%USERPROFILE%\adlane-recherche\entraineurs\`. L'utilisateur copiera lui-même les fichiers dans la conversation cloud.
   Ne fais aucun `git add`, `commit` ou `push` de ces fichiers.
2. **Pas de contournement de blocage.** Pas de proxy, de VPN, de rotation d'adresse, de cookies volés ni de faux navigateur.
   Connexion normale du PC. En cas de limite (erreur 429, « confirm you're not a bot ») : pause de 5 min, puis 30 à 60 s entre
   vidéos. Une vidéo qui reste inaccessible est notée, puis remplacée (voir « Vidéo indisponible »).
3. **Aucun secret** (jeton, clé) dans un fichier ou dans ta réponse.
4. **Rien d'inventé.** Passage inaudible : `[inaudible]`. Mot douteux : `[?mot]`. Ce que tu ne vois pas nettement à l'écran,
   tu l'écris (`joueur non identifiable`, `chiffre illisible`) au lieu de le deviner.
5. **Vidéos et images supprimées** après traitement : seule la transcription `.md` est gardée.

## LA RÈGLE QUI A ÉTÉ SAUTÉE LA DERNIÈRE FOIS : décrire l'écran

Lors des vidéos de priorité A, la partie « Ce qui est montré à l'écran » est restée **vide dans tous les fichiers**. Pour une vidéo
de tactique, c'est la moitié de l'information : l'analyste dit « regardez ce joueur » ou « ici » et c'est l'image qui dit qui et
où. **Un fichier sans description de l'écran est un fichier raté, à refaire.**

### Comment faire (obligatoire pour chaque vidéo)

1. Télécharge la vidéo en basse définition, pour l'étude locale seulement :
   `yt-dlp -f "bv*[height<=480]+ba/b[height<=480]" -o "tmp\%(id)s.%(ext)s" <url>`
2. Extrais les images :
   - une image toutes les **10 s** :
     `ffmpeg -i tmp\<id>.mp4 -vf "fps=1/10,scale=854:-1" tmp\<id>\t_%05d.jpg`
   - plus une image à chaque changement de plan :
     `ffmpeg -i tmp\<id>.mp4 -vf "select='gt(scene,0.35)',scale=854:-1" -vsync vfr -frame_pts 1 tmp\<id>\s_%05d.jpg`
   - le numéro de l'image donne l'horodatage (`t_00012` = 110 s, car la première image `t_00001` est à 0 s).
3. **Ouvre et regarde réellement chaque image** (outil de lecture d'image de Claude, ou skill `watch`). Ne décris pas d'après la
   parole : décris ce que tu vois.
4. Insère la description **dans la transcription, à sa place dans le temps**, sur une ligne qui commence par `ÉCRAN :` :

```
[00:04:10] And you can see here how they shift across when the ball goes wide.
[00:04:12] ÉCRAN : image de match arrêtée, Arsenal (rouge) sans ballon en 4-4-2 bloc médian, ligne défensive à ~35 m de son but ;
           flèches jaunes : Ødegaard monte sur le central gauche, Saka ferme le latéral ; adversaire (bleu) a 3 joueurs derrière
           la ligne du ballon ; score 1-0, 23e minute à l'incrustation.
[00:04:20] So the full-back is cut off and the only pass left is backwards.
```

### Ce que la description doit contenir quand c'est visible

- **Schéma et positions** : formation avec et sans ballon (ex. 4-2-3-1 qui devient 3-2-5), hauteur du bloc et de la ligne
  défensive, joueurs nommés ou numéros visibles, qui est où, distances entre lignes.
- **Mouvements** : flèches, appels, passes dessinées, zones surlignées, cercles autour des joueurs, « troisième homme ».
- **Graphiques et stats** : titre, axes, équipes, **toutes les valeurs lisibles** (possession, xG, tirs, PPDA, passes, duels,
  distances), légende, période ou matchs concernés.
- **Cartes de chaleur, positions moyennes, réseaux de passes** : quelles zones sont chaudes, quel couloir, quelle hauteur, quels
  joueurs reliés et avec quelle épaisseur.
- **Contexte du match** : équipes et couleurs, score et minute sur l'incrustation, qui a le ballon, phase de jeu
  (construction, pressing, transition, coup de pied arrêté).
- **Changements** : remplacement ou changement de système montré (avant/après), minute, effet affiché.
- **Compositions affichées** : recopie le onze et le schéma tels qu'ils sont à l'écran.
- Plan sans intérêt (présentateur face caméra, logo, publicité) : une seule ligne `ÉCRAN : présentateur face caméra`, puis rien
  jusqu'au plan suivant utile.

### Contrôle automatique avant d'enregistrer un fichier

Compte les lignes `ÉCRAN :` qui ne sont **pas** « présentateur face caméra », « logo » ou « publicité ».
- Il en faut **au moins une par minute de vidéo** d'analyse (une vidéo de 12 min → au moins 12).
- En dessous : reprends les images, ne livre pas le fichier.
- Note le compte dans l'en-tête (`ecrans_decrits: 27`).

## Transcription de la parole

Dans l'ordre, la première méthode qui marche :
1. sous-titres manuels de l'auteur (`yt-dlp --write-subs --sub-langs "en,fr,es,it,de" --skip-download`, ou
   `youtube-transcript-api`) ;
2. sous-titres automatiques (`--write-auto-subs`) ;
3. panneau « Transcription » de YouTube, dans le navigateur intégré de Claude ;
4. Whisper local sur l'audio de la vidéo déjà téléchargée (`faster-whisper`, langue détectée automatiquement : beaucoup de
   vidéos sont en espagnol, italien, allemand ou français ; garde la langue d'origine, **ne traduis pas**).

Réglage de Whisper : GPU NVIDIA → `distil-large-v3` ou `large-v3`, `float16` ; sans GPU → `int8`, `beam_size=1`,
`vad_filter=True`, `small` (multilingue, pas `small.en` puisque les langues varient). Mesure la vitesse sur la première vidéo et
note-la dans `ETAT.md`.

## Format d'un fichier

`transcriptions\<ligue>\<club>\<rang>_<id>.md` (ligue : PL, LIGA, SERIEA, BUNDES, L1 ; rang : 01 à 10 comme dans la liste)

```markdown
---
id: <id>
url: https://www.youtube.com/watch?v=<id>
titre: <titre exact>
chaine: <chaîne>
publiee: <AAAA-MM-JJ>
duree: <hh:mm:ss>
langue: <en|fr|es|it|de>
entraineur: <nom>
club: <club>
ligue: <PL|LIGA|SERIEA|BUNDES|L1>
matchs_analyses: [<équipe A x-y équipe B, date>, ...]   # d'après la vidéo, vide si aucun match précis
source_transcription: sous-titres manuels | sous-titres automatiques | panneau YouTube | whisper <modèle>
ecrans_decrits: <nombre>
relu: oui | non
---

## Transcription exacte avec l'écran

[00:00:00] <parole mot pour mot>
[00:00:05] ÉCRAN : <description>
...

## Index de repérage (pas un résumé)

- Schémas et formations montrés : <schéma, phase> → [horodatage]
- Stats et chiffres affichés ou cités : <valeur> → [horodatage]
- Changements en cours de match : <minute, qui, effet décrit> → [horodatage]
- Réactions à une tactique adverse : <adversaire, ce qui change> → [horodatage]
- Joueurs clés et rôles : <joueur, rôle> → [horodatage]
```

## Ordre de travail

La liste donne un rang de 1 à 10 par équipe (1 = la plus récente). Travaille **par vagues**, pour que chaque entraîneur soit
couvert vite :
1. vague 1 : rang 1 de tous les entraîneurs ;
2. vague 2 : rangs 2 et 3 ;
3. vague 3 : rangs 4 à 6 ;
4. vague 4 : rangs 7 à 10.

Dans une vague, suis l'ordre de la liste (Premier League, Liga, Serie A, Bundesliga, Ligue 1).

## Vidéo indisponible ou hors sujet

Si une vidéo est privée, supprimée, bloquée, ou si, à l'écoute, elle ne parle pas vraiment du jeu de cet entraîneur cette
saison (jeu vidéo Football Manager / EA FC, images de match sans commentaire, réaction de supporters sans analyse, pronostics,
rumeurs de transfert) : note-la dans `ETAT.md` avec la raison, puis remplace-la par **la plus récente analyse d'un match de cette
équipe qui n'est pas déjà dans la liste**. Recherche YouTube triée par date de mise en ligne (filtre « Trier par : date
d'importation »), requêtes « <club> match analysis », « <club> post match analysis », et dans la langue du championnat
(« analyse du match <club> », « análisis del partido <club> », « analisi partita <club> », « <club> Spielanalyse »). Garde-la si
elle date de cette saison (depuis le 1er juillet 2026), dure plus de 4 min et commente le jeu (schémas, pressing, construction,
changements, stats). Pas plus de 2 vidéos sur le même match. Note le remplacement dans `ETAT.md`.

**Mise à jour** : la liste date du 02/11/2026. À chaque nouvelle vague, ajoute en tête de chaque équipe les analyses de ses matchs
joués depuis (même méthode de recherche), pour rester sur les matchs les plus récents.

## Fichiers à copier pour la synthèse

- `a-copier\<ligue>\<club>-lot-1.md`, `-lot-2.md`… : les transcriptions d'**un seul entraîneur** mises bout à bout, **40 000
  caractères au plus par lot**, sans couper une vidéo en deux sauf si elle dépasse seule cette taille. Chaque lot commence par
  le nom de l'entraîneur, du club, et la liste des vidéos qu'il contient.
- À la fin de chaque vague : `a-copier\vague-<n>.zip` qui contient les lots de la vague. L'utilisateur ne peut envoyer que
  5 fichiers à la fois ; un zip par vague lui suffit.
- `a-copier\SOMMAIRE.md` : par ligue et par club, les lots et les vidéos de chacun.

## Suivi

- `catalogue.csv` : une ligne par vidéo (ligue, club, entraîneur, rang, id, titre, chaîne, date, durée, état, méthode,
  ecrans_decrits, remplaçante de).
- `ETAT.md` : vague en cours, vidéos faites, échecs et causes, remplacements, vitesse mesurée, temps passé. En cas de coupure,
  reprends grâce à `catalogue.csv` sans refaire ce qui est fait.
- À la fin de chaque vague, réponds en français avec : vidéos faites et ratées (cause), remplacements, nombre moyen de lignes
  `ÉCRAN :` par minute, chemin du zip. **Ne colle aucune transcription dans ta réponse.**

## Contrôle qualité de chaque fichier

- Le dernier horodatage est proche de la durée de la vidéo : rien n'est sauté.
- Aucun passage résumé ou reformulé ; seules les lignes `ÉCRAN :` sont écrites par toi.
- Au moins une ligne `ÉCRAN :` utile par minute (contrôle ci-dessus).
- Noms des joueurs et des clubs bien orthographiés (vérifie avec l'effectif du club si besoin).
- La langue d'origine est conservée.
