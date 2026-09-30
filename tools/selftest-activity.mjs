#!/usr/bin/env node
/**
 * selftest-activity.mjs — the D78 Activity tape's pure half (docs/activity.js):
 * day buckets across a Central midnight, your own ⏳ rows and their suppression
 * by evt, routing by record shape, and the pill contrast. Run: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activityGroups, pendingActivityRows, activityRoute, activityTime, dayLabel, pendingLabel,
  ACTOR_COLORS, HUE_BG, actorHue, actorLabel, MAX_ROWS,
} from '../docs/activity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

console.log('activity self-test');

// 2026-09-30 10:00 CDT = 15:00Z. Central midnight is 05:00Z.
const NOW = new Date('2026-09-30T15:00:00Z');
const r = (ts, actor = 'Josh', extra = {}) => ({ ts, actor, role: 'service', action: 'x', verb: null, record: null, text: `t ${ts}`, evt: `e-${ts}`, ...extra });

check('activityGroups: newest first, bucketed by CENTRAL day across a midnight', () => {
  const rows = [
    r('2026-09-30T04:59:00Z'),   // 23:59 CDT on 9/29 → Yesterday
    r('2026-09-30T14:14:02.311Z'),
    r('2026-09-30T05:00:00Z'),   // 00:00 CDT on 9/30 → Today
    r('2026-09-28T17:00:00Z'),   // Mon 9/28
  ];
  const g = activityGroups(rows, NOW);
  assert.deepEqual(g.map((x) => x.label), ['Today', 'Yesterday', 'Mon 9/28']);
  assert.deepEqual(g[0].rows.map((x) => x.ts), ['2026-09-30T14:14:02.311Z', '2026-09-30T05:00:00Z']);
  assert.equal(g[1].rows[0].ts, '2026-09-30T04:59:00Z');
  assert.equal(activityTime('2026-09-30T14:14:02.311Z'), '9:14');
  assert.equal(activityTime('2026-09-30T04:59:00Z'), '11:59');
  assert.equal(activityTime('2026-09-30T05:00:00Z'), '12:00');
});

check('activityGroups: empty, absent, junk rows, and the 40-row cap', () => {
  assert.deepEqual(activityGroups([], NOW), []);
  assert.deepEqual(activityGroups(undefined, NOW), []);
  assert.deepEqual(activityGroups(null, NOW), []);
  assert.deepEqual(activityGroups([null, { ts: 'nope' }, {}], NOW), []);
  const many = Array.from({ length: 55 }, (_, i) => r(new Date(NOW.getTime() - i * 60000).toISOString()));
  assert.equal(activityGroups(many, NOW).flatMap((x) => x.rows).length, MAX_ROWS);
});

check('dayLabel: Today · Yesterday · "Dow M/D" — including across a month and a year', () => {
  assert.equal(dayLabel('2026-09-30', '2026-09-30'), 'Today');
  assert.equal(dayLabel('2026-09-30', '2026-10-01'), 'Yesterday');
  assert.equal(dayLabel('2026-12-31', '2027-01-01'), 'Yesterday');
  assert.equal(dayLabel('2026-09-28', '2026-09-30'), 'Mon 9/28');
  assert.equal(dayLabel('', '2026-09-30'), '');
});

check('activityGroups: your pending rows ride at the TOP of Today, creating it if needed', () => {
  const filed = [r('2026-09-30T14:50:00Z'), r('2026-09-29T15:00:00Z')];
  const mine = [{ ...r('2026-09-30T14:00:00Z', 'Matt'), pending: true }];
  const g = activityGroups(filed, NOW, mine);
  assert.equal(g[0].label, 'Today');
  assert.ok(g[0].rows[0].pending, 'pending first even though a filed row is newer');
  assert.equal(g[0].rows.length, 2);
  const g2 = activityGroups([r('2026-09-29T15:00:00Z')], NOW, mine);
  assert.deepEqual(g2.map((x) => x.label), ['Today', 'Yesterday']);
  assert.equal(activityGroups([], NOW, mine)[0].rows.length, 1);
});

const PENDING = [
  { id: '2026-09-30T14:10:00.000Z:abc123', ts: '2026-09-30T14:10:00.000Z', actor: 'Matt', role: 'owner', action: 'ticket_update', payload: { ticket: 'S1031', note: 'x' } },
  { id: '2026-09-30T14:12:00.000Z:def456', ts: '2026-09-30T14:12:00.000Z', actor: 'Matt', role: 'owner', action: 'work_order', payload: { action: 'LABOR', work_order: 'W1003', hours: 1.5 } },
  { id: '2026-09-30T14:13:00.000Z:ghi789', ts: '2026-09-30T14:13:00.000Z', actor: 'Josh', role: 'service', action: 'doc_attach', payload: { record: 'S1031' } },
  { id: 'x1', ts: '2026-09-30T14:14:00.000Z', actor: 'Matt', role: 'owner', action: 'dispatch_add', payload: {} },
  { id: 'evt-y', ts: '2026-09-30T14:15:00.000Z', actor: 'Matt', role: 'owner', action: 'work_order', serial: '900233', payload: { action: 'INSPECT', step: 'DONE', tech: 'Matt' } },
];

check('pendingActivityRows: only me, newest first, labelled from a small map', () => {
  const rows = pendingActivityRows(PENDING, { name: 'Matt', role: 'owner' }, []);
  assert.deepEqual(rows.map((x) => x.text), ['900233: inspection sent', 'dispatch_add sent', 'W1003: hours logged', 'S1031: update sent']);
  assert.ok(rows.every((x) => x.actor === 'Matt' && x.pending));
  assert.equal(rows[0].verb, 'INSPECT DONE');
  assert.equal(rows[0].record, '900233');
  const josh = pendingActivityRows(PENDING, { name: 'Josh', role: 'service' }, []);
  assert.deepEqual(josh.map((x) => x.text), ['S1031: document attached']);
  assert.deepEqual(pendingActivityRows(PENDING, null, []), []);
  assert.deepEqual(pendingActivityRows(undefined, { name: 'Matt' }, []), []);
  assert.equal(pendingLabel({ action: 'lead_close', payload: { lead: 'L1004' } }), 'L1004: lead_close sent', 'the default label, record still prefixed');
});

check('pendingActivityRows: a filed row with the same evt suppresses the ⏳ one (bare, evt:, evt_ forms)', () => {
  const me = { name: 'Matt', role: 'owner' };
  const bare = pendingActivityRows(PENDING, me, [{ evt: '2026-09-30T14:10:00.000Z:abc123' }]);
  assert.ok(!bare.some((x) => x.record === 'S1031'));
  const keyed = pendingActivityRows(PENDING, me, [{ evt: 'evt:2026-09-30T14:12:00.000Z:def456' }]);
  assert.ok(!keyed.some((x) => x.record === 'W1003'));
  const under = pendingActivityRows(PENDING, me, [{ evt: 'evt_x1' }]);
  assert.ok(!under.some((x) => x.action === 'dispatch_add'));
  assert.equal(pendingActivityRows(PENDING, me, [{ evt: 'someone-else' }]).length, 4);
});

check('activityRoute: by record shape — ticket, lead, work order, our serial; else no link', () => {
  const units = [{ serial: '900233' }, { serial: 150074 }];
  assert.equal(activityRoute('S1031', units), '#/ticket/S1031');
  assert.equal(activityRoute('L1009', units), '#/lead/L1009');
  assert.equal(activityRoute('W1003', units), '#/wo/W1003');
  assert.equal(activityRoute('900233', units), '#/unit/900233');
  assert.equal(activityRoute('150074', units), '#/unit/150074');
  assert.equal(activityRoute('999999', units), null, 'unknown serial');
  assert.equal(activityRoute('m-pu-900128', units), null, 'dispatch id');
  assert.equal(activityRoute('R092526A', units), null, 'agreement');
  assert.equal(activityRoute(4130, units), null, 'int agreement');
  assert.equal(activityRoute(null, units), null);
  assert.equal(activityRoute('', units), null);
  assert.equal(activityRoute('S1031', undefined), '#/ticket/S1031');
});

// WCAG relative luminance, for the pill text (white) on each hue.
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

check('pills: four crew hues all distinct, everyone else grey, never blank; white text ≥ 4.5:1 on every hue', () => {
  const hues = ['Matt', 'Kevin', 'Josh', 'Zac'].map(actorHue);
  assert.equal(new Set(hues).size, 4);
  assert.ok(!hues.includes('grey'));
  assert.equal(actorHue('Architect'), 'grey');
  assert.equal(actorHue(undefined), 'grey');
  assert.equal(actorLabel('Architect'), 'Architect');
  assert.equal(actorLabel(''), '—');
  for (const [hue, bg] of Object.entries(HUE_BG)) {
    const c = contrast('#FFFFFF', bg);
    assert.ok(c >= 4.5, `${hue} ${bg}: ${c.toFixed(2)}:1`);
  }
  for (const h of Object.values(ACTOR_COLORS)) assert.ok(HUE_BG[h], `${h} has a colour`);
  // The CSS must draw the same numbers the contrast check just proved.
  const css = fs.readFileSync(path.join(HERE, '..', 'docs', 'style.css'), 'utf8');
  for (const [hue, bg] of Object.entries(HUE_BG)) {
    assert.ok(new RegExp(`\\.pill-actor\\.h-${hue}\\s*\\{\\s*background:\\s*${bg}`, 'i').test(css), `style.css .pill-actor.h-${hue} is ${bg}`);
  }
});

console.log(`\n${passed} checks passed.`);
