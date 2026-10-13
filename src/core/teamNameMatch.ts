// Normalisation de noms d'équipe pour faire correspondre les mêmes matchs
// entre deux sources qui n'utilisent pas exactement le même libellé
// (ex: football-data.org "Arsenal FC" vs TheOddsAPI/API-Football "Arsenal").
// Best-effort : une équipe qui ne matche pas reste simplement non associée,
// jamais de donnée inventée à sa place.

/**
 * Équipes que les sources nomment très différemment (« Sporting Clube de Portugal » / « Sporting CP », « Slavia Praha » /
 * « Slavia Prague », « Internazionale Milano » / « Inter Milan », « Bayern München » / « Bayern Munich »…) : toutes les
 * variantes d'une ligne sont ramenées à la première. Sans cela, le match n'était pas reconnu d'une source à l'autre
 * (Lens – Sporting resté invisible en direct, donc aucun pari ni combiné).
 */
const ALIAS_GROUPS: string[][] = [
  ['Sporting CP', 'Sporting Clube de Portugal', 'Sporting Lisbon', 'Sporting Lisboa'],
  ['Slavia Prague', 'SK Slavia Praha', 'Slavia Praha'],
  ['Inter Milan', 'FC Internazionale Milano', 'Internazionale', 'Inter'],
  ['AC Milan', 'Milan'],
  ['Bayern Munich', 'FC Bayern München', 'Bayern Munchen', 'Bayern'],
  ['PSV Eindhoven', 'PSV'],
  ['Paris Saint-Germain', 'Paris Saint Germain', 'PSG'],
  ['Manchester City', 'Man City'],
  ['Manchester United', 'Man United', 'Man Utd'],
  ['Tottenham Hotspur', 'Tottenham', 'Spurs'],
  ['Wolverhampton Wanderers', 'Wolves'],
  ['Newcastle United', 'Newcastle'],
  ['Brighton and Hove Albion', 'Brighton & Hove Albion', 'Brighton'],
  ['West Ham United', 'West Ham'],
  ['Leeds United', 'Leeds'],
  ['Coventry City', 'Coventry'],
  ['Atletico Madrid', 'Club Atlético de Madrid', 'Atlético de Madrid', 'Atletico de Madrid'],
  ['Athletic Club', 'Athletic Bilbao'],
  ['Real Sociedad', 'Real Sociedad de Fútbol'],
  ['Olympique de Marseille', 'Marseille', 'Olympique Marseille'],
  ['Olympique Lyonnais', 'Lyon'],
  ['AS Monaco', 'Monaco'],
  ['Racing Club de Lens', 'Lens', 'RC Lens'],
  ['Stade Brestois 29', 'Brest', 'Stade Brestois'],
  ['Bayer 04 Leverkusen', 'Bayer Leverkusen', 'Leverkusen'],
  ['Borussia Mönchengladbach', 'Borussia Monchengladbach', "Gladbach", "M'gladbach"],
  ['Borussia Dortmund', 'Dortmund', 'BVB'],
  ['RB Salzburg', 'Red Bull Salzburg', 'FC Red Bull Salzburg'],
  ['SL Benfica', 'Benfica'],
  ['FC Porto', 'Porto'],
  ['Sporting Braga', 'SC Braga', 'Braga'],
  ['Ajax', 'AFC Ajax'],
  ['Feyenoord', 'Feyenoord Rotterdam'],
  ['Celtic', 'Celtic Glasgow'],
  ['Shakhtar Donetsk', 'Shakhtar'],
  ['Dinamo Zagreb', 'GNK Dinamo Zagreb'],
  ['Red Star Belgrade', 'Crvena Zvezda', 'FK Crvena Zvezda'],
  ['Young Boys', 'BSC Young Boys'],
  ['Union Saint-Gilloise', 'Royale Union Saint-Gilloise', 'Union SG'],
  ['Bodo/Glimt', 'FK Bodø/Glimt', 'Bodo Glimt'],
  ['Qarabag', 'Qarabag FK', 'Qarabağ'],
  ['Olympiacos', 'Olympiakos', 'Olympiacos FC'],
  ['Kairat Almaty', 'FC Kairat', 'Kairat'],
  ['Pafos', 'Pafos FC'],
  ['FC Copenhagen', 'FC København', 'Copenhagen'],
  ['Sturm Graz', 'SK Sturm Graz'],
  ['Club Brugge', 'Club Brugge KV'],
  ['Galatasaray', 'Galatasaray SK'],
  ['Fenerbahce', 'Fenerbahçe', 'Fenerbahce SK'],
  ['Eintracht Frankfurt', 'Frankfurt'],
  ['Girona', 'Girona FC'],
  ['Elche', 'Elche CF'],
  ['Celta Vigo', 'RC Celta de Vigo', 'Celta de Vigo'],
  ['Alaves', 'Deportivo Alavés', 'Deportivo Alaves'],
];

const aliasMap = new Map<string, string>();
let aliasReady = false;

function buildAliases(): void {
  aliasReady = true;
  for (const group of ALIAS_GROUPS) {
    const canonical = baseNormalize(group[0]);
    for (const variant of group) aliasMap.set(baseNormalize(variant), canonical);
  }
}

export function normalizeTeamName(name: string): string {
  if (!aliasReady) buildAliases();
  const base = baseNormalize(name);
  return aliasMap.get(base) ?? base;
}

function baseNormalize(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ac|cd|ud|rc|ssd|calcio|club|ss|as)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Repli quand la correspondance exacte échoue : football-data.org utilise
 * souvent le nom officiel complet (« Olympique de Marseille », « Racing
 * Club de Lens », « Club Atlético de Madrid ») là où TheOddsAPI/les
 * bookmakers utilisent le nom court (« Marseille », « Lens », « Atletico
 * Madrid ») — ce n'est pas un problème d'accent/suffixe que
 * normalizeTeamName peut résoudre, la Premier League y échappe car les noms
 * anglais coïncident déjà (« Arsenal FC » -> « Arsenal » des deux côtés).
 * Comparaison par ENSEMBLE DE MOTS plutôt qu'inclusion de chaîne brute : un
 * mot inséré au milieu (« de », « club ») casserait une simple inclusion de
 * sous-chaîne. Accepte une correspondance si tous les mots du nom le plus
 * court apparaissent dans l'autre, jamais l'inverse — un nom à un seul mot
 * trop court (« as », « fc ») est ignoré pour éviter les faux positifs.
 * Best-effort : certains cas (nom de ville traduit, ex. « München » vs
 * « Munich », ou suffixe différent, ex. « Rennais » vs « Rennes ») restent
 * volontairement non couverts plutôt que de risquer un mauvais rapprochement.
 */
export function namesLikelyMatch(normalizedA: string, normalizedB: string): boolean {
  if (normalizedA === normalizedB) return true;
  if (normalizedA.length < 4 || normalizedB.length < 4) return false;

  // 1) Inclusion de sous-chaîne : couvre les cas où le nom court est un
  // PRÉFIXE du mot long (« Lyon » dans « Lyonnais »).
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;

  // 2) Ensemble de mots : couvre les cas où un mot est INSÉRÉ au milieu
  // (« Atletico Madrid » vs « Atletico DE Madrid »), que la simple
  // inclusion de sous-chaîne ne peut pas voir.
  const tokensA = normalizedA.split(' ').filter((t) => t.length > 0);
  const tokensB = normalizedB.split(' ').filter((t) => t.length > 0);
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  if (shorter.length === 0) return false;
  if (shorter.length === 1 && shorter[0].length < 4) return false; // mot unique trop générique

  const longerSet = new Set(longer);
  return shorter.every((token) => longerSet.has(token));
}
