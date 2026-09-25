#!/usr/bin/env node
/**
 * selftest-workorders.mjs — the D65 work-order rules in docs/workorders.js.
 * Pure: no DOM, no network. Dates are pinned strings, never "today".
 */
import assert from 'node:assert/strict';
import {
  workOrdersOf, woById, stripGroups, openPartCount, requestedTone, lineTone, trackingUrl,
  fmtHours, hoursValid, woChipText, defaultPurpose, manufacturerFor, vendorFor, partActions,
  closeShown, closeEnabled, cancelShown, pendingOpens, pendingOpenFor, pendingForWo, describeWoEvent,
} from '../docs/workorders.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
console.log('work-orders self-test');

const part = (line, state, o = {}) => ({ line, manufacturer: 'FACTORY-CAT', part_number: `P-${line}`, description: null, qty: 1,
  state, ordered: null, vendor: null, vendor_ref: null, tracking: null, carrier: null, delivered: null, source: 'VENDOR', ...o });
const wo = (id, o = {}) => ({ id, serial: '900100', asset_item: 'A-1001', ticket: null, status: 'OPEN', purpose: 'REPAIR',
  opened: '2026-09-20', opened_by: 'Josh', closed: null, age_days: 1, note: null, parts: [], labor: [],
  parts_open: 0, hours_total: 0, log: [], ...o });

const LIST = [
  wo('W1001', { age_days: 1, parts: [
    part(1, 'REQUESTED'),
    part(2, 'ORDERED', { ordered: '2026-09-23' }),
    part(3, 'IN-TRANSIT', { ordered: '2026-09-22', tracking: '1Z999AA10123456784', carrier: 'UPS' }),
    part(4, 'CANCELLED'),
  ] }),
  wo('W1003', { age_days: 8, parts: [part(1, 'REQUESTED'), part(2, 'ORDERED', { ordered: '2026-09-18' })] }),
  wo('W1004', { status: 'CLOSED', age_days: null, closed: '2026-09-19', parts: [
    part(1, 'DELIVERED', { ordered: '2026-09-10', delivered: '2026-09-15' }),
  ] }),
  wo('W1002', { parts: [part(1, 'DELIVERED', { delivered: '2026-09-21' })] }),
];

check('a pre-D65 snapshot has no work orders — an empty list, never a throw', () => {
  assert.deepEqual(workOrdersOf({}), []);
  assert.deepEqual(workOrdersOf(null), []);
  assert.deepEqual(workOrdersOf({ work_orders: 'nope' }), []);
  assert.equal(woById(workOrdersOf({ work_orders: LIST }), 'W1003').age_days, 8);
  assert.equal(woById([], 'W1001'), null);
});

check('strip groups: Ordered · In transit · Requested (oldest first), Delivered newest first; CANCELLED nowhere', () => {
  const g = stripGroups(LIST);
  const ids = (rows) => rows.map((r) => `${r.wo.id}/${r.part.line}`);
  assert.deepEqual(ids(g.ordered), ['W1003/2', 'W1001/2'], 'oldest order first');
  assert.deepEqual(ids(g.inTransit), ['W1001/3']);
  assert.deepEqual(ids(g.requested), ['W1003/1', 'W1001/1'], 'the oldest work order first');
  assert.deepEqual(ids(g.delivered), ['W1002/1', 'W1004/1'], 'newest delivery first, closed ones included');
  const all = [...g.ordered, ...g.inTransit, ...g.requested, ...g.delivered];
  assert.ok(!all.some((r) => r.part.state === 'CANCELLED'));
});

check('pill = the engine summary (requested + ordered + in transit); counted from rows only without one', () => {
  assert.equal(openPartCount({ parts_requested: 4, parts_ordered: 1, parts_in_transit: 2, delivered_30d: 9 }, LIST), 7, 'summary wins');
  assert.equal(openPartCount(null, LIST), 5, 'fallback: 2 ordered + 1 in transit + 2 requested');
  assert.equal(openPartCount({ parts_requested: 1 }, LIST), 5, 'a half summary is no summary');
  assert.equal(openPartCount(null, []), 0);
});

check('tone: amber at 3 days on a REQUESTED line, red at 7 — engine ages, never subtracted here', () => {
  const at = (age) => [wo('W1', { age_days: age, parts: [part(1, 'REQUESTED')] })];
  assert.equal(requestedTone(at(2), 3, 7), '');
  assert.equal(requestedTone(at(3), 3, 7), 'amber');
  assert.equal(requestedTone(at(6), 3, 7), 'amber');
  assert.equal(requestedTone(at(7), 3, 7), 'red');
  assert.equal(requestedTone(LIST, 3, 7), 'red', 'W1003 is 8 days old with a REQUESTED line');
  // An old work order whose lines are all ORDERED is Matt chasing a vendor, not a stall.
  assert.equal(requestedTone([wo('W1', { age_days: 30, parts: [part(1, 'ORDERED')] })], 3, 7), '');
  assert.equal(requestedTone([wo('W1', { age_days: null, parts: [part(1, 'REQUESTED')] })], 3, 7), '');
  assert.equal(lineTone(LIST[1], LIST[1].parts[0], 3, 7), 'red');
  assert.equal(lineTone(LIST[1], LIST[1].parts[1], 3, 7), '', 'an ORDERED line is never toned');
});

check('tracking links only for a detected carrier; the carrier word is dropped from the number', () => {
  assert.equal(trackingUrl('UPS', '1Z999AA10123456784'), 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.equal(trackingUrl('UPS', 'UPS 1Z999 AA10123456784'), 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.ok(trackingUrl('FEDEX', '771234567890').startsWith('https://www.fedex.com/'));
  assert.ok(trackingUrl('USPS', '9400111899223856924218').startsWith('https://tools.usps.com/'));
  assert.equal(trackingUrl(null, 'LTL PRO 48213377'), null, 'no carrier, no link');
  assert.equal(trackingUrl('DHL', '123'), null, 'a carrier outside the enum is plain text');
  assert.equal(trackingUrl('UPS', ''), null);
  assert.equal(trackingUrl('UPS', '1Z<script>'), 'https://www.ups.com/track?tracknum=1Z%3Cscript%3E', 'encoded');
});

check('hours: 0.25–12 in quarter steps; formatted without trailing zeros', () => {
  for (const h of [0.25, 0.5, 1, 1.5, 7.75, 12]) assert.ok(hoursValid(h), `${h}`);
  for (const h of [0, 0.2, 1.3, 12.25, 13, NaN, '1']) assert.ok(!hoursValid(h), `${h}`);
  assert.equal(fmtHours(2.5), '2.5');
  assert.equal(fmtHours(3), '3');
  assert.equal(fmtHours(0.75), '0.75');
  assert.equal(fmtHours(null), '0');
});

check('the unit chip: "W1001 · 2 parts open · 3.5 h", engine counts only', () => {
  assert.equal(woChipText(wo('W1001', { parts_open: 2, hours_total: 3.5 })), 'W1001 · 2 parts open · 3.5 h');
  assert.equal(woChipText(wo('W1002', { parts_open: 1, hours_total: 0 })), 'W1002 · 1 part open · 0 h');
  assert.equal(woChipText(null, { work_order: 'W1009', wo_parts_open: 3 }), 'W1009 · 3 parts open', 'unit keys when the row is missing');
});

check('OPEN defaults: rent-ready for a unit in prep, else repair; the make from the brand; vendor from the make', () => {
  assert.equal(defaultPurpose({ readiness: 'NEEDS-PREP' }), 'RENT-READY');
  assert.equal(defaultPurpose({ readiness: 'DOWN' }), 'REPAIR');
  assert.equal(defaultPurpose({ readiness: 'READY' }), 'REPAIR');
  assert.equal(manufacturerFor('Factory Cat'), 'FACTORY-CAT');
  assert.equal(manufacturerFor('FACTORY CAT'), 'FACTORY-CAT');
  assert.equal(manufacturerFor('IPC Eagle'), 'IPC-EAGLE');
  assert.equal(manufacturerFor('Tennant'), 'TENNANT');
  assert.equal(manufacturerFor('Halstead'), 'OTHER');
  assert.equal(manufacturerFor(null), 'OTHER');
  assert.equal(vendorFor('FACTORY-CAT'), 'RPS');
  assert.equal(vendorFor('KODIAK'), 'RPS');
  assert.equal(vendorFor('NILFISK'), 'NILFISK');
  assert.equal(vendorFor('OTHER'), 'OTHER');
});

check('line buttons by role × state (§5 table)', () => {
  const w = wo('W1', { opened_by: 'Josh' });
  const acts = (state, role, me = 'Someone') => partActions(w, part(1, state), role, me);
  assert.deepEqual(acts('REQUESTED', 'owner'), ['ORDERED', 'CANCELLED']);
  assert.deepEqual(acts('REQUESTED', 'service', 'Josh'), ['CANCELLED'], 'own work order');
  assert.deepEqual(acts('REQUESTED', 'service', 'Zac'), [], 'not his');
  assert.deepEqual(acts('REQUESTED', 'sales'), []);
  assert.deepEqual(acts('ORDERED', 'owner'), ['IN-TRANSIT', 'DELIVERED']);
  assert.deepEqual(acts('ORDERED', 'service'), ['IN-TRANSIT', 'DELIVERED']);
  assert.deepEqual(acts('ORDERED', 'sales'), []);
  assert.deepEqual(acts('IN-TRANSIT', 'service'), ['DELIVERED']);
  assert.deepEqual(acts('DELIVERED', 'owner'), []);
  assert.deepEqual(acts('CANCELLED', 'owner'), []);
  assert.ok(!acts('REQUESTED', 'service', 'Josh').includes('ORDERED'), 'service is never offered Mark ordered');
  assert.deepEqual(partActions(wo('W1', { status: 'CLOSED' }), part(1, 'ORDERED'), 'owner', 'Matt'), [], 'nothing on a closed one');
});

check('Close: owner only, enabled once every line is DELIVERED or CANCELLED; Cancel: owner or the opener pre-order', () => {
  const open = wo('W1', { parts: [part(1, 'DELIVERED'), part(2, 'IN-TRANSIT')] });
  const done = wo('W2', { parts: [part(1, 'DELIVERED'), part(2, 'CANCELLED')] });
  const labor = wo('W3', { parts: [] });
  assert.ok(closeShown(open, 'owner') && !closeShown(open, 'service') && !closeShown(open, 'sales'));
  assert.ok(!closeEnabled(open), 'a line in transit holds it open');
  assert.ok(closeEnabled(done) && closeEnabled(labor), 'settled lines, or none');
  assert.ok(!closeShown(wo('W4', { status: 'CLOSED' }), 'owner'));
  const fresh = wo('W5', { opened_by: 'Josh', parts: [part(1, 'REQUESTED')] });
  assert.ok(cancelShown(fresh, 'owner', 'Matt'));
  assert.ok(cancelShown(fresh, 'service', 'Josh'), 'the opener, nothing ordered yet');
  assert.ok(!cancelShown(fresh, 'service', 'Zac'));
  assert.ok(!cancelShown(open, 'service', 'Josh'), 'once a line has moved it is Matt\'s');
});

check('pending: OPEN keyed on serial (no id), the rest on payload.work_order', () => {
  const P = [
    { id: 'e1', action: 'work_order', serial: '900100', payload: { action: 'OPEN', purpose: 'PM', parts: [] } },
    { id: 'e2', action: 'work_order', serial: null, payload: { action: 'LABOR', work_order: 'W1001', who: 'Zac', hours: 1.5 } },
    { id: 'e3', action: 'work_order', serial: null, payload: { action: 'PART-STATE', work_order: 'W1001', line: 2, state: 'DELIVERED' } },
    { id: 'e4', action: 'readiness', serial: '900100', payload: { readiness: 'READY' } },
  ];
  assert.deepEqual(pendingOpens(P).map((e) => e.id), ['e1']);
  assert.deepEqual(pendingOpenFor(P, 900100).map((e) => e.id), ['e1'], 'serial compared as text');
  assert.deepEqual(pendingOpenFor(P, '900107'), []);
  assert.deepEqual(pendingForWo(P, 'W1001').map((e) => e.id), ['e2', 'e3']);
  assert.deepEqual(pendingForWo(P, 'W1002'), []);
  assert.equal(describeWoEvent(P[0]), 'new work order — labor only');
  assert.equal(describeWoEvent(P[1]), '1.5 h logged for Zac');
  assert.equal(describeWoEvent(P[2]), 'line 2 → Delivered');
});

check('no money: nothing this module returns carries a figure or a money key', () => {
  const out = JSON.stringify([stripGroups(LIST), woChipText(LIST[0]), LIST.map((w) => partActions(w, w.parts[0], 'owner', 'Matt'))]);
  assert.ok(!/\$\s?\d/.test(out));
  assert.ok(!/"(cost|rate|price)"/.test(out));
});

console.log(`${passed} checks passed.`);
