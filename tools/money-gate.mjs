#!/usr/bin/env node
/**
 * money-gate.mjs — prove the §6 money gate against a REAL snapshot, end to end
 * through a running Worker, without ever putting one in this repo.
 *
 *   ADMIN_SECRET=… node tools/money-gate.mjs <snapshot.json> [worker-origin]
 *
 * Defaults to http://localhost:8788 (`npm run dev:worker`). It publishes the
 * snapshot you name, fetches `/api/data` as each of the three roles, asserts,
 * and then RESTORES the mock snapshot so no real data is left in the KV it
 * touched. Nothing is written to disk.
 *
 * Why this exists on its own rather than inside m1-loop.sh: m1-loop is the mock
 * loop, and its assertions are pinned to mock ids and counts. Publishing a real
 * snapshot as a side effect of it would put real data in the local KV every
 * time somebody ran the routine test.
 *
 * ---------------------------------------------------------------------------
 * THE ASSERTION THAT MATTERS (v2.5)
 *
 * A `service` token's payload must not carry lead money — not in a field, and
 * not in a sentence. The structured half has been true since v2.2: the Worker
 * deletes `value`, `potential_commission`, `leads_summary.commission_rates`,
 * `leads_summary.money_fields` and `scoreboard.money`.
 *
 * The FREE-TEXT half is newer and is why this file exists. At v2.4 the engine
 * was writing figures into `leads[].log[].text`, which handed the same token
 * the number the fields had just been stripped of. The Worker fixed it by
 * deleting the whole lead log — over-strip, and it cost a tech their own notes.
 * At v2.5 the engine fixed it properly: a lead log row reads "value set" /
 * "value updated", and the builder refuses to publish one carrying a figure.
 * The strip was reversed on the strength of that promise.
 *
 * This file is what holds the promise to account. If a figure ever comes back
 * into a lead log, the right fix is upstream in the engine — not a strip here,
 * and never a regex redaction over free text.
 *
 * TICKET logs are deliberately NOT checked: they carry quote amounts, those are
 * visible to every role by design, and `service_queue[].quote.amount` has
 * rendered for everyone since schema 3.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The figure shape the contract forbids in a lead log. */
const MONEY_RE = /\$\s?\d/;

const file = process.argv[2];
const WORKER = (process.argv[3] || process.env.WORKER || 'http://localhost:8788').replace(/\/+$/, '');
const SECRET = process.env.ADMIN_SECRET || 'dev-admin-secret-not-for-production';

if (!file) {
  console.error('usage: ADMIN_SECRET=… node tools/money-gate.mjs <snapshot.json> [worker-origin]');
  process.exit(2);
}

// Throwaway crew tokens, same shape and values as tools/m1-loop.sh so the two
// can be run back to back against one `wrangler dev`.
const T = {
  sales: 'm1testsales00000000000000000001',
  service: 'm1testservice000000000000000001',
  owner: 'm1testowner00000000000000000001',
};

let passed = 0;
let failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
};

const admin = (p, body) => fetch(`${WORKER}${p}`, {
  method: 'POST',
  headers: { 'X-Admin-Secret': SECRET, 'Content-Type': 'application/json' },
  body,
});
const asRole = (role) => fetch(`${WORKER}/api/data`, { headers: { Authorization: `Bearer ${T[role]}` } });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MOCK = path.join(HERE, '..', 'docs', 'mock', 'mock-full.json');
const realText = fs.readFileSync(file, 'utf8');

console.log(`money gate — ${path.basename(file)} through ${WORKER}\n`);

let tokensRes = await admin('/api/admin/tokens', JSON.stringify({
  [T.sales]: { name: 'Test Kevin', role: 'sales' },
  [T.service]: { name: 'Test Josh', role: 'service' },
  [T.owner]: { name: 'Test Matt', role: 'owner' },
}));
if (!tokensRes.ok) {
  console.error(`  could not load test tokens (${tokensRes.status}). Is the Worker up, and is ADMIN_SECRET right?`);
  process.exit(1);
}

const pub = await admin('/api/admin/publish', realText);
if (!pub.ok) {
  console.error(`  could not publish the snapshot (${pub.status})`);
  process.exit(1);
}
ok(true, `published ${JSON.parse(realText).meta.run_id || 'the snapshot'}`);

try {
  /* ------------------------------------------------------- service token -- */

  const svcRes = await asRole('service');
  const svcText = await svcRes.text();          // the RAW bytes, before any parse
  const svc = JSON.parse(svcText);

  ok(svcRes.status === 200, 'service token reads /api/data');
  ok(!svcText.includes('potential_commission'), "the raw bytes do not contain 'potential_commission'");
  ok(!svcText.includes('commission_rates'), "the raw bytes do not contain 'commission_rates'");

  const leads = svc.snapshot.leads || [];
  ok(leads.every((l) => !('value' in l) && !('potential_commission' in l)),
    `no money field on any of the ${leads.length} leads`);
  ok(!('money' in (svc.snapshot.scoreboard || {})), 'scoreboard.money is gone');
  ok(!('commission_rates' in (svc.snapshot.leads_summary || {})), 'leads_summary.commission_rates is gone');
  ok(!('money_fields' in (svc.snapshot.leads_summary || {})), 'leads_summary.money_fields is gone');

  /* ------ the v2.5 assertion: no figure in the lead-log TEXT ------------- */

  ok(leads.some((l) => Array.isArray(l.log)), 'the lead log survives the gate (v2.5 reversal)');

  const leadRows = leads.flatMap((l) => (l.log || []).map((r) => ({ lead: l.lead, ...r })));
  const withFigure = leadRows.filter((r) => MONEY_RE.test(String(r.text || '')));
  ok(withFigure.length === 0,
    `no lead-log row matches /\\$\\s?\\d/ (${leadRows.length} rows checked)`);
  for (const r of withFigure) console.log(`         ${r.lead}: ${r.text}`);
  if (withFigure.length) {
    console.log('         ^ the engine is writing figures into a lead log again.');
    console.log('           Fix it upstream — do NOT re-add a strip or a redaction here.');
  }

  // Deliberately NOT asserted: "no figure anywhere under leads[]". `machine`
  // and `close_note` are free text a person types, and they legitimately carry
  // figures — a customer's stated budget ("under $18k"), a competitor's price
  // ("came in $2,400 under us"). Neither is our deal value or anybody's
  // commission. The gate covers the structured money and the log rows the
  // ENGINE writes; a sentence somebody typed is theirs, and an assertion that
  // claimed otherwise would fail on honest data and get muted.

  ok(!!svc.snapshot.insights, 'insights still ships — deal size is not commission');
  const tRows = (svc.snapshot.service_queue || []).flatMap((t) => t.log || []);
  ok(tRows.length > 0, `ticket logs untouched (${tRows.length} rows) — a tech keeps their work`);

  /* ------------------------------------------------- sales + owner keep -- */

  const sales = await asRole('sales').then((r) => r.json());
  ok(sales.snapshot.leads.some((l) => typeof l.value === 'number'), 'sales keeps lead values');
  ok(!!sales.snapshot.scoreboard.money, 'sales keeps scoreboard.money');
  ok(sales.snapshot.leads.some((l) => Array.isArray(l.log)), 'sales keeps the lead log');

  const owner = await asRole('owner').then((r) => r.json());
  ok(!!owner.snapshot.scoreboard.money, 'owner keeps scoreboard.money');
} finally {
  // Put the mock back, whatever happened above. Real data does not linger in a
  // KV this script touched.
  const restore = await admin('/api/admin/publish', fs.readFileSync(MOCK, 'utf8'));
  console.log(restore.ok ? '\n  (mock snapshot restored)' : '\n  WARNING: could not restore the mock snapshot');
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
