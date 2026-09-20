// Module Validator - Règles bloquantes et warnings (§4)
// Implémentation des 4 leçons apprises du terrain

import { Bet, BetLeg, ValidationFlag } from '../types';

export interface ValidationResult {
  valid: boolean;
  flags: ValidationFlag[];
  blockers: ValidationFlag[];  // Règles bloquantes (empêchent le pari)
  warnings: ValidationFlag[];  // Warnings (avertissent mais n'empêchent pas)
}

/**
 * Valide un pari selon les règles du §4
 * @param bet Le pari à valider
 * @param allBets Ensemble des paris existants pour vérifier l'exposition croisée
 * @param referenceTime Horodatage de test/exécution (défaut: now)
 */
export function validateBet(bet: Bet, allBets: Bet[] = [], referenceTime?: Date): ValidationResult {
  const flags: ValidationFlag[] = [];
  const blockers: ValidationFlag[] = [];
  const warnings: ValidationFlag[] = [];

  // BLOCK_1X2_SOUS_50 (§4.2 - Leçon "leg-1x2-sous-50-pourcent", 2 occurrences)
  for (const leg of bet.legs) {
    if (leg.market === '1X2' && leg.estimated_prob !== null && leg.estimated_prob !== undefined) {
      if (leg.estimated_prob < 0.50) {
        flags.push('BLOCK_1X2_SOUS_50');
        blockers.push('BLOCK_1X2_SOUS_50');
        break;
      }
    }
  }

  // BLOCK_COTE_MANQUANTE
  if (bet.legs.some(leg => !leg.is_void && leg.odds === null)) {
    flags.push('BLOCK_COTE_MANQUANTE');
    blockers.push('BLOCK_COTE_MANQUANTE');
  }

  // BLOCK_KICKOFF_DEPASSE (§5.3 - Leçon "j4-echec-taches-planifiees-14h")
  const now = referenceTime || new Date();
  for (const leg of bet.legs) {
    const kickoff = new Date(leg.kickoff_utc);
    if (now >= kickoff) {
      flags.push('BLOCK_KICKOFF_DEPASSE');
      blockers.push('BLOCK_KICKOFF_DEPASSE');
      break;
    }
  }

  // WARN_EXPOSITION_MATCH (§4.3 - Leçon "faux-combines-memes-matchs")
  // Vérifie si un même match apparaît dans > 2 slips (sur la session/journée)
  const sessionBets = allBets.filter(b => b.date === bet.date);
  const matchExposure = new Map<string, number>();

  for (const b of sessionBets) {
    for (const leg of b.legs) {
      const count = matchExposure.get(leg.match) || 0;
      matchExposure.set(leg.match, count + 1);
    }
  }

  for (const leg of bet.legs) {
    const count = matchExposure.get(leg.match) || 0;
    if (count > 2) {
      flags.push('WARN_EXPOSITION_MATCH');
      warnings.push('WARN_EXPOSITION_MATCH');
      break;
    }
  }

  // ERROR_AUTO_ANNULATION (§4.3)
  const oppositeSelections = detectOppositeSelections(bet, sessionBets);
  if (oppositeSelections) {
    flags.push('ERROR_AUTO_ANNULATION');
    blockers.push('ERROR_AUTO_ANNULATION');
  }

  // WARN_BTTS_NON_CALIBRE (§4.1 - Leçon "btts-equipe-en-disette", 3 occurrences)
  const hasBTTS = bet.legs.some(leg => leg.market === 'BTTS');
  if (hasBTTS) {
    flags.push('WARN_BTTS_NON_CALIBRE');
    warnings.push('WARN_BTTS_NON_CALIBRE');
  }

  // WARN_MARCHE_SANS_HISTO (§4 règle 5)
  const marketsWithoutHistory: string[] = ['corners', 'fouls', 'cards', 'shots_on_target', 'saves', '1ere_mi_temps'];
  for (const leg of bet.legs) {
    if (marketsWithoutHistory.includes(leg.market) && bet.confidence_level === 'Élevé') {
      flags.push('WARN_MARCHE_SANS_HISTO');
      warnings.push('WARN_MARCHE_SANS_HISTO');
      break;
    }
  }

  return {
    valid: blockers.length === 0,
    flags: [...new Set(flags)],
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)]
  };
}

/**
 * Détecte les sélections opposées entre paris (ex: O2.5 vs U2.5 sur même match)
 */
function detectOppositeSelections(bet: Bet, otherBets: Bet[]): boolean {
  for (const leg of bet.legs) {
    for (const otherBet of otherBets) {
      if (otherBet.id === bet.id) continue;

      for (const otherLeg of otherBet.legs) {
        // Même match + même marché -> vérifier si sélections opposées
        if (leg.match === otherLeg.match && leg.market === otherLeg.market) {
          // Cas évidents d'opposition textuelle
          if (
            (leg.selection.includes('Plus') && otherLeg.selection.includes('Moins')) ||
            (leg.selection.includes('Moins') && otherLeg.selection.includes('Plus')) ||
            (leg.selection.includes('Victoire') && otherLeg.selection.includes('Match nul')) ||
            (leg.selection.includes('Oui') && otherLeg.selection.includes('Non'))
          ) {
            return true;
          }
        }

        // Cas spécifique : OU_2_5 avec sélections différentes = opposition garantie
        if (leg.match === otherLeg.match && leg.market === 'OU_2_5' && otherLeg.market === 'OU_2_5') {
          if (leg.selection !== otherLeg.selection) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Lint de contenu - Bannit les mots interdits (§0)
 */
const BANNED_WORDS = [
  'sûr', 'sur', 'garanti', 'sans risque', 'banker', 'lock', '100%', '100 %',
  'certain', 'assuré', 'gagnant', 'immanquable'
];

export function lintContent(text: string): { valid: boolean; bannedWords: string[] } {
  const lowerText = text.toLowerCase();
  const found = BANNED_WORDS.filter(word => lowerText.includes(word));

  return {
    valid: found.length === 0,
    bannedWords: found
  };
}
