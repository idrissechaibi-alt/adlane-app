# Leçons des vidéos Friends of Tracking

122 fiches tirées de 33 vidéos de la chaîne https://www.youtube.com/@friendsoftracking755 (résumés reformulés, aucune transcription publiée). Source des données : `scripts/coaches/inbox/wave4-friendsoftracking.json`, intégrées à la base des entraîneurs (`src/core/coaches/data/facts.json`).

13 vidéos restent à lire (YouTube a refusé leurs sous-titres) : Distance In R2, Euclidean Plane, trailer Vosse de Boode, présentation PSG, SkillCorner, Player rank, Valuing actions 2, Valuing actions intro, Ultimate Guide to Expected Goals, xG model 1 et 2, Introduction tracking data in python, Setting Up to do Data Science.


## Voronoi Diagrams
https://www.youtube.com/watch?v=MIGQFcVO7-s

### Diagramme de Voronoï : zone contrôlée par un joueur
Le diagramme de Voronoï attribue à chaque joueur l'ensemble des points du terrain qui sont plus proches de lui que de tout autre joueur. C'est la première approximation de la zone qu'un joueur contrôle, et la réunion des zones d'une équipe donne son emprise sur le terrain. L'intervenant le décrit comme une première approche, déjà utilisée ailleurs (circonscriptions électorales, implantation d'hôpitaux).

- **Principe** : Le joueur le plus proche d'un point est supposé y arriver le premier.
- **En direct** : Sans positions des joueurs, on ne peut pas le calculer en direct. On peut seulement lire son équivalent indirect : touches dans la surface adverse, passes dans le camp adverse et possession indiquent quelle équipe occupe l'espace.
- **Limite** : Ignore la vitesse et l'orientation des joueurs : l'intervenant précise que des modèles plus sophistiqués (pitch control) en tiennent compte.
- Confiance : haute

### Limites du Voronoï : vitesse et orientation ignorées
Pour la zone réellement contrôlée, il faudrait tenir compte de la direction de course, de l'orientation du corps et de la vitesse maximale du joueur. Un défenseur plus lent mais plus proche peut perdre la course contre un attaquant lancé. Le Voronoï reste donc un point de départ, pas une mesure de contrôle réel.

- **Principe** : Proximité n'est pas contrôle : le temps d'arrivée dépend de la vitesse et de la direction.
- **En direct** : Méfiance envers toute lecture « géométrique » du terrain faite à partir de simples comptages : une domination en possession ne dit pas qui contrôle les zones dangereuses.
- **Limite** : Propos de cours d'introduction, sans chiffres.
- Confiance : haute


## Soccer Fields And The Euclidean Plane
https://www.youtube.com/watch?v=6UBeRHNzYo0

### Repère du terrain : dimensions et unités
Un terrain mesure typiquement environ 125 m sur 85 m dans le cours (136 sur 93 yards), avec une petite variance selon les stades. Chaque joueur est un point (x, y) dans le plan, par exemple (77, 55) pour un joueur placé aux trois quarts de la longueur.

- **Principe** : Avant d'utiliser des positions, il faut connaître les dimensions du terrain et l'unité.
- **En direct** : Quand une source donne des positions en yards ou en mètres, convertir avant de comparer deux fournisseurs de données.
- **Limite** : Les dimensions réelles varient selon les stades ; 125 x 85 est une convention de cours.
- Confiance : haute

### Pièges d'orientation et d'origine des coordonnées
Le même joueur peut avoir des coordonnées (77, 55) ou (55, 77) selon que l'axe long est horizontal ou vertical, ou que l'origine est placée dans un coin ou au centre. Il faut aussi vérifier si le repère est reflété. Les mélanger sans le savoir fausse toutes les distances et zones calculées.

- **Principe** : Toujours vérifier où est l'origine, quel axe est le long et quelle unité est utilisée.
- **En direct** : Dans un flux de stats minute par minute, vérifier que « domicile » et « extérieur » ne sont pas inversés avant d'interpréter un déséquilibre de tirs ou de possession.
- **Limite** : Mise en garde générale de l'intervenant, sans lien direct avec un flux de comptages.
- Confiance : moyenne


## Exporting your pass flow map to Tableau
https://www.youtube.com/watch?v=aibBF0BuzBU

### Carte de flux de passes : lecture et construction dans Tableau
La vidéo montre comment exporter les passes d'un joueur (exemple : les passes de Messi) vers un tableur puis les tracer dans Tableau sur un fond de terrain, en dessinant des segments dont l'épaisseur indique le sens (extrémité large = réception). La couleur reflète le nombre de passes dans une même zone de départ.

- **Principe** : Une carte de flux résume où un joueur reçoit et distribue le ballon, avec la fréquence par couloir.
- **En direct** : Sans coordonnées des passes, utiliser plutôt les passes dans le camp adverse et la possession pour approcher l'idée de « où l'équipe fait vivre le ballon ».
- **Limite** : Tutoriel d'outil : peu d'enseignement analytique, il illustre surtout la visualisation.
- Confiance : moyenne


## Making heat maps of actions
https://www.youtube.com/watch?v=VbisEW4r56g

### Cartes de chaleur à 5 couloirs et 5 hauteurs
L'intervenant découpe le terrain en 5 couloirs (deux ailes, deux demi-espaces, l'axe) et 5 hauteurs, une grille que les entraîneurs comprennent intuitivement. Une grille 10 x 10 est possible mais ne correspond plus à la façon dont les coachs voient le jeu. Le demi-espace face au but est vu comme une zone clé à contrôler en attaque.

- **Principe** : Une résolution de 5 x 5 suffit pour parler le langage des entraîneurs.
- **En direct** : Rattacher les chiffres du flux aux zones : touches dans la surface et centres renseignent le couloir/zone de danger, passes dans le camp adverse la hauteur atteinte.
- **Limite** : Choix de résolution défendu comme convention, pas comme règle.
- Confiance : moyenne

### Ne regarder que les passes proches d'un tir
Cartographier toutes les passes de l'Angleterre féminine montre surtout qu'elle joue dans son camp, ce qui n'apprend rien. En ne gardant que les passes des 15 secondes avant un tir, un schéma apparaît : l'attaque passe nettement plus par le côté droit (Lucy Bronze très présente). Sans comparaison avec d'autres équipes ni filtre de qualité, la lecture reste partielle.

- **Principe** : Filtrer sur ce qui précède un tir révèle comment une équipe crée vraiment ses occasions.
- **En direct** : Dans le flux, privilégier les signaux proches du tir (tirs, tirs cadrés, touches dans la surface, centres) plutôt que la possession brute, qui ne dit pas où se crée le danger.
- **Limite** : Tous les tirs comptent pareil dans cette analyse ; l'intervenant propose de ne garder que les occasions d'au moins 5 à 7 % de xG.
- Confiance : haute

### Seuil de xG de 5 à 7 % pour une « vraie occasion »
Pour affiner l'analyse, il propose de ne retenir que les tirs dépassant environ 5 à 7 % de xG, qu'il juge être le seuil habituel d'une bonne occasion, même si le chiffre paraît faible. Ce sont les situations qu'une équipe veut multiplier.

- **Principe** : Un tir à moins de 5 % de xG est rarement une vraie occasion.
- **En direct** : Dans le flux : un tir lointain ou bloqué pèse peu ; ce sont les tirs cadrés, les touches dans la surface et les corners enchaînés qui indiquent une montée du xG.
- **Limite** : Seuil donné de mémoire, à calibrer sur nos données.
- Confiance : moyenne

### Style de jeu, pas jugement de qualité
Le message répété : ces cartes décrivent comment joue une équipe (contre-attaque ou jeu de possession en phase finale) sans dire que c'est bon ou mauvais. Un tir précédé de peu de passes signale une contre-attaque. Le tempo de passes se calcule en divisant le nombre de passes d'une séquence par sa durée. Même Liverpool, selon lui, intègre le xG sans toujours l'afficher.

- **Principe** : Décrire le style avant de juger : un indicateur sert à caractériser, pas à optimiser.
- **En direct** : Avant d'interpréter possession et passes dans le camp adverse, se demander si l'équipe domine ou si elle attend la contre-attaque : possession faible + tirs cadrés peut être un plan, pas une faiblesse.
- **Limite** : Réponses orales à des questions du public, sans chiffres.
- Confiance : haute


## Pattern matching in football event data
https://www.youtube.com/watch?v=r7frxADMgO8

### Rechercher des séquences d'événements avec des expressions régulières
Chaque événement (passe, tir) est encodé par une lettre ; une séquence de match devient une chaîne de caractères sur laquelle on applique une expression régulière. Exemple : chercher « passe puis tir » dans un match de Barcelone (données StatsBomb ouvertes) renvoie 27 séquences en quelques millisecondes.

- **Principe** : Une séquence de jeu se retrouve comme un motif dans une chaîne de lettres.
- **En direct** : Même idée sur un flux minute par minute : repérer des motifs (série de corners puis tir cadré, faute puis carton) plutôt que des totaux isolés.
- **Limite** : Outil de code (bibliothèque kloppy), pas un modèle prédictif.
- Confiance : moyenne

### Ajouter l'équipe et la zone au motif
Un premier motif trouve aussi des passes d'une équipe suivies d'un tir de l'autre : il faut coder l'équipe dans la lettre et utiliser une référence arrière pour exiger la même équipe. En ajoutant sept zones, on cherche par exemple « une ou plusieurs passes dans la zone 1 puis un tir ». L'analyse montre ainsi d'où partent les dernières passes avant un tir dans la surface (surtout des zones centrales).

- **Principe** : Le même motif n'a de sens que pour une seule équipe et dans une zone précise.
- **En direct** : Ne jamais mélanger les chiffres des deux équipes : un tir cadré de l'adversaire après une faute ne dit rien de la pression de l'équipe qui a commis la faute.
- **Limite** : Annonce d'un second tutoriel pour intégrer le temps (vitesse de récupération), non vu ici.
- Confiance : moyenne

### Utilité : mesurer la fréquence et alimenter l'analyse vidéo
Les motifs permettent de compter à quelle fréquence une situation arrive (ex. assists des tirs dans la surface venant plutôt des zones 2 à 4 que des ailes extrêmes) et d'exporter les séquences vers un outil vidéo pour voir les scènes.

- **Principe** : Un motif compté sur un match entier devient une tendance exploitable.
- **En direct** : En direct, compter la fréquence d'un motif depuis le début du match pour éviter de réagir à un événement isolé.
- **Limite** : Exemple sur un seul match : à ne pas généraliser.
- Confiance : faible


## Analysing defensive positioning and attacking runs
https://www.youtube.com/watch?v=8w8lTnruIbI

### Ouvrir des espaces : le crédit ne va pas qu'au passeur et au buteur
Sur deux buts d'un match de Brommapojkarna, l'analyse vue de dessus montre que les coéquipiers qui font des appels (attirer un défenseur, couper l'axe) créent des zones vertes de passe réussie pour le porteur. Le tireur n'a pas touché la passe décisive, mais ses appels, ceux de deux autres joueurs et le travail de pressing ont ouvert l'espace. Le modèle évalue des passes à environ 60 % puis 65 % de réussite, contre 95 % pour une passe vers un joueur seul devant le but.

- **Principe** : Un but vient de l'espace créé par tous les joueurs, pas seulement des deux derniers acteurs.
- **En direct** : Un pic de tirs, corners et touches dans la surface après une période de pressing haut suggère un espace déjà ouvert ; ne pas attribuer la hausse au seul tireur.
- **Limite** : Exemples tirés d'une équipe suédoise précise, chiffres de probabilité donnés oralement.
- Confiance : moyenne

### Probabilité de réussite d'une passe contre probabilité de marquer
Le modèle compare plusieurs options : une passe très sûre mais loin du but, une passe plus risquée devant le but. Le choix optimal pèse la chance que la passe arrive et la chance de marquer ensuite (jusqu'à 80 à 90 % pour un joueur seul devant le but). Le gardien est lui-même mis en doute lorsqu'il suit la passe probable, ce qui permet au tireur de le surprendre.

- **Principe** : La bonne décision multiplie probabilité de réussir la passe et probabilité de marquer ensuite.
- **En direct** : Un tir peu probable (tir lointain, bloqué) après plusieurs options de passe est souvent un mauvais choix ; compter les tirs bloqués séparément des tirs cadrés.
- **Limite** : Les valeurs de probabilité viennent du modèle interne de l'intervenant, non publié.
- Confiance : moyenne

### Décision manquée : la passe vers une zone rouge
Un contre-exemple d'un match nul contre Kalmar : le joueur passe vers un partenaire très marqué (zone rouge du modèle) alors qu'un appel parfait dans la surface offrait une passe bien plus rentable. Le diagramme sert au retour vidéo pour montrer au joueur ce qu'il aurait dû faire. Au fil de la saison, la complicité entre joueurs a augmenté et les décisions se sont améliorées.

- **Principe** : Les cartes de probabilité servent d'outil pédagogique pour corriger les décisions des joueurs.
- **En direct** : Quand une équipe domine en tirs mais convertit peu, la cause peut être un mauvais choix d'option plus qu'un manque de volume.
- **Limite** : Anecdote d'une équipe suédoise, sans validation chiffrée générale.
- Confiance : faible


## Creating a pass flow graph in R
https://www.youtube.com/watch?v=uOE2_UIRniE

### Carte de flux de passes : principe de construction
Le terrain StatsBomb (120 x 80) est découpé en cases carrées de 20 : six colonnes et quatre lignes. Pour chaque case, on garde les passes qui y démarrent, on calcule la position moyenne de départ et d'arrivée et on compte les passes. La flèche donne direction et longueur moyennes ; la couleur de la case indique la fréquence. L'arrivée n'est pas contrainte, ce qui montre où la passe va réellement.

- **Principe** : Résumer des milliers de passes bruitées en une flèche moyenne par zone.
- **En direct** : Équivalent en direct : passes dans le camp adverse et centres indiquent si les passes sont verticales ou latérales ; sans coordonnées, pas de flèche.
- **Limite** : Tutoriel de code R ; l'exemple (Messi, La Liga 2017-18) montre un joueur vertical, actif près de la surface.
- Confiance : moyenne

### Choix de la taille de case (bin)
L'intervenant invite à tester des cases de 10, 20 ou 30 : trop petites, elles contiennent trop peu de passes pour une moyenne fiable ; trop grandes, elles lissent tout. Les passes sont filtrées sur le point de départ seulement.

- **Principe** : La résolution de la grille arbitre entre bruit et perte d'information.
- **En direct** : Même arbitrage en direct : une fenêtre de cinq minutes est bruyante, quinze minutes lissent trop ; ne pas réagir à un seul événement.
- **Limite** : Consigne d'ordre pratique, sans chiffres de performance.
- Confiance : faible


## Combining data science and sports science, with Benfica's head of data science (Part 1)
https://www.youtube.com/watch?v=L6jtpFE7c6I

### Charge externe et charge interne
En sciences du sport, la charge externe est ce que le joueur a fait (distance, accélérations, course à haute vitesse, mesurées par GPS ou tracking), la charge interne ce que cela lui a coûté (fréquence cardiaque, effort perçu, questionnaire de bien-être). L'analogie : kilomètres parcourus par la voiture contre carburant consommé. Les deux se combinent pour savoir si un joueur est en forme ou en surcharge.

- **Principe** : Un même effort externe coûte plus cher à un joueur fatigué.
- **En direct** : Le flux n'a que des comptages : fautes, cartons et baisse de tempo en fin de match sont des indices indirects de fatigue, jamais une mesure.
- **Limite** : Les mesures internes sont invasives ou subjectives (les joueurs sous-déclarent parfois leur effort).
- Confiance : haute

### Sous-charge, surcharge et risque de blessure
Entre sous-charge, homéostasie, surcharge et rupture, la zone utile est la surcharge modérée. Le match reste la meilleure séance (courses droites, changements de direction, haute intensité). Les remplaçants peu utilisés sont sous-chargés et donc exposés s'ils doivent entrer à la suite d'une blessure.

- **Principe** : Ni trop peu ni trop de charge : les joueurs de réserve sont aussi à risque.
- **En direct** : Un remplaçant lancé tard après peu de minutes peut être moins efficace ; ne pas surestimer son impact sur le flux.
- **Limite** : Heuristique de terrain, non quantifiée dans la vidéo.
- Confiance : moyenne

### Indice d'efficacité d'entraînement
Relier en échelle logarithmique la charge externe (distance totale) à la charge interne (fréquence cardiaque, effort perçu) donne une droite de référence par joueur. Si les séances se placent sous la droite, le joueur produit plus avec moins de coût : il progresse. Au-dessus, il se fatigue. Les écarts-types servent à classer la séance.

- **Principe** : Un joueur qui gagne en efficacité produit plus de distance pour le même coût cardiaque.
- **En direct** : Transposé : comparer le volume de jeu d'une équipe à son rythme habituel plutôt qu'à une moyenne générale.
- **Limite** : Régression simple, exemple d'un joueur sur quelques semaines.
- Confiance : moyenne

### Prédire la charge du match depuis la semaine d'entraînement
Les périodisations (cycles de la saison, charge forte à J-4 et J-3, baisse ensuite) sont mises en régression pour prédire la distance et la course à haute vitesse du match. Benfica a bâti un outil de séances sur trois saisons de données GPS ; avec une demi-saison, l'erreur dépasse un à deux écarts-types et l'outil ne vaut rien.

- **Principe** : Un modèle sur les données d'un seul club n'est utile qu'avec assez d'historique.
- **En direct** : Principe d'humilité utile à l'app : peu de matchs en base = prédictions peu fiables, ne pas sur-confiant.
- **Limite** : Détail précisé oralement ; le modèle exact (mixte) est vu en seconde partie.
- Confiance : moyenne


## Combining data science and sports science, with Benfica's head of data science (Part 2)
https://www.youtube.com/watch?v=teCgjQ2ZKNo

### Lisser les vitesses avant de calculer la charge
Les vitesses brutes issues du tracking sont bruitées. On les lisse avec un filtre polynomial local (type Savitzky-Golay, ordre 2 ou 3). Distance totale = intégrale de la vitesse sur le temps. Les bandes de vitesse (marche, trot, course 4 à 7 m/s, sprint au-delà de 7 m/s) sont des seuils absolus ; l'intervenant rappelle qu'un seuil individuel (courbe de lactate) est plus juste, un défenseur central à 5 m/s dépensant plus qu'un ailier.

- **Principe** : Nettoyer le signal d'abord, puis mesurer ; les seuils de vitesse devraient être individuels.
- **En direct** : À éviter d'extrapoler au flux de comptages : pas de vitesse. Rappel que deux joueurs de même distance n'ont pas la même charge.
- **Limite** : Contenu physiologique, utile surtout comme cadre de pensée.
- Confiance : moyenne

### Accélérations et décélérations : seuil de 2 m/s² et durée
Une accélération ou décélération « forte » dépasse ±2 m/s² (heuristique du fournisseur GPS) sur au moins environ 0,75 s ; au-delà de 6 m/s² la valeur est considérée comme aberrante. Deux joueurs peuvent couvrir la même distance avec des rapports accélérations/décélérations très différents, donc une charge mécanique différente.

- **Principe** : Même distance n'est pas même charge : les changements de rythme comptent.
- **En direct** : Un match haché (fautes, interruptions) déprime le rythme et fatigue différemment d'un match fluide ; surveiller fautes et tempo.
- **Limite** : Seuils discutés comme debatables dans la vidéo.
- Confiance : moyenne

### Détection de changement de rythme pour décider un remplacement
En calculant la puissance métabolique (fonction de la vitesse et de l'accélération) sur une fenêtre glissante de cinq minutes, l'algorithme de détection de rupture (package ruptures : segmentation binaire ou PELT) repère le moment où le joueur baisse de régime. Un seuil de pénalité plus sévère donne moins de ruptures. Utile pour proposer un remplacement ou repérer les phases où l'équipe monte ou baisse de rythme.

- **Principe** : Une rupture dans la courbe de puissance signale un coup de fatigue.
- **En direct** : En direct : une équipe dont les tirs, corners et touches dans la surface chutent d'un coup suggère une baisse de rythme ; la détection de rupture sur le flux minute par minute est la version simple de cette idée.
- **Limite** : Calculé sur un joueur en tracking ; transposition au flux de comptages à valider.
- Confiance : moyenne

### Séquences d'intensité maximale et chute de la minute suivante
Chez Benfica, la minute qui suit la minute la plus intense d'un joueur se situe en moyenne environ 21 mètres sous sa moyenne de distance par minute (intervalle de confiance à 95 % entre −27 et −15), via un modèle linéaire mixte avec joueur en effet aléatoire. Les séances d'entraînement n'exposaient qu'une partie de l'intensité vue en match (33 à 48 % cités). Le recul est observé même sur cinq minutes, quel que soit le moment du match.

- **Principe** : Après un effort maximal, un joueur reste en dessous de sa moyenne un moment.
- **En direct** : Une équipe qui vient de presser très haut a besoin de récupérer : attendre une baisse de tirs ensuite plutôt qu'une pression continue.
- **Limite** : Objection soulevée : le ballon peut simplement être ailleurs ; l'effet n'est pas prouvé causal.
- Confiance : moyenne

### Rythme d'équipe : attaquer quand l'équipe est au-dessus de sa moyenne
Avec un GPS en direct, l'intervenant utiliserait la détection de rupture pour savoir si 5 ou 6 joueurs sont au-dessus de leur moyenne (phase d'attaque) ou en dessous (priorité à l'organisation défensive, laisser l'adversaire garder le ballon et l'attirer vers l'accélération). Les équipes qui mènent baissent souvent le rythme, l'adversaire s'alignant sur le tempo.

- **Principe** : Adapter l'intention de jeu à la phase d'énergie de l'équipe.
- **En direct** : Un tempo qui baisse chez le leader + peu de tirs adverses = contrôle ; un tempo qui monte chez l'adversaire = danger.
- **Limite** : Hypothèse présentée comme piste, non testée sur la vidéo.
- Confiance : faible


## Models for evaluating players part 4: Possession chain models
https://www.youtube.com/watch?v=0VAdzaid8L8

### La chaîne de possession comme unité du football
Une chaîne de possession est la suite d'actions entre une récupération et la fin de l'attaque (typiquement 5 à 30 secondes). L'intervenant la juge plus naturelle que le modèle de Markov sans mémoire, car les entraîneurs parlent de jeu lent puis d'accélération soudaine ou de contre-attaque. Exemple : Belgique contre Brésil, récupération de Neymar jusqu'au tir de De Bruyne, chaîne de dix actions.

- **Principe** : Le football se pense en séquences qui ont une mémoire, pas en positions du ballon isolées.
- **En direct** : Un tir cadré survient souvent après une chaîne : regarder la montée conjointe de passes dans le camp adverse, corners et touches dans la surface sur quelques minutes, pas un chiffre isolé.
- **Limite** : Le flux n'a pas la chaîne exacte, seulement ses effets agrégés.
- Confiance : haute

### VAEP : prédire un but dans les dix actions suivantes
Le modèle d'évaluation d'actions de la KU Leuven (VAEP) cible les dix dernières actions avant un tir. Un classifieur (régression logistique ici) prédit pour chaque groupe de trois actions, avec le contexte du match, la probabilité qu'un but suive. Les actions peu spectaculaires (tir bloqué, corner raté) reçoivent donc de la valeur.

- **Principe** : La valeur d'une action est sa contribution à la probabilité de marquer dans les actions qui suivent.
- **En direct** : Un corner suivi d'un tir cadré a plus de valeur qu'un tir isolé lointain ; surveiller les enchaînements corner → tir cadré.
- **Limite** : Détails du modèle renvoyés aux vidéos de Lotte et Jan, non repris ici.
- Confiance : haute

### xG Chain de StatsBomb et sa limite
Pour chaque possession, on prend les tirs, on somme leur xG et on attribue cette somme à tous les joueurs qui ont touché le ballon. Un défenseur qui touche la balle au début reçoit autant de crédit que le buteur. Messi (Barcelone 2016-17) ressort premier de l'équipe, les gardiens derniers. La limite : la difficulté de l'action n'est pas prise en compte, une simple passe vers un partenaire seul est payée comme une passe exceptionnelle.

- **Principe** : Partager le crédit entre tous les acteurs de la chaîne, mais pas selon la difficulté.
- **En direct** : Ne pas attribuer un pic de xG à un seul joueur : toute l'équipe participe à la montée.
- **Limite** : Méthode de crédit, pas de prévision.
- Confiance : haute

### Valeur d'une passe en deux régressions
Pour chaque passe, une régression logistique estime la probabilité qu'une chaîne se termine par un tir selon les coordonnées de départ et d'arrivée, puis une régression linéaire estime le xG attendu du tir. Les passes qui finissent souvent en tir et en but valent plus (passe devant le but > passe en arrière). La même idée vaut pour les récupérations : récupérer haut vaut plus que récupérer dans l'axe défensif.

- **Principe** : Une passe vaut ce qu'elle a l'habitude de produire comme tirs et buts.
- **En direct** : Les passes dans le camp adverse et les centres valent plus que la possession dans son propre camp : un volume de possession bas sur le terrain a peu de poids.
- **Limite** : Les passes sont supposées réussies ; les paramètres sont simples (logistique + linéaire).
- Confiance : haute

### Classement de joueurs : Van Dijk meilleur joueur de Liverpool
Sur les dix derniers matchs de Liverpool (modèle de l'intervenant), Virgil van Dijk ressort meilleur joueur grâce à ses longues passes qui coupent les lignes et mènent à une possession haute. Robertson et Alexander-Arnold sont valorisés par leurs changements de jeu, alors que le modèle de Markov favorisait le jeu court central. Les tirs sont pondérés par le xG, avec un bonus important pour un but marqué.

- **Principe** : Les chaînes de possession valorisent aussi les longues passes qui mènent à des contre-attaques.
- **En direct** : Une équipe de jeu long peut créer autant de danger qu'une équipe de possession : ne pas conclure d'une possession basse à une faiblesse.
- **Limite** : Un classement n'a pas de vérité de terrain ; l'intervenant insiste que ce sont des indications.
- Confiance : moyenne

### Rester simple : régression avant réseaux de neurones
L'intervenant conclut que même les modèles avancés (VAEP, plus-minus ajusté) reposent sur des régressions logistique, linéaire ou de Poisson parce qu'elles sont robustes et expliquables. Il recommande de maîtriser ces outils avant de passer aux réseaux de neurones. La chaîne de possession est une bonne unité d'analyse avec mémoire de 5 à 30 secondes.

- **Principe** : Des modèles simples et lisibles valent mieux que des modèles opaques sur peu de données.
- **En direct** : Pour l'app, privilégier des formules transparentes calibrées sur les résultats passés plutôt qu'un modèle complexe sur 1 ou 2 saisons.
- **Limite** : Opinion de l'intervenant.
- Confiance : haute


## Models for evaluating players part 3: Markov models
https://www.youtube.com/watch?v=nzIFXf5f3XA

### Horizon de prédiction d'un match : environ 10 secondes
L'intervenant estime qu'on ne prédit pas fiablement une minute, encore moins 15, 45 ou 90 minutes de jeu ; on peut prédire quelques secondes (un joueur qui va tirer a plus de chances de marquer). Cette propriété de quasi-absence de mémoire justifie les modèles de Markov qui ne regardent que la position actuelle du ballon.

- **Principe** : Le football est prévisible à quelques secondes, pas à plusieurs minutes.
- **En direct** : Pour l'app : un pic de pression de quelques minutes ne prédit pas le score final ; l'estimation d'un but ou d'un tir est valable à court terme et doit être réactualisée à chaque minute.
- **Limite** : Affirmation de cours basée sur une conférence précédente, sans mesure précise donnée ici.
- Confiance : moyenne

### Modèle de Markov de Sarah Rudd (7 zones)
Sarah Rudd découpe le terrain en sept zones et estime avec des données Opta la probabilité de passer d'une zone à une autre, avec « fin de possession » et « but » comme états absorbants. Un joueur est crédité si son action augmente la probabilité de but (0,17 → 0,28) et pénalisé si elle la baisse (0,25 → 0,17). L'intervenant rappelle que Rudd a été recrutée par Arsenal après cette présentation.

- **Principe** : La valeur d'une action est le changement de probabilité de but entre l'avant et l'après.
- **En direct** : Une série d'actions qui font avancer le ballon vers la surface augmente la probabilité de but accumulée ; surveiller touches dans la surface et passes dans le camp adverse.
- **Limite** : Le modèle exact d'Arsenal a sûrement évolué.
- Confiance : haute

### Expected Threat (xT) de Karun Singh
Pour chaque zone, la valeur xT combine deux options : tirer avec la probabilité de tir × xG de la zone, ou déplacer le ballon avec la probabilité de déplacement × la valeur des zones d'arrivée. On commence avec toutes les valeurs à zéro et on itère : la valeur se propage depuis le but. Exemple cité pour une zone : 70 % de déplacement, 30 % de tir, 2 % de chance de marquer. Jouer au centre rapporte plus de danger que sur les ailes. Manchester City ressortait par ses ballons vers la ligne de but puis vers la surface.

- **Principe** : xT donne de la valeur aux zones qui mènent au tir, même quand on n'y tire pas.
- **En direct** : Un équipe qui progresse en passes vers l'axe, près de la surface, monte son xT même sans tirer ; des passes dans le camp adverse et des centres sont des indices de menace avant le tir.
- **Limite** : La grille utilisée par Singh est arbitraire ; l'intervenant préférerait 5 ou 7 couloirs.
- Confiance : haute

### Limites du modèle de Markov : pas d'attaques soudaines
Si on simule le ballon avec la matrice de transition, il tourne de façon très conservatrice et n'arrive presque jamais au but. Le modèle ne capture pas les attaques soudaines, qui sont des événements rares mais ce qui fait une bonne attaque. L'échelle de la grille est aussi un choix par essais et erreurs. Le modèle reste un point de départ, pas un simulateur réaliste.

- **Principe** : Un modèle sans mémoire écrase les attaques éclair, qui sont les moments dangereux.
- **En direct** : Ne pas lisser le flux : une accélération soudaine de tirs/corners sur 3 minutes vaut plus qu'une moyenne sur 30 minutes.
- **Limite** : Remarque issue de l'expérience personnelle de l'intervenant, non publiée.
- Confiance : moyenne


## Models for evaluating players part 2: Player radars
https://www.youtube.com/watch?v=iIJkV1v6UrA

### Classement en percentiles pour comparer les joueurs
Les statistiques brutes (8,49 longues passes par match, 0,17 centre) ne disent pas si c'est bon ou mauvais. Pour comparer, on classe tous les joueurs du championnat à un poste et on transforme le rang en pourcentage : le meilleur vaut 100 %, le dernier 12,5 % sur huit joueurs, les ex æquo prenant la moyenne. L'exemple d'Adam Webster (défenseur central de Bristol City, recruté ensuite par Brighton) montre qu'un profil se lit sur ses percentiles, avec le contexte de jeu.

- **Principe** : Un chiffre n'a de sens que rapporté à la distribution des pairs.
- **En direct** : Le flux n'a pas de pairs : comparer une équipe à sa moyenne de ligue ou à ses matchs précédents plutôt qu'à un chiffre absolu.
- **Limite** : Exemple d'un article de blog sur le Championship, pas une validation générale.
- Confiance : haute

### Ajuster les actions défensives à la possession
Un défenseur d'une équipe qui a le ballon 70 % du temps fait peu de tacles, ce qui le fait paraître mauvais. On corrige en divisant par le temps où l'équipe n'a pas le ballon : 15 tacles ÷ (0,3 × 90) pour 30 % de possession adverse. Pour les actions offensives, l'ajustement est l'inverse. L'intervenant dit ne pas savoir comment StatsBomb procède exactement.

- **Principe** : Compter les actions défensives par temps sans ballon et non par minute.
- **En direct** : En direct : ne pas conclure qu'une équipe défend mal parce qu'elle fait peu de fautes/tacles quand elle a 65 % de possession ; ni qu'elle presse beaucoup sans regarder le temps sans ballon.
- **Limite** : Formule simple, il existe des variantes plus sophistiquées.
- Confiance : haute

### Limites des radars : ordre des catégories et échelle quadratique
Les radars sont populaires mais trompeurs : l'ordre des catégories change la forme (les scouts regardent l'aire, pas la longueur des axes) et l'échelle est quadratique, ce qui exagère visuellement les meilleurs (Van Dijk devient une grosse tache). L'intervenant les emploie quand même avec les recruteurs en connaissant ces biais.

- **Principe** : Un radar exagère les extrêmes ; lire les valeurs, pas la surface.
- **En direct** : Même précaution pour tout tableau de bord du flux : un score composite cache les valeurs réelles.
- **Limite** : Critique méthodologique, non chiffrée.
- Confiance : moyenne

### Style de joueur, poste et contexte tactique
Un radar sert surtout à décrire le style : Kanté fort en tacles, interceptions, passes et pressions, De Bruyne en progression et xG assisté. Un défenseur qui fait beaucoup de passes dans le dernier tiers peut simplement jouer dans une défense à trois où ce rôle est demandé. Comparer les ligues exige l'intuition des recruteurs ou la valeur de transfert comme approximation. Aucun algorithme ne dit comment De Bruyne jouerait à Burnley.

- **Principe** : Les statistiques décrivent des styles dans un système, elles ne transposent pas telles quelles.
- **En direct** : Même chiffre de tirs dans deux matchs ne veut pas dire la même chose selon le plan de jeu (bloc bas contre jeu de possession).
- **Limite** : Aucune donnée ne résout seule le contexte.
- Confiance : haute


## Models for evaluating players part 1: Plus/minus and EA player ratings
https://www.youtube.com/watch?v=Qxy72wzNT_M

### Plus-minus naïf : buts pour et contre pendant la présence
Le plus-minus compte +1 pour un but de son équipe et −1 pour un but encaissé quand le joueur est sur le terrain, ramené à 90 minutes. Exemple : un joueur de 60 minutes dans un match où l'équipe encaisse un but, puis 30 minutes dans un autre où elle en marque deux, obtient +4,5. Utile pour juger les remplaçants et les jeunes, mais ignore l'adversaire, le niveau de ligue et la situation du match.

- **Principe** : Le plus-minus mesure l'effet global de la présence, sans dire par quelles actions.
- **En direct** : Un match où le score change vite à chaque changement montre l'impact des remplaçants : regarder la différence de tirs/xG avant et après chaque remplacement.
- **Limite** : Peu fiable en football à cause du faible nombre de remplacements.
- Confiance : moyenne

### Régression ridge pour le plus-minus ajusté
Dan Rosenbaum découpe le match en tranches sans remplacement, puis régresse la différence de buts sur la présence de chaque joueur (+1 domicile, −1 extérieur) et estime l'avantage à domicile. Comme il y a des centaines de joueurs, une pénalité (régression ridge) ramène la plupart vers zéro et ne laisse ressortir que les vrais écarts. L'intervenant note que ça marche mieux au basket qu'au football (moins de remplacements).

- **Principe** : Une pénalité sur les coefficients évite de sur-ajuster quand les paramètres sont nombreux.
- **En direct** : Pour l'app : sur peu de matchs, régulariser les poids appris pour ne pas sur-réagir au bruit.
- **Limite** : Les bibliothèques de machine learning appliquent la pénalité par défaut, ce qui peut cacher un effet réel.
- Confiance : moyenne

### Indice EA Sports : valeur relative des actions
Le modèle de l'indice de performance d'EA Sports régresse les tirs d'une équipe sur ses centres, dribbles, passes, cartons. En divisant les coefficients, un centre vaut environ 15 passes sur une saison et une expulsion équivaut à environ −42 interceptions. Le carton rouge adverse augmente nettement la cadence de tirs de l'équipe adverse, et le jaune adverse aussi, mais la causalité n'est pas établie.

- **Principe** : Les cartons adverses et les centres se retrouvent associés à plus de tirs.
- **En direct** : Une expulsion d'un adversaire sur le flux est un indicateur fort d'une hausse prochaine des tirs de l'équipe à onze ; un carton jaune adverse aide un peu.
- **Limite** : Relations corrélationnelles : l'intervenant signale un problème de cause à effet.
- Confiance : moyenne

### Pourquoi le modèle EA se trompe
Le modèle valorise chaque action de la même façon quelle que soit sa zone, donc il recommanderait de centrer sans cesse. En 2008-09 il classait premier le gardien de Fulham Mark Schwarzer, devant Gareth Barry et Sol Campbell, ce que personne n'acceptait. Ajouter buts, victoires et clean sheets a corrigé le classement mais on retombe alors sur le principe d'un jeu de fantasy football.

- **Principe** : Un modèle doit tenir compte de l'endroit où l'action est faite et croiser l'avis des fans et des coachs.
- **En direct** : Un volume élevé de centres sans touches dans la surface correspondantes est un signal de faible qualité plutôt que de domination.
- **Limite** : Cas historique de 2008-09 de la Premier League.
- Confiance : haute


## Valuing actions 4: Analysing models and results
https://www.youtube.com/watch?v=w9G0z3eGCj8

### Deux modèles : probabilité de marquer et d'encaisser dans les 10 actions
Le VAEP entraîne deux classifieurs sur la saison en dehors de La Liga : probabilité que l'équipe marque dans les 10 prochaines actions, probabilité qu'elle encaisse. Les variables dominantes sont les positions du ballon (distance au but de l'action courante et des précédentes). L'indicateur « même équipe que l'action précédente » pèse peu individuellement. Test sur La Liga (environ 10 % des matchs).

- **Principe** : La proximité du but domine la probabilité de marquer dans les prochaines actions.
- **En direct** : Touches dans la surface et passes dans le camp adverse sont les approximations les plus directes de cette proximité.
- **Limite** : Analyse par des outils d'interprétation (importance de variables, SHAP) sur un seul jeu de données.
- Confiance : haute

### VAEP d'une action = hausse du risque de marquer − hausse du risque d'encaisser
La valeur d'une action est la variation de la probabilité de marquer plus la baisse de celle d'encaisser, avant/après l'action. Les actions échouées ont typiquement une valeur négative (perdre le ballon coûte). On somme ces valeurs par joueur, on normalise par 90 minutes avec un seuil de 450 minutes minimum.

- **Principe** : Une action vaut ce qu'elle change dans les probabilités de but des deux côtés.
- **En direct** : Une perte de balle dans son propre camp coûte plus qu'une perte devant le but adverse ; compter les pertes là où elles font mal.
- **Limite** : Résultats dépendent du modèle choisi.
- Confiance : haute

### Quantité contre qualité : deux profils de joueurs bien notés
Messi domine la liste (0,87 par 90 minutes, bien au-dessus du deuxième), à la fois avec beaucoup d'actions et une valeur moyenne élevée. Un autre joueur obtient une note comparable avec très peu d'actions mais de forte valeur. On peut donc lire une note comme volume × valeur moyenne.

- **Principe** : Une même note peut venir de beaucoup d'actions modestes ou de quelques actions décisives.
- **En direct** : Équipe qui ne tire que 5 fois mais dont 4 cadrés avec touches dans la surface élevées : peu de volume, haute valeur.
- **Limite** : Valeurs issues du modèle de l'intervenant, saison 2017-18.
- Confiance : moyenne

### Arbitrage risque / récompense
En séparant la valeur des actions réussies et celle des actions ratées, on voit quels joueurs prennent des risques : ceux qui perdent beaucoup de valeur sur les échecs (ailiers dribbleurs) compensent par leurs réussites. D'autres perdent peu mais complètent peu d'actions utiles. Pour Messi, les pertes lourdes sont plus que compensées.

- **Principe** : Un joueur risqué n'est bon que si ses réussites compensent le coût de ses pertes.
- **En direct** : Beaucoup de tirs ratés (hors cadre, bloqués) avec peu de tirs cadrés = beaucoup de risque sans récompense.
- **Limite** : Analyse descriptive, pas une règle de conduite.
- Confiance : moyenne


## Evaluating players using match result and event data
https://www.youtube.com/watch?v=j5ybADC2gC4

### Le plus-minus naïf peut conduire à de très mauvaises décisions
Histoire racontée par Ian Graham (Liverpool) : un analyste externe avait écrit au propriétaire que Liverpool gagnait 36 % de ses matchs avec Luis Suárez et 58 % sans lui, pour recommander de le vendre. Il a fallu deux jours pour convaincre de garder Suárez. Morale : il faut un système de notation fiable et partagé dans le club.

- **Principe** : Une comparaison brute « avec / sans » le joueur ignore l'adversaire et le contexte.
- **En direct** : Ne pas conclure d'un seul indicateur brut (possession, score après peu de minutes) à la qualité d'une équipe ou d'un joueur.
- **Limite** : Anecdote rapportée oralement, sans chiffres vérifiables.
- Confiance : moyenne

### Trois familles de notation : globale, par événements, variables latentes
Les méthodes globales donnent un seul nombre (plus-minus, probabilité de but ajoutée comme le VAEP). Les méthodes par événements donnent des indicateurs séparés (radars, jusqu'à une quinzaine de nombres). Les variables latentes regroupent les actions corrélées : centres, passes clés, passes décisives pointent vers « créer des occasions » ; duels aériens, tacles, récupérations, interceptions vers « regagner le ballon ».

- **Principe** : Regrouper les actions qui vont ensemble donne des dimensions plus lisibles que beaucoup d'indicateurs.
- **En direct** : Dans le flux : tirs, tirs cadrés et touches dans la surface forment un même bloc « création » ; fautes et cartons un bloc « conflit » ; ne pas les additionner sans réfléchir.
- **Limite** : Classification proposée par l'intervenant, pas un standard.
- Confiance : moyenne

### Plus-minus ajusté : segments, pénalisation et ajustements pour le football
Le match est découpé en segments à effectif constant (6 à 8 par match), la différence de buts étant régressée sur les joueurs présents. Les corrections ajoutées : poids pour les matchs récents, poids selon la durée du segment et le score au début, avantage à domicile (effet minime), pénalité pour carton rouge, courbe d'âge, et écart entre ligues en rapprochant les joueurs mal connus de la moyenne de leurs coéquipiers plutôt que de zéro.

- **Principe** : Il faut beaucoup de saisons et plusieurs ligues pour qu'un plus-minus en football soit stable.
- **En direct** : Le carton rouge a un coût mesurable en buts par minute dans ce modèle ; l'intervenant ne donne pas le chiffre ici.
- **Limite** : Données de feuilles de match uniquement ; peu de buts et peu de remplacements limitent la précision.
- Confiance : moyenne

### Le plus-minus et les indicateurs d'événements se recoupent peu
En régressant les notes plus-minus sur des indicateurs d'événements par poste, environ 30 % de la variance seulement est expliquée (38 % pour les attaquants), donc deux tiers restent inexpliqués. Pour les attaquants, buts par 90 minutes, passes clés et tirs cadrés comptent ; pour les milieux offensifs, passes clés et dribbles réussis ; pour défenseurs et milieux défensifs, le nombre de passes réussies.

- **Principe** : Les événements ne reproduisent qu'une partie de la contribution réelle au score.
- **En direct** : Les tirs cadrés et les passes clés reflètent le mieux la contribution offensive ; une équipe qui tire sans cadrer a moins de poids qu'un chiffre de tirs total ne le laisse croire.
- **Limite** : Seuls les indicateurs reliés au plus-minus ont été retenus, donc résultat non généralisable.
- Confiance : moyenne

### Les indicateurs d'événements améliorent à peine la prévision des résultats
Prédire les résultats de matchs avec les seules notes plus-minus fait mieux qu'avec les seuls indicateurs d'événements. En ajoutant à la note plus-minus les arrêts par 90 minutes et les passes clés par 90, la perte quadratique baisse très légèrement. L'intervenant note qu'avec plus d'informations les modèles événementiels devraient finir par faire mieux, mais personne ne l'a encore démontré.

- **Principe** : Les indicateurs d'événements simples n'ont pas battu de façon claire le plus-minus pour prédire les résultats.
- **En direct** : Humilité pour l'app : un modèle de statistiques minute par minute doit être validé sur ses prévisions futures, pas sur la plausibilité.
- **Limite** : Pas de xG dans les indicateurs testés ; les auteurs restent prudents.
- Confiance : moyenne

### Critères d'un bon système de notation : fiabilité, validité apparente, prédiction
Quatre tests : fiabilité (un indicateur à 0,7 de fiabilité contient au moins 50 % de variance vraie ; le VAEP sur une saison n'a que 0,25 de corrélation entre moitiés, soit environ 0,4 de fiabilité, donc il faut plusieurs saisons), validité apparente (classer Ancelotti 595e sur 596 entraîneurs échoue au test), validité de contenu (contribution ou capacité ?) et validité prédictive (prédit-il le futur ?). Les intervalles d'incertitude s'obtiennent par rééchantillonnage.

- **Principe** : Un indicateur utile doit être stable, plausible et prédire le futur.
- **En direct** : Avant de faire confiance à un signal du flux, vérifier qu'il se répète d'un match à l'autre et qu'il améliore les prévisions.
- **Limite** : Chiffres cités de mémoire par l'intervenant (article de l'Economist de 2019 pour le contre-exemple).
- Confiance : haute


## Valuing actions 3: training machine learning models
https://www.youtube.com/watch?v=WlORqYIb-Gg

### Comparer toute prévision au taux de base (score de Brier)
Le tutoriel entraîne un classifieur XGBoost pour prédire un but à partir d'un état de jeu. Le taux de base (probabilité moyenne observée, environ 1,55 % par état) sert de modèle naïf : score de Brier 0,01529 contre 0,01459 pour un premier modèle et 0,01404 après réglage. Plus bas est meilleur ; si un modèle ne bat pas le taux de base, il n'apprend rien.

- **Principe** : Un modèle de probabilité se juge contre la simple fréquence moyenne.
- **En direct** : Pour l'app : calculer le score de Brier des probabilités affichées et comparer au taux de base de la ligue ; sinon les probabilités n'ont pas de valeur.
- **Limite** : Valeurs de l'exemple (données Wyscout) ; un but dans les dix actions reste un événement rare.
- Confiance : haute

### Calibration : une probabilité de 35 % doit arriver 35 % du temps
Le modèle de base est mal calibré : pour les états prédits à environ 35 %, seuls 18 % finissent en but, donc le modèle sous-estime ou surestime selon les tranches. Un meilleur réglage (100 arbres, profondeur 4) améliore nettement la courbe de fiabilité. Une recalibration (régression isotonique ou logistique) est possible. La majorité des états ont une probabilité très faible, car la plupart ne mènent jamais à un but.

- **Principe** : Une probabilité n'est utile que si elle est calibrée sur la fréquence réelle.
- **En direct** : Tracer par tranche de probabilité affichée le taux réel de réussite des paris : c'est le meilleur contrôle pour l'app.
- **Limite** : Exemple d'un modèle d'enseignement, pas de modèle de production.
- Confiance : haute

### Éviter le sur-apprentissage : validation croisée et séparation chronologique
Un modèle trop spécifique mémorise le passé (sur-apprentissage) ; trop général, il rate les nuances. Remèdes : séparer entraînement et test (10 % ici, avec graine fixe et stratification), validation croisée à 5 plis pour choisir les hyperparamètres, et surtout dans un cas réel, respecter l'ordre chronologique (entraîner sur deux saisons, régler sur la suivante, tester sur la dernière). Ne jamais laisser la saison évaluée dans l'entraînement.

- **Principe** : Tester sur des matchs postérieurs à l'entraînement, jamais mélangés.
- **En direct** : Pour l'apprentissage de l'app : calibrer sur les matchs passés et évaluer sur les matchs suivants, jamais l'inverse.
- **Limite** : Consignes de méthode, pas de résultat de football.
- Confiance : haute

### Limiter la complexité plutôt qu'ajouter des variables
Le nombre d'arbres et leur profondeur maximale (4 ici) sont des leviers pour éviter la mémorisation. XGBoost choisit lui-même les variables utiles : une variable peu informative n'est jamais utilisée. L'intervenant invite à tester des variables supplémentaires du tutoriel précédent mais note qu'une grille plus grande coûte plus de temps de calcul.

- **Principe** : Mieux vaut un modèle contraint qui généralise qu'un modèle riche qui mémorise.
- **En direct** : Peu de variables bien choisies (tirs cadrés, corners, touches dans la surface) valent mieux qu'un grand nombre de stats corrélées.
- **Limite** : Réglages de l'exemple (100 estimateurs, profondeur 4) non transposables tels quels.
- Confiance : moyenne


## Beyond pitch control: valuing player actions and passing options
https://www.youtube.com/watch?v=KXSLKwADXKI

### Valeur de possession attendue (EPV) : probabilité de finir en but
L'EPV est la probabilité qu'une possession se termine par un but compte tenu de la situation : position du ballon, positions et vitesses des joueurs, phase de jeu (jeu ouvert ou coup de pied arrêté), score, temps restant. Le modèle simple présenté n'utilise que la position du ballon (grille) et les coups de pied arrêtés, et se calibre avec une saison d'événements. Exemple : environ 2 % dans une case milieu de terrain avancé, 1 % au milieu de son propre camp, au minimum 0,5 %.

- **Principe** : L'EPV donne de la valeur à toute position du ballon, pas seulement aux tirs.
- **En direct** : Même le ballon dans son camp a une petite valeur ; ce qui fait monter l'EPV, c'est d'avancer le ballon vers la surface adverse (passes dans le camp adverse, touches dans la surface).
- **Limite** : Valeurs lues sur un graphique interactif à partir d'un modèle de l'intervenant, pas de chiffres universels.
- Confiance : haute

### Matrice de transition : états, buts et pertes de balle
Chaque case du terrain est un état ; s'ajoutent des états de coups de pied arrêtés (corner, penalty) et deux états finaux : but et perte de possession. La matrice donne la probabilité de passer d'un état à un autre. En la multipliant jusqu'à la convergence, on obtient pour chaque état la probabilité de finir en but ou en perte (exemple : 0,2 but et 0,8 perte). La première version est de Sarah Rudd (2011), on retrouve ensuite VAEP, g+ et l'expected threat.

- **Principe** : On peut tout dériver de la probabilité de passer d'un état à l'autre.
- **En direct** : Chaque corner obtenu ou touche dans la surface est un changement d'état avec plus de valeur que la possession seule.
- **Limite** : Il faut au moins une saison de données d'événements pour estimer la matrice.
- Confiance : haute

### Valeur d'une passe = différence d'EPV entre départ et arrivée
Une passe de 1 % d'EPV à 8 % apporte 7 points. Pour comparer des options, on multiplie la valeur de la zone cible par le contrôle de zone (probabilité que la passe soit gardée) et on retranche la valeur actuelle multipliée par le contrôle de zone actuel. Une passe en arrière peut ainsi avoir une valeur positive si elle conserve la balle alors qu'un dribble serait perdu.

- **Principe** : La meilleure décision combine la valeur de la zone et la probabilité de garder le ballon.
- **En direct** : Beaucoup de passes en arrière ne sont pas forcément mauvaises : sous pression, conserver vaut parfois plus qu'une passe risquée vers l'avant.
- **Limite** : Un contre-exemple de l'exemple : le modèle ignore les interceptions.
- Confiance : haute

### Meilleures options manquées : changements d'aile
En cherchant sur tous les passes le maximum d'EPV attendu, l'intervenant trouve souvent que la meilleure option est une longue passe croisée vers un ailier isolé, comme les équipes qui basculent le jeu (il évoque Liverpool). Pour une passe décisive, le modèle montre qu'un joueur a choisi presque la meilleure option (valeur attendue d'environ 0,05), alors que sur une autre action une passe en retrait aurait valu plus.

- **Principe** : L'espace libre sur l'aile opposée est une source majeure de valeur.
- **En direct** : Un jeu long ou un changement d'aile réussi précède souvent les centres : surveiller la hausse des centres après un tempo rapide.
- **Limite** : Résultats descriptifs sur un match de démonstration.
- Confiance : moyenne

### Ce qu'il manque au modèle : interceptions, tacles, dribbles, défense
Le contrôle de zone ignore les interceptions le long de la trajectoire (travail de Will Spearman, Sloan 2017) et la probabilité d'être taclé en possession. Les actions défensives (interceptions, dégagements) et le dribble ne sont pas valorisés. Le VAEP et le modèle g+ d'American Soccer Analysis intègrent davantage de contexte (contre-attaques, ballons traversants).

- **Principe** : Un modèle partiel doit être complété par ce qu'il ne mesure pas.
- **En direct** : Dans le flux : fautes et cartons éclairent un peu la défense, mais aucun indicateur ne remplace les interceptions manquantes.
- **Limite** : Liste de pistes, pas de résultats.
- Confiance : moyenne


## Exploring football match events in Python
https://www.youtube.com/watch?v=ZXEHPKmx410

### Ordres de grandeur d'un match en données d'événements
Sur une saison de Serie A du jeu de données Wyscout public, un match compte en moyenne environ 1 700 événements (minimum 1 300, maximum 2 000). Les passes représentent presque 50 % des événements, les duels environ 25 %, les fautes, interruptions et tirs seulement 1 à 2 % chacun. La moyenne observée est de 2,68 buts par match, soit près de 1 000 buts dans la saison.

- **Principe** : Les tirs sont rares (1 à 2 % des événements) alors que les passes dominent.
- **En direct** : Dans le flux, un tir est un événement rare et informatif ; une série de tirs cadrés en quelques minutes est un signal fort.
- **Limite** : Chiffres d'un seul championnat sur une saison (la vidéo ne précise pas l'année dans ce que j'ai retenu).
- Confiance : moyenne

### Répartition spatiale : duels et fautes sur les côtés, hors-jeu et tirs devant le but
Par estimation de densité sur le terrain, les duels et les fautes se concentrent sur les côtés, les fautes dans sa propre surface sont rares (elles donneraient un penalty), les hors-jeu et les tirs se concentrent devant le but adverse. La carte des tirs est la base d'un modèle de xG.

- **Principe** : Chaque type d'événement a sa zone naturelle.
- **En direct** : Les fautes dans le camp défensif sont dangereuses car elles mènent à des coups francs près de la surface.
- **Limite** : Description d'un championnat italien, non vérifiée ailleurs.
- Confiance : moyenne

### Cartons jaunes en hausse, rouges en début et en fin de match
Les buts n'ont pas de tendance claire pendant le match (légèrement plus probables entre la 25e et la 35e minute). En revanche, les cartons jaunes deviennent de plus en plus probables avec le temps, et les cartons rouges se concentrent au tout début et à la toute fin du match.

- **Principe** : Le risque disciplinaire monte avec la minute ; les buts ne suivent pas de tendance régulière.
- **En direct** : Plus on avance dans le match, plus les fautes mènent à des cartons ; un joueur déjà averti en fin de match est plus à risque, ce qui peut annoncer un carton rouge.
- **Limite** : Tendance sur une saison de Serie A, à confirmer sur d'autres compétitions.
- Confiance : moyenne

### Réseaux de passes et centralité de flux
Dans les données Wyscout, seul le passeur est connu ; le destinataire se déduit de l'événement suivant si la passe est précise. Le réseau de passes dessine des nœuds (joueurs) et des arêtes dirigées. La centralité de flux mesure la fraction des chemins menant à un tir où un joueur passe. Pour trois joueurs italiens, deux ont une distribution étroite, un autre varie fortement d'un match à l'autre.

- **Principe** : Un joueur central pour les chemins menant à des tirs est important, même sans toucher le but.
- **En direct** : En direct : la concentration des touches dans la surface et des tirs sur un petit groupe est un indice de dépendance à un joueur clé.
- **Limite** : Valeurs individuelles non rapportées ici.
- Confiance : faible


## Valuing actions 1: from Wyscout data to rating players
https://www.youtube.com/watch?v=0ol_eLLEQ64

### Pipeline en quatre étapes pour valoriser les actions
Le processus : télécharger et pré-traiter les événements Wyscout (jeu public, saison 2017-18 des cinq grands championnats, Coupe du monde 2018, Euro 2016, environ 75 Mo), convertir en un format uniforme d'actions (SPADL) compatible avec Opta, StatsBomb, Wyscout, valoriser les états de jeu avec deux modèles, puis noter les joueurs en sommant la valeur de leurs actions. Un état de jeu est une suite de trois actions consécutives.

- **Principe** : Uniformiser le format d'événements avant de modéliser permet d'appliquer le même modèle à tous les fournisseurs.
- **En direct** : Le flux de l'app a son propre format ; il faut le normaliser avant d'appliquer des règles apprises ailleurs.
- **Limite** : Tutoriel de code, le fond théorique est dans les vidéos suivantes.
- Confiance : moyenne

### Étiquettes : un but marqué ou encaissé dans les dix actions suivantes
Chaque état de jeu reçoit deux étiquettes : « un but est marqué » et « un but est encaissé » dans les dix actions suivantes. La grande majorité des étiquettes sont fausses, car peu d'états mènent à un but. Les modèles XGBoost donnent ensuite une probabilité entre 0 et 1 pour chaque étiquette.

- **Principe** : Les buts sont très rares par état de jeu ; l'étiquette est déséquilibrée.
- **En direct** : Même déséquilibre pour l'app : la plupart des matchs minute par minute n'ont pas de but, donc la probabilité de but est faible tant que le flux est calme.
- **Limite** : Choix de dix actions arbitraire mais standard dans le VAEP.
- Confiance : moyenne

### Normaliser par 90 minutes et filtrer les joueurs peu utilisés
Le classement brut place Gareth Bale en tête (3,7) pour l'Euro 2016 mais ne tient pas compte des minutes jouées. On divise par les minutes jouées × 90 et on ne garde que les joueurs ayant au moins 360 minutes (quatre matchs) ; le seuil est réglable.

- **Principe** : Un cumul sans normalisation favorise ceux qui jouent plus.
- **En direct** : Les tirs et corners du flux doivent s'interpréter par minute écoulée, surtout si un match est joué en infériorité numérique.
- **Limite** : Seuils simplement donnés à titre d'exemple.
- Confiance : moyenne


## Creating an Interactive Shot Map (Part 2)
https://www.youtube.com/watch?v=yWXD7xi1f30

### Carte de tirs filtrée par xG et par origine de la passe décisive
L'application filtre les tirs par compétition, saison, équipe, type de tir, résultat, pied et plage de xG, et par zone d'origine de la passe décisive choisie au pinceau sur un terrain de 120 x 80. En sélectionnant par exemple le couloir droit pour Barcelone (La Liga 2017-18), les tirs affichés partent surtout du premier ou du second poteau. La taille du cercle représente le xG.

- **Principe** : Croiser la zone de la passe et le xG montre quels centres créent les meilleures occasions.
- **En direct** : Sur le flux, les centres et les corners sont des proxys de la passe décisive ; leur lien avec les tirs cadrés renseigne la source du danger.
- **Limite** : Tutoriel de programmation ; pas de chiffres de performance.
- Confiance : faible

### xG diff : écart entre buts marqués et buts attendus
Les données incluent une mesure d'écart (xG diff) entre buts réellement marqués par une équipe et xG cumulé de ses tirs, pour juger si elle sur- ou sous-performe. Chaque tir porte aussi la présence d'une passe décisive ou d'une passe clé et sa localisation.

- **Principe** : Comparer buts réels et xG sépare la chance de la qualité des occasions.
- **En direct** : Une équipe qui marque plus que son xG cumulé a de fortes chances de redescendre ; une équipe sous son xG peut remonter.
- **Limite** : Définition donnée en passant, sans chiffres.
- Confiance : moyenne


## Liverpool Analytics Challenge
https://www.youtube.com/watch?v=CQr7qFw6LfY

### Défi Liverpool : analyser 14 buts avec des données de tracking
Le défi consiste à rédiger une analyse d'adversaire sur la façon dont Liverpool marque, à partir de 14 buts récents (dont un contre Barcelone) avec positions des joueurs fournies par un compte de visualisation. Les buts montrent souvent une construction dans son camp puis une attaque très rapide. L'intervenant insiste sur le fait qu'il faut regarder la vidéo en plus des données, car 14 buts ne suffisent pas à conclure.

- **Principe** : Avec peu d'exemples, combiner l'œil du footballeur et les chiffres.
- **En direct** : Un échantillon court (quelques tirs dans un match) ne justifie pas une règle ; confirmer par plusieurs signaux avant de parier.
- **Limite** : Il s'agit de l'énoncé d'un défi, pas d'une analyse terminée.
- Confiance : haute

### Espace dans la défense avant le corner
Un diagramme de Voronoï du moment juste avant un corner pris par Liverpool contre Barcelone montre un grand espace libre au cœur de la défense adverse. La vidéo-animation du but permet d'enchaîner les images du corner au ballon qui entre dans les filets.

- **Principe** : Les actions décisives commencent souvent par un espace laissé libre.
- **En direct** : Un corner ne vaut que s'il se joue dans un espace libre ; compter les corners seuls surestime le danger.
- **Limite** : Un seul exemple.
- Confiance : faible


## Creating passing networks with Barcelona data scientist Sergio Llana
https://www.youtube.com/watch?v=JZ6Jc-cvKX8

### Réseau de passes : nœuds = position moyenne, arêtes = passes entre deux joueurs
Dans un réseau de passes, chaque joueur est un nœud placé à la position moyenne où il fait ses passes ; chaque arête agrège les passes dans les deux sens entre deux joueurs (clé commune pour regrouper). La taille et la couleur reflètent le nombre de passes, ou leur valeur (VAEP de la passe) en variante. On peut utiliser les événements StatsBomb ou les données de tracking Metrica.

- **Principe** : Un réseau de passes montre qui joue avec qui et où se joue le jeu.
- **En direct** : Le flux n'a pas la position moyenne mais le volume de passes dans le camp adverse et la possession.
- **Limite** : Code de visualisation d'un analyste du FC Barcelone.
- Confiance : moyenne

### Limiter le réseau aux titulaires avant la première rupture
Pour éviter qu'un remplaçant n'encombre le graphique, le réseau ne couvre que la période jusqu'au premier remplacement ou premier carton rouge. La valeur de couleur peut être fixée avec un maximum commun (par exemple 50 passes) pour comparer deux matchs.

- **Principe** : Comparer deux réseaux n'est possible qu'avec la même échelle et le même effectif.
- **En direct** : En direct : après un carton rouge ou un remplacement, repartir à zéro les comparaisons de tendance.
- **Limite** : Choix de conception du code, pas une règle de football.
- Confiance : moyenne

### Position moyenne selon la phase : attaque ou défense, ballon dans quel camp
Avec le tracking, la position moyenne d'un joueur est trompeuse si l'on mélange phases d'attaque et de défense (la moyenne tombe au milieu). L'analyste filtre les images où l'équipe attaque, puis celles où le ballon est dans la moitié adverse, ce qui change fortement les positions. Les résultats diffèrent beaucoup entre « équipe qui attaque ballon chez l'adversaire » et « équipe qui défend dans son camp ».

- **Principe** : Toute moyenne doit être calculée dans une phase de jeu cohérente.
- **En direct** : Éviter de comparer des stats d'ensemble pour un match qui a changé de phase après un but ou un carton rouge.
- **Limite** : Résultat qualitatif sans chiffres.
- Confiance : moyenne


## Advanced football analytics: building and applying a pitch control model in python
https://www.youtube.com/watch?v=5X1cSehLg6s

### Contrôle de zone : probabilité de garder le ballon à un endroit donné
Le contrôle de zone (pitch control) d'un point est la probabilité que l'équipe qui a le ballon le garde s'il y est envoyé. Il faut calculer le temps d'arrivée du ballon, le temps d'arrivée de chaque joueur et la probabilité que chacun contrôle le ballon, puis répéter sur une grille de pixels. Il dit où garder la possession, pas la valeur de l'endroit.

- **Principe** : Contrôle de zone = chance de conserver le ballon, valeur nulle de la zone.
- **En direct** : Sans positions des joueurs, la possession et les passes dans le camp adverse sont les seuls proxys ; garder en tête qu'ils ne disent pas où est le danger.
- **Limite** : Nécessite des données de tracking.
- Confiance : haute

### Hypothèses physiques du modèle simplifié
Ballon à vitesse constante de 15 m/s (21 m donnent 1,4 s). Joueurs : vitesse maximale 5 m/s, accélération 7 m/s², délai de réaction de 0,7 s pendant lequel ils gardent leur trajectoire, puis course directe vers la cible à vitesse maximale. Probabilité de contrôler le ballon : taux de 4,3 par seconde (environ 0,25 s pour contrôler, 90 % en un peu plus d'une demi-seconde).

- **Principe** : On approxime l'arrivée des joueurs par un temps de réaction puis une course droite.
- **En direct** : Rappel utile : la réaction et le temps de contrôle comptent peu à l'échelle de la minute mais décident de qui gagne un duel court.
- **Limite** : Paramètres issus du modèle de Will Spearman, volontairement grossiers.
- Confiance : haute

### L'incertitude sur le temps d'arrivée change fortement le résultat
Avec arrivée exacte, un joueur à 1,5 s contre un autre à 2 s gagnerait à 93 %. Avec une incertitude de 0,45 s (fonction sigmoïde), la probabilité tombe à 70 %, le rival monte à environ 30 %. Une probabilité de contrôle sans incertitude est donc trop optimiste.

- **Principe** : Ne pas traiter un écart de temps ou de statistique comme exact : une petite incertitude change beaucoup la probabilité.
- **En direct** : Pour l'app : afficher une plage plutôt qu'un chiffre unique et éviter de rendre ferme un pari sur une différence minime.
- **Limite** : Chiffres de l'exemple d'un seul jeu de joueurs.
- Confiance : haute

### Risque des passes : la plupart sont sûres à plus de 90 %
Sur 543 passes réussies de l'équipe à domicile dans un match de démonstration, la grande majorité avait plus de 90 % de chances de réussite (souvent des passes entre défenseurs sans pression). 18 passes avaient moins de 50 % : de longues passes depuis le camp défensif (dégagements) et des passes dans la surface adverse. Plus de la moitié des 20 plus risquées sont suivies d'un duel ou d'une perte de balle, ou d'un tir.

- **Principe** : Les passes risquées se concentrent dans les zones les plus peuplées et les plus dangereuses.
- **En direct** : Beaucoup de passes dans la surface adverse sont risquées mais conduisent souvent à des tirs ; ne pas les pénaliser sans regarder les tirs.
- **Limite** : Un seul match de la base Metrica (jeu d'échantillon).
- Confiance : moyenne

### Valeur d'un appel hors ballon : espace créé
Les trois passes menant à un but montrent comment l'appel d'un coéquipier ouvre une zone de contrôle (0,78 pour la passe dans l'espace, 0,60 pour la passe décisive). Le travail proposé en exercice : mesurer le territoire gagné par une course sans ballon, première étape pour quantifier les actions hors ballon.

- **Principe** : Un appel sans ballon a une valeur mesurable par l'espace qu'il libère ou qu'il prend.
- **En direct** : Une équipe qui court beaucoup vers l'avant crée de l'espace ; sans tracking, on ne le voit qu'après coup via tirs et touches dans la surface.
- **Limite** : Idée proposée comme pistes, pas résultat.
- Confiance : moyenne


## Liverpool FC data scientist William Spearman's masterclass in pitch control
https://www.youtube.com/watch?v=X9PrwPyolyU

### Du Voronoï en distance au Voronoï en temps, puis en probabilité
Le Voronoï par distance dit que le joueur le plus proche contrôle un point. Si un adversaire plus loin court vers le ballon, il y arrive en réalité plus vite : la bonne mesure est le temps d'interception (avec vitesse et accélération maximales). Comme rien n'est certain, ces temps passent dans un modèle probabiliste ajusté sur des données réelles, en regardant quel joueur fait le prochain contrôle.

- **Principe** : Le contrôle d'espace dépend du temps pour y arriver, pas de la distance.
- **En direct** : Un joueur proche mais à l'arrêt contrôle moins qu'un joueur plus loin mais lancé : une équipe qui court vers l'avant (pressing) reprend du terrain.
- **Limite** : Nécessite des positions et des vitesses des joueurs.
- Confiance : haute

### Plus de contrôle d'espace n'implique pas une meilleure performance
Comme la distance totale courue, le contrôle d'espace peut être mal utilisé : la possession élevée donne du contrôle mais une équipe en contre-attaque peut dominer le jeu avec moins. Le gardien et les défenseurs de l'équipe qui attaque contrôlent beaucoup d'espace sans valeur offensive. Il faut donc pondérer par la proximité du ballon (contrôle pertinent) et par la valeur de la zone.

- **Principe** : Mesurer le contrôle là où le ballon va et là où il y a du danger.
- **En direct** : Possession élevée ne signifie pas domination : croiser possession avec tirs cadrés et touches dans la surface, surtout contre une équipe qui joue en contre.
- **Limite** : Mise en garde générale de l'intervenant.
- Confiance : haute

### Contrôle dynamique : l'incertitude croît loin du ballon
Le temps de contrôle suit une loi exponentielle : 90 % des contrôles se font en moins d'une seconde. Dans un exemple discrétisé par pas de 0,1 s, un joueur avec 10 % par pas a 27,1 % sur trois pas, le suivant 7,3 % puis 6,6 %, et ainsi de suite pour un total de 34,2 % pour le second. Les probabilités sont conditionnelles : un joueur plus loin sur la trajectoire ne reçoit que si le premier ne l'a pas fait. Loin du ballon, le temps de vol laisse les défenseurs converger, donc le contrôle y est moins certain.

- **Principe** : Plus le ballon met de temps à arriver, plus l'issue est incertaine.
- **En direct** : Une longue passe vers l'avant est un pari ; une série courte de passes réduit l'incertitude ; ne pas assimiler les deux.
- **Limite** : Exemple pédagogique avec des pas arbitraires.
- Confiance : haute

### Contrôle pertinent et opportunité de marquer
La pertinence d'une zone est la probabilité que la prochaine touche y soit (selon la distance au porteur et le contrôle de l'équipe). Multipliée par une carte de probabilité de marquer sur une touche contrôlée, elle donne l'opportunité de marquer : un attaquant en position régulière derrière la défense a une forte opportunité même avec une petite zone. L'opportunité n'est que le début : il faut encore passer, tirer et marquer.

- **Principe** : Pondérer le contrôle par la pertinence et la valeur de la zone.
- **En direct** : Les touches dans la surface sont les meilleurs indicateurs observables de l'opportunité de marquer ; les passes dans le camp adverse un indicateur plus faible.
- **Limite** : Le modèle de marquer utilisé est très simple.
- Confiance : haute

### Opportunités équivalentes malgré un nombre de tirs très différent
Dans un match donné, les deux équipes ont marqué un but et généré des opportunités de marquer similaires, alors que l'une avait tiré cinq fois et l'autre bien plus. Le nombre de tirs seul ne reflète donc pas le danger créé.

- **Principe** : Le volume de tirs ne dit rien sans la qualité des occasions.
- **En direct** : Dans le flux, ne pas surpondérer le nombre brut de tirs : privilégier les tirs cadrés, la proximité du but et les corners enchaînés.
- **Limite** : Exemple d'un seul match.
- Confiance : moyenne

### Analyse de tendance d'un joueur : un arrière droit qui tire souvent seul
Pour un arrière droit, les cartes d'opportunité de trois matchs montrent des tirs depuis l'extérieur de la surface sur l'aile droite, ce qui représente environ 0,2 à 0,3 but par match attendu pour quatre tirs sans but. Dans le match suivant, il tire deux fois depuis la même zone et marque deux fois. Le décalage entre opportunités et buts annonçait un retour à la moyenne.

- **Principe** : Une série d'opportunités sans but est souvent suivie d'un rattrapage.
- **En direct** : Joueurs ou équipes sous leur xG cumulé : à surveiller pour un but futur (sans extrapoler sur peu d'exemples).
- **Limite** : Anecdote d'un seul joueur.
- Confiance : faible


## Seeing in to the future: modelling football player movements
https://www.youtube.com/watch?v=iD-EE4nUbwI

### Trois principes spatiaux : probabilité de passe, impact de passe, contrôle de zone
La probabilité de passe cartographie où le porteur peut passer sans interception (vert) ou pas (rouge). L'impact de passe mesure le danger créé par une passe vers un point (plus rouge près du but). Le contrôle de zone mesure qui arriverait le premier sur un ballon tombé là. Ces trois principes relient la géométrie du jeu au vocabulaire des entraîneurs.

- **Principe** : Un joueur peut maximiser la réussite de sa passe, son impact ou le contrôle de zone.
- **En direct** : Pour le flux : probabilité de passe ≈ possession et précision, impact ≈ passes dans le camp adverse et touches dans la surface, contrôle de zone ≈ tirs concédés limités.
- **Limite** : Principes proposés par l'intervenant et ses collaborateurs.
- Confiance : haute

### Trois zones de jeu : intervention, aide mutuelle, coopération
Inspiré de l'entraînement du FC Barcelone, le terrain autour du ballon se découpe en zone d'intervention (près du porteur : garder le ballon), zone d'aide mutuelle (ouvrir des lignes de passe) et zone de coopération (occuper l'espace loin du ballon, anticiper la perte). L'intervenant fait le parallèle avec les zones de répulsion, d'alignement et d'attraction des bancs de poissons.

- **Principe** : Chaque joueur agit différemment selon sa distance au ballon.
- **En direct** : Les joueurs éloignés du ballon décident de la transition : une équipe qui contrôle bien la zone de coopération concède moins de contres.
- **Limite** : Cadre conceptuel, non quantifié ici.
- Confiance : moyenne

### xG : un angle et une régression logistique
L'angle de tir vers le but (largeur 7,32 m) explique bien la probabilité de marquer : une régression logistique sur l'angle, avec courbes de niveau à 7 %, 15 % et 30 %. Ajouter la distance, des termes non linéaires, le pied, la contre-attaque, ou les positions des adversaires en tracking améliore le modèle. Exemple : Cristiano Ronaldo n'a marqué que 2 buts sur environ 60 tirs hors surface (≈3 %), la qualité vient de la proximité.

- **Principe** : Plus l'angle et la proximité sont bons, plus la probabilité de marquer monte.
- **En direct** : Les tirs depuis l'extérieur de la surface sont à environ 3 % ou moins ; les compter comme des occasions surestime le danger.
- **Limite** : Chiffre de Ronaldo cité de mémoire dans une saison de Liga.
- Confiance : haute

### Valeur d'une passe par chaîne de possession (deux régressions)
Une chaîne se brise quand l'adversaire touche deux fois de suite le ballon. Pour chaque type de passe, une régression logistique donne la probabilité d'un tir, une seconde le xG du tir ; leur produit est la valeur de la passe (par exemple une chance sur dix de finir en but = 0,1). Données Opta utilisées pour toutes les actions, y compris interceptions et têtes.

- **Principe** : La valeur d'une passe est la probabilité de tir × le xG moyen de ce tir.
- **En direct** : Les passes dans la surface ou les longues passes vers l'aile valent plus que la possession dans son camp.
- **Limite** : Modèle de l'intervenant, avec les limites déjà vues.
- Confiance : haute

### Probabilité de passe par la physique plutôt que par l'apprentissage automatique
Le modèle de Fran Peralta calcule la trajectoire du ballon et la course de chaque joueur pour savoir s'ils peuvent intercepter. L'intervenant préfère une approche physique parce que les données de tracking du ballon sont de mauvaise qualité et parce que les modèles construits à partir de connaissances expertes marchent mieux avec peu de données. Exemple : une passe d'Alex avait une faible probabilité alors qu'une autre option verte existait.

- **Principe** : Mieux vaut construire un modèle avec la connaissance du jeu que laisser une machine tout apprendre.
- **En direct** : Principe pour l'app : encoder des règles de football sensées plutôt que de laisser un modèle apprendre sur trop peu de matchs.
- **Limite** : Avis de l'intervenant, sans comparaison chiffrée.
- Confiance : moyenne

### Courses de dégagement : créer l'espace puis s'arrêter
Dans un but de Barcelone, l'ailier court d'abord pour attirer un défenseur (ce qui libère de l'espace pour l'arrière gauche), puis s'arrête à un endroit qui maximise son propre contrôle de zone une seconde plus tard. Les joueurs alternent entre maximiser la probabilité de passe et le contrôle de zone.

- **Principe** : Les courses sans ballon servent à ouvrir un espace avant de se placer.
- **En direct** : Un tempo irrégulier avec des pics de tirs suit souvent ce type de mouvement.
- **Limite** : Analyse d'un cas, pas statistique.
- Confiance : faible

### Test sur le terrain : le produit probabilité × impact explique le mieux les mouvements
En simulant un joueur qui connaît le futur à une seconde et maximise le contrôle, la probabilité de passe, l'impact ou leurs produits, l'intervenant trouve que le produit probabilité de passe × impact est le meilleur prédicteur de la position des attaquants proches du ballon dans un match contre Malmö. Le seul contrôle de zone ne bat pas « rester sur place ». Les résultats sont plus faibles contre un autre adversaire.

- **Principe** : Les attaquants pensent en réussite × danger, pas en contrôle pur.
- **En direct** : La bonne cible d'une équipe est la combinaison de sécurité et de danger : peu de passes ratées dans les zones dangereuses.
- **Limite** : Travail en cours sur deux matchs d'un club suédois.
- Confiance : moyenne


## Delving deeper into the tracking data with python: measuring the physical performance of players
https://www.youtube.com/watch?v=VX3T-4lB2o0

### Le tracking donne la vitesse et l'élan, pas seulement la position
Les positions sont mesurées toutes les 40 ms (25 images par seconde) ; avec elles on calcule vitesses et accélérations. Dans l'exemple, les flèches de vitesse montrent un mouvement massif vers le but adverse : le contexte d'une contre-attaque, où la plupart des passes disponibles sont vers l'avant. Sans vitesse, on ne voit pas l'intention.

- **Principe** : La direction et la vitesse des joueurs changent la lecture d'une situation.
- **En direct** : Dans le flux : plus de passes dans le camp adverse et de centres rapidement enchaînés suggèrent une transition rapide.
- **Limite** : Description de la donnée Metrica, échantillon de deux matchs.
- Confiance : moyenne

### Nettoyer les vitesses : écarter les valeurs aberrantes et lisser
La vitesse brute est la différence de position divisée par 40 ms. Toute valeur au-dessus de 12 m/s (le record d'Usain Bolt) est écartée comme erreur de suivi, puis un filtre de Savitzky-Golay lisse le signal. Les mouvements en vidéo sont beaucoup moins saccadés après lissage.

- **Principe** : Écarter l'impossible puis lisser avant de calculer quoi que ce soit.
- **En direct** : Même hygiène pour le flux de l'app : écarter les valeurs absurdes d'un fournisseur de stats (compteurs qui décroissent).
- **Limite** : Seuil de 12 m/s donné comme borne physique.
- Confiance : haute

### Bandes de vitesse et sprints : définitions utilisées
Marche sous 2 m/s, trot de 2 à 4, course de 4 à 7, sprint au-dessus de 7 m/s. Un sprint soutenu est au moins une seconde au-dessus de 7 m/s. Dans le match de démonstration, la plupart des joueurs font 5 à 8 sprints, un attaquant en fait 13, surtout sur le côté gauche ; un gardien parcourt environ 5 km. Milieux et attaquants font l'essentiel de la course à haute vitesse.

- **Principe** : Distance totale et sprints décrivent deux profils d'effort différents.
- **En direct** : Une équipe qui court beaucoup vers l'avant en fin de match a généralement encore de l'énergie ; une baisse de tirs et de corners signale la fatigue.
- **Limite** : Chiffres d'un match d'exemple, non généralisables.
- Confiance : moyenne

### Minutes jouées et distance totale par joueur
Les minutes jouées se déduisent de la première et dernière observation du joueur (exemple : huit joueurs sur 94 minutes, un remplaçant 10 minutes après un joueur sorti à la 83e). La distance est la somme de vitesse × 0,04 s. Les milieux axiaux et l'ailier droit couvrent le plus de distance.

- **Principe** : Il faut normaliser par minutes jouées avant de comparer deux joueurs.
- **En direct** : Pour le flux : rapporter les compteurs à la minute écoulée et à l'effectif (remplacements, cartons rouges).
- **Limite** : Description de code.
- Confiance : moyenne


## Creating an Interactive Shot Map (Intro to R Shiny 1/3)
https://www.youtube.com/watch?v=-a4NC65x_qQ

### Champs manquants dans un flux d'événements : exemple du destinataire d'une passe
Le présentateur corrige un bug : certaines passes StatsBomb n'ont pas de destinataire, et l'absence décale tout le vecteur de la ligne (le destinataire reçoit l'identifiant de la passe, le pied devient un identifiant). La solution est de tester l'existence du champ et de mettre une valeur manquante (NA) quand il est absent.

- **Principe** : Un champ optionnel qui manque peut corrompre silencieusement toute l'analyse.
- **En direct** : Pour l'app : tout compteur absent d'un flux (xG, tirs cadrés) doit rester manquant et non devenir zéro.
- **Limite** : Leçon de qualité de données, pas de football.
- Confiance : haute

### Écart entre buts réels et xG cumulé par équipe
Les tirs sont agrégés par match et équipe pour calculer le xG total, comparé aux buts réellement marqués (variable xG diff). Une équipe qui sous-performe constamment (attendue à trois buts, en marque un ou deux) est une piste d'exploration. Ce jeu de données comprend environ 20 380 tirs.

- **Principe** : Écart durable entre buts et xG = finition, qualité de gardien, ou modèle à corriger.
- **En direct** : Un écart ponctuel de buts vs xG n'est pas un signal ; il faut plusieurs matchs.
- **Limite** : Définition donnée à titre d'outil, sans résultat.
- Confiance : moyenne


## How to create the mathematically perfect press using pitch control
https://www.youtube.com/watch?v=s6bpn3Uox7M

### Le pressing efficace est collectif et réduit la zone rouge de l'adversaire
Dans un 4-0 contre Östersunds, trois buts de Hammarby viennent d'une récupération haute quand l'adversaire cherche à sortir de derrière. La vue de dessus montre qui contribue : les joueurs proches marquent leurs adversaires pendant que les milieux couvrent des zones plutôt que des hommes. L'objectif en défense est de réduire la surface rouge (celle que l'adversaire contrôle) et en attaque d'augmenter la surface verte.

- **Principe** : Presser consiste à couvrir de l'espace ensemble, pas à tacler individuellement.
- **En direct** : Un pic de fautes et de balles récupérées haut suit souvent un pressing ; les tirs qui suivent viennent des récupérations hautes.
- **Limite** : Exemples sélectionnés parmi les réussites, l'intervenant le reconnaît.
- Confiance : moyenne

### Sacrifier la zone la moins dangereuse
Contre une équipe qui joue à onze, on ne peut pas tout couvrir : le pressing laisse volontairement l'arrière latéral loin du ballon, car s'il reçoit, l'équipe a le temps de se réorganiser. Quand le pressing réussit, le ballon sort dans une direction aléatoire et les milieux positionnés derrière en reprennent la possession.

- **Principe** : Une bonne pression abandonne la zone la moins dangereuse.
- **En direct** : Une équipe qui presse haut s'expose derrière ; dans le flux, attendre des tirs adverses sur contre après une série de corners n'est pas anormal.
- **Limite** : Principe tactique d'une équipe, sans mesure du gain.
- Confiance : moyenne

### Positionnement optimal par rapport à la position réelle
Une simulation calcule les positions qui couvriraient le plus d'espace ; deux milieux étaient presque aux positions optimales. Une étude de Barcelone aurait montré que Messi est le joueur qui marche le plus intelligemment pour occuper le bon espace. Hammarby, battu 2-0 par Dalkurd, avait par ailleurs des défauts de couverture que l'on corrigeait en réunion avec les joueurs.

- **Principe** : Les joueurs qui paraissent passifs peuvent occuper des zones clés.
- **En direct** : Un faible nombre d'actions défensives n'indique pas un manque d'implication, surtout pour une équipe bien organisée.
- **Limite** : Anecdote sur Messi non sourcée dans la vidéo.
- Confiance : faible


## How to explain expected goals to a football player
https://www.youtube.com/watch?v=Xc6IG9-Dt18

### Explication simple du xG avec trois cercles : 30 %, 15 % et 7 %
Pour expliquer le xG à des joueurs, l'intervenant utilise des cercles autour de la surface : un tir dans le cercle de 30 % a plus de 30 % de chances de marquer, 15 % dans le suivant, 7 % dans le suivant. Un tir de tête d'un joueur à Hammarby dans le match, pourtant très ouvert, valait environ 10 %. Un joueur disait penser en pourcentages après les matchs.

- **Principe** : Penser en probabilités pour discuter des occasions sans émotion.
- **En direct** : Le flux n'a pas la position des tirs mais le nombre de tirs cadrés et de touches dans la surface ; les tirs lointains sont à 1 à 7 %.
- **Limite** : Valeurs de rings tirées du modèle de l'intervenant ; une distribution précise est dans le modèle de xG.
- Confiance : haute

### La position compte plus que la qualité de la finition
Deux attaquants de niveau comparable ont une différence de finition minime ; ce qui se répète sur des saisons, c'est d'atteindre les bonnes positions. Pour Messi, Neymar et Suárez à Barcelone (saison avec Neymar), à deux tirs près tous les buts de Liga sont venus d'intérieur des cercles décrits. Le hasard (gardien, rebond) pèse beaucoup sur un tir donné.

- **Principe** : Évaluer un attaquant à la qualité des positions qu'il atteint, pas aux buts d'une série.
- **En direct** : Une équipe qui crée des occasions proches du but (touches dans la surface élevées) est plus fiable qu'une équipe qui marque par hasard de loin.
- **Limite** : Exemple de la Liga sur quelques saisons, avec peu de tirs hors cercle.
- Confiance : haute

### Tirs de loin : environ 1 sur 30 pour Ronaldo, 1 sur 25 pour Bale
Cristiano Ronaldo marque environ une fois sur 30 en tirant de l'extérieur de la surface (2 buts sur 60 tirs environ), Gareth Bale environ une fois sur 25 ; ils tirent beaucoup de loin, mais les 29 échecs ne passent pas sur les réseaux. Leur force est de se placer dans la surface. Les tirs lointains valent environ 1 %, contre 7 % depuis la zone suivante.

- **Principe** : Un tir de loin a une probabilité d'environ 1 à 3 % de marquer.
- **En direct** : Un grand nombre de tirs hors de la surface ne doit pas faire monter la probabilité de but du match.
- **Limite** : Chiffres cités de mémoire par l'intervenant, deux joueurs sur quelques saisons.
- Confiance : moyenne

### Exemple concret : un ailier qui avance pour tirer à 7 % au lieu de 1 %
Le joueur Moyo (Hammarby) tirait trop de loin (1 % de chances) ; après discussion avec l'analyste, il a avancé dans la surface. Un but marqué montre la progression : de moins de 1 % à la réception à 7 % au tir, après les appels d'autres attaquants qui ont déplacé les défenseurs. Un coéquipier mieux placé (10 à 15 %) aurait pu recevoir la passe, mais le risque d'une passe manquée équilibre le choix : le but de la discussion est d'avoir un débat raisonné plutôt qu'émotionnel.

- **Principe** : Se rapprocher du but vaut plus que de tirer plus vite ; passer ou tirer se juge au produit des probabilités.
- **En direct** : Voir comment les occasions se rapprochent du but dans le temps (touches dans la surface) est un indice plus fiable que le total de tirs.
- **Limite** : Cas d'un seul joueur sur quelques matchs.
- Confiance : moyenne


## Making Your Own Shot and Pass Maps
https://www.youtube.com/watch?v=oOAnERLiN5U

### Données d'événements : seulement ce qui touche le ballon
Les événements ne contiennent que les actions avec le ballon : passes (départ, arrivée, destinataire), tirs (position, destination dans ou hors du cadre), interceptions, tacles. Ils n'incluent pas la position des joueurs sans ballon, sauf lorsqu'ils le touchent. Les dimensions StatsBomb sont 120 x 80 (yards), ce que l'intervenant rappelle pour tracer le terrain.

- **Principe** : Les données d'événements ne voient pas l'espace libre ni les appels sans ballon.
- **En direct** : Le flux est encore plus pauvre : il n'a pas de positions du tout, uniquement des totaux d'actions.
- **Limite** : Rappel de cadre, utile pour limiter les attentes.
- Confiance : haute

### Carte de tirs avec cercle proportionnel au xG
En traçant les tirs d'un match (Suède–Angleterre, Coupe du monde féminine) avec une aire de cercle proportionnelle au xG, c'est-à-dire un rayon proportionnel à la racine carrée de la probabilité, on voit que les buts n'étaient pas forcément les meilleures occasions : deux buts suédois avaient un xG faible, celui de l'Angleterre était plus élevé. Un match où les deux équipes ont eu de bonnes occasions.

- **Principe** : L'aire du cercle doit représenter la probabilité, pas son rayon.
- **En direct** : Un but à faible xG reste un événement chanceux : ne pas en tirer de conséquence sur la suite du match.
- **Limite** : Un seul match, xG du fournisseur StatsBomb.
- Confiance : moyenne

### Communiquer avec une seule figure
L'exercice demande d'expliquer en un tweet et au plus deux figures un joueur observé, en testant si les données confirment ou contredisent l'impression. Au club, on ne peut pas écrire un rapport entier : un entraîneur ou un joueur reçoit une figure.

- **Principe** : L'analyse n'est utile que si elle se dit en une image et une phrase.
- **En direct** : Pour les cartes de l'app : une conclusion en une phrase avec un seul chiffre, sans surcharge.
- **Limite** : Consigne pédagogique, pas un résultat.
- Confiance : faible


## Loading in and investigating World Cup data in Python
https://www.youtube.com/watch?v=GTtuOt03FM0

### Sources ouvertes pour pratiquer : StatsBomb et Wyscout
Les données StatsBomb en accès libre (environ 19 compétitions dans ce cours, dont la Coupe du monde féminine 2019 et masculine 2018) et le jeu Wyscout publié sur figshare permettent d'apprendre sans accès commercial. Les fichiers JSON sont hiérarchiques : compétitions, puis matchs, puis événements, et on y navigue comme dans un tableur arborescent.

- **Principe** : On peut apprendre l'analyse de matchs avec des données ouvertes avant de payer un fournisseur.
- **En direct** : Ces jeux ouverts servent à calibrer des règles d'évaluation avant de les appliquer à un flux en direct.
- **Limite** : Les données couvrent des compétitions précises, pas toutes les ligues.
- Confiance : moyenne

### Apprendre en faisant : retrouver un match par ses équipes
Le cours montre comment parcourir tous les matchs d'une compétition pour trouver l'identifiant du match Angleterre–Suède (69301 dans les notes) ou lister les résultats d'une équipe. L'intervenant insiste : on apprend la syntaxe en cherchant en ligne, la compétence importante est de formuler la question.

- **Principe** : Une bonne question guide le code ; la syntaxe se retrouve.
- **En direct** : Même chose pour l'app : définir ce qu'on veut mesurer avant de choisir la statistique.
- **Limite** : Tutoriel de programmation.
- Confiance : faible


## Advice for anyone who wants to become a football data scientist
https://www.youtube.com/watch?v=cnEDCqmqCzw

### Communiquer vaut mieux qu'un modèle un peu plus précis
Pour le data scientist de la fédération allemande, la compétence la plus importante est de communiquer avec les entraîneurs : un modèle moins précis mais compris vaut mieux qu'un modèle meilleur non transmis. Certains clubs ont un communicant dédié (analyste de match ou adjoint). Un test proposé : expliquer son travail à quelqu'un qui n'est pas du domaine ; si les yeux se ferment au bout de cinq minutes, il faut travailler la communication.

- **Principe** : Un indicateur que personne ne comprend ne sert pas.
- **En direct** : Pour l'app : une alerte doit s'énoncer en une phrase (tirs cadrés, minute, xG) plutôt qu'un score abstrait.
- **Limite** : Conseil de carrière, pas un résultat de modèle.
- Confiance : moyenne

### Comprendre le football compte autant que savoir programmer
Tous les invités soulignent qu'il faut aimer et comprendre le football : les experts (entraîneurs, analystes tactiques, préparateurs physiques) apportent les idées de variables, et sans cette culture on ne propose pas de bonnes idées ni ne se fait respecter. Le métier demande aussi une charge de travail élevée pour un salaire moyen, donc de la passion.

- **Principe** : Les bonnes variables viennent de la connaissance du jeu.
- **En direct** : Avant d'ajouter une statistique au flux, se demander quelle observation d'entraîneur elle vient confirmer.
- **Limite** : Opinions personnelles des invités.
- Confiance : faible

### Les fruits à portée de main : des choses simples bien faites
L'invité de Benfica insiste sur le fait que les clubs sont heureux de recevoir des choses simples faites correctement et régulièrement : nettoyage de données, visualisations claires (Power BI, Tableau), puis modélisation avancée si besoin. Il recommande de savoir expliquer l'incertitude : d'où vient la donnée, quel échantillon, quelle variance est expliquée, variabilité entre joueurs et chez un même joueur.

- **Principe** : Maîtriser l'incertitude et l'échantillon avant de modéliser.
- **En direct** : Ne jamais afficher une probabilité sans dire sur combien de matchs elle repose.
- **Limite** : Avis d'un praticien, pas une règle.
- Confiance : haute

### Se former sur ses propres sujets avec des données ouvertes
Plusieurs conseils : apprendre à programmer sur un sujet qui passionne (le football), utiliser les données ouvertes (StatsBomb, jeu Wyscout sur figshare avec une saison par grand championnat), s'inspirer de codes de collecte existants plutôt que de réinventer. Un préparateur physique est devenu autonome en R et Python en travaillant une demi-heure à une heure par jour.

- **Principe** : Une pratique régulière et courte sur un sujet aimé suffit.
- **En direct** : Pour l'app : construire les règles sur des données ouvertes avant de payer des fournisseurs.
- **Limite** : Conseils d'apprentissage.
- Confiance : faible

### Hackathons et concours comme porte d'entrée
Les invités citent les concours de recrutement : hackathons de la fédération allemande (deux saisons de Bundesliga), du PSG (le vainqueur aurait obtenu deux thèses financées), de la NBA, de la NFL, le forum d'Opta en février avec mentor. Ils observent que dans les faits peu de gens sont arrivés par des voies planifiées ; beaucoup par des rencontres fortuites, soutenues ensuite par des compétences et une communauté.

- **Principe** : Montrer un travail concret sur un jeu de données imposé ouvre des portes.
- **En direct** : Rien d'immédiat pour le flux en direct.
- **Limite** : Anecdotes de carrière.
- Confiance : faible


## Getting Started with R + StatsBomb | Analyzing Squad Rotation and Clustering Passes
https://www.youtube.com/watch?v=ilIIjqfstfQ

### Rotation d'effectif : combien de titulaires changent d'un match à l'autre
La rotation se mesure par la différence d'ensemble entre les onze titulaires de deux matchs consécutifs (nombre de joueurs changés), croisée avec le résultat du match, pour chaque équipe de la FA Women's Super League 2018-19. Le graphique en barres par journée, coloré par résultat (victoire, nul, défaite), permet de repérer les équipes qui tournent beaucoup et ce que cela donne.

- **Principe** : Un changement du onze de départ est mesurable et comparable entre équipes.
- **En direct** : Un onze très remanié peut expliquer une baisse des tirs ou de la possession sur le début du match.
- **Limite** : Exemple descriptif d'une seule saison, sans test de lien avec les résultats.
- Confiance : faible

### Séquence de passes dans une possession
Pour chaque possession, on numérote les passes (1, 2, 3...) afin de repérer leur rang dans la séquence ; une possession de 16 passes se différencie d'une attaque directe. Les passes sont aussi classées par équipe et par destinataire, la qualité des données imposant de gérer les passes sans destinataire.

- **Principe** : La longueur d'une possession est un indicateur de style (construction lente ou attaque directe).
- **En direct** : Dans le flux, possession élevée avec peu de tirs cadrés = longue circulation sans pénétration.
- **Limite** : Choix de codage, non évalué.
- Confiance : faible

### Classer les passes en groupes avec k-moyennes
Sur 97 000 à 100 000 passes de la FA Women's Super League, les passes (point de départ et d'arrivée) sont classées en 25, 50 ou 75 groupes par k-moyennes ; on calcule les positions moyennes de départ et d'arrivée par groupe. On compare ensuite le nombre de passes d'une équipe dans chaque groupe à la moyenne de la ligue par un z-score, en retenant les groupes à plus de 1,5 écart-type (exemple pris sur Arsenal).

- **Principe** : Les types de passes typiques d'une équipe se repèrent par rapport à la ligue.
- **En direct** : Un comportement qui dépasse nettement la norme de la ligue est une signature de style : à surveiller contre cette équipe.
- **Limite** : L'auteur doute de la pertinence de certains résultats (passes étranges) et signale qu'il faudrait vérifier les données.
- Confiance : faible

### Standardiser les coordonnées avant de grouper
Les données StatsBomb vont de 0 à 120 en x et de 0 à 80 en y, l'origine étant en haut à gauche ; il faut renverser l'axe et écarter les valeurs hors terrain avant d'appliquer un algorithme. Pour de gros volumes, on parallélise le calcul.

- **Principe** : Toujours nettoyer et normaliser les coordonnées avant de comparer ou de grouper.
- **En direct** : Pour le flux : s'assurer que les unités et les repères sont cohérents avant toute comparaison entre sources.
- **Limite** : Rappel technique.
- Confiance : moyenne
