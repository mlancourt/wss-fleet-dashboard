#!/usr/bin/env node
/**
 * selftest-inspections.mjs — the D67 inspection-sheet rules in docs/inspections.js.
 * Pure: no DOM, no network. Dates and clocks are pinned strings, never "now".
 * The library here is a local fixture: the module never names a row, and this
 * test proves the filtering works from whatever the snapshot carries.
 */
import assert from 'node:assert/strict';
import {
  inspectionsOf, inspById, checklistOf, rowIndex, forSerial, deriveProfile, defaultKind, rowShows, visibleSections,
  profileOf, cellLayout, parseSg, sheetFrom, overlay, firstHours, doneReady, flagCount, answeredIn, flaggedLabels,
  sectionValue, ctNow, minutesBetween, doneStamp, reopenShown, voidShown, woPrefill, woButtonShown, fmtReading,
  resumeText, chipText, stripCounts, stripGroups, draftTone, pendingOpens, pendingOpensFor, pendingForInsp, byTs,
  describeInspEvent, SCALES, FLAG_RESULTS, pendingBySerial,
} from '../docs/inspections.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
console.log('inspections self-test');

const LIB = [
  { id: 'bat', title: 'Batteries', rows: [
    { id: 'bat.terminals', label: 'Terminals', scale: 'FUNCTION' },
    { id: 'bat.watering', label: 'Watering', scale: 'FUNCTION', shows_for: { battery: ['WET'] } },
    { id: 'bat.old', label: 'Old gauge', scale: 'FUNCTION', retired: '2026-09-20' },
  ] },
  { id: 'ctl', title: 'Controls', rows: [
    { id: 'ctl.key', label: 'Key switch', scale: 'FUNCTION' },
    { id: 'ctl.horn', label: 'Horn', scale: 'FUNCTION', shows_for: { body_style: ['RIDER', 'STAND-ON'] } },
    { id: 'ctl.seat', label: 'Seat switch', scale: 'FUNCTION', shows_for: { body_style: ['RIDER'] } },
    { id: 'ctl.broom', label: 'Broom lever', scale: 'FUNCTION', shows_for: { class: ['SWEEPER'] } },
    { id: 'ctl.lift', label: 'Side broom lift', scale: 'FUNCTION', shows_for: { class: ['SWEEPER'], body_style: ['RIDER'] } },
  ] },
  { id: 'deck', title: 'Deck', shows_for: { class: ['SCRUBBER'] }, rows: [
    { id: 'deck.curtains', label: 'Curtains', scale: 'WEAR' },
    { id: 'sqg.blades', label: 'Blades', scale: 'FUNCTION' },
  ] },
];
const ids = (vis) => vis.flatMap((s) => s.rows.map((r) => r.id));
const P = (machine_class, body_style, battery_type) => ({ machine_class, body_style, battery_type });

check('a pre-D67 snapshot has no sheets and no library — empty, never a throw', () => {
  assert.deepEqual(inspectionsOf({}), []);
  assert.deepEqual(inspectionsOf(null), []);
  assert.equal(checklistOf({}), null);
  assert.equal(checklistOf({ inspection_checklist: { version: null, sections: [] } }), null, 'the engine’s "no sheet" shape is no library');
  assert.equal(checklistOf({ inspection_checklist: { version: '1', sections: LIB } }).length, 3);
  assert.equal(inspById([{ id: 'I1001' }], 'I1001').id, 'I1001');
  assert.equal(inspById([], 'I1001'), null);
  assert.equal(rowIndex(LIB).get('bat.old').retired, '2026-09-20', 'the index keeps retired rows — old sheets carry them');
});

check('derivation from the category mirrors the engine; the picker default follows §2', () => {
  assert.deepEqual(deriveProfile('Ride-On Sweeper'), { machine_class: 'SWEEPER', body_style: 'RIDER' });
  assert.deepEqual(deriveProfile('Walk-Behind Sweeper'), { machine_class: 'SWEEPER', body_style: 'WALK-BEHIND' });
  assert.deepEqual(deriveProfile('Chariot (Stand-on) Scrubber'), { machine_class: 'SCRUBBER', body_style: 'STAND-ON' });
  assert.deepEqual(deriveProfile('Mid-Size Rider Scrubber'), { machine_class: 'SCRUBBER', body_style: 'RIDER' });
  assert.deepEqual(deriveProfile(null), { machine_class: 'SCRUBBER', body_style: 'WALK-BEHIND' });
  assert.equal(defaultKind({ unit_state: 'ON-RENT', readiness: 'NEEDS-PREP' }), 'RETURN', 'coming back off rent wins');
  assert.equal(defaultKind({ unit_state: 'IN-SHOP', readiness: 'NEEDS-PREP' }), 'CHECKOUT');
  assert.equal(defaultKind({ unit_state: 'AVAILABLE', readiness: 'READY' }), 'PM');
});

check('shows_for filters by class · body_style · battery, on the section and the row; absent = everyone', () => {
  const wb = ids(visibleSections(LIB, P('SCRUBBER', 'WALK-BEHIND', 'WET')));
  assert.deepEqual(wb, ['bat.terminals', 'bat.watering', 'ctl.key', 'deck.curtains', 'sqg.blades']);
  const rider = ids(visibleSections(LIB, P('SCRUBBER', 'RIDER', 'WET')));
  assert.ok(rider.includes('ctl.horn') && rider.includes('ctl.seat'), 'RIDER adds the rider rows');
  assert.ok(wb.every((id) => rider.includes(id)), 'and takes nothing away');
  const sweeper = ids(visibleSections(LIB, P('SWEEPER', 'RIDER', 'AGM')));
  assert.ok(!sweeper.includes('deck.curtains'), 'a section-level class hides the whole deck on a sweeper');
  assert.ok(sweeper.includes('ctl.broom') && sweeper.includes('ctl.lift'), 'class AND body_style both have to fit');
  assert.ok(!sweeper.includes('bat.watering'), 'AGM hides a WET-only row');
  assert.ok(!ids(visibleSections(LIB, P('SWEEPER', 'STAND-ON', 'AGM'))).includes('ctl.lift'));
  assert.equal(visibleSections(LIB, P('SWEEPER', 'WALK-BEHIND', 'LITHIUM')).find((s) => s.section.id === 'deck'), undefined, 'an empty section is dropped');
});

check('a retired row is hidden on a new sheet and drawn on a sheet that carries it', () => {
  const row = LIB[0].rows[2];
  assert.equal(rowShows(LIB[0], row, P('SCRUBBER', 'WALK-BEHIND', 'WET'), new Set()), false);
  assert.equal(rowShows(LIB[0], row, P('SCRUBBER', 'WALK-BEHIND', 'WET'), new Set(['bat.old'])), true);
});

check('the cell grid: WET only, sized by voltage, grouped by pack — 6V = A–C, 12V = A–F', () => {
  const n = (b) => { const l = cellLayout(b); return l ? l.reduce((k, g) => k + g.cells.length, 0) : null; };
  assert.deepEqual(cellLayout({ type: 'WET', voltage: 24, pack: '4x6V' }).map((g) => g.cells.join('')), ['ABC', 'ABC', 'ABC', 'ABC']);
  assert.deepEqual(cellLayout({ type: 'WET', voltage: 24, pack: '2x12V' }).map((g) => g.cells.join('')), ['ABCDEF', 'ABCDEF']);
  assert.equal(n({ type: 'WET', voltage: 36, pack: '3x12V' }), 18);
  assert.equal(cellLayout({ type: 'WET', voltage: 36, pack: '6x6V' }).length, 6);
  assert.equal(n({ type: 'WET', voltage: 24, pack: '4x6V' }), 12, '24V is always 12 cells');
  assert.equal(n({ type: 'WET', voltage: 24, pack: '2x12V' }), 12);
  assert.equal(n({ type: 'WET', voltage: 36, pack: '6x6V' }), 18, '36V is always 18');
  assert.equal(cellLayout({ type: 'AGM', voltage: 24, pack: '4x6V' }), null, 'AGM: no grid');
  assert.equal(cellLayout({ type: 'LITHIUM', voltage: 36, pack: null }), null);
  assert.equal(cellLayout({ type: 'WET', voltage: 24, pack: null }), null, 'no pack yet: no grouping, no grid');
  assert.equal(cellLayout({ type: 'WET', voltage: 36, pack: '4x6V' }), null, 'a pack that does not match the voltage');
});

check('the hydrometer: 1.265 and 1265 both read 1.265; out of 1.000–1.400 is refused', () => {
  assert.equal(parseSg('1.265'), 1.265);
  assert.equal(parseSg('1265'), 1.265, 'gloves: no decimal point');
  assert.equal(parseSg(' 1.2 '), 1.2);
  assert.equal(parseSg(''), null);
  assert.equal(parseSg('1.000'), 1);
  assert.equal(parseSg('1.400'), 1.4);
  assert.ok(Number.isNaN(parseSg('2.0')));
  assert.ok(Number.isNaN(parseSg('0.99')));
  assert.ok(Number.isNaN(parseSg('abc')));
  assert.ok(Number.isNaN(parseSg('1500')));
});

const ROW = {
  id: 'I1001', serial: '900100', kind: 'CHECKOUT', status: 'DRAFT', machine_class: 'SCRUBBER', body_style: 'WALK-BEHIND',
  battery: { type: 'WET', voltage: 24, pack: '4x6V' }, readings: { hours_key: null, brush1_pct: 60 },
  cells: [{ battery: 1, cell: 'A', sg: 1.265, clarity: 'CLEAR', level: 'FULL' }],
  items: [{ id: 'ctl.key', result: 'IN-SPEC', note: null }, { id: 'sqg.blades', result: 'REPAIR', note: 'rolled' }],
  comments: 'x', flags: 1, age_days: 0, log: [],
};

check('overlay = the engine’s SAVE merge: a present section replaces, an absent one is untouched', () => {
  const s = sheetFrom(ROW);
  const t = overlay(s, { action: 'SAVE', inspection: 'I1001', readings: { hours_key: 412.5 } });
  assert.equal(t.readings.hours_key, 412.5);
  assert.equal(t.readings.brush1_pct, null, 'readings is ONE section — replaced whole');
  assert.equal(t.items.size, 2, 'items untouched');
  assert.equal(t.comments, 'x');
  assert.equal(overlay(s, { comments: null }).comments, null, 'a present null clears');
  const agm = overlay(s, { battery: { type: 'AGM', voltage: 24, pack: null } });
  assert.equal(agm.cells.size, 0, 'off a WET pack the cells go, as in the engine');
  assert.equal(overlay(s, { items: [] }).items.size, 0);
  assert.equal(s.items.size, 2, 'the base is never mutated');
});

check('hours: key, else traction, else scrub — Done needs one', () => {
  assert.equal(firstHours({ hours_key: null, hours_traction: 7, hours_scrub: 9 }), 7);
  assert.equal(firstHours({ hours_key: 0 }), 0, 'a zero meter is a reading');
  assert.equal(firstHours({}), null);
  assert.equal(doneReady(sheetFrom(ROW)), false);
  assert.equal(doneReady(overlay(sheetFrom(ROW), { readings: { hours_scrub: 12 } })), true);
});

check('flags and answered counts are over the rows this machine SEES', () => {
  let s = sheetFrom(ROW);
  const vis = visibleSections(LIB, profileOf(s), new Set(s.items.keys()));
  assert.equal(flagCount(s, vis), 1);
  s = overlay(s, { items: [...ROW.items, { id: 'ctl.horn', result: 'PROBLEM' }] });
  assert.equal(flagCount(s, visibleSections(LIB, profileOf(s), new Set())), 1, 'a horn flag on a walk-behind is not on the sheet');
  assert.equal(flagCount(s, visibleSections(LIB, P('SCRUBBER', 'RIDER', 'WET'), new Set())), 2);
  assert.equal(answeredIn(s, LIB[1].rows), 2);
  assert.deepEqual(flaggedLabels(s, LIB), ['Horn', 'Blades'], 'library order');
  for (const v of FLAG_RESULTS) assert.ok(SCALES.FUNCTION.includes(v) || SCALES.WEAR.includes(v));
});

check('a section on the wire: only visible answers, only laid-out cells, the pack only on WET', () => {
  const s = overlay(sheetFrom(ROW), {
    items: [...ROW.items, { id: 'ctl.horn', result: 'PROBLEM' }, { id: 'bat.old', result: 'N/A' }, { id: 'deck.curtains', result: null, note: 'check next time' }],
    cells: [{ battery: 1, cell: 'A', sg: 1.265 }, { battery: 1, cell: 'F', sg: 1.2 }, { battery: 2, cell: 'B', sg: null, clarity: null, level: null }],
  });
  const items = sectionValue(s, 'items', LIB);
  assert.deepEqual(items.map((i) => i.id), ['bat.old', 'ctl.key', 'deck.curtains', 'sqg.blades'],
    'the hidden horn stays in the page; the carried retired row and a note-only row travel');
  assert.deepEqual(sectionValue(s, 'cells', LIB).map((c) => `${c.battery}${c.cell}`), ['1A'], '1F is not on a 6V battery; an empty cell is not sent');
  assert.deepEqual(sectionValue(s, 'battery', LIB), { type: 'WET', voltage: 24, pack: '4x6V' });
  assert.deepEqual(sectionValue(overlay(s, { battery: { type: 'AGM', voltage: 24, pack: '4x6V' } }), 'battery', LIB), { type: 'AGM', voltage: 24, pack: null });
  assert.deepEqual(sectionValue(overlay(s, { battery: { type: 'WET', voltage: 36, pack: '4x6V' } }), 'battery', LIB), { type: 'WET', voltage: 36, pack: null });
  assert.deepEqual(sectionValue(overlay(s, { battery: { type: 'AGM', voltage: 24 } }), 'cells', LIB), [], 'no grid, no cells');
  const r = sectionValue(s, 'readings', LIB);
  assert.deepEqual(Object.keys(r).sort(), ['brush1_pct', 'brush2_pct', 'brushes_rotated', 'hours_key', 'hours_scrub',
    'hours_traction', 'main_broom_pct'], 'readings go whole — v1.2: no recharge counter, no lengths');
  assert.equal(sectionValue(overlay(s, { readings: { hours_key: 5, brush1_pct: 62.6 } }), 'readings', LIB).brush1_pct, 63, 'a percent goes out whole');
  assert.equal(sectionValue(overlay(s, { comments: '   ' }), 'comments', LIB), null, 'a blank box is null');
  assert.equal(sectionValue(s, 'machine_class', LIB), 'SCRUBBER');
  assert.ok(!/\$\s?\d/.test(JSON.stringify(SECTIONS_ALL(s))), 'nothing money-shaped in any section');
});
function SECTIONS_ALL(s) { return ['machine_class', 'body_style', 'battery', 'readings', 'cells', 'items', 'comments'].map((k) => sectionValue(s, k, LIB)); }

check('Central wall clock from Intl parts; minutes between two engine stamps', () => {
  assert.equal(ctNow(new Date('2026-09-25T17:05:00Z')), '2026-09-25 12:05', 'CDT is UTC-5');
  assert.equal(ctNow(new Date('2026-12-25T06:30:00Z')), '2026-12-25 00:30', 'CST is UTC-6, and midnight is 00 not 24');
  assert.equal(minutesBetween('2026-09-24 10:31 CT', '2026-09-25 10:31'), 1440);
  assert.equal(minutesBetween('2026-09-24', '2026-09-25 10:31'), null, 'a date-only stamp is not a clock');
});

const DONE = { ...ROW, status: 'DONE', done: '2026-09-24', tech: 'Josh', opened_by: 'Zac', flags: 2, work_order: null,
  log: [{ ts: '2026-09-24 09:02 CT', who: 'Zac', text: 'OPEN by Zac (CHECKOUT)' }, { ts: '2026-09-24 10:31 CT', who: 'Josh', text: 'DONE by Josh — 412.5 h written back' }] };

check('Reopen: owner any time; the tech who signed it within 24 h of DONE; nobody else', () => {
  assert.equal(doneStamp(DONE), '2026-09-24 10:31 CT');
  assert.equal(reopenShown(DONE, 'owner', 'Matt', '2026-10-30 08:00'), true);
  assert.equal(reopenShown(DONE, 'service', 'Josh', '2026-09-25 10:31'), true, 'exactly 24 h');
  assert.equal(reopenShown(DONE, 'service', 'Josh', '2026-09-25 10:32'), false, 'a minute past');
  assert.equal(reopenShown(DONE, 'service', 'Zac', '2026-09-24 11:00'), false, 'the opener is not the tech');
  assert.equal(reopenShown(DONE, 'sales', 'Kevin', '2026-09-24 11:00'), false, 'sales: no');
  assert.equal(reopenShown({ ...DONE, log: [] }, 'service', 'Josh', '2026-09-24 11:00'), false, 'no DONE stamp → owner only');
  assert.equal(reopenShown(ROW, 'owner', 'Matt'), false, 'a DRAFT does not reopen');
});

check('Void: owner, or the opener while DRAFT', () => {
  assert.equal(voidShown({ ...ROW, opened_by: 'Josh' }, 'service', 'Josh'), true);
  assert.equal(voidShown({ ...ROW, opened_by: 'Josh' }, 'service', 'Zac'), false);
  assert.equal(voidShown({ ...DONE, opened_by: 'Josh' }, 'service', 'Josh'), false, 'the opener loses it at DONE');
  assert.equal(voidShown(DONE, 'owner', 'Matt'), true);
  assert.equal(voidShown({ ...ROW, status: 'VOID' }, 'owner', 'Matt'), false);
});

check('the work order from a sheet: only DONE + flags + no work order; purpose by kind; note ≤ 200', () => {
  assert.equal(woButtonShown(DONE), true);
  assert.equal(woButtonShown({ ...DONE, work_order: 'W1005' }), false);
  assert.equal(woButtonShown({ ...DONE, flags: 0 }), false);
  assert.equal(woButtonShown(ROW), false, 'not on a DRAFT');
  assert.deepEqual(woPrefill(DONE, ['Blades']), { purpose: 'RENT-READY', note: 'from I1001: Blades' });
  assert.equal(woPrefill({ ...DONE, kind: 'PM' }, ['Blades']).purpose, 'REPAIR');
  assert.equal(woPrefill({ ...DONE, kind: 'RETURN' }, ['Blades']).purpose, 'REPAIR');
  const long = woPrefill(DONE, Array.from({ length: 30 }, (_, i) => `Row number ${i}`)).note;
  assert.ok(long.length <= 200 && long.endsWith('…') && long.startsWith('from I1001: '));
});

check('labels: an hour meter, the Resume button, the chip', () => {
  assert.equal(fmtReading(412.5), '412.5');
  assert.equal(fmtReading(412), '412');
  assert.equal(fmtReading(null), '');
  assert.equal(resumeText({ id: 'I1001', kind: 'CHECKOUT', flags: 3 }), 'Resume I1001 · CHECKOUT · 3 ⚑');
  assert.equal(resumeText(null, 'I1009'), 'Resume I1009', 'a draft the list lost still resumes by id');
  assert.equal(chipText({ id: 'I1001', flags: 2 }), '📋 I1001 · 2 ⚑');
  assert.equal(chipText({ id: 'I1001', flags: 0 }), '📋 I1001');
});

check('the strip: the engine summary wins; drafts oldest first; done within the week newest first; amber at 2 days', () => {
  const list = [
    { id: 'I1004', status: 'DRAFT', age_days: 3 }, { id: 'I1005', status: 'DRAFT', age_days: 0 },
    { id: 'I1002', status: 'DONE', done: '2026-09-22' }, { id: 'I1003', status: 'DONE', done: '2026-09-24' },
    { id: 'I1000', status: 'DONE', done: '2026-09-10' },
  ];
  assert.deepEqual(stripCounts({ drafts: 9, done_7d: 8 }, list, '2026-09-18'), { drafts: 9, done7: 8 });
  assert.deepEqual(stripCounts(null, list, '2026-09-18'), { drafts: 2, done7: 2 });
  const g = stripGroups(list, '2026-09-18');
  assert.deepEqual(g.drafts.map((i) => i.id), ['I1004', 'I1005']);
  assert.deepEqual(g.done.map((i) => i.id), ['I1003', 'I1002']);
  assert.equal(draftTone(list, 2), 'amber');
  assert.equal(draftTone([{ status: 'DRAFT', age_days: 1 }], 2), '');
  assert.equal(draftTone([{ status: 'DONE', age_days: 9 }], 2), '', 'only drafts age');
});

check('pending: OPEN keyed on the serial (no invented id); the rest on payload.inspection', () => {
  const P1 = [
    { id: 'b', ts: '2026-09-25T12:02:00Z', action: 'inspection', serial: '900100', payload: { action: 'OPEN', kind: 'PM' } },
    { id: 'a', ts: '2026-09-25T12:01:00Z', action: 'inspection', serial: null, payload: { action: 'SAVE', inspection: 'I1001', comments: 'x' } },
    { id: 'c', ts: '2026-09-25T12:03:00Z', action: 'inspection', serial: null, payload: { action: 'DONE', inspection: 'I1001', tech: 'Josh' } },
    { id: 'd', ts: '2026-09-25T12:04:00Z', action: 'work_order', serial: '900100', payload: { action: 'OPEN', inspection: 'I1001' } },
  ];
  assert.deepEqual(pendingOpens(P1).map((e) => e.id), ['b']);
  assert.deepEqual(pendingOpensFor(P1, 900100).map((e) => e.id), ['b'], 'serial compared as text');
  assert.deepEqual(pendingForInsp(P1, 'I1001').map((e) => e.id), ['a', 'c'], 'a work order is not an inspection event');
  assert.deepEqual([...P1].sort(byTs).map((e) => e.id), ['a', 'b', 'c', 'd']);
  const bySerial = [...P1, { id: 'e', action: 'inspection', serial: '900100', payload: { action: 'DONE', tech: 'Josh' } }];
  assert.deepEqual(pendingBySerial(bySerial, 900100).map((e) => e.id), ['e'], 'D67c: a serial-keyed DONE — not the OPEN, not the work order');
  assert.deepEqual(pendingBySerial(bySerial, '1'), []);
  assert.equal(describeInspEvent(P1[0]), 'new PM sheet');
  assert.equal(describeInspEvent(P1[1]), 'saved comments');
  assert.equal(describeInspEvent(P1[2]), 'done (Josh)');
  assert.equal(describeInspEvent({ payload: { action: 'OPEN', kind: 'RETURN', readings: {}, items: [] } }), 'new Return sheet — readings, items');
});

check('forSerial: newest first — DONE by done, DRAFT by opened', () => {
  const list = [
    { id: 'I1001', serial: '9', status: 'DONE', done: '2026-09-01', opened: '2026-08-30' },
    { id: 'I1003', serial: '9', status: 'DRAFT', opened: '2026-09-20' },
    { id: 'I1002', serial: '9', status: 'DONE', done: '2026-09-10', opened: '2026-09-09' },
    { id: 'I1004', serial: '8', status: 'DRAFT', opened: '2026-09-25' },
  ];
  assert.deepEqual(forSerial(list, 9).map((i) => i.id), ['I1003', 'I1002', 'I1001']);
});

console.log(`${passed} checks passed.`);
