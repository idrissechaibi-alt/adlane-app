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
];

export interface SourcedFact {
  topic: 'timing' | 'transitions' | 'cartons_rouges' | 'arbitrage' | 'remplacements' | 'coups_arretes' | 'valeur_actions' | 'momentum';
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
];

export function sourcesBlock(): string {
  const used = new Set(SOURCED_FACTS.flatMap((f) => f.sources));
  const facts = SOURCED_FACTS.map((f) => `- [${f.topic}] ${f.fact} (${f.sources.join(', ')})`).join('\n');
  const refs = SOURCES.filter((s) => used.has(s.id)).map((s) => `${s.id}: ${s.citation}`).join('\n');
  return `## Faits issus de la recherche (avec sources)\n${facts}\n\n## Références\n${refs}`;
}
