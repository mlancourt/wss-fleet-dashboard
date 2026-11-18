#!/usr/bin/env node
/**
 * selftest-hours.mjs — D134 (hours on every job), the page's pure rules in
 * docs/hours.js. All data FAKE. The gate itself is the engine's; this checks
 * that the page reads the date off the snapshot (never its own), compares
 * date strings as strings, and asks for hours exactly where the spec says.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  hoursFrom, hoursLive, hoursRequired, ticketLabor, ticketHours, linkedWoHours, pendingTicketHours, askHoursOnMove,
  offerCancel, hoursFieldProblem, closeReasonText, woNeedsLabor, ticketLaborPayloads, HOURS_GATED_STAGES, NEED_LABOR_LINE,
} from '../docs/hours.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const S = (from) => ({ meta: from === undefined ? {} : { hours_required_from: from } });

check('the date comes off the snapshot; a pre-D134 snapshot is not live; a bad value is not a date', () => {
  assert.equal(hoursFrom(S('2027-01-01')), '2027-01-01');
  assert.equal(hoursLive(S()), false); assert.equal(hoursLive(null), false); assert.equal(hoursLive(S('Jan 1')), false);
  assert.equal(hoursRequired(S('2027-01-01'), '2026-12-31'), false);
  assert.equal(hoursRequired(S('2027-01-01'), '2027-01-01'), true, 'the day itself is gated');
  assert.equal(hoursRequired(S(), '2099-01-01'), false, 'no date key: never required');
  assert.equal(hoursRequired(S('2027-01-01'), undefined), false);
  const src = fs.readFileSync(new URL('../docs/hours.js', import.meta.url), 'utf8');
  assert.ok(!/2027-01-01/.test(src), 'the page never holds the date');
  assert.ok(!/new Date\(/.test(src), 'and never Date-parses one (rule 7)');
});

check('ticket labor + hours_total read verbatim; a pre-D134 row reads as none', () => {
  assert.deepEqual(ticketLabor({}), []); assert.equal(ticketHours({}), 0); assert.equal(ticketHours({ hours_total: 'x' }), 0);
  assert.equal(ticketHours({ hours_total: 3.25 }), 3.25);
  assert.equal(ticketLabor({ labor: [{ hours: 1 }, null, 'x'] }).length, 1);
});

check('from W… lines: linked work orders that carry hours, nothing else', () => {
  const wos = [{ id: 'W1', ticket: 'S1', hours_total: 2 }, { id: 'W2', ticket: 'S1', hours_total: 0 }, { id: 'W3', ticket: 'S2', hours_total: 4 }];
  assert.deepEqual(linkedWoHours({ ticket: 'S1' }, wos), [{ id: 'W1', hours: 2, text: 'from W1 · 2 h' }]);
  assert.deepEqual(linkedWoHours({ ticket: 'S9' }, wos), []);
  assert.deepEqual(linkedWoHours(null, wos), []);
});

check('the stage sheet asks for hours only on a move into the two gated stages, on a ticket with none, off a D134 snapshot', () => {
  assert.deepEqual([...HOURS_GATED_STAGES].sort(), ['COMPLETE', 'READY-TO-INVOICE']);
  const live = S('2027-01-01');
  assert.equal(askHoursOnMove(live, { hours_total: 0 }, 'READY-TO-INVOICE'), true);
  assert.equal(askHoursOnMove(live, { hours_total: 0 }, 'COMPLETE'), true);
  assert.equal(askHoursOnMove(live, { hours_total: 0 }, 'IN-PROGRESS'), false);
  assert.equal(askHoursOnMove(live, { hours_total: 0.25 }, 'COMPLETE'), false);
  assert.equal(askHoursOnMove(live, { hours_total: 0 }, 'COMPLETE', 1), false, 'pending hours land first');
  assert.equal(askHoursOnMove(S(), { hours_total: 0 }, 'COMPLETE'), false, 'old snapshot: today\'s sheet');
  assert.equal(offerCancel(live, 'COMPLETE'), true); assert.equal(offerCancel(live, 'READY-TO-INVOICE'), false); assert.equal(offerCancel(S(), 'COMPLETE'), false);
  const pend = [{ action: 'ticket_labor', payload: { ticket: 'S1', hours: 1 } }, { action: 'ticket_update', payload: { ticket: 'S1', hours: 1, stage: 'X' } },
    { action: 'ticket_update', payload: { ticket: 'S1', note: 'x' } }, { action: 'ticket_labor', payload: { ticket: 'S2', hours: 1 } }];
  assert.equal(pendingTicketHours(pend, 'S1').length, 2);
});

check('the one hours field: blank/0 is a problem only when required; a bad reading always is', () => {
  assert.equal(hoursFieldProblem('', false), null); assert.equal(hoursFieldProblem('0', false), null);
  assert.ok(hoursFieldProblem('', true)); assert.ok(hoursFieldProblem('0', true));
  for (const bad of ['0.1', '1.3', '12.25', '-1', 'x']) assert.ok(hoursFieldProblem(bad, false), bad);
  for (const good of ['0.25', '1', '12']) assert.equal(hoursFieldProblem(good, true), null, good);
});

check('close words, the work-order Close rule, and the + Hours payloads (TRAVEL first, no damage, no action key)', () => {
  assert.equal(closeReasonText('CANCELLED'), 'cancelled'); assert.equal(closeReasonText('NO-RESPONSE'), 'no response'); assert.equal(closeReasonText(null), null);
  assert.equal(NEED_LABOR_LINE, 'Add labor to close');
  assert.equal(woNeedsLabor({ status: 'OPEN', hours_total: 0 }, true), true);
  assert.equal(woNeedsLabor({ status: 'OPEN', hours_total: 0.25 }, true), false);
  assert.equal(woNeedsLabor({ status: 'OPEN', hours_total: 0 }, false), false, 'before the date');
  assert.equal(woNeedsLabor({ status: 'OPEN', hours_total: 0 }, true, 1), false, 'pending labor counts');
  assert.equal(woNeedsLabor({ status: 'CLOSED', hours_total: 0 }, true), false);
  assert.deepEqual(ticketLaborPayloads({ ticket: 'S1', date: '2026-11-17', who: 'Zac', note: null, travel: 0.5, labor: 1 }), [
    { ticket: 'S1', date: '2026-11-17', who: 'Zac', hours: 0.5, kind: 'TRAVEL', note: null },
    { ticket: 'S1', date: '2026-11-17', who: 'Zac', hours: 1, kind: 'LABOR', note: null }]);
  assert.deepEqual(ticketLaborPayloads({ ticket: 'S1', who: 'Zac', travel: 0, labor: 0 }), []);
});

console.log(`${passed} checks passed.`);
