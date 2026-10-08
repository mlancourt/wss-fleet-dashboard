#!/usr/bin/env node
/**
 * selftest-quotes.mjs — D83, machine quotes from the lead card. Drives the
 * shared template (docs/quote-email.js), the status rules (docs/quotes.js) and
 * the REAL worker/worker.js quote paths against an in-memory KV, with Resend's
 * API stubbed at globalThis.fetch. ALL DATA HERE IS FAKE — fake customers, fake
 * machines, fake prices, example.com addresses.
 */
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
import {
  quoteTotals, fmtCents, fmtUsd, longDate, lineRows, renderQuoteEmail, defaultSubject, quoteTerms, NUMBER_PLACEHOLDER,
} from '../docs/quote-email.js';
import { overlayQuote, overlayLeads, quoteState, quoteChipText, mdOf, tokenOf, statusRank } from '../docs/quotes.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

function fakeKV() {
  const m = new Map();
  const meta = new Map();
  return {
    _m: m,
    async get(key, opt) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      const type = typeof opt === 'string' ? opt : opt && opt.type;
      if (type === 'arrayBuffer') return v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : new TextEncoder().encode(v).buffer;
      if (v instanceof Uint8Array) return v;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, v, opts) {
      if (v instanceof ArrayBuffer) v = new Uint8Array(v);
      m.set(key, typeof v === 'string' || v instanceof Uint8Array ? v : String(v));
      if (opts && opts.metadata) meta.set(key, structuredClone(opts.metadata)); else meta.delete(key);
    },
    async delete(key) { m.delete(key); meta.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name })), list_complete: true, cursor: null };
    },
  };
}

const TOK = { owner: 'qtestowner000000000000000000001', sales: 'qtestsales000000000000000000001', service: 'qtestservice0000000000000000001', intake: 'qtestintake00000000000000000001', nosender: 'qtestnosender000000000000000001' };
const WEBHOOK_SECRET = 'whsec_' + Buffer.from('fake-webhook-signing-key-for-tests').toString('base64');
const env = {
  FLEET_KV: fakeKV(), ADMIN_SECRET: 'qtest-admin-secret', RESEND_API_KEY: 're_fake_test_key', RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
  WSS_TAX_RATE: '0.055',
  SENDERS: JSON.stringify({
    Kevin: { mailbox: 'kevin@example.com', name: 'Kevin Example', phone: '(555) 010-0001' },
    Matt: { mailbox: 'matt@example.com', name: 'Matt Example', phone: '(555) 010-0002' },
  }),
};
await env.FLEET_KV.put('tokens', JSON.stringify({
  [TOK.owner]: { name: 'Matt', role: 'owner' }, [TOK.sales]: { name: 'Kevin', role: 'sales' },
  [TOK.service]: { name: 'Josh', role: 'service' }, [TOK.intake]: { name: 'Website-Chat', role: 'intake' },
  [TOK.nosender]: { name: 'Pat', role: 'sales' },
}));

const ORIGIN = 'https://w.example';
const call = async (method, path, { role, body, headers = {}, admin } = {}) => {
  const h = { ...headers };
  if (role) h.Authorization = `Bearer ${TOK[role]}`;
  if (admin) h['X-Admin-Secret'] = env.ADMIN_SECRET;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  return worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }), env);
};
const asJson = async (res) => ({ status: res.status, body: await res.json() });

// ---- fake catalog + snapshot ------------------------------------------------
const CATALOG = {
  built: '2026-10-08T10:00:00-05:00',
  machines: [
    { key: 'acme-x20-walk-behind-scrubber-20-disk', title: 'Acme X20 Walk-Behind Scrubber (20" Disk)', manufacturer: 'Acme', model: 'X20-PA', stock: 'X20-001', category: 'Floor Scrubbers', condition: 'new', list: 5433, series: 'X Series', deck_in: 20, deck_type: 'D', image: null },
    { key: 'zeta-micro-20-disk', title: 'Zeta Micro (20" Disk)', manufacturer: 'Zeta Cat', model: 'ZM-20', stock: 'ZM-20', category: 'Floor Scrubbers', condition: 'new', list: 9139, series: null, deck_in: 20, deck_type: 'D', image: null },
    { key: 'nolist-machine', title: 'No-List Machine', manufacturer: 'Other', model: 'NL', stock: null, category: 'Sweepers', condition: 'new', list: null, series: null, deck_in: null, deck_type: null, image: null },
  ],
  series: { 'X Series': { brand: 'Acme', groups: [{ name: 'Batteries', deck_min: null, deck_max: null, deck_type: null, items: [{ part: 'X-035', description: '130ah WET (2x)', list: 54 }] }] } },
  business: { name: 'Wisconsin Scrub & Sweep', phone: '(555) 010-0000', email: 'info@example.com', street: '1 Fake St', city_line: 'Ixonia, WI 53036', city: 'Ixonia', region: 'WI' },
};
const SNAP = () => ({
  meta: { schema_version: 7 },
  leads: [
    { lead: 'L1034', status: 'OPEN', stage: 'CONTACTED', customer: 'Acme Foods', contact: 'Pat Example', email: 'pat@example.com', value: 5000, potential_commission: 100, quote: null, quotes: [] },
    { lead: 'L1035', status: 'WON', stage: 'INVOICED', customer: 'Beta Co', quote: null, quotes: [] },
  ],
  leads_summary: { money_fields: ['value', 'potential_commission', 'quote.total', 'quotes[].total'], commission_rates: { x: 1 } },
});
await env.FLEET_KV.put('snapshot', JSON.stringify(SNAP()));

// ---- Resend stub --------------------------------------------------------------
const sent = [];
let resendMode = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === 'https://api.resend.com/emails') {
    const body = JSON.parse(init.body);
    if (resendMode === 'fail') return new Response(JSON.stringify({ name: 'validation_error', message: 'API key is invalid' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (resendMode === 'throw') throw new Error('connect ECONNREFUSED');
    sent.push({ body, headers: init.headers });
    return new Response(JSON.stringify({ id: `fake-resend-${sent.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};

const LINES = [
  { kind: 'machine', key: 'acme-x20-walk-behind-scrubber-20-disk', description: 'Acme X20 Walk-Behind Scrubber (20" Disk)', model: 'X20-PA', qty: 1, unit: 5433,
    options: [{ part: 'X-035', description: '130ah WET (2x)', unit: 54 }, { part: 'X-020', description: '33" Squeegee', unit: 0 }] },
  { kind: 'text', description: 'Delivery + setup, Mequon', qty: 1, unit: 250 },
  { kind: 'freight', description: 'Freight', qty: 1, unit: 0 },
];
const PAYLOAD = (extra = {}) => ({ lead: 'L1034', to: 'pat@example.com', cc: [], subject: `Wisconsin Scrub & Sweep — Quote ${NUMBER_PLACEHOLDER} · Acme X20`, lines: LINES, tax: true, note: 'Hi Pat,\n\nHere it is.', valid_days: 30, ...extra });
const send = (role, payload = PAYLOAD()) => call('POST', '/api/event', { role, body: { action: 'quote_send', payload } }).then(asJson);
const kvKeys = () => [...env.FLEET_KV._m.keys()].filter((k) => !k.startsWith('rl:')).sort();

console.log('quotes self-test (D83)');

/* ============================================================ shared modules */

await check('totals in cents: Σ qty·unit + Σ options, tax 5.5% on the lot, rounded to the cent', () => {
  const t = quoteTotals(LINES, true, 0.055);
  assert.equal(t.subtotal, 5737);                 // 5433 + 54 + 0 + 250 + 0
  assert.equal(t.tax, 315.54);                    // 315.535 → .54
  assert.equal(t.total, 6052.54);
  assert.deepEqual(quoteTotals([{ kind: 'machine', qty: 2, unit: 0.1, options: [{ unit: 0.2 }] }], false), { subtotal: 0.4, tax: 0, total: 0.4, tax_rate: 0.055 }, 'no float drift; options ride once, not per qty');
  assert.equal(fmtCents(1299540), '$12,995.40');
  assert.equal(fmtUsd(0), '$0.00');
  assert.equal(longDate('2026-10-08'), 'October 8, 2026');
  const rows = lineRows(LINES);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.level), [0, 1, 1, 0, 0]);
  assert.equal(rows[2].nc, true, 'a $0 option is N/C');
});

await check('the email: one template, escaped, PDF button, pixel only when given (a preview never fires Opened)', () => {
  const q = { number: 'Q2001', date: '2026-10-08', expires: '2026-11-07', valid_days: 30, lines: LINES, tax: true, tax_rate: 0.055,
    note: 'Hi <b>Pat</b>,\n\nline two', sender: { name: 'Kevin Example', mailbox: 'kevin@example.com', phone: '(555) 010-0001' },
    pdf_url: 'https://w.example/q/abc.pdf', pixel_url: 'https://w.example/q/abc/o.gif', business: CATALOG.business };
  const { html, text } = renderQuoteEmail(q);
  assert.ok(html.includes('Hi &lt;b&gt;Pat&lt;/b&gt;'), 'the note is escaped');
  assert.ok(html.includes('href="https://w.example/q/abc.pdf"') && html.includes('View / download quote (PDF)'));
  assert.ok(html.trim().endsWith('</body></html>') && html.lastIndexOf('o.gif') > html.lastIndexOf('View / download'), 'the pixel goes last');
  assert.ok(html.includes('$6,052.54') && html.includes('N/C') && html.includes('Sales tax (5.5%)'));
  assert.ok(html.includes('Prices are valid for 30 days from the quote date'), 'terms block');
  assert.ok(html.includes('(555) 010-0000'), 'terms phone from the catalog business block, never hard-coded');
  assert.ok(text.includes('https://w.example/q/abc.pdf') && text.includes('$6,052.54'), 'plain-text alternative carries the link and the total');
  const preview = renderQuoteEmail({ ...q, number: null, pixel_url: null, pdf_url: null });
  assert.ok(!preview.html.includes('o.gif') && !preview.html.includes('<img'), 'no pixel in a preview');
  assert.ok(preview.html.includes(NUMBER_PLACEHOLDER));
  const exempt = renderQuoteEmail({ ...q, tax: false });
  assert.ok(exempt.html.includes('Tax not included — exempt certificate on file') && exempt.html.includes('$5,737.00'));
  assert.equal(defaultSubject(null, 'Acme X20'), `Wisconsin Scrub & Sweep — Quote ${NUMBER_PLACEHOLDER} · Acme X20`);
  assert.ok(quoteTerms(30, null).includes('Ixonia, WI'));
});

await check('status: VIEWED outranks DELIVERED, EXPIRED outranks both; the chip reads the spec’s words', () => {
  const base = { number: 'Q2001', sent: '2026-10-08', status: 'SENT', pdf: '/q/0123456789abcdef0123456789abcdef.pdf', viewed_count: 0 };
  assert.equal(tokenOf(base), '0123456789abcdef0123456789abcdef');
  assert.equal(quoteChipText(base), 'Q2001 · sent 10/8 · not viewed');
  assert.equal(overlayQuote(base, { delivered_at: '2026-10-08T16:00:00Z' }).status, 'DELIVERED');
  const v = overlayQuote(base, { delivered_at: '2026-10-08T16:00:00Z', viewed_at: '2026-10-09T14:00:00Z', viewed_count: 2 });
  assert.equal(v.status, 'VIEWED'); assert.equal(v.viewed_count, 2);
  assert.equal(quoteState(v).text, 'Viewed 10/9'); assert.equal(quoteState(v).tone, 'strong');
  assert.equal(overlayQuote({ ...base, status: 'EXPIRED' }, { viewed_at: '2026-10-09T14:00:00Z' }).status, 'EXPIRED', 'never moves a status down');
  assert.equal(quoteState(overlayQuote(base, { bounced_at: '2026-10-08T16:00:00Z' })).tone, 'bad');
  assert.equal(quoteState({ ...base, opened_at: '2026-10-09T03:30:00Z' }).text, 'Opened 10/8', 'an instant renders in Central (03:30Z = 10:30 pm the 8th)');
  assert.equal(mdOf('2026-10-09'), '10/9');
  assert.ok(statusRank('EXPIRED') > statusRank('VIEWED') && statusRank('VIEWED') > statusRank('DELIVERED'));
  const leads = [{ lead: 'L1', quote: { ...base }, quotes: [{ ...base }] }];
  assert.equal(overlayLeads(leads, { '0123456789abcdef0123456789abcdef': { viewed_count: 1, viewed_at: '2026-10-09T14:00:00Z' } }), 1);
  assert.equal(leads[0].quote.status, 'VIEWED'); assert.equal(leads[0].quotes[0].viewed_count, 1);
});

/* ================================================================ catalog */

await check('GET /api/catalog: 503 before a push; the push refuses net/disc by path; sales/owner only, token required', async () => {
  assert.equal((await call('GET', '/api/catalog', { role: 'sales' })).status, 503);
  const bad = await asJson(await call('POST', '/api/admin/catalog', { admin: true, body: { ...CATALOG, series: { S: { groups: [{ items: [{ part: 'p', list: 1, net: 0.6 }] }] } } } }));
  assert.equal(bad.status, 400); assert.ok(bad.body.error.includes('catalog.series.S.groups[0].items[0].net'), bad.body.error);
  const bad2 = await call('POST', '/api/admin/catalog', { admin: true, body: { ...CATALOG, machines: [{ key: 'x', DISC: 0.35 }] } });
  assert.equal(bad2.status, 400, 'any case');
  assert.equal((await call('POST', '/api/admin/catalog', { body: CATALOG })).status, 401, 'no secret, no push');
  const ok = await asJson(await call('POST', '/api/admin/catalog', { admin: true, body: CATALOG }));
  assert.equal(ok.status, 200); assert.equal(ok.body.machines, 3);
  const got = await asJson(await call('GET', '/api/catalog', { role: 'sales' }));
  assert.equal(got.status, 200); assert.equal(got.body.machines[1].list, 9139); assert.equal(got.body.tax_rate, 0.055); assert.equal(got.body.valid_days, 30);
  assert.equal((await call('GET', '/api/catalog', { role: 'owner' })).status, 200);
  assert.equal((await call('GET', '/api/catalog', { role: 'service' })).status, 403, 'E: service 403');
  assert.equal((await call('GET', '/api/catalog', { role: 'intake' })).status, 403);
  assert.equal((await call('GET', '/api/catalog')).status, 401, 'G: not reachable without a token');
});

/* ============================================================= quote_send */

let first;
await check('quote_send: renders, sends via Resend from the sender (Bcc + Reply-To), stores PDF + record + event; totals are the Worker’s', async () => {
  const r = await send('sales');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  first = r.body;
  const res = first.result;
  assert.equal(res.number, 'Q2001', 'the seq starts at 2001');
  assert.match(res.token, /^[0-9a-f]{32}$/);
  assert.equal(res.subtotal, 5737); assert.equal(res.tax, 315.54); assert.equal(res.total, 6052.54);
  assert.equal(res.by, 'Kevin'); assert.equal(res.pdf, `/q/${res.token}.pdf`);
  assert.match(res.expires, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(first.actor, 'Kevin'); assert.equal(first.action, 'quote_send');
  const mail = sent[0].body;
  assert.equal(mail.from, 'Kevin Example <kevin@example.com>');
  assert.deepEqual(mail.bcc, ['kevin@example.com'], 'Kevin keeps his own copy');
  assert.equal(mail.reply_to, 'kevin@example.com');
  assert.deepEqual(mail.to, ['pat@example.com']);
  assert.equal(mail.subject, 'Wisconsin Scrub & Sweep — Quote Q2001 · Acme X20', 'the Q---- placeholder becomes the number');
  assert.deepEqual(mail.tags, [{ name: 'quote', value: 'Q2001' }]); assert.equal(mail.headers['X-WSS-Quote'], 'Q2001');
  assert.ok(mail.html.includes(`${ORIGIN}/q/${res.token}.pdf`) && mail.html.includes(`${ORIGIN}/q/${res.token}/o.gif`));
  assert.ok(mail.text.includes(`${ORIGIN}/q/${res.token}.pdf`));
  assert.ok(!('attachments' in mail), 'no attachment — the link is the view signal (Q2)');
  assert.equal(sent[0].headers['Idempotency-Key'], `quote-${res.token}`);
  const pdf = await env.FLEET_KV.get(`quotepdf:${res.token}`, 'arrayBuffer');
  assert.equal(new TextDecoder().decode(new Uint8Array(pdf).slice(0, 5)), '%PDF-');
  const rec = await env.FLEET_KV.get(`quote:${res.token}`, 'json');
  assert.equal(rec.resend_id, 'fake-resend-1'); assert.equal(rec.lead, 'L1034'); assert.equal(rec.total, 6052.54);
  assert.equal(await env.FLEET_KV.get('quotenum:Q2001'), res.token);
  assert.ok(await env.FLEET_KV.get(`evt:${first.id}`), 'the event is stored for the engine');
});

await check('a catalog key alone fills title, model and list from the catalog; an unknown key needs its own description + price', async () => {
  const r = await send('owner', PAYLOAD({ lines: [{ kind: 'machine', key: 'zeta-micro-20-disk' }] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.result.number, 'Q2002');
  assert.deepEqual(r.body.payload.lines[0], { kind: 'machine', key: 'zeta-micro-20-disk', description: 'Zeta Micro (20" Disk)', model: 'ZM-20', qty: 1, unit: 9139, options: [] });
  assert.equal(sent.at(-1).body.from, 'Matt Example <matt@example.com>', "Matt's token sends as Matt");
  const unknown = await send('sales', PAYLOAD({ lines: [{ kind: 'machine', key: 'not-in-catalog' }] }));
  assert.equal(unknown.status, 400); assert.ok(unknown.body.error.includes('not in the catalog'));
  const freeText = await send('sales', PAYLOAD({ lines: [{ kind: 'machine', key: 'not-in-catalog', description: 'Special order', unit: 100 }] }));
  assert.equal(freeText.status, 201, 'free-text fallback');
  const noList = await send('sales', PAYLOAD({ lines: [{ kind: 'machine', key: 'nolist-machine' }] }));
  assert.equal(noList.status, 400); assert.ok(noList.body.error.includes('no list price'));
});

await check('F: Resend refuses → 500 with Resend’s message, no number consumed, nothing in KV, no event (both failure paths)', async () => {
  const before = kvKeys();
  const seq = await env.FLEET_KV.get('quote:seq');
  for (const mode of ['fail', 'throw']) {
    resendMode = mode;
    const r = await send('sales');
    assert.equal(r.status, 500);
    assert.ok(r.body.error.includes(mode === 'fail' ? 'API key is invalid' : 'ECONNREFUSED'), r.body.error);
    assert.equal(await env.FLEET_KV.get('quote:seq'), seq, 'the seq is released');
    assert.deepEqual(kvKeys(), before, 'nothing stored');
  }
  resendMode = 'ok';
  const next = await send('sales');
  assert.equal(next.body.result.number, `Q${Number(seq) + 1}`, 'the next send takes the number the failures released');
});

await check('refusals before anything is minted: roles, sender, config, lead, shape (spec §3 rejects)', async () => {
  const seq = await env.FLEET_KV.get('quote:seq');
  const sentN = sent.length;
  const r = async (role, payload, status, hint) => {
    const x = await send(role, payload);
    assert.equal(x.status, status, `${hint}: ${JSON.stringify(x.body)}`);
    if (hint) assert.ok(String(x.body.error).toLowerCase().includes(hint.toLowerCase()), `${hint} — got ${x.body.error}`);
  };
  await r('service', PAYLOAD(), 403, 'role service');
  await r('intake', PAYLOAD(), 403, 'role intake');
  await r('nosender', PAYLOAD(), 403, 'no sending mailbox');
  await r('sales', PAYLOAD({ lead: 'L9999' }), 400, 'not on the board');
  await r('sales', PAYLOAD({ lead: 'L1035' }), 400, 'WON');
  await r('sales', PAYLOAD({ lines: [] }), 400, 'at least one line');
  await r('sales', PAYLOAD({ to: 'not-an-email' }), 400, 'not an email');
  await r('sales', PAYLOAD({ lines: Array.from({ length: 26 }, () => ({ kind: 'text', description: 'x', unit: 1 })) }), 400, 'limited to 25');
  await r('sales', PAYLOAD({ lines: [{ kind: 'text', description: 'x', unit: -1 }] }), 400, 'negative');
  await r('sales', PAYLOAD({ lines: [{ kind: 'text', description: 'x', unit: '12' }] }), 400, 'must be a number');
  await r('sales', PAYLOAD({ lines: [{ kind: 'text', description: 'x', unit: 1, options: [] }] }), 400, 'options ride only');
  await r('sales', PAYLOAD({ total: 1 }), 400, 'does not take total');
  await r('sales', PAYLOAD({ note: 'x'.repeat(4001) }), 400, 'too long');
  await r('sales', PAYLOAD({ subject: 'x'.repeat(201) }), 400, 'too long');
  await r('sales', PAYLOAD({ lines: [{ kind: 'machine', description: 'x', unit: 1, price: 5 }] }), 400, '"price"');
  await r('sales', PAYLOAD({ cc: ['a@example.com', 'bad'] }), 400, 'cc[1]');
  const noKey = { ...env.RESEND_API_KEY };
  delete env.RESEND_API_KEY;
  await r('sales', PAYLOAD(), 503, 'not configured');
  env.RESEND_API_KEY = 're_fake_test_key';
  void noKey;
  assert.equal(await env.FLEET_KV.get('quote:seq'), seq, 'no refusal consumes a number');
  assert.equal(sent.length, sentN, 'and none sends');
});

await check('quote_view is never accepted from a phone; a sent quote cannot be undone', async () => {
  const v = await asJson(await call('POST', '/api/event', { role: 'owner', body: { action: 'quote_view', payload: { token: first.result.token, kind: 'viewed' } } }));
  assert.equal(v.status, 400); assert.equal(v.body.error, 'unknown action');
  const u = await asJson(await call('DELETE', `/api/event/${encodeURIComponent(first.id)}`, { role: 'sales' }));
  assert.equal(u.status, 403); assert.ok(u.body.error.includes('cannot be undone'));
  assert.ok(await env.FLEET_KV.get(`evt:${first.id}`), 'still there');
});

/* ======================================================== customer routes */

const qEvents = async () => (await Promise.all((await env.FLEET_KV.list({ prefix: 'evt:' })).keys.map((k) => env.FLEET_KV.get(k.name, 'json')))).filter((e) => e.action === 'quote_view');

await check('GET /q/<token>.pdf: the PDF inline as WSS-Quote-Q2001.pdf, Viewed stamped + counted, a quote_view event as actor customer', async () => {
  const t = first.result.token;
  const res = await call('GET', `/q/${t}.pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/pdf');
  assert.equal(res.headers.get('Content-Disposition'), 'inline; filename="WSS-Quote-Q2001.pdf"');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(0, 5)), '%PDF-');
  let st = await env.FLEET_KV.get(`quoteview:${t}`, 'json');
  assert.equal(st.viewed_count, 1); assert.ok(st.viewed_at);
  await call('GET', `/q/${t}.pdf`);
  st = await env.FLEET_KV.get(`quoteview:${t}`, 'json');
  assert.equal(st.viewed_count, 2);
  const ev = (await qEvents()).filter((e) => e.payload.kind === 'viewed');
  assert.equal(ev.length, 2);
  assert.equal(ev[0].actor, 'customer'); assert.equal(ev[0].role, 'customer');
  assert.deepEqual([ev[0].payload.lead, ev[0].payload.number, ev[0].payload.token], ['L1034', 'Q2001', t]);
  assert.deepEqual(ev.map((e) => e.payload.viewed_count).sort(), [1, 2], 'each view carries its running count (same-ms events may list in either order — the engine takes the max)');
  // HEAD (a link scanner) and a crew read (?t=) serve without stamping.
  assert.equal((await call('HEAD', `/q/${t}.pdf`)).status, 200);
  assert.equal((await call('GET', `/q/${t}.pdf?t=${TOK.sales}`)).status, 200);
  assert.equal((await env.FLEET_KV.get(`quoteview:${t}`, 'json')).viewed_count, 2, 'neither counts as the customer looking');
  assert.equal((await call('GET', `/q/${'0'.repeat(32)}.pdf`)).status, 404);
  assert.equal(await (await call('GET', '/q/nope.pdf')).text(), 'not found', 'plain text, not JSON');
});

await check('GET /q/<token>/o.gif: a 1×1 GIF, Opened stamped once, one event', async () => {
  const t = first.result.token;
  const res = await call('GET', `/q/${t}/o.gif`);
  assert.equal(res.status, 200); assert.equal(res.headers.get('Content-Type'), 'image/gif');
  const b = new Uint8Array(await res.arrayBuffer());
  assert.equal(new TextDecoder().decode(b.slice(0, 6)), 'GIF89a');
  await call('GET', `/q/${t}/o.gif`);
  assert.ok((await env.FLEET_KV.get(`quoteview:${t}`, 'json')).opened_at);
  assert.equal((await qEvents()).filter((e) => e.payload.kind === 'opened').length, 1, 'first open only');
});

await check('GET /api/data: the live overlay shows Viewed before the engine runs; service sees no quote money anywhere', async () => {
  // The engine has applied Q2001: the snapshot carries it (SENT, no views yet).
  const snap = SNAP();
  const q = { number: 'Q2001', sent: '2026-10-08', by: 'Kevin', to: 'pat@example.com', total: 6052.54, status: 'SENT', viewed_count: 0, viewed_at: null, pdf: first.result.pdf, expires: first.result.expires };
  snap.leads[0].quote = q; snap.leads[0].quotes = [q];
  await env.FLEET_KV.put('snapshot', JSON.stringify(snap));
  const own = await asJson(await call('GET', '/api/data', { role: 'owner' }));
  const L = own.body.snapshot.leads[0];
  assert.equal(L.quote.status, 'VIEWED'); assert.equal(L.quote.viewed_count, 2); assert.ok(L.quote.opened_at);
  assert.equal(L.quotes[0].viewed_count, 2, 'history rows too');
  assert.equal(L.quote.total, 6052.54, 'owner keeps the money');
  assert.ok(!own.body.pending.some((e) => e.action === 'quote_view'), 'customer views never badge as pending');
  assert.ok(own.body.pending.some((e) => e.action === 'quote_send' && e.payload.lines), 'owner sees the pending send whole');
  const svc = await call('GET', '/api/data', { role: 'service' });
  const raw = await svc.text();
  const body = JSON.parse(raw);
  const S = body.snapshot.leads[0];
  assert.ok(!('total' in S.quote) && !('total' in S.quotes[0]), 'quote.total + quotes[].total stripped (spec §2.1)');
  assert.ok(!('value' in S) && !('potential_commission' in S));
  assert.equal(S.quote.status, 'VIEWED', 'the chip still reads');
  const ps = body.pending.filter((e) => e.action === 'quote_send');
  assert.ok(ps.length && ps.every((e) => !e.payload.lines && !('total' in e.result) && !('subtotal' in e.result) && e.result.number));
  assert.ok(!/6,?052|5,?737|5433|315\.54/.test(raw), 'I: no quote figure anywhere in the service payload');
  assert.ok(!raw.includes('commission_rates') && !raw.includes('money_fields'));
});

await check('rate limit: 30/min/IP on the customer routes', async () => {
  const t = first.result.token;
  const hdr = { 'CF-Connecting-IP': '203.0.113.9' };
  let last;
  for (let i = 0; i < 31; i++) last = await call('GET', `/q/${t}/o.gif`, { headers: hdr });
  assert.equal(last.status, 429);
  assert.equal((await call('GET', `/q/${t}/o.gif`, { headers: { 'CF-Connecting-IP': '203.0.113.10' } })).status, 200, 'per IP');
});

/* ================================================================ webhook */

async function signed(body, { id = `msg_${Math.random().toString(36).slice(2)}`, ts = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET } = {}) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(secret.slice(6), 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`))).toString('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'Content-Type': 'application/json' };
}

await check('Resend webhook: Svix-verified; delivered / bounced stamp the quote and mint quote_view; unmatched or duplicate is a quiet 200', async () => {
  const t = first.result.token;
  const deliv = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-08T15:43:00.000Z', data: { email_id: 'fake-resend-1', tags: { quote: 'Q2001' } } });
  assert.equal((await call('POST', '/api/resend/webhook', { body: deliv, headers: { 'Content-Type': 'application/json' } })).status, 401, 'unsigned');
  const forged = await signed(deliv, { secret: 'whsec_' + Buffer.from('wrong').toString('base64') });
  assert.equal((await call('POST', '/api/resend/webhook', { body: deliv, headers: forged })).status, 401, 'wrong key');
  const stale = await signed(deliv, { ts: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await call('POST', '/api/resend/webhook', { body: deliv, headers: stale })).status, 401, 'replayed an hour later');
  const h = await signed(deliv, { id: 'msg_fixed_1' });
  const ok = await asJson(await call('POST', '/api/resend/webhook', { body: deliv, headers: h }));
  assert.equal(ok.status, 200); assert.equal(ok.body.kind, 'delivered');
  assert.equal((await env.FLEET_KV.get(`quoteview:${t}`, 'json')).delivered_at, '2026-10-08T15:43:00.000Z');
  const dup = await asJson(await call('POST', '/api/resend/webhook', { body: deliv, headers: h }));
  assert.equal(dup.body.duplicate, true, 'a Resend retry is not a second event');
  assert.equal((await qEvents()).filter((e) => e.payload.kind === 'delivered').length, 1);
  // Bounced — matched by the email id alone (array-form tags / no tags at all).
  const t2 = await env.FLEET_KV.get('quotenum:Q2002');
  const bounce = JSON.stringify({ type: 'email.bounced', created_at: '2026-10-08T15:44:00.000Z', data: { email_id: 'fake-resend-2', bounce: { message: 'mailbox does not exist' } } });
  const b = await asJson(await call('POST', '/api/resend/webhook', { body: bounce, headers: await signed(bounce) }));
  assert.equal(b.body.quote, 'Q2002');
  const bs = await env.FLEET_KV.get(`quoteview:${t2}`, 'json');
  assert.equal(bs.bounce_reason, 'mailbox does not exist');
  const be = (await qEvents()).find((e) => e.payload.kind === 'bounced');
  assert.equal(be.payload.reason, 'mailbox does not exist'); assert.equal(be.actor, 'customer');
  const other = JSON.stringify({ type: 'email.delivered', data: { email_id: 'someone-elses-mail', tags: [{ name: 'quote', value: 'Q9999' }] } });
  const o = await asJson(await call('POST', '/api/resend/webhook', { body: other, headers: await signed(other) }));
  assert.equal(o.status, 200); assert.equal(o.body.ignored, 'not a quote');
  const opened = JSON.stringify({ type: 'email.opened', data: {} });
  assert.equal((await asJson(await call('POST', '/api/resend/webhook', { body: opened, headers: await signed(opened) }))).body.ignored, 'email.opened', 'Resend tracking stays off — ignored');
  const saved = env.RESEND_WEBHOOK_SECRET; delete env.RESEND_WEBHOOK_SECRET;
  assert.equal((await call('POST', '/api/resend/webhook', { body: deliv, headers: h })).status, 503, 'fail closed without a secret');
  env.RESEND_WEBHOOK_SECRET = saved;
});

await check('admin: the engine fetches a sent quote’s PDF by token; nobody else can', async () => {
  const t = first.result.token;
  const res = await call('GET', `/api/admin/quotepdf/${t}`, { admin: true });
  assert.equal(res.status, 200); assert.equal(res.headers.get('Content-Type'), 'application/pdf');
  assert.equal((await call('GET', `/api/admin/quotepdf/${t}`, { role: 'owner' })).status, 401);
  assert.equal((await call('GET', `/api/admin/quotepdf/${'f'.repeat(32)}`, { admin: true })).status, 404);
});

globalThis.fetch = realFetch;
console.log(`${passed} checks passed.`);
