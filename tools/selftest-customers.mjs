#!/usr/bin/env node
/** selftest-customers.mjs — D115: the pure rules behind the customer lookup. Run: npm test */
import assert from 'node:assert/strict';
import { searchCustomers, pushRecent, docStatus, docTitle, salesCaption, onTracker, fmtCents, SEARCH_LIMIT, searchUnits, recentKind, customerMatches, ticketCustomerLink, UNIT_LIMIT } from '../docs/customers.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
console.log('customers self-test (D115 · D128)');

const index = { built: 'x', count: 4, customers: [
  { id: '1', name: 'Acme Foods', company: null, city: 'Ixonia', last: '2026-10-01' },
  { id: '2', name: 'Acme Dental', company: 'Acme Dental LLC', city: 'Waukesha', last: null },
  { id: '3', name: 'Bluebird Logistics', company: null, city: null, last: '2026-09-09' },
  { id: '4', name: 'Café Résumé', company: null, city: 'Milwaukee', last: null },
] };

await check('search: every word must match across name · company · city; empty → []; accents fold; capped', async () => {
  assert.deepEqual(searchCustomers(index, 'acme').map((c) => c.id), ['1', '2']);
  assert.deepEqual(searchCustomers(index, 'acme wauk').map((c) => c.id), ['2'], 'city narrows');
  assert.deepEqual(searchCustomers(index, 'llc').map((c) => c.id), ['2'], 'company counts');
  assert.deepEqual(searchCustomers(index, 'cafe resume').map((c) => c.id), ['4'], 'accents fold');
  assert.deepEqual(searchCustomers(index, '   '), []);
  assert.deepEqual(searchCustomers(null, 'acme'), []);
  const big = { customers: Array.from({ length: 60 }, (_, i) => ({ id: String(i), name: `Zed ${i}` })) };
  assert.equal(searchCustomers(big, 'zed').length, SEARCH_LIMIT);
  assert.equal(searchCustomers(big, 'zed', 3).length, 3);
});

await check('recent: newest first, de-duplicated, capped at 5, junk tolerated', async () => {
  let r = pushRecent(null, { id: 1, name: 'A', city: 'X' });
  r = pushRecent(r, { id: '2', name: 'B' });
  r = pushRecent(r, { id: 1, name: 'A again' });
  assert.deepEqual(r.map((x) => x.id), ['1', '2']);
  assert.equal(r[0].name, 'A again');
  for (let i = 3; i < 10; i++) r = pushRecent(r, { id: i, name: String(i) });
  assert.equal(r.length, 5);
  assert.deepEqual(pushRecent('junk', null), []);
  assert.deepEqual(pushRecent([{ id: 7 }, 'x', null], null).map((x) => x.id), [7]);
});

await check('docs: status chips, titles, cents', async () => {
  assert.deepEqual(docStatus({ status: 'PAID' }), { label: 'paid', tone: 'paid' });
  assert.deepEqual(docStatus({ status: 'open' }), { label: 'open', tone: 'open' });
  assert.deepEqual(docStatus({ status: 'VOID' }), { label: 'void', tone: 'void' });
  assert.deepEqual(docStatus({}), { label: '', tone: '' });
  assert.equal(docTitle({ type: 'INVOICE', num: '44115' }), 'INV 44115');
  assert.equal(docTitle({ type: 'SALES-RECEIPT', num: 'WEB-1002' }), 'RCPT WEB-1002');
  assert.equal(docTitle({ num: 'R092526A-1' }), 'DOC R092526A-1', 'numbers are opaque strings');
  assert.equal(fmtCents(314.5), '$314.50');
  assert.equal(fmtCents(0), '$0.00');
  assert.equal(fmtCents(null), '—');
});

await check('salesCaption', async () => {
  assert.equal(salesCaption({ sales_count: 0 }), 'No invoices in QuickBooks yet.');
  assert.equal(salesCaption({ sales_count: 1, first_sale: '2024-03-11', last_sale: '2026-10-01' }), '1 sale · first 2024-03-11 · last 2026-10-01');
  assert.equal(salesCaption({ sales_count: 12, last_sale: '2026-10-01' }), '12 sales · last 2026-10-01');
});

await check('onTracker: exact fold-match on the customer text, open records only, never a substring', async () => {
  const snap = {
    service_queue: [{ ticket: 'S1', customer: 'ACME FOODS ', status: 'OPEN' }, { ticket: 'S2', customer: 'Acme Foods', status: 'CLOSED' }, { ticket: 'S3', customer: 'Acme Foods Inc', status: 'OPEN' }],
    agreements: [{ agreement: 'R1', customer: 'acme foods' }],
    parts_orders: [{ order: 'P1', customer: 'Acme Foods', status: 'OPEN' }, { order: 'P2', customer: 'Acme Foods', status: 'CLOSED' }],
    leads: [{ lead: 'L1', customer: 'Acme Foods, LLC', status: 'OPEN' }, { lead: 'L2', customer: 'Acme Foods', status: 'WON' }],
  };
  const r = onTracker(snap, { name: 'Acme Foods', company: 'Acme Foods, LLC' });
  assert.deepEqual([r.tickets.map((t) => t.ticket), r.agreements.map((a) => a.agreement), r.parts.map((p) => p.order), r.leads.map((l) => l.lead)], [['S1'], ['R1'], ['P1'], ['L1']]);
  assert.deepEqual(onTracker(null, { name: 'x' }).tickets, []);
  assert.deepEqual(onTracker(snap, { name: null }).tickets, []);
});

/* ------------------------------------------------------------------ D128 -- */

const fleet = [
  { serial: '150074', asset_item: 'TR-7', brand: 'Factory Cat', model: 'XR-34', unit_state: 'AVAILABLE' },
  { serial: '1500', asset_item: 'A-1042', brand: 'Kodiak', model: 'K12', unit_state: 'ON-RENT' },
  { serial: '150', asset_item: null, brand: 'Tomcat', model: 'MiniMag', unit_state: 'IN-SHOP' },
  { serial: '220931', asset_item: 'TR-150', brand: 'Factory Cat', model: 'Mag-HD', unit_state: 'AVAILABLE' },
  { serial: '150999', asset_item: null, brand: 'Factory Cat', model: 'XR-34', unit_state: 'RETIRED' },
];

await check('D128 searchUnits: ≥3-char prefix of serial / asset #, every-word over brand·model·asset·serial; exact serial first; RETIRED out; top 10', async () => {
  assert.deepEqual(searchUnits('15', fleet), [], 'below the 3-char floor: nothing');
  assert.deepEqual(searchUnits('  ', fleet), []);
  assert.deepEqual(searchUnits('150', fleet).map((u) => u.serial), ['150', '1500', '150074', '220931'], 'exact serial, then prefix hits by serial, then the word hit (asset TR-150); RETIRED 150999 excluded');
  assert.deepEqual(searchUnits('tr-1', fleet).map((u) => u.serial), ['220931'], 'asset # prefix, case-folded');
  assert.deepEqual(searchUnits('factory xr', fleet).map((u) => u.serial), ['150074'], 'every word, across brand + model');
  assert.deepEqual(searchUnits('cat 150', fleet).map((u) => u.serial), ['150', '150074', '220931'], 'word hits, serial order (Tom*cat* 150 · Factory Cat 150074 · asset TR-150)');
  assert.deepEqual(searchUnits('XR-34', fleet).map((u) => u.serial), ['150074'], 'the RETIRED twin never shows');
  assert.deepEqual(searchUnits('nothing here', fleet), []);
  assert.deepEqual(searchUnits('150', null), []);
  const big = Array.from({ length: 30 }, (_, i) => ({ serial: `9${String(i).padStart(4, '0')}`, unit_state: 'AVAILABLE' }));
  assert.equal(searchUnits('900', big).length, UNIT_LIMIT);
  // prefix beats a word hit even when the word hit sorts earlier by serial
  const mix = [{ serial: '100', brand: 'Abc', model: 'TRX', unit_state: 'AVAILABLE' }, { serial: '200', asset_item: 'TRX-9', unit_state: 'AVAILABLE' }];
  assert.deepEqual(searchUnits('trx', mix).map((u) => u.serial), ['200', '100'], 'prefix before word');
});

await check('D128 recent: unit rows beside customer rows, same cap; a legacy row with no kind reads as a customer', async () => {
  let r = pushRecent([{ id: '7', name: 'Old Row', city: null }], { kind: 'unit', serial: 150074, label: 'Factory Cat XR-34' });
  assert.deepEqual(r[0], { kind: 'unit', serial: '150074', label: 'Factory Cat XR-34' });
  assert.equal(recentKind(r[0]), 'unit'); assert.equal(recentKind(r[1]), 'customer', 'legacy D115 row');
  r = pushRecent(r, { id: 150074, name: 'A customer whose id looks like a serial' });
  assert.equal(r.length, 3, 'a customer id and a unit serial never collide');
  r = pushRecent(r, { kind: 'unit', serial: '150074', label: 'again' });
  assert.equal(r.length, 3); assert.equal(r[0].label, 'again', 'a unit de-dupes on its serial, moves to the top');
  for (let i = 0; i < 6; i++) r = pushRecent(r, { kind: 'unit', serial: `S${i}` });
  assert.equal(r.length, 5, 'one cap for both kinds');
  assert.deepEqual(pushRecent([{ kind: 'unit' }, { kind: 'unit', serial: '1' }, null], null), [{ kind: 'unit', serial: '1' }], 'a unit row with no serial is junk');
});

await check('D128 ticket shortcut: exact fold-match on name or company → 0 / 1 / 2+; customer-owned only', async () => {
  const idx = { customers: [
    { id: '1', name: 'Acme Foods', company: null },
    { id: '2', name: 'Fairmont Dairy', company: null },
    { id: '3', name: 'Fairmont Dairy — Jefferson plant', company: 'Fairmont Dairy' },
    { id: '4', name: 'Bluebird', company: 'Bluebird Logistics LLC' },
  ] };
  const T = (customer, owner = 'CUSTOMER') => ({ ticket: 'S1', machine_owner: owner, customer });
  assert.equal(ticketCustomerLink(T('Acme'), idx), null, 'never a substring');
  assert.equal(ticketCustomerLink(T('Nobody Inc'), idx), null, '0 → nothing');
  assert.deepEqual(ticketCustomerLink(T('acme foods'), idx), { href: '#/customer/1', label: '📇 Customer history', count: 1 }, '1 → the card (case folds)');
  assert.deepEqual(ticketCustomerLink(T('Bluebird Logistics, LLC'), idx).href, '#/customer/4', 'company counts; punctuation folds like onTracker');
  const two = ticketCustomerLink(T('Fairmont Dairy'), idx);
  assert.deepEqual(two, { href: '#/customers?q=Fairmont%20Dairy', label: '📇 Customer history (2 matches)', count: 2 }, '2 → the lookup pre-filled');
  assert.equal(ticketCustomerLink(T('Acme Foods', 'WSS'), idx), null, 'a WSS-owned ticket draws nothing');
  assert.equal(ticketCustomerLink(T('Acme Foods'), null), null, 'no index yet → nothing');
  assert.deepEqual(customerMatches(idx, '').map((c) => c.id), []);
});

console.log(`${passed} checks passed.`);
