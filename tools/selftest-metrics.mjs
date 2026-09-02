#!/usr/bin/env node
/** selftest-metrics.mjs — pins the D19 utilization math and band edges. Run: npm test */
import assert from 'node:assert/strict';
import { utilization, band } from '../docs/metrics.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const U = (state, status = 'RENTAL') => ({ unit_state: state, status });

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
  const r = utilization(units);
  assert.equal(r.denom, 5);
  assert.equal(r.onRent, 2);
  assert.equal(r.pct, 40);
  assert.equal(r.label, 'Building');
});

check('rounds to a whole percent, and the rounded value picks the band', () => {
  const mk = (on, total) => utilization([...Array(on)].map(() => U('ON-RENT')).concat([...Array(total - on)].map(() => U('AVAILABLE'))));
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
  assert.equal(utilization([]).pct, null);
  assert.equal(utilization([U('RETIRED'), U('AVAILABLE', 'LOANER')]).pct, null);
  assert.equal(utilization(undefined).label, '—');
});

check('ON-RENT never exceeds 100% even if a LOANER-status unit is marked ON-RENT', () => {
  const r = utilization([U('ON-RENT'), U('ON-RENT', 'LOANER')]);
  assert.equal(r.pct, 100);
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
