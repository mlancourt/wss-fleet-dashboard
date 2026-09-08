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
  DOC_RECORD_RE, CREW_KINDS, KIND_CHOICES, resolveKind, sanitizeName, retypeName,
  cameraName, isImageMime, pendingDocRows,
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

/* ================================================= upload (S2) ============ */

check('a phone may only mint the four crew kinds', () => {
  assert.deepEqual([...CREW_KINDS].sort(), ['OTHER', 'PARTS-LIST', 'PHOTO', 'WORKORDER']);
  // The sheet offers three; PHOTO is worked out, never tapped.
  assert.deepEqual(KIND_CHOICES.map((c) => c.kind), ['WORKORDER', 'PARTS-LIST', 'OTHER']);
  assert.equal(KIND_CHOICES[0].kind, 'WORKORDER', 'the default is what a tech is holding');
});

check('"Other" on an image means PHOTO; on a PDF it stays OTHER', () => {
  assert.equal(resolveKind('OTHER', 'image/jpeg'), 'PHOTO');
  assert.equal(resolveKind('OTHER', 'image/png'), 'PHOTO');
  assert.equal(resolveKind('OTHER', 'application/pdf'), 'OTHER');
  // The named kinds mean themselves whatever the file is.
  assert.equal(resolveKind('WORKORDER', 'image/jpeg'), 'WORKORDER');
  assert.equal(resolveKind('PARTS-LIST', 'application/pdf'), 'PARTS-LIST');
  // A vault kind can never be reached from the phone, even if one is asked for.
  assert.equal(resolveKind('QUOTE', 'application/pdf'), 'OTHER');
  assert.equal(resolveKind('', 'application/pdf'), 'OTHER');
});

check('a record is a ticket or a lead, and nothing else', () => {
  for (const good of ['S1018', 'L1005', 'S0001']) assert.ok(DOC_RECORD_RE.test(good), good);
  for (const bad of ['X1', 'S101', 'S10188', 's1018', 'S1018 ', '../evt', '']) {
    assert.ok(!DOC_RECORD_RE.test(bad), bad);
  }
});

check('names lose path separators, quotes and anything not printable ASCII', () => {
  // It travels in an X-Doc-Name header: a non-Latin-1 byte makes fetch() throw
  // before the request leaves, and a quote would break the Worker's
  // Content-Disposition. Both are the caller's job to prevent, here.
  assert.equal(sanitizeName('../../etc/passwd'), '..-..-etc-passwd');
  assert.equal(sanitizeName('a"b.pdf'), "a'b.pdf");
  assert.equal(sanitizeName('devis-café.pdf'), 'devis-caf_.pdf');
  assert.equal(sanitizeName('C:\\Scans\\wo.pdf'), 'C:-Scans-wo.pdf');
  assert.equal(sanitizeName(''), 'document');
  assert.equal(sanitizeName('   '), 'document');
  assert.equal(sanitizeName(null, 'photo.jpg'), 'photo.jpg');
  assert.ok(sanitizeName('x'.repeat(400)).length <= 120, 'the Worker caps at 120');
});

check('a PNG resized to JPEG stops claiming to be a .png', () => {
  assert.equal(retypeName('IMG_4821.png', 'image/jpeg'), 'IMG_4821.jpg');
  assert.equal(retypeName('diagram', 'image/jpeg'), 'diagram.jpg');
  assert.equal(retypeName('scan.pdf', 'application/pdf'), 'scan.pdf', 'a PDF is untouched');
});

check('a camera capture is named after the record and the minute, in LOCAL time', () => {
  // Local, not UTC, and that is not the CLAUDE.md rule being broken: rule 7 is
  // about timestamps in the DATA. This is a label a person in Ixonia reads, and
  // a 2pm photo named "…-1900" would look wrong to the only people who see it.
  const at = new Date(2026, 8, 8, 14, 32);       // Sep 8 2026, 14:32 local
  assert.equal(cameraName('S1018', 'image/jpeg', at), 'WO-S1018-20260908-1432.jpg');
  assert.equal(cameraName('L1005', 'image/jpeg', new Date(2026, 0, 2, 3, 4)), 'WO-L1005-20260102-0304.jpg');
});

check('isImageMime knows the two the Worker accepts', () => {
  assert.ok(isImageMime('image/jpeg') && isImageMime('image/png'));
  assert.ok(isImageMime('IMAGE/JPEG; charset=x'), 'a parameterised header still counts');
  assert.ok(!isImageMime('application/pdf') && !isImageMime('image/heic') && !isImageMime(''));
});

/* --------------------------------------------------- pending attach rows -- */

const ATT = (record, docId, extra = {}) => ({
  id: `e-${docId}`, action: 'doc_attach', actor: 'Josh',
  payload: { record, doc_id: docId, kind: 'WORKORDER', name: 'wo.pdf', ...extra },
});

check('pending rows are the attaches for THAT record, in submission order', () => {
  const events = [
    ATT('S1001', '1111111111111111'),
    { id: 'z', action: 'ticket_update', payload: { ticket: 'S1001', note: 'x' } },
    ATT('L1005', '2222222222222222'),
    ATT('S1001', '3333333333333333'),
  ];
  const rows = pendingDocRows(events, 'S1001');
  assert.deepEqual(rows.map((r) => r.docId), ['1111111111111111', '3333333333333333']);
  assert.deepEqual(pendingDocRows(events, 'L1005').map((r) => r.docId), ['2222222222222222']);
  assert.deepEqual(pendingDocRows(events, 'S9999'), [], 'a record with none gets none');
  assert.deepEqual(pendingDocRows(events, null), [], 'and no record gets nothing at all');
});

check('a pending row carries the icon and label its kind earns', () => {
  const [r] = pendingDocRows([ATT('S1001', '1111111111111111', { kind: 'PHOTO', name: 'site.jpg' })], 'S1001');
  assert.equal(r.icon, '🖼');
  assert.equal(r.label, 'Photo');
  assert.equal(r.name, 'site.jpg');
  assert.equal(r.who, 'Josh');
});

check('a pending attach with no usable doc_id is dropped, like a filed one', () => {
  // Same rule as docRows: the id is the only part that reaches a URL, and the
  // Worker refused to store the event unless the bytes were there — so a row
  // this malformed is a bug somewhere, and drawing it would hide the bug.
  const bad = [
    ATT('S1001', 'NOTHEXNOTHEXNOTH'),
    { id: 'a', action: 'doc_attach', payload: { record: 'S1001', kind: 'OTHER', name: 'x' } },
    { id: 'b', action: 'doc_attach', payload: null },
    null,
  ];
  assert.deepEqual(pendingDocRows(bad, 'S1001'), []);
});

console.log(`\n${passed} checks passed`);
