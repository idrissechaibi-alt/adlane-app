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
  ['Paris FC'],
  ['Inter Miami', 'Inter Miami CF'],
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
/** Alias appris à l'usage (deux noms vus sur le même match) : fournis par teamAliasStore, jamais saisis à la main. */
let learned = new Map<string, string>();
export function setLearnedAliases(map: Map<string, string>): void {
  learned = map;
}

let canonSet: Set<string> | null = null;
function canonicals(): Set<string> {
  return (canonSet ??= new Set(aliasMap.values()));
}

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
  const fixed = aliasMap.get(base) ?? base;
  return learned.get(fixed) ?? fixed;
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
  // Deux équipes DISTINCTES de la liste (AC Milan / Inter Milan, Paris FC / Paris Saint-Germain) ne se confondent jamais.
  if (!aliasReady) buildAliases();
  if (canonicals().has(normalizedA) && canonicals().has(normalizedB)) return false;
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
  if (shorter.every((token) => longerSet.has(token))) return true;

  // 3) Graphies différentes d'une même ville (München/Munich, Praha/Prague…), sigles de statut (SK, FK, KV…) et
  // proximité d'écriture : on compare les mots « utiles » après synonymes, puis une distance d'édition.
  const core = (tokens: string[]) => tokens.map((t) => SYNONYMS[t] ?? t).filter((t) => t.length > 1 && !STATUS_TOKENS.has(t));
  const ca = core(tokensA);
  const cb = core(tokensB);
  if (ca.length > 0 && cb.length > 0) {
    const [sh, lo] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
    const loSet = new Set(lo);
    if (sh.every((t) => loSet.has(t) || lo.some((l) => l.length >= 5 && t.length >= 5 && (l.startsWith(t) || t.startsWith(l))))) return true;
    const ja = ca.join(' ');
    const jb = cb.join(' ');
    if (ja.length >= 6 && jb.length >= 6 && similarity(ja, jb) >= 0.84) return true;
  }
  return false;
}

/** Mots qui ne distinguent pas deux clubs (statut juridique, sigles). */
const STATUS_TOKENS = new Set(['sk', 'fk', 'kv', 'sv', 'tsv', 'vfb', 'vfl', 'fsv', 'bsc', 'gnk', 'nk', 'afc', 'rsc', 'de', 'la', 'le', 'du', 'of', 'the', 'and']);

/** Graphies de villes selon la langue de la source. */
const SYNONYMS: Record<string, string> = {
  munchen: 'munich', praha: 'prague', wien: 'vienna', koln: 'cologne', koeln: 'cologne', torino: 'turin', milano: 'milan',
  lisboa: 'lisbon', genova: 'genoa', firenze: 'florence', napoli: 'naples', zurich: 'zurich', kobenhavn: 'copenhagen',
  beograd: 'belgrade', moskva: 'moscow', bucuresti: 'bucharest', warszawa: 'warsaw', athina: 'athens', kyiv: 'kiev',
  internazionale: 'inter', hotspur: 'tottenham', wanderers: 'wolves', monchengladbach: 'gladbach',
};

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}
