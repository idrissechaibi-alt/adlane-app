// API Football - Module Principal
// Exporte tous les clients API et le gestionnaire

// ==================== TYPES ====================
export * from './types';

// ==================== CACHE ====================
export * from './cache';

// ==================== MANAGER ====================
export * from './footballAPIManager';

// ==================== API CLIENTS ====================

// BallDontLie (API-Football)
export * from './footballDataAPIs/ballDontLie';

// SofaScore
export * from './footballDataAPIs/sofaScore';

// Football-Data.org
export * from './footballDataAPIs/footballData';

// TheOddsAPI
export * from './footballDataAPIs/theOddsAPI';

// ==================== SCRAPING ====================
export * from './scraping/matchScraper';

// ==================== CALCULS AVANCÉS ====================
export * from '../calc/advancedCalculations';
