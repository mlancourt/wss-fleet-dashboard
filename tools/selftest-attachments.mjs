#!/usr/bin/env node
/**
 * selftest-attachments.mjs — the schema-6 document row logic (docs/attachments.js).
 *
 * The rules this file defends:
 *   - a doc id IS the content hash, so a row whose id is not 16 lowercase hex
 *     is not a document and must never reach a URL;
 *   - order is the engine's, never ours;
 *   - a missing `docs` key (a schema-5 snapshot still on KV) is [], not a throw;
 *   - `added` is a date-only Central business date and NOTHING here parses it.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  DOC_ID_RE, docRows, hasDocs, docIcon, kindLabel, humanBytes, docUrl,
} from '../docs/attachments.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

console.log('attachments self-test');

const D = (o) => ({ id: 'ab0b83a1b88c21ff', name: 'q.pdf', kind: 'QUOTE', bytes: 25602, added: '2026-09-07', ...o });

/* ----------------------------------------------------------------- rows -- */

check('a missing docs key is [] — a schema-5 snapshot renders unchanged', () => {
  assert.deepEqual(docRows({ ticket: 'S1001' }), []);
  assert.deepEqual(docRows(null), []);
  assert.deepEqual(docRows({ docs: null }), []);
  assert.deepEqual(docRows({ docs: 'nope' }), []);
  assert.equal(hasDocs({ ticket: 'S1001' }), false);
});

check('rows come back in the engine order, never re-sorted', () => {
  const e = { docs: [D({ id: 'ffffffffffffffff', name: 'z.pdf' }), D({ id: '0000000000000000', name: 'a.pdf' })] };
  assert.deepEqual(docRows(e).map((r) => r.name), ['z.pdf', 'a.pdf']);
});

check('a row without a usable id is dropped — the tap could only ever 404', () => {
  const bad = [
    D({ id: 'AB0B83A1B88C21FF' }),      // uppercase: the id is lowercase hex, always
    D({ id: 'ab0b83a1b88c21f' }),       // 15 chars
    D({ id: 'ab0b83a1b88c21fff' }),     // 17
    D({ id: 'zzzzzzzzzzzzzzzz' }),      // not hex
    D({ id: '../snapshot' }),
    D({ id: null }),
    D({ id: undefined }),
  ];
  for (const d of bad) assert.deepEqual(docRows({ docs: [d] }), [], `should drop ${JSON.stringify(d.id)}`);
  assert.equal(docRows({ docs: [...bad, D({})] }).length, 1, 'the good one survives its bad neighbours');
});

check('a nameless or kindless row still renders — it just falls back', () => {
  const [r] = docRows({ docs: [{ id: 'ab0b83a1b88c21ff' }] });
  assert.equal(r.name, 'document');
  assert.equal(r.kind, 'OTHER');
  assert.equal(r.icon, '📄');
  assert.equal(r.size, '', 'no byte count means no size chip, not "NaN KB"');
});

check('nothing here parses `added` — it is a Central date-only string', () => {
  // The row we hand the renderer carries no Date and no reformatted date at
  // all: the doc row shows a size, not a day. If that ever changes it is
  // rendered verbatim (CLAUDE.md rule 7).
  const [r] = docRows({ docs: [D({ added: '2026-09-07' })] });
  assert.ok(!('added' in r) || typeof r.added === 'string');
  assert.ok(!Object.values(r).some((v) => v instanceof Date), 'no Date may exist in a doc row');
});

/* -------------------------------------------------------- icons + labels -- */

check('icons: 📝 for the things you work from, 🖼 for a photo, 📄 for the rest', () => {
  assert.equal(docIcon('WORKORDER'), '📝');
  assert.equal(docIcon('PARTS-LIST'), '📝');
  assert.equal(docIcon('PHOTO'), '🖼');
  for (const k of ['QUOTE', 'PO', 'PM-REPORT', 'SERVICE-TICKET', 'OTHER']) assert.equal(docIcon(k), '📄');
  assert.equal(docIcon('SOMETHING-NEW'), '📄', 'an enum value we have not met falls back, never blank');
});

check('labels are title-cased with the hyphen kept, initialisms left alone', () => {
  assert.equal(kindLabel('QUOTE'), 'Quote');
  assert.equal(kindLabel('PARTS-LIST'), 'Parts-List');
  assert.equal(kindLabel('SERVICE-TICKET'), 'Service-Ticket');
  assert.equal(kindLabel('WORKORDER'), 'Workorder');
  // PM is preventive maintenance and PO is a purchase order. "Pm-Report" and
  // "Po" read as typos on a shop floor, so the two initialisms stay upper.
  assert.equal(kindLabel('PM-REPORT'), 'PM-Report');
  assert.equal(kindLabel('PO'), 'PO');
  assert.equal(kindLabel(''), 'Other');
  assert.equal(kindLabel(undefined), 'Other');
});

/* ----------------------------------------------------------------- size -- */

check('bytes are decimal units, one decimal below 10 — the phone says 26 KB', () => {
  assert.equal(humanBytes(25602), '26 KB');     // the work order's own example
  assert.equal(humanBytes(7180), '7.2 KB');
  assert.equal(humanBytes(1874300), '1.9 MB');
  assert.equal(humanBytes(14000000), '14 MB');
  assert.equal(humanBytes(999), '999 B');
  assert.equal(humanBytes(1000), '1.0 KB');
  assert.equal(humanBytes(0), '0 B');
});

check('a size we cannot read renders as nothing, never as NaN', () => {
  for (const v of [null, undefined, -1, NaN, Infinity, '25602']) assert.equal(humanBytes(v), '');
});

/* ------------------------------------------------------------------ url -- */

check('the doc URL carries the token in ?t= — a new tab cannot send a header', () => {
  const u = docUrl('https://w.example', 'ab0b83a1b88c21ff', 'tok/en+1');
  assert.equal(u, 'https://w.example/api/doc/ab0b83a1b88c21ff?t=tok%2Fen%2B1');
  assert.equal(docUrl('https://w.example/', 'ab0b83a1b88c21ff', 'x'), 'https://w.example/api/doc/ab0b83a1b88c21ff?t=x');
});

check('no Worker, no token, or a junk id -> null, so nothing opens a broken tab', () => {
  assert.equal(docUrl('', 'ab0b83a1b88c21ff', 'x'), null);
  assert.equal(docUrl('https://w.example', 'ab0b83a1b88c21ff', ''), null);
  assert.equal(docUrl('https://w.example', '../snapshot', 'x'), null);
  assert.equal(docUrl('https://w.example', '', 'x'), null);
});

check('DOC_ID_RE is the shape the Worker enforces, character for character', () => {
  assert.ok(DOC_ID_RE.test('ab0b83a1b88c21ff'));
  assert.ok(!DOC_ID_RE.test('AB0B83A1B88C21FF'));
  assert.ok(!DOC_ID_RE.test('ab0b83a1b88c21ff\n'));
});

console.log(`\n${passed} checks passed`);
