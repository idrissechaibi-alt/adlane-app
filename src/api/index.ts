// API Football - Module Principal
// Exporte les types, le manager et les clients API

// ==================== TYPES ====================
export * from './types';

// ==================== CACHE ====================
export * from './cache';

// ==================== MANAGER ====================
// Only export the manager (not individual API functions to avoid conflicts)
export { FootballAPIManager, createFootballAPIManager } from './footballAPIManager';
export type { FootballAPIConfig } from './footballAPIManager';