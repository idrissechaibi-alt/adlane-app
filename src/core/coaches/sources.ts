// Sources de la base de savoir des entraîneurs. Chaque fait de SOURCED_FACTS renvoie à une source de SOURCES.
// « lu » = page ou PDF ouvert et interrogé le 25/10/2026 ; « extrait » = seulement le résumé du résultat de recherche.

export interface KnowledgeSource {
  id: string;
  citation: string;
  url: string;
  access: 'lu' | 'extrait';
  /** Football (association) uniquement : les sources d'autres sports sont exclues. */
  note?: string;
}

export const SOURCES: KnowledgeSource[] = [
  { id: 'S1', citation: 'Temporal dynamics of goal scoring in soccer (arXiv 2501.18606) — 3 433 matchs, 21 ligues et compétitions', url: 'https://arxiv.org/pdf/2501.18606', access: 'lu' },
  { id: 'S2', citation: 'Eusebio, Prieto-González, Marcelino (2024). An analysis of transition-resulted goal scoring patterns in football leagues. BMC Sports Sci Med Rehabil 16:60', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10908095/', access: 'lu' },
  { id: 'S3', citation: 'Wei, Shu, Liu, Chmura, Randers, Krustrup (2024). Analysing substitutions in recent World Cups and European Championships. Biology of Sport 41', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11167463/', access: 'lu' },
  { id: 'S4', citation: 'Ivanov (IntelligentFC, 2018). How does a red card affect the outcome of a football match — 7 979 matchs de Liga, Premier League et Serie A', url: 'http://intelligentfc.com/how-does-a-red-card-affect-the-outcome-of-a-football-match/', access: 'lu', note: 'Billet d’analyste, pas une étude évaluée par des pairs.' },
  { id: 'S5', citation: 'Effects of a red card on goal-scoring in World Cup football matches (cadre à taux de risque)', url: 'https://www.researchgate.net/publication/318186703_Effects_of_a_red_card_on_goal-scoring_in_World_Cup_football_matches', access: 'extrait' },
  { id: 'S6', citation: 'Estimating the effect of the red card in soccer: when to commit an offense in exchange for preventing a goal opportunity', url: 'https://www.researchgate.net/publication/210215902_Estimating_the_effect_of_the_red_card_in_soccer_When_to_commit_an_offense_in_exchange_for_preventing_a_goal_opportunity', access: 'extrait' },
  { id: 'S7', citation: 'Boyko, Boyko, Boyko (2007). Referee bias contributes to home advantage in English Premiership football. J Sports Sci 25(11):1185-1194', url: 'https://pubmed.ncbi.nlm.nih.gov/17654230/', access: 'extrait' },
  { id: 'S8', citation: 'Endrich, Gesche (2020). Home-bias in referee decisions: evidence from « Ghost Matches » during the Covid19-Pandemic. Economics Letters 197', url: 'https://www.sciencedirect.com/science/article/pii/S0165176520303815', access: 'extrait' },
  { id: 'S9', citation: 'Systematic literature review on home advantage in football during COVID-19 (PMC8724651) — synthèse de Scoppa 2021, Sors 2020, Link 2021, Dilger 2020, McCarrick 2021', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8724651/', access: 'extrait' },
  { id: 'S10', citation: 'Scoppa (2026). VAR, Referee Bias, and Home Advantage: Evidence from European Football (58 783 matchs, données football-data.co.uk)', url: 'https://www.researchgate.net/publication/402152079_VAR_Referee_Bias_and_Home_Advantage_Evidence_from_European_Football', access: 'extrait' },
  { id: 'S11', citation: 'Expecting Goals — The Set Piece Revolution in the Premier League', url: 'https://www.expectinggoals.com/p/the-set-piece-revolution', access: 'extrait', note: 'Billet d’analyste.' },
  { id: 'S12', citation: 'Tactical Football Analysis — World Cup 2026 group stage set-piece trends', url: 'https://tacticalfootballanalysis.com/world-cup-2026-group-stage-set-piece-trends-tactics-analysis/', access: 'extrait', note: 'Billet d’analyste.' },
  { id: 'S13', citation: 'Hudl — What is Expected Threat (xT)? Possession Value models explained (Karun Singh 2018 ; VAEP, Decroos et al.)', url: 'https://www.hudl.com/blog/possession-value-models-explained', access: 'extrait' },
  { id: 'S14', citation: 'Fernández, Bornn, Cervone (2021). A framework for the fine-grained evaluation of the instantaneous expected value of soccer possessions. Machine Learning 110', url: 'https://doi.org/10.1007/s10994-021-05989-6', access: 'extrait' },
  { id: 'S15', citation: 'Armatas et al. — Relationship between time and goal scoring in soccer games: analysis of three World Cups', url: 'https://www.researchgate.net/publication/233492477_Relationship_between_time_and_goal_scoring_in_soccer_games_Analysis_of_three_World_Cups', access: 'extrait' },
  { id: 'S16', citation: 'Decoding the complexities of transitions in football: a comprehensive narrative review (2024)', url: 'https://www.researchgate.net/publication/379664639_Decoding_the_complexities_of_transitions_in_football_a_comprehensive_narrative_review', access: 'extrait' },
  { id: 'S17', citation: 'Analysis of corner kicks at the FIFA Women’s World Cup 2019 (Int J Perform Anal Sport)', url: 'https://www.tandfonline.com/doi/full/10.1080/24748668.2021.1936408', access: 'extrait' },
  { id: 'S18', citation: 'Soccermatics — Expected Threat, action-based (documentation ouverte)', url: 'https://soccermatics.readthedocs.io/en/latest/lesson4/xTAction.html', access: 'extrait' },
  { id: 'S19', citation: 'Wikipédia — saisons 2026-27 de Premier League, La Liga, Bundesliga, Serie A et Ligue 1 (clubs, entraîneurs, changements), pages lues le 25/10/2026', url: 'https://en.wikipedia.org/wiki/2026%E2%80%9327_Premier_League', access: 'lu', note: 'Lecture automatique des tableaux ; à revérifier avant usage sensible.' },
  { id: 'S20', citation: 'ESPN (Connelly, O’Hanlon, 19/08/2026). Premier League 2026-27 mega-preview: team-by-team analysis', url: 'https://global.espn.com/football/story/_/id/49644584/premier-league-2026-2027-preview-offseason-moves-stats-analysis-predictions-teams', access: 'lu', note: 'Extraction partielle : plusieurs clubs sans style précisé.' },
  { id: 'S21', citation: 'Tactical Football Analysis — Premier League corners 2026/2027, set-piece analysis', url: 'https://tacticalfootballanalysis.com/premier-league-corners-2026-2027-set-piece-analysis-tactics/', access: 'extrait', note: 'Billet d’analyste.' },
  { id: 'S23', citation: 'Martin Cid Magazine (Nakamura, 11/09/2026). Premier League 2026-27: the tactical ideas reshaping the season, ranked', url: 'https://www.martincid.com/sports-en/premier-league-2026-27-tactical-trends-ranked/', access: 'lu', note: 'Magazine généraliste, pas une source académique.' },
  { id: 'S24', citation: 'Tactical Football Analysis — Enzo Maresca tactics at Man City 2026/2027', url: 'https://tacticalfootballanalysis.com/enzo-maresca-tactics-manchester-city-2026-2027-tactical-analysis/', access: 'lu', note: 'Publié en mai 2026, avant les matchs.' },
  { id: 'S25', citation: 'Al Jazeera (09/08/2026). La Liga: five key talking points heading into the 2026-2027 season', url: 'https://www.aljazeera.com/sports/2026/8/9/la-liga-five-key-talking-points-heading-into-the-2026-2027-season', access: 'extrait' },
  { id: 'S26', citation: 'Tactical Football Analysis — page La Liga (Real Madrid 4-1 Real Sociedad, plan de Mourinho)', url: 'https://tacticalfootballanalysis.com/tag/la-liga/', access: 'extrait' },
  { id: 'S27', citation: 'Bush, M. (2017). Contemporary factors impacting match performances of elite soccer players: the development and evolution of performance in the English Premier League. Thèse de doctorat, University of Sunderland (307 pages)', url: 'https://sure.sunderland.ac.uk/id/eprint/8850/1/BushPhD%20Thesis%20(Complete).pdf', access: 'lu', note: 'Résumé et chapitres d’évolution lus ; pas toute la thèse.' },
  { id: 'S28', citation: 'Anzer, G. (2021). Large scale analysis of offensive performance in football. Thèse de doctorat, Université de Tübingen (Bundesliga 2013-2021, 4 896 matchs, positions et événements) ; formations par phase de jeu : Anzer, Bauer, Shaw', url: 'https://bibliographie.uni-tuebingen.de/xmlui/bitstream/handle/10900/124678/Dissertation_GAN_Publication_version.pdf', access: 'lu', note: 'Résumé, conclusion et section formation contre formation lus.' },
  { id: 'S29', citation: 'Leveraging minute-by-minute soccer match event data to adjust team’s offensive production for game context (arXiv 2508.04008) — 15 saisons, 5 grands championnats, modèles additifs généralisés', url: 'https://arxiv.org/pdf/2508.04008', access: 'lu', note: 'Chiffres issus d’une lecture automatique du PDF ; à confirmer dans le tableau d’origine.' },
  { id: 'S30', citation: 'Robberechts, Van Haaren, Davis (2019). A Bayesian approach to in-game win probability in soccer (arXiv 1906.05029)', url: 'https://arxiv.org/abs/1906.05029', access: 'extrait' },
  { id: 'S31', citation: 'Real-time forecasting within soccer matches through a Bayesian lens (arXiv 2303.12401) — Premier League, 8 saisons', url: 'https://arxiv.org/abs/2303.12401', access: 'extrait' },
  { id: 'S32', citation: 'Prediction-based evaluation of back-four defense with spatial control in soccer (arXiv 2511.06191) — Liga 2023-24, 2 413 séquences du FC Barcelone et du Real Madrid', url: 'https://arxiv.org/abs/2511.06191', access: 'extrait' },
  { id: 'S33', citation: 'A graph neural network deep-dive into successful counterattacks (arXiv 2411.17450) — 632 matchs MLS, NWSL et sélections', url: 'https://arxiv.org/abs/2411.17450', access: 'extrait', note: 'Hommes et femmes séparés ; pas des ligues européennes.' },
  { id: 'S34', citation: 'Pressing intensity: an intuitive measure for pressing in soccer (arXiv 2501.04712)', url: 'https://arxiv.org/abs/2501.04712', access: 'extrait' },
  { id: 'S35', citation: 'Coach2vec: autoencoding the playing style of soccer coaches (arXiv 2106.15444) — Serie A, quatre saisons', url: 'https://arxiv.org/abs/2106.15444', access: 'extrait' },
  { id: 'S36', citation: '22bet News — The 5 key tactical trends shaping the Premier League this season (4-2-3-1 utilisé par 11 clubs sur 20)', url: 'https://news.22bet.com/news/5-key-tactical-trends-shaping-the-premier-league-this-season/', access: 'extrait', note: 'Site d’un bookmaker : source faible, date non vérifiée (probablement une saison antérieure).' },
];

export interface SourcedFact {
  topic: 'timing' | 'tendances' | 'formations' | 'evolution' | 'modeles_direct' | 'transitions' | 'cartons_rouges' | 'arbitrage' | 'remplacements' | 'coups_arretes' | 'valeur_actions' | 'momentum';
  fact: string;
  sources: string[];
  /** Comment l'app peut s'en servir (indicatif). */
  use: string;
}

export const SOURCED_FACTS: SourcedFact[] = [
  {
    topic: 'timing',
    fact: 'Sur 3 433 matchs (21 ligues et compétitions), la probabilité d’un but augmente au fil du match ; il y a moins de buts que prévu dans les premières minutes de chaque mi-temps, avec un creux entre la 45e et la 50e, et le dernier but d’un match tombe plus près de la fin que le hasard ne le prévoit. Après un but, la même équipe marque plus souvent que prévu juste ensuite (buts par rafales) et l’adversaire moins.',
    sources: ['S1'],
    use: 'Rythme de buts croissant : une ligne « plus de » vaut davantage tard dans le match ; après un but, ne pas supposer un retour immédiat à la moyenne.',
  },
  {
    topic: 'timing',
    fact: 'Sur trois Coupes du monde, la tranche de 15 minutes la plus riche en buts est la dernière (76e-90e).',
    sources: ['S15'],
    use: 'Confirme la fenêtre de buts tardifs ; extrait seulement, chiffres exacts non relus.',
  },
  {
    topic: 'transitions',
    fact: 'Sur 2 140 buts de 702 matchs, les transitions offensives et leurs prolongements directs expliquent 54,21 % des buts dans les ligues majeures de l’échantillon (Espagne, Italie, Allemagne), contre 41,97 % dans les ligues marginales (Portugal, Pays-Bas, Russie) et 43,65 % dans les ligues émergentes (Qatar, Arabie saoudite, Émirats). Les profils de buts restent stables entre le début et le milieu de saison.',
    sources: ['S2'],
    use: 'Un match ouvert, avec récupérations hautes et contres, produit plus de buts que le seul niveau de possession ne le suggère.',
  },
  {
    topic: 'cartons_rouges',
    fact: 'Un carton rouge apparaît dans environ 20 % des matchs. Pour des équipes égales, le domicile marque 1,46 but et l’extérieur 1,00 ; avec un rouge au domicile, le domicile tombe à 0,94 but marqué et 1,68 encaissé (-1,2 but d’écart). La victoire à domicile passe de 48 % à environ 18 %. Pour un rouge à l’extérieur, la victoire visiteuse passe de 23,5 % à 14,1 % et le nul reste à peu près stable.',
    sources: ['S4'],
    use: 'Après un rouge, réévaluer le 1X2 et les totaux ; l’effet est asymétrique selon le camp.',
  },
  {
    topic: 'cartons_rouges',
    fact: 'Dans un cadre à taux de risque, un rouge réduit le rythme de buts de l’équipe sanctionnée et augmente celui de l’adversaire ; une étude cite un taux de buts de l’équipe à dix ramené à environ deux tiers de sa valeur d’origine.',
    sources: ['S5', 'S6'],
    use: 'Ordre de grandeur pour recalculer la projection de buts d’une équipe à dix (extraits seulement).',
  },
  {
    topic: 'arbitrage',
    fact: 'Les arbitres sifflent moins de fautes et montrent moins de jaunes aux équipes à domicile ; sans public (matchs à huis clos de 2020), l’avantage du domicile est presque divisé par deux et les décisions deviennent plus équilibrées. Le VAR a réduit l’avantage à domicile sur les points et la différence de buts mais pas sur les penaltys ni les rouges.',
    sources: ['S7', 'S8', 'S9', 'S10'],
    use: 'Biais d’arbitrage vers le domicile sur fautes et jaunes, surtout devant un public nombreux ; à garder en repère, pas comme certitude.',
  },
  {
    topic: 'remplacements',
    fact: 'Le premier remplacement arrive en moyenne entre la 57e et la 60e minute ; l’équipe menée change plus tôt (55,3) que celle qui gagne (59,3) ou fait nul (60,2). Avec cinq remplacements autorisés, ils sont 48 % plus nombreux (4,26 contre 2,87) et environ 13 à 15 % des buts sont marqués par des remplaçants.',
    sources: ['S3'],
    use: 'La fenêtre 55e-70e est celle des changements : le rythme et les corners de l’équipe menée peuvent y monter.',
  },
  {
    topic: 'coups_arretes',
    fact: 'Dans la Premier League récente, une part croissante de buts vient de corners en inswing visés vers la zone des six mètres (près de trois corners sur dix) et de touches longues ; environ 70 % des corners de la saison précédente étaient en inswing ; les centres vers les six mètres produisent aussi davantage de buts contre son camp. Le gain en buts dépasse la hausse du nombre de tirs, d’où une part de chance de finition.',
    sources: ['S11', 'S12'],
    use: 'Les corners ne sont pas qu’un volume : leur qualité varie selon la ligue et l’équipe. Billets d’analystes, à recouper.',
  },
  {
    topic: 'coups_arretes',
    fact: 'Étude de la Coupe du monde féminine 2019 : les buts sur corner sont plus probables après des attaques dynamiques ou avec 1 à 4 défenseurs sur les corners courts ; les tirs cadrés sont plus probables sur des corners dans certaines zones.',
    sources: ['S17'],
    use: 'Extrait seulement ; football féminin, à ne pas généraliser.',
  },
  {
    topic: 'valeur_actions',
    fact: 'L’Expected Threat (xT, Karun Singh 2018) attribue à chaque zone du terrain une valeur égale à la probabilité de but à partir de cette zone et crédite les joueurs qui font progresser le ballon ; il ignore les actions défensives et les tirs. VAEP (Decroos et al.) estime avant/après chaque action la variation de probabilité de marquer et d’encaisser.',
    sources: ['S13', 'S14', 'S18'],
    use: 'Justifie de privilégier les touches dans la surface adverse et les passes dans le camp adverse (nos marqueurs avancés) plutôt que la possession brute.',
  },
  {
    topic: 'momentum',
    fact: 'Attention : l’article « On the existence of momentum in professional football » (PLOS ONE 2022) porte sur le football AMÉRICAIN (NFL 2002-2012), pas sur le football association. Il n’est donc PAS retenu comme preuve pour nos matchs. Pour le football association, les rafales de buts après un but (S1) sont le seul appui chiffré lu pour l’instant.',
    sources: ['S1'],
    use: 'Le momentum de la carte FotMob reste un indicateur de pression, pas une preuve de causalité.',
  },
  {
    topic: 'timing',
    fact: 'Quinze saisons des cinq grands championnats, modèle additif minute par minute : l’état du score, les cartons rouges, le domicile, la force relative et la minute influencent tous les tirs (et presque toujours les corners). Les facteurs d’ajustement vers un match nul à effectif égal valent environ 0,77-0,92 pour une équipe menée d’un but, 1,12-1,35 pour une équipe qui mène d’un but et 1,35-1,75 à partir de +2 : l’équipe qui mène produit donc moins, l’équipe menée plus. L’effet est le plus marqué en Serie A. L’hypothèse « l’équipe menée devient de plus en plus offensive et celle qui mène de plus en plus prudente à mesure que la fin approche » n’est quasiment PAS confirmée (peu d’interactions significatives après correction), d’où un modèle additif simple.',
    sources: ['S29'],
    use: 'À l’état du score près, ne pas amplifier artificiellement l’effet « fin de match » ; appliquer un facteur constant de score aux tirs et aux corners.',
  },
  {
    topic: 'cartons_rouges',
    fact: 'Même étude (S29) : les facteurs d’ajustement valent environ 1,60-1,75 pour une équipe à dix (un rouge) et 2,25-3,00 à neuf ou moins, contre 0,62-0,75 pour l’équipe en supériorité d’un joueur (0,40-0,70 à +2). Autrement dit, l’équipe à dix produit environ 0,6 fois ce qu’elle produirait à onze et l’équipe en supériorité environ 1,3 à 1,6 fois.',
    sources: ['S29'],
    use: 'Un rouge fait baisser les tirs et corners de l’équipe sanctionnée et monter ceux de l’adversaire ; ordre de grandeur, lecture automatique à confirmer.',
  },
  {
    topic: 'formations',
    fact: 'Bundesliga, 13 081 observations de formation sur 1 803 matchs : la construction à deux défenseurs centraux (2-4-3-1) est la plus fréquente et génère en moyenne 1,41 xG par match ; contre elle, un bloc médian 4-2-3-1 concède 1,32 xG et un 5-2-3 concède 1,59 xG (0,27 xG d’écart par match, près de neuf buts par saison). La construction à trois défenseurs (3-1-4-2) produit 1,36 xG et tombe à 1,17 xG face à un 4-2-3-1. Les buts ne sont pas très fréquents (3,1 par match dans cet échantillon).',
    sources: ['S28'],
    use: 'Le choix de la formation compte, mais l’effet reste de l’ordre de quelques dixièmes de xG par match.',
  },
  {
    topic: 'evolution',
    fact: 'Premier League 2006-07 → 2012-13 : la course à haute intensité augmente de 24 à 35 % selon les postes, les sprints d’environ 50 %, les passes d’environ 40 % ; les latéraux changent le plus. L’auteur montre aussi que les variables rares (tirs, tacles) sont très variables d’un match à l’autre et qu’il faut beaucoup de matchs pour les estimer ; il propose des fourchettes autour d’une performance typique plutôt qu’une prédiction.',
    sources: ['S27'],
    use: 'Le jeu s’intensifie avec le temps : des repères anciens (rythme, passes) sous-estiment le football actuel. Éviter de conclure sur peu de matchs.',
  },
  {
    topic: 'modeles_direct',
    fact: 'Un modèle bayésien de probabilité de victoire en direct pour le football, entraîné sur huit saisons des cinq grands championnats, donne des probabilités bien calibrées ; les modèles transposés d’autres sports sont peu précis dans le football, surtout en fin de match, à cause du faible nombre de buts. Un autre modèle en temps réel (probit multinomial, effets des variables qui varient avec le temps, huit saisons de Premier League) bat des concurrents statistiques et d’apprentissage automatique.',
    sources: ['S30', 'S31'],
    use: 'Les effets des variables en direct changent avec la minute : prévoir des coefficients variables dans le temps.',
  },
  {
    topic: 'transitions',
    fact: 'Défense à quatre en repli après une perte de balle (Liga 2023-24, Barcelone et Real Madrid, 2 413 séquences) : la hauteur relative de la ligne est le facteur le plus associé à la réussite défensive, avec le contrôle de l’espace ; Barcelone gagne par la compacité et le contrôle d’espace, le Real Madrid par une défense plus adaptative mais moins régulière. Pour les contre-attaques réussies (632 matchs MLS, NWSL et sélections), les variables les plus importantes sont la vitesse d’une ligne de but à l’autre, l’angle vers le but et l’angle vers le ballon.',
    sources: ['S32', 'S33'],
    use: 'Un bloc haut exposé aux contres est plus risqué ; la vitesse de progression verticale prédit la réussite d’un contre.',
  },
  {
    topic: 'coups_arretes',
    fact: 'Règles de corner modifiées en 2026 : lors de la phase de groupes de la Coupe du monde 2026, 51,2 % des corners étaient en inswing, contre environ 70 % en Premier League la saison précédente. Les six grands clubs anglais (1 307 corners en 2025-26 : 69,1 % inswing, 15,2 % outswing, 15,7 % courts) gardaient les mêmes habitudes en match de préparation. Arsenal, champion, s’est distingué par ses corners physiques et répétitifs.',
    sources: ['S21'],
    use: 'Les profils de corners de la saison précédente restent un repère valable pour les gros clubs anglais, à surveiller selon l’adaptation aux règles.',
  },
  {
    topic: 'tendances',
    fact: 'Premier League 2026-27 (début de saison) selon un magazine : 1) le ballon arrêté comme arme principale (touches longues dessinées, corners à plus haut taux de buts « record », près d’un but sur cinq sur ballon arrêté ; Brentford en tête) ; 2) le gardien qui sort du rôle de premier relanceur ; 3) le retour du triangle du troisième homme (Arsenal, Coventry) ; 4) la valeur du contrôle (City) ; 5) le bloc bas qui « remonte » (Hull) ; 6) l’attaque sans plan dans le dernier tiers (Tottenham et Aston Villa sans but sur leurs trois premiers matchs). Huit nouveaux managers ont misé sur le pressing.',
    sources: ['S23'],
    use: 'Photographie de septembre 2026 pour la Premier League ; magazine généraliste, à confirmer par des chiffres d’éditeurs de données.',
  },
  {
    topic: 'tendances',
    fact: 'Changement de génération des entraîneurs : à l’été 2026, Guardiola quitte Manchester City après six titres (remplacé par Maresca), Liverpool limoge Slot un an après son titre (remplacé par Iraola), Mourinho revient au Real Madrid, Allegri passe à Naples puis Amorim au Milan. Un seul entraîneur actuel de Premier League a déjà gagné le championnat.',
    sources: ['S19', 'S20'],
    use: 'Les profils de club de l’an dernier peuvent ne plus valoir : un nouvel entraîneur remet à zéro une partie des tendances (pressing, formation, corners).',
  },
  {
    topic: 'valeur_actions',
    fact: 'Coach2vec (Serie A, quatre saisons) représente le style de jeu d’un entraîneur par un code issu des séquences de possession de ses équipes et permet de comparer les entraîneurs .',
    sources: ['S35'],
    use: 'Justifie un fichier de style par entraîneur, mis à jour avec ses matchs réels.',
  },
];

export function sourcesBlock(): string {
  const used = new Set(SOURCED_FACTS.flatMap((f) => f.sources));
  const facts = SOURCED_FACTS.map((f) => `- [${f.topic}] ${f.fact} (${f.sources.join(', ')})`).join('\n');
  const refs = SOURCES.filter((s) => used.has(s.id)).map((s) => `${s.id}: ${s.citation}`).join('\n');
  return `## Faits issus de la recherche (avec sources)\n${facts}\n\n## Références\n${refs}`;
}
