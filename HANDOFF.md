# Handoff — Pipeline fictif bloqué (à reprendre)

Dernière mise à jour : 2026-09-27, session Claude Sonnet 5
(`https://claude.ai/code/session_015cuuVCbzUHMmjRrVMJiJQr`).

Ce fichier résume où en est le diagnostic du "pipe fictif" pour reprendre
dans un autre terminal sans repartir de zéro. Il documente ce qui a été
**vérifié empiriquement** (pas des suppositions) et ce qui reste ouvert.

## Le symptôme de départ

L'utilisateur constate que l'app "ne fait toujours rien" : très peu ou pas de
prédictions générées, malgré des matchs réellement en direct (trêve
internationale : Ligue des Nations Afrique / CAN). Deux pipelines sont
concernés :

- **Paris RÉELS** : 5 grands championnats + compétitions internationales
  pendant la trêve (`src/core/inPlayCombos.ts`, `processRealSlot`).
- **Paris FICTIFS** ("pipe fictif") : tout l'univers de matchs suivi, gratuit
  uniquement, sert à affûter le modèle (`src/core/fictionalProgram.ts` pour
  la découverte du calendrier, `inPlayCombos.ts` pour le suivi).

## Demande explicite de l'utilisateur (point de départ de cette session)

> "Ok abandonne la piste OMNIROUTE laisse la en dernier recours débrouille
> toi pour faire les scan et prédictions in app directement en mangeant les
> api pour en laisser pour les paris réelles mais résous le problème du
> Pipeline fictif"

Traduction en tâches :
1. Démoter Omniroute (serveur auto-hébergé, sujet à des pannes "circuit
   breaker") en dernier recours plutôt que mécanisme principal.
2. Utiliser les vraies API (Sportmonks notamment, quasi inutilisée : 3000
   req/jour, 0 consommées) comme source primaire.
3. Protéger le budget du pipeline réel pendant qu'on consomme plus les API
   ailleurs.
4. Priorité explicite : **résoudre le pipe fictif**.

## Ce qui a été fait (dans l'ordre, avec les commits)

### 1. `fb03d30` — Sportmonks comme découverte primaire du pipe fictif
Le blocage historique du pipe fictif : `ensureFictionalDailyProgram`
(`src/core/fictionalProgram.ts`) balayait 60 pays un par un via des agents
Omniroute (LLM), qui tombaient en permanence sur "agents de recherche coupés
(circuit breaker)".

Ajout de `fetchSportmonksFixturesByDate` (`src/api/footballDataAPIs/
sportmonks.ts`, endpoint `/fixtures/date/{date}`, pagination par curseur) —
calendrier mondial d'une date en un flux structuré, sans LLM. Devient la
source **primaire** ; Omniroute ne comble plus que les pays que Sportmonks
n'a pas couverts (vrai dernier recours).

Budget protégé via `spendBudget('sportmonks')` existant
(`src/core/requestBudget.ts`, réserve 70% du quota à l'auto-apprentissage,
30% pour l'usage direct/pipeline réel).

`ensureFictionalDailyProgram` accepte maintenant `OmnirouteConfig | null` :
le pipe fictif ne dépend plus du tout d'Omniroute pour fonctionner.

### 2. `f80f987` — Diagnostic plus honnête (clé absente vs échec)
Le message "Sportmonks : non configuré ou injoignable" recouvrait deux cas
très différents. Ajout de champs d'erreur précis (`fictionalSportmonksError`,
`sportmonksError`) remontés jusqu'au bouton "Forcer le scan"
(`src/screens/EvolutionScreen.tsx`).

### 3. `01baa00` — Faux positif corrigé : "0 résultat" ≠ erreur
**Bug réel trouvé** : Sportmonks renvoie parfois HTTP 200 avec
`{"message": "No result(s) found matching your request. Either the query
did not return any results or you don't have access to it via your current
subscription."}` même quand la requête est simplement vide (aucun match à
cet instant). Le code traitait CE message comme une erreur fatale à chaque
fois. Corrigé : seule l'ABSENCE du tableau `data` signale une vraie erreur ;
un tableau vide est un résultat normal.

### 4. `733273c` — Bouton "Tester" dédié pour Sportmonks
`testSportmonksConnection` (`src/api/footballDataAPIs/sportmonks.ts`) appelle
les deux endpoints réellement utilisés (`/livescores` et `/fixtures/date`) et
rapporte les VRAIS chiffres, pas juste OK/échec. Bouton branché dans
`src/screens/APIManagementScreen.tsx`.

**Résultat du test (confirmé par l'utilisateur, capture d'écran) :**
```
✅ Connexion OK
Livescores : 0 match(s) en direct au total, dont 0 en 1ère/2e mi-temps ou à la pause.
Calendrier du jour : 0 match(s) au total ce jour (toutes compétitions couvertes par le plan).
```
→ **La clé Sportmonks fonctionne** (HTTP 200, pas d'erreur). Mais le compte
renvoie **zéro fixture pour toute la planète, toute la journée**, alors que
l'utilisateur confirme qu'il y a "des dizaines de matchs nationaux" en
direct au même moment (trêve internationale).

### 5. `8642752` — Même traitement pour API-Football (relevé live)
En vérifiant la carte "Gestion des API", l'utilisateur a montré qu'API-
Football fonctionne bien (bouton Tester → "Connexion OK", quota 63-72/100
consommé, donc actif) — **pourtant** tous les diagnostics de scan montrent
`Relevé live : source Omniroute`, jamais `api_football`.

Cause probable identifiée (pas encore confirmée par un message d'erreur
réel) : `fetchLiveFixtures` (`src/core/halftimeMonitor.ts`) appelle
`/fixtures?live=all`, un endpoint DIFFÉRENT de celui testé par le bouton
Tester (`/status`) et différent de celui de l'univers du jour
(`/fixtures?date=`). Beaucoup de plans API-Football restreignent `live=all`
aux offres payantes même quand `/status` et `/fixtures?date` répondent
normalement. L'erreur réelle de `data.errors` était déjà détectée dans le
code mais avalée par un simple `console.warn`, invisible depuis l'app.

Correctif : le message d'erreur exact remonte maintenant dans le diagnostic
("API-Football (relevé live) : ...") via `AutoLearnTickDiagnostics.
apiFootballError` (`src/core/backgroundTasks.ts`) et s'affiche dans le
message "Forcer le scan" (`src/screens/EvolutionScreen.tsx`).

**⚠️ Pas encore vérifié** : il faut relancer "Forcer le scan" après mise à
jour OTA et lire ce que dit cette nouvelle ligne — c'est le prochain point à
lire en priorité en reprenant.

## État actuel — ce qui marche, ce qui ne marche pas

| Source | Clé/config | Connexion | Données réelles renvoyées |
|---|---|---|---|
| API-Football | ✅ présente | ✅ OK (`/status`) | ❌ 0 côté relevé live (`/fixtures?live=all`) — cause probable : endpoint hors plan, **à confirmer** avec le nouveau message d'erreur |
| Sportmonks | ✅ présente | ✅ OK (les deux endpoints testés) | ❌ 0 partout (`/livescores` ET `/fixtures/date`) alors que des matchs sont en direct — **cause probable : plan Sportmonks sans compétition sélectionnée/couverte**, à vérifier sur my.sportmonks.com |
| Omniroute | ✅ configuré | Intermittent | "agents de recherche coupés (circuit breaker)" récurrent — d'où la démotion en dernier recours |
| SofaScore | Pas de clé nécessaire | Bloqué | 403 Cloudflare depuis IP cloud/datacenter (vérifié multi-outils) — pourrait fonctionner depuis le réseau mobile du téléphone (pas encore confirmé) |

**Conclusion actuelle : les DEUX vraies API (API-Football et Sportmonks) ont
des clés valides et fonctionnelles, mais renvoient 0 résultat sur les
endpoints qui comptent** (relevé live / calendrier), pour des raisons
probablement liées aux PLANS souscrits (endpoints ou compétitions hors
couverture), pas à des bugs de connexion. Omniroute reste donc, de fait, la
seule source qui tourne — d'où "l'app ne fait toujours rien" malgré tout le
travail fait sur le code.

## Prochaines étapes (dans l'ordre)

1. **Relancer "Forcer le scan"** (Analyses → Calibration) après mise à jour
   OTA, lire la ligne `API-Football (relevé live) : ...` dans le message.
   Si elle dit un truc comme "This endpoint is not available on your
   subscription plan" → confirmé, c'est un problème de plan API-Football, pas
   de code.
2. **Vérifier le compte Sportmonks sur my.sportmonks.com** (pas dans l'app) :
   section "My Subscription" / "My Leagues" — voir si des compétitions sont
   réellement sélectionnées/actives sur le plan. Si aucune, c'est la cause du
   "0 partout" malgré une clé valide.
3. Si les deux plans sont bien limités : soit upgrader/reconfigurer les plans
   côté fournisseur (hors code), soit accepter qu'Omniroute reste le seul
   mécanisme fonctionnel actuellement et se concentrer sur la fiabilité
   d'Omniroute (le "circuit breaker" récurrent, jamais définitivement réglé
   malgré plusieurs tentatives dans les sessions précédentes).
4. Non commencé : remplacer l'estimation des buts attendus (xG) par Omniroute
   pour les matchs fictifs/internationaux par une méthode data-driven
   (stats d'équipes via Sportmonks) — mis de côté cette session car plus
   risqué et moins urgent que le blocage de découverte ci-dessus. Voir le
   commentaire en tête de `src/core/inPlayCombos.ts`.

## Repères utiles dans le code

- `src/core/fictionalProgram.ts` — programme du jour du pipe fictif (feed
  transmis → Sportmonks → Omniroute en dernier recours).
- `src/api/footballDataAPIs/sportmonks.ts` — client Sportmonks (livescores,
  fixtures/date, test de connexion).
- `src/core/halftimeMonitor.ts` — `fetchLiveFixtures` (API-Football
  `/fixtures?live=all`, le point suspect actuel).
- `src/core/backgroundTasks.ts` — orchestration du tick complet
  (`runAutoLearnTick`), diagnostic `AutoLearnTickDiagnostics`.
- `src/screens/EvolutionScreen.tsx` — bouton "Forcer le scan", texte du
  diagnostic (`formatScanDiagnostics`).
- `src/screens/APIManagementScreen.tsx` — Gestion des API, boutons "Tester".
- `src/core/requestBudget.ts` — répartition 70% auto-apprentissage / 30%
  usage direct par source, à respecter pour toute nouvelle intégration API.

## Discipline de travail établie (à respecter en reprenant)

- Toujours `git fetch origin main` puis fusionner les "Sauvegarde
  planifiée"/"Sauvegarde au démarrage" (auto-sync du téléphone) AVANT de
  committer — ce sont des snapshots de données, jamais de conflit de code
  attendu, `git merge --ff-only` suffit presque toujours.
- `npx tsc --noEmit -p .` + `npx jest` avant ET après avoir fusionné, avant
  chaque commit.
- Ne jamais deviner un champ d'API non documenté avec certitude ("n'invente
  rien") — préférer instrumenter/diagnostiquer plutôt que repatcher à
  l'aveugle (c'est cette discipline qui a permis de trouver le vrai bug
  "0 résultat ≠ erreur" au lieu de re-deviner indéfiniment).
- Push direct sur `main` (déclenche l'OTA que l'utilisateur teste) — c'est le
  fonctionnement établi, pas une PR.
