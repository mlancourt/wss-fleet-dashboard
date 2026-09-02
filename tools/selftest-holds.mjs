#!/usr/bin/env node
/** selftest-holds.mjs — Reservations v2 logic: statuses, overlaps, window validation, range text. */
import assert from 'node:assert/strict';
import { holdsOf, holdStatus, currentHold, futureHolds, findOverlaps, validateWindow, groupByDate } from '../docs/holds.js';
import { fmtRange, addBusinessDays } from '../docs/dates.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const H = (id, start, end, status) => ({ id, start, end, status, customer: id, held_by: 'Kevin' });
const TODAY = '2026-09-02';

console.log('holds self-test');

check('holdsOf: array, start-sorted, [] for v1 units', () => {
  assert.deepEqual(holdsOf({}), []);
  assert.deepEqual(holdsOf({ reservations: null }), []);
  const u = { reservations: [H('b', '2026-09-10', '2026-09-10'), H('a', '2026-09-03', '2026-09-04')] };
  assert.deepEqual(holdsOf(u).map((h) => h.id), ['a', 'b']);
});

check('holdStatus: engine status wins; fallback computes from strings only', () => {
  assert.equal(holdStatus(H('x', '2026-09-01', '2026-09-01', 'expired'), TODAY), 'expired');
  assert.equal(holdStatus(H('x', '2026-09-01', '2026-09-01'), TODAY), 'expired');
  assert.equal(holdStatus(H('x', '2026-09-02', '2026-09-02'), TODAY), 'current');
  assert.equal(holdStatus(H('x', '2026-09-01', '2026-09-05'), TODAY), 'current');
  assert.equal(holdStatus(H('x', '2026-09-03', '2026-09-03'), TODAY), 'future');
  assert.equal(holdStatus(H('x', '2026-09-05', '2026-09-03'), TODAY), 'malformed');
  assert.equal(holdStatus(H('x', 'soon', '2026-09-03'), TODAY), 'malformed');
  assert.equal(holdStatus(null, TODAY), 'malformed');
});

check('future holds never imply RESERVED — the list is a calendar, the chip is the state', () => {
  const u = { unit_state: 'AVAILABLE', reservations: [H('f1', '2026-09-08', '2026-09-08', 'future'), H('f2', '2026-09-10', '2026-09-12', 'future')] };
  assert.equal(currentHold(u, TODAY), null);
  assert.equal(futureHolds(u, TODAY).length, 2);
  assert.equal(u.unit_state, 'AVAILABLE');   // and nothing here changes that
});

check('findOverlaps: inclusive windows, malformed skipped', () => {
  const holds = [H('a', '2026-09-08', '2026-09-08', 'future'), H('b', '2026-09-10', '2026-09-12', 'future'), H('m', '2026-09-20', '2026-09-18', 'malformed')];
  assert.deepEqual(findOverlaps(holds, '2026-09-08', '2026-09-08').map((h) => h.id), ['a']);
  assert.deepEqual(findOverlaps(holds, '2026-09-09', '2026-09-09').map((h) => h.id), []);
  assert.deepEqual(findOverlaps(holds, '2026-09-07', '2026-09-10').map((h) => h.id), ['a', 'b']);
  assert.deepEqual(findOverlaps(holds, '2026-09-12', '2026-09-30').map((h) => h.id), ['b']);
  assert.deepEqual(findOverlaps(holds, 'junk', '2026-09-30'), []);
});

check('validateWindow: end >= start, end >= today, nothing else', () => {
  assert.equal(validateWindow('2026-09-08', '2026-09-08', TODAY), null);
  assert.equal(validateWindow('2026-09-01', '2026-09-02', TODAY), null);   // ends today: fine
  assert.match(validateWindow('2026-09-08', '2026-09-07', TODAY), /before/);
  assert.match(validateWindow('2026-08-20', '2026-08-25', TODAY), /past/);
  assert.match(validateWindow('', '2026-09-08', TODAY), /start/);
  assert.match(validateWindow('2026-09-08', '9/9', TODAY), /end/);
});

check('fmtRange: one-day vs window, year only when it changes', () => {
  assert.equal(fmtRange('2026-09-08', '2026-09-08'), 'Sep 8');
  assert.equal(fmtRange('2026-09-08', '2026-09-11'), 'Sep 8 – Sep 11');
  assert.equal(fmtRange('2026-12-30', '2027-01-02'), 'Dec 30 – Jan 2, 2027');
  assert.equal(fmtRange('2026-09-08', null), 'Sep 8');
  assert.equal(fmtRange(null, null), '');
});

check('end default = start + 5 business days, anchored on start (not today)', () => {
  assert.equal(addBusinessDays('2026-09-08', 5), '2026-09-15');   // Tue -> next Tue
  assert.equal(addBusinessDays('2026-09-11', 5), '2026-09-18');   // Fri -> Fri
});

check('groupByDate: chronological groups by start', () => {
  const g = groupByDate([H('b', '2026-09-10', '2026-09-10'), H('a', '2026-09-08', '2026-09-08'), H('c', '2026-09-08', '2026-09-09')]);
  assert.deepEqual(g.map((x) => [x.date, x.items.length]), [['2026-09-08', 2], ['2026-09-10', 1]]);
});

console.log(`\n${passed} checks passed`);
