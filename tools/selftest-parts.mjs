#!/usr/bin/env node
/**
 * selftest-parts.mjs — the pure rules of docs/parts.js (D88, Parts-Site-Spec).
 * All data here is FAKE. Run: npm test
 */
import assert from 'node:assert/strict';
import {
  partsColumns, closedOrders, partsBadge, partsStageOptions, stageFields, isGated, gateText, partsInFlight,
  inFlightCounts, shipmentsOf, boxesOpen, latestShipment, canShipBox, firstLine, partsValue, canCloseOrder, canComplete, sortOrders, partsOptions,
  partsScoreTiles, P_STAT_WINDOWS,
} from '../docs/parts.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
console.log('parts self-test');

const o = (x) => ({ status: 'OPEN', terms: 'CASH', supply: 'VENDOR', ...x });

check('columns: six stages in order, engine counts win, an unknown stage still gets a column', () => {
  const rows = [o({ order: 'P1', stage: 'REQUESTED' }), o({ order: 'P2', stage: 'BACKORDER' }), o({ order: 'P3', status: 'LOST', stage: 'QUOTED' })];
  const cols = partsColumns(rows, { open_by_stage: { REQUESTED: 4 } });
  assert.deepEqual(cols.map((c) => c.stage), ['REQUESTED', 'QUOTED', 'APPROVED', 'ORDERED', 'IN-TRANSIT', 'DELIVERED', 'BACKORDER']);
  assert.equal(cols[0].count, 4, 'the engine number');
  assert.equal(cols[1].orders.length, 0, 'a LOST order never sits on the board');
  assert.equal(cols[6].count, 1);
});

check('sort: red, yellow, then longest in stage', () => {
  const s = sortOrders([o({ order: 'A', age_in_stage_days: 9 }), o({ order: 'B', stale: 'yellow' }), o({ order: 'C', stale: 'red', age_in_stage_days: 0.1 })]);
  assert.deepEqual(s.map((x) => x.order), ['C', 'B', 'A']);
});

check('closed strip: CLOSED · LOST · DEAD, newest first; badge is requested_unquoted, zero → 0', () => {
  const c = closedOrders([o({ order: 'P1' }), o({ order: 'P2', status: 'LOST', closed: '2026-10-01' }), o({ order: 'P3', status: 'CLOSED', closed: '2026-10-09' })]);
  assert.deepEqual(c.map((x) => x.order), ['P3', 'P2']);
  assert.equal(partsBadge({ requested_unquoted: 2 }), 2);
  assert.equal(partsBadge(null), 0);
});

check('money: a null or absent value is not zero', () => {
  assert.equal(partsValue(o({ value: null })), null);
  assert.equal(partsValue(o({})), null);
  assert.equal(partsValue(o({ value: 0 })), 0);
});

check('stage options: SHOP-STOCK hides ORDERED + IN-TRANSIT; ORDERED is the owner\'s; owner steps back one, sales never', () => {
  const stock = partsStageOptions(o({ stage: 'APPROVED', supply: 'SHOP-STOCK' }), 'owner');
  assert.deepEqual(stock.map((x) => x.stage), ['REQUESTED', 'QUOTED', 'APPROVED', 'DELIVERED']);
  const sales = Object.fromEntries(partsStageOptions(o({ stage: 'APPROVED' }), 'sales').map((x) => [x.stage, x.enabled]));
  assert.deepEqual(sales, { REQUESTED: false, QUOTED: false, APPROVED: false, ORDERED: false, 'IN-TRANSIT': true, DELIVERED: true });
  const owner = Object.fromEntries(partsStageOptions(o({ stage: 'APPROVED' }), 'owner').map((x) => [x.stage, x.enabled]));
  assert.deepEqual(owner, { REQUESTED: false, QUOTED: true, APPROVED: false, ORDERED: true, 'IN-TRANSIT': true, DELIVERED: true });
  const late = Object.fromEntries(partsStageOptions(o({ stage: 'DELIVERED' }), 'owner').map((x) => [x.stage, x.enabled]));
  assert.equal(late['IN-TRANSIT'], false, 'no stepping back past ORDERED — the box beats the invoice');
  assert.ok(partsStageOptions(o({ stage: 'QUOTED' }), 'service').every((x) => !x.enabled), 'service moves nothing');
});

check('the gate: ORDERED asks vendor + (CASH paid + invoice | ACCOUNT customer PO), pre-filled; stock DELIVERED asks the gate only', () => {
  const cash = stageFields(o({ stage: 'APPROVED', paid: '2026-10-08', invoice: 'Order #1001' }), 'ORDERED');
  assert.deepEqual(cash.map((f) => [f.key, f.required, f.value]), [['vendor', true, ''], ['vendor_ref', false, ''], ['paid', true, '2026-10-08'], ['invoice', true, 'Order #1001']]);
  const acct = stageFields(o({ terms: 'ACCOUNT', customer_po: 'PO-9' }), 'ORDERED');
  assert.deepEqual(acct.map((f) => f.key), ['vendor', 'vendor_ref', 'customer_po']);
  assert.equal(acct[2].value, 'PO-9');
  assert.deepEqual(stageFields(o({ supply: 'SHOP-STOCK' }), 'DELIVERED').map((f) => f.key), ['paid', 'invoice']);
  assert.deepEqual(stageFields(o({}), 'DELIVERED'), [], 'a vendor order delivered: nothing to ask');
  assert.deepEqual(stageFields(o({ tracking: '1Z' }), 'IN-TRANSIT').map((f) => [f.key, f.value]), [['tracking', '1Z']]);
  assert.deepEqual(stageFields(o({ quote: { number: '44040' }, value: 312.5 }), 'QUOTED').map((f) => [f.key, f.value]), [['quote', '44040'], ['value', 312.5]]);
  assert.ok(isGated(o({}), 'ORDERED') && isGated(o({ supply: 'SHOP-STOCK' }), 'DELIVERED') && !isGated(o({}), 'DELIVERED'));
  assert.ok(gateText(o({ terms: 'ACCOUNT' })).includes('PO') && gateText(o({})).includes('payment'));
});

check('close + done: owner any time, sales only before ORDERED; Done = owner at DELIVERED', () => {
  assert.ok(canCloseOrder('sales', o({ stage: 'APPROVED' })) && !canCloseOrder('sales', o({ stage: 'ORDERED' })));
  assert.ok(canCloseOrder('owner', o({ stage: 'IN-TRANSIT' })) && !canCloseOrder('service', o({ stage: 'REQUESTED' })));
  assert.ok(canComplete('owner', o({ stage: 'DELIVERED' })) && !canComplete('sales', o({ stage: 'DELIVERED' })) && !canComplete('owner', o({ stage: 'IN-TRANSIT' })));
});

check('tracker band: OPEN at ORDERED / IN-TRANSIT only, oldest ordered first; counts', () => {
  const rows = partsInFlight([o({ order: 'P1', stage: 'IN-TRANSIT', ordered: '2026-10-09' }), o({ order: 'P2', stage: 'ORDERED', ordered: '2026-10-01' }),
    o({ order: 'P3', stage: 'DELIVERED' }), o({ order: 'P4', stage: 'ORDERED', status: 'DEAD' })]);
  assert.deepEqual(rows.map((x) => x.order), ['P2', 'P1']);
  assert.deepEqual(inFlightCounts(rows), { ordered: 1, inTransit: 1 });
});

check('D98 shipments: tolerant of a pre-D98 row; newest box by shipped then id; Ship from shop = owner/sales, OPEN, APPROVED on', () => {
  assert.deepEqual(shipmentsOf(o({})), []);
  assert.equal(boxesOpen(o({})), 0);
  assert.equal(latestShipment(o({})), null);
  const r = o({ shipments: [{ id: 1, tracking: 'A', shipped: '2026-10-15' }, { id: 2, tracking: 'B', shipped: '2026-10-15' }, { id: 3, tracking: null, shipped: '2026-10-16' }] });
  assert.equal(latestShipment(r).tracking, 'B', 'same day → higher id; no-tracking boxes skipped');
  for (const st of ['APPROVED', 'ORDERED', 'IN-TRANSIT', 'DELIVERED']) assert.ok(canShipBox('sales', o({ stage: st })), st);
  assert.ok(!canShipBox('owner', o({ stage: 'QUOTED' })) && !canShipBox('service', o({ stage: 'APPROVED' })));
  assert.ok(!canShipBox('owner', o({ stage: 'DELIVERED', status: 'CLOSED' })) && !canShipBox('owner', o({ stage: 'APPROVED', status: 'LOST' })));
});

check('D98 band: an APPROVED order with a box moving draws (in transit), dated by its first box; no box, no row', () => {
  const rows = partsInFlight([o({ order: 'P1', stage: 'APPROVED', boxes_open: 1, shipments: [{ id: 1, tracking: 'X', shipped: '2026-10-15' }] }),
    o({ order: 'P2', stage: 'ORDERED', ordered: '2026-10-10' }), o({ order: 'P3', stage: 'APPROVED' })]);
  assert.deepEqual(rows.map((x) => x.order), ['P2', 'P1']);
  assert.deepEqual(inFlightCounts(rows), { ordered: 1, inTransit: 1 });
});

check('first line of multi-line parts text; options fall back to ours', () => {
  assert.equal(firstLine('\n  2x blade \r\n1x lid'), '2x blade');
  assert.equal(firstLine(null), '');
  assert.deepEqual(partsOptions({ vendors: ['RPS'] }).vendors, ['RPS']);
  assert.equal(partsOptions(null).stages.length, 6);
});

console.log(`${passed} checks passed.`);

// ---------------------------------------------------------------- D105: the Parts scoreboard (was the D103 strip)
{
  const win = (o, p) => ({ days: 30, opened: 8, per_day: 0.27, complete: 1, lost: 1, dead: 0, ...o, prev: p === undefined ? { days: 30, opened: 5, per_day: 0.17, complete: 2, lost: 0, dead: 1 } : p });
  const stats = { as_of: '2026-10-15', windows: { '7d': win({ days: 7, opened: 2, per_day: 0.29 }), '30d': win({}), '90d': win({ days: 41 }, null), all: { days: 41, opened: 8, per_day: 0.2, complete: 1, lost: 1, dead: 0 } },
    money: { '7d': { quoted: 2, avg_value: 600, won_value: 0, prev: { quoted: 1, avg_value: 300, won_value: 300 } }, '30d': { quoted: 8, avg_value: 530.9, won_value: 1808.65, prev: { quoted: 5, avg_value: 412.4, won_value: 905.1 } }, '90d': { quoted: 8, avg_value: 530.9, won_value: 1808.65, prev: null }, all: { quoted: 8, avg_value: 530.9, won_value: 1808.65 } } };
  const fmt = (n) => `$${Math.round(n)}`;
  const sc = partsScoreTiles({ stats }, '30d', fmt);
  assert.deepEqual(sc.tiles.map((t) => [t.key, t.shown, t.dir, t.prevShown]),
    [['opened', '8', 'up', '5'], ['per_day', '0.3/day', 'up', '0.2/day'], ['avg', '$531', 'up', '$412'], ['complete', '1', 'down', '2'], ['won', '$1809', 'up', '$905'], ['lost', '1', 'up', '0'], ['dead', '0', 'down', '1']],
    'D105: owner tiles in draw order, each against prev; lost/dead shown because one side is non-zero');
  assert.equal(sc.caption, 'vs. the 30 days before'); assert.ok(sc.hasMoney);
  assert.deepEqual(sc.tiles.filter((t) => t.key === 'lost' || t.key === 'dead').map((t) => [t.dir, t.tone]), [['up', 'down'], ['down', 'up']], 'D105: more lost paints red, fewer dead paints green — the arrow keeps the arithmetic');
  const svc = partsScoreTiles({ stats: { windows: stats.windows } }, '30d', fmt);   // the Worker deleted stats.money (prev money with it)
  assert.deepEqual(svc.tiles.map((t) => t.key), ['opened', 'per_day', 'complete', 'lost', 'dead'], 'D105: service — no money tile, no $0, no hint');
  assert.ok(!svc.hasMoney && svc.tiles.every((t) => t.kind !== 'money'));
  const young = partsScoreTiles({ stats }, '90d', fmt);
  assert.ok(young.tiles.every((t) => t.dir === 'none' && t.prevShown == null), 'D105: prev null → no arrows');
  assert.equal(young.caption, 'no earlier period yet');
  const all = partsScoreTiles({ stats }, 'all', fmt);
  assert.equal(all.caption, 'all time · 41 days'); assert.ok(all.tiles.every((t) => t.dir === 'none'));
  assert.equal(partsScoreTiles({}, '30d', fmt), null, 'D105: pre-D103 snapshot → no card');
  assert.equal(partsScoreTiles({ stats: { windows: {} } }, '30d', fmt), null, 'D105: window missing → no card');
  const empty = { stats: { windows: { '30d': { days: 30, opened: 0, per_day: 0, complete: 0, lost: 0, dead: 0, prev: null } }, money: { '30d': { quoted: 0, avg_value: null, won_value: 0, prev: null } } } };
  assert.deepEqual(partsScoreTiles(empty, '30d', fmt).tiles.map((t) => [t.key, t.shown]), [['opened', '0'], ['per_day', '0.0/day'], ['avg', null], ['complete', '0'], ['won', '$0']], 'D105: nothing opened → avg null (not zero), no lost/dead tiles');
  const partial = partsScoreTiles({ stats: { windows: { '7d': win({ days: 7 }, { days: 3, opened: 1, per_day: 0.33, complete: 0, lost: 0, dead: 0 }) } } }, '7d', fmt);
  assert.equal(partial.caption, 'vs. the 7 days before (3d of history)', 'D105: a prev window the ledger only partly covers says so');
  assert.deepEqual(P_STAT_WINDOWS, ['7d', '30d', '90d', 'all']);
  console.log('  ok  D105: scoreboard tiles vs prev, money absent for service, captions');
}
