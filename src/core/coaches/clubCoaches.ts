// Fichier entraîneur par club (cinq grands championnats, saison 2026-27), état au 25/10/2026.
// Source des noms et dates : pages Wikipédia de chaque saison (S19), lecture automatique. Les notes tactiques ne sont renseignées
// que lorsqu'une source les donne (voir sources.ts) ; une note vide signifie « pas encore étudié », jamais « pas de style ».

export interface ClubCoachFile {
  league: 'Premier League' | 'La Liga' | 'Bundesliga' | 'Serie A' | 'Ligue 1';
  club: string;
  coach: string;
  /** Date d'arrivée si elle est postérieure au début de l'été 2026 (sinon absente : en poste avant). */
  since?: string;
  /** Prédécesseur direct, quand le changement date de 2026. */
  replaced?: string;
  /** Faits tactiques sourcés (français). */
  notes: string;
  sources: string[];
}

export const CLUB_COACHES: ClubCoachFile[] = [
  {
    "league": "Premier League",
    "club": "Arsenal",
    "coach": "Mikel Arteta",
    "notes": "Champion en titre 2025-26 ; défense la plus solide de la ligue depuis 2023 (écart d’environ 37 xG avec le 2e sur trois saisons) ; corners répétitifs et physiques, majoritairement en inswing ; triangle du troisième homme.",
    "sources": [
      "S20",
      "S21",
      "S21"
    ]
  },
  {
    "league": "Premier League",
    "club": "Aston Villa",
    "coach": "Unai Emery",
    "notes": "Sans but sur les trois premières journées 2026-27 (selon un billet de septembre) ; écart de +4,4 xG contre +29 de différence de buts réelle sur trois saisons.",
    "sources": [
      "S20",
      "S23"
    ]
  },
  {
    "league": "Premier League",
    "club": "Bournemouth",
    "coach": "Marco Rose",
    "since": "2026-06-01",
    "replaced": "Andoni Iraola",
    "notes": "Jeu vertical : vitesse directe moyenne de 1,48 m/s, 89,9 possessions par match, 25 tirs sur récupération la saison passée (style hérité d’Iraola, à confirmer sous Rose).",
    "sources": [
      "S19",
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Brentford",
    "coach": "Keith Andrews",
    "notes": "Équipe n°1 des coups de pied arrêtés et des touches longues ; xG par tir le plus haut de la ligue (0,20 contre 0,16 en moyenne) ; club mené par l’analyse de données.",
    "sources": [
      "S20",
      "S23"
    ]
  },
  {
    "league": "Premier League",
    "club": "Brighton & Hove Albion",
    "coach": "Fabian Hürzeler",
    "notes": "Pressing et progression de balle ; 12,4 récupérations hautes par match, 23 buts sur ces récupérations.",
    "sources": [
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Chelsea",
    "coach": "Xabi Alonso",
    "since": "2026-07-01",
    "replaced": "Calum McFarlane (intérim)",
    "notes": "Quatrième entraîneur en moins d’un an ; effectif jeune censé presser et courir ; aucune compétition européenne cette saison.",
    "sources": [
      "S19",
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Coventry City",
    "coach": "Frank Lampard",
    "notes": "Promu ; possession contrôlée, mais aussi centres et duels aériens (trois joueurs avec au moins trois buts de la tête la saison passée) ; verticalité à prouver.",
    "sources": [
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Crystal Palace",
    "coach": "Pierre Sage",
    "since": "2026-06-15",
    "replaced": "Oliver Glasner",
    "notes": "Pas de profil tactique relevé.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Premier League",
    "club": "Everton",
    "coach": "David Moyes",
    "notes": "Pas de profil tactique relevé.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Premier League",
    "club": "Fulham",
    "coach": "Álvaro Arbeloa",
    "since": "2026-07-07",
    "replaced": "Marco Silva",
    "notes": "Effectif le plus âgé de la ligue (28,1 ans en moyenne pondérée par les minutes).",
    "sources": [
      "S19",
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Hull City",
    "coach": "Sergej Jakirović",
    "notes": "Promu ; cité pour un bloc bas qui « remonte » (tendance 5 du billet de septembre).",
    "sources": [
      "S23"
    ]
  },
  {
    "league": "Premier League",
    "club": "Ipswich Town",
    "coach": "Gary O’Neil",
    "since": "2026-06-23",
    "replaced": "Kieran McKenna",
    "notes": "Promu.",
    "sources": [
      "S19",
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Leeds United",
    "coach": "Daniel Farke",
    "notes": "Jeu direct (parmi les cinq premiers pour la distance moyenne de passe et la part de passes vers l’avant) et pressing sélectif ; recherche des attaques rapides.",
    "sources": [
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Liverpool",
    "coach": "Andoni Iraola",
    "since": "2026-06-04",
    "replaced": "Arne Slot",
    "notes": "Pressing (PPDA), arrivé après le limogeage de Slot, champion un an plus tôt.",
    "sources": [
      "S19",
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Manchester City",
    "coach": "Enzo Maresca",
    "since": "2026-06-29",
    "replaced": "Pep Guardiola",
    "notes": "Défense à quatre avec gardien jouant en défenseur central supplémentaire, latéraux rentrants, losange au milieu ; supériorités numériques et rotations ; canal central parfois surpeuplé. Billet publié en mai, à confirmer sur les matchs.",
    "sources": [
      "S19",
      "S24"
    ]
  },
  {
    "league": "Premier League",
    "club": "Manchester United",
    "coach": "Michael Carrick",
    "notes": "Entraîneur à 19 matchs de Premier League ; Bruno Fernandes a signé 13 de ses 21 passes décisives record en 17 matchs sous Carrick.",
    "sources": [
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Newcastle United",
    "coach": "Matthias Jaissle",
    "since": "2026-08-05",
    "replaced": "Eddie Howe",
    "notes": "Plusieurs de ses meilleurs joueurs sont partis cet été.",
    "sources": [
      "S19",
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Nottingham Forest",
    "coach": "Oliver Glasner",
    "since": "2026-07-06",
    "replaced": "Vítor Pereira",
    "notes": "Pas de profil tactique relevé.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Premier League",
    "club": "Sunderland",
    "coach": "Régis Le Bris",
    "notes": "Promu maintenu grâce à la verticalité : jeu long pour sortir des zones dangereuses.",
    "sources": [
      "S20"
    ]
  },
  {
    "league": "Premier League",
    "club": "Tottenham Hotspur",
    "coach": "Roberto De Zerbi",
    "notes": "17e du championnat deux saisons de suite ; sans but sur les trois premières journées 2026-27 d’après un billet de septembre.",
    "sources": [
      "S20",
      "S23"
    ]
  },
  {
    "league": "La Liga",
    "club": "Deportivo Alavés",
    "coach": "Quique Sánchez Flores",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Athletic Club",
    "coach": "Edin Terzić",
    "since": "2026-07-01",
    "replaced": "Ernesto Valverde",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Atlético Madrid",
    "coach": "Diego Simeone",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "FC Barcelone",
    "coach": "Hansi Flick",
    "notes": "Deux titres de suite avant 2026-27.",
    "sources": [
      "S19",
      "S25"
    ]
  },
  {
    "league": "La Liga",
    "club": "Celta Vigo",
    "coach": "Claudio Giráldez",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Deportivo La Corogne",
    "coach": "Antonio Hidalgo",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Elche",
    "coach": "Martín Anselmi",
    "since": "2026-06-13",
    "replaced": "Eder Sarabia",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Espanyol",
    "coach": "Manolo González",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Getafe",
    "coach": "José Bordalás",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Levante",
    "coach": "Luís Castro",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Málaga",
    "coach": "Juan Francisco Funes",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Osasuna",
    "coach": "Jagoba Arrasate",
    "since": "2026-10-12",
    "replaced": "Luis Miguel Ramis",
    "notes": "Changement le plus récent de la ligue ; Ramis avait remplacé Alessio Lisci en juin.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Racing Santander",
    "coach": "José Alberto López",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Rayo Vallecano",
    "coach": "Beñat San José",
    "since": "2026-06-18",
    "replaced": "Iñigo Pérez",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Real Betis",
    "coach": "Manuel Pellegrini",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Real Sociedad",
    "coach": "Pellegrino Matarazzo",
    "notes": "A encaissé 4-1 contre le Real Madrid de Mourinho.",
    "sources": [
      "S19",
      "S26"
    ]
  },
  {
    "league": "La Liga",
    "club": "Real Madrid",
    "coach": "José Mourinho",
    "since": "2026-06-13",
    "replaced": "Álvaro Arbeloa",
    "notes": "Reconstruction profonde ; construction large, pressing agressif, attaques verticales (billet d’août sur le 4-1 contre la Real Sociedad).",
    "sources": [
      "S19",
      "S26"
    ]
  },
  {
    "league": "La Liga",
    "club": "Séville FC",
    "coach": "Luis García",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Valence CF",
    "coach": "Javier Aguirre",
    "since": "2026-09-23",
    "replaced": "Óscar Sánchez (intérim, après Carlos Corberán)",
    "notes": "Troisième entraîneur de la saison en deux semaines.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "La Liga",
    "club": "Villarreal",
    "coach": "Iñigo Pérez",
    "since": "2026-06-01",
    "replaced": "Marcelino",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "FC Augsburg",
    "coach": "Manuel Baum",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Union Berlin",
    "coach": "Mauro Lustrinelli",
    "since": "2026-05-21",
    "replaced": "Marie-Louise Eta (intérim)",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Werder Brême",
    "coach": "Daniel Thioune",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Borussia Dortmund",
    "coach": "Niko Kovač",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "SV Elversberg",
    "coach": "Vincent Wagner",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Eintracht Francfort",
    "coach": "Adi Hütter",
    "since": "2026-05-31",
    "replaced": "Albert Riera",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "SC Fribourg",
    "coach": "Julian Schuster",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Hambourg SV",
    "coach": "Merlin Polzin",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "TSG Hoffenheim",
    "coach": "Christian Ilzer",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "1. FC Cologne",
    "coach": "René Wagner",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "RB Leipzig",
    "coach": "Martín Demichelis",
    "since": "2026-06-22",
    "replaced": "Ole Werner",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Bayer Leverkusen",
    "coach": "Carles Martínez Novell",
    "since": "2026-06-04",
    "replaced": "Kasper Hjulmand",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Mayence 05",
    "coach": "Urs Fischer",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Borussia Mönchengladbach",
    "coach": "Alexander Blessin",
    "since": "2026-09-22",
    "replaced": "Jan-Moritz Lichte (intérim, après Eugen Polanski)",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Bayern Munich",
    "coach": "Vincent Kompany",
    "notes": "Double tenant du titre (34e titre).",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "SC Paderborn",
    "coach": "Ralf Kettemann",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "Schalke 04",
    "coach": "Miron Muslić",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Bundesliga",
    "club": "VfB Stuttgart",
    "coach": "Sebastian Hoeneß",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Atalanta",
    "coach": "Maurizio Sarri",
    "since": "2026-06-15",
    "replaced": "Raffaele Palladino",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Bologne",
    "coach": "Raffaele Palladino",
    "since": "2026-09-16",
    "replaced": "Domenico Tedesco (après Vincenzo Italiano)",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Cagliari",
    "coach": "Fabio Pisacane",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Côme",
    "coach": "Cesc Fàbregas",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Fiorentina",
    "coach": "Paolo Vanoli",
    "since": "2026-09-07",
    "replaced": "Fabio Grosso",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Frosinone",
    "coach": "Massimiliano Alvini",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Genoa",
    "coach": "Daniele De Rossi",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Inter Milan",
    "coach": "Cristian Chivu",
    "notes": "Champion en titre (21e scudetto).",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Juventus",
    "coach": "Luciano Spalletti",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Lazio",
    "coach": "Gennaro Gattuso",
    "since": "2026-06-23",
    "replaced": "Maurizio Sarri",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Lecce",
    "coach": "Eusebio Di Francesco",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "AC Milan",
    "coach": "Rúben Amorim",
    "since": "2026-06-16",
    "replaced": "Massimiliano Allegri",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Monza",
    "coach": "Ivan Jurić",
    "since": "2026-06-29",
    "replaced": "Paolo Bianco",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Naples",
    "coach": "Massimiliano Allegri",
    "since": "2026-07-03",
    "replaced": "Antonio Conte",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Parme",
    "coach": "Alberto Gilardino",
    "since": "2026-09-29",
    "replaced": "Carlos Cuesta",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "AS Rome",
    "coach": "Gian Piero Gasperini",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Sassuolo",
    "coach": "Alberto Aquilani",
    "since": "2026-06-12",
    "replaced": "Fabio Grosso",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Torino",
    "coach": "Ignazio Abate",
    "since": "2026-06-12",
    "replaced": "Roberto D’Aversa",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Udinese",
    "coach": "Kosta Runjaić",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Serie A",
    "club": "Venise",
    "coach": "Davide Nicola",
    "since": "2026-10-14",
    "replaced": "Giovanni Stroppa",
    "notes": "Promu ; changement le plus récent de la ligue.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Angers",
    "coach": "Stéphane Gilli",
    "since": "2026-06-09",
    "replaced": "Alexandre Dujeux",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Auxerre",
    "coach": "Will Still",
    "since": "2026-06-12",
    "replaced": "Christophe Pélissier",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Brest",
    "coach": "Julien Lachuer",
    "since": "2026-06-27",
    "replaced": "Éric Roy",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Le Havre",
    "coach": "Didier Digard",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Le Mans",
    "coach": "Patrick Videira",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Lens",
    "coach": "Yannick Cahuzac",
    "since": "2026-09-15",
    "replaced": "Dino Toppmöller (arrivé en juin après Pierre Sage)",
    "notes": "Deuxième de Ligue 1 la saison passée.",
    "sources": [
      "S19",
      "S20"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Lille",
    "coach": "Davide Ancelotti",
    "since": "2026-06-01",
    "replaced": "Bruno Génésio",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Lyon",
    "coach": "Paulo Fonseca",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Lorient",
    "coach": "Alexandre Dujeux",
    "since": "2026-06-09",
    "replaced": "Olivier Pantaloni",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Marseille",
    "coach": "Bruno Génésio",
    "since": "2026-07-01",
    "replaced": "Habib Beye",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Monaco",
    "coach": "Filipe Luís",
    "since": "2026-07-06",
    "replaced": "Sébastien Pocognoli",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Nice",
    "coach": "Olivier Pantaloni",
    "since": "2026-06-17",
    "replaced": "Claude Puel",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Paris FC",
    "coach": "Liam Rosenior",
    "since": "2026-07-07",
    "replaced": "Antoine Kombouaré",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Paris Saint-Germain",
    "coach": "Luis Enrique",
    "notes": "Cinq fois champion de suite avant 2026-27.",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Rennes",
    "coach": "Franck Haise",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Strasbourg",
    "coach": "Hugo Oliveira",
    "since": "2026-07-12",
    "replaced": "Gary O’Neil",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Toulouse",
    "coach": "Jens Berthel Askou",
    "since": "2026-05-21",
    "replaced": "Carles Martínez Novell",
    "notes": "",
    "sources": [
      "S19"
    ]
  },
  {
    "league": "Ligue 1",
    "club": "Troyes",
    "coach": "Stéphane Dumont",
    "notes": "Promu.",
    "sources": [
      "S19"
    ]
  }
]

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Fiche de l'entraîneur d'un club d'après le nom d'équipe (comparaison souple : « Man City », « Manchester City »…). */
export function clubCoachOf(team: string | undefined | null): ClubCoachFile | null {
  if (!team) return null;
  const t = strip(team);
  const ALIASES: Record<string, string> = { 'man city': 'manchester city', 'man utd': 'manchester united', 'man united': 'manchester united', spurs: 'tottenham hotspur', tottenham: 'tottenham hotspur', newcastle: 'newcastle united', 'nott m forest': 'nottingham forest', brighton: 'brighton hove albion', wolves: 'wolverhampton', 'atletico madrid': 'atletico madrid', barcelona: 'fc barcelone', barca: 'fc barcelone', 'real madrid': 'real madrid', 'bayern': 'bayern munich', 'bayern munchen': 'bayern munich', 'borussia dortmund': 'borussia dortmund', dortmund: 'borussia dortmund', leverkusen: 'bayer leverkusen', 'rb leipzig': 'rb leipzig', inter: 'inter milan', internazionale: 'inter milan', milan: 'ac milan', roma: 'as rome', napoli: 'naples', 'paris sg': 'paris saint germain', psg: 'paris saint germain', marseille: 'marseille', lyon: 'lyon' };
  const wanted = ALIASES[t] ?? t;
  return (
    CLUB_COACHES.find((c) => strip(c.club) === wanted) ??
    CLUB_COACHES.find((c) => strip(c.club).includes(wanted) || wanted.includes(strip(c.club))) ??
    null
  );
}

