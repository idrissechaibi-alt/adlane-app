jest.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: {}, EncodingType: {} }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('../src/core/gitAutoSync', () => ({ fetchRepoJson: async () => null, fetchRepoText: async () => null }));
jest.mock('../src/core/kvStore', () => {
  const m = new Map<string, string>();
  return { __esModule: true, default: { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k) } };
});
import { coachBriefing } from '../src/core/coaches/knowledgeBase';
import { COACHES } from '../src/core/coaches/knowledge';
import { opinionOn, type TacticalRead } from '../src/core/coaches/tacticalEngine';
import { expectedBehavior, matchupOf, tendencyOf } from '../src/core/coaches/teamTendencies';

const read = (over: Partial<TacticalRead>): TacticalRead => ({
  minute: 60, diff: 0, state: 'nul', dominance: 0, recentDominance: 0, tempoTrend: 1, eventsPerMin: 0.3, tension: 0.3, phase: 'fenetre_changements',
  profile: 'indetermine', momentum: null, momentumShift: null, territory: null, heightH: null, heightA: null, reds: 0, reliable: true, flags: [], ...over,
});
const coach = COACHES.find((c) => c.id === 'guardiola')!;

describe('tendances d’équipe', () => {
  it('retrouve une équipe par ses noms usuels, y compris sans fichier vidéo propre', () => {
    expect(tendencyOf('Real Madrid')?.conf).toBe('moyenne');
    expect(tendencyOf('Brighton & Hove Albion')?.leading).toBe('bloc_bas');
    expect(tendencyOf('Équipe inconnue')).toBeNull();
  });

  it('reconnaît un duel : contre-attaque contre ligne haute', () => {
    const m = matchupOf(tendencyOf('Monaco'), tendencyOf('TSG Hoffenheim'));
    expect(m.flags).toContain('contre_contre_ligne_haute');
    expect(m.tempoBias).toBeGreaterThan(0);
  });

  it('deux équipes fermées : duel fermé', () => {
    const m = matchupOf(tendencyOf('Getafe'), tendencyOf('SC Paderborn'));
    expect(m.flags).toContain('deux_equipes_fermees');
    expect(m.tempoBias).toBeLessThan(0);
  });

  it('sans fiche : aucune lecture', () => {
    expect(matchupOf(null, null)).toEqual({ flags: [], tempoBias: 0, notes: [], weight: 0 });
  });

  it('décrit la réaction d’une équipe selon le score', () => {
    expect(expectedBehavior(tendencyOf('Hull City'), { minute: 10, diff: 0, secondHalf: false }).join(' ')).toMatch(/démarre souvent mal/);
    expect(expectedBehavior(tendencyOf('Brighton & Hove Albion'), { minute: 60, diff: 1, secondHalf: true }).join(' ')).toMatch(/recule/);
  });

  it('une équipe qui recule en menant abaisse l’avis sur « plus de buts »', () => {
    const r = read({ diff: 1, state: 'domicile_devant', minute: 60 });
    const leg = { market: 'total_buts', selection: 'Plus de 2.5 buts (total match)', homeTeam: 'Brighton & Hove Albion', awayTeam: 'Manchester City' };
    const sans = opinionOn(r, coach, leg);
    const avec = opinionOn(r, coach, leg, { home: tendencyOf(leg.homeTeam), away: tendencyOf(leg.awayTeam) });
    expect(avec.reasons.join(' ')).toMatch(/profil : Brighton & Hove Albion recule/);
    expect(avec.adjust).toBeLessThanOrEqual(sans.adjust);
  });

  it('l’apport des tendances reste borné', () => {
    const r = read({ diff: -1, state: 'exterieur_devant', minute: 70 });
    const leg = { market: 'total_buts', selection: 'Plus de 1.5 buts (total match)', homeTeam: 'TSG Hoffenheim', awayTeam: 'Lens' };
    const a = opinionOn(r, coach, leg);
    const b = opinionOn(r, coach, leg, { home: tendencyOf(leg.homeTeam), away: tendencyOf(leg.awayTeam) });
    // Jamais le motif principal : l'écart de confiance reste faible.
    expect(Math.abs(b.adjust - a.adjust)).toBeLessThanOrEqual(0.03);
  });

  it('le briefing reste de taille raisonnable avec les observations vidéo', () => {
    const b = coachBriefing('Arsenal', 'Chelsea', 'Premier League');
    expect(b.context).toMatch(/Observations vidéo/);
    expect(b.context.length).toBeLessThan(14000);
  });
});

describe('poids de l’avis de l’entraîneur', () => {
  it('est nul tant que la preuve n’est pas faite', async () => {
    const { coachWeight } = await import('../src/core/coaches/coachDesk');
    expect(await coachWeight('guardiola')).toBe(0);
  });
});
