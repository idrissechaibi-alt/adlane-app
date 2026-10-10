// Loi des comptages (corners, cartons, fautes) avec dispersion APPRISE.
//
// Poisson suppose variance = moyenne. Les matchs réels dépassent souvent ce
// cadre (un match ouvert à 15 corners pour 6 attendus, 6 buts pour 2,5) : les
// « Moins de » étaient alors trop sûrs et les lignes trop basses. La dispersion
// F = variance / moyenne, mesurée sur les matchs réglés (deltaLearning.ts),
// passe la loi en binomiale négative : même moyenne, queue plus épaisse.

/** P(X = k) pour une binomiale négative de moyenne `mean` et de rapport variance/moyenne `fano` (≥ 1). */
function pmfSeries(mean: number, fano: number, upTo: number): number[] {
  const out: number[] = [];
  if (mean <= 0) {
    for (let k = 0; k <= upTo; k++) out.push(k === 0 ? 1 : 0);
    return out;
  }
  if (fano <= 1.02) {
    let p = Math.exp(-mean);
    out.push(p);
    for (let k = 1; k <= upTo; k++) {
      p = (p * mean) / k;
      out.push(p);
    }
    return out;
  }
  const r = mean / (fano - 1);
  const q = mean / (r + mean); // probabilité d'« échec » de la binomiale négative
  let p = Math.pow(1 - q, r);
  out.push(p);
  for (let k = 0; k < upTo; k++) {
    p = (p * (k + r) * q) / (k + 1);
    out.push(p);
  }
  return out;
}

/** P(il reste au moins `needed` événements à venir). */
export function atLeastProb(mean: number, fano: number, needed: number): number {
  if (needed <= 0) return 1;
  const pmf = pmfSeries(mean, fano, needed - 1);
  const below = pmf.reduce((s, v) => s + v, 0);
  return Math.max(0, Math.min(1, 1 - below));
}

/** Ligne X.5 la plus HAUTE dont le « Plus de » reste au moins `threshold` probable. */
export function pickHighestOverLine(mean: number, fano: number, threshold: number, observed: number): { line: number; prob: number } | null {
  let best: { line: number; prob: number } | null = null;
  for (let i = 0; i < 30; i++) {
    const line = observed + 0.5 + i;
    const prob = atLeastProb(mean, fano, i + 1);
    if (prob < threshold) break;
    best = { line, prob };
  }
  return best;
}

/** Ligne X.5 la plus BASSE dont le « Moins de » reste au moins `threshold` probable. */
export function pickLowestUnderLine(mean: number, fano: number, threshold: number, observed: number): { line: number; prob: number } | null {
  for (let i = 0; i < 30; i++) {
    const line = observed + 0.5 + i;
    const prob = 1 - atLeastProb(mean, fano, i + 1);
    if (prob >= threshold) return { line, prob };
  }
  return null;
}
