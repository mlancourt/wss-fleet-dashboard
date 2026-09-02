/* Client-computed fleet metrics. Pure — no DOM — so tools/selftest-metrics.mjs
 * can pin the band edges. */

/**
 * Fleet utilization (D19).
 *   numerator    units ON-RENT
 *   denominator  units with status "RENTAL" and unit_state != "RETIRED"
 * Demos and loaner-outs are not on rent. The numerator is taken inside the
 * denominator set, so the ratio can never exceed 100%.
 * Bands on the rounded whole-percent: <30 Low · 30–60 Building · 61–80 Healthy · >80 Over-extended.
 * The word label is mandatory in the UI — two bands are red.
 */
export function utilization(units) {
  const pool = (units || []).filter((u) => u.status === 'RENTAL' && u.unit_state !== 'RETIRED');
  const onRent = pool.filter((u) => u.unit_state === 'ON-RENT').length;
  const denom = pool.length;
  const pct = denom ? Math.round((onRent / denom) * 100) : null;
  return { pct, onRent, denom, ...band(pct) };
}

/** -> { band: 'low'|'building'|'healthy'|'over'|'none', label, color: 'red'|'yellow'|'green'|'none' } */
export function band(pct) {
  if (pct == null || Number.isNaN(pct)) return { band: 'none', label: '—', color: 'none' };
  if (pct < 30) return { band: 'low', label: 'Low', color: 'red' };
  if (pct <= 60) return { band: 'building', label: 'Building', color: 'yellow' };
  if (pct <= 80) return { band: 'healthy', label: 'Healthy', color: 'green' };
  return { band: 'over', label: 'Over-extended', color: 'red' };
}
