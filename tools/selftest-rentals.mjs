#!/usr/bin/env node
/**
 * selftest-rentals.mjs — the D64 rental-lifecycle rules in docs/rentals.js.
 * Pure: no DOM, no network. Dates are pinned strings, never "today".
 */
import assert from 'node:assert/strict';
import {
  statusOf, outMove, inMove, rentalGroups, rentalActions, dueBackTone, outDatePassed, clampToToday,
  deliveryRow, returnRow, agreementForRow, pendingForAgreement, agreementHref, agreementByRoute, billsNow,
} from '../docs/rentals.js';
import { recurringRevenue } from '../docs/metrics.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
console.log('rentals self-test');

const TODAY = '2026-09-25';
const ag = (o) => ({ agreement: 4100, customer: 'Acme Foods', serial: '900100', cycle: '28D', cycle_rate: 500,
  cycles_billed: 1, cycles_max: null, alerts: [], ...o });

check('a legacy row (no status, no moves) reads ACTIVE, out on our truck, home on it', () => {
  const a = ag({});
  assert.equal(statusOf(a), 'ACTIVE');
  assert.equal(outMove(a), 'DELIVER');
  assert.equal(inMove(a), 'PICKUP');
  assert.equal(statusOf(ag({ status: 'SOMETHING-NEW' })), 'ACTIVE', 'an unknown status still draws somewhere');
});

check('groups: pending soonest out first, on rent longest first, off-rent oldest first', () => {
  const rows = [
    ag({ agreement: 'R1', status: 'PENDING', out_date: '2026-09-30' }),
    ag({ agreement: 'R2', status: 'PENDING', out_date: '2026-09-24' }),
    ag({ agreement: 'R3', status: 'PENDING', out_date: null }),
    ag({ agreement: 4101, status: 'ACTIVE', days_on_rent: 3 }),
    ag({ agreement: 4102, status: 'ACTIVE', days_on_rent: 200 }),
    ag({ agreement: 'R4', status: 'ACTIVE', days_on_rent: null }),
    ag({ agreement: 4103, status: 'OFF-RENT', off_rent: '2026-09-24' }),
    ag({ agreement: 'R5', status: 'OFF-RENT', off_rent: '2026-09-20' }),
  ];
  const g = rentalGroups(rows);
  assert.deepEqual(g.pending.map((a) => a.agreement), ['R2', 'R1', 'R3']);
  assert.deepEqual(g.active.map((a) => a.agreement), [4102, 4101, 'R4']);
  assert.deepEqual(g.offRent.map((a) => a.agreement), ['R5', 4103]);
});

check('a legacy file keeps the pre-D64 order: unbilled, then alerts, then customer', () => {
  const g = rentalGroups([
    ag({ agreement: 4101, customer: 'Zeta' }),
    ag({ agreement: 4102, customer: 'Alpha', alerts: ['split cycle'] }),
    ag({ agreement: null, customer: 'Mid' }),
    ag({ agreement: 'R092526A', customer: 'Beta' }),
  ]);
  assert.deepEqual(g.active.map((a) => a.agreement), [null, 4102, 'R092526A', 4101]);
  assert.equal(g.pending.length + g.offRent.length, 0);
});

check('the sort never mix-compares an int against a string (D59)', () => {
  // Same date, same everything: the tiebreak is the id, and it goes through String().
  const rows = [ag({ agreement: 4130, status: 'PENDING', out_date: TODAY }), ag({ agreement: 'R092526A', status: 'PENDING', out_date: TODAY })];
  assert.deepEqual(rentalGroups(rows).pending.map((a) => a.agreement), [4130, 'R092526A']);
});

check('role matrix: Went out / Off-rent / Back in shop (§3)', () => {
  const pendDel = ag({ status: 'PENDING', out_move: 'DELIVER' });
  const pendPu = ag({ status: 'PENDING', out_move: 'CUSTOMER-PICKUP' });
  const active = ag({ status: 'ACTIVE' });
  const offPu = ag({ status: 'OFF-RENT', in_move: 'PICKUP' });
  const offRet = ag({ status: 'OFF-RENT', in_move: 'CUSTOMER-RETURN' });
  const legacy = ag({});
  const none = { wentOut: false, offRent: false, backInShop: false };
  for (const role of ['sales', 'owner']) {
    assert.deepEqual(rentalActions(pendDel, role), none, 'a DELIVER tile has no button — the truck is the OUT');
    assert.deepEqual(rentalActions(pendPu, role), { ...none, wentOut: true });
    assert.deepEqual(rentalActions(active, role), { ...none, offRent: true });
    assert.deepEqual(rentalActions(legacy, role), { ...none, offRent: true }, 'legacy: Off-rent and nothing else');
    assert.deepEqual(rentalActions(offRet, role), { ...none, backInShop: true });
  }
  assert.deepEqual(rentalActions(offPu, 'sales'), none, 'sales waits for the truck');
  assert.deepEqual(rentalActions(offPu, 'owner'), { ...none, backInShop: true }, 'the owner override');
  for (const a of [pendDel, pendPu, active, offPu, offRet, legacy]) {
    assert.deepEqual(rentalActions(a, 'service'), none, 'service gets no rental buttons');
    assert.deepEqual(rentalActions(a, ''), none);
  }
  assert.deepEqual(rentalActions(ag({ agreement: null }), 'owner'), none, 'no id, nothing to name in the event');
});

check('due back: red once passed, amber today and tomorrow, quiet after', () => {
  assert.equal(dueBackTone('2026-09-24', TODAY), 'red');
  assert.equal(dueBackTone('2026-09-25', TODAY), 'amber');
  assert.equal(dueBackTone('2026-09-26', TODAY), 'amber');
  assert.equal(dueBackTone('2026-09-27', TODAY), '');
  assert.equal(dueBackTone('2026-10-01', '2026-09-30'), 'amber', 'across a month end');
  assert.equal(dueBackTone(null, TODAY), '');
  assert.equal(dueBackTone('soon', TODAY), '');
});

check('a PENDING rental past its out date is flagged; nothing else is', () => {
  assert.equal(outDatePassed(ag({ status: 'PENDING', out_date: '2026-09-24' }), TODAY), true);
  assert.equal(outDatePassed(ag({ status: 'PENDING', out_date: TODAY }), TODAY), false);
  assert.equal(outDatePassed(ag({ status: 'ACTIVE', out_date: '2026-09-01' }), TODAY), false);
  assert.equal(outDatePassed(ag({ status: 'PENDING', out_date: null }), TODAY), false);
});

check('a sheet date is capped at today; junk and the future go as null', () => {
  assert.equal(clampToToday(TODAY, TODAY), TODAY);
  assert.equal(clampToToday('2026-09-20', TODAY), '2026-09-20');
  assert.equal(clampToToday('2026-09-26', TODAY), null);
  assert.equal(clampToToday('', TODAY), null);
  assert.equal(clampToToday('9/25/2026', TODAY), null);
});

check('the delivery and return rows are found by id, and by agreement', () => {
  const dispatch = [
    { id: 'm-dl-R092826A', source: 'RENTAL-DELIVER', agreement: 'R092826A' },
    { id: 'm-pu-900128', source: 'RENTAL-RETURN', agreement: 4106, serial: '900128' },
    { id: 'm-pu-900555', source: 'RENTAL-RETURN', agreement: null, serial: '900555' },
  ];
  assert.equal(deliveryRow(ag({ agreement: 'R092826A' }), dispatch).id, 'm-dl-R092826A');
  assert.equal(deliveryRow(ag({ agreement: 'R1', delivery: { id: 'm-dl-R092826A' } }), dispatch).id, 'm-dl-R092826A');
  assert.equal(deliveryRow(ag({ agreement: 'R9' }), dispatch), null);
  assert.equal(returnRow(ag({ agreement: 4106, serial: 'other' }), dispatch).id, 'm-pu-900128');
  assert.equal(returnRow(ag({ agreement: 4999, serial: '900555' }), dispatch).id, 'm-pu-900555', 'legacy row: by serial');
  assert.equal(returnRow(ag({ agreement: '4106', serial: 'x' }), dispatch), null, 'never coerced: "4106" is not 4106');
  assert.equal(agreementForRow(dispatch[0], [ag({ agreement: 'R092826A', lead: 'L1008' })]).lead, 'L1008');
  assert.equal(agreementForRow(dispatch[2], [ag({})]), null);
});

check('pending rental events match on payload.agreement, strictly', () => {
  const pending = [
    { action: 'rental_update', payload: { agreement: 'R092526A', action: 'OFF-RENT' } },
    { action: 'rental_update', payload: { agreement: 4211, action: 'IN' } },
    { action: 'dispatch_done', payload: { dispatch_id: 'm-dl-R092526A' } },
  ];
  assert.equal(pendingForAgreement(pending, 'R092526A').length, 1);
  assert.equal(pendingForAgreement(pending, 4211).length, 1);
  assert.equal(pendingForAgreement(pending, '4211').length, 0);
  assert.equal(pendingForAgreement(pending, null).length, 0);
});

check('the agreement route round-trips an int and a string id', () => {
  const rows = [ag({ agreement: 4130 }), ag({ agreement: 'R092526A' }), ag({ agreement: null })];
  assert.equal(agreementHref('R092526A'), '#/agreement/R092526A');
  assert.equal(agreementHref(4130), '#/agreement/4130');
  assert.equal(agreementByRoute(rows, '4130').agreement, 4130);
  assert.equal(agreementByRoute(rows, 'R092526A').agreement, 'R092526A');
  assert.equal(agreementByRoute(rows, 'null'), null, 'the unbilled orphan has no page');
});

check('D21 sums ACTIVE + OFF-RENT (and legacy), never PENDING', () => {
  const rows = [
    ag({ cycle_rate: 100 }),                                           // legacy
    ag({ cycle_rate: 200, status: 'ACTIVE' }),
    ag({ cycle_rate: 400, status: 'OFF-RENT', cycles_billed: 2, cycles_max: 3 }),
    ag({ cycle_rate: 800, status: 'PENDING', cycles_billed: 0 }),
    ag({ cycle_rate: 1600, status: 'SOMETHING-NEW' }),
  ];
  assert.equal(billsNow(rows[3]), false);
  assert.equal(recurringRevenue(rows).total, 700);
  assert.equal(recurringRevenue(rows).count, 3);
  // D7: an OFF-RENT row capped at what it billed has stopped recurring.
  assert.equal(recurringRevenue([ag({ status: 'OFF-RENT', cycles_billed: 3, cycles_max: 3 })]).total, 0);
});

console.log(`\n${passed} checks passed.`);
