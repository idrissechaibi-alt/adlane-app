jest.mock('../src/core/kvStore', () => {
  const m = new Map<string, string>();
  return { __esModule: true, default: { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k) } };
});
import { addRemoved, ensureRemovedLoaded, isLegRemoved, legShapeKey, removedOddsFactor } from '../src/core/removedBets';

describe('paris retirés', () => {
  beforeAll(async () => {
    await ensureRemovedLoaded();
  });

  it('même pari à deux checkpoints = même identité', () => {
    expect(legShapeKey('total_buts', 'Moins de 3.5 buts (total match)')).toBe(legShapeKey('total_buts', 'Moins de 3.5 buts (total match)'));
    expect(legShapeKey('total_buts', 'Plus de 3.5 buts (total match)')).not.toBe(legShapeKey('total_buts', 'Moins de 3.5 buts (total match)'));
  });

  it('marchés par équipe : deux équipes = deux paris', () => {
    expect(legShapeKey('buts_equipe', 'Plus de 0.5 but — Le Mans (extérieur)')).not.toBe(legShapeKey('buts_equipe', 'Plus de 0.5 but — Auxerre (domicile)'));
  });

  it("ligne inexistante : les lignes hors du menu sont bloquées, celles du menu non", async () => {
    await addRemoved({ home: 'Lyon', away: 'Nice', market: 'total_buts', selection: 'Plus de 1.5 buts (total match)', reason: 'ligne', lineMin: 2.5, lineMax: 5.5 });
    expect(isLegRemoved('Lyon', 'Nice', 'total_buts', 'Plus de 1.5 buts (total match)')).toBe(true);
    expect(isLegRemoved('Lyon', 'Nice', 'total_buts', 'Plus de 0.5 buts (total match)')).toBe(true);
    expect(isLegRemoved('Lyon', 'Nice', 'total_buts', 'Plus de 3.5 buts (total match)')).toBe(false);
    expect(isLegRemoved('Lyon', 'Nice', 'total_buts', 'Moins de 1.5 buts (total match)')).toBe(false);
    expect(isLegRemoved('Lyon', 'Brest', 'total_buts', 'Plus de 1.5 buts (total match)')).toBe(false);
  });

  it('cote sous le plancher : la cote estimée est ramenée à la cote réelle', async () => {
    await addRemoved({ home: 'Lyon', away: 'Nice', market: 'btts', selection: 'BTTS Oui — les deux équipes marquent (Oui)', reason: 'cote', ratio: 1.3 / 1.5 });
    const f = removedOddsFactor('Lyon', 'Nice', 'btts', 'BTTS Oui — les deux équipes marquent (Oui)');
    expect(f).toBeCloseTo(0.8667, 3);
    expect(1.5 * f).toBeLessThan(1.4);
    expect(1.7 * f).toBeGreaterThan(1.4);
    expect(removedOddsFactor('Lyon', 'Nice', 'btts', 'BTTS Non — au moins une des deux équipes ne marque pas (Non)')).toBe(1);
    expect(isLegRemoved('Lyon', 'Nice', 'btts', 'BTTS Oui — les deux équipes marquent (Oui)')).toBe(false);
  });
});
