/* Client-computed fleet metrics. Pure — no DOM — so tools/selftest-metrics.mjs
 * can pin the band edges. */

/**
 * Fleet utilization (D19 by units, D44 by dollars) — one rentable population,
 * measured two ways.
 *
 *   population   units with status "RENTAL" and unit_state != "RETIRED"
 *                (RETIRED never ships anyway — D34)
 *   by units     ON-RENT count ÷ population count
 *   by dollars   ON-RENT acquisition_cost ÷ population acquisition_cost
 *
 * Demos and loaner-outs are out but not earning rent, so they sit in the
 * denominator of both. Each numerator is taken inside its own denominator set,
 * so neither ratio can exceed 100%.
 *
 * ACQUISITION COST ONLY (D44). Never book or ask: book drifts every anniversary
 * and would move the bar with no machine moving. Cost is what is actually tied
 * up in the yard. There is deliberately no toggle.
 *
 * A unit with no acquisition_cost is skipped on BOTH sides of the dollar ratio
 * and counted in `excluded` — treating a missing cost as $0 would quietly drag
 * the percentage down and make the fleet look worse than it is.
 *
 * Bands on the rounded whole-percent, identical for both bars:
 *   <30 Low · 30–60 Building · 61–80 Healthy · >80 Over-extended.
 * The word label is mandatory in the UI — two bands are red.
 *
 * -> { units: {onRent, total, pct, band, label, color},
 *      dollars: {onRent, total, pct, excluded, band, label, color} }
 */
export function utilization(units) {
  const pool = (units || []).filter((u) => u.status === 'RENTAL' && u.unit_state !== 'RETIRED');
  const isOut = (u) => u.unit_state === 'ON-RENT';
  // Schema 4 strips acquisition_cost from units, so this branch only ever has
  // costs to add up on a schema-3 snapshot. See utilizationFrom().

  const onRent = pool.filter(isOut).length;
  const total = pool.length;
  const pct = total ? Math.round((onRent / total) * 100) : null;

  const costed = pool.filter((u) => typeof u.acquisition_cost === 'number' && isFinite(u.acquisition_cost));
  const sum = (list) => list.reduce((n, u) => n + u.acquisition_cost, 0);
  const dollarTotal = sum(costed);
  const dollarOnRent = sum(costed.filter(isOut));
  const dollarPct = dollarTotal ? Math.round((dollarOnRent / dollarTotal) * 100) : null;

  return {
    units: { onRent, total, pct, ...band(pct) },
    dollars: {
      onRent: dollarOnRent,
      total: dollarTotal,
      pct: dollarPct,
      excluded: pool.length - costed.length,
      ...band(dollarPct),
    },
  };
}

/**
 * Utilization for a whole snapshot (D45).
 *
 * Schema 4 ships `meta.utilization` already computed by the engine and no
 * longer ships `acquisition_cost` at all, so the dollar ratio CANNOT be
 * recomputed here — the percentages are the only form the money takes on this
 * site. Prefer the engine's numbers whenever they are present.
 *
 * Schema 3 has no `meta.utilization`, so fall back to computing both bars from
 * `units[]` exactly as before. That path disappears once every published
 * snapshot is schema 4.
 *
 * Note there are no amounts in the schema-4 shape and none are invented here:
 * `dollars` carries a percentage and an exclusion count, never a total.
 */
export function utilizationFrom(snapshot) {
  const m = snapshot && snapshot.meta && snapshot.meta.utilization;
  if (m && typeof m === 'object') return fromMeta(m);
  return utilization(snapshot && snapshot.units);
}

/** The engine's percentages, taken verbatim; only the band words are ours. */
function fromMeta(m) {
  const u = m.units || {};
  const d = m.dollars || {};
  const pct = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const uPct = pct(u.pct);
  const dPct = pct(d.pct);
  return {
    units: { onRent: num(u.on_rent), total: num(u.total), pct: uPct, ...band(uPct) },
    // No `total` and no `onRent`: schema 4 carries no dollar amounts, ever, and
    // this site must not be the place one gets reconstructed.
    dollars: { pct: dPct, excluded: num(d.excluded) || 0, ...band(dPct) },
  };
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

/**
 * Recurring revenue (D21): sum of cycle_rate over agreements with cycle "28D"
 * that are still running — cycles_max null, or cycles_billed < cycles_max.
 * ONE-SHOT rows never count (the agreement:null orphan is ONE-SHOT). A 28D row
 * with next_due null (missing seed) still counts: the contracted rate is
 * recurring whether or not the next invoice date is known.
 * perMonth = total × 365 ÷ 28 ÷ 12, rounded to the whole dollar.
 */
export function recurringRevenue(agreements) {
  const rows = (agreements || []).filter((a) =>
    a && a.cycle === '28D' && (a.cycles_max == null || Number(a.cycles_billed) < Number(a.cycles_max)));
  const total = rows.reduce((sum, a) => sum + (typeof a.cycle_rate === 'number' ? a.cycle_rate : 0), 0);
  return { total, count: rows.length, perMonth: Math.round((total * 365) / 28 / 12) };
}
