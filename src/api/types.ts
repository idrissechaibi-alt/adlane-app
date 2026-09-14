// Types communs pour tous les API Football
// Conforme aux standards de l'application adlane

// ==================== FIXTURES & MATCH ====================

export interface FootballMatch {
  id: string;
  leagueId: string;
  leagueName: string;
  leagueCountry?: string;
  leagueLogo?: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId?: string;
  awayTeamId?: string;
  homeTeamLogo?: string;
  awayTeamLogo?: string;
  kickoff_utc: string;        // ISO 8601
  kickoff_local?: string;     // UTC+1 (Algérie)
  status: 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';
  scoreFulltime?: {
    home: number;
    away: number;
  };
  scoreHalftime?: {
    home: number;
    away: number;
  };
  venue?: string;
  timezone?: string;
  round?: string;
  season?: number;
}

export interface MatchStatistics {
  matchId: string;
  homeTeam: {
    shotsTotal?: number;
    shotsOnTarget?: number;
    shotsOffTarget?: number;
    shotsBlocked?: number;
    possession?: number;
    corners?: number;
    fouls?: number;
    yellowCards?: number;
    redCards?: number;
    passesTotal?: number;
    passesAccuracy?: number;
    tackles?: number;
    interceptions?: number;
    clearances?: number;
    offside?: number;
  };
  awayTeam: {
    shotsTotal?: number;
    shotsOnTarget?: number;
    shotsOffTarget?: number;
    shotsBlocked?: number;
    possession?: number;
    corners?: number;
    fouls?: number;
    yellowCards?: number;
    redCards?: number;
    passesTotal?: number;
    passesAccuracy?: number;
    tackles?: number;
    interceptions?: number;
    clearances?: number;
    offside?: number;
  };
  meta: {
    source: string;
    timestamp: string;
  };
}

// ==================== ODDS ====================

export interface MarketOdds {
  market: '1X2' | 'BTTS' | 'OU_2_5' | 'corners' | 'fouls' | 'cards' | 'shots';
  odds: {
    home?: number;
    draw?: number;
    away?: number;
    yes?: number;
    no?: number;
    over?: number;
    under?: number;
    total?: number; // pour OU (ex: 2.5)
  };
  timestamp: string;
  source: string;
}

export interface AllMatchOdds {
  matchId: string;
  match: FootballMatch;
  markets: MarketOdds[];
  rawOdds?: any; // données brutes pour debug
}

// ==================== TEAMS ====================

export interface Team {
  id: string;
  name: string;
  shortCode?: string;
  logo?: string;
  leagueId?: string;
  stats: {
    played?: number;
    won?: number;
    draw?: number;
    lost?: number;
    goalsFor?: number;
    goalsAgainst?: number;
    points?: number;
    xgFor?: number;       // expected goals
    xgAgainst?: number;
    form?: string[];      // ['W', 'D', 'L', 'W', 'W']
  };
  lastMatches?: MatchResult[];
  nextMatches?: FootballMatch[];
}

export interface MatchResult {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  date: string;
  league: string;
}

// ==================== PLAYERS ====================

export interface Player {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  position?: string;
  age?: number;
  stats: {
    matchesPlayed?: number;
    goals?: number;
    assists?: number;
    xg?: number;
    minutesPlayed?: number;
    yellowCards?: number;
    redCards?: number;
    shotsOnTarget?: number;
  };
  form?: string[];        // ['G', 'A', '0', 'G', '0']
}

// ==================== API RESPONSE ====================

export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  rateLimit?: {
    remaining: number;
    reset: string; // ISO 8601
    limit: number;
  };
  cacheHit?: boolean;
  source: string;
  timestamp: string;
}

// ==================== LEAGUE INFO ====================

export interface LeagueInfo {
  id: string;
  name: string;
  country: string;
  flag?: string;
  isTopTier: boolean;
  hasStats: boolean;
  hasOdds: boolean;
}

// ==================== CONFIG ====================

export interface APIConfig {
  ballDontLie?: string;   // x-rapidapi-key
  sofaScore?: string;     // cookie ou token
  footballData?: string;  // X-Auth-Token
  theOddsAPI?: string;
  sportmonks?: string;

  // Paramètres
  enableFallback: boolean;
  cacheEnabled: boolean;
  cacheTTL: number;       // en secondes
  maxRetries: number;
  retryDelay: number;     // en ms
}

// ==================== FAVORITES & SUBSCRIPTIONS ====================

export interface UserFavorite {
  type: 'team' | 'league' | 'player';
  id: string;
  name: string;
  addedAt: string;
}

// ==================== SCRAPING ====================

export interface ScrapedData {
  sourceUrl: string;
  extractedAt: string;
  matchData?: FootballMatch;
  statsData?: MatchStatistics;
  oddsData?: MarketOdds[];
  error?: string;
}
