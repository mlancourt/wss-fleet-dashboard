#!/usr/bin/env node
/**
 * selftest-dates.mjs — guards CLAUDE.md rule 7.
 *
 * Business dates in the snapshot are date-only Central strings. If anything in
 * docs/dates.js ever routes one through `new Date("YYYY-MM-DD")`, a Central-time
 * user sees the previous day. That bug is disqualifying, so it gets a test.
 *
 * Run: npm test        (no dependencies, no network)
 */
import assert from 'node:assert/strict';
import {
  fmtDate, fmtDateFull, todayCentral, addBusinessDays,
  fmtInstantCentral, hoursSince, fmtMoney,
} from '../docs/dates.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

console.log('date + money self-test');

// --- the timezone trap itself -----------------------------------------------
// Run the whole suite as if the machine were somewhere that would expose a
// UTC-midnight parse. Under TZ=Pacific/Kiritimati (UTC+14) a naive
// new Date("2026-01-01").getDate() is still 1, but under UTC-11 it is Dec 31.
check('date-only strings never shift, in any host timezone', () => {
  for (const d of ['2026-01-01', '2026-03-08', '2026-07-04', '2026-12-31', '2024-02-29']) {
    const [y, m, day] = d.split('-');
    assert.equal(fmtDateFull(d).endsWith(`, ${y}`), true, `${d}: wrong year`);
    assert.equal(fmtDate(d).split(' ')[1], String(+day), `${d}: wrong day of month`);
    assert.ok(fmtDate(d).startsWith(
      ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]),
      `${d}: wrong month`);
  }
});

check('formats a known date exactly', () => {
  assert.equal(fmtDate('2026-09-14'), 'Sep 14');
  assert.equal(fmtDateFull('2026-09-14'), 'Sep 14, 2026');
  assert.equal(fmtDate('2026-01-01'), 'Jan 1');
  assert.equal(fmtDateFull('2026-12-31'), 'Dec 31, 2026');
});

check('null / empty / unknown shapes degrade safely', () => {
  assert.equal(fmtDate(null), '');
  assert.equal(fmtDate(undefined), '');
  assert.equal(fmtDate(''), '');
  assert.equal(fmtDateFull(null), '');
  // Anything the engine sends that isn't YYYY-MM-DD renders verbatim, never NaN.
  assert.equal(fmtDate('sometime next week'), 'sometime next week');
  assert.equal(fmtDate('2026-09-14T00:00:00Z'), '2026-09-14T00:00:00Z');
});

// --- +5 business days --------------------------------------------------------
check('addBusinessDays skips Sat/Sun', () => {
  // 2026-09-14 is a Monday.
  assert.equal(addBusinessDays('2026-09-14', 5), '2026-09-21'); // Mon -> next Mon
  assert.equal(addBusinessDays('2026-09-14', 1), '2026-09-15'); // Mon -> Tue
  assert.equal(addBusinessDays('2026-09-17', 1), '2026-09-18'); // Thu -> Fri
  assert.equal(addBusinessDays('2026-09-18', 1), '2026-09-21'); // Fri -> Mon
  assert.equal(addBusinessDays('2026-09-19', 1), '2026-09-21'); // Sat -> Mon
  assert.equal(addBusinessDays('2026-09-20', 1), '2026-09-21'); // Sun -> Mon
});

check('addBusinessDays never lands on a weekend', () => {
  let day = '2026-01-01';
  for (let i = 0; i < 400; i++) {
    const out = addBusinessDays(day, 5);
    const [y, m, d] = out.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    assert.ok(dow !== 0 && dow !== 6, `${day} +5bd -> ${out} is a weekend`);
    day = addBusinessDays(day, 1);
  }
});

check('addBusinessDays crosses month and year ends', () => {
  assert.equal(addBusinessDays('2026-12-28', 5), '2027-01-04'); // Mon -> Mon
  assert.equal(addBusinessDays('2024-02-26', 5), '2024-03-04'); // leap year
});

check('addBusinessDays passes bad input straight through', () => {
  assert.equal(addBusinessDays('not-a-date', 5), 'not-a-date');
  assert.equal(addBusinessDays('', 5), '');
});

// --- instants (these ARE parseable) ------------------------------------------
check('generated_at renders in Central', () => {
  // 2026-09-01T15:04:00Z is 10:04 AM CDT. The separator between date and time
  // differs between Node's ICU and browsers ("," vs "at") — assert the parts.
  const out = fmtInstantCentral('2026-09-01T15:04:00Z');
  assert.ok(out.includes('Sep 1'), out);
  assert.ok(out.includes('10:04') && out.includes('AM'), out);
  assert.equal(fmtInstantCentral('garbage'), 'garbage');
  assert.equal(fmtInstantCentral(null), 'unknown');
});

check('staleness math', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  assert.equal(hoursSince('2026-09-02T12:00:00Z', now), 0);
  assert.equal(hoursSince('2026-09-01T12:00:00Z', now), 24);
  assert.ok(hoursSince('2026-08-31T20:00:00Z', now) > 36);
  assert.equal(hoursSince('garbage', now), 0); // never render a fake warning
});

check('todayCentral shape', () => {
  assert.match(todayCentral(), /^\d{4}-\d{2}-\d{2}$/);
  // 2026-09-02T02:00:00Z is still Sep 1 in Central.
  assert.equal(todayCentral(new Date('2026-09-02T02:00:00Z')), '2026-09-01');
});

check('money', () => {
  assert.equal(fmtMoney(0), '$0');
  assert.equal(fmtMoney(17400), '$17,400');
  assert.equal(fmtMoney(null), '—');
  assert.equal(fmtMoney(undefined), '—');
  assert.equal(fmtMoney(NaN), '—');
});

console.log(`\n${passed} checks passed (TZ=${process.env.TZ || 'system'})`);
