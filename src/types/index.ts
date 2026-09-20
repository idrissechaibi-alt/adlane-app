// Types centraux pour APP adlane - Système de suivi et analyse de paris football
// Conforme au schéma cible du HANDOFF-PARIS-FOOT.md §2

export type BetStatus = 'proposed' | 'pending' | 'won' | 'lost' | 'void';
export type LegResult = 'pending' | 'won' | 'lost' | 'void';
export type ConfidenceLevel = 'Faible' | 'Moyen' | 'Élevé';
export type Market =
  | '1X2'
  | 'BTTS'
  | 'OU_2_5'
  | 'corners'
  | 'shots_on_target'
  | 'fouls'
  | 'cards'
  | 'saves'
  | '1ere_mi_temps';

export type ValidationFlag =
  | 'BLOCK_1X2_SOUS_50'           // Jambe 1X2 ou nul < 50%
  | 'BLOCK_COTE_MANQUANTE'        // Jambe sans cote publiée
  | 'BLOCK_KICKOFF_DEPASSE'       // now >= kickoff (§4.4)
  | 'WARN_EXPOSITION_MATCH'       // Match dans > 2 slips
  | 'ERROR_AUTO_ANNULATION'       // Jambes opposées entre slips
  | 'WARN_BTTS_NON_CALIBRE'       // BTTS mal calibré (§4.1)
  | 'WARN_MARCHE_SANS_HISTO';     // Marché non historisé

export interface BetLeg {
  id: string;
  match: string;                  // ex: "Real Sociedad - Atlético Madrid"
  matchId?: string;                // id stable du match (ScheduledMatchDetail.id), pour retrouver le rafraîchissement T-90
  leagueId?: string;                // id de compétition (football-data.org ou API-Football selon la source), pour les stats corners/cartons/fautes
  kickoff_utc: string;            // ISO 8601 (ex: "2026-09-13T19:00:00Z")
  league: string;                 // ex: "La Liga"
  market: Market;
  selection: string;              // ex: "Plus de 2,5 buts", "Victoire Arsenal"
  odds: number | null;            // null si non publiée -> BLOCK_COTE_MANQUANTE
  /** 'market' = cote réelle (bookmaker) ; 'estimated' = cote juste théorique (1/proba modèle), sans marché publié pour ce type de sélection (corners/cartons/fautes/1ère mi-temps). Jamais affichée comme une cote ferme : l'utilisateur la complète lui-même au placement. */
  oddsSource?: 'market' | 'estimated';
  estimated_prob?: number | null; // Probabilité estimée par le modèle (0 à 1)
  is_void: boolean;               // true si joueur/match annulé
  result: LegResult;
  stat_observed?: string | null;  // Stat mesurée (ex: "3 tirs cadrés", "Score 0-3")
  evidence_url?: string | null;   // Preuve résultat (Sofascore, Flashscore, etc.)
}

export interface Bet {
  id: string;                     // ex: "j4-c01", "combo-div-1"
  version: number;                // Contrôle de concurrence optimiste (if_version)
  date: string;                   // Date attendue YYYY-MM-DD
  creneau_utc: string;            // Heure/créneau en UTC
  creneau_display: string;        // Affichage Algérie (UTC+1)
  league: string;                 // Compétition ou libellé de session
  legs: BetLeg[];                 // 100% structuré (Dérive 1 résolue)

  // Financier
  odds: number | null;            // Cote effective recalculée si void
  stake: number | null;           // Mise saisie par l'utilisateur
  payout?: number | null;         // Gains bruts si won
  net_pnl?: number | null;        // Net (+ gains - mise)
  excluded_from_pnl: boolean;     // Explicite si odds ou stake null (Dérive 3)

  // Statut & Décision
  status: BetStatus;
  played: boolean;                // false si resté au stade d'étude (Dérive 2)
  confiance: number | null;       // 0-100
  confidence_level: ConfidenceLevel;

  // Analyse & Audit
  analysis: string;               // 1 à 3 phrases factuelles et chiffrées
  resultat_verif?: string | null; // Journal de vérification
  validation_flags: ValidationFlag[]; // Warnings/Blocks levés

  createdAt: string;              // ISO 8601
  updatedAt: string;              // ISO 8601
}

export interface Lesson {
  doc_id: string;                 // ex: "btts-equipe-en-disette"
  motif: string;                  // Libellé du piège identifié
  occurrences: number;            // Nombre d'incidents réels
  regle_validation: ValidationFlag; // Règle bloquante/warning liée
  detail: string;                 // Historique factuel + correctif
  derniere_maj: string;           // YYYY-MM-DD
}

export interface MarketCalibration {
  market: Market;
  league?: string;
  total_predictions: number;
  predictions_won: number;
  actual_success_rate: number;    // Taux réel (ex: 0.40 pour BTTS)
  avg_predicted_prob: number;     // Proba moyenne annoncée (ex: 0.62)
  calibration_status: 'calibre' | 'suspect' | 'non_calibre';
  last_updated: string;           // ISO 8601
}

export interface OmnirouteConfig {
  endpoint: string;               // URL de ton Omniroute
  apiKey: string;                 // Clé API
  selectedModel: string;          // Modèle actif
  availableModels: string[];      // Liste des modèles configurés
}

export interface DailyReport {
  date: string;                   // YYYY-MM-DD
  bets_settled: number;
  bets_won: number;
  bets_lost: number;
  total_stake: number;
  total_return: number;
  net_pnl: number;
  roi: number;
  lessons_learned: string[];      // Références aux doc_id des leçons
  details: string;                // Rapport formaté (§5.5)
}
