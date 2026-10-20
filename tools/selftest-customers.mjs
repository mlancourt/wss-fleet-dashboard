#!/usr/bin/env node
/** selftest-customers.mjs — D115: the pure rules behind the customer lookup. Run: npm test */
import assert from 'node:assert/strict';
import { searchCustomers, pushRecent, docStatus, docTitle, salesCaption, onTracker, fmtCents, SEARCH_LIMIT } from '../docs/customers.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
console.log('customers self-test (D115)');

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

console.log(`${passed} checks passed.`);
