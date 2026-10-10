# Stats d'équipes match par match

`collect.py` compile, pour les 5 grands championnats + Ligue des champions (111 équipes),
chaque match officiel de la saison (toutes compétitions, hors amicaux) : stats du match,
de la 1ère MT et de la 2e MT, « pour » et « contre », score, mi-temps, minutes des buts.
Source : FotMob (public, sans clé). Sortie : `data/team-stats/index.json` + `teams/<id>.json`.
Exécuté chaque nuit à 02:00 UTC (`.github/workflows/team-stats.yml`) ; incrémental.
Une stat absente de la source n'est jamais inventée.
