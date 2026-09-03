#!/usr/bin/env node
/** selftest-metrics.mjs — pins the D19 (units) and D44 (dollars) utilization
 *  math and the band edges both bars share. Run: npm test */
import assert from 'node:assert/strict';
import { utilization, utilizationFrom, band } from '../docs/metrics.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const U = (state, status = 'RENTAL', acquisition_cost = 1000) => ({ unit_state: state, status, acquisition_cost });

console.log('utilization self-test');

check('band edges: <30 Low, 30–60 Building, 61–80 Healthy, >80 Over-extended', () => {
  const want = { 0: 'Low', 29: 'Low', 30: 'Building', 45: 'Building', 60: 'Building',
                 61: 'Healthy', 80: 'Healthy', 81: 'Over-extended', 100: 'Over-extended' };
  for (const [p, l] of Object.entries(want)) assert.equal(band(+p).label, l, `${p}%`);
  assert.equal(band(29).color, 'red'); assert.equal(band(30).color, 'yellow');
  assert.equal(band(61).color, 'green'); assert.equal(band(81).color, 'red');
  assert.equal(band(null).label, '—');
});

check('denominator = RENTAL and not RETIRED; numerator = ON-RENT only', () => {
  const units = [
    U('ON-RENT'), U('ON-RENT'), U('AVAILABLE'), U('IN-SHOP'),        // 2 of 4 rental
    U('ON-DEMO'),                                                    // in denominator, not numerator
    U('LOANER-OUT', 'LOANER'), U('AVAILABLE', 'LOANER'),             // loaner status: excluded
    U('RETIRED'),                                                    // retired: excluded
  ];
  const r = utilization(units).units;
  assert.equal(r.total, 5);
  assert.equal(r.onRent, 2);
  assert.equal(r.pct, 40);
  assert.equal(r.label, 'Building');
});

check('rounds to a whole percent, and the rounded value picks the band', () => {
  const mk = (on, total) => utilization([...Array(on)].map(() => U('ON-RENT')).concat([...Array(total - on)].map(() => U('AVAILABLE')))).units;
  assert.equal(mk(2, 7).pct, 29);   // 28.57 -> 29 Low
  assert.equal(mk(2, 7).label, 'Low');
  assert.equal(mk(3, 5).pct, 60);   // exactly 60 -> Building
  assert.equal(mk(3, 5).label, 'Building');
  assert.equal(mk(11, 18).pct, 61); // 61.1 -> Healthy
  assert.equal(mk(11, 18).label, 'Healthy');
  assert.equal(mk(4, 5).pct, 80);   // Healthy
  assert.equal(mk(4, 5).label, 'Healthy');
  assert.equal(mk(13, 16).pct, 81); // 81.25 -> Over-extended
  assert.equal(mk(13, 16).label, 'Over-extended');
  assert.equal(mk(5, 5).pct, 100);
});

check('empty fleet / no rental units -> no percentage, never NaN', () => {
  for (const empty of [utilization([]), utilization([U('RETIRED'), U('AVAILABLE', 'LOANER')]), utilization(undefined)]) {
    assert.equal(empty.units.pct, null);
    assert.equal(empty.dollars.pct, null);
    assert.equal(empty.units.label, '—');
    assert.equal(empty.dollars.label, '—');
    assert.equal(empty.dollars.total, 0);
  }
});

check('ON-RENT never exceeds 100% even if a LOANER-status unit is marked ON-RENT', () => {
  const r = utilization([U('ON-RENT'), U('ON-RENT', 'LOANER')]).units;
  assert.equal(r.pct, 100);
});

/* ------------------------------------------------ utilization by dollars (D44) */

check('dollar % is on-rent cost over rentable cost, on the same population as units', () => {
  const r = utilization([
    U('ON-RENT', 'RENTAL', 30000), U('ON-RENT', 'RENTAL', 20000),   // $50k earning
    U('AVAILABLE', 'RENTAL', 10000),                                 // $10k idle
    U('ON-DEMO', 'RENTAL', 25000),                                   // out, not on rent
    U('LOANER-OUT', 'RENTAL', 15000),                                // out, not on rent
    U('RETIRED', 'RENTAL', 99999),                                   // never counted
    U('AVAILABLE', 'LOANER', 88888),                                 // not rentable
  ]);
  assert.equal(r.dollars.onRent, 50000);
  assert.equal(r.dollars.total, 100000);      // 30+20+10+25+15
  assert.equal(r.dollars.pct, 50);
  assert.equal(r.dollars.label, 'Building');
  assert.equal(r.dollars.excluded, 0);
  // the same call answers the unit question over the same five machines
  assert.equal(r.units.total, 5);
  assert.equal(r.units.onRent, 2);
  assert.equal(r.units.pct, 40);
});

check('a demo or loaner counts as capital NOT on rent, never as on rent', () => {
  const r = utilization([U('ON-DEMO', 'RENTAL', 40000), U('LOANER-OUT', 'RENTAL', 60000)]);
  assert.equal(r.dollars.onRent, 0);
  assert.equal(r.dollars.total, 100000);
  assert.equal(r.dollars.pct, 0);
  assert.equal(r.dollars.label, 'Low');
});

check('a missing cost is excluded from BOTH sides and counted — never treated as $0', () => {
  const noCost = { unit_state: 'ON-RENT', status: 'RENTAL', acquisition_cost: null };
  const absent = { unit_state: 'AVAILABLE', status: 'RENTAL' };
  const r = utilization([U('ON-RENT', 'RENTAL', 60000), U('AVAILABLE', 'RENTAL', 40000), noCost, absent]);
  assert.equal(r.dollars.excluded, 2);
  assert.equal(r.dollars.onRent, 60000, 'the costless ON-RENT unit adds nothing to the numerator');
  assert.equal(r.dollars.total, 100000, 'nor to the denominator');
  assert.equal(r.dollars.pct, 60);
  // Counting them as $0 would have given 60/100 on a 4-unit denominator — the
  // trap this test exists for. The UNIT bar still counts all four.
  assert.equal(r.units.total, 4);
  assert.equal(r.units.onRent, 2);
  // A non-finite cost is missing too, not zero.
  assert.equal(utilization([U('ON-RENT', 'RENTAL', NaN), U('AVAILABLE', 'RENTAL', 100)]).dollars.excluded, 1);
});

check('every cost missing -> no dollar percentage, never NaN or a divide-by-zero', () => {
  const r = utilization([{ unit_state: 'ON-RENT', status: 'RENTAL' }, { unit_state: 'AVAILABLE', status: 'RENTAL' }]);
  assert.equal(r.dollars.pct, null);
  assert.equal(r.dollars.label, '—');
  assert.equal(r.dollars.excluded, 2);
  assert.equal(r.units.pct, 50, 'the unit bar is unaffected by missing money');
});

check('both bars read the same band vocabulary for the same percentage', () => {
  for (const pct of [0, 29, 30, 60, 61, 80, 81, 100]) {
    const onUnits = utilization([...Array(pct)].map(() => U('ON-RENT'))
      .concat([...Array(100 - pct)].map(() => U('AVAILABLE')))).units;
    // one $1 unit per percentage point makes the dollar ratio identical
    const onDollars = utilization([...Array(pct)].map(() => U('ON-RENT', 'RENTAL', 1))
      .concat([...Array(100 - pct)].map(() => U('AVAILABLE', 'RENTAL', 1)))).dollars;
    assert.equal(onUnits.pct, pct);
    assert.equal(onDollars.pct, pct);
    assert.equal(onDollars.label, onUnits.label, `${pct}% must read the same on both bars`);
    assert.equal(onDollars.color, onUnits.color);
  }
});

/* --------------------------------- schema 4: the engine hands us the numbers (D45) */

check('schema 4: percentages come from meta.utilization, untouched', () => {
  const r = utilizationFrom({ meta: { schema_version: 4, utilization: {
    units: { on_rent: 18, total: 35, pct: 51 },
    dollars: { pct: 60, excluded: 2 },
  } } });
  assert.equal(r.units.onRent, 18);
  assert.equal(r.units.total, 35);
  assert.equal(r.units.pct, 51);
  assert.equal(r.units.label, 'Building');
  assert.equal(r.dollars.pct, 60);
  assert.equal(r.dollars.excluded, 2);
  assert.equal(r.dollars.label, 'Building');
  // Schema 4 ships no amounts, and none may be invented from the percentages.
  assert.equal(r.dollars.total, undefined, 'no dollar total may appear');
  assert.equal(r.dollars.onRent, undefined, 'no dollar amount may appear');
});

check('schema 4 wins even when units[] still carries costs', () => {
  // Belt and braces: if a transitional snapshot had both, the engine's number
  // is the authority — the client must not quietly recompute a different one.
  const r = utilizationFrom({
    meta: { utilization: { units: { on_rent: 1, total: 4, pct: 25 }, dollars: { pct: 25, excluded: 0 } } },
    units: [U('ON-RENT', 'RENTAL', 90000), U('AVAILABLE', 'RENTAL', 10000)],
  });
  assert.equal(r.units.pct, 25);
  assert.equal(r.dollars.pct, 25, 'must not recompute 90% from the stale costs');
});

check('schema 3 fallback: no meta.utilization -> computed from units[] as before', () => {
  const snap = { meta: { schema_version: 3 }, units: [
    U('ON-RENT', 'RENTAL', 60000), U('AVAILABLE', 'RENTAL', 40000),
  ] };
  const r = utilizationFrom(snap);
  assert.equal(r.units.pct, 50);
  assert.equal(r.dollars.pct, 60);
  assert.equal(r.dollars.label, 'Building');
  // identical to calling the fallback directly
  assert.deepEqual(r, utilization(snap.units));
});

check('a snapshot with neither meta.utilization nor costs degrades, never throws', () => {
  const r = utilizationFrom({ meta: {}, units: [{ status: 'RENTAL', unit_state: 'ON-RENT' }] });
  assert.equal(r.units.pct, 100);
  assert.equal(r.dollars.pct, null);
  assert.equal(r.dollars.label, '—');
  // and the degenerate inputs
  for (const bad of [undefined, null, {}, { meta: null }]) {
    const x = utilizationFrom(bad);
    assert.equal(x.units.pct, null);
    assert.equal(x.dollars.pct, null);
  }
});

check('a malformed meta.utilization yields no percentage rather than NaN', () => {
  const r = utilizationFrom({ meta: { utilization: { units: { pct: 'lots' }, dollars: {} } } });
  assert.equal(r.units.pct, null);
  assert.equal(r.units.label, '—');
  assert.equal(r.dollars.pct, null);
  assert.equal(r.dollars.excluded, 0);
});

check('the live example: 18/35 units = 51%, $251,624/$421,578 = 60% Building', () => {
  // Two bars, one fleet, legitimately different numbers — a few expensive
  // riders out on rent move the money bar further than the unit bar.
  const fleet = [];
  // 18 on rent totalling 251,624; 17 idle totalling 169,954 (= 421,578 - 251,624)
  const spread = (n, total, state) => {
    const each = Math.floor(total / n);
    for (let i = 0; i < n; i++) fleet.push(U(state, 'RENTAL', i === n - 1 ? total - each * (n - 1) : each));
  };
  spread(18, 251624, 'ON-RENT');
  spread(17, 169954, 'AVAILABLE');
  const r = utilization(fleet);
  assert.equal(r.units.total, 35);
  assert.equal(r.units.onRent, 18);
  assert.equal(r.units.pct, 51);          // 51.43 -> 51
  assert.equal(r.dollars.onRent, 251624);
  assert.equal(r.dollars.total, 421578);
  assert.equal(r.dollars.pct, 60);        // 59.69 -> 60
  assert.equal(r.dollars.label, 'Building');
});

console.log(`\n${passed} checks passed`);

// ---- D20 status board ---------------------------------------------------
const { statusBoard, BOARD_ROWS } = await import('../docs/metrics.js');
const R = (state, readiness = 'READY', status = 'RENTAL') => ({ unit_state: state, readiness, status });

check('board: six rows, mutually exclusive, counts sum to the non-retired fleet', () => {
  const units = [
    R('ON-RENT'), R('ON-RENT', 'DOWN'),            // readiness ignored for out states
    R('ON-DEMO', 'NEEDS-PREP'),
    R('LOANER-OUT', 'READY', 'LOANER'),
    R('AVAILABLE', 'READY'), R('RESERVED', 'READY'), R('IN-SHOP', 'READY'),
    R('AVAILABLE', 'NEEDS-PREP'), R('IN-SHOP', null),   // unknown readiness -> needs prep
    R('IN-SHOP', 'DOWN'),
    R('RETIRED', 'DOWN'),                               // excluded entirely
  ];
  const b = statusBoard(units);
  assert.equal(b.total, 10);
  assert.deepEqual(b.rows.map((r) => r.count), [2, 1, 1, 3, 2, 1]);
  assert.equal(b.rows.reduce((a, r) => a + r.count, 0), b.total);
  assert.deepEqual(b.rows.map((r) => r.key), BOARD_ROWS.map((r) => r.key));
  assert.equal(b.rows[0].pct, 20);
  assert.equal(b.rows[3].pct, 30);
});

check('board: zero-count rows are present with 0, and an empty fleet never yields NaN', () => {
  const b = statusBoard([R('ON-RENT'), R('ON-RENT')]);
  assert.equal(b.rows.length, 6);
  assert.deepEqual(b.rows.map((r) => r.count), [2, 0, 0, 0, 0, 0]);
  assert.deepEqual(b.rows.map((r) => r.pct), [100, 0, 0, 0, 0, 0]);
  const e = statusBoard([]);
  assert.equal(e.total, 0);
  assert.ok(e.rows.every((r) => r.count === 0 && r.pct === 0));
});

console.log(`\n${passed} checks passed (incl. board)`);

// ---- D21 recurring revenue ------------------------------------------------
const { recurringRevenue } = await import('../docs/metrics.js');
const A = (cycle, rate, billed = 1, max = null, extra = {}) => ({ agreement: 1, cycle, cycle_rate: rate, cycles_billed: billed, cycles_max: max, next_due: '2026-09-20', ...extra });

check('recurring: 28D and still running only; ONE-SHOT, past-max and orphan excluded; null next_due included', () => {
  const r = recurringRevenue([
    A('28D', 1000),                       // open-ended            ✓
    A('28D', 500, 2, 6),                  // 2 of 6                ✓
    A('28D', 700, 6, 6),                  // at max                ✗
    A('28D', 900, 7, 6),                  // past max              ✗
    A('ONE-SHOT', 400, 1, 1),             // one-shot              ✗
    A('ONE-SHOT', 0, 0, null, { agreement: null }),   // the orphan  ✗
    A('28D', 300, 1, null, { next_due: null }),        // missing seed ✓
  ]);
  assert.equal(r.count, 3);
  assert.equal(r.total, 1800);
});

check('recurring: per-month = total × 365 ÷ 28 ÷ 12, whole dollars', () => {
  assert.equal(recurringRevenue([A('28D', 28)]).perMonth, Math.round((28 * 365) / 28 / 12)); // 30
  assert.equal(recurringRevenue([A('28D', 26005)]).perMonth, 28249);   // 28,249.48 -> 28,249
  assert.equal(recurringRevenue([]).total, 0);
  assert.equal(recurringRevenue([]).perMonth, 0);
  assert.equal(recurringRevenue(undefined).count, 0);
});

check('recurring: a non-numeric cycle_rate contributes nothing rather than NaN', () => {
  const r = recurringRevenue([A('28D', null), A('28D', 100)]);
  assert.equal(r.total, 100); assert.equal(r.count, 2);
});

console.log(`\n${passed} checks passed (incl. revenue)`);
