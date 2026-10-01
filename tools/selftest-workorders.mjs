#!/usr/bin/env node
/**
 * selftest-workorders.mjs — the D65 / D68 / D69 work-order rules in docs/workorders.js.
 * Pure: no DOM, no network. Dates are pinned strings, never "today".
 */
import assert from 'node:assert/strict';
import {
  workOrdersOf, woById, stripGroups, openPartCount, requestedTone, lineTone, trackingUrl,
  fmtHours, hoursValid, woChipText, defaultPurpose, manufacturerFor, vendorFor, partActions,
  closeShown, closeEnabled, cancelShown, pendingOpens, pendingOpenFor, pendingForWo, describeWoEvent,
  isStockLine, sourceOf, pendingLineLabel, PART_VERB_LABEL,
  PURPOSES, PURPOSE_LABEL, closeBlocker, readyOffered, stripCounts, stripTone, openWorkOrders, pendingBySerial, byTs,
  DELIVERED_DAYS, trackerGroups, trackerCounts, inspectTone, unitHistory, historyCaption, laborWho, laborKindOf, travelHours, laborPayloads, laborProblem, stepperValid,
  customerOrders, orderCounts, pipelineOrderChip, orderOf, ORDER_VENDORS, VENDORS,
} from '../docs/workorders.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
console.log('work-orders self-test');

const part = (line, state, o = {}) => ({ line, manufacturer: 'FACTORY-CAT', part_number: `P-${line}`, description: null, qty: 1,
  state, ordered: null, vendor: null, vendor_ref: null, tracking: null, carrier: null, delivered: null, source: 'VENDOR', ...o });
const wo = (id, o = {}) => ({ id, serial: '900100', asset_item: 'A-1001', ticket: null, status: 'OPEN', purpose: 'REPAIR',
  opened: '2026-09-20', opened_by: 'Josh', closed: null, age_days: 1, note: null, parts: [], labor: [],
  inspection: { status: 'DONE', flags: 0 }, parts_open: 0, hours_total: 0, log: [], ...o });

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

check('D69 unit chip: "W1003 · RETURN · 📋 pending · 2 parts open · 1.5 h", engine counts only', () => {
  assert.equal(woChipText(wo('W1003', { purpose: 'RETURN', inspection: { status: 'PENDING' }, parts_open: 2, hours_total: 1.5 })),
    'W1003 · RETURN · 📋 pending · 2 parts open · 1.5 h');
  assert.equal(woChipText(wo('W1002', { purpose: 'PM', inspection: { status: 'DONE', flags: 2 }, parts_open: 1, hours_total: 0 })),
    'W1002 · PM · 📋 ✓ 2 ⚑ · 1 part open · 0 h');
  assert.equal(woChipText(wo('W1004', { inspection: { status: 'SKIPPED', skipped_reason: 'x' } })), 'W1004 · REPAIR · 📋 skipped · 0 parts open · 0 h');
  assert.equal(woChipText(null, { work_order: 'W1009', wo_parts_open: 3, wo_inspection: 'PENDING' }), 'W1009 · 📋 pending · 3 parts open', 'unit keys when the row is missing');
  assert.equal(woChipText(null, { work_order: 'W1009', wo_parts_open: 3 }), 'W1009 · 3 parts open', 'a pre-D69 unit');
  assert.equal(woChipText(wo('W1', { inspection: 'I1001' })), 'W1 · REPAIR · 📋 pending · 0 parts open · 0 h', 'a legacy string sheet reads pending');
});

check('D69 purposes: the five, D67 kinds folded in; a legacy RENT-READY still has a label', () => {
  assert.deepEqual(PURPOSES, ['CHECKOUT', 'RETURN', 'PM', 'REPAIR', 'OTHER']);
  assert.equal(PURPOSE_LABEL.CHECKOUT, 'Check-out');
  assert.equal(PURPOSE_LABEL['RENT-READY'], 'Rent-ready');
});

check('OPEN defaults (D69 §2, the engine\'s): NEEDS-PREP → RETURN · DOWN / ON-RENT → REPAIR · READY → CHECKOUT · else PM', () => {
  assert.equal(defaultPurpose({ readiness: 'NEEDS-PREP', unit_state: 'IN-SHOP' }), 'RETURN');
  assert.equal(defaultPurpose({ readiness: 'DOWN', unit_state: 'IN-SHOP' }), 'REPAIR');
  assert.equal(defaultPurpose({ readiness: 'READY', unit_state: 'ON-RENT' }), 'REPAIR', 'out on rent beats READY');
  assert.equal(defaultPurpose({ readiness: 'READY', unit_state: 'AVAILABLE' }), 'CHECKOUT');
  assert.equal(defaultPurpose({ readiness: 'NEEDS-PICKUP', unit_state: 'ON-DEMO' }), 'PM');
  assert.equal(defaultPurpose(null), 'PM');
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

check('line buttons by role × state (D68 §3 table)', () => {
  const w = wo('W1', { opened_by: 'Josh' });
  const acts = (state, role, me = 'Someone') => partActions(w, part(1, state), role, me);
  assert.deepEqual(acts('REQUESTED', 'owner'), ['ORDERED', 'SHOP-STOCK', 'CANCELLED']);
  assert.deepEqual(acts('REQUESTED', 'service', 'Josh'), ['SHOP-STOCK', 'CANCELLED'], 'own work order');
  assert.deepEqual(acts('REQUESTED', 'service', 'Zac'), ['SHOP-STOCK'], 'not his — but the shelf is anyone on the bench');
  assert.equal(PART_VERB_LABEL['SHOP-STOCK'], 'Use from stock');
  for (const st of ['ORDERED', 'IN-TRANSIT', 'DELIVERED', 'CANCELLED']) {
    for (const r of ['owner', 'service', 'sales']) assert.ok(!acts(st, r, 'Josh').includes('SHOP-STOCK'), `${st}/${r}: already on order or settled — no stock pull`);
  }
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

check('D69 Close: lines settled AND the sheet DONE or SKIPPED — the blocker says which; Mark READY only at home', () => {
  const settled = [part(1, 'DELIVERED'), part(2, 'CANCELLED')];
  assert.equal(closeBlocker(wo('W1', { parts: settled })), null);
  assert.equal(closeBlocker(wo('W1', { parts: settled, inspection: { status: 'SKIPPED' } })), null);
  const sheet = closeBlocker(wo('W1', { parts: settled, inspection: { status: 'PENDING' } }));
  assert.ok(/inspection is still pending/.test(sheet) && !/part line/.test(sheet), sheet);
  const line = closeBlocker(wo('W1', { parts: [part(1, 'ORDERED')] }));
  assert.ok(/1 part line still open/.test(line) && !/inspection/.test(line), line);
  const both = closeBlocker(wo('W1', { parts: [part(1, 'REQUESTED'), part(2, 'IN-TRANSIT')], inspection: { status: 'PENDING' } }));
  assert.ok(/2 part lines still open/.test(both) && /inspection is still pending/.test(both), both);
  assert.ok(!closeEnabled(wo('W1', { inspection: 'I1001' })), 'a legacy string sheet is PENDING — holds Close');
  assert.ok(!closeEnabled(wo('W1', { inspection: null })));
  assert.equal(closeBlocker(wo('W1', { status: 'CLOSED', inspection: { status: 'PENDING' } })), null, 'nothing to close');
  for (const st of ['AVAILABLE', 'RESERVED', 'IN-SHOP']) assert.ok(readyOffered({ unit_state: st }), st);
  for (const st of ['ON-RENT', 'ON-DEMO', 'LOANER-OUT']) assert.ok(!readyOffered({ unit_state: st }), st);
  assert.ok(!readyOffered(null));
});

check('D69 strip: "N open · M inspection pending · K parts open"; amber from a stale PENDING sheet, red only from parts', () => {
  const list = [
    wo('W1', { age_days: 1, inspection: { status: 'PENDING' }, parts: [part(1, 'ORDERED')] }),
    wo('W2', { age_days: 5, inspection: { status: 'DONE', flags: 1 } }),
    wo('W3', { status: 'CLOSED', age_days: null, inspection: { status: 'DONE' } }),
  ];
  assert.deepEqual(stripCounts({ open: 2, inspections_pending: 1, parts_requested: 0, parts_ordered: 1, parts_in_transit: 0 }, list),
    { open: 2, pending: 1, parts: 1 }, 'the engine summary');
  assert.deepEqual(stripCounts(null, list), { open: 2, pending: 1, parts: 1 }, 'counted from rows');
  const T = { partsAmber: 3, partsRed: 7, inspectAmber: 2 };
  assert.equal(stripTone(null, list, T), '', 'a PENDING sheet one day old');
  const stale = [wo('W1', { age_days: 2, inspection: { status: 'PENDING' } })];
  assert.equal(stripTone({ inspections_pending: 1 }, stale, T), 'amber', 'two days PENDING');
  assert.equal(stripTone({ inspections_pending: 0 }, stale, T), '', 'the summary says none pending');
  assert.equal(stripTone(null, [wo('W1', { age_days: 9, inspection: { status: 'SKIPPED' } })], T), '', 'a skipped sheet is settled');
  assert.equal(stripTone(null, [wo('W1', { age_days: 3, parts: [part(1, 'REQUESTED')] })], T), 'amber', 'the D65 parts rule');
  assert.equal(stripTone(null, [wo('W1', { age_days: 8, inspection: { status: 'PENDING' }, parts: [part(1, 'REQUESTED')] })], T), 'red', 'parts red wins');
  assert.deepEqual(openWorkOrders(list).map((w) => w.id), ['W2', 'W1'], 'OPEN only, oldest first');
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
  assert.equal(describeWoEvent(P[0]), 'new PM work order');
  assert.equal(describeWoEvent(P[1]), '1.5 h logged for Zac');
  assert.equal(describeWoEvent(P[2]), 'line 2 → Delivered');
});

check('D69: every verb but OPEN may be keyed on the serial — pendingBySerial finds them; INSPECT reads in English', () => {
  const P = [
    { id: 'e1', ts: '2026-09-27T10:00:00Z', action: 'work_order', serial: '153928', payload: { action: 'OPEN', purpose: 'RETURN', parts: [] } },
    { id: 'e3', ts: '2026-09-27T10:02:00Z', action: 'work_order', serial: '153928', payload: { action: 'INSPECT', step: 'DONE', tech: 'Zac' } },
    { id: 'e2', ts: '2026-09-27T10:01:00Z', action: 'work_order', serial: '153928', payload: { action: 'INSPECT', step: 'SAVE', readings: { hours_key: 41 } } },
    { id: 'e4', ts: '2026-09-27T10:03:00Z', action: 'work_order', serial: null, payload: { action: 'INSPECT', step: 'SAVE', work_order: 'W1003', comments: 'x' } },
    { id: 'e5', ts: '2026-09-27T10:04:00Z', action: 'work_order', serial: '153928', payload: { action: 'LABOR', who: 'Zac', hours: 1.5 } },
  ];
  assert.deepEqual(pendingBySerial(P, '153928').sort(byTs).map((e) => e.id), ['e2', 'e3', 'e5'], 'not the OPEN, not the W-keyed one');
  assert.deepEqual(pendingBySerial(P, 153928).map((e) => e.id).length, 3, 'serial compared as text');
  assert.deepEqual(pendingForWo(P, 'W1003').map((e) => e.id), ['e4']);
  assert.equal(describeWoEvent(P[0]), 'new Return work order');
  assert.equal(describeWoEvent(P[2]), 'sheet saved — readings');
  assert.equal(describeWoEvent(P[1]), 'sheet done (Zac)');
  assert.equal(describeWoEvent({ action: 'work_order', payload: { action: 'INSPECT', step: 'SKIP', reason: 'gasket only' } }), 'no inspection — gasket only');
  assert.equal(describeWoEvent({ action: 'work_order', payload: { action: 'INSPECT', step: 'REOPEN' } }), 'sheet reopened');
  assert.equal(describeWoEvent({ action: 'work_order', payload: { action: 'CLOSE', work_order: 'W1', ready: false } }), 'close (readiness left alone)');
});

check('D68: source is a fact about the part — stock lines are DELIVERED, land in Delivered, never block Close', () => {
  const stock = part(2, 'DELIVERED', { source: 'SHOP-STOCK', delivered: '2026-09-25' });
  assert.equal(sourceOf(part(1, 'REQUESTED', { source: undefined })), 'VENDOR', 'legacy line = VENDOR');
  assert.equal(sourceOf(part(1, 'REQUESTED', { source: 'WARRANTY' })), 'WARRANTY');
  assert.equal(sourceOf(stock), 'SHOP-STOCK');
  assert.ok(isStockLine(stock));
  assert.ok(!isStockLine(part(1, 'DELIVERED')), 'a vendor delivery is not stock');
  assert.ok(!isStockLine(part(1, 'CANCELLED', { source: 'SHOP-STOCK' })), 'a cancelled line reads cancelled');
  const w = wo('W9', { parts: [part(1, 'ORDERED', { ordered: '2026-09-24' }), stock] });
  const g = stripGroups([w]);
  assert.deepEqual(g.delivered.map((r) => r.part.line), [2], 'the stock line is in Delivered');
  assert.ok(![...g.ordered, ...g.inTransit, ...g.requested].some((r) => r.part.line === 2), 'and never Ordered / In transit / Requested');
  assert.equal(openPartCount(null, [w]), 1, 'not counted open');
  assert.ok(closeEnabled(wo('W9', { parts: [stock, part(3, 'CANCELLED')] })), 'stock lines never hold Close');
  assert.ok(!closeEnabled(w), 'the vendor line still does');
  const pull = { id: 'e9', action: 'work_order', serial: null, payload: { action: 'PART-STATE', work_order: 'W9', line: 1, source: 'SHOP-STOCK', note: null } };
  assert.equal(pendingLineLabel(pull.payload), 'from stock');
  assert.equal(describeWoEvent(pull), 'line 1 → from stock');
  assert.equal(describeWoEvent({ action: 'work_order', payload: { action: 'ADD-PARTS', work_order: 'W9',
    parts: [{ part_number: 'a', qty: 1, source: 'SHOP-STOCK' }, { part_number: 'b', qty: 1 }] } }), '2 parts added (1 from stock)');
});

check('no money: nothing this module returns carries a figure or a money key', () => {
  const out = JSON.stringify([stripGroups(LIST), woChipText(LIST[0]), LIST.map((w) => partActions(w, w.parts[0], 'owner', 'Matt'))]);
  assert.ok(!/\$\s?\d/.test(out));
  assert.ok(!/"(cost|rate|price)"/.test(out));
});

/* ------------------------------------------------ D70: service history */

check('D70: Delivered (30d) is 30 days of boxes — a 40-day line is out, a pre-D70 line (no key) is in', () => {
  assert.equal(DELIVERED_DAYS, 30);
  const list = [
    wo('W2001', { status: 'CLOSED', closed: '2026-08-19', parts: [part(1, 'DELIVERED', { delivered: '2026-08-19', delivered_age_days: 40 })] }),
    wo('W2002', { parts: [part(1, 'DELIVERED', { delivered: '2026-09-25', delivered_age_days: 3 })] }),
    wo('W2003', { status: 'CLOSED', parts: [part(1, 'DELIVERED', { delivered: '2026-08-29', delivered_age_days: 30 })] }),
    wo('W2004', { parts: [part(1, 'DELIVERED', { delivered: '2026-09-01' })] }),   // pre-D70: no key → 0
  ];
  assert.deepEqual(stripGroups(list).delivered.map((r) => r.wo.id), ['W2002', 'W2004', 'W2003']);
});

/* ------------------------------------------------ D75: the Parts tracker */

check('D75: trackerGroups — one group per work order; Active oldest first with its delivered lines inside; all-delivered → Delivered', () => {
  const list = [
    wo('W3001', { age_days: 2, parts: [
      part(3, 'DELIVERED', { delivered: '2026-09-27', delivered_age_days: 2 }),
      part(1, 'ORDERED', { ordered: '2026-09-27' }),
      part(2, 'IN-TRANSIT', { ordered: '2026-09-26', tracking: '1Z999AA10123456784', carrier: 'UPS' }),
      part(4, 'CANCELLED'),
    ] }),
    wo('W3002', { age_days: 9, parts: [part(1, 'REQUESTED')] }),
    wo('W3003', { age_days: 9, parts: [part(1, 'ORDERED', { ordered: '2026-09-21' })] }),                    // tie on age → id asc
    wo('W3004', { status: 'CLOSED', age_days: null, closed: '2026-09-25', parts: [
      part(1, 'DELIVERED', { delivered: '2026-09-24', delivered_age_days: 5 }),
    ] }),
    wo('W3005', { status: 'CLOSED', age_days: null, parts: [
      part(1, 'DELIVERED', { delivered: '2026-08-29', delivered_age_days: 31 }),                               // 31 days → no group
    ] }),
    wo('W3006', { parts: [part(1, 'DELIVERED', { delivered: '2026-09-28', delivered_age_days: 1 }), part(2, 'CANCELLED')] }),
    wo('W3007', { parts: [part(1, 'CANCELLED')] }),                                                             // only cancelled → no group
    wo('W3008', { status: 'CLOSED', age_days: null, parts: [part(1, 'ORDERED')] }),                           // a CLOSED WO is never Active
  ];
  const g = trackerGroups(list, 3, 7);
  assert.deepEqual(g.active.map((x) => x.wo.id), ['W3002', 'W3003', 'W3001'], 'oldest age first, id asc on a tie');
  const mixed = g.active.find((x) => x.wo.id === 'W3001');
  assert.deepEqual(mixed.lines.map((p) => p.line), [1, 2, 3], 'line asc; the delivered line rides inside; CANCELLED never');
  assert.deepEqual(mixed.counts, { requested: 0, ordered: 1, inTransit: 1, delivered: 1 });
  assert.deepEqual(g.delivered.map((x) => x.wo.id), ['W3006', 'W3004'], 'all-delivered groups, newest delivery first; CLOSED allowed');
  assert.equal(g.delivered[1].newestDelivered, '2026-09-24');
  assert.deepEqual(g.delivered[0].counts, { requested: 0, ordered: 0, inTransit: 0, delivered: 1 }, 'the cancelled line is not counted');
  const all = [...g.active, ...g.delivered].map((x) => x.wo.id);
  for (const id of ['W3005', 'W3007', 'W3008']) assert.ok(!all.includes(id), `${id} has no group`);
  assert.ok(![...g.active, ...g.delivered].some((x) => x.lines.some((p) => p.state === 'CANCELLED')), 'CANCELLED never in a group');
});

check('D75: worstTone — the worst lineTone among open lines (red beats amber); none without thresholds', () => {
  const list = [
    wo('W4001', { age_days: 4, parts: [part(1, 'REQUESTED'), part(2, 'ORDERED')] }),
    wo('W4002', { age_days: 8, parts: [part(1, 'ORDERED'), part(2, 'REQUESTED')] }),
    wo('W4003', { age_days: 20, parts: [part(1, 'ORDERED'), part(2, 'IN-TRANSIT')] }),     // an ordered part is never late
  ];
  const tone = Object.fromEntries(trackerGroups(list, 3, 7).active.map((x) => [x.wo.id, x.worstTone]));
  assert.deepEqual(tone, { W4001: 'amber', W4002: 'red', W4003: '' });
  assert.ok(trackerGroups(list).active.every((x) => x.worstTone === ''), 'no thresholds → no tone');
  assert.deepEqual(trackerGroups([]), { active: [], delivered: [] });
  assert.deepEqual(trackerGroups(null), { active: [], delivered: [] });
});

check('D75: trackerCounts — open lines on non-CLOSED work orders only', () => {
  const list = [
    wo('W5001', { parts: [part(1, 'REQUESTED'), part(2, 'ORDERED'), part(3, 'IN-TRANSIT'), part(4, 'IN-TRANSIT'), part(5, 'DELIVERED'), part(6, 'CANCELLED')] }),
    wo('W5002', { status: 'CLOSED', age_days: null, parts: [part(1, 'REQUESTED'), part(2, 'ORDERED')] }),
  ];
  assert.deepEqual(trackerCounts(list), { requested: 1, ordered: 1, inTransit: 2 });
  assert.deepEqual(trackerCounts([]), { requested: 0, ordered: 0, inTransit: 0 });
});

check('D75: the Work orders strip tones by the inspection rule alone — a stale REQUESTED line no longer reaches it', () => {
  assert.equal(inspectTone(null, [wo('W1', { age_days: 9, parts: [part(1, 'REQUESTED')] })], 2), '', 'parts never tone it');
  assert.equal(inspectTone(null, [wo('W1', { age_days: 2, inspection: { status: 'PENDING' } })], 2), 'amber');
  assert.equal(inspectTone({ inspections_pending: 0 }, [wo('W1', { age_days: 5, inspection: { status: 'PENDING' } })], 2), '');
});

check('D75: no money in anything the tracker helpers return', () => {
  const out = JSON.stringify([trackerGroups(LIST, 3, 7), trackerCounts(LIST)]);
  assert.ok(!/\$\s?\d/.test(out) && !/"(cost|rate|price)"/.test(out));
});

check('D70: unitHistory — this serial, CLOSED only, WOs + fleet tickets merged, newest first by string, id-desc ties', () => {
  const wos = [
    wo('W1004', { status: 'CLOSED', closed: '2026-09-23' }),
    wo('W1005', { status: 'CLOSED', closed: '2026-08-19' }),
    wo('W1006', { status: 'CLOSED', closed: '2026-09-10' }),
    wo('W1001', { status: 'OPEN' }),                                                        // open → not history
    wo('W1009', { status: 'CLOSED', closed: '2026-09-27', serial: '900200' }),             // another machine
  ];
  const tk = (ticket, o) => ({ ticket, status: 'CLOSED', machine_owner: 'WSS', serial: '900100', closed: '2026-09-02', ...o });
  const tickets = [
    tk('S2015', { closed: '2026-09-10' }),
    tk('S2032', { closed: '2026-09-26' }),
    tk('S2040', { status: 'OPEN', closed: null }),                                          // open → not history
    tk('S2050', { machine_owner: 'CUSTOMER', serial: null }),                               // customer machine never matches
    { ticket: 'S2051', status: 'CLOSED', serial: 900100, closed: '2026-07-01' },            // a numeric serial still matches as text
  ];
  const h = unitHistory('900100', wos, tickets);
  assert.deepEqual(h.map((r) => [r.kind, r.id]), [
    ['ticket', 'S2032'], ['wo', 'W1004'], ['wo', 'W1006'], ['ticket', 'S2015'], ['wo', 'W1005'], ['ticket', 'S2051'],
  ], 'newest closed first; a same-day tie goes to the higher id as text (W1006 > S2015)');
  assert.deepEqual(unitHistory(900100, wos, tickets).map((r) => r.id), h.map((r) => r.id), 'serial compared as text');
  assert.deepEqual(unitHistory('999999', wos, tickets), []);
  assert.deepEqual(unitHistory(null, wos, tickets), [], 'no serial, no history');
  assert.deepEqual(unitHistory('900100', undefined, undefined), [], 'a pre-D65 snapshot');
  // A work order and its linked ticket are two rows.
  const linked = unitHistory('900100', [wo('W2003', { status: 'CLOSED', closed: '2026-09-26', ticket: 'S2032' })], [tk('S2032', { closed: '2026-09-26' })]);
  assert.deepEqual(linked.map((r) => r.id), ['W2003', 'S2032']);
});

check('D70: the caption reads each window off its summary (fallbacks 30 / 7); who worked it, in first-seen order', () => {
  assert.equal(historyCaption({ closed_window_days: 365 }, { closed_window_days: 90 }), 'Work orders a year back · tickets 90 days');
  assert.equal(historyCaption(null, null), 'Work orders 30 days back · tickets 7 days');
  assert.deepEqual(laborWho(wo('W1', { labor: [{ who: 'Josh' }, { who: 'Zac' }, { who: 'Josh' }, {}] })), ['Josh', 'Zac']);
});

/* ------------------------------------------------ D71: travel vs labor */

check('D71: laborPayloads — one per non-zero stepper, TRAVEL first, same day / who / note; 0 / 0 refused', () => {
  const base = { key: { work_order: 'W1003' }, date: '2026-09-25', who: 'Josh', note: 'brakes' };
  const both = laborPayloads({ ...base, travel: 1.25, labor: 3 });
  assert.deepEqual(both, [
    { action: 'LABOR', work_order: 'W1003', date: '2026-09-25', who: 'Josh', hours: 1.25, kind: 'TRAVEL', note: 'brakes' },
    { action: 'LABOR', work_order: 'W1003', date: '2026-09-25', who: 'Josh', hours: 3, kind: 'LABOR', note: 'brakes' },
  ]);
  assert.deepEqual(laborPayloads({ ...base, travel: 0, labor: 1 }).map((p) => p.kind), ['LABOR']);
  assert.deepEqual(laborPayloads({ ...base, travel: 0.5, labor: 0 }).map((p) => p.kind), ['TRAVEL']);
  assert.deepEqual(laborPayloads({ ...base, key: {}, travel: 0, labor: 1 })[0].work_order, undefined, 'serial-keyed: no invented work_order');
  assert.deepEqual(laborPayloads({ ...base, travel: 0, labor: 0 }), []);
  assert.match(laborProblem(0, 0), /Travel, Labor, or both/);
  assert.equal(laborProblem(0.5, 0), null);
  assert.ok(laborProblem(0.1, 1), 'each stepper on its own: 0.1 is not a quarter hour');
  assert.ok(laborProblem(1, 12.25), '12.25 is over');
  assert.ok(laborProblem(NaN, 1));
  assert.deepEqual(laborPayloads({ ...base, travel: 1.3, labor: 1 }), [], 'one bad stepper sends nothing');
  assert.ok(stepperValid(0) && stepperValid(0.25) && stepperValid(12) && !stepperValid(-0.25));
});

check('D71: kind on a labor row — TRAVEL or Labor (legacy / missing → LABOR); the travel sum is plain addition', () => {
  assert.equal(laborKindOf({ kind: 'TRAVEL' }), 'TRAVEL');
  assert.equal(laborKindOf({ kind: 'travel' }), 'TRAVEL');
  assert.equal(laborKindOf({ kind: 'LABOR' }), 'LABOR');
  assert.equal(laborKindOf({}), 'LABOR');
  assert.equal(laborKindOf(null), 'LABOR');
  const w = wo('W1', { labor: [{ hours: 1.25, kind: 'TRAVEL' }, { hours: 3 }, { hours: 0.5, kind: 'TRAVEL' }] });
  assert.equal(travelHours(w), 1.75);
  assert.equal(travelHours(wo('W2')), 0);
  assert.equal(describeWoEvent({ action: 'work_order', payload: { action: 'LABOR', hours: 0.5, who: 'Josh', kind: 'TRAVEL' } }), '0.5 h travel logged for Josh');
  assert.equal(describeWoEvent({ action: 'work_order', payload: { action: 'LABOR', hours: 1, who: 'Josh', kind: 'LABOR' } }), '1 h logged for Josh');
  assert.ok(!/cost|rate|price|\$/i.test(JSON.stringify(laborPayloads({ who: 'Josh', travel: 1, labor: 1 }))), 'no money');
});

/* ---- D79: the customer parts order on a ticket ---- */
const ord = (state, ordered, extra = {}) => ({ state, vendor: 'RPS', vendor_ref: null, ordered, tracking: null, carrier: null, delivered: null, note: null, ...extra });
const tk = (ticket, order, extra = {}) => ({ ticket, status: 'OPEN', machine_owner: 'CUSTOMER', stage: 'WAITING-ON-PARTS', order, ...extra });
const Q = [
  tk('S1005', ord('IN-TRANSIT', '2026-09-20')),
  tk('S1003', ord('ORDERED', '2026-09-28')),
  tk('S1004', ord('ORDERED', '2026-09-20')),          // same day as S1005 → S-number breaks the tie
  tk('S1006', ord('ORDERED', null)),                  // no date → last
  tk('S1007', ord('DELIVERED', '2026-09-10', { delivered: '2026-09-25' }), { stage: 'READY-TO-SCHEDULE' }),
  tk('S1008', ord('DELIVERED', '2026-09-10', { delivered: '2026-09-29' }), { stage: 'SCHEDULED' }),
  tk('S1009', ord('IN-TRANSIT', '2026-09-01'), { status: 'CLOSED' }),
  tk('S1010', null),
  tk('S1011', undefined),
  tk('S1012', ord('IN-TRANSIT', '2026-09-22'), { machine_owner: 'WSS' }),
  tk('S1013', ord('ORDERED', '2026-09-22'), { machine_owner: 'CUSTOMER', stage: 'SCHEDULED' }),
  null,
];

check('D79: customerOrders — OPEN only, ORDERED/IN-TRANSIT oldest `ordered` first (nulls last, S-number ties), DELIVERED newest first', () => {
  const c = customerOrders(Q);
  assert.deepEqual(c.active.map((r) => r.ticket.ticket), ['S1004', 'S1005', 'S1012', 'S1013', 'S1003', 'S1006']);
  assert.deepEqual(c.delivered.map((r) => r.ticket.ticket), ['S1008', 'S1007']);
  assert.ok(![...c.active, ...c.delivered].some((r) => r.ticket.ticket === 'S1009'), 'a CLOSED ticket never draws');
  assert.ok(c.active.every((r) => r.order === r.ticket.order));
  assert.deepEqual(customerOrders(undefined), { active: [], delivered: [] }, 'pre-D79 / no queue');
  assert.deepEqual(customerOrders([tk('S1', { state: 'CANCELLED' })]), { active: [], delivered: [] }, 'an unknown state is in neither band');
  assert.equal(orderOf({ order: [] }), null, 'an array is not an order');
});

check('D79: orderCounts — over customerOrders rows or tickets', () => {
  const c = customerOrders(Q);
  assert.deepEqual(orderCounts(c.active), { ordered: 4, inTransit: 2, delivered: 0 });
  assert.deepEqual(orderCounts(Q), { ordered: 4, inTransit: 3, delivered: 2 }, 'raw tickets count every order, the CLOSED one too — callers filter');
  assert.deepEqual(orderCounts(null), { ordered: 0, inTransit: 0, delivered: 0 });
});

check('D79: pipelineOrderChip — OPEN customer tickets in WAITING-ON-PARTS, zeros dropped, "" when none', () => {
  assert.equal(pipelineOrderChip(Q), '3 ordered · 1 in transit', 'S1003/4/6 + S1005; not WSS S1012, not SCHEDULED S1013, not CLOSED S1009');
  assert.equal(pipelineOrderChip([tk('S1', ord('IN-TRANSIT', '2026-09-01'))]), '1 in transit', 'zero ordered dropped');
  assert.equal(pipelineOrderChip([tk('S1', null), tk('S2', undefined)]), '');
  assert.equal(pipelineOrderChip(undefined), '');
});

check('D79: the order vendor list is the part-line VENDORS in the sheet\'s order; no money key anywhere', () => {
  assert.deepEqual([...ORDER_VENDORS].sort(), [...VENDORS].sort());
  assert.deepEqual(ORDER_VENDORS, ['RPS', 'NILFISK', 'IPC-EAGLE', 'MINUTEMAN', 'TENNANT', 'OTHER']);
  const withCost = [tk('S1', ord('ORDERED', '2026-09-01', { cost_total: 412, cost_source_inv: 'INV-1' }))];
  const out = JSON.stringify([customerOrders(withCost).active.map((r) => ({ t: r.ticket.ticket })), orderCounts(withCost), pipelineOrderChip(withCost)]);
  assert.ok(!/cost|\$/.test(out), 'nothing the helpers return carries the cost');
});

console.log(`${passed} checks passed.`);
