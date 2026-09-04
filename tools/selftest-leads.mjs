#!/usr/bin/env node
/**
 * selftest-leads.mjs — the schema-5 leads logic, asserted.
 *
 * The rule this file exists to defend: MONEY IS ABSENT, NOT ZERO. The Worker
 * strips `value`, `potential_commission`, `leads_summary.commission_rates` and
 * `scoreboard.money` for a `service` token (spec §6). Everything downstream has
 * to read that as "not shown", never as $0 — and never draw a hole where the
 * number would have been, which would say just as much.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  BOARD_STAGES, LEAD_STAGES, NO_DATA,
  optionsFrom, moneyFields, hasMoney, amount, isStale,
  sortLeads, filterLeads, chipCounts, boardColumns, closedLeads, leadById,
  canEditLead, canCloseLead, stageOptions, stageNeeds,
  delta, pctOr, statOr, leadForHold, isDemoHold,
} from '../docs/leads.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

console.log('leads self-test');

/* ------------------------------------------------------------- fixtures -- */

const lead = (o) => ({
  lead: o.lead, status: o.status || 'OPEN', stage: o.stage || 'RECEIVED',
  customer: o.customer || 'Someone', assigned: o.assigned || 'Kevin',
  priority: o.priority || 'MEDIUM', stale: o.stale || null,
  age_in_stage_days: o.age == null ? 1 : o.age,
  closed: o.closed || null, ...o,
});

const FIXTURE = [
  lead({ lead: 'L1', stage: 'RECEIVED', value: 1000, potential_commission: 70 }),
  lead({ lead: 'L2', stage: 'CONTACTED', assigned: 'Matt', stale: 'yellow', age: 4 }),
  lead({ lead: 'L3', stage: 'QUOTED', stale: 'red', age: 9, priority: 'LOW' }),
  lead({ lead: 'L4', stage: 'DEMO-SCHEDULED', priority: 'HIGH' }),
  lead({ lead: 'L5', stage: 'INVOICED', status: 'WON', closed: '2026-09-01' }),
  lead({ lead: 'L6', stage: 'QUOTED', status: 'LOST', closed: '2026-08-30', close_reason: 'PRICE' }),
  lead({ lead: 'L7', stage: 'RECEIVED', status: 'DEAD', closed: '2026-09-02' }),
  // An OPEN lead parked at a stage the board has no column for. It must still
  // land somewhere: hiding a column is a choice, dropping a lead is data loss.
  lead({ lead: 'L8', stage: 'INVOICED', status: 'OPEN' }),
];

/* --------------------------------------------------------------- options -- */

check('enum lists come from the snapshot when it sends them, ours otherwise', () => {
  const fromUs = optionsFrom(null);
  assert.deepEqual(fromUs.stages, LEAD_STAGES);
  assert.ok(fromUs.sources.includes('MACHINIO'));

  const fromEngine = optionsFrom({ stages: ['A', 'B'], sources: ['X'], lost_reasons: ['NOPE'], assignees: ['Kevin'] });
  assert.deepEqual(fromEngine.stages, ['A', 'B'], 'a new stage must not need a site deploy');
  assert.deepEqual(fromEngine.sources, ['X']);
  assert.deepEqual(fromEngine.interests, optionsFrom(null).interests, 'an absent list falls back');

  // Junk must not become the option list — a chip row of `undefined` is worse
  // than the stale-but-correct constant.
  assert.deepEqual(optionsFrom({ stages: [] }).stages, LEAD_STAGES);
  assert.deepEqual(optionsFrom({ stages: [1, 2] }).stages, LEAD_STAGES);
});

check('moneyFields defaults to the two the Worker strips today', () => {
  assert.deepEqual(moneyFields(null), ['value', 'potential_commission']);
  assert.deepEqual(moneyFields({ money_fields: ['value', 'potential_commission', 'margin'] }),
    ['value', 'potential_commission', 'margin']);
});

/* ----------------------------------------------------------------- money -- */

check('hasMoney reads scoreboard.money — the one signal for the whole page', () => {
  assert.equal(hasMoney({ scoreboard: { money: { on_table_value: 0 } } }), true);
  assert.equal(hasMoney({ scoreboard: { speed: {} } }), false, 'a stripped payload has no money block');
  assert.equal(hasMoney({ scoreboard: null }), false);
  assert.equal(hasMoney(null), false);
  // Zero is a real amount and must stay visible — the gate is presence, not truthiness.
  assert.equal(hasMoney({ scoreboard: { money: {} } }), true);
});

check('amount() treats absent as null and zero as zero', () => {
  assert.equal(amount(0), 0, '$0 on the table is a fact, not a missing field');
  assert.equal(amount(14250.5), 14250.5);
  assert.equal(amount(undefined), null, 'a stripped key is not zero');
  assert.equal(amount(null), null);
  assert.equal(amount('14250'), null, 'a string is not money');
  assert.equal(amount(NaN), null);
  assert.equal(amount(Infinity), null);
});

check('a stripped lead exposes no money at all', () => {
  // Exactly what a service token receives: the keys are gone, not zeroed.
  const stripped = { lead: 'L1', status: 'OPEN', stage: 'QUOTED', customer: 'X' };
  assert.equal(amount(stripped.value), null);
  assert.equal(amount(stripped.potential_commission), null);
  assert.equal('value' in stripped, false, 'the key itself must be absent');
});

/* --------------------------------------------------------------- sorting -- */

check('inside a column: red, then yellow, then priority, then oldest', () => {
  const order = sortLeads([
    lead({ lead: 'a', priority: 'HIGH', age: 1 }),
    lead({ lead: 'b', stale: 'yellow', priority: 'LOW', age: 2 }),
    lead({ lead: 'c', stale: 'red', priority: 'LOW', age: 1 }),
    lead({ lead: 'd', priority: 'HIGH', age: 8 }),
  ]).map((l) => l.lead);
  assert.deepEqual(order, ['c', 'b', 'd', 'a'], 'rot first, then priority, then longest in stage');
});

check('sortLeads does not mutate its input', () => {
  const src = [lead({ lead: 'a' }), lead({ lead: 'b', stale: 'red' })];
  const before = src.map((l) => l.lead);
  sortLeads(src);
  assert.deepEqual(src.map((l) => l.lead), before);
});

/* ------------------------------------------------------------- filtering -- */

check('the three chips filter the way they read', () => {
  assert.equal(filterLeads(FIXTURE, 'all', 'Kevin').length, FIXTURE.length);
  assert.deepEqual(filterLeads(FIXTURE, 'mine', 'Matt').map((l) => l.lead), ['L2']);
  assert.deepEqual(filterLeads(FIXTURE, 'stale', 'Kevin').map((l) => l.lead), ['L2', 'L3']);
  // No name = nobody's. "Mine" must never silently mean "everything".
  assert.deepEqual(filterLeads(FIXTURE, 'mine', null), []);
});

check('chip counts are over the whole list, not the filtered view', () => {
  const c = chipCounts(FIXTURE, 'Matt');
  assert.equal(c.all, 5, 'five OPEN leads');
  assert.equal(c.mine, 1);
  assert.equal(c.stale, 2);
  // The counts must not move when the chip does.
  assert.deepEqual(chipCounts(filterLeads(FIXTURE, 'all', 'Matt'), 'Matt'), c);
});

check('isStale is red or yellow, and nothing else', () => {
  assert.equal(isStale({ stale: 'red' }), true);
  assert.equal(isStale({ stale: 'yellow' }), true);
  assert.equal(isStale({ stale: null }), false);
  assert.equal(isStale({}), false);
  assert.equal(isStale(null), false);
});

/* ----------------------------------------------------------------- board -- */

check('five columns: the four open stages, then WON', () => {
  const cols = boardColumns(FIXTURE, { me: { name: 'Kevin' } });
  const keys = cols.map((c) => c.key);
  assert.deepEqual(keys.slice(0, 4), BOARD_STAGES);
  assert.equal(keys[keys.length - 1], 'WON', 'WON is always the last column');
  assert.deepEqual(cols.find((c) => c.key === 'WON').leads.map((l) => l.lead), ['L5']);
});

check('WON is a STATUS column — a won lead never sits in a stage column', () => {
  const cols = boardColumns(FIXTURE, { me: { name: 'Kevin' } });
  for (const c of cols) {
    if (c.key === 'WON') continue;
    assert.ok(!c.leads.some((l) => l.status !== 'OPEN'), `${c.key} holds only OPEN leads`);
  }
});

check('LOST and DEAD are never on the board — they are the closed strip', () => {
  const onBoard = boardColumns(FIXTURE, { me: null }).flatMap((c) => c.leads.map((l) => l.lead));
  assert.ok(!onBoard.includes('L6') && !onBoard.includes('L7'));
  assert.deepEqual(closedLeads(FIXTURE).map((l) => l.lead), ['L7', 'L6'], 'most recently closed first');
});

check('an OPEN lead at an off-board stage gets its own column, before WON', () => {
  const cols = boardColumns(FIXTURE, { me: null });
  const keys = cols.map((c) => c.key);
  assert.ok(keys.includes('INVOICED'), 'L8 must not vanish');
  assert.ok(keys.indexOf('INVOICED') < keys.indexOf('WON'));
  assert.deepEqual(cols.find((c) => c.key === 'INVOICED').leads.map((l) => l.lead), ['L8']);
});

check('column counts come from the summary only when nothing is filtered', () => {
  const summary = { open_by_stage: { RECEIVED: 99, CONTACTED: 1, QUOTED: 1, 'DEMO-SCHEDULED': 1 } };
  const all = boardColumns(FIXTURE, { filter: 'all', me: null, summary });
  assert.equal(all[0].count, 99, 'the engine is the authority on an unfiltered board');

  const mine = boardColumns(FIXTURE, { filter: 'mine', me: { name: 'Matt' }, summary });
  assert.equal(mine[0].count, 0, 'a filtered column counts what it actually draws');
  assert.equal(mine[1].count, 1);
});

check('the closed strip honours the chip too', () => {
  assert.deepEqual(closedLeads(FIXTURE, 'mine', 'Matt'), []);
  assert.equal(closedLeads(FIXTURE, 'all', null).length, 2);
});

check('leadById finds it, or honestly returns null', () => {
  assert.equal(leadById(FIXTURE, 'L3').stage, 'QUOTED');
  assert.equal(leadById(FIXTURE, 'nope'), null);
  assert.equal(leadById(null, 'L1'), null);
});

/* --------------------------------------------------------- stage picker -- */

check('only sales and owner work the pipeline', () => {
  assert.equal(canEditLead('sales'), true);
  assert.equal(canEditLead('owner'), true);
  assert.equal(canEditLead('service'), false, 'a tech may add a note and nothing else');
  assert.equal(canCloseLead('service'), false);
});

check('INVOICED is hidden unless you are Matt', () => {
  const forKevin = stageOptions(FIXTURE[0], 'sales').map((o) => o.stage);
  assert.ok(!forKevin.includes('INVOICED'), 'it names a real invoice');
  assert.deepEqual(forKevin, BOARD_STAGES);

  const forMatt = stageOptions(FIXTURE[0], 'owner').map((o) => o.stage);
  assert.deepEqual(forMatt, LEAD_STAGES);

  // Josh sees the buttons drawn but disabled — the picker is not his.
  assert.ok(stageOptions(FIXTURE[0], 'service').every((o) => !o.enabled));
});

check('the current stage is marked, so the picker shows where you are', () => {
  const opts = stageOptions(lead({ lead: 'x', stage: 'QUOTED' }), 'sales');
  assert.deepEqual(opts.filter((o) => o.current).map((o) => o.stage), ['QUOTED']);
});

check('three stages ask for something before they can be proposed', () => {
  const l = lead({ lead: 'x', stage: 'CONTACTED', value: null });
  assert.equal(stageNeeds(l, 'DEMO-SCHEDULED'), 'demo');
  assert.equal(stageNeeds(l, 'INVOICED'), 'invoice');
  assert.equal(stageNeeds(l, 'QUOTED'), 'value', 'a quote with no number is not a quote');
  assert.equal(stageNeeds(l, 'CONTACTED'), null);

  // A value we already have is not asked for twice.
  assert.equal(stageNeeds(lead({ lead: 'y', value: 5000 }), 'QUOTED'), null);
  // Zero IS a value. Asking again would overwrite a deliberate zero.
  assert.equal(stageNeeds(lead({ lead: 'z', value: 0 }), 'QUOTED'), null);
  // A service token's stripped lead: the picker is disabled for them anyway,
  // but the guard must not read "absent" as "we have one".
  assert.equal(stageNeeds({ lead: 'q' }, 'QUOTED'), 'value');
});

/* ------------------------------------------------------------ scoreboard -- */

check('delta gives a direction, and nothing at all without a baseline', () => {
  assert.equal(delta(5, 3).dir, 'up');
  assert.equal(delta(1, 3).dir, 'down');
  assert.equal(delta(3, 3).dir, 'flat');
  assert.equal(delta(5, null).dir, 'none', 'no baseline, no arrow');
  assert.equal(delta(null, 3).dir, 'none');
  assert.equal(delta(0, 0).dir, 'flat');
  assert.equal(delta(delta(2, 1).avg, 1).dir, 'flat');
});

check('a null rate reads "not enough data" — never a dash, never a zero', () => {
  assert.equal(pctOr(null), NO_DATA);
  assert.equal(pctOr(undefined), NO_DATA);
  assert.equal(pctOr(0), '0%', 'a real zero percent is a finding, and stays');
  assert.equal(pctOr(62.4), '62%');
  assert.equal(statOr(null, 'h'), NO_DATA);
  assert.equal(statOr(2.55, 'h'), '2.6h');
  assert.equal(statOr(0, 'h'), '0h');
  assert.equal(statOr(21, 'd'), '21d');
  assert.notEqual(pctOr(null), '—');
  assert.notEqual(pctOr(null), '0%');
});

/* ---------------------------------------------------- unit page tie-in -- */

check('a demo hold links to its lead by hold id and by nothing else', () => {
  const leads = [
    lead({ lead: 'L20', demo: { date: '2026-09-07', serial: '900114', hold_id: 'h0114l' } }),
    lead({ lead: 'L21', demo: null }),
  ];
  assert.equal(leadForHold(leads, 'h0114l').lead, 'L20');
  assert.equal(leadForHold(leads, 'h9999z'), null, 'a near miss must not guess');
  assert.equal(leadForHold(leads, null), null);
  assert.equal(leadForHold(leads, undefined), null, 'a hold with no id matches nothing');
});

check('isDemoHold reads the purpose, and is not fooled by the word in passing', () => {
  assert.equal(isDemoHold({ purpose: 'DEMO — Ixonia' }), true);
  assert.equal(isDemoHold({ purpose: 'demo at the plant' }), true);
  assert.equal(isDemoHold({ purpose: 'quote hold' }), false);
  assert.equal(isDemoHold({ purpose: 'replacement, not a demo' }), false, 'a demo hold starts as one');
  assert.equal(isDemoHold({ purpose: null }), false);
  assert.equal(isDemoHold(null), false);
});

console.log(`\n${passed} checks passed.`);
