// Alimentation continue des entraîneurs : le téléphone rapatrie (toutes les 6 h au plus) les banques de données publiées par le serveur PC
// (moyennes par club à jour, data/server/banks) et les nouveaux savoirs déposés dans le dépôt (scripts/coaches/inbox/*.json), sans
// nouvelle version de l'app. Ils complètent ou remplacent les chiffres embarqués dans knowledgeBase.ts.

import AsyncStorage from '../kvStore';
import { fetchRepoText, listRepoDir } from '../gitAutoSync';
import { clubCoachOf } from './clubCoaches';
import type { TeamWindow } from './leagueStats';
import type { KnowledgeFact } from './knowledgeBase';

const STATS_KEY = '@coach_bank_club_stats';
const FACTS_KEY = '@coach_dynamic_facts';
const AT_KEY = '@coach_feed_pulled_at';
const PULL_EVERY_MS = 6 * 3_600_000;
const MAX_DYNAMIC_FACTS = 600;

export const BANK_STATS_PATH = 'data/server/banks/club-stats.json';
export const INBOX_DIR = 'scripts/coaches/inbox';

interface BankFile {
  updatedAt: string;
  clubs: Record<string, { league: string; courant?: TeamWindow; deuxSaisons?: TeamWindow }>;
}

let bank: { updatedAt: string; byClub: Map<string, { courant?: TeamWindow; deuxSaisons?: TeamWindow }> } | null = null;
let dynamic: KnowledgeFact[] = [];
let loaded = false;

function indexBank(file: BankFile): void {
  const byClub = new Map<string, { courant?: TeamWindow; deuxSaisons?: TeamWindow }>();
  for (const [csvName, v] of Object.entries(file.clubs ?? {})) {
    const club = clubCoachOf(csvName);
    if (club && club.league === v.league) byClub.set(club.club, { courant: v.courant, deuxSaisons: v.deuxSaisons });
  }
  bank = { updatedAt: file.updatedAt, byClub };
}

/** Charge en mémoire ce que le téléphone a déjà rapatrié (appelé avant de construire un dossier). */
export async function loadKnowledgeFeed(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STATS_KEY);
    if (raw) indexBank(JSON.parse(raw));
  } catch {
    bank = null;
  }
  try {
    dynamic = JSON.parse((await AsyncStorage.getItem(FACTS_KEY)) ?? '[]');
  } catch {
    dynamic = [];
  }
}

/** Moyennes à jour d'un club (nom de la fiche), ou null tant que le serveur n'en a pas publié. */
export function bankStatsFor(club: string): { courant?: TeamWindow; deuxSaisons?: TeamWindow; updatedAt: string } | null {
  const v = bank?.byClub.get(club);
  return v && bank ? { ...v, updatedAt: bank.updatedAt } : null;
}

/** Savoirs ajoutés depuis la sortie de l'app (déposés dans le dépôt). */
export function dynamicFacts(): KnowledgeFact[] {
  return dynamic;
}

export function knowledgeFeedStatus(): { clubsWithFreshStats: number; statsUpdatedAt: string | null; dynamicFacts: number } {
  return { clubsWithFreshStats: bank?.byClub.size ?? 0, statsUpdatedAt: bank?.updatedAt ?? null, dynamicFacts: dynamic.length };
}

const factKey = (f: { topic?: string; fact_fr?: string }) => `${f.topic ?? ''}|${(f.fact_fr ?? '').slice(0, 80)}`;

/** Rapatrie les banques de données et les nouveaux savoirs (toutes les 6 h au plus). Renvoie ce qui a été reçu, ou null. */
export async function pullKnowledgeFeed(force = false): Promise<{ clubs: number; facts: number } | null> {
  await loadKnowledgeFeed();
  try {
    const last = Number(await AsyncStorage.getItem(AT_KEY)) || 0;
    if (!force && Date.now() - last < PULL_EVERY_MS) return null;
    let clubs = 0;
    const statsText = await fetchRepoText(BANK_STATS_PATH);
    if (statsText) {
      const file: BankFile = JSON.parse(statsText);
      if (file?.clubs && Object.keys(file.clubs).length >= 60) {
        await AsyncStorage.setItem(STATS_KEY, statsText);
        indexBank(file);
        clubs = bank?.byClub.size ?? 0;
      }
    }
    // Nouveaux savoirs : tout fichier .json du dossier de dépôt contenant des faits (fact_fr) ; les doublons sont ignorés.
    const files = ((await listRepoDir(INBOX_DIR)) ?? []).filter((f) => f.name.endsWith('.json'));
    const seen = new Set(dynamic.map(factKey));
    const added: KnowledgeFact[] = [];
    for (const f of files) {
      const text = await fetchRepoText(f.path);
      if (!text) continue;
      let list: any[] = [];
      try {
        list = JSON.parse(text);
      } catch {
        continue;
      }
      for (const x of Array.isArray(list) ? list : []) {
        if (!x?.fact_fr || !x?.topic || seen.has(factKey(x))) continue;
        seen.add(factKey(x));
        added.push({
          id: `D${dynamic.length + added.length + 1}`,
          topic: String(x.topic),
          fact_fr: String(x.fact_fr).slice(0, 1500),
          use_fr: x.use_fr ?? x.how_to_read_live_fr ?? null,
          caveat_fr: x.caveat_fr ?? null,
          confidence: x.confidence ?? null,
          source: x.source ?? { citation: [x.author, x.title].filter(Boolean).join(' — '), url: x.url, read: x.read },
        });
      }
    }
    if (added.length) {
      dynamic = [...dynamic, ...added].slice(-MAX_DYNAMIC_FACTS);
      await AsyncStorage.setItem(FACTS_KEY, JSON.stringify(dynamic));
    }
    await AsyncStorage.setItem(AT_KEY, String(Date.now()));
    return { clubs, facts: added.length };
  } catch {
    return null;
  }
}
