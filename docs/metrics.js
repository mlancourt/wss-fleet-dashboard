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

/**
 * Fleet status board (D20): six mutually exclusive buckets over the non-retired
 * fleet, summing to 100%. Out states bucket by unit_state; on-hand states
 * (AVAILABLE / RESERVED / IN-SHOP) bucket by readiness. An on-hand unit with an
 * unrecognised readiness is counted as NEEDS-PREP — it isn't ready, and the
 * board must never lose a unit.
 */
export const BOARD_ROWS = [
  { key: 'on-rent', label: 'On rent', color: 'rent' },
  { key: 'on-demo', label: 'On demo', color: 'demo' },
  { key: 'loaner-out', label: 'Loaner out', color: 'loaner' },
  { key: 'ready', label: 'Ready', color: 'ok' },
  { key: 'needs-prep', label: 'Needs prep', color: 'warn' },
  { key: 'down', label: 'Down', color: 'bad' },
];

export function statusBoard(units) {
  const live = (units || []).filter((u) => u.unit_state !== 'RETIRED');
  const counts = Object.fromEntries(BOARD_ROWS.map((r) => [r.key, 0]));
  for (const u of live) {
    if (u.unit_state === 'ON-RENT') counts['on-rent']++;
    else if (u.unit_state === 'ON-DEMO') counts['on-demo']++;
    else if (u.unit_state === 'LOANER-OUT') counts['loaner-out']++;
    else if (u.readiness === 'READY') counts.ready++;
    else if (u.readiness === 'DOWN') counts.down++;
    else counts['needs-prep']++;
  }
  const total = live.length;
  return {
    total,
    rows: BOARD_ROWS.map((r) => ({
      ...r,
      count: counts[r.key],
      pct: total ? Math.round((counts[r.key] / total) * 100) : 0,
    })),
  };
}
