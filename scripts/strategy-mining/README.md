# Recherche de stratégies de mi-temps

1. `python3 fetch_fotmob_halftime.py 21 rows.json` — matchs terminés des 21 derniers jours (FotMob) avec stats de 1ère mi-temps et résultat final.
2. `python3 mine_halftime_rules.py` — pour chaque marché (buts, corners, cartons, fautes en 2e MT), cherche les combinaisons de 1 ou 2 marqueurs de 1ère MT qui battent le taux de base d'au moins 8 points, sur au moins 50 matchs, trouvées sur les 2/3 les plus anciens et vérifiées sur le tiers le plus récent. Résultat : `rules_live.json`.
3. Les règles retenues sont recopiées dans `src/core/strategies.ts` (DATA_RULES).
