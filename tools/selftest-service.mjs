#!/usr/bin/env node
/** selftest-service.mjs — schema-3 service + dispatch logic: stage gating,
 *  kanban columns, dispatch ordering, the rig warning. Run: npm test */
import assert from 'node:assert/strict';
import {
  STAGES, stagesFor, canStage, stageOptions, filterTickets, columnize, sortTickets,
  missingMoves, openCount, dispatchFor, sortOpen, groupByDate, sections, rigClash,
  driverChoices, defaultDriver, canCancel, unbookedPickups,
} from '../docs/service.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const T = (ticket, stage, machine_owner = 'CUSTOMER', extra = {}) =>
  ({ ticket, stage, machine_owner, status: 'OPEN', priority: 'MEDIUM', age_days: 1, ...extra });
const D = (id, status, extra = {}) => ({ id, status, kind: 'PICKUP', source: 'MANUAL', date: null, ...extra });

console.log('service + dispatch self-test');

/* ------------------------------------------------------------------ stages */

check('WSS tickets hide QUOTED and READY-TO-INVOICE; customer tickets show all seven', () => {
  assert.deepEqual(stagesFor('CUSTOMER'), STAGES);
  assert.deepEqual(stagesFor('WSS'),
    ['INTAKE', 'INSPECTION', 'PARTS-ORDERED', 'IN-PROGRESS', 'COMPLETE']);
  assert.equal(stagesFor('WSS').includes('QUOTED'), false);
});

check('stage changes are service/owner only — sales never moves a ticket', () => {
  const t = T('S1', 'INTAKE');
  for (const stage of STAGES) {
    assert.equal(canStage(t, stage, 'sales'), false, `sales ${stage}`);
    assert.equal(canStage(t, stage, ''), false, `no role ${stage}`);
  }
  assert.equal(canStage(t, 'INSPECTION', 'service'), true);
  assert.equal(canStage(t, 'INSPECTION', 'owner'), true);
});

check('COMPLETE on a CUSTOMER ticket is owner-only; on a WSS ticket a tech may close it', () => {
  assert.equal(canStage(T('S1', 'READY-TO-INVOICE', 'CUSTOMER'), 'COMPLETE', 'service'), false);
  assert.equal(canStage(T('S1', 'READY-TO-INVOICE', 'CUSTOMER'), 'COMPLETE', 'owner'), true);
  assert.equal(canStage(T('S2', 'IN-PROGRESS', 'WSS'), 'COMPLETE', 'service'), true);
});

check('a stage hidden for WSS can never be set on a WSS ticket', () => {
  const wss = T('S2', 'INTAKE', 'WSS');
  assert.equal(canStage(wss, 'QUOTED', 'owner'), false);
  assert.equal(canStage(wss, 'READY-TO-INVOICE', 'owner'), false);
});

check('stageOptions marks the current stage and captions the disabled COMPLETE', () => {
  const opts = stageOptions(T('S1', 'QUOTED', 'CUSTOMER'), 'service');
  assert.equal(opts.length, 7);
  assert.equal(opts.find((o) => o.stage === 'QUOTED').current, true);
  const done = opts.find((o) => o.stage === 'COMPLETE');
  assert.equal(done.enabled, false);
  assert.equal(done.caption, 'Matt closes after invoicing.');
  // Matt sees no caption and a live button.
  const mattsDone = stageOptions(T('S1', 'QUOTED'), 'owner').find((o) => o.stage === 'COMPLETE');
  assert.equal(mattsDone.enabled, true);
  assert.equal(mattsDone.caption, null);
});

/* ------------------------------------------------------------------ kanban */

const QUEUE = [
  T('S1', 'INTAKE', 'CUSTOMER', { priority: 'HIGH', age_days: 2 }),
  T('S2', 'INTAKE', 'WSS'),
  T('S3', 'IN-PROGRESS', 'CUSTOMER'),
  T('S4', 'COMPLETE', 'CUSTOMER', { status: 'CLOSED' }),
  T('S5', 'TRIAGE', 'CUSTOMER'),              // a stage we've never heard of
];

check('filterTickets: all / Customer / Fleet', () => {
  assert.equal(filterTickets(QUEUE, 'all').length, 5);
  assert.deepEqual(filterTickets(QUEUE, 'WSS').map((t) => t.ticket), ['S2']);
  assert.equal(filterTickets(QUEUE, 'CUSTOMER').length, 4);
  assert.deepEqual(filterTickets(null, 'all'), []);
});

check('columnize: seven stages in order, unknown stages appended, nothing dropped', () => {
  const cols = columnize(QUEUE);
  assert.deepEqual(cols.slice(0, 7).map((c) => c.stage), STAGES);
  assert.equal(cols[7].stage, 'TRIAGE');
  assert.equal(cols.reduce((n, c) => n + c.tickets.length, 0), QUEUE.length);
});

check('columnize counts come from service_summary only when unfiltered', () => {
  const summary = { open_by_stage: { INTAKE: 9 } };
  assert.equal(columnize(QUEUE, { summary }).find((c) => c.stage === 'INTAKE').count, 9);
  // Filtered, the summary would be a lie — count what is drawn.
  assert.equal(columnize(QUEUE, { summary, filter: 'WSS' }).find((c) => c.stage === 'INTAKE').count, 1);
});

check('sortTickets: open before closed, HIGH first, then oldest', () => {
  assert.deepEqual(sortTickets(QUEUE).map((t) => t.ticket), ['S1', 'S2', 'S3', 'S5', 'S4']);
});

check('missingMoves offers a move only when the ticket says NONE and no live row exists', () => {
  const t = { intake_move: 'NONE', return_move: 'NONE' };
  assert.deepEqual(missingMoves(t, []), { intake: true, ret: true });
  assert.deepEqual(missingMoves(t, [D('m1', 'SCHEDULED', { kind: 'PICKUP' })]), { intake: false, ret: true });
  // A DONE row is history, not a booking.
  assert.deepEqual(missingMoves(t, [D('m1', 'DONE', { kind: 'PICKUP' })]), { intake: true, ret: true });
  assert.deepEqual(missingMoves({ intake_move: 'PICKUP', return_move: 'DELIVER' }, []), { intake: false, ret: false });
});

/* ---------------------------------------------------------------- dispatch */

check('openCount is OPEN + SCHEDULED — DONE rows linger 7 days and must not inflate the badge', () => {
  assert.equal(openCount([D('a', 'OPEN'), D('b', 'SCHEDULED'), D('c', 'DONE')]), 2);
  assert.equal(openCount([]), 0);
  assert.equal(openCount(null), 0);
});

check('sortOpen: dated ascending, undated after, stable by id', () => {
  const rows = [D('m3', 'OPEN'), D('m1', 'OPEN', { date: '2026-09-15' }), D('m2', 'OPEN', { date: '2026-09-11' }), D('m0', 'OPEN')];
  assert.deepEqual(sortOpen(rows).map((r) => r.id), ['m2', 'm1', 'm0', 'm3']);
  // Junk in `date` sorts as undated rather than "sorting" as a string.
  assert.deepEqual(sortOpen([D('x', 'OPEN', { date: 'soon' }), D('y', 'OPEN', { date: '2026-09-01' })]).map((r) => r.id), ['y', 'x']);
});

check('groupByDate: one group per day, in date order, undated last', () => {
  const g = groupByDate([D('a', 'SCHEDULED', { date: '2026-09-11' }), D('b', 'SCHEDULED', { date: '2026-09-09' }),
    D('c', 'SCHEDULED', { date: '2026-09-11' }), D('d', 'SCHEDULED')]);
  assert.deepEqual(g.map((x) => x.date), ['2026-09-09', '2026-09-11', '']);
  assert.deepEqual(g[1].rows.map((r) => r.id), ['a', 'c']);
});

check('sections splits the board into Open / Scheduled / Done this week', () => {
  const s = sections([D('a', 'OPEN'), D('b', 'SCHEDULED', { date: '2026-09-10' }), D('c', 'DONE'), D('d', 'OPEN', { date: '2026-09-08' })]);
  assert.deepEqual(s.open.map((r) => r.id), ['d', 'a']);
  assert.equal(s.scheduledCount, 1);
  assert.deepEqual(s.done.map((r) => r.id), ['c']);
});

check('dispatchFor: only this ticket, live rows before done ones', () => {
  const all = [D('m1', 'DONE', { ticket: 'S1' }), D('m2', 'OPEN', { ticket: 'S1' }), D('m3', 'OPEN', { ticket: 'S9' })];
  assert.deepEqual(dispatchFor(all, 'S1').map((r) => r.id), ['m2', 'm1']);
  assert.deepEqual(dispatchFor(all, null), []);
});

/* ------------------------------------------------------------- rig warning */

check('rigClash warns on same rig + same day, from the snapshot or from the engine', () => {
  const dispatch = [D('m1', 'SCHEDULED', { rig: 'TRAILER-6000', date: '2026-09-11' })];
  const hit = rigClash({ dispatch, warnings: [], rig: 'TRAILER-6000', date: '2026-09-11' });
  assert.deepEqual(hit.ids, ['m1']);
  // A different rig or a different day is not a clash.
  assert.equal(rigClash({ dispatch, warnings: [], rig: 'TRAILER-3000', date: '2026-09-11' }), null);
  assert.equal(rigClash({ dispatch, warnings: [], rig: 'TRAILER-6000', date: '2026-09-12' }), null);
  // Re-claiming the row that IS the clash doesn't warn about itself.
  assert.equal(rigClash({ dispatch, warnings: [], rig: 'TRAILER-6000', date: '2026-09-11', excludeId: 'm1' }), null);
  // The engine's warning stands even when we can't see the other row.
  const fromEngine = rigClash({ dispatch: [], warnings: [{ rig: 'JOSH-LIFTGATE', date: '2026-09-11', ids: ['m8', 'm9'] }],
    rig: 'JOSH-LIFTGATE', date: '2026-09-11' });
  assert.deepEqual(fromEngine.ids, ['m8', 'm9']);
  // No date yet = nothing to warn about.
  assert.equal(rigClash({ dispatch, warnings: [], rig: 'TRAILER-6000', date: null }), null);
});

/* ------------------------------------------------------------------ people */

check('driverChoices: owner picks anyone, others only themselves', () => {
  assert.deepEqual(driverChoices({ role: 'owner', name: 'Matt' }), ['Matt', 'Kevin', 'Josh', 'Zac']);
  assert.deepEqual(driverChoices({ role: 'service', name: 'Josh' }), ['Josh']);
  assert.equal(defaultDriver({ role: 'service', name: 'Zac' }), 'Zac');
  assert.equal(defaultDriver({ role: 'owner', name: 'Matt' }), 'Matt');
  // An unrecognised name can't be narrowed to nothing.
  assert.deepEqual(driverChoices({ role: 'sales', name: 'New Hire' }).length, 4);
});

check('canCancel: owner, MANUAL rows only', () => {
  assert.equal(canCancel(D('a', 'OPEN', { source: 'MANUAL' }), 'owner'), true);
  assert.equal(canCancel(D('a', 'OPEN', { source: 'MANUAL' }), 'service'), false);
  assert.equal(canCancel(D('a', 'OPEN', { source: 'RENTAL-RETURN' }), 'owner'), false);
});

check('unbookedPickups: a released unit with no live RENTAL-RETURN row is never silent', () => {
  const pickups = [{ serial: '900107' }, { serial: '900114' }];
  const dispatch = [D('m1', 'OPEN', { source: 'RENTAL-RETURN', serial: '900107' })];
  assert.deepEqual(unbookedPickups(pickups, dispatch).map((p) => p.serial), ['900114']);
  // A DONE row doesn't count as booked (the truck already went; if it's still
  // in pickups[] the engine will say so next run).
  assert.equal(unbookedPickups(pickups, [D('m1', 'DONE', { source: 'RENTAL-RETURN', serial: '900107' })]).length, 2);
  assert.deepEqual(unbookedPickups([], dispatch), []);
});

console.log(`\n${passed} checks passed.`);
