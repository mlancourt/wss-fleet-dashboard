#!/usr/bin/env node
/**
 * selftest-notes.mjs — the v2.4 Notes timeline logic.
 *
 * The rule this file defends: a log row's `ts` is a DISPLAY STRING the engine
 * already formatted for a Central reader, in one of two shapes —
 * "2026-09-04 11:09 CT" or a bare "2026-09-03". It is neither an instant to
 * format nor a business date to reformat, and handing it to `new Date()` is the
 * bug CLAUDE.md calls disqualifying. Nothing here parses it; nothing re-sorts
 * on it.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { logRows, hasLog, pendingNotes, MAX_LOG_ROWS } from '../docs/notes.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

console.log('notes self-test');

const R = (ts, who, text) => ({ ts, who, text });

/* ------------------------------------------------------------- log rows -- */

check('rows come back in the order the engine sent them — never re-sorted', () => {
  // Deliberately mixed shapes, exactly as the real snapshot mixes them. A sort
  // would put the bare date somewhere else and separate a tech's answer from
  // the import note it answers.
  const t = {
    log: [
      R('2026-09-03 10:55 CT', 'Mission', 'opened by Mission Control'),
      R('2026-09-03', null, 'import note: called in by the plant manager'),
      R('2026-09-04 09:44 CT', 'Josh', 'Josh RECEIVED → IN-PROGRESS: found multiple issues'),
    ],
  };
  assert.deepEqual(logRows(t).map((r) => r.text), t.log.map((r) => r.text));
  assert.equal(logRows(t)[0].ts, '2026-09-03 10:55 CT', 'the CT stamp survives verbatim');
  assert.equal(logRows(t)[1].ts, '2026-09-03', 'and so does a bare date');
});

check('a row with no author is kept — a third of the real ones have none', () => {
  const rows = logRows({ log: [R('2026-09-03', null, 'import note'), R('2026-09-03', '', 'another')] });
  assert.equal(rows.length, 2, 'an authorless row is history, not noise');
  assert.equal(rows[0].who, null);
  assert.equal(rows[1].who, null, 'an empty string normalises to null, so the chip simply does not draw');
});

check('a row with no text is dropped — an empty bubble says nothing', () => {
  const rows = logRows({ log: [R('2026-09-03', 'Josh', ''), R('2026-09-03', 'Josh', '   '), R('2026-09-03', 'Josh', 'real')] });
  assert.deepEqual(rows.map((r) => r.text), ['real']);
});

check('missing, null and malformed logs are all just "no notes"', () => {
  for (const entity of [null, undefined, {}, { log: null }, { log: 'nope' }, { log: [] }]) {
    assert.deepEqual(logRows(entity), []);
    assert.equal(hasLog(entity), false);
  }
  // Junk inside the array is skipped rather than thrown on.
  assert.deepEqual(logRows({ log: [null, 'x', 42, R('2026-09-03', 'Josh', 'kept')] }).map((r) => r.text), ['kept']);
  assert.equal(hasLog({ log: [R('2026-09-03', null, 'kept')] }), true);
});

check('a runaway log is capped at 30, keeping the RECENT end', () => {
  const long = { log: Array.from({ length: 45 }, (_, i) => R('2026-09-03', 'Josh', `entry ${i}`)) };
  const rows = logRows(long);
  assert.equal(rows.length, MAX_LOG_ROWS);
  assert.equal(rows[0].text, 'entry 15', 'the oldest are dropped, not the newest');
  assert.equal(rows[rows.length - 1].text, 'entry 44');
  // At or under the cap nothing is touched.
  assert.equal(logRows({ log: long.log.slice(0, 30) }).length, 30);
});

check('ts and who are trimmed but never reformatted', () => {
  const rows = logRows({ log: [R('  2026-09-04 11:09 CT  ', '  Josh  ', '  the text  ')] });
  assert.equal(rows[0].ts, '2026-09-04 11:09 CT');
  assert.equal(rows[0].who, 'Josh');
  assert.equal(rows[0].text, 'the text');
  // The one thing that must never happen to this field.
  assert.ok(!Number.isNaN(Date.parse('2026-09-04')), 'sanity: Date.parse works on the bare shape');
  assert.ok(Number.isNaN(Date.parse(rows[0].ts)), 'the CT shape is not even parseable — proof it must stay text');
});

/* -------------------------------------------------------- pending notes -- */

check('pending notes come from the note payload, attributed to the actor', () => {
  const evs = [
    { id: 'e1', actor: 'Josh', action: 'ticket_update', payload: { ticket: 'S1', note: 'Pump landed early' } },
    { id: 'e2', actor: 'Kevin', action: 'ticket_update', payload: { ticket: 'S1', stage: 'CONTACTED' } },
    { id: 'e3', actor: 'Matt', action: 'lead_close', payload: { lead: 'L1', outcome: 'LOST', note: 'Went elsewhere' } },
  ];
  const out = pendingNotes(evs);
  assert.deepEqual(out.map((n) => n.text), ['Pump landed early', 'Went elsewhere'],
    'a stage move with no note contributes nothing');
  assert.deepEqual(out.map((n) => n.who), ['Josh', 'Matt']);
  assert.deepEqual(out.map((n) => n.id), ['e1', 'e3'], 'the id rides along so Undo can address it');
});

check('pending notes survive a missing payload, actor or list', () => {
  assert.deepEqual(pendingNotes(null), []);
  assert.deepEqual(pendingNotes([]), []);
  assert.deepEqual(pendingNotes([{}, { payload: null }, { payload: {} }, { payload: { note: '  ' } }]), []);
  assert.deepEqual(pendingNotes([{ payload: { note: 'orphan' } }]), [{ id: null, who: null, text: 'orphan' }]);
});

console.log(`\n${passed} checks passed.`);
