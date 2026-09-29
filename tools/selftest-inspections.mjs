#!/usr/bin/env node
/**
 * selftest-inspections.mjs — the inspection-sheet rules in docs/inspections.js
 * (D67 machinery; D69: the sheet is the `inspection` block on a work order).
 * Pure: no DOM, no network. Dates and clocks are pinned strings, never "now".
 * The library here is a local fixture: the module never names a row, and this
 * test proves the filtering works from whatever the snapshot carries.
 */
import assert from 'node:assert/strict';
import {
  checklistOf, rowIndex, deriveProfile, rowShows, visibleSections, blockOf, statusOf, isSettled,
  profileOf, cellLayout, parseSg, sheetFrom, overlay, firstHours, doneReady, flagCount, answeredIn, flaggedLabels,
  sectionValue, ctNow, minutesBetween, settledStamp, reopenShown, fmtReading, chipText, chipTone, describeStep,
  SCALES, FLAG_RESULTS,
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

check('a pre-D67 snapshot has no library — null, never a throw', () => {
  assert.equal(checklistOf({}), null);
  assert.equal(checklistOf(null), null);
  assert.equal(checklistOf({ inspection_checklist: { version: null, sections: [] } }), null, 'the engine’s "no sheet" shape is no library');
  assert.equal(checklistOf({ inspection_checklist: { version: '1', sections: LIB } }).length, 3);
  assert.equal(rowIndex(LIB).get('bat.old').retired, '2026-09-20', 'the index keeps retired rows — old sheets carry them');
});

check('D69: the block on a work order — an object; a legacy string / null reads as a blank PENDING sheet', () => {
  assert.equal(blockOf({ inspection: { status: 'DONE', flags: 2 } }).status, 'DONE');
  assert.equal(blockOf({ inspection: { status: 'WEIRD' } }).status, 'PENDING', 'an unknown status is PENDING');
  assert.deepEqual(blockOf({ inspection: 'I1001' }), { status: 'PENDING', legacy: 'I1001' });
  assert.deepEqual(blockOf({ inspection: null }), { status: 'PENDING', legacy: null });
  assert.deepEqual(blockOf({}), { status: 'PENDING', legacy: null });
  assert.equal(statusOf({ inspection: { status: 'SKIPPED' } }), 'SKIPPED');
  assert.ok(isSettled({ inspection: { status: 'DONE' } }) && isSettled({ inspection: { status: 'SKIPPED' } }));
  assert.ok(!isSettled({ inspection: { status: 'PENDING' } }) && !isSettled({ inspection: 'I1001' }));
  const legacy = sheetFrom(blockOf({ inspection: 'I1001' }), { machine_class: 'SWEEPER', body_style: 'RIDER', battery: { type: 'AGM', voltage: 36 } });
  assert.equal(legacy.status, 'PENDING');
  assert.equal(legacy.machine_class, 'SWEEPER', 'derived defaults fill a blank sheet');
  assert.equal(legacy.battery.type, 'AGM');
  assert.equal(legacy.items.size, 0);
  assert.ok(!JSON.stringify({ ...legacy, items: [], cells: [] }).includes('I1001'), 'the I-number is never drawn as the sheet');
  const real = sheetFrom({ status: 'PENDING', machine_class: 'SCRUBBER', battery: { type: null } }, { machine_class: 'SWEEPER' });
  assert.equal(real.machine_class, 'SCRUBBER', 'the vault\'s value beats a default');
});

check('derivation from the category mirrors the engine', () => {
  assert.deepEqual(deriveProfile('Ride-On Sweeper'), { machine_class: 'SWEEPER', body_style: 'RIDER' });
  assert.deepEqual(deriveProfile('Walk-Behind Sweeper'), { machine_class: 'SWEEPER', body_style: 'WALK-BEHIND' });
  assert.deepEqual(deriveProfile('Chariot (Stand-on) Scrubber'), { machine_class: 'SCRUBBER', body_style: 'STAND-ON' });
  assert.deepEqual(deriveProfile('Mid-Size Rider Scrubber'), { machine_class: 'SCRUBBER', body_style: 'RIDER' });
  assert.deepEqual(deriveProfile(null), { machine_class: 'SCRUBBER', body_style: 'WALK-BEHIND' });
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
  status: 'PENDING', machine_class: 'SCRUBBER', body_style: 'WALK-BEHIND',
  battery: { type: 'WET', voltage: 24, pack: '4x6V' }, readings: { hours_key: null, brush1_pct: 60 },
  cells: [{ battery: 1, cell: 'A', sg: 1.265, clarity: 'CLEAR', level: 'FULL' }],
  items: [{ id: 'ctl.key', result: 'IN-SPEC', note: null }, { id: 'sqg.blades', result: 'REPAIR', note: 'rolled' }],
  comments: 'x', flags: 1,
};

check('overlay = the engine’s SAVE merge: a present section replaces, an absent one is untouched', () => {
  const s = sheetFrom(ROW);
  const t = overlay(s, { action: 'INSPECT', step: 'SAVE', work_order: 'W1001', readings: { hours_key: 412.5 } });
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
  assert.deepEqual(Object.keys(r).sort(), ['brush1_pct', 'brush2_pct', 'brushes_rotated', 'head_type', 'hours_key', 'hours_scrub',
    'hours_traction', 'hours_vac', 'main_broom_pct', 'pad_color', 'pad_diameter', 'pad_drivers_needed', 'pad_holders_needed', 'pads_needed'],
  'readings go whole — v1.2: no recharge counter, no lengths; D74: vac meter + scrub head');
  // D74: the pad block is scrubbed unless the head is PAD; diameter / color unless pads are needed.
  const padOn = sectionValue(overlay(s, { readings: { head_type: 'PAD', pads_needed: true, pad_drivers_needed: true, pad_diameter: 17, pad_color: '  red  ' } }), 'readings', LIB);
  assert.equal(padOn.head_type, 'PAD'); assert.equal(padOn.pad_drivers_needed, true); assert.equal(padOn.pad_holders_needed, null);
  assert.equal(padOn.pad_diameter, 17); assert.equal(padOn.pad_color, 'red', 'color trimmed');
  const padOff = sectionValue(overlay(s, { readings: { head_type: 'BRUSH', pads_needed: true, pad_diameter: 17, pad_color: 'red', hours_vac: 12.5 } }), 'readings', LIB);
  assert.equal(padOff.pads_needed, null, 'no pad needs on a BRUSH head'); assert.equal(padOff.pad_color, null); assert.equal(padOff.hours_vac, 12.5, 'vac hours are a meter, decimals kept');
  const noPads = sectionValue(overlay(s, { readings: { head_type: 'PAD', pad_holders_needed: true, pad_diameter: 17, pad_color: 'red' } }), 'readings', LIB);
  assert.equal(noPads.pad_holders_needed, true); assert.equal(noPads.pad_diameter, null, 'diameter only when pads are needed');
  assert.equal(sectionValue(overlay(s, { readings: { head_type: 'DISC' } }), 'readings', LIB).head_type, null, 'an unknown head type drops');
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

const DONE = { ...ROW, status: 'DONE', done: '2026-09-24', tech: 'Josh', flags: 2 };
const LOG = [
  { ts: '2026-09-24 09:02 CT', who: 'Zac', text: 'opened by Zac (RETURN) — 0 part line(s), inspection pending' },
  { ts: '2026-09-24 10:31 CT', who: 'Josh', text: 'inspection DONE by Josh — 412.5 h written to 900100' },
  { ts: '2026-09-24 11:00 CT', who: 'Josh', text: 'Josh logged 1.5 h' },
];

check('Reopen (D69): owner any time; the tech who signed or skipped it, within 24 h; nobody else', () => {
  assert.equal(settledStamp(LOG), '2026-09-24 10:31 CT', 'the latest DONE / SKIPPED bullet, not the last bullet');
  assert.equal(settledStamp([{ ts: '2026-09-24 08:00 CT', text: 'inspection SKIPPED by Zac: gasket only' }]), '2026-09-24 08:00 CT');
  assert.equal(reopenShown(DONE, LOG, 'owner', 'Matt', '2026-10-30 08:00'), true);
  assert.equal(reopenShown(DONE, LOG, 'service', 'Josh', '2026-09-25 10:31'), true, 'exactly 24 h');
  assert.equal(reopenShown(DONE, LOG, 'service', 'Josh', '2026-09-25 10:32'), false, 'a minute past');
  assert.equal(reopenShown(DONE, LOG, 'service', 'Zac', '2026-09-24 11:00'), false, 'the opener is not the tech');
  assert.equal(reopenShown(DONE, LOG, 'sales', 'Kevin', '2026-09-24 11:00'), false, 'sales: no');
  assert.equal(reopenShown(DONE, [], 'service', 'Josh', '2026-09-24 11:00'), false, 'no stamp → owner only');
  const skipped = { ...ROW, status: 'SKIPPED', tech: 'Zac', skipped_reason: 'gasket only' };
  assert.equal(reopenShown(skipped, [{ ts: '2026-09-24 08:00 CT', text: 'inspection SKIPPED by Zac: gasket only' }], 'service', 'Zac', '2026-09-24 09:00'), true, 'the skipper, same window');
  assert.equal(reopenShown(ROW, LOG, 'owner', 'Matt'), false, 'a PENDING sheet does not reopen');
});

check('labels: an hour meter; the 📋 chip — pending (amber) / ✓ n ⚑ / skipped', () => {
  assert.equal(fmtReading(412.5), '412.5');
  assert.equal(fmtReading(412), '412');
  assert.equal(fmtReading(null), '');
  assert.equal(chipText({ status: 'PENDING' }), 'pending');
  assert.equal(chipText({ status: 'DONE', flags: 2 }), '✓ 2 ⚑');
  assert.equal(chipText({ status: 'DONE', flags: 0 }), '✓');
  assert.equal(chipText({ status: 'SKIPPED' }), 'skipped');
  assert.equal(chipTone({ status: 'PENDING' }), 'amber');
  assert.equal(chipTone({ status: 'DONE', flags: 2 }), 'warn');
  assert.equal(chipTone({ status: 'DONE', flags: 0 }), 'ok');
});

check('an INSPECT tap in English', () => {
  assert.equal(describeStep({ step: 'SAVE', readings: {}, items: [] }), 'sheet saved — readings, items');
  assert.equal(describeStep({ step: 'SAVE', machine_class: 'SWEEPER' }), 'sheet saved — machine');
  assert.equal(describeStep({ step: 'DONE', tech: 'Zac' }), 'sheet done (Zac)');
  assert.equal(describeStep({ step: 'SKIP', reason: 'gasket only' }), 'no inspection — gasket only');
  assert.equal(describeStep({ step: 'REOPEN' }), 'sheet reopened');
});

console.log(`${passed} checks passed.`);
