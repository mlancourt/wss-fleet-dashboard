#!/usr/bin/env node
/**
 * selftest-render.mjs — renders every view of the real app.js against every
 * mock variant, in a minimal DOM, and fails on a thrown error, an undefined
 * leaking into the markup, or a date-only string that got Date-parsed.
 *
 * This is not a browser: it stubs just enough DOM for app.js to boot. It cannot
 * catch a layout problem — it catches the thing a phone catches too late, which
 * is a view that throws or renders "undefined". Run: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES, STAGE_LABEL, PIPELINE_STAGES, columnsFor, sections as dispatchSections } from '../docs/service.js';
import { BOARD_STAGES, NO_DATA } from '../docs/leads.js';
import { utilization, utilizationFrom } from '../docs/metrics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, '..', 'docs');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

/* ------------------------------------------------------------- tiny DOM -- */

const listeners = new Map();
function el(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(), _html: '', dataset: {}, classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    style: {}, hidden: false, textContent: '', children: [],
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild(c) { this.children.push(c); return c; },
    scrollIntoView() {}, focus() {}, closest: () => null,
  };
  return node;
}
const view = el('main');
const nodes = {
  '#view': view, '#asof': el('span'), '#pending-badge': el('span'),
  '#tab-dispatch-badge': el('span'), '#tab-leads-badge': el('span'),
};

globalThis.window = {
  location: { href: 'http://localhost:8787/?mock=full', hash: '#/', hostname: 'localhost', protocol: 'http:', pathname: '/', search: '?mock=full',
    replace(h) { this.hash = String(h); } },
  addEventListener() {}, scrollTo() {}, history: {}, getSelection: () => null, isSecureContext: false,
};
globalThis.history = { replaceState() {} };
globalThis.location = window.location;
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.sessionStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.CSS = { escape: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '\\$&') };
// Node 22 already defines navigator (getter-only) — app.js only reads it.
/* The image pipeline, stubbed (S2). Node has no canvas and no JPEG encoder, so
 * what these record is the MECHANISM: the dimensions the resize asked for, the
 * encoder settings it asked for, and the EXIF option it passed. Those are the
 * contract. The byte size of a real JPEG is not something a stub can prove, so
 * the stub emits bytes proportional to pixels and the test asserts the
 * dimensions and settings that produce a small file — never a fabricated size
 * dressed up as a measurement. */
const encodes = [];        // {w, h, type, quality}
const bitmapOpts = [];     // the options bag each createImageBitmap call got
let bitmapSize = { width: 4000, height: 3000 };

function canvasEl() {
  const c = {
    tagName: 'CANVAS', width: 0, height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob(cb, type, quality) {
      encodes.push({ w: c.width, h: c.height, type, quality });
      // ~0.05 bytes/px is roughly what q0.7 JPEG costs. Proportional, not real.
      cb(new Blob([new Uint8Array(Math.max(1, Math.round(c.width * c.height * 0.05)))], { type }));
    },
    toDataURL: (type) => `data:${type};base64,/9j/stub`,
  };
  return c;
}

globalThis.createImageBitmap = async (_file, opts) => {
  bitmapOpts.push(opts || null);
  return { ...bitmapSize, close() {} };
};

globalThis.document = {
  querySelector: (sel) => nodes[sel] || null,
  querySelectorAll: () => [],
  addEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).concat(fn)); },
  createRange: () => ({ selectNodeContents() {} }),
  createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? canvasEl() : el(tag)),
  // D52: the map binds its gestures to the injected <svg>. In this DOM there is
  // no element to bind to, so bindMap() finds nothing and returns — which is
  // the point: every assertion below is about the MARKUP the view produces.
  getElementById: (id) => mapNodes[id] || null,
};
const mapNodes = {};

// The page fetches its own mock file relative to docs/.
globalThis.fetch = async (url) => {
  const file = path.join(DOCS, String(url).split('?')[0]);
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

/* --------------------------------------------------------------- harness -- */

const app = await import(path.join(DOCS, 'app.js'));
// app.js runs refresh() on import; wait for the fetch chain to settle.
const settle = () => new Promise((r) => setTimeout(r, 30));
await settle();

const ROUTES = ['#/', '#/rentals', '#/holds', '#/dispatch', '#/service', '#/leads', '#/billing'];

/** Render one route and hand back the markup, failing loudly on a throw. */
async function renderRoute(hash) {
  window.location.hash = hash;
  view._html = '';
  app.__render();
  await settle();
  return view._html;
}

/** Every page a crew member can reach, for one mock variant. */
async function allRoutes(variant, role) {
  window.location.href = `http://localhost:8787/?mock=${variant}&role=${role}&pending=1`;
  window.location.search = `?mock=${variant}&role=${role}&pending=1`;
  await app.__refresh();
  const snap = app.__state().snapshot;
  const out = [];
  const extra = [
    ...snap.units.slice(0, 6).map((u) => `#/unit/${encodeURIComponent(u.serial)}`),
    ...snap.categories.map((c) => `#/cat/${encodeURIComponent(c)}`),
    ...(snap.service_queue || []).map((t) => `#/ticket/${encodeURIComponent(t.ticket || t.ticket_id || '')}`),
    ...(snap.dispatch || []).map((r) => `#/dispatch/${encodeURIComponent(r.id)}`),
    ...(snap.leads || []).map((l) => `#/lead/${encodeURIComponent(l.lead)}`),
    ...(snap.work_orders || []).map((w) => `#/wo/${encodeURIComponent(w.id)}`),
    ...snap.units.filter((u) => u.work_order).map((u) => `#/unit/${encodeURIComponent(u.serial)}`),
    // D67: every sheet, every unit that carries one, and every ⏳ NEW sheet.
    ...(snap.inspections || []).map((i) => `#/inspection/${encodeURIComponent(i.id)}`),
    ...snap.units.filter((u) => u.inspection_draft || u.last_inspection).map((u) => `#/unit/${encodeURIComponent(u.serial)}`),
    ...app.__state().pending.filter((e) => e.action === 'inspection' && e.serial).map((e) => `#/inspection/new/${encodeURIComponent(e.serial)}`),
    '#/unit/nope', '#/ticket/S9999', '#/lead/L9999', '#/wo/W9999', '#/inspection/I9999', '#/inspection/new/nope',
  ];
  for (const hash of ROUTES.concat(extra)) out.push([hash, await renderRoute(hash)]);
  return out;
}

console.log('render self-test');

for (const variant of ['full', 'empty', 'legacy']) {
  for (const who of ['owner', 'service', 'sales']) {
    await check(`every route renders — mock:${variant} as ${who}`, async () => {
      const pages = await allRoutes(variant, who);
      for (const [hash, out] of pages) {
        assert.ok(typeof out === 'string', `${hash} produced no markup`);
        assert.ok(!/undefined|\[object Object\]|NaN/.test(out),
          `${hash} (${variant}/${who}) leaked a placeholder: ${(/.{0,60}(undefined|\[object Object\]|NaN).{0,60}/.exec(out) || [])[0]}`);
        // The disqualifying bug: a date-only string parsed as a Date renders as
        // "Invalid Date" or an off-by-one. Neither string may ever appear.
        assert.ok(!/Invalid Date|GMT|T00:00:00/.test(out), `${hash} (${variant}) Date-parsed a date-only string`);
      }
    });
  }
}

await check('the retired Billing view redirects to Dispatch, never renders billing rows', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  const out = await renderRoute('#/dispatch');
  assert.ok(!/Cycle \(Periodic\) Invoicing|Due next 7 days|Created last run/.test(out));
  // and the snapshot really does still carry billing — we simply don't read it
  assert.ok(app.__state().snapshot.billing, 'mock lost its billing block');
});

await check('Rentals leads with the recurring-revenue block (D21, moved from Billing)', async () => {
  const out = await renderRoute('#/rentals');
  assert.ok(out.includes('Recurring revenue — per 28-day cycle'), 'revenue headline missing');
  // D64: the Agreements list became three groups — revenue still leads all of them.
  assert.ok(out.indexOf('Recurring revenue') < out.indexOf('On rent'), 'revenue must lead the page');
  assert.ok(/≈ \$[\d,]+ \/ month/.test(out), 'per-month sub-line missing');
});

await check('Dispatch shows all three sections and the released-not-booked guard', async () => {
  const out = await renderRoute('#/dispatch');
  for (const s of ['Open', 'Scheduled', 'Done this week']) assert.ok(out.includes(s), `${s} section missing`);
  assert.ok(out.includes('Released, not on the board'), 'the unbooked pick-up must not go quiet');
  assert.ok(out.includes('billed through'), 'a RENTAL-RETURN row must show billed-through');
  // No map links, ever (§4).
  assert.ok(!/maps\.|geo:|google\.com\/maps/.test(out), 'a map link leaked into Dispatch');
});

await check('Service renders every stage, both filters and the pending ticket_open card', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=service&pending=1';
  window.location.search = '?mock=full&role=service&pending=1';
  await app.__refresh();
  const out = await renderRoute('#/service');
  // Derived from the enum, not a hand-copied list — a stage rename must not be
  // able to leave this test asserting yesterday's vocabulary.
  for (const stage of STAGES) {
    assert.ok(out.includes(STAGE_LABEL[stage]), `stage column ${STAGE_LABEL[stage]} missing`);
  }
  // A column header renders whether or not anything is in it, so check the
  // FIXTURE separately: §9 wants a ticket in every stage, and when D42 added
  // SCHEDULED the generator wasn't extended and that column drew empty.
  const stages = new Set(app.__state().snapshot.service_queue.map((t) => t.stage));
  for (const stage of STAGES) {
    assert.ok(stages.has(stage), `mock-full has no ticket in ${stage} — extend make-mock-data.js`);
  }
  assert.ok(out.includes('⏳ NEW —'), 'the pending ticket_open card is missing');
  assert.ok(!/S\?\?\?\?|undefined/.test(out), 'a ticket id was invented for a pending open');
  assert.ok(out.includes('Fleet status'), 'the D20 board must stay at the top of Service');
});

/* ------------------------------------------- service pipeline widget (D43) */

/** Render #/service under one chip. The chip is clicked, not faked, so the
 *  persistence path is exercised too. */
async function serviceUnder(filter) {
  await renderRoute('#/service');
  const fire = listeners.get('click') || [];
  const btn = { dataset: { filter }, closest: (sel) => (sel === '[data-filter]' ? btn : null) };
  for (const fn of fire) await fn({ target: { closest: (sel) => (sel === '[data-filter]' ? btn : null) } });
  return view._html;
}

await check('the landing shows both utilization bars, Units then Dollars (D44/D45)', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  const out = await renderRoute('#/');
  assert.ok(out.includes('Fleet utilization'), 'the card keeps its header');
  const caps = [...out.matchAll(/class="util-cap">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(caps, ['Units', 'Dollars'], 'two captioned bars, units first');
  assert.equal([...out.matchAll(/class="util-track"/g)].length, 2, 'two bars, one card');
  assert.equal([...out.matchAll(/<section class="util"/g)].length, 1, 'one card, not two');

  // The percentages come from meta.utilization, which arrived at schema 4 and
  // is unchanged by schema 5 (leads are purely additive).
  const snap = app.__state().snapshot;
  assert.ok(snap.meta.schema_version >= 4, 'mock-full should be schema 4 or later');
  const u = utilizationFrom(snap);
  assert.equal(u.units.pct, snap.meta.utilization.units.pct, 'engine number, not a recomputation');
  assert.ok(out.includes(`>${u.units.pct}%<`) && out.includes(`>${u.dollars.pct}%<`));
  assert.ok(out.includes(`util-bar util-${u.units.color}`));
  assert.ok(out.includes(`util-bar util-${u.dollars.color}`));

  // mock-full leaves one unit out of the cost ledger, so the footnote shows.
  assert.equal(u.dollars.excluded, 1, 'mock-full should exclude exactly one unit');
  assert.ok(out.includes('1 unit without a cost excluded'), 'the excluded footnote is missing');
});

await check('no costless units -> no footnote (the empty variant)', async () => {
  window.location.href = 'http://localhost:8787/?mock=empty&role=owner';
  window.location.search = '?mock=empty&role=owner';
  await app.__refresh();
  const out = await renderRoute('#/');
  assert.equal(utilizationFrom(app.__state().snapshot).dollars.excluded, 0);
  assert.ok(!out.includes('without a cost excluded'), 'the footnote must hide when nothing was skipped');
  assert.equal([...out.matchAll(/class="util-track"/g)].length, 2, 'both bars still draw');

  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
});

/* ------------------------------------------ cost + book leave the site (D45) */

await check('the dollar bar names what it measures, with no number (D46)', async () => {
  const out = await renderRoute('#/');
  assert.ok(out.includes('Fleet value on rent'), 'the dollar bar caption is missing');
  // it sits in the sub-line slot, like the units bar's own sub-line
  assert.ok(/class="util-s">Fleet value on rent</.test(out), 'caption must use the sub-line slot');
  // and the excluded footnote sits UNDER it
  assert.ok(out.indexOf('Fleet value on rent') < out.indexOf('without a cost excluded'),
    'the footnote belongs under the caption');
});

await check('Dispatch leads with deliveries in Open and inside each Scheduled day (D46)', async () => {
  const rows = app.__state().snapshot.dispatch;
  const out = await renderRoute('#/dispatch');
  const sec = dispatchSections(rows);

  // The Open section draws exactly what the module ordered, in that order.
  const openSec = out.slice(out.indexOf('<h2>Open'), out.indexOf('<h2>Scheduled'));
  const openIds = [...openSec.matchAll(/id="d-([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(openIds, sec.open.map((r) => r.id), 'Open must draw sections().open verbatim');

  // And that order really does lead with deliveries, ahead of an earlier pick-up.
  const kindOf = Object.fromEntries(rows.map((r) => [r.id, r.kind]));
  const kinds = openIds.map((id) => kindOf[id]);
  assert.ok(kinds.includes('DELIVER') && kinds.includes('PICKUP'), 'mock must hold both kinds open');
  assert.ok(kinds.lastIndexOf('DELIVER') < kinds.indexOf('PICKUP'), `Open must lead with deliveries, got ${kinds}`);

  // Inside each Scheduled day, same rule; groups still ascend by date.
  const schedSec = out.slice(out.indexOf('<h2>Scheduled'));
  const schedIds = [...schedSec.matchAll(/id="d-([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(schedIds, sec.scheduled.flatMap((g) => g.rows.map((r) => r.id)));

  // Nothing was lost in the reorder. "Done this week" is collapsed by default,
  // so the drawn set is Open + Scheduled.
  const drawn = [...out.matchAll(/id="d-([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(drawn).size, sec.open.length + sec.scheduledCount);
  assert.equal(drawn.length, new Set(drawn).size, 'no row drawn twice');
});

await check('no dollar AMOUNT appears anywhere on the landing page', async () => {
  const out = await renderRoute('#/');
  // Percentages yes; currency no. The old "$X on rent of $Y" sub-line is gone
  // and nothing else on the landing may print money.
  const money = out.match(/\$[\d,]+/g);
  assert.equal(money, null, `the landing must show no dollar amounts, found ${money}`);
  assert.ok(!/on rent of/.test(out), 'the dollar sub-line must be gone');
  // the units bar keeps its own count sub-line — that is a machine count, not money
  assert.ok(/\d+ of \d+ rental units on rent/.test(out), 'the units sub-line stays');
});

await check('the unit page shows Ask but never Cost or Book', async () => {
  const snap = app.__state().snapshot;
  for (const u of snap.units.slice(0, 8)) {
    const out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
    assert.ok(!/Acquisition cost/.test(out), `#${u.serial} still shows Acquisition cost`);
    assert.ok(!/<dt>Book<\/dt>/.test(out), `#${u.serial} still shows Book`);
    assert.ok(/<dt>Ask<\/dt>/.test(out), `#${u.serial} lost Ask, which stays`);
    assert.ok(!/undefined|\$NaN/.test(out), `#${u.serial} rendered a placeholder`);
  }
});

await check('a schema-3 snapshot still renders — and its costs stay off the screen', async () => {
  // mock-legacy is an authentic pre-schema-4 file: it carries acquisition_cost
  // and book on every unit and has NO meta.utilization. The page must fall back
  // to computing the bars, and must still refuse to print those figures.
  window.location.href = 'http://localhost:8787/?mock=legacy&role=owner';
  window.location.search = '?mock=legacy&role=owner';
  await app.__refresh();
  const snap = app.__state().snapshot;
  assert.ok(snap.units.some((u) => typeof u.acquisition_cost === 'number'), 'legacy fixture lost its costs');
  assert.equal(snap.meta.utilization, undefined, 'legacy must have no meta.utilization');

  const landing = await renderRoute('#/');
  const u = utilizationFrom(snap);
  assert.equal(u.units.pct, utilization(snap.units).units.pct, 'the fallback path must be the one used');
  assert.ok(landing.includes(`>${u.units.pct}%<`), 'the fallback still draws the units bar');
  assert.ok(landing.includes(`>${u.dollars.pct}%<`), 'and the dollars bar');
  assert.equal(landing.match(/\$[\d,]+/g), null, 'no amounts, even when the snapshot has them');

  const withCost = snap.units.find((x) => typeof x.acquisition_cost === 'number');
  const unitPage = await renderRoute(`#/unit/${encodeURIComponent(withCost.serial)}`);
  assert.ok(!/Acquisition cost/.test(unitPage) && !/<dt>Book<\/dt>/.test(unitPage),
    'an old snapshot still carries cost and book — the page must ignore them, not display them');

  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
});

await check('a unit stripped of every money field renders clean', async () => {
  const snap = app.__state().snapshot;
  const u = snap.units[0];
  const saved = { ask: u.ask };
  delete u.ask;                       // schema 4 keeps ask, but tolerate its absence
  const out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(!/undefined|\$NaN|NaN/.test(out), 'a money-less unit must render clean');
  assert.ok(/<dt>Ask<\/dt>/.test(out), 'the row stays, showing an em dash');
  Object.assign(u, saved);
});

await check('the chip zone is All · Fleet · Customer, in that order (D43)', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  const out = await renderRoute('#/service');
  const order = [...out.matchAll(/data-filter="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['all', 'WSS', 'CUSTOMER'], 'Fleet must sit left of Customer');
  // + New ticket leads the page, above the chips and the widgets.
  assert.ok(out.indexOf('+ New ticket') < out.indexOf('data-filter='), 'New ticket comes first');
  assert.ok(out.indexOf('data-filter=') < out.indexOf('Fleet status'), 'chips come before the widgets');
});

await check('All shows both widgets and all ten columns', async () => {
  const out = await serviceUnder('all');
  assert.ok(out.includes('Fleet status'), 'the fleet board must show under All');
  assert.ok(out.includes('Service pipeline'), 'the pipeline must show under All');
  assert.ok(out.indexOf('Fleet status') < out.indexOf('Service pipeline'), 'board above pipeline');
  assert.ok(out.includes('Customer machines · fleet repairs are on the board above'),
    'the caption explains the split, but only when both are on screen');
  const cols = [...out.matchAll(/id="kan-([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, columnsFor('all'));
  assert.equal(cols.length, 10, 'D47 took the board to nine, D48 to ten');
  assert.equal(cols[5], 'READY-TO-SCHEDULE', 'D48 sits straight after WAITING-ON-PARTS');
  assert.equal(cols[2], 'NEEDS-QUOTE', 'and it sits straight after CONTACTED');
});

await check('Fleet shows the board only, seven columns, and only WSS tickets', async () => {
  const out = await serviceUnder('WSS');
  assert.ok(out.includes('Fleet status'), 'the board is the Fleet widget');
  assert.ok(!out.includes('Service pipeline'), 'the pipeline is customer work — hidden under Fleet');
  const cols = [...out.matchAll(/id="kan-([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, columnsFor('WSS'));
  assert.equal(cols.length, 7, 'Fleet is seven — D48 added a stage a fleet ticket CAN take');
  assert.ok(cols.includes('READY-TO-SCHEDULE'), 'a fleet unit whose parts arrived is ready to schedule too (D48)');
  assert.ok(!cols.includes('WAITING-ON-CUSTOMER') && !cols.includes('READY-TO-INVOICE'));
  assert.ok(!cols.includes('NEEDS-QUOTE'), 'nobody quotes us to us (D47)');
  // every card drawn belongs to a fleet ticket
  const wss = new Set(app.__state().snapshot.service_queue.filter((t) => t.machine_owner === 'WSS').map((t) => t.ticket));
  for (const [, id] of out.matchAll(/class="kan-id">([^<]+)</g)) {
    assert.ok(wss.has(id), `${id} is a customer ticket and must not show under Fleet`);
  }
});

await check('Customer shows the pipeline only, ten columns, and only customer tickets', async () => {
  const out = await serviceUnder('CUSTOMER');
  assert.ok(out.includes('Service pipeline'), 'the pipeline is the Customer widget');
  assert.ok(!out.includes('Fleet status'), 'the fleet board is hidden under Customer');
  assert.ok(!out.includes('fleet repairs are on the board above'), 'no caption when the board is not on screen');
  const cols = [...out.matchAll(/id="kan-([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, columnsFor('CUSTOMER'));
  const cust = new Set(app.__state().snapshot.service_queue.filter((t) => t.machine_owner === 'CUSTOMER').map((t) => t.ticket));
  for (const [, id] of out.matchAll(/class="kan-id">([^<]+)</g)) {
    assert.ok(cust.has(id), `${id} is a fleet ticket and must not show under Customer`);
  }
});

await check('the pipeline draws nine tappable rows and a live open pill', async () => {
  const out = await serviceUnder('CUSTOMER');
  const rows = [...out.matchAll(/data-pipe="([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, PIPELINE_STAGES, 'nine rows in stage order');
  // D47: our court, so the same maroon as RECEIVED and not WAITING's amber.
  assert.ok(out.includes('pipe-new" data-pipe="NEEDS-QUOTE"'), 'the Needs quote row is maroon');
  assert.ok(out.includes('pipe-new" data-pipe="READY-TO-SCHEDULE"'), 'the Ready to schedule row is maroon too — our court (D48)');
  assert.ok(out.includes('>Needs quote<'), 'and reads in shop-floor words');
  assert.ok(!rows.includes('COMPLETE'), 'COMPLETE is the header pill, not a row');
  const q = app.__state().snapshot.service_queue;
  const open = q.filter((t) => t.machine_owner === 'CUSTOMER' && t.status === 'OPEN').length;
  // D62: the snapshot carries 90 days of closed tickets; the pill is this week's only.
  const closed = q.filter((t) => t.machine_owner === 'CUSTOMER' && t.status === 'CLOSED' && t.closed_age_days <= 7).length;
  assert.ok(q.some((t) => t.machine_owner === 'CUSTOMER' && t.status === 'CLOSED' && t.closed_age_days > 7), 'the mock carries older closes');
  assert.ok(out.includes(`${open} open`), `header pill should read "${open} open"`);
  assert.equal(out.includes('closed this week'), closed > 0, 'the closed pill hides at zero');
  if (closed) assert.ok(out.includes(`${closed} closed this week`), `closed pill should read ${closed}, not the 90-day total`);
});

await check('D62b: COMPLETE is this week only; the pipeline\'s Completed row is collapsed, counts the window, opens, and searches', async () => {
  const snap = app.__state().snapshot;
  const q = snap.service_queue;
  const out = await serviceUnder('all');
  const col = out.split('id="kan-COMPLETE"')[1].split('</section>')[0];
  for (const t of q.filter((x) => x.status === 'CLOSED')) {
    assert.equal(col.includes(`>${t.ticket}<`), t.closed_age_days <= 7, `${t.ticket} (${t.closed_age_days}d) in COMPLETE?`);
  }
  assert.ok(out.includes('data-completed-toggle="1" aria-expanded="false"'), 'collapsed by default');
  assert.ok(out.includes(`<span class="done-n">${snap.service_summary.closed_in_window}</span>`), 'pill = closed_in_window');
  assert.ok(!out.includes('id="completed-q"'), 'no search box while collapsed');
  // The tenth row of the widget, directly under Ready to invoice, inside the card.
  const pipe = out.split('aria-label="Service pipeline')[1].split('</section>')[0];
  assert.ok(pipe.includes('data-completed-toggle'), 'the Completed row lives inside the pipeline card');
  const after = pipe.split('data-pipe="READY-TO-INVOICE"')[1];
  assert.ok(after && after.includes('data-completed-toggle') && !after.includes('data-pipe='), 'directly under Ready to invoice, last row');
  const doneRow = pipe.split('class="brow pipe-done"')[1].split('</div>')[0];
  assert.ok(doneRow.includes('class="done-btn"'), 'the label is a maroon button, not a plain stage label');
  assert.ok(!doneRow.includes('brow-track') && !doneRow.includes('brow-p') && !doneRow.includes('%'), 'no bar, no percent');
  assert.ok(!doneRow.includes('data-pipe'), 'it never scrolls the kanban');
  // No strip under the kanban any more.
  const kan = out.split('class="kan-wrap"')[1];
  assert.ok(!kan.includes('data-completed-toggle') && !kan.includes('Completed'), 'the v1.0 strip is gone');

  const toggle = async () => {
    for (const fn of listeners.get('click') || []) {
      await fn({ target: { closest: (sel) => (sel === '[data-completed-toggle]' ? {} : null) } });
    }
    return view._html;
  };
  const open = await toggle();
  assert.ok(open.includes('aria-expanded="true"'), 'the button opens the panel');
  const panel = open.split('aria-label="Service pipeline')[1].split('</section>')[0];
  assert.ok(panel.includes('id="completed-q"'), 'the search box is inside the widget card');
  const strip = open.split('id="completed-list">')[1].split('</section>')[0];
  const ids = [...strip.matchAll(/href="#\/ticket\/(S\d+)"/g)].map((m) => m[1]);
  const want = q.filter((t) => t.status === 'CLOSED')
    .sort((a, b) => a.closed_age_days - b.closed_age_days || b.ticket.localeCompare(a.ticket)).map((t) => t.ticket);
  assert.deepEqual(ids, want, 'every CLOSED ticket, newest first');
  assert.ok(open.includes('placeholder="customer, machine, or S-number"'));
  assert.ok(strip.includes('📎'), 'a row with paperwork says so');

  // Typing redraws the list only, not the view.
  const list = el('div');
  nodes['#completed-list'] = list;
  const before = view._html;
  for (const fn of listeners.get('input') || []) await fn({ target: { id: 'completed-q', value: 'SILVERLINE', closest: () => null } });
  assert.equal(view._html, before, 'the view is not re-rendered on a keystroke');
  assert.equal([...list._html.matchAll(/href="#\/ticket\//g)].length, 1, 'one match');
  assert.ok(list._html.includes('Silverline'));
  for (const fn of listeners.get('input') || []) await fn({ target: { id: 'completed-q', value: 'zzz no match', closest: () => null } });
  assert.ok(list._html.includes('No completed tickets match.'));
  for (const fn of listeners.get('input') || []) await fn({ target: { id: 'completed-q', value: '', closest: () => null } });
  delete nodes['#completed-list'];

  // Customer: the widget draws, and the list honours the chip.
  const cust = await serviceUnder('CUSTOMER');
  const cids = [...cust.split('id="completed-list">')[1].split('</section>')[0].matchAll(/href="#\/ticket\/(S\d+)"/g)].map((m) => m[1]);
  assert.ok(cids.length >= 1);
  for (const id of cids) assert.equal(q.find((t) => t.ticket === id).machine_owner, 'CUSTOMER');
  assert.ok(cust.includes(`<span class="done-n">${cids.length}</span>`), 'under a chip the pill is the drawn count');
  // Fleet: no pipeline widget, so no Completed row — accepted by the spec (All covers ours).
  const fleet = await serviceUnder('WSS');
  assert.ok(!fleet.includes('data-completed-toggle') && !fleet.includes('id="completed-list"'), 'no Completed row under Fleet');
  assert.ok(q.some((t) => t.status === 'CLOSED' && t.machine_owner === 'WSS'), 'the mock has a closed fleet ticket');
  const allOpen = await serviceUnder('all');
  const aids = [...allOpen.split('id="completed-list">')[1].split('</section>')[0].matchAll(/href="#\/ticket\/(S\d+)"/g)].map((m) => m[1]);
  assert.ok(aids.some((id) => q.find((t) => t.ticket === id).machine_owner === 'WSS'), 'All lists our closed tickets too');

  await toggle();                 // fold it back up
  await serviceUnder('all');
});

await check('D62: a pre-D62 snapshot — no closed_age_days / closed_window_days — renders as before', async () => {
  const snap = app.__state().snapshot;
  const saved = JSON.stringify(snap);
  snap.service_queue = snap.service_queue.filter((t) => t.status !== 'CLOSED' || t.closed_age_days <= 7)
    .map(({ closed_age_days, ...t }) => t);
  delete snap.service_summary.closed_window_days;
  delete snap.service_summary.closed_in_window;
  const closed = snap.service_queue.filter((t) => t.status === 'CLOSED');
  const out = await serviceUnder('all');
  const col = out.split('id="kan-COMPLETE"')[1].split('</section>')[0];
  for (const t of closed) assert.ok(col.includes(`>${t.ticket}<`), `${t.ticket} stays in COMPLETE`);
  assert.ok(out.includes(`<span class="done-n">${closed.length}</span>`), 'row count = drawn count');
  // And the empty copy falls back to 7 days.
  snap.service_queue = snap.service_queue.filter((t) => t.status !== 'CLOSED');
  for (const fn of listeners.get('click') || []) await fn({ target: { closest: (sel) => (sel === '[data-completed-toggle]' ? {} : null) } });
  assert.ok(view._html.includes('Nothing completed in the last 7 days.'));
  for (const fn of listeners.get('click') || []) await fn({ target: { closest: (sel) => (sel === '[data-completed-toggle]' ? {} : null) } });
  Object.assign(snap, JSON.parse(saved));
  await serviceUnder('all');
});

await check('the chip is remembered per device and survives a reload', async () => {
  await serviceUnder('WSS');
  // A fresh boot reads it back out of storage rather than defaulting to All.
  assert.equal(localStorage.getItem('wss_fleet_service_filter'), 'WSS');
  // Boot a second copy of the module to prove the chip comes back from storage.
  // app.js registers delegated listeners at import, so that copy would other-
  // wise keep answering our synthetic clicks and re-rendering #view from its
  // own state. Quarantine its listeners rather than let two apps share a DOM.
  const saved = new Map([...listeners].map(([k, v]) => [k, v.slice()]));
  const fresh = await import(`${path.join(DOCS, 'app.js')}?reload=${Date.now()}`);
  await settle();
  assert.equal(fresh.__ui().ticketFilter, 'WSS', 'the remembered chip must come back');
  listeners.clear();
  for (const [k, v] of saved) listeners.set(k, v);

  await serviceUnder('all');   // leave the device on All for the checks below
});

await check('the pipeline card never hides — zero open tickets still draws nine rows', async () => {
  window.location.href = 'http://localhost:8787/?mock=empty&role=owner';
  window.location.search = '?mock=empty&role=owner';
  await app.__refresh();
  const out = await serviceUnder('CUSTOMER');
  assert.ok(out.includes('Service pipeline'), 'the card stays even with nothing in it');
  assert.ok(out.includes('0 open'), 'the pill reads 0 open');
  assert.ok(!out.includes('closed this week'), 'the closed pill hides at zero');
  assert.equal([...out.matchAll(/data-pipe="[A-Z-]+"/g)].length, 9, 'nine zero rows still render');
  assert.equal([...out.matchAll(/>0%</g)].length >= 9, true, 'and they read 0%');

  // hand the suite back the state it expects: full snapshot, All chip
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  await serviceUnder('all');
});

/* ------------------------------------------- undo your own pending tap (D46) */

/** Every Undo control drawn across the views that badge pending events. */
async function undoableIds(role) {
  window.location.href = `http://localhost:8787/?mock=full&role=${role}&pending=1`;
  window.location.search = `?mock=full&role=${role}&pending=1`;
  await app.__refresh();
  const seen = new Set();
  const snap = app.__state().snapshot;
  const routes = ['#/', '#/rentals', '#/dispatch', '#/service', '#/holds', '#/leads']
    .concat(snap.units.map((u) => `#/unit/${encodeURIComponent(u.serial)}`))
    .concat(snap.service_queue.map((t) => `#/ticket/${encodeURIComponent(t.ticket)}`))
    .concat((snap.leads || []).map((l) => `#/lead/${encodeURIComponent(l.lead)}`))
    .concat((snap.work_orders || []).map((w) => `#/wo/${encodeURIComponent(w.id)}`))
    // D67: a SAVE on a numbered sheet only shows on that sheet.
    .concat((snap.inspections || []).map((i) => `#/inspection/${encodeURIComponent(i.id)}`));
  for (const r of routes) {
    const out = await renderRoute(r);
    for (const [, id] of out.matchAll(/data-sheet="undo" data-id="([^"]+)"/g)) seen.add(id);
  }
  return { me: app.__state().me, ids: seen, pending: app.__state().pending };
}

await check('mock identity is a real person per role, so "is this mine?" is answerable', async () => {
  for (const [role, name] of [['owner', 'Matt'], ['sales', 'Kevin'], ['service', 'Josh']]) {
    window.location.href = `http://localhost:8787/?mock=full&role=${role}`;
    window.location.search = `?mock=full&role=${role}`;
    await app.__refresh();
    assert.equal(app.__state().me.name, name, `${role} should be ${name} in mock`);
  }
});

await check('Undo appears on my own pending taps and on nobody else\'s', async () => {
  for (const role of ['owner', 'sales', 'service']) {
    const { me, ids, pending } = await undoableIds(role);
    const mine = pending.filter((e) => e.actor === me.name).map((e) => e.id);
    const theirs = pending.filter((e) => e.actor !== me.name).map((e) => e.id);

    assert.ok(mine.length, `${role} (${me.name}) should have at least one pending tap in the fixture`);
    assert.ok(theirs.length, `${role} should also see somebody else's pending tap`);
    for (const id of mine) assert.ok(ids.has(id), `${me.name} must be offered Undo on their own ${id}`);
    for (const id of theirs) assert.ok(!ids.has(id), `${me.name} must NOT be offered Undo on ${id}`);
  }
});

await check('Undo is per-actor, not per-role — Zac\'s tap is undoable by nobody on the board', async () => {
  // evt-mock-5 is Zac's, and Zac is not one of the three mock identities. A
  // role-based check would have handed it to Josh, who shares his role.
  const zac = (await undoableIds('service')).pending.find((e) => e.actor === 'Zac');
  assert.ok(zac, 'the fixture must hold an event by a fourth person');
  for (const role of ['owner', 'sales', 'service']) {
    const { ids } = await undoableIds(role);
    assert.ok(!ids.has(zac.id), `${role} must not be offered Undo on Zac's tap`);
  }
});

await check('the confirm sheet carries the promised copy, and only for my own tap', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=service&pending=1';
  window.location.search = '?mock=full&role=service&pending=1';
  await app.__refresh();
  // Josh's own ticket_open draws as the synthetic NEW card on the Service view.
  const mine = app.__state().pending.find((e) => e.actor === 'Josh' && e.action === 'ticket_open');
  // Zac's ticket_update is badged on that ticket's detail page.
  const theirs = app.__state().pending.find((e) => e.actor === 'Zac' && e.action === 'ticket_update');
  assert.ok(mine && theirs, 'the fixture must hold both events');

  // arm it the way a tap does
  app.__ui().form = { kind: 'undo', id: mine.id, arg: null };
  const armed = await renderRoute('#/service');
  assert.ok(armed.includes("Undo this tap? It hasn't been applied yet."), 'confirm copy missing');
  assert.ok(armed.includes(`data-undo="${mine.id}"`), 'the confirm must name the event');

  // The same sheet keyed to someone else's event draws nothing, on the very
  // page that event IS badged on — so this is about the actor, not the route.
  const ticket = theirs.payload.ticket;
  app.__ui().form = { kind: 'undo', id: theirs.id, arg: null };
  const other = await renderRoute(`#/ticket/${encodeURIComponent(ticket)}`);
  assert.ok(other.includes('by Zac'), 'the page must still badge the pending change');
  assert.ok(!other.includes(`data-undo="${theirs.id}"`), "someone else's event must never arm");
  assert.ok(!other.includes("Undo this tap?"), 'and no confirm copy leaks onto it');
  app.__ui().form = null;
});

await check('a pending event with no id is never undoable', async () => {
  // Defensive: the badge must not offer a control it cannot address.
  const st = app.__state();
  st.pending.push({ actor: 'Josh', role: 'service', action: 'ticket_open', serial: null, payload: { customer: 'No Id Co', machine_owner: 'CUSTOMER' } });
  const out = await renderRoute('#/service');
  assert.ok(!/data-sheet="undo" data-id="(undefined)?"/.test(out), 'an id-less event must draw no Undo');
  st.pending.pop();

  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
});

await check('the stage picker offers NEEDS-QUOTE on their machine, never on ours (D47)', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=service';
  window.location.search = '?mock=full&role=service';
  await app.__refresh();
  const q = app.__state().snapshot.service_queue;

  const cust = q.find((t) => t.machine_owner === 'CUSTOMER' && t.status === 'OPEN');
  const theirs = await renderRoute(`#/ticket/${encodeURIComponent(cust.ticket)}`);
  assert.ok(theirs.includes('data-stage="NEEDS-QUOTE"'), 'a customer ticket can be quoted');

  const ours = q.find((t) => t.machine_owner === 'WSS');
  const mine = await renderRoute(`#/ticket/${encodeURIComponent(ours.ticket)}`);
  assert.ok(!mine.includes('data-stage="NEEDS-QUOTE"'), 'nobody quotes us to us');
  assert.ok(!mine.includes('data-stage="WAITING-ON-CUSTOMER"') && !mine.includes('data-stage="READY-TO-INVOICE"'));
  assert.equal([...mine.matchAll(/data-stage="[A-Z-]+"/g)].length, 7, 'seven buttons on a fleet ticket (D48)');
  assert.ok(mine.includes('data-stage="READY-TO-SCHEDULE"'), 'and one of them is Ready to schedule');

  // And a ticket actually parked there renders its stage in shop-floor words.
  const parked = q.find((t) => t.stage === 'NEEDS-QUOTE');
  assert.ok(parked, 'the fixture must hold a NEEDS-QUOTE ticket');
  const detail = await renderRoute(`#/ticket/${encodeURIComponent(parked.ticket)}`);
  assert.ok(detail.includes('>Needs quote</span>'), 'the stage chip reads "Needs quote"');
});

await check('a tech sees COMPLETE disabled on a customer ticket, Matt does not', async () => {
  const q = app.__state().snapshot.service_queue;
  const cust = q.find((t) => t.machine_owner === 'CUSTOMER' && t.status === 'OPEN');
  const wss = q.find((t) => t.machine_owner === 'WSS');

  window.location.href = 'http://localhost:8787/?mock=full&role=service';
  window.location.search = '?mock=full&role=service';
  await app.__refresh();
  const asTech = await renderRoute(`#/ticket/${cust.ticket}`);
  assert.ok(asTech.includes('Matt closes after invoicing.'), 'the caption must explain the disabled button');

  const asTechWss = await renderRoute(`#/ticket/${wss.ticket}`);
  assert.ok(!asTechWss.includes('Waiting on customer'), 'WAITING-ON-CUSTOMER must be hidden on one of our own machines');
  assert.ok(!asTechWss.includes('Ready to invoice'), 'READY-TO-INVOICE must be hidden on a WSS ticket');

  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  const asMatt = await renderRoute(`#/ticket/${cust.ticket}`);
  assert.ok(!asMatt.includes('Matt closes after invoicing.'), 'Matt gets no caption — he can close it');
});

await check('sales sees no stage picker, and no Cancel on a manual run', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=sales';
  window.location.search = '?mock=full&role=sales';
  await app.__refresh();
  const t = app.__state().snapshot.service_queue[0];
  const out = await renderRoute(`#/ticket/${t.ticket}`);
  assert.ok(out.includes('Techs and Matt move the stage.'), 'sales must be told who moves stages');
  assert.ok(!out.includes('data-stage='), 'sales must not get stage buttons');
  // but everyone may note / assign / schedule and work the board
  assert.ok(out.includes('Add a note') && out.includes('Assign') && out.includes('Schedule'));
  const board = await renderRoute('#/dispatch');
  assert.ok(!board.includes('data-cancel='), 'only Matt cancels a run');
  assert.ok(board.includes('data-sheet="claim"'), 'anyone may claim a run');
});

await check('a unit with an open ticket shows the wrench chip and links to it', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  const u = app.__state().snapshot.units.find((x) => x.service_ticket);
  const out = await renderRoute(`#/unit/${u.serial}`);
  assert.ok(out.includes(`🔧 ${u.service_ticket}`), 'wrench chip missing');
  assert.ok(out.includes(`#/ticket/${u.service_ticket}`), 'the wrench must link to the ticket');
  assert.ok(out.includes('Schedule delivery'), 'the unit page books a truck (§5)');
});

await check('a NEEDS-PICKUP unit points at its row on the Dispatch board (§5)', async () => {
  const snap = app.__state().snapshot;
  const booked = snap.dispatch.find((r) => r.source === 'RENTAL-RETURN' && r.status !== 'DONE');
  const out = await renderRoute(`#/unit/${booked.serial}`);
  assert.ok(out.includes('on the Dispatch board'), 'the pick-up must name where its run lives');
  assert.ok(out.includes(`#/dispatch/${booked.id}`), 'and link straight to the row');
});

await check('a hold row books the truck for it (§4)', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=sales';
  window.location.search = '?mock=full&role=sales';
  await app.__refresh();
  const out = await renderRoute('#/holds');
  assert.ok(out.includes('Schedule delivery'), 'a hold row must be able to book a run');
  assert.ok(/data-sheet="add-run" data-serial="\d+" data-hold="h/.test(out), 'the run must carry the hold it came from');
});

await check('the empty variant renders both empty states, not a crash', async () => {
  window.location.href = 'http://localhost:8787/?mock=empty&role=owner';
  window.location.search = '?mock=empty&role=owner';
  await app.__refresh();
  assert.ok((await renderRoute('#/service')).includes('Nothing in the shop.'));
  assert.ok((await renderRoute('#/dispatch')).includes('Nothing to move.'));
});

await check('the schema-2 snapshot still renders every view during the cutover', async () => {
  window.location.href = 'http://localhost:8787/?mock=legacy&role=owner';
  window.location.search = '?mock=legacy&role=owner';
  await app.__refresh();
  assert.equal(app.__state().snapshot.meta.schema_version, 2);
  const svc = await renderRoute('#/service');
  assert.ok(svc.includes('Fleet status'), 'the board still draws on an old snapshot');
  const disp = await renderRoute('#/dispatch');
  // An old snapshot has no dispatch[] at all — but it still has pickups[], and
  // a released unit must surface somewhere rather than vanish with the board.
  assert.ok(disp.includes('Released, not on the board'), 'pick-ups must survive a schema-2 snapshot');
  assert.ok(disp.includes('Nothing unclaimed.'), 'the Open section renders its own empty state');
  // The old singular `reservation` is present in this file and must be ignored.
  assert.ok(app.__state().snapshot.units.some((u) => u.reservation), 'legacy fixture lost its singular reservation');
  assert.ok((await renderRoute('#/holds')).includes('Holds'));
});

/* ================================================ leads (schema 5) ========= */

/** Render the Leads tab as somebody, with the pending fixture loaded. */
async function leadsAs(role, hash = '#/leads') {
  window.location.href = `http://localhost:8787/?mock=full&role=${role}&pending=1`;
  window.location.search = `?mock=full&role=${role}&pending=1`;
  await app.__refresh();
  return renderRoute(hash);
}

/** The service token's view, with the Worker's §6 strip applied to the fixture.
 *  The mock file is the UNstripped snapshot — the strip happens at the edge —
 *  so the test has to do to it exactly what worker.js stripLeadMoney() does. */
async function leadsAsStrippedService(hash = '#/leads', openScore = false) {
  window.location.href = 'http://localhost:8787/?mock=full&role=service&pending=1';
  window.location.search = '?mock=full&role=service&pending=1';
  await app.__refresh();
  app.__ui().showScore = openScore ? true : null;
  const snap = app.__state().snapshot;
  // `log` deliberately STAYS (v2.5): the engine no longer writes a figure into
  // a lead log row, so the gate no longer has to take the notes with it.
  for (const l of snap.leads) { delete l.value; delete l.potential_commission; }
  delete snap.leads_summary.commission_rates;
  delete snap.leads_summary.money_fields;
  delete snap.scoreboard.money;
  return renderRoute(hash);
}

await check('the Leads board draws seven columns, New Lead first and Won last', async () => {
  const out = await leadsAs('sales');
  const heads = [...out.matchAll(/<div class="kan-head"><span>([^<]+)</g)].map((m) => m[1]);
  // D55: RECEIVED reads "New Lead" and PO-RECEIVED closes the open stages.
  assert.deepEqual(heads.slice(0, 6),
    ['New Lead', 'Contacted', 'Quoted', 'Demo booked', 'Demo done', 'PO received'],
    'the six open stages, in pipeline order');
  assert.ok(!heads.includes('Received'), 'the first column must not still read "Received"');
  assert.equal(heads[heads.length - 1], 'Won', 'Won is the last column');
  assert.ok(out.includes('data-lead-filter="all"') && out.includes('data-lead-filter="mine"')
    && out.includes('data-lead-filter="stale"'), 'All / Mine / Stale');
});

await check('every OPEN lead in the fixture is on the board exactly once', async () => {
  const out = await leadsAs('sales');
  const snap = app.__state().snapshot;
  for (const l of snap.leads.filter((x) => x.status === 'OPEN')) {
    const hits = [...out.matchAll(new RegExp(`href="#/lead/${l.lead}"`, 'g'))].length;
    assert.equal(hits, 1, `${l.lead} should appear once on the board`);
  }
  // LOST and DEAD are in the collapsed strip, which is shut by default.
  for (const l of snap.leads.filter((x) => x.status === 'LOST' || x.status === 'DEAD')) {
    assert.ok(!out.includes(`href="#/lead/${l.lead}"`), `${l.lead} must not be on the board`);
  }
});

await check('a service token sees no money on the leads board — and no hole either', async () => {
  // Scoreboard expanded, so the absence of rows 1-2 is a real absence and not
  // just the fold hiding them.
  const out = await leadsAsStrippedService('#/leads', true);
  assert.ok(!/class="lead-money"/.test(out), 'no money line on any card');
  assert.ok(!out.includes('potential commission'), 'not even the label');
  assert.ok(!out.includes('On the table'), 'row 1 is not rendered at all');
  assert.ok(!out.includes('This month'), 'row 2 is not rendered at all');
  assert.ok(!out.includes('vs. your last'), 'nor row 2\'s caption');
  assert.ok(!/\$[0-9]/.test(out.split('kan-wrap')[0]), 'not a single dollar figure above the board');
  // The rows that are not money still render, so the tab is still useful.
  assert.ok(out.includes('Speed') && out.includes('Stale') && out.includes('Conversion'),
    'rows 3-5 survive');
  // A placeholder would say exactly where the missing number lives.
  assert.ok(!/lead-money/.test(out));
});

await check('sales sees both money rows and the money line on cards', async () => {
  const out = await leadsAs('sales');
  assert.ok(out.includes('On the table'), 'row 1');
  assert.ok(out.includes('potential commission'), 'never "commission" alone');
  assert.ok(/class="lead-money"/.test(out), 'cards carry value + potential commission');
  assert.ok(out.includes('vs. your last 3 mo avg'), 'row 2 names its baseline');
});

await check('the Committed row shows for owner and sales, and never for a tech (D55)', async () => {
  const snap = app.__state().snapshot;
  for (const who of ['sales', 'owner']) {
    const out = await leadsAs(who);
    const money = JSON.parse(JSON.stringify(snap.scoreboard.money));
    assert.ok(money.committed_count > 0, 'the fixture needs a committed deal');
    assert.ok(out.includes('Committed'), `${who} should see the row`);
    assert.ok(out.includes(`${money.committed_count} PO in hand`), 'the sub-line counts the POs');
    // It sits under "On the table", because it is part of that number, not a rival to it.
    assert.ok(out.indexOf('On the table') < out.indexOf('Committed'), 'Committed goes below On the table');
    assert.ok(out.includes('potential commission'), 'never "commission" alone');
  }

  // A service token has no scoreboard.money at all (the Worker deletes the whole
  // object), so the row cannot render — asserted rather than assumed.
  const josh = await leadsAsStrippedService('#/leads', true);
  assert.ok(!josh.includes('Committed'), 'a tech must not see committed dollars');
  assert.ok(!josh.includes('PO in hand'));
});

await check('the Committed row hides itself when nothing is committed', async () => {
  // "Committed $0" is a row that says nothing on most days.
  await leadsAs('sales');            // the check above left us on the stripped-service copy
  const snap = app.__state().snapshot;
  const keep = snap.scoreboard.money.committed_count;
  const keepLeads = snap.leads.map((l) => l.stage);
  snap.scoreboard.money.committed_count = 0;
  snap.scoreboard.money.committed_value = 0;
  snap.scoreboard.money.committed_commission = 0;
  for (const l of snap.leads) if (l.stage === 'PO-RECEIVED') l.stage = 'QUOTED';
  // The column count comes from the engine's own census when the filter is All,
  // so an honest "nothing committed" has to move that too.
  snap.leads_summary.open_by_stage['PO-RECEIVED'] = 0;

  const out = await renderRoute('#/leads');
  assert.ok(!out.includes('Committed'), 'no row at zero');
  assert.ok(out.includes('On the table'), 'but the rest of the scoreboard still draws');
  // The COLUMN still draws, and should: board columns are a fixed set so the
  // layout does not reshuffle as leads move. Only the money ROW is conditional.
  assert.ok(out.includes('PO received'), 'the empty column stays — stable layout');
  assert.ok(/PO received<\/span><span class="c">0</.test(out), 'and reads 0');

  snap.scoreboard.money.committed_count = keep;
  snap.leads_summary.open_by_stage['PO-RECEIVED'] = keep;
  snap.leads.forEach((l, i) => { l.stage = keepLeads[i]; });
  await app.__refresh();
});

await check('a PO-RECEIVED lead carries its PO on the card and needs no PO to re-enter', async () => {
  await leadsAs('sales');
  const snap = app.__state().snapshot;
  const l = snap.leads.find((x) => x.stage === 'PO-RECEIVED');
  assert.ok(l && l.po, 'the fixture needs a lead with a PO');
  const out = await renderRoute(`#/lead/${encodeURIComponent(l.lead)}`);
  assert.ok(out.includes('>PO<') || /<dt[^>]*>PO</.test(out), 'the card needs a PO row');
  assert.ok(out.includes(l.po), `the PO number ${l.po} is missing`);
  assert.ok(out.includes('PO received'), 'the stage chip reads the label');
  assert.ok(!out.includes('undefined'));
});

await check('the stage sheet asks for the PO before it will propose the move', async () => {
  await leadsAs('sales');
  const snap = app.__state().snapshot;
  // A QUOTED lead has no PO, so moving it must ask.
  const l = snap.leads.find((x) => x.status === 'OPEN' && x.stage === 'QUOTED');
  assert.ok(l, 'the fixture needs an open QUOTED lead');
  await renderRoute(`#/lead/${encodeURIComponent(l.lead)}`);
  for (const fn of listeners.get('click') || []) {
    const btn = { dataset: { leadStage: 'PO-RECEIVED' }, disabled: false };
    btn.closest = (q) => (q === '[data-lead-stage]' ? btn : null);
    await fn({ target: btn });
  }
  await settle();
  const out = view._html;
  assert.ok(out.includes('Customer PO #'), 'the form must ask for the PO by name');
  assert.ok(/<input id="ls-po" name="po" required/.test(out), 'and require it, and send it as `po`');
  assert.ok(out.includes('the PO is the commitment'), 'say why it is required');
  assert.ok(out.includes('Move to PO received'), 'the button names the stage in words');
});

await check('the scoreboard is open for Kevin and folded away for Josh', async () => {
  const kevin = await leadsAs('sales');
  assert.ok(/aria-expanded="true"[^>]*>\s*<span>▾ Scoreboard/.test(kevin.replace(/\n\s*/g, ' '))
    || kevin.includes('▾ Scoreboard'), 'open by default on sales');
  const josh = await leadsAsStrippedService();
  assert.ok(josh.includes('▸ Scoreboard'), 'collapsed by default on everyone else');
  assert.ok(!josh.includes('Speed') || josh.includes('▸ Scoreboard'), 'collapsed means no rows drawn');
});

await check('insights are for Kevin and Matt, and collapsed until asked for', async () => {
  const sales = await leadsAs('sales');
  assert.ok(sales.includes('Pipeline insights — last 90 days'));
  assert.ok(sales.includes('▸ Pipeline insights'), 'collapsed by default');
  assert.ok(!sales.includes('Why we lose'), 'the tables are not drawn while collapsed');
  const svc = await leadsAsStrippedService();
  assert.ok(!svc.includes('Pipeline insights'), 'a tech does not get the insights card');
});

await check('a null rate renders the phrase, never a dash or a zero', async () => {
  // The empty variant is the real snapshot's shape on a quiet day: no leads,
  // every rate null, insufficient true.
  window.location.href = 'http://localhost:8787/?mock=empty&role=sales';
  window.location.search = '?mock=empty&role=sales';
  await app.__refresh();
  const out = await renderRoute('#/leads');
  assert.ok(out.includes('No leads yet.'), 'the empty board says so');
  assert.ok(out.includes('not enough data yet (n=0/5)'), 'the conversion row admits it');
  assert.ok(out.includes(NO_DATA), 'the speed median reads the phrase');
  assert.ok(!out.includes('<strong>&mdash;</strong>') && !out.includes('<strong>—</strong>'),
    'no em-dash placeholders in the scoreboard');
});

await check('the nav badge counts leads nobody has called yet', async () => {
  await leadsAs('sales');
  const snap = app.__state().snapshot;
  assert.equal(String(nodes['#tab-leads-badge'].textContent), String(snap.leads_summary.received_uncontacted));
  assert.equal(nodes['#tab-leads-badge'].hidden, snap.leads_summary.received_uncontacted === 0);

  window.location.href = 'http://localhost:8787/?mock=empty&role=sales';
  window.location.search = '?mock=empty&role=sales';
  await app.__refresh();
  await renderRoute('#/leads');
  assert.equal(nodes['#tab-leads-badge'].hidden, true, 'zero means no badge');
});

await check('the lead detail carries the whole record and its pending writes', async () => {
  const out = await leadsAs('sales', '#/lead/L1005');
  assert.ok(out.includes('Harbor Line Logistics'));
  assert.ok(out.includes('990142'), 'the quote number');
  assert.ok(out.includes('$28,900'), 'the value');
  assert.ok(out.includes('Potential commission'));
  assert.ok(out.includes('Who') && out.includes('The deal') && out.includes('Timing'));
  // evt-mock-8 is Kevin's pending stage move on this lead.
  assert.ok(out.includes('⏳ 1 pending change'), 'the pending write is badged');
  assert.ok(out.includes('stage → Demo booked'), 'and described in English');
  assert.ok(out.includes('data-sheet="undo"'), 'and Kevin may take his own tap back');
});

await check('a tech sees a lead but no stage picker, and can still add a note', async () => {
  const out = await leadsAsStrippedService('#/lead/L1005');
  assert.ok(!out.includes('data-lead-stage='), 'no stage buttons for service');
  assert.ok(out.includes('Kevin and Matt work the pipeline'));
  assert.ok(out.includes('data-sheet="lead-note"'), 'a note is still theirs to add');
  assert.ok(!out.includes('data-sheet="lead-value"'), 'the value is not');
  assert.ok(!out.includes('data-sheet="lead-close"'), 'nor is closing it');
  assert.ok(!out.includes('$28,900') && !out.includes('Potential commission'), 'and no money anywhere');
});

await check('Kevin gets four stages, Matt gets Invoiced too', async () => {
  const kevin = [...(await leadsAs('sales', '#/lead/L1005')).matchAll(/data-lead-stage="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(kevin, BOARD_STAGES, 'INVOICED is hidden from sales');
  const matt = [...(await leadsAs('owner', '#/lead/L1005')).matchAll(/data-lead-stage="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(matt, BOARD_STAGES.concat('INVOICED'));
});

await check('a pending lead_open shows without inventing a lead number', async () => {
  const out = await leadsAs('service');
  assert.ok(out.includes('Stonebridge Cold Storage'), 'the pending new lead is on screen');
  assert.ok(out.includes('The engine assigns the lead number at the next run.'));
  assert.ok(!/L\?+/.test(out) && !out.includes('href="#/lead/undefined"'), 'no invented id');
});

await check('a demo hold on a unit page links back to its lead (§4)', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=sales';
  window.location.search = '?mock=full&role=sales';
  await app.__refresh();
  const snap = app.__state().snapshot;
  const withDemo = snap.leads.find((l) => l.demo && l.demo.hold_id);
  assert.ok(withDemo, 'the fixture must hold a lead with a booked demo');
  const out = await renderRoute(`#/unit/${encodeURIComponent(withDemo.demo.serial)}`);
  assert.ok(out.includes(`href="#/lead/${withDemo.lead}"`), 'the hold row links to the lead');
  assert.ok(out.includes('>demo</span>'), 'and says it is a demo');
});

await check('a lead pointing at a service ticket deep-links to it', async () => {
  const out = await leadsAs('sales', '#/lead/L1008');
  const t = app.__state().snapshot.leads.find((l) => l.lead === 'L1008').related_ticket;
  assert.ok(t, 'the fixture must wire one lead to a ticket');
  assert.ok(out.includes(`href="#/ticket/${t}"`));
});

await check('a quote file link is drawn only for an http(s) URL', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=sales';
  window.location.search = '?mock=full&role=sales';
  await app.__refresh();
  const l = app.__state().snapshot.leads.find((x) => x.quote);
  assert.ok(l, 'the fixture must hold a lead with a quote');

  // The engine puts this URL in the snapshot and we turn it into an href.
  // Escaping keeps it inside the attribute; it does not make the scheme safe.
  l.quote.file = 'javascript:alert(1)';
  let out = await renderRoute(`#/lead/${l.lead}`);
  assert.ok(!out.includes('javascript:'), 'a javascript: quote link must not be drawn');
  assert.ok(!out.includes('>open</a>'), 'and no link at all, rather than a dead one');

  l.quote.file = 'https://files.example.com/q/990142.pdf';
  out = await renderRoute(`#/lead/${l.lead}`);
  assert.ok(out.includes('href="https://files.example.com/q/990142.pdf"'), 'a real link is drawn');
  assert.ok(out.includes('rel="noopener noreferrer"'));
  l.quote.file = null;
});

/* ------------------------------------------------- notes timeline (v2.4) -- */

await check('a ticket renders its log oldest-first, text primary, who as a chip', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=service';
  window.location.search = '?mock=full&role=service';
  await app.__refresh();
  const t = app.__state().snapshot.service_queue.find((x) => (x.log || []).length >= 3);
  assert.ok(t, 'the fixture must hold a ticket with a real log');

  const out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(out.includes('<h2>Notes'), 'the section is called Notes');

  // Every row is on screen, in the engine's order — newest therefore at the bottom.
  const texts = [...out.matchAll(/class="ntext">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(texts.length, t.log.length, 'every row renders, none dropped');
  assert.deepEqual(texts.map((x) => x.slice(0, 24)), t.log.map((r) => esc(r.text).slice(0, 24)),
    'oldest first — the order the engine sent, never re-sorted');

  // who is a chip only when the engine parsed one.
  const withWho = t.log.filter((r) => r.who);
  assert.equal([...out.matchAll(/class="nwho">/g)].length, withWho.length,
    'one chip per authored row, none for the imports');
  for (const r of withWho) assert.ok(out.includes(`class="nwho">${r.who}<`), `${r.who} should have a chip`);

  // ts verbatim, in both shapes, and never Date-parsed.
  for (const r of t.log) assert.ok(out.includes(`class="nts">${esc(r.ts)}<`), `${r.ts} must render verbatim`);
  assert.ok(!/Invalid Date|GMT|T00:00:00/.test(out), 'the CT shape must never reach new Date()');
});

// The page escapes what it interpolates; the assertions above compare against
// the same escaping rather than the raw fixture text.
function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

await check('this session\'s pending note closes the timeline, badged (v2.5)', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=service&pending=1';
  window.location.search = '?mock=full&role=service&pending=1';
  await app.__refresh();
  // evt-mock-5 is Zac's ticket_update on S1004, and it carries a note.
  const ev = app.__state().pending.find((e) => e.action === 'ticket_update' && e.payload && e.payload.note);
  assert.ok(ev, 'the fixture must hold a pending note');
  const t = app.__state().service_queue
    ? null : app.__state().snapshot.service_queue.find((x) => x.ticket === ev.payload.ticket);
  assert.ok(t && (t.log || []).length, 'and it must land on a ticket that already has a log');

  const out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(out.includes('class="nrow is-pending"'), 'the pending note is tinted');
  assert.ok(out.includes('⏳ applies at the next run'), 'and says it has not landed');
  assert.ok(out.indexOf('is-pending') > out.indexOf(esc(t.log[t.log.length - 1].text).slice(0, 24)),
    'it closes the timeline, newest last (v2.5) — below the record, not above it');
  assert.ok(out.includes(esc(ev.payload.note)), 'the note text itself is on screen');
});

await check('a lead renders its log the same way', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=sales';
  window.location.search = '?mock=full&role=sales';
  await app.__refresh();
  const l = app.__state().snapshot.leads.find((x) => (x.log || []).length >= 3);
  assert.ok(l, 'the fixture must hold a lead with a log');
  const out = await renderRoute(`#/lead/${encodeURIComponent(l.lead)}`);
  assert.equal([...out.matchAll(/class="ntext">/g)].length, l.log.length);
  assert.ok(out.includes(`class="nts">${esc(l.log[0].ts)}<`));
});

await check('an empty log renders "No notes yet.", not a gap', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=service';
  window.location.search = '?mock=full&role=service';
  await app.__refresh();
  const snap = app.__state().snapshot;
  const bare = snap.service_queue.find((x) => !(x.log || []).length);
  assert.ok(bare, 'the fixture must hold a ticket with no log');
  const out = await renderRoute(`#/ticket/${encodeURIComponent(bare.ticket)}`);
  assert.ok(out.includes('<h2>Notes'), 'the section still draws');
  assert.ok(out.includes('No notes yet.'));
  assert.ok(!out.includes('class="ntext"'));
});

await check('a schema-2 snapshot has no log field at all and still renders Notes', async () => {
  window.location.href = 'http://localhost:8787/?mock=legacy&role=owner';
  window.location.search = '?mock=legacy&role=owner';
  await app.__refresh();
  const t = app.__state().snapshot.service_queue[0];
  assert.equal(t.log, undefined, 'the legacy fixture predates log[] by three schema versions');
  const out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket || t.ticket_id)}`);
  assert.ok(out.includes('No notes yet.') || !out.includes('<h2>Notes'), 'an absent field is not a crash');
});

await check('a service token KEEPS the lead log — it is money-free by contract (v2.5)', async () => {
  // v2.4 stripped it, because the engine was writing figures into that free
  // text. v2.5 fixed it upstream: a lead log row reads "value set" now, and the
  // builder refuses to publish one carrying a figure. So Josh gets his own lead
  // notes back — and the money assertion moves onto the TEXT, where the
  // guarantee now lives.
  const out = await leadsAsStrippedService('#/lead/L1005');
  assert.ok(out.includes('class="nrow">'), 'the lead log renders for a tech again');
  assert.ok(out.includes('Kevin value set'), 'including the value-change row, figure-free');

  // The gate itself is unchanged: the structured money is still gone, and now
  // nothing in the log text puts it back.
  assert.ok(!out.includes('class="lead-money"') && !out.includes('Potential commission'));
  assert.ok(!/\$\s?\d/.test(out), 'no dollar figure anywhere on the page, log text included');

  // Kevin sees the same log plus the money that belongs to him.
  window.location.href = 'http://localhost:8787/?mock=full&role=sales';
  window.location.search = '?mock=full&role=sales';
  await app.__refresh();
  const kevin = await renderRoute('#/lead/L1005');
  assert.ok(kevin.includes('Kevin value set'), 'sales sees the same money-free log row');
  assert.ok(/\$\s?\d/.test(kevin), 'and the structured money the tech does not get');

  // Ticket logs were never gated and still are not.
  window.location.href = 'http://localhost:8787/?mock=full&role=service';
  window.location.search = '?mock=full&role=service';
  await app.__refresh();
  const t = app.__state().snapshot.service_queue.find((x) => (x.log || []).length >= 3);
  const josh = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(josh.includes('class="nrow">'), 'ticket logs are not gated');
});

await check('no lead log row anywhere in the fixture carries a dollar figure', async () => {
  // The client-side half of the v2.5 contract. The Worker half is
  // tools/money-gate.mjs, which asserts the same regex on a real payload.
  window.location.href = 'http://localhost:8787/?mock=full&role=sales';
  window.location.search = '?mock=full&role=sales';
  await app.__refresh();
  const rows = app.__state().snapshot.leads.flatMap((l) => l.log || []);
  assert.ok(rows.length, 'the fixture must actually have lead log rows to check');
  const bad = rows.filter((r) => /\$\s?\d/.test(r.text));
  assert.deepEqual(bad, [], `a lead log row carries a figure: ${bad.map((r) => r.text).join(' | ')}`);
});

await check('a schema-4 snapshot says leads have not arrived, rather than drawing an empty board', async () => {
  window.location.href = 'http://localhost:8787/?mock=legacy&role=sales';
  window.location.search = '?mock=legacy&role=sales';
  await app.__refresh();
  const out = await renderRoute('#/leads');
  assert.ok(out.includes('No leads in this snapshot.'));
  assert.ok(!out.includes('kan-head'), 'no board at all — the keys are absent, not empty');
  assert.equal(nodes['#tab-leads-badge'].hidden, true);
});

/* ============================================ documents (schema 6) ========= */

const asFull = async (role = 'owner') => {
  window.location.href = `http://localhost:8787/?mock=full&role=${role}`;
  window.location.search = `?mock=full&role=${role}`;
  await app.__refresh();
  return app.__state().snapshot;
};

await check('ticket detail draws a Documents group above Notes', async () => {
  const snap = await asFull('service');
  const t = snap.service_queue.find((x) => (x.docs || []).length > 1);
  assert.ok(t, 'the fixture must carry a ticket with more than one doc');

  const out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(out.includes('<h2>Documents'), 'no Documents header');
  assert.equal([...out.matchAll(/class="docrow"/g)].length, t.docs.length, 'one row per doc');

  // It sits between the ticket card and the Notes timeline (the work order's
  // placement), so a tech scrolling for the diagnosis passes the paperwork.
  assert.ok(out.indexOf('<h2>Documents') < out.indexOf('<h2>Notes'), 'Documents must come before Notes');

  // Row content: icon, "Kind — name", humanized size.
  for (const d of t.docs) {
    assert.ok(out.includes(`data-doc="${d.id}"`), `${d.name} is not linked`);
    assert.ok(out.includes(d.name), `${d.name} is not named`);
  }
  assert.ok(out.includes('📝') && out.includes('🖼'), 'both icons on a ticket that has both kinds');
  assert.ok(out.includes('1.9 MB'), 'the photo\'s size is not humanized');
});

await check('the doc row is a button, and it carries only the id — never a storage key', async () => {
  const snap = await asFull('owner');
  const t = snap.service_queue.find((x) => (x.docs || []).length);
  const out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(/<button class="docrow" type="button" data-doc="[0-9a-f]{16}">/.test(out));
  assert.ok(!out.includes('docmeta:') && !/["'>]doc:/.test(out), 'no KV key may reach the page');
  // No href: the tap opens a new tab through window.open with the token, which
  // an <a href> would have to put in the markup on every row.
  assert.ok(!/docrow[^>]*href=/.test(out));
});

await check('lead detail draws the same group — a QUOTE on a lead is fine', async () => {
  const snap = await asFull('sales');
  const l = snap.leads.find((x) => (x.docs || []).length);
  assert.ok(l, 'the fixture must carry a lead with a doc');
  const out = await renderRoute(`#/lead/${encodeURIComponent(l.lead)}`);
  assert.ok(out.includes('<h2>Documents'));
  assert.ok(out.includes(`data-doc="${l.docs[0].id}"`));
  assert.ok(out.indexOf('<h2>Documents') < out.indexOf('<h2>Notes'));
});

await check('a service token sees the lead doc too — docs are never role-gated', async () => {
  const snap = await asFull('service');
  const l = snap.leads.find((x) => (x.docs || []).length);
  const out = await renderRoute(`#/lead/${encodeURIComponent(l.lead)}`);
  assert.ok(out.includes(`data-doc="${l.docs[0].id}"`), 'a tech must be able to open the quote');
});

await check('an empty docs[] draws no ROWS, and no count — but keeps the two doors (S2)', async () => {
  // S1 rendered nothing at all here. S2 supersedes that on a detail view: the
  // add buttons live in this group, so an empty group is not a placeholder, it
  // is how a document gets onto the ticket. No count chip, no rows, no
  // "No documents" text — just the two doors.
  const snap = await asFull('owner');
  const t = snap.service_queue.find((x) => !(x.docs || []).length);
  assert.ok(t, 'the fixture must carry a ticket with no docs');
  const out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(out.includes('<h2>Documents<'), 'the group draws, with no count chip');
  assert.ok(!/<h2>Documents <span class="count"/.test(out), 'nothing to count');
  assert.ok(!out.includes('class="docrow"'), 'no rows');
  assert.ok(!/No documents/i.test(out), 'still no placeholder text');
  assert.ok(out.includes('data-doc-pick="camera"') && out.includes('data-doc-pick="file"'));
  assert.ok(out.includes('<h2>Notes'), 'Notes still renders its own empty state — that is a different call');
});

await check('a schema-5 snapshot (no docs key anywhere) renders ticket + lead detail', async () => {
  // The forward/backward-compatibility case: schema 5 is still on KV until the
  // engine publishes a 6. Not one view may notice.
  const snap = await asFull('owner');
  snap.meta.schema_version = 5;
  for (const t of snap.service_queue) delete t.docs;
  for (const l of snap.leads) delete l.docs;
  for (const a of snap.agreements) delete a.docs;

  for (const t of snap.service_queue) {
    const out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
    assert.ok(!out.includes('undefined'), `${t.ticket} leaked undefined`);
    assert.ok(!/<h2>Documents <span class="count"/.test(out), `${t.ticket} counted documents it does not have`);
    assert.ok(!out.includes('class="docrow"'), `${t.ticket} drew a document row out of nothing`);
  }
  for (const l of snap.leads) {
    const out = await renderRoute(`#/lead/${encodeURIComponent(l.lead)}`);
    assert.ok(!out.includes('undefined'), `${l.lead} leaked undefined`);
    assert.ok(!/<h2>Documents <span class="count"/.test(out));
    assert.ok(!out.includes('class="docrow"'));
  }
  await asFull('owner');   // put the fixture back for anything after this
});

/* ================================= document upload — S2 =================== */

/**
 * Drive the real handlers the way a phone does: a `change` from a hidden file
 * input, then a `click` on one of the kind buttons. Nothing is faked past the
 * event target — prepareFile, resolveKind, sendUpload and the renderer are all
 * the shipping code.
 */
const fireOn = async (type, target) => {
  for (const fn of listeners.get(type) || []) await fn({ target });
};
const fakeTarget = (sel, extra) => {
  const node = { dataset: {}, files: null, value: '', disabled: false, ...extra };
  node.closest = (q) => (q === sel ? node : null);
  node.parentNode = { querySelector: () => null };
  return node;
};

/** Choose a file for a record, then tap a kind. Returns after the send settles. */
async function attach({ record, file, source = 'file', kindChoice = 'WORKORDER' }) {
  await fireOn('change', fakeTarget('[data-doc-input]', {
    dataset: { record, docInput: source }, files: [file],
  }));
  await settle();
  await fireOn('click', fakeTarget('[data-doc-kind]', { dataset: { docKind: kindChoice } }));
  await settle();
}

/**
 * Put the app in API mode against a stubbed Worker, because uploads are refused
 * in mock mode by design (docs/api.js) — so the upload path can only be tested
 * on the real one. `handler(url, init)` answers /api/doc and /api/event.
 */
const realFetch = globalThis.fetch;
async function apiMode(handler) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/data')) {
      return { ok: true, status: 200, json: async () => ({ me: { name: 'Josh', role: 'service' }, snapshot, pending: [] }) };
    }
    return handler(u, init);
  };
  window.location.href = 'https://fleet.wisconsinscrubandsweep.com/?t=0123456789abcdef0123456789abcdef';
  window.location.search = '?t=0123456789abcdef0123456789abcdef';
  window.location.hostname = 'fleet.wisconsinscrubandsweep.com';
  window.location.protocol = 'https:';
  await app.__refresh();
  return snapshot;
}
async function backToMock() {
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
}

await check('a 4000x3000 photo is resized to 1600px long edge at q0.7, EXIF honoured', async () => {
  const sent = [];
  const snap = await apiMode(async (u, init) => {
    if (u.endsWith('/api/doc')) {
      sent.push({ headers: init.headers, blob: init.body });
      return { ok: true, status: 201, json: async () => ({ id: 'aaaabbbbccccdddd', bytes: 1, existed: false }) };
    }
    return { ok: true, status: 201, json: async () => ({ id: 'evt1', ts: 'x', actor: 'Josh', role: 'service', action: 'doc_attach', serial: null, payload: JSON.parse(init.body).payload }) };
  });
  const t = snap.service_queue[0];
  await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);

  encodes.length = 0; bitmapOpts.length = 0;
  const original = new File([new Uint8Array(9_000_000)], 'IMG_4821.jpg', { type: 'image/jpeg' });
  await attach({ record: t.ticket, file: original, source: 'camera', kindChoice: 'OTHER' });

  // The EXIF ask comes first, or every portrait photo lands on its side.
  assert.deepEqual(bitmapOpts[0], { imageOrientation: 'from-image' });

  // Two encodes: the upload, then the thumbnail.
  const [upload] = encodes;
  assert.equal(Math.max(upload.w, upload.h), 1600, 'long edge must be capped at 1600');
  assert.equal(upload.w, 1600); assert.equal(upload.h, 1200, 'aspect ratio kept');
  assert.equal(upload.type, 'image/jpeg', 'PNG in, JPEG out — always JPEG');
  assert.equal(upload.quality, 0.7);

  // What actually went up is the RESIZED blob, not the 9 MB the camera gave us.
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].blob, original, 'the original file must never be the body');
  assert.ok(sent[0].blob.size < original.size / 10, 'the upload is a fraction of the capture');

  // The camera's own "IMG_4821.jpg" is replaced; a camera capture is named
  // after the record and the minute, and "Other" on an image means PHOTO.
  const h = sent[0].headers;
  assert.match(h['X-Doc-Name'], new RegExp(`^WO-${t.ticket}-\\d{8}-\\d{4}\\.jpg$`));
  assert.equal(h['X-Doc-Kind'], 'PHOTO');
  assert.equal(h['X-Doc-Record'], t.ticket);
  assert.equal(h['Content-Type'], 'image/jpeg');

  await backToMock();
});

await check('a PDF goes up byte-identical — no canvas, no re-encode, no conversion', async () => {
  const sent = [];
  const snap = await apiMode(async (u, init) => {
    if (u.endsWith('/api/doc')) {
      sent.push({ headers: init.headers, blob: init.body });
      return { ok: true, status: 201, json: async () => ({ id: 'ab0b83a1b88c21ff', bytes: 24557, existed: false }) };
    }
    return { ok: true, status: 201, json: async () => ({ id: 'evt2', action: 'doc_attach', actor: 'Josh', payload: JSON.parse(init.body).payload }) };
  });
  const t = snap.service_queue[0];
  await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);

  encodes.length = 0;
  const bytes = fs.readFileSync(path.join(HERE, '..', 'test', 'fixtures', 'sample-quote.pdf'));
  const pdf = new File([bytes], 'Fairmont Quote.pdf', { type: 'application/pdf' });
  await attach({ record: t.ticket, file: pdf, kindChoice: 'OTHER' });

  assert.equal(encodes.length, 0, 'a PDF must never touch the canvas');
  assert.equal(sent[0].blob, pdf, 'the very same File object goes out');
  assert.equal(sent[0].headers['Content-Type'], 'application/pdf');
  assert.equal(sent[0].headers['X-Doc-Kind'], 'OTHER', 'a PDF marked Other stays OTHER, never PHOTO');
  assert.equal(sent[0].headers['X-Doc-Name'], 'Fairmont Quote.pdf', 'a picked file keeps its own name');

  await backToMock();
});

await check('a failed send shows the retry row, and the retry needs no second pick', async () => {
  let attempts = 0;
  const snap = await apiMode(async (u, init) => {
    if (u.endsWith('/api/doc')) {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 413, json: async () => ({ error: 'too large' }) };
      return { ok: true, status: 201, json: async () => ({ id: 'ab0b83a1b88c21ff', bytes: 10, existed: false }) };
    }
    return { ok: true, status: 201, json: async () => ({ id: 'evt3', action: 'doc_attach', actor: 'Josh', payload: JSON.parse(init.body).payload }) };
  });
  const t = snap.service_queue[0];
  await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);

  const pdf = new File([new Uint8Array(64)], 'wo.pdf', { type: 'application/pdf' });
  await attach({ record: t.ticket, file: pdf });

  let out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(out.includes('is-failed'), 'a failed send must show as failed');
  assert.ok(out.includes('Too big (max 10 MB)'), 'the 413 is translated, not echoed as a number');
  assert.ok(out.includes('tap to retry'));
  const retryId = /data-doc-retry="([^"]+)"/.exec(out);
  assert.ok(retryId, 'the failed row must carry a retry handle');

  // The retry re-sends the blob already in memory — no change event, no picker.
  await fireOn('click', fakeTarget('[data-doc-retry]', { dataset: { docRetry: retryId[1] } }));
  await settle();
  assert.equal(attempts, 2, 'the second attempt reused the in-memory blob');

  out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(!out.includes('is-failed'), 'the failed row is gone once it lands');
  assert.ok(out.includes('is-pending') && out.includes('⏳ filing'), 'it becomes a pending row');
  assert.ok(!out.includes('data-doc="ab0b83a1b88c21ff"'), 'and is NOT tappable — the engine has not filed it');

  await backToMock();
});

await check('a pending doc_attach renders on its own record and nowhere else', async () => {
  const snap = await asFull('owner');
  const [a, b] = snap.service_queue;
  const lead = snap.leads[0];
  app.__state().pending.push(
    { id: 'e1', action: 'doc_attach', actor: 'Josh', role: 'service', serial: null,
      payload: { record: a.ticket, doc_id: '1111222233334444', kind: 'WORKORDER', name: 'wo.pdf' } },
    { id: 'e2', action: 'doc_attach', actor: 'Kevin', role: 'sales', serial: null,
      payload: { record: lead.lead, doc_id: '5555666677778888', kind: 'PHOTO', name: 'site.jpg' } },
  );

  const onA = await renderRoute(`#/ticket/${encodeURIComponent(a.ticket)}`);
  assert.ok(onA.includes('Workorder — wo.pdf') && onA.includes('is-pending'));
  assert.ok(!onA.includes('site.jpg'), "the lead's document must not appear on a ticket");

  const onB = await renderRoute(`#/ticket/${encodeURIComponent(b.ticket)}`);
  assert.ok(!onB.includes('wo.pdf'), 'and not on a different ticket either');

  const onLead = await renderRoute(`#/lead/${encodeURIComponent(lead.lead)}`);
  assert.ok(onLead.includes('Photo — site.jpg') && onLead.includes('is-pending'));
  assert.ok(!onLead.includes('wo.pdf'));

  // It counts as a document on that record, and it is not openable.
  assert.ok(/<h2>Documents <span class="count">/.test(onA));
  assert.ok(!onA.includes('data-doc="1111222233334444"'));

  app.__state().pending.length = 0;
  await asFull('owner');
});

await check('a malformed pending doc_attach is dropped, never drawn as a broken row', async () => {
  const snap = await asFull('owner');
  const t = snap.service_queue[0];
  app.__state().pending.push(
    { id: 'x1', action: 'doc_attach', payload: { record: t.ticket, doc_id: 'NOTHEX', kind: 'OTHER', name: 'a' } },
    { id: 'x2', action: 'doc_attach', payload: { record: t.ticket, kind: 'OTHER', name: 'b' } },
  );
  const out = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(!out.includes('NOTHEX'));
  assert.ok(!out.includes('is-pending'), 'neither row may draw');
  app.__state().pending.length = 0;
  await asFull('owner');
});

/* ==================================================== the map — D52 ======== */

import { collect, stack, geoMeta, projector, boxToViewBox } from '../docs/map.js';

/** Render #/dispatch/map, giving the lazily-fetched asset time to land. */
async function mapView(role = 'owner') {
  window.location.href = `http://localhost:8787/?mock=full&role=${role}`;
  window.location.search = `?mock=full&role=${role}`;
  await app.__refresh();
  let out = await renderRoute('#/dispatch/map');
  // loadMap() fetches once and re-renders; the first pass is the loading state.
  for (let i = 0; i < 6 && !out.includes('id="wimap"'); i++) {
    await settle();
    out = view._html;
  }
  return out;
}

const projectFromAsset = () => projector(new Map([...fs.readFileSync(path.join(DOCS, 'wi-map.svg'), 'utf8')
  .match(/<svg\b[^>]*>/i)[0].matchAll(/([a-zA-Z0-9-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]])));

const mapClick = async (target) => {
  for (const fn of listeners.get('click') || []) await fn({ target });
  await settle();
};
const pick = (sel, dataset) => {
  const node = { dataset, disabled: false };
  node.closest = (q) => (q === sel ? node : null);
  node.parentNode = { querySelector: () => null };
  return node;
};

await check('#/dispatch/map draws the asset inline at the SE-Wisconsin default view', async () => {
  const out = await mapView();
  assert.ok(out.includes('id="wimap"'), 'the map never rendered');
  // Inline, not an <img>: pins must be children of the same document or the
  // CSS variables that repaint the counties never reach them.
  assert.ok(!/<img[^>]+wi-map\.svg/.test(out), 'the map must be inlined, not <img>-ed');
  assert.ok(out.includes('id="counties"') && out.includes('class="county"'), 'the asset body is missing');
  assert.ok(out.includes('id="interstates"'), 'the asset was truncated');

  // The opening viewport is meta.geo.default_view, projected — not the whole state.
  const snap = app.__state().snapshot;
  const g = geoMeta(snap);
  const project = projectFromAsset();
  const want = boxToViewBox(g.default_view, project);
  const got = /id="wimap"[^>]*viewBox="([^"]+)"/.exec(out);
  assert.ok(got, 'no viewBox on the map');
  const [x, y, w, h] = got[1].split(/\s+/).map(Number);
  assert.ok(Math.abs(x - want.x) < 0.5 && Math.abs(y - want.y) < 0.5, `opened at ${got[1]}`);
  assert.ok(Math.abs(w - want.w) < 0.5 && Math.abs(h - want.h) < 0.5);
  assert.ok(w < 880, 'the default view must be a window, not the whole state');

  assert.ok(out.includes('data-map="home"') && out.includes('data-map="fit"'), '⌂ and ⤢ must both be there');
});

await check('the shop pin lands on Ixonia and is never filterable', async () => {
  const out = await mapView();
  const g = geoMeta(app.__state().snapshot);
  const m = /<g class="pin shop" data-x="([\d.]+)" data-y="([\d.]+)"/.exec(out);
  assert.ok(m, 'no shop pin');
  // 618.4, 792.5 is Jefferson County — asserted against the real county
  // polygons in tools/selftest-map.mjs; here we only check it is that point.
  assert.ok(Math.abs(Number(m[1]) - 618.4) < 1, `shop x ${m[1]}`);
  assert.ok(Math.abs(Number(m[2]) - 792.5) < 1, `shop y ${m[2]}`);
  assert.ok(out.includes('>WSS</text>'));
  assert.ok(!/data-mapkind="shop"/.test(out), 'the shop is not a filter chip');
});

await check('every pin obeys the §3.3 table, and nothing else is drawn', async () => {
  const out = await mapView();
  const snap = app.__state().snapshot;
  const { pins, off } = collect(snap);
  const stacks = stack(pins);

  const drawn = [...out.matchAll(/data-stack="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(drawn.length, stacks.length, 'one pin per stack, no more');
  assert.deepEqual(new Set(drawn), new Set(stacks.map((s) => s.key)));

  // A geo:null row and an out-of-state row are in the off-map list and NOWHERE
  // else. This is the assertion that stops a bad address becoming a wrong pin.
  assert.ok(off.length, 'the fixture must carry off-map rows');
  for (const r of off) {
    assert.ok(!drawn.some((k) => k.includes(String(r.lat))), `${r.id} must not be pinned`);
    assert.ok(out.includes(`>${r.address || '(no address)'}<`), `${r.id} must be listed with its raw address`);
  }
  assert.ok(out.includes('Off the map'), 'the off-map block is missing');
});

await check('every marker is the same teardrop, whatever its precision (D53)', async () => {
  const out = await mapView();
  const { pins } = collect(app.__state().snapshot);
  const stacks = stack(pins);
  assert.ok(stacks.some((s) => s.precision === 'city'), 'the fixture needs a city-precision place');
  assert.ok(stacks.some((s) => s.precision !== 'city'), 'and a finer one');

  // The hollow variant is gone from the code and from the screen.
  assert.ok(!out.includes('hollow'), 'no hollow markers may render');
  assert.ok(!/solid = |hollow = /.test(out), 'and the legend must not still explain them');

  // One teardrop path, used by every pin, tip on the coordinate (0,0).
  const teardrops = [...out.matchAll(/<path class="pg" d="M0,0 C[^"]+"/g)];
  assert.equal(teardrops.length, stacks.length + 1, 'one teardrop per stack, plus the shop');
  for (const st of stacks) {
    assert.ok(new RegExp(`data-stack="${st.key}"[\\s\\S]{0,400}<path class="pg" d="M0,0 C`).test(out),
      `${st.key} is not a teardrop`);
  }
});

await check('no pin is red — the brand colour is the shop and the chrome only', async () => {
  const css = fs.readFileSync(path.join(DOCS, 'style.css'), 'utf8');
  const block = /--pin-service:([^;]+);[\s\S]*?--pin-rental:([^;]+);/.exec(css);
  assert.ok(block, 'the pin palette is missing');
  const kinds = [...css.matchAll(/--pin-(service|pickup|delivery|lead|rental):\s*([^;]+);/g)]
    .map(([, k, v]) => [k, v.trim()]);
  assert.equal(kinds.length, 5);
  // "Not red" is a question about HUE, not about how much red channel a colour
  // has — the mandated pick-up orange #F97316 is 98% red channel and is plainly
  // not red. The brand maroons sit at hue ~0; anything within 15 degrees of
  // that would disappear into the app's own chrome.
  const hue = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  assert.ok(hue('#B71C1C') < 5, 'sanity: the brand maroon sits at hue ~0');
  for (const [k, v] of kinds) {
    assert.ok(/^#[0-9A-Fa-f]{6}$/.test(v), `${k} should be a literal hex, got ${v}`);
    // Nothing that resolves to a brand variable, either.
    assert.ok(!/var\(--red/.test(v) && !/var\(--bad/.test(v), `${k} is brand red`);
    const h = hue(v);
    assert.ok(h > 15 && h < 345, `${k} (${v}) is hue ${h.toFixed(0)} — inside the brand-red band`);
  }
  // And they have to hold apart from EACH OTHER, not just from the brand.
  const hues = kinds.map(([, v]) => hue(v)).sort((a, b) => a - b);
  for (let i = 1; i < hues.length; i++) {
    assert.ok(hues[i] - hues[i - 1] > 25, `two kinds are ${(hues[i] - hues[i - 1]).toFixed(0)} degrees apart`);
  }
  // Five distinct hues, and the filter chips wear them too.
  assert.equal(new Set(kinds.map(([, v]) => v.toLowerCase())).size, 5);
  for (const [k] of kinds) assert.ok(css.includes(`.mk-${k}`), `no chip swatch for ${k}`);
});

await check('the beige D52 overrides are gone; the asset paints itself', async () => {
  const css = fs.readFileSync(path.join(DOCS, 'style.css'), 'utf8');
  for (const dead of ['#F4F1EA', '#DDD6C8', '#E4D8BC', '#C9BC88', '#9A9384']) {
    assert.ok(!css.includes(dead), `style.css still carries the beige ${dead}`);
  }
  // No --map-* override at all: the asset's own fallbacks are the design.
  const overrides = [...css.matchAll(/^\s*--map-[a-z-]+:/gm)].map((m) => m[0].trim());
  assert.deepEqual(overrides, [], `style.css must not re-declare ${overrides.join(', ')}`);
  // And the asset does carry them, with the D53 values.
  const svg = fs.readFileSync(path.join(DOCS, 'wi-map.svg'), 'utf8');
  for (const [v, fallback] of [['--map-water', '#CDE3F6'], ['--map-land', '#F1F3F5'],
    ['--map-line', '#D3D8DE'], ['--map-road', '#FFFFFF'], ['--map-i', '#FFFFFF']]) {
    assert.ok(svg.includes(`var(${v},${fallback})`), `the asset lost ${v}'s fallback`);
  }
});

await check('every pin shows its ID chip at the default view, and loses it state-wide', async () => {
  const out = await mapView();
  const { pins } = collect(app.__state().snapshot);
  const stacks = stack(pins);

  // At the opening zoom: a chip per pin, carrying the row's own id.
  assert.ok(!/class="wimap[^"]*\bfar\b/.test(out), 'the default view must NOT be in chips-off mode');
  const chips = [...out.matchAll(/<g class="chip">/g)];
  assert.equal(chips.length, stacks.length + 1, 'one chip per pin, plus the shop');
  for (const st of stacks) {
    const one = st.rows.length === 1;
    const want = one ? st.rows[0].label : `${st.rows[0].label} +${st.rows.length - 1}`;
    assert.ok(out.includes(`>${want}</text>`), `${st.key} chip should read "${want}"`);
  }
  assert.ok(out.includes('>WSS</text>'), 'the shop keeps its chip');

  // Zoomed out to the whole state, the chips go away — CSS hides them off the
  // `far` class, so the markup keeps them and the class is the switch.
  await mapClick(pick('[data-map]', { map: 'fit' }));
  const wide = await renderRoute('#/dispatch/map');
  assert.ok(/class="wimap[^"]*\bfar\b/.test(wide), 'the whole state must switch chips off');
  const css = fs.readFileSync(path.join(DOCS, 'style.css'), 'utf8');
  assert.ok(/\.wimap\.far \.pin \.chip \{ display: none/.test(css), 'nothing actually hides them');

  // And back in restores them.
  await mapClick(pick('[data-map]', { map: 'home' }));
  const back = await renderRoute('#/dispatch/map');
  assert.ok(!/class="wimap[^"]*\bfar\b/.test(back), 'coming home must bring the chips back');
});

await check('the sheet says the precision in words, and says nothing for a rooftop', async () => {
  await mapView();
  const { pins } = collect(app.__state().snapshot);
  const stacks = stack(pins);
  const city = stacks.find((s) => s.precision === 'city');
  const street = stacks.find((s) => s.precision === 'street');
  const roof = stacks.find((s) => s.precision === 'rooftop');
  assert.ok(city && street && roof, 'the fixture must cover all three (§6)');

  await mapClick(pick('[data-stack]', { stack: city.key }));
  let out = view._html;
  assert.ok(/<div class="sheet-prec"><strong>City center<\/strong> — no street address on file<\/div>/.test(out),
    'the city line is missing or reworded');
  // The marker itself says nothing about precision any more.
  assert.ok(!out.includes('hollow'));

  await mapClick(pick('[data-stack]', { stack: street.key }));
  out = view._html;
  assert.ok(/<strong>Approximate<\/strong> — street, no number/.test(out), 'the street line is missing');

  await mapClick(pick('[data-stack]', { stack: roof.key }));
  out = view._html;
  assert.ok(!out.includes('sheet-prec'), 'a rooftop address needs no apology');
  await mapClick(pick('[data-map]', { map: 'close' }));
});

await check('the map box is sized to the opening view, not the whole state', async () => {
  const out = await mapView();
  const m = /style="aspect-ratio: ([\d.]+) \/ ([\d.]+)"/.exec(out);
  assert.ok(m, 'the box has no aspect ratio, so the state will float in dead space');
  const ratio = Number(m[1]) / Number(m[2]);
  const g = geoMeta(app.__state().snapshot);
  const v = boxToViewBox(g.default_view, projectFromAsset());
  assert.ok(ratio > v.w / v.h, 'the box must be a little wider than the view (edge labels)');
  assert.ok(ratio < (v.w / v.h) * 1.35, 'but not so wide it becomes a letterbox');
  // The whole-state viewBox is much squarer; sizing to it is what left the band.
  assert.ok(ratio > 880 / 930, 'sized to the state, not the view');
});

await check('a stacked pin shows its count and the sheet lists every row', async () => {
  await mapView();
  const { pins } = collect(app.__state().snapshot);
  const multi = stack(pins).filter((s) => s.rows.length > 1)[0];
  assert.ok(multi, 'the fixture must carry a stack');

  let out = view._html;
  // D53: the badge moved onto the pin HEAD (the teardrop's circle) rather than
  // hanging off its shoulder, and the chip beside it carries "first +N".
  assert.ok(new RegExp(`data-stack="${multi.key}"[\\s\\S]{0,700}<g class="badge">[\\s\\S]{0,160}>${multi.rows.length}</text>`).test(out),
    'a stacked pin must carry a count badge');
  assert.ok(out.includes(`>${multi.rows[0].label} +${multi.rows.length - 1}</text>`),
    'and its chip must say how many more are under it');

  await mapClick(pick('[data-stack]', { stack: multi.key }));
  out = view._html;
  assert.ok(out.includes('class="sheet mapsheet"'), 'the sheet did not open');
  for (const r of multi.rows) {
    assert.ok(out.includes(`>${r.label}</span>`), `${r.label} is missing from the sheet`);
    assert.ok(out.includes(`href="${r.href}"`), `${r.label} has no Open link`);
  }
  // Navigate goes to coordinates, in a new tab.
  const nav = /<a class="btn" href="(https:\/\/www\.google\.com\/maps\/dir[^"]+)" target="_blank" rel="noopener noreferrer">Navigate<\/a>/.exec(out);
  assert.ok(nav, 'no Navigate button');
  assert.ok(nav[1].includes(encodeURIComponent(`${multi.lat.toFixed(6)},${multi.lng.toFixed(6)}`)));

  await mapClick(pick('[data-map]', { map: 'close' }));
});

await check('every Open link in the sheet lands on a route the app actually has', async () => {
  await mapView();
  const { pins } = collect(app.__state().snapshot);
  const snap = app.__state().snapshot;
  for (const st of stack(pins)) {
    await mapClick(pick('[data-stack]', { stack: st.key }));
    const out = view._html;
    for (const r of st.rows) {
      assert.ok(out.includes(`href="${r.href}"`), `${r.id}: ${r.href}`);
      // Follow it: a link to a detail page that does not exist is a dead end.
      const page = await renderRoute(r.href);
      assert.ok(!/not found\./i.test(page), `${r.href} is a dead link`);
      assert.ok(!page.includes('undefined'), `${r.href} leaked undefined`);
      await renderRoute('#/dispatch/map');
    }
  }
  assert.ok(snap.units.length, 'sanity');
  await mapClick(pick('[data-map]', { map: 'close' }));
});

await check('filter chips add and remove whole kinds', async () => {
  let out = await mapView();
  const { pins } = collect(app.__state().snapshot);
  const rentals = stack(pins.filter((p) => p.kind === 'rental'));
  assert.ok(rentals.length, 'the fixture needs rentals');
  assert.ok(out.includes('class="pin k-rental'), 'rentals start on');

  await mapClick(pick('[data-mapkind]', { mapkind: 'rental' }));
  out = view._html;
  assert.ok(!out.includes('class="pin k-rental'), 'switching Rentals off must remove them');
  assert.ok(out.includes('class="pin k-service') || out.includes('class="pin k-pickup'), 'and leave the rest');
  assert.ok(/data-mapkind="rental"[^>]*aria-pressed="false"/.test(out.replace(/class="[^"]*"/g, (c) => c)) ||
    out.includes('aria-pressed="false"'), 'the chip must show as off');

  await mapClick(pick('[data-mapkind]', { mapkind: 'rental' }));
  assert.ok(view._html.includes('class="pin k-rental'), 'and back on again');
});

await check('turning every chip off gives you the map back, not a blank one', async () => {
  await mapView();
  for (const k of ['service', 'pickup', 'delivery', 'lead', 'rental']) {
    await mapClick(pick('[data-mapkind]', { mapkind: k }));
  }
  const out = view._html;
  assert.ok(out.includes('class="pin k-'), 'a blank map reads as a broken map');
  assert.equal(app.__ui().mapKinds.size, 5);
});

await check('Plan a run: three stops become a multi-stop directions URL from the shop', async () => {
  await mapView();
  const { pins } = collect(app.__state().snapshot);
  const stacks = stack(pins).slice(0, 3);
  const g = geoMeta(app.__state().snapshot);

  await mapClick(pick('[data-map]', { map: 'plan' }));
  assert.ok(view._html.includes('Planning a run'));

  for (const st of stacks) await mapClick(pick('[data-stack]', { stack: st.key }));
  const out = view._html;

  // ①②③ on the pins, in tap order.
  for (let i = 0; i < stacks.length; i++) {
    assert.ok(new RegExp(`data-stack="${stacks[i].key}"[\\s\\S]{0,500}class="stopbadge"[\\s\\S]{0,120}>${i + 1}<`).test(out),
      `stop ${i + 1} has no numbered badge`);
  }

  const href = /<a class="btn" href="(https:\/\/www\.google\.com\/maps\/dir[^"]+)"[^>]*>Open route \(3\)/.exec(out);
  assert.ok(href, 'no Open route button');
  const q = new URL(href[1].replace(/&amp;/g, '&')).searchParams;
  assert.equal(q.get('origin'), `${g.shop.lat.toFixed(6)},${g.shop.lng.toFixed(6)}`, 'the shop is the origin');
  assert.equal(q.get('travelmode'), 'driving');
  // Default is "back to the shop": destination = shop, all three are waypoints.
  assert.equal(q.get('destination'), q.get('origin'));
  assert.equal(q.get('waypoints').split('|').length, 3);
  assert.deepEqual(q.get('waypoints').split('|'), stacks.map((s) => `${s.lat.toFixed(6)},${s.lng.toFixed(6)}`));

  // Nothing was written. Not one event, not one byte of snapshot.
  assert.equal(app.__state().pending.length, 0, 'planning a run must never write an event');

  await mapClick(pick('[data-map]', { map: 'plan' }));
  assert.deepEqual(app.__ui().mapStops, [], 'leaving select mode clears the run');
});

await check('the List view is byte-for-byte what it was, plus the switch', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  // Tap List, the way a person would — the map tests above left the tab on Map,
  // which is itself the remembered-choice behaviour working.
  await mapClick(pick('[data-dview]', { dview: 'list' }));
  const list = await renderRoute('#/dispatch');
  assert.ok(list.includes('<h2>Open'), 'the Open block');
  assert.ok(list.includes('Scheduled') && list.includes('Done this week'));
  assert.ok(list.includes('data-sheet="add-run"'), '+ Add a run');
  assert.ok(!list.includes('id="wimap"'), 'no map on the list view');
  // The only thing D52 added to it.
  assert.ok(list.includes('data-dview="map"') && list.includes('data-dview="list"'));
  assert.ok(/<div class="segbar">[\s\S]*?<\/div>\s*\n\s*<div class="actions">/.test(list),
    'the switch sits above the existing blocks, not inside them');
});

await check('the Dispatch tab remembers Map, and List takes it back', async () => {
  await mapView();                       // lands on #/dispatch/map
  assert.equal(app.__ui().dispatchView, 'map', 'a deep link sets the tab for this session');
  assert.ok((await renderRoute('#/dispatch')).includes('id="wimap"'), 'the bare tab route follows the choice');
  await mapClick(pick('[data-dview]', { dview: 'list' }));
  assert.equal(app.__ui().dispatchView, 'list');
  assert.ok(!(await renderRoute('#/dispatch')).includes('id="wimap"'));
});

await check('a schema-6 snapshot (no geo anywhere) says so instead of drawing a blank map', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  const snap = app.__state().snapshot;
  delete snap.meta.geo;
  const out = await renderRoute('#/dispatch/map');
  assert.ok(out.includes('No map in this snapshot'), 'it must say why, not draw an empty state');
  assert.ok(!out.includes('undefined'));
  assert.ok(out.includes('data-dview="list"'), 'and leave the way back to the List view');

  // And the List view is completely unaffected by a missing meta.geo — the way
  // back has to work even when the map cannot draw, which is the whole point of
  // leaving the switch on screen.
  await mapClick(pick('[data-dview]', { dview: 'list' }));
  const list = await renderRoute('#/dispatch');
  assert.ok(list.includes('<h2>Open') && !list.includes('undefined'));
});

await check('the map renders for every role — geo is not money and is not gated', async () => {
  for (const who of ['owner', 'sales', 'service']) {
    const out = await mapView(who);
    assert.ok(out.includes('id="wimap"'), `${who} got no map`);
    assert.ok(!out.includes('undefined'), `${who} leaked undefined`);
    // Leads render on the map exactly as they do on the Leads tab.
    assert.ok(out.includes('class="pin k-lead') || out.includes('data-mapkind="lead"'), `${who}: leads missing`);
  }
});

/* ===================================== the Shop List + readiness aging (D56) */

const ON_HAND_STATES = new Set(['AVAILABLE', 'RESERVED', 'IN-SHOP']);
const shopUnitsOf = (snap) => snap.units.filter((u) => ON_HAND_STATES.has(u.unit_state)
  && (u.readiness === 'NEEDS-PREP' || u.readiness === 'DOWN'));

/** The markup of the Shop List section only — everything after its heading. */
const shopSection = (out) => out.slice(out.indexOf('<section class="shop-list">'));
/** The serials the Shop List actually drew, in the order it drew them. */
const shopSerials = (out) => [...shopSection(out).matchAll(/#\/unit\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));

async function landingAs(variant = 'full', who = 'owner') {
  window.location.href = `http://localhost:8787/?mock=${variant}&role=${who}`;
  window.location.search = `?mock=${variant}&role=${who}`;
  await app.__refresh();
  return renderRoute('#/');
}

await check('the Shop List sits UNDER the category cards, never above them (D15 amended)', async () => {
  const out = await landingAs();
  assert.ok(out.includes('In the shop'), 'the section is missing from the landing page');
  const lastCat = out.lastIndexOf('class="card cat-card"');
  assert.ok(lastCat > -1, 'the category cards went missing');
  assert.ok(lastCat < out.indexOf('In the shop'), 'the cards own the top of the page — Kevin reads the lights first');
  // and it is still below the utilization card, which leads the page (D19/D44)
  assert.ok(out.indexOf('Fleet utilization') < out.indexOf('In the shop'));
  // D54: machines, never people. No actor may appear in this section.
  const sec = shopSection(out);
  for (const who of ['Matt', 'Kevin', 'Josh', 'Zac']) {
    assert.ok(!sec.includes(who), `the Shop List named ${who} — it lists machines, not people`);
  }
});

await check('prep before down, oldest first inside each group, nulls last (D56)', async () => {
  const out = await landingAs();
  const snap = app.__state().snapshot;
  const bySerial = Object.fromEntries(snap.units.map((u) => [String(u.serial), u]));
  const drawn = shopSerials(out).map((s) => bySerial[s]);

  // the fixture has to hold both groups, or this proves nothing
  assert.ok(drawn.some((u) => u.readiness === 'NEEDS-PREP') && drawn.some((u) => u.readiness === 'DOWN'),
    'mock-full needs units in both groups — extend make-mock-data.js');

  const firstDown = drawn.findIndex((u) => u.readiness === 'DOWN');
  assert.ok(!drawn.slice(firstDown).some((u) => u.readiness === 'NEEDS-PREP'),
    `every NEEDS-PREP must precede every DOWN, got ${drawn.map((u) => u.readiness)}`);

  for (const group of ['NEEDS-PREP', 'DOWN']) {
    const ages = drawn.filter((u) => u.readiness === group)
      .map((u) => (typeof u.readiness_age_days === 'number' ? u.readiness_age_days : -1));
    const sorted = [...ages].sort((a, b) => b - a);
    assert.deepEqual(ages, sorted, `${group} must run oldest first, nulls last — got ${ages}`);
  }
  // nothing was dropped and nothing drawn twice
  assert.equal(drawn.length, shopUnitsOf(snap).length);
  assert.equal(new Set(shopSerials(out)).size, drawn.length);
});

await check('an out unit carrying a stale DOWN never reaches the Shop List (D18)', async () => {
  const out = await landingAs();
  const snap = app.__state().snapshot;
  const trap = snap.units.find((u) => !ON_HAND_STATES.has(u.unit_state) && u.readiness === 'DOWN');
  assert.ok(trap, 'mock-full needs an out unit holding a DOWN readiness — that is the trap');
  assert.ok(typeof trap.readiness_age_days === 'number', 'and it has to carry an age, or it proves nothing');
  assert.ok(!shopSerials(out).includes(String(trap.serial)),
    `${trap.serial} is ${trap.unit_state} — readiness is not a concept for it`);

  // and its unit row draws no readiness chip and no age chip either
  const row = await renderRoute(`#/unit/${encodeURIComponent(trap.serial)}`);
  assert.ok(!/class="chip age/.test(row), 'an out unit must show no age chip');
  assert.ok(!row.includes('Readiness since'), 'and no Readiness since row');
});

await check('the age chip reads "today" at 0 and a bare day count above it', async () => {
  const snap = app.__state().snapshot;
  const u = shopUnitsOf(snap).find((x) => typeof x.readiness_age_days === 'number');
  const keep = u.readiness_age_days;

  u.readiness_age_days = 0;
  let out = await renderRoute('#/');
  assert.ok(shopSection(out).includes('>today<'), '0 days reads "today", not "0d"');
  assert.ok(!shopSection(out).includes('>0d<'));

  u.readiness_age_days = 3;
  out = await renderRoute('#/');
  assert.ok(shopSection(out).includes('>3d<'), 'a bare day count — the readiness chip says what for');
  assert.ok(!/in prep for/i.test(shopSection(out)), 'no prose on the chip');
  u.readiness_age_days = keep;
});

await check('the tone bands turn at 7 and 14, and nowhere else', async () => {
  const snap = app.__state().snapshot;
  const u = shopUnitsOf(snap).find((x) => typeof x.readiness_age_days === 'number');
  const keep = u.readiness_age_days;
  const chipFor = async (n) => {
    u.readiness_age_days = n;
    const sec = shopSection(await renderRoute('#/'));
    const m = new RegExp(`<span class="chip (age[^"]*)">${n === 0 ? 'today' : n + 'd'}<`).exec(sec);
    assert.ok(m, `no age chip drawn at ${n}`);
    return m[1];
  };
  assert.equal(await chipFor(0), 'age', 'a fresh one is neutral');
  assert.equal(await chipFor(6), 'age', 'the day before amber is still neutral');
  assert.equal(await chipFor(7), 'age amber', 'AGE_AMBER = 7');
  assert.equal(await chipFor(13), 'age amber', 'the day before red is still amber');
  assert.equal(await chipFor(14), 'age red', 'AGE_RED = 14');
  assert.equal(await chipFor(40), 'age red');
  u.readiness_age_days = keep;
});

await check('a never-stamped unit draws its row with no age chip at all', async () => {
  const out = await landingAs();
  const snap = app.__state().snapshot;
  const blank = shopUnitsOf(snap).find((u) => u.readiness_age_days == null);
  assert.ok(blank, 'mock-full needs an on-hand unit with both fields null');
  assert.ok(shopSerials(out).includes(String(blank.serial)), 'no age is not a reason to hide the machine');

  const row = await renderRoute(`#/unit/${encodeURIComponent(blank.serial)}`);
  assert.ok(!/class="chip age/.test(row), 'no number beats a made-up one');
  // the row still renders — as a dash. A missing row would read as "not applicable";
  // a dash reads as "nobody knows", which is the truth.
  const dd = /<dt>Readiness since<\/dt>\s*<dd class="([^"]*)">([^<]*)</.exec(row);
  assert.ok(dd, 'the Readiness since row must still render for an unstamped unit');
  assert.equal(dd[2], '—', `expected a dash, got ${dd[2]}`);
  assert.ok(dd[1].includes('muted'), 'and it is muted, like every other empty value');
  assert.ok(!/undefinedd|nulld|NaN/.test(row));
});

await check('the empty variant says so in one quiet line, and draws no cards', async () => {
  const out = await landingAs('empty');
  const snap = app.__state().snapshot;
  assert.equal(shopUnitsOf(snap).length, 0, 'mock-empty must have a clean yard');
  assert.ok(out.includes('Nothing in prep, nothing down.'), 'a green day should read as a green day');
  const sec = shopSection(out);
  assert.ok(!sec.includes('class="card unit-row"'), 'no cards, just the line');
  // the cards above it are untouched
  assert.ok(out.includes('class="card cat-card"'));
});

await check('Readiness since shows for NEEDS-PREP and DOWN on-hand, and for nothing else', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  const snap = app.__state().snapshot;
  let shown = 0;
  for (const u of snap.units) {
    const out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
    const has = out.includes('Readiness since');
    const should = ON_HAND_STATES.has(u.unit_state) && (u.readiness === 'NEEDS-PREP' || u.readiness === 'DOWN');
    assert.equal(has, should, `#${u.serial} (${u.unit_state}/${u.readiness}) Readiness since: ${has}, expected ${should}`);
    if (!has) continue;
    shown++;
    if (u.readiness_since) {
      // rendered verbatim as text, never Date-parsed (CLAUDE.md rule 7)
      assert.ok(!/Invalid Date|GMT|T00:00:00/.test(out), `#${u.serial} Date-parsed a date-only string`);
      const age = u.readiness_age_days;
      assert.ok(out.includes(age === 0 ? 'today' : `${age}d`), `#${u.serial} lost its age`);
    }
  }
  assert.ok(shown >= 4, `only ${shown} units showed the row — the fixture got thin`);
});

await check('the age chip travels with unitChips — category rows carry it too', async () => {
  const snap = app.__state().snapshot;
  const u = shopUnitsOf(snap).find((x) => typeof x.readiness_age_days === 'number');
  const out = await renderRoute(`#/cat/${encodeURIComponent(u.category)}`);
  assert.ok(new RegExp(`class="chip age[^"]*">${u.readiness_age_days === 0 ? 'today' : u.readiness_age_days + 'd'}<`).test(out),
    'the category list must show the same age — one function, three places');
  // and READY units in the same list still show none
  const ready = snap.units.filter((x) => x.category === u.category && x.readiness === 'READY');
  if (ready.length) {
    const row = await renderRoute(`#/unit/${encodeURIComponent(ready[0].serial)}`);
    assert.ok(!/class="chip age/.test(row), 'a READY age is a brag, not a task');
  }
});

await check('a schema-2 snapshot with no readiness clock renders the list without ages', async () => {
  const out = await landingAs('legacy');
  const snap = app.__state().snapshot;
  assert.equal(snap.meta.schema_version, 2);
  assert.ok(snap.units.every((u) => !('readiness_age_days' in u)), 'legacy must not carry the key');
  assert.ok(out.includes('In the shop'), 'the section still draws');
  assert.ok(shopSerials(out).length > 0, 'and still lists the machines');
  assert.ok(!/class="chip age/.test(shopSection(out)), 'with no age chip anywhere');
  assert.ok(!/undefined|nulld|NaN/.test(shopSection(out)));

  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
});

/* ============================================ D59 — the opaque agreement id */
/* An agreement is an int on legacy Integra paper (4130) and a STRING on WSS's
 * own ("R092526A"). Everything downstream treats it as an opaque id: it is
 * rendered verbatim, never parsed, never coerced, never given an "R" it already
 * has, and never sorted int-against-string. These checks read the id out of the
 * snapshot rather than typing it, so they keep meaning something if the fixture
 * is renumbered. */

const WSS_PAPER = 'R092526A';

async function ownerFull() {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  return app.__state().snapshot;
}

await check('the fixture really carries both agreement shapes (D59)', async () => {
  const snap = await ownerFull();
  const kinds = new Set(snap.agreements.map((a) => (a.agreement == null ? 'null' : typeof a.agreement)));
  assert.ok(kinds.has('number'), 'legacy Integra ints must survive in the fixture');
  assert.ok(kinds.has('string'), 'a WSS-paper agreement id must be in the fixture');
  assert.ok(kinds.has('null'), 'and the unbilled-rental orphan');
  const paper = snap.agreements.find((a) => a.agreement === WSS_PAPER);
  assert.ok(paper, 'the WSS-paper row is the whole point of this block');
  assert.equal(paper.last_invoice, `${WSS_PAPER}-1`, 'the id already carries its own R — never prefix a second one');
  assert.ok(snap.units.some((u) => u.agreement === WSS_PAPER), 'a unit must point at it');
  assert.ok((snap.pickups || []).some((p) => p.agreement === WSS_PAPER), 'and a pick-up row must carry one too');
});

await check('Rentals renders every agreement id verbatim, int or string (D59)', async () => {
  const snap = await ownerFull();
  const out = await renderRoute('#/rentals');
  for (const a of snap.agreements) {
    if (a.agreement == null) continue;
    assert.ok(out.includes(String(a.agreement)), `agreement ${a.agreement} is missing from the card`);
    if (a.last_invoice) assert.ok(out.includes(String(a.last_invoice)), `invoice ${a.last_invoice} is missing`);
  }
  // The two ways a digits-only assumption shows up: an "R" bolted onto an id
  // that had one, and an id run through Number().
  assert.ok(!out.includes(`R${WSS_PAPER}`), 'something prefixed an "R" onto a WSS-paper id');
  assert.ok(!/NaN|Infinity/.test(out), 'something did arithmetic on an agreement id');
  // The sort must not mix-compare an int against a string — it sorts on
  // severity then customer, and every row has to survive it.
  assert.equal((out.match(/class="card rtile"/g) || []).length, snap.agreements.length,
    'every agreement row must draw — a throwing comparator loses rows');
});

await check('unit detail and Dispatch carry a string agreement without coercing it (D59)', async () => {
  const snap = await ownerFull();
  const unit = snap.units.find((u) => u.agreement === WSS_PAPER);
  const out = await renderRoute(`#/unit/${encodeURIComponent(unit.serial)}`);
  assert.ok(out.includes(WSS_PAPER), 'the unit page must show the id it is out on');
  assert.ok(!out.includes(`R${WSS_PAPER}`) && !/NaN/.test(out));

  // The pick-up came off that same agreement; its row and its detail sheet both
  // draw, and neither leaks a parse. The board is the LIST — an earlier check
  // may have left this session on the map, which draws pins and no rows.
  app.__ui().dispatchView = 'list';
  const disp = await renderRoute('#/dispatch');
  assert.ok(disp.includes(`#${unit.serial}`), 'the released unit must be on the Dispatch board');
  assert.ok(!/NaN|\[object Object\]|undefined/.test(disp));
  const row = (snap.dispatch || []).find((r) => r.serial === unit.serial);
  if (row) {
    const sheet = await renderRoute(`#/dispatch/${encodeURIComponent(row.id)}`);
    assert.ok(!/NaN|undefined/.test(sheet));
  }
});

await check('the billing block still hangs invoices off an opaque id (D59)', async () => {
  // The site does not render `billing` (D39) — but the mock is the contract's
  // shape, and an invoice built by prefixing "R" would be wrong there too.
  const snap = await ownerFull();
  const rows = (snap.billing && snap.billing.created_last_run) || [];
  assert.ok(rows.length, 'the fixture must carry created_last_run rows');
  for (const r of rows) {
    assert.ok(String(r.invoice).startsWith(typeof r.agreement === 'number' ? `R${r.agreement}-` : `${r.agreement}-`),
      `invoice ${r.invoice} does not hang off agreement ${r.agreement}`);
    assert.ok(!String(r.invoice).startsWith('RR'), 'a second "R" got bolted on');
  }
});

await check('a CONTRACT doc renders through the 📄 fallback, and no phone can mint one (D59)', async () => {
  const snap = await ownerFull();
  const lead = (snap.leads || []).find((l) => (l.docs || []).some((d) => d.kind === 'CONTRACT'));
  assert.ok(lead, 'the fixture must carry a CONTRACT doc somewhere a detail sheet draws it');
  const out = await renderRoute(`#/lead/${encodeURIComponent(lead.lead)}`);
  assert.ok(out.includes('Contract'), 'the unknown kind must still get a readable label');
  assert.ok(out.includes('📄'), 'and the fallback icon, not a blank');
  assert.ok(!/undefined|\[object Object\]/.test(out));
  // The upload sheet never offers it — that is the vault's to mint.
  assert.ok(!/value="CONTRACT"/.test(out), 'CONTRACT must not be offerable from a phone');
});

/* ---- D63: an in-place re-render keeps the reader where they were ---- */

async function withScrollSpy(fn) {
  const calls = [];
  const saved = window.scrollTo;
  window.scrollTo = (...a) => { calls.push(a); };
  try { await fn(calls); } finally { window.scrollTo = saved; delete window.scrollY; }
}

await check('D63: two renders at the same hash do not reset scroll', async () => {
  await ownerFull();
  await withScrollSpy(async (calls) => {
    await renderRoute('#/dispatch');           // a navigation: lands at the top
    window.scrollY = 640;                      // the reader scrolls down the board…
    view.scrollTop = 120;
    calls.length = 0;
    app.__render();                            // …and a claim lands: same hash, redraw
    await settle();
    assert.equal(calls.length, 0, 'scrollTo must not be called on an in-place re-render');
    assert.equal(view.scrollTop, 120, '#view keeps its scroll too');
    assert.ok(view._html.length > 0, 'and the view still redrew');
  });
});

await check('D63: a hash change still scrolls to the top', async () => {
  await withScrollSpy(async (calls) => {
    await renderRoute('#/service');
    window.scrollY = 900;
    view.scrollTop = 50;
    calls.length = 0;
    await renderRoute('#/dispatch');
    assert.deepEqual(calls, [[0, 0]], 'a real navigation starts at the top');
    assert.equal(view.scrollTop, 0);
  });
});

/* ============================== rental lifecycle (D64) ==================== */

const tileOrder = (out) => [...out.matchAll(/class="card rtile" data-agreement="([^"]*)"/g)].map((m) => m[1]);
/** The markup of one tile, by agreement id. */
const tileOf = (out, id) => {
  const i = out.indexOf(`class="card rtile" data-agreement="${id}"`);
  assert.ok(i >= 0, `no tile for ${id}`);
  const j = out.indexOf('class="card rtile"', i + 10);
  const k = out.indexOf('<h2>', i);
  const end = [j, k].filter((x) => x > i).reduce((m, x) => Math.min(m, x), out.length);
  return out.slice(i, end);
};
const rentalButtons = (out) => [...out.matchAll(/data-sheet="rental" data-id="([^"]*)"/g)].map((m) => m[1]);

await check('D64: Rentals draws Pending, On rent, Off-rent — in that order, each in its own order', async () => {
  const snap = await asFull('owner');
  const out = await renderRoute('#/rentals');
  const at = (h) => out.indexOf(`<h2>${h}`);
  assert.ok(at('Pending') > out.indexOf('Recurring revenue'), 'revenue leads');
  assert.ok(at('Pending') < at('On rent') && at('On rent') < at('Off-rent'), 'group order');
  const order = tileOrder(out);
  const by = (st) => snap.agreements.filter((a) => (a.status || 'ACTIVE') === st);
  const idx = (a) => order.indexOf(String(a.agreement));
  // Pending: soonest out_date first.
  const pend = by('PENDING').slice().sort((a, b) => a.out_date.localeCompare(b.out_date));
  assert.ok(pend.length >= 2, 'the fixture needs two PENDING rows');
  assert.ok(idx(pend[0]) < idx(pend[1]));
  // On rent: longest days_on_rent first.
  const act = by('ACTIVE').filter((a) => typeof a.days_on_rent === 'number').sort((a, b) => b.days_on_rent - a.days_on_rent);
  for (let i = 1; i < act.length; i++) assert.ok(idx(act[i - 1]) < idx(act[i]), `${act[i - 1].agreement} before ${act[i].agreement}`);
  // Off-rent: oldest off_rent first.
  const off = by('OFF-RENT').slice().sort((a, b) => a.off_rent.localeCompare(b.off_rent));
  assert.ok(off.length >= 2, 'the fixture needs two OFF-RENT rows');
  assert.ok(idx(off[0]) < idx(off[1]));
  // Every row lands in exactly one tile.
  assert.equal(order.length, snap.agreements.length);
});

await check('D64: a Pending tile says how it leaves, and flags a passed out date in red', async () => {
  const snap = await asFull('owner');
  const out = await renderRoute('#/rentals');
  const dl = snap.agreements.find((a) => a.status === 'PENDING' && a.out_move === 'DELIVER');
  const pu = snap.agreements.find((a) => a.status === 'PENDING' && a.out_move === 'CUSTOMER-PICKUP');
  const dlTile = tileOf(out, dl.agreement);
  assert.ok(dlTile.includes(`href="#/dispatch/${dl.delivery.id}"`), 'the delivery links to its Dispatch row');
  assert.ok(dlTile.includes(`SCHEDULED ${dl.delivery.driver} / ${dl.delivery.rig}`), 'claim status, driver and rig');
  assert.ok(/Delivery (Sun|Mon|Tue|Wed|Thu|Fri|Sat) /.test(dlTile), 'the delivery names its weekday');
  assert.ok(dlTile.includes(`href="#/lead/${dl.lead}"`), 'the lead chip links');
  assert.ok(dlTile.includes('data-doc=') && dlTile.includes('Contract'), 'the CONTRACT rides on the tile');
  assert.ok(!dlTile.includes('out date passed'), 'a future out date is not late');
  assert.ok(!dlTile.includes('data-sheet="rental"'), 'a DELIVER tile has no button — the truck is the OUT');
  const puTile = tileOf(out, pu.agreement);
  assert.ok(puTile.includes('Customer picks up'), 'customer pick-up line');
  assert.ok(puTile.includes('chip bad') && puTile.includes('out date passed'), 'yesterday and still PENDING: red');
  assert.ok(puTile.includes(`data-id="OUT|${pu.agreement}"`) && puTile.includes('>Went out<'), 'Went out on a customer pick-up');
});

await check('D64: an On rent tile carries its age, and nags about the due-back date', async () => {
  const snap = await asFull('owner');
  const out = await renderRoute('#/rentals');
  const { todayCentral, addDays } = await import('../docs/dates.js');
  const today = todayCentral();
  const late = snap.agreements.find((a) => a.status === 'ACTIVE' && a.in_date === addDays(today, -1));
  const soon = snap.agreements.find((a) => a.status === 'ACTIVE' && a.in_date === addDays(today, 1));
  assert.ok(late && soon, 'the fixture needs an ACTIVE row due yesterday and one due tomorrow');
  assert.ok(tileOf(out, late.agreement).includes('class="due red"'), 'overdue is red');
  assert.ok(tileOf(out, late.agreement).includes('overdue'));
  assert.ok(tileOf(out, soon.agreement).includes('class="due amber"'), 'tomorrow is amber');
  assert.ok(tileOf(out, soon.agreement).includes('0d on rent'), 'a zero-day rental reads 0d, not blank');
  const quiet = snap.agreements.find((a) => a.status === 'ACTIVE' && a.agreement != null && !a.in_date);
  assert.ok(!tileOf(out, quiet.agreement).includes('class="due'), 'no in_date, no nag');
  const t = tileOf(out, soon.agreement);
  assert.ok(t.includes(`data-id="OFF-RENT|${soon.agreement}"`) && t.includes('>Off-rent<'), 'Off-rent button');
  assert.ok(!/class="btn ghost"[^>]*data-sheet="rental"/.test(t), 'Off-rent is the filled maroon button');
  assert.ok(t.includes('Stops the clock and puts a pickup on Dispatch.'));
});

await check('D64: an Off-rent tile shows the pickup run, or the customer-return button', async () => {
  const snap = await asFull('owner');
  const out = await renderRoute('#/rentals');
  const offPu = snap.agreements.find((a) => a.status === 'OFF-RENT' && a.in_move === 'PICKUP');
  const offRet = snap.agreements.find((a) => a.status === 'OFF-RENT' && a.in_move === 'CUSTOMER-RETURN');
  const row = snap.dispatch.find((r) => r.source === 'RENTAL-RETURN' && r.agreement === offPu.agreement);
  const a = tileOf(out, offPu.agreement);
  assert.ok(a.includes(`href="#/dispatch/${row.id}"`) && a.includes(`${row.status} ${row.driver} / ${row.rig}`), 'pickup line');
  assert.ok(a.includes('Billed through') && a.includes('Off-rent'));
  assert.ok(a.includes(`data-id="IN|${offPu.agreement}"`) && a.includes('Owner override'), 'owner sees the override');
  const b = tileOf(out, offRet.agreement);
  assert.ok(b.includes('Customer brings it back'));
  assert.ok(b.includes(`data-id="IN|${offRet.agreement}"`) && b.includes('>Back in shop<'));
});

await check('D64: the button matrix per role — sales, owner, service', async () => {
  const snap = await asFull('sales');
  const offPu = snap.agreements.find((a) => a.status === 'OFF-RENT' && a.in_move === 'PICKUP');
  let out = await renderRoute('#/rentals');
  assert.ok(!tileOf(out, offPu.agreement).includes('data-sheet="rental"'), 'sales gets no override');
  const salesBtns = rentalButtons(out);
  assert.ok(salesBtns.some((k) => k.startsWith('OUT|')) && salesBtns.some((k) => k.startsWith('OFF-RENT|')) && salesBtns.some((k) => k.startsWith('IN|')));
  await asFull('service');
  out = await renderRoute('#/rentals');
  assert.equal(rentalButtons(out).length, 0, 'service gets no rental buttons at all');
  assert.ok(out.includes('class="card rtile"'), '…but sees every tile');
  await asFull('owner');
});

await check('D64: a legacy snapshot renders Rentals as before — all On rent, Off-rent the only button', async () => {
  for (const who of ['owner', 'sales', 'service']) {
    window.location.href = `http://localhost:8787/?mock=legacy&role=${who}`;
    window.location.search = `?mock=legacy&role=${who}`;
    await app.__refresh();
    const snap = app.__state().snapshot;
    assert.ok(snap.agreements.every((a) => !('status' in a)), 'the legacy fixture must carry no status');
    const out = await renderRoute('#/rentals');
    assert.ok(!out.includes('<h2>Pending') && !out.includes('<h2>Off-rent'), 'no empty groups on a legacy file');
    assert.ok(out.includes('<h2>On rent'));
    assert.equal(tileOrder(out).length, snap.agreements.length);
    const btns = rentalButtons(out);
    if (who === 'service') assert.equal(btns.length, 0);
    else {
      assert.equal(btns.length, snap.agreements.filter((a) => a.agreement != null).length, 'one Off-rent per billable row');
      assert.ok(btns.every((k) => k.startsWith('OFF-RENT|')), 'Off-rent and nothing else');
    }
  }
  await asFull('owner');
});

/** API mode as a given identity, capturing every POST /api/event body. */
async function apiAs(me, extraPending = []) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/data')) {
      return { ok: true, status: 200, json: async () => ({ me, snapshot, pending: extraPending.slice() }) };
    }
    if (u.endsWith('/api/event') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posted.push(body);
      const stored = { id: `2026-09-25T12:00:00.000Z:abc${posted.length}`, ts: '2026-09-25T12:00:00.000Z', actor: me.name, role: me.role, ...body };
      return { ok: true, status: 201, json: async () => stored };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  window.location.href = 'https://fleet.wisconsinscrubandsweep.com/?t=0123456789abcdef0123456789abcdef';
  window.location.search = '?t=0123456789abcdef0123456789abcdef';
  window.location.hostname = 'fleet.wisconsinscrubandsweep.com';
  window.location.protocol = 'https:';
  await app.__refresh();
  return { snapshot, posted };
}
/** Submit a rental sheet the way the page does: a real submit event on a form
 *  whose fields come from `fields`. Node's FormData refuses a non-DOM form, so
 *  it is swapped for one that reads the same fields. */
async function submitRental(verb, id, fields) {
  const form = { dataset: { action: 'rental_update', verb, id }, _fields: fields,
    querySelector: (q) => (q === 'button[type=submit]' ? { disabled: false } : null) };
  form.closest = (q) => (q === 'form.write' ? form : null);
  const SavedFD = globalThis.FormData;
  globalThis.FormData = class { constructor(f) { this.f = f; } get(k) { return k in this.f._fields ? this.f._fields[k] : null; } };
  try {
    for (const fn of listeners.get('submit') || []) await fn({ target: form, preventDefault() {} });
  } finally { globalThis.FormData = SavedFD; }
  await settle();
}

await check('D64: the Off-rent sheet posts rental_update {OFF-RENT, date, note}, capped at today', async () => {
  const { todayCentral } = await import('../docs/dates.js');
  const today = todayCentral();
  const { snapshot, posted } = await apiAs({ name: 'Kevin', role: 'sales' });
  const a = snapshot.agreements.find((x) => x.status === 'ACTIVE' && typeof x.agreement === 'number' && x.agreement != null);
  const key = `OFF-RENT|${a.agreement}`;
  await renderRoute('#/rentals');
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'rental', id: key } }));
  await settle();
  const sheet = view._html;
  assert.ok(sheet.includes('data-action="rental_update" data-verb="OFF-RENT"'), 'the sheet opened');
  assert.ok(sheet.includes(`max="${today}"`) && sheet.includes(`value="${today}"`), 'default today, max today');

  // A future date never leaves the phone.
  await submitRental('OFF-RENT', String(a.agreement), { date: '2999-01-01', note: '' });
  assert.equal(posted.length, 0, 'a future date must not post');
  assert.ok(view._html.includes('in the future'), 'and it says why');

  await submitRental('OFF-RENT', String(a.agreement), { date: today, note: 'Called at 8' });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], { action: 'rental_update', serial: null,
    payload: { agreement: a.agreement, action: 'OFF-RENT', date: today, note: 'Called at 8' } });
  assert.equal(typeof posted[0].payload.agreement, 'number', 'a legacy int goes as an int — never coerced');
  const out = await renderRoute('#/rentals');
  const t = tileOf(out, a.agreement);
  assert.ok(t.includes('⏳ 1 pending'), 'the tile badges pending');
  assert.ok(/data-sheet="rental" data-id="OFF-RENT\|[^"]*" disabled/.test(t), 'and the button waits for the next snapshot');
  assert.ok(t.includes('>Undo<'), 'the D46 valve is there for your own tap');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D64: Went out on a WSS-paper id posts the string, verbatim', async () => {
  const { snapshot, posted } = await apiAs({ name: 'Matt', role: 'owner' });
  const pu = snapshot.agreements.find((x) => x.status === 'PENDING' && x.out_move === 'CUSTOMER-PICKUP');
  await submitRental('OUT', String(pu.agreement), { date: '', note: '' });
  assert.deepEqual(posted[0].payload, { agreement: pu.agreement, action: 'OUT', date: null, note: null });
  assert.equal(typeof posted[0].payload.agreement, 'string');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D64: a RENTAL-DELIVER row — chips, no Cancel, Done copy names the agreement and the lead', async () => {
  const snap = await asFull('owner');
  app.__ui().dispatchView = 'list';
  const row = snap.dispatch.find((r) => r.source === 'RENTAL-DELIVER');
  assert.ok(row && row.id.startsWith('m-dl-'), 'the fixture needs a RENTAL-DELIVER row');
  const out = await renderRoute('#/dispatch');
  const i = out.indexOf(`id="d-${row.id}"`);
  const next = out.indexOf(' id="d-', i + 10);
  const drow = out.slice(i, next > 0 ? next : undefined);
  assert.ok(drow.includes('Rental delivery'), 'the Rental delivery chip');
  assert.ok(drow.includes(`href="#/agreement/${row.agreement}"`), 'the R-number links to the agreement');
  assert.ok(drow.includes('>Done<'), 'Done works as on every row');
  assert.ok(!drow.includes('data-cancel'), 'no Cancel, even for the owner');
  // Every dispatch row carries `agreement` now — and the rest are null.
  assert.ok(snap.dispatch.every((r) => 'agreement' in r));
  // Open the Done sheet: the copy says what the tap sets off.
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'done', id: row.id } }));
  await settle();
  const a = snap.agreements.find((x) => x.agreement === row.agreement);
  assert.ok(view._html.includes(`Marks ${row.agreement} on rent from today and closes lead ${a.lead} as won.`), 'Done copy');
  app.__ui().form = null;
  // Without a lead, the clause goes.
  a.lead = null;
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'done', id: row.id } }));
  await settle();
  assert.ok(view._html.includes(`Marks ${row.agreement} on rent from today.`), 'no lead, no clause');
  app.__ui().form = null;
  await asFull('owner');
});

await check('D64: the unit page — rental chip, agmt: hold with no Release, delivery link not a button', async () => {
  const snap = await asFull('sales');
  const u = snap.units.find((x) => x.pending_agreement != null && snap.dispatch.some((r) => r.id === `m-dl-${x.pending_agreement}`));
  assert.ok(u, 'the fixture needs a unit promised to a delivered PENDING rental');
  const out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes(`Reserved for rental ${u.pending_agreement}`) && out.includes(`href="#/agreement/${u.pending_agreement}"`));
  const h = u.reservations.find((x) => x.id.startsWith('agmt:'));
  assert.ok(h, 'the implied RENTAL hold');
  assert.ok(!out.includes(`data-release="${h.id}"`), 'an agmt: hold is never releasable');
  assert.ok(out.includes('clears itself on delivery'));
  assert.ok(out.includes('RENTAL'));
  assert.ok(!out.includes('data-form="dispatch"'), 'Schedule delivery is hidden');
  assert.ok(out.includes(`href="#/dispatch/m-dl-${u.pending_agreement}"`), 'it points at the derived run instead');
  assert.ok(out.includes('data-form="reserve"'), 'Reserve-for-later still works (D28)');
  // A unit with no pending rental keeps its Schedule delivery button.
  const plain = snap.units.find((x) => x.pending_agreement == null && x.unit_state === 'AVAILABLE');
  assert.ok((await renderRoute(`#/unit/${encodeURIComponent(plain.serial)}`)).includes('data-form="dispatch"'));
  // And the Holds view books no truck for an agmt: hold.
  const holds = await renderRoute('#/holds');
  assert.ok(!holds.includes(`data-hold="${h.id}"`), 'no Schedule delivery on an agmt: hold');
  await asFull('owner');
});

await check('D64: #/agreement/<id> renders int, string and PENDING ids; no Notes; not-found says so', async () => {
  const snap = await asFull('owner');
  for (const a of snap.agreements.filter((x) => x.agreement != null)) {
    const out = await renderRoute(`#/agreement/${encodeURIComponent(String(a.agreement))}`);
    assert.ok(out.includes(String(a.agreement)) && out.includes(a.customer || 'Unknown customer'), `${a.agreement} detail`);
    assert.ok(!/undefined|NaN|\[object Object\]|Invalid Date/.test(out), `${a.agreement} leaked a placeholder`);
    assert.ok(!out.includes('<h2>Notes'), 'agreements have no log[] yet — no timeline');
  }
  const dl = snap.agreements.find((x) => x.status === 'PENDING' && x.out_move === 'DELIVER');
  const out = await renderRoute(`#/agreement/${dl.agreement}`);
  assert.ok(out.includes(`id="d-${dl.delivery.id}"`), 'its delivery run shows under Moves');
  assert.ok(out.includes('<h2>Documents'), 'the CONTRACT shows in Documents');
  assert.ok(!out.includes('data-doc-pick'), 'no phone upload onto an agreement');
  assert.ok((await renderRoute('#/agreement/R000000Z')).includes('Agreement not found.'));
});

/* ============================================ D65 — work orders ========== */

const MONEY_RE = /\$\s?\d/;
const partsStripOf = (out) => {
  const i = out.indexOf('<section class="parts');
  if (i < 0) return '';
  return out.slice(i, out.indexOf('</section>', i) + 10);
};
const setParts = (open) => { app.__ui().showParts = open; app.__ui().showPartsDelivered = open; };

await check('D65: the Parts strip sits under the utilization card, above the cards, folded, with the engine pill', async () => {
  const snap = await asFull('owner');
  setParts(false);
  const out = await renderRoute('#/');
  const util = out.indexOf('class="util"');
  const strip = out.indexOf('<section class="parts');
  const card = out.indexOf('cat-card');
  assert.ok(util >= 0 && strip > util && card > strip, 'util → strip → category cards');
  const s = snap.work_order_summary;
  const n = s.parts_requested + s.parts_ordered + s.parts_in_transit;
  const st = partsStripOf(out);
  assert.ok(st.includes('🔩 Parts ▸'), 'reads 🔩 Parts ▸');
  assert.ok(st.includes(`>${n} open<`), `pill = requested + ordered + in transit (${n})`);
  assert.ok(!st.includes('id="parts-body"'), 'collapsed by default');
  assert.ok(/parts-n red/.test(st), 'a REQUESTED line on an 8-day-old work order is red');
});

await check('D65: expanded — part lines grouped Ordered · In transit · Requested, Delivered folded inside, PO leads', async () => {
  const snap = await asFull('owner');
  app.__ui().showParts = true; app.__ui().showPartsDelivered = false;
  const st = partsStripOf(await renderRoute('#/'));
  const o = st.indexOf('>Ordered <'); const t = st.indexOf('>In transit <'); const r = st.indexOf('>Requested <');
  assert.ok(o > 0 && t > o && r > t, 'Ordered, then In transit, then Requested');
  assert.ok(st.includes('Delivered (30d)') && !st.includes('delivered '), 'Delivered is folded');
  const rows = [...st.matchAll(/<div class="prow">/g)].length;
  const lines = snap.work_orders.filter((w) => w.status === 'OPEN')
    .flatMap((w) => w.parts).filter((p) => ['REQUESTED', 'ORDERED', 'IN-TRANSIT'].includes(p.state)).length;
  assert.equal(rows, lines, 'one row per open PART LINE, not per work order');
  assert.ok(st.includes('PO <strong>W1001</strong>') && st.includes('href="#/wo/W1001"'), 'W-number labelled PO, tap → #/wo/');
  assert.ok(st.includes('href="https://www.ups.com/track?tracknum=1Z999AA10123456784"'), 'UPS → a carrier link');
  assert.ok(st.includes('<span class="chip track">LTL PRO 48213377</span>'), 'unknown carrier → plain text, no link');
  assert.ok(st.includes('href="#/ticket/S1002"'), 'the 🔩 row carries its ticket chip');
  assert.ok(!MONEY_RE.test(st), 'no money in the strip');
  app.__ui().showPartsDelivered = true;
  const st2 = partsStripOf(await renderRoute('#/'));
  assert.ok(st2.includes('delivered ') && st2.includes('tools.usps.com'), 'Delivered (30d) opens, USPS links');
  setParts(false);
});

await check('D65: the strip toggle is remembered for the session', async () => {
  await asFull('owner');
  setParts(false);
  await renderRoute('#/');
  await fireOn('click', fakeTarget('[data-parts-toggle]', {}));
  await settle();
  assert.equal(app.__ui().showParts, true);
  assert.equal(sessionStorage.getItem('wss.parts.open'), '1');
  assert.ok(partsStripOf(view._html).includes('id="parts-body"'));
  setParts(false);
  sessionStorage.removeItem('wss.parts.open');
});

await check('D65: empty strip on the legacy fixture (no work_orders key) and on the quiet one', async () => {
  for (const v of ['legacy', 'empty']) {
    window.location.href = `http://localhost:8787/?mock=${v}&role=owner`;
    window.location.search = `?mock=${v}&role=owner`;
    await app.__refresh();
    app.__ui().showParts = true;
    const st = partsStripOf(await renderRoute('#/'));
    assert.ok(st.includes('>0 open<') && st.includes('parts-n zero'), `${v}: 0 open, quiet`);
    assert.ok(!st.includes('class="prow"'), `${v}: no rows`);
    assert.ok(st.includes('Nothing on order.'), `${v}: says so`);
  }
  setParts(false);
  await asFull('owner');
});

await check('D65: unit page — the chip when a work order is open, "Open work order" when not, any role', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    const u = snap.units.find((x) => x.work_order === 'W1001');
    const wo = snap.work_orders.find((w) => w.id === 'W1001');
    const out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
    assert.ok(out.includes(`href="#/wo/W1001">🔩 W1001 · ${wo.parts_open} parts open · ${wo.hours_total} h<`), `${role}: the chip`);
    assert.ok(!out.includes('data-form="wo-open"'), `${role}: no second work order on the serial`);
    const plain = snap.units.find((x) => !x.work_order && x.unit_state !== 'RETIRED');
    assert.ok((await renderRoute(`#/unit/${encodeURIComponent(plain.serial)}`)).includes('data-form="wo-open">Open work order<'), `${role}: the button`);
  }
  await asFull('owner');
});

/** Submit a work-order form the way the page does. FormData is swapped for one
 *  that reads the given fields (arrays for the repeated part-line inputs). */
async function submitWo(dataset, fields, inline = false) {
  const writeMsg = { innerHTML: '' };
  const form = { dataset: { action: 'work_order', ...dataset }, _fields: fields,
    querySelector: (q) => (q === 'button[type=submit]' ? { disabled: false } : null) };
  form.closest = (q) => (q === 'form.write' ? form : q === '#write-form' && inline ? {} : null);
  const SavedFD = globalThis.FormData;
  globalThis.FormData = class {
    constructor(f) { this.f = f; }
    get(k) { const v = this.f._fields[k]; return v == null ? null : Array.isArray(v) ? v[0] : v; }
    getAll(k) { const v = this.f._fields[k]; return v == null ? [] : Array.isArray(v) ? v : [v]; }
  };
  nodes['#write-msg'] = writeMsg;
  try {
    for (const fn of listeners.get('submit') || []) await fn({ target: form, preventDefault() {} });
  } finally { globalThis.FormData = SavedFD; delete nodes['#write-msg']; }
  await settle();
  return writeMsg.innerHTML;
}

await check('D65: OPEN posts {serial, OPEN, purpose, parts} and draws a synthetic ⏳ NEW card — never an invented W-number', async () => {
  const { snapshot, posted } = await apiAs({ name: 'Josh', role: 'service' });
  const u = snapshot.units.find((x) => !x.work_order && x.unit_state === 'IN-SHOP' && x.readiness === 'NEEDS-PREP')
    || snapshot.units.find((x) => !x.work_order && x.unit_state !== 'RETIRED');
  // The sheet's defaults: rent-ready for a unit in prep, the make from its brand.
  const sheet = await (async () => {
    const mod = await import('../docs/workorders.js');
    return { purpose: mod.defaultPurpose(u), mfr: mod.manufacturerFor(u.brand) };
  })();
  assert.equal(sheet.purpose, u.readiness === 'NEEDS-PREP' ? 'RENT-READY' : 'REPAIR');
  // A line with a description but no part # never leaves the phone.
  let msg = await submitWo({ verb: 'OPEN', serial: u.serial },
    { purpose: 'RENT-READY', note: '', p_mfr: ['OTHER'], p_num: [''], p_desc: ['valve'], p_qty: ['1'] }, true);
  assert.equal(posted.length, 0);
  assert.ok(msg.includes('part number'), 'it says why');
  msg = await submitWo({ verb: 'OPEN', serial: u.serial }, {
    purpose: 'RENT-READY', note: 'rent-ready for Acme Foods',
    p_mfr: ['FACTORY-CAT', 'FACTORY-CAT', 'FACTORY-CAT'], p_num: ['150-4500', '21-422S', ''],
    p_desc: ['Solution valve 24V', 'Squeegee blade rear', ''], p_qty: ['1', '2', '1'],
  }, true);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], { action: 'work_order', serial: u.serial, payload: { action: 'OPEN', purpose: 'RENT-READY', note: 'rent-ready for Acme Foods',
    parts: [
      { manufacturer: 'FACTORY-CAT', part_number: '150-4500', description: 'Solution valve 24V', qty: 1 },
      { manufacturer: 'FACTORY-CAT', part_number: '21-422S', description: 'Squeegee blade rear', qty: 2 },
    ] } }, 'the blank third row is not a line');
  assert.ok(!JSON.stringify(posted[0]).match(/cost|rate|price/i), 'no money key is ever built');
  assert.ok(msg.includes('W-number'), 'the confirmation says the engine numbers it');
  const unitOut = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(unitOut.includes('⏳ New work order — applies at the next run'), 'the unit page waits');
  assert.ok(!unitOut.includes('data-form="wo-open"'), 'and offers no second OPEN');
  app.__ui().showParts = true;
  const st = partsStripOf(await renderRoute('#/'));
  assert.ok(st.includes(`⏳ NEW — ${u.asset_item} — 2 parts — applies at the next run`), 'the synthetic card, keyed on the serial');
  assert.ok(st.includes('⏳ 1 new'), 'the folded header says so too');
  assert.ok(st.includes('>Undo<'), 'Josh can take it back (D46)');
  setParts(false);
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D65: #/wo/W1001 — PO big, per-role line buttons, Close disabled with a line open, no money', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    await asFull(role);
    const out = await renderRoute('#/wo/W1001');
    assert.ok(out.includes('<div class="po-big">PO <span>W1001</span></div>'), `${role}: PO W1001, big`);
    assert.ok(!MONEY_RE.test(out) && !/\b(cost|rate|price)\b/i.test(out.replace(/rate-?/g, '')), `${role}: no money anywhere`);
    assert.ok(out.includes('data-sheet="wo-labor"') && out.includes('+ Log hours'), `${role}: + Log hours`);
    assert.ok(out.includes('data-sheet="wo-add"'), `${role}: + Add parts`);
    const ordered = out.includes('>Mark ordered<');
    const transit = /data-id="W1001\|2\|IN-TRANSIT"/.test(out);
    const delivered = /data-id="W1001\|3\|DELIVERED"/.test(out);
    if (role === 'owner') {
      assert.ok(ordered && transit && delivered, 'owner: Mark ordered + In transit + Delivered');
      assert.ok(/data-sheet="wo-close" data-id="W1001" disabled/.test(out), 'Close is disabled while a line is open');
      assert.ok(out.includes('Every line has to be delivered or cancelled'), 'and says why');
    } else if (role === 'service') {
      assert.ok(!ordered, 'service is never offered Mark ordered');
      assert.ok(transit && delivered, 'service moves boxes: In transit + Delivered');
      assert.ok(!out.includes('data-sheet="wo-close"'), 'no Close for service');
    } else {
      assert.ok(!ordered && !transit && !delivered, 'sales moves no line');
      assert.ok(!out.includes('data-sheet="wo-close"'), 'no Close for sales');
    }
  }
  // A labor-only work order has nothing open: the owner may close it.
  await asFull('owner');
  const pm = await renderRoute('#/wo/W1002');
  assert.ok(/data-sheet="wo-close" data-id="W1002">/.test(pm), 'labor-only → Close enabled');
  assert.ok(pm.includes('No parts on this work order'), 'labor only, said plainly');
  const closed = await renderRoute('#/wo/W1004');
  assert.ok(!closed.includes('data-sheet="wo-') && closed.includes('CLOSED'), 'a closed one offers nothing');
  assert.ok((await renderRoute('#/wo/W9999')).includes('Work order not found.'));
});

await check('D65: the ORDERED sheet names the PO and defaults the vendor; hours are quarter hours', async () => {
  const { posted } = await apiAs({ name: 'Matt', role: 'owner' });
  await renderRoute('#/wo/W1001');
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'wo-part', id: 'W1001|1|ORDERED' } }));
  await settle();
  assert.ok(view._html.includes('Give them <strong>PO W1001</strong>'), 'the sheet says what to read to the vendor');
  const { vendorFor } = await import('../docs/workorders.js');
  const want = vendorFor(app.__state().snapshot.work_orders.find((w) => w.id === 'W1001').parts[0].manufacturer);
  assert.ok(view._html.includes(`<option value="${want}" selected>`), `the vendor defaults from the make (${want})`);
  await submitWo({ verb: 'PART-STATE', wo: 'W1001', line: '1', state: 'ORDERED' },
    { date: '2026-09-24', vendor: 'RPS', vendor_ref: 'SO-448121', note: '' });
  assert.deepEqual(posted[0], { action: 'work_order', serial: null, payload: { action: 'PART-STATE', work_order: 'W1001', line: 1,
    state: 'ORDERED', date: '2026-09-24', vendor: 'RPS', vendor_ref: 'SO-448121', note: null } });
  // A labor line off the quarter hour never leaves the phone.
  await submitWo({ verb: 'LABOR', wo: 'W1001' }, { date: '2026-09-24', who: 'Zac', hours: '1.3', note: '' });
  assert.equal(posted.length, 1, '1.3 h is refused before the POST');
  await submitWo({ verb: 'LABOR', wo: 'W1001' }, { date: '2026-09-24', who: 'Zac', hours: '1.5', note: 'rebuild' });
  assert.deepEqual(posted[1].payload, { action: 'LABOR', work_order: 'W1001', date: '2026-09-24', who: 'Zac', hours: 1.5, note: 'rebuild' });
  const out = await renderRoute('#/wo/W1001');
  assert.ok(out.includes('⏳ 2 pending') && out.includes('line 1 → Ordered') && out.includes('1.5 h logged for Zac'), 'badged on payload.work_order');
  assert.ok(out.includes('⏳ → Ordered — applies at the next run') && !/data-id="W1001\|1\|ORDERED"/.test(out), 'the line waits, its buttons go');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D65: ticket detail carries a read-only 🔩 chip when its unit has a work order', async () => {
  const snap = await asFull('service');
  const w = snap.work_orders.find((x) => x.ticket);
  const out = await renderRoute(`#/ticket/${w.ticket}`);
  assert.ok(out.includes(`<a class="chip wo" href="#/wo/${w.id}">🔩 ${w.id}</a>`));
  const plain = snap.service_queue.find((t) => !t.serial || !(snap.units.find((u) => u.serial === t.serial) || {}).work_order);
  assert.ok(!(await renderRoute(`#/ticket/${plain.ticket}`)).includes('class="chip wo"'));
  await asFull('owner');
});

await check('D65: the mock itself carries no money key on any work order, and W1005 (closed 40d) never ships', async () => {
  const snap = await asFull('owner');
  const text = JSON.stringify(snap.work_orders);
  assert.ok(!/"(cost|cost_source_inv|rate|price)"/.test(text), 'no money key');
  assert.ok(!MONEY_RE.test(text), 'no figure');
  assert.ok(!snap.work_orders.some((w) => w.id === 'W1005'), 'outside the 30-day window');
  assert.ok(snap.work_orders.every((w) => w.status !== 'CLOSED' || w.age_days === null), 'age_days is null once CLOSED');
});

/* ----------------------------------------------- D67: the inspection sheet */

const inspStripOf = (out) => {
  const i = out.indexOf('<section class="parts insp-strip');
  return i < 0 ? '' : out.slice(i, out.indexOf('</section>', i) + 10);
};
const resetSheets = () => { app.__sheetLocal().clear(); app.__ui().form = null; };
const fieldTarget = (ifield, value, tag = 'INPUT') => {
  const node = { dataset: { ifield }, value, tagName: tag, classList: { add() {}, remove() {} } };
  node.closest = (q) => (q === '[data-ifield]' ? node : null);
  return node;
};
const tapSeg = (id, val) => fireOn('click', fakeTarget('[data-iseg]', { dataset: { iseg: id, val } }));
const { fmtMD: FMT_MD } = await import('../docs/dates.js');
const INSP = await import('../docs/inspections.js');

/** A fake Worker for the sheet's saves: POSTs are stored and echoed; DELETE answers delStatus(id). */
async function apiInsp(me, extraPending = [], { delStatus = () => 200 } = {}) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const posted = [];
  const deleted = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/data')) return { ok: true, status: 200, json: async () => ({ me, snapshot, pending: extraPending.slice() }) };
    if (u.endsWith('/api/event') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posted.push(body);
      n++;
      const ts = `2026-09-25T12:00:${String(n).padStart(2, '0')}.000Z`;
      const stored = { id: `${ts}:t${n}`, ts, actor: me.name, role: me.role, ...body };
      return { ok: true, status: 201, json: async () => stored };
    }
    const m = /\/api\/event\/(.+)$/.exec(u);
    if (m && init.method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      deleted.push(id);
      const st = delStatus(id);
      return { ok: st === 200, status: st, json: async () => ({ deleted: id }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  window.location.href = 'https://fleet.wisconsinscrubandsweep.com/?t=0123456789abcdef0123456789abcdef';
  window.location.search = '?t=0123456789abcdef0123456789abcdef';
  window.location.hostname = 'fleet.wisconsinscrubandsweep.com';
  window.location.protocol = 'https:';
  resetSheets();
  await app.__refresh();
  return { snapshot, posted, deleted };
}
async function leaveApi() {
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  resetSheets();
  await asFull('owner');
}
/** Submit any form.write the way the page does. */
async function submitForm(dataset, fields) {
  const form = { dataset, querySelector: (q) => (q === 'button[type=submit]' ? { disabled: false } : null) };
  form.closest = (q) => (q === 'form.write' ? form : null);
  const SavedFD = globalThis.FormData;
  globalThis.FormData = class {
    get(k) { const v = fields[k]; return v == null ? null : Array.isArray(v) ? v[0] : v; }
    getAll(k) { const v = fields[k]; return v == null ? [] : Array.isArray(v) ? v : [v]; }
  };
  try { for (const fn of listeners.get('submit') || []) await fn({ target: form, preventDefault() {} }); }
  finally { globalThis.FormData = SavedFD; }
  await settle();
}

await check('D67: a pre-D67 snapshot — "No inspections yet", no Inspect button, the route says not found', async () => {
  window.location.href = 'http://localhost:8787/?mock=legacy&role=owner';
  window.location.search = '?mock=legacy&role=owner';
  await app.__refresh();
  const st = inspStripOf(await renderRoute('#/'));
  assert.ok(st.includes('>No inspections yet<'), 'the strip says so');
  const u = app.__state().snapshot.units.find((x) => x.unit_state !== 'RETIRED');
  const unit = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(!unit.includes('data-form="insp-open"') && !unit.includes('<h2>Inspections'), 'no library → no button, no list');
  assert.ok((await renderRoute('#/inspection/I1005')).includes('Sheet not found.'));
  await asFull('owner');
});

await check('D67: the strip sits under the Parts strip, above the cards — folded, engine counts, amber at 2 days', async () => {
  const snap = await asFull('owner');
  app.__ui().showInspections = false;
  app.__ui().showParts = false;
  const out = await renderRoute('#/');
  const parts = out.indexOf('<section class="parts card');
  const insp = out.indexOf('<section class="parts insp-strip');
  assert.ok(parts >= 0 && insp > parts && out.indexOf('cat-card') > insp, 'Parts → Inspections → category cards');
  const st = inspStripOf(out);
  const s = snap.inspection_summary;
  assert.ok(st.includes('📋 Inspections ▸'));
  assert.ok(st.includes(`>${s.drafts} drafts · ${s.done_7d} done this week<`), 'the engine summary');
  assert.ok(/parts-n amber/.test(st), 'a 3-day-old DRAFT turns it amber');
  assert.ok(!st.includes('id="insp-body"'), 'collapsed by default');
  await fireOn('click', fakeTarget('[data-insp-toggle]', {}));
  await settle();
  assert.equal(sessionStorage.getItem('wss.inspections.open'), '1', 'remembered for the session');
  const open = inspStripOf(view._html);
  const d4 = open.indexOf('>I1004<'); const d5 = open.indexOf('>I1005<'); const done = open.indexOf('Done (7d)');
  assert.ok(d4 > 0 && d5 > d4 && done > d5, 'Drafts oldest first, then Done (7d)');
  assert.ok(open.includes('href="#/inspection/I1004"') && open.includes('Resume ›'));
  assert.ok(open.includes('href="#/wo/W1002">🔩 W1002<'), 'a Done row carries its work order');
  assert.ok(!open.includes('I1001'), 'the 100-day-old sheet never shipped');
  app.__ui().showInspections = false;
  sessionStorage.removeItem('wss.inspections.open');
});

await check('D67: amber only from a DRAFT two days old; the empty fixture reads "No inspections yet"', async () => {
  const snap = await asFull('owner');
  assert.equal(INSP.draftTone(snap.inspections, 2), 'amber');
  assert.equal(INSP.draftTone(snap.inspections.map((i) => ({ ...i, age_days: i.status === 'DRAFT' ? 1 : null })), 2), '');
  window.location.href = 'http://localhost:8787/?mock=empty&role=owner';
  window.location.search = '?mock=empty&role=owner';
  await app.__refresh();
  assert.ok(inspStripOf(await renderRoute('#/')).includes('>No inspections yet<'));
  await asFull('owner');
});

await check('D67: unit page — Resume on a DRAFT, the picker otherwise (default per §2), hours in the header, last 5', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    const du = snap.units.find((u) => u.inspection_draft === 'I1005');
    const d = snap.inspections.find((i) => i.id === 'I1005');
    const out = await renderRoute(`#/unit/${encodeURIComponent(du.serial)}`);
    assert.ok(out.includes(`href="#/inspection/I1005">📋 ${INSP.resumeText(d)}<`), `${role}: Resume`);
    assert.ok(!out.includes('data-form="insp-open"'), `${role}: never a second DRAFT`);
    const hu = snap.units.find((u) => u.last_inspection && u.last_inspection.id === 'I1003');
    const hout = await renderRoute(`#/unit/${encodeURIComponent(hu.serial)}`);
    assert.ok(hout.includes(`<div class="s hours-line">412.5 h · as of ${FMT_MD(hu.hours_as_of)}</div>`), `${role}: the meter in the header`);
    assert.ok(hout.includes('data-form="insp-open">📋 Inspect<'), `${role}: the Inspect button`);
    assert.ok(hout.includes(`I1003 · RETURN · ${FMT_MD(hu.last_inspection.done)} · Josh · 412.5 h · 2 ⚑`), `${role}: the list row`);
  }
  const snap = await asFull('service');
  const bare = snap.units.find((u) => !u.hours && !u.inspection_draft && u.unit_state !== 'RETIRED');
  assert.ok(!(await renderRoute(`#/unit/${encodeURIComponent(bare.serial)}`)).includes('hours-line'), 'no meter, no line');
  await asFull('owner');
});

await check('D67: the sheet renders FROM the checklist — sections in library order, filtered for the machine', async () => {
  const snap = await asFull('service');
  resetSheets();
  const out = await renderRoute('#/inspection/I1005');
  const lib = snap.inspection_checklist.sections;
  const titles = lib.map((s) => s.title).filter((t) => out.includes(`<h2>${t.replace(/&/g, '&amp;')} <span class="count">`));
  assert.deepEqual(titles, ['Batteries', 'Check operation & condition of', 'Scrub deck & squeegee'], 'library order, scrubber sees the deck');
  assert.ok(out.includes('data-iseg="ctl.estop"') && !out.includes('data-iseg="ctl.main_broom_ctl"'), 'class filter');
  assert.ok(!out.includes('data-iseg="ctl.horn"'), 'walk-behind: no horn');
  assert.ok(out.includes('data-iseg="bat.watering"'), 'WET: the watering row');
  assert.ok(!out.includes('data-iseg="bat.old_gauge"'), 'a retired row stays off a sheet that never answered it');
  assert.ok(out.includes('data-ifield="readings.brush1_pct"') && !out.includes('readings.main_broom_pct'), 'readings follow the class');
  // v1.2: % life left — whole numbers, the number pad, a % on the field; no recharge counter; "Body style".
  assert.ok(/<input type="number" inputmode="numeric" pattern="\[0-9\]\*" step="1" min="0" max="100" data-ifield="readings.brush1_pct"/.test(out), 'a numeric-keypad percent field');
  assert.ok(out.includes('<span>Brush 1 life left</span>') && out.includes('<span class="pct-suf" aria-hidden="true">%</span>'), 'labelled, with a % suffix');
  assert.ok(!out.includes('recharge') && !out.includes('_length'), 'no recharge counter, no lengths');
  assert.ok(out.includes('<span>Body style</span>') && out.includes('data-ifield="body_style"') && !out.includes('data-ifield="controls"'), 'the dropdown is Body style');
  assert.ok(out.includes('<span class="count">3/4 answered</span>'), 'Batteries: 3 of 4');
  // The WEAR scale on a WEAR row, FUNCTION on a FUNCTION row — from the library, never hard-coded.
  assert.ok(/data-iseg="deck.curtains" data-val="REPLACE"/.test(out) && !/data-iseg="deck.curtains" data-val="REPAIR"/.test(out));
  assert.ok(/data-iseg="ctl.estop" data-val="PROBLEM"/.test(out) && /data-iseg="ctl.estop" data-val="N\/A"/.test(out));
  // A DONE sheet that carries the retired row still draws it.
  assert.ok((await renderRoute('#/inspection/I1002')).includes('Analog charge gauge (retired)'));
});

await check('D67: switching body style to RIDER adds the rider rows and keeps every answer', async () => {
  await asFull('service');
  resetSheets();
  await renderRoute('#/inspection/I1005');
  await tapSeg('ctl.key_switch', 'REPAIR');
  await fireOn('change', fieldTarget('body_style', 'RIDER', 'SELECT'));
  await settle();
  let out = view._html;
  assert.ok(out.includes('data-iseg="ctl.horn"') && out.includes('data-iseg="ctl.seat_switch"'), 'the rider rows appear');
  assert.ok(out.includes('data-iseg="ctl.key_switch" data-val="REPAIR" aria-pressed="true"'), 'the answer typed before the switch is kept');
  assert.ok(out.includes('data-iseg="deck.curtains" data-val="WORN" aria-pressed="true"'), 'and the engine’s answers too');
  await tapSeg('ctl.horn', 'PROBLEM');
  await fireOn('change', fieldTarget('body_style', 'WALK-BEHIND', 'SELECT'));
  await fireOn('change', fieldTarget('body_style', 'RIDER', 'SELECT'));
  await settle();
  out = view._html;
  assert.ok(out.includes('data-iseg="ctl.horn" data-val="PROBLEM" aria-pressed="true"'), 'flip away and back: the horn answer survives');
  await fireOn('change', fieldTarget('machine_class', 'SWEEPER', 'SELECT'));
  await settle();
  assert.ok(!view._html.includes('data-iseg="deck.curtains"') && view._html.includes('data-iseg="ctl.side_broom_lift"'), 'a sweeper: no deck, the broom rows');
  resetSheets();
});

await check('D67: the WET cell grid follows voltage and pack; AGM hides it', async () => {
  await asFull('service');
  resetSheets();
  let out = await renderRoute('#/inspection/I1005');
  const rows = (o) => [...o.matchAll(/class="cell-r"/g)].length;
  const groups = (o) => [...o.matchAll(/class="cell-gh">Battery \d/g)].length;
  assert.equal(rows(out), 12, '24V: 12 cells');
  assert.equal(groups(out), 4, '4 × 6V: four batteries of A–C');
  assert.ok(out.includes('data-ifield="cell:4C:sg"') && !out.includes('cell:1D:sg'));
  await fireOn('change', fieldTarget('battery.pack', '2x12V', 'SELECT'));
  await settle();
  out = view._html;
  assert.equal(rows(out), 12, 'still 12 cells');
  assert.equal(groups(out), 2, '2 × 12V: two batteries of A–F');
  assert.ok(out.includes('data-ifield="cell:2F:sg"'));
  await fireOn('change', fieldTarget('battery.voltage', '36', 'SELECT'));
  await settle();
  out = view._html;
  assert.equal(rows(out), 0, 'a 24V pack does not fit 36V — no grid until the pack is picked');
  assert.ok(out.includes('Pick the voltage and the pack'));
  await fireOn('change', fieldTarget('battery.pack', '6x6V', 'SELECT'));
  await settle();
  assert.equal(rows(view._html), 18, '36V: 18 cells');
  assert.equal(groups(view._html), 6);
  await fireOn('change', fieldTarget('battery.type', 'AGM', 'SELECT'));
  await settle();
  out = view._html;
  assert.equal(rows(out), 0, 'AGM: no grid');
  assert.ok(out.includes('Sealed pack') && !out.includes('data-ifield="battery.pack"'), 'and no pack dropdown');
  assert.ok(!out.includes('data-iseg="bat.watering"'), 'the WET-only row goes too');
  resetSheets();
});

await check('D67: Done is disabled until an hours field has a value (the engine’s one rule)', async () => {
  await asFull('service');
  resetSheets();
  let out = await renderRoute('#/inspection/I1005');
  assert.ok(/data-sheet="insp-done" data-id="I1005" disabled>Done</.test(out), 'no hours: disabled');
  assert.ok(out.includes('Done needs an hours reading'));
  await fireOn('input', fieldTarget('readings.hours_traction', '88.5'));
  out = await renderRoute('#/inspection/I1005');
  assert.ok(/data-sheet="insp-done" data-id="I1005">Done</.test(out), 'traction hours count');
  await fireOn('input', fieldTarget('readings.hours_traction', ''));
  out = await renderRoute('#/inspection/I1005');
  assert.ok(/data-sheet="insp-done" data-id="I1005" disabled>Done</.test(out), 'cleared again: disabled again');
  resetSheets();
});

await check('D67: flagged rows tint; the WO button only on DONE + flags + no work order', async () => {
  await asFull('owner');
  resetSheets();
  const i3 = await renderRoute('#/inspection/I1003');
  assert.equal([...i3.matchAll(/class="irow flag"/g)].length, 2, 'two flags, two tinted rows');
  assert.ok(i3.includes('data-sheet="insp-wo"') && i3.includes('Open work order from this inspection'));
  assert.ok(!(await renderRoute('#/inspection/I1002')).includes('data-sheet="insp-wo"'), 'I1002 already has W1002');
  assert.ok(!(await renderRoute('#/inspection/I1005')).includes('data-sheet="insp-wo"'), 'not on a DRAFT');
  await renderRoute('#/inspection/I1005');
  await tapSeg('sqg.blades', 'REPAIR');
  assert.ok(/class="irow flag">\s*<div class="irow-top"><span class="irow-l">Check and rotate blades/.test(view._html), 'a fresh flag tints at once');
  assert.ok(view._html.includes('data-ifield="note:sqg.blades"'), 'and opens its note');
  resetSheets();
});

await check('D67: a DONE sheet is read-only; Reopen for owner, not for sales', async () => {
  for (const role of ['owner', 'sales']) {
    await asFull(role);
    resetSheets();
    const out = await renderRoute('#/inspection/I1003');
    const fields = [...out.matchAll(/<(input|select|textarea|button)[^>]*data-(ifield|iseg|irot)="[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.ok(fields.length > 30, 'the whole sheet is drawn');
    assert.ok(fields.every((f) => / disabled>$/.test(f)), `${role}: every control disabled`);
    assert.ok(!out.includes('id="insp-status"') && !out.includes('data-inote='), `${role}: no save line, no + note`);
    assert.equal(out.includes('data-sheet="insp-reopen"'), role === 'owner', `${role}: Reopen ${role === 'owner' ? 'shown' : 'hidden'}`);
  }
  await asFull('owner');
});

await check('D67: read-only chips — 📋 on the ticket the sheet linked, and on the work order opened from it', async () => {
  await asFull('service');
  const t = await renderRoute('#/ticket/S1002');
  assert.ok(t.includes('<a class="chip insp" href="#/inspection/I1005">📋 I1005</a>'));
  const w = await renderRoute('#/wo/W1002');
  assert.ok(w.includes('<a class="chip insp" href="#/inspection/I1002">📋 I1002</a>'));
  assert.ok(!(await renderRoute('#/wo/W1001')).includes('class="chip insp"'));
  await asFull('owner');
});

await check('D67: a numbered sheet saves ONE section per SAVE, and takes back its own older save of that section', async () => {
  const { posted, deleted } = await apiInsp({ name: 'Josh', role: 'service' });
  await renderRoute('#/inspection/I1005');
  await tapSeg('sqg.blades', 'REPAIR');
  await app.__flushSheets();
  assert.equal(posted.length, 1);
  assert.deepEqual(Object.keys(posted[0].payload).sort(), ['action', 'inspection', 'items']);
  assert.equal(posted[0].serial, null);
  const items = posted[0].payload.items;
  assert.equal(items.find((i) => i.id === 'sqg.blades').result, 'REPAIR');
  assert.equal(items.length, 7, 'the six the engine had + the new one — the whole section');
  await fireOn('input', fieldTarget('comments', 'rear blade rolled'));
  await fireOn('change', fieldTarget('comments', 'rear blade rolled', 'TEXTAREA'));
  await app.__flushSheets();
  assert.deepEqual(posted[1].payload, { action: 'SAVE', inspection: 'I1005', comments: 'rear blade rolled' }, 'comments alone');
  await fireOn('input', fieldTarget('note:sqg.blades', 'rolled'));
  await fireOn('change', fieldTarget('note:sqg.blades', 'rolled'));
  await app.__flushSheets();
  assert.equal(posted[2].payload.items.find((i) => i.id === 'sqg.blades').note, 'rolled');
  assert.ok(deleted.length === 1 && /:t1$/.test(deleted[0]), 'the older items SAVE is taken back; the comments SAVE is not');
  const saves = app.__state().pending.filter((e) => e.action === 'inspection' && e.payload.action === 'SAVE');
  assert.deepEqual(saves.map((e) => Object.keys(e.payload).filter((k) => k !== 'action' && k !== 'inspection')).sort(), [['comments'], ['items']]);
  assert.ok(!posted.some((p) => /\$\s?\d/.test(JSON.stringify(p)) || /"(cost|rate|price)"/.test(JSON.stringify(p))), 'no money');
  // v1.2: a body-style flip goes out as `body_style` — never `controls` — and a percent goes out whole.
  await fireOn('change', fieldTarget('body_style', 'RIDER', 'SELECT'));
  await fireOn('input', fieldTarget('readings.brush1_pct', '62.6'));
  await fireOn('change', fieldTarget('readings.brush1_pct', '62.6'));
  await app.__flushSheets();
  const bs = posted.find((p) => 'body_style' in p.payload);
  assert.deepEqual(bs && bs.payload, { action: 'SAVE', inspection: 'I1005', body_style: 'RIDER' });
  assert.ok(!posted.some((p) => 'controls' in p.payload), 'never `controls`');
  const rd = posted.filter((p) => 'readings' in p.payload).pop().payload.readings;
  assert.equal(rd.brush1_pct, 63);
  assert.ok(!('recharge_count' in rd) && !('brush1_length' in rd));
  await fireOn('input', fieldTarget('readings.brush2_pct', '140'));
  assert.equal(app.__sheetLocal().get('I1005').edits.readings.brush2_pct, null, '140% is refused on the phone');
  // The pending save is drawn on the sheet — badged, never as applied.
  const out = await renderRoute('#/inspection/I1005');
  assert.ok(out.includes('saved items') && out.includes('saved comments') && out.includes('saved body_style'));
  await leaveApi();
});

await check('D67: a NEW sheet opens at once as ⏳ NEW; each save re-issues the pending OPEN and takes the old one back', async () => {
  const { snapshot, posted, deleted } = await apiInsp({ name: 'Josh', role: 'service' });
  const u = snapshot.units.find((x) => !x.inspection_draft && x.unit_state === 'ON-RENT');
  const unitOut = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(unitOut.includes('data-form="insp-open"'));
  await fireOn('click', fakeTarget('[data-insp-open]', { dataset: { inspOpen: 'RETURN', serial: u.serial } }));
  await settle();
  assert.deepEqual(posted[0], { action: 'inspection', serial: u.serial, payload: { action: 'OPEN', kind: 'RETURN' } });
  assert.equal(window.location.hash, `#/inspection/new/${encodeURIComponent(u.serial)}`, 'straight to the sheet');
  let out = await renderRoute(window.location.hash);
  assert.ok(out.includes('⏳ NEW · ') && out.includes('not numbered yet'), 'drawn as NEW');
  assert.ok(!/I\d{4} · /.test(out.slice(out.indexOf('<div class="h">'), out.indexOf('</div>', out.indexOf('<div class="h">')))), 'no invented I-number');
  const newKey = `new:${u.serial}`;
  assert.ok(out.includes(`data-sheet="insp-done" data-id="${newKey}" disabled>Done<`), 'no hours yet: Done disabled');
  assert.ok(!out.includes('Done unlocks once the engine numbers'), 'the old "wait for the number" copy is gone');
  assert.ok(out.includes('data-ifield="kind"'), 'the kind can still change — it rides on the OPEN');
  await fireOn('input', fieldTarget('readings.hours_key', '1204'));
  await fireOn('change', fieldTarget('readings.hours_key', '1204'));
  await app.__flushSheets();
  assert.equal(posted.length, 2);
  assert.equal(posted[1].serial, u.serial);
  assert.equal(posted[1].payload.action, 'OPEN');
  assert.equal(posted[1].payload.kind, 'RETURN');
  assert.equal(posted[1].payload.readings.hours_key, 1204);
  assert.ok(!('inspection' in posted[1].payload));
  assert.equal(deleted.length, 1, 'the first OPEN is taken back');
  await tapSeg('ctl.key_switch', 'IN-SPEC');
  await app.__flushSheets();
  assert.equal(posted[2].payload.readings.hours_key, 1204, 'the fold carries everything typed so far');
  assert.equal(posted[2].payload.items[0].id, 'ctl.key_switch');
  const opens = app.__state().pending.filter((e) => e.action === 'inspection' && e.payload.action === 'OPEN');
  assert.equal(opens.length, 1, 'one OPEN in the inbox, always the latest');
  out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('⏳ Resume new sheet · Return'), 'the unit page resumes it');
  out = await renderRoute(`#/inspection/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes(`data-sheet="insp-done" data-id="${newKey}">Done<`), 'D67c: an hours reading on a ⏳ NEW sheet enables Done');
  await leaveApi();
});

await check('D67c: Done on a ⏳ NEW sheet saves first (the OPEN fold), then posts DONE keyed on the serial; the sheet locks', async () => {
  const snap0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const u = snap0.units.find((x) => !x.inspection_draft && x.unit_state === 'ON-RENT');
  const open = { id: '2026-09-25T11:00:00.000Z:o1', ts: '2026-09-25T11:00:00.000Z', actor: 'Josh', role: 'service',
    action: 'inspection', serial: u.serial, payload: { action: 'OPEN', kind: 'RETURN' } };
  const { posted, deleted } = await apiInsp({ name: 'Josh', role: 'service' }, [open]);
  const key = `new:${u.serial}`;
  await renderRoute(`#/inspection/new/${encodeURIComponent(u.serial)}`);
  await fireOn('input', fieldTarget('readings.hours_key', '412.5'));    // typed, not yet blurred
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'insp-done', id: key } }));
  await settle();
  assert.ok(view._html.includes(`data-serial="${u.serial}"`) && view._html.includes('>Mark it done<'), 'the Done sheet carries the serial');
  await submitForm({ action: 'inspection', verb: 'DONE', key, serial: u.serial }, { tech: 'Josh' });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].payload.action, 'OPEN', 'flush first: the OPEN is re-issued with the meter');
  assert.equal(posted[0].payload.readings.hours_key, 412.5);
  assert.deepEqual(deleted, [open.id], 'and the older OPEN taken back');
  assert.deepEqual(posted[1], { action: 'inspection', serial: u.serial, payload: { action: 'DONE', tech: 'Josh' } },
    'DONE keyed on the serial — no invented inspection key');
  const out = await renderRoute(`#/inspection/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('done (Josh) — by Josh'), 'the pending Done badges on this sheet, by serial');
  assert.ok(out.includes('Marked done — the engine files it'), 'says what happens next');
  assert.ok(!out.includes('data-sheet="insp-done"') && !out.includes('id="insp-status"'), 'locked: no Done, no saving');
  assert.ok(/data-ifield="comments"[^>]* disabled>/.test(out), 'every field read-only');
  // A tap after Done must not fold: it would re-issue the OPEN AFTER the Done.
  await tapSeg('ctl.key_switch', 'IN-SPEC');
  await app.__flushSheets();
  assert.equal(posted.length, 2, 'nothing more goes out');
  app.__ui().showInspections = true;
  assert.ok(inspStripOf(await renderRoute('#/')).includes('— done, numbered at the next run'), 'the strip card says done');
  app.__ui().showInspections = false;
  const unitOut = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(unitOut.includes('⏳ done (Josh) by Josh'), 'the unit page lists it (keyed on the serial)');
  await leaveApi();
});

await check('D67c: undoing a NEW sheet’s OPEN also takes back my Done sent against its serial', async () => {
  const snap0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const u = snap0.units.find((x) => !x.inspection_draft && x.unit_state === 'ON-RENT');
  const open = { id: '2026-09-25T11:00:00.000Z:o1', ts: '2026-09-25T11:00:00.000Z', actor: 'Josh', role: 'service',
    action: 'inspection', serial: u.serial, payload: { action: 'OPEN', kind: 'PM', readings: { hours_key: 9 } } };
  const done = { id: '2026-09-25T11:01:00.000Z:d1', ts: '2026-09-25T11:01:00.000Z', actor: 'Josh', role: 'service',
    action: 'inspection', serial: u.serial, payload: { action: 'DONE', tech: 'Josh' } };
  const { deleted } = await apiInsp({ name: 'Josh', role: 'service' }, [open, done]);
  await renderRoute(`#/inspection/new/${encodeURIComponent(u.serial)}`);
  await fireOn('click', fakeTarget('[data-undo]', { dataset: { undo: open.id } }));
  await settle();
  assert.deepEqual(deleted, [open.id, done.id], 'the Done would find no DRAFT — it goes too');
  await leaveApi();
});

await check('D67c: a numbered DRAFT shows a Done still pending against its serial, and locks', async () => {
  const snap0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const d = snap0.inspections.find((i) => i.id === 'I1005');
  const done = { id: '2026-09-25T11:01:00.000Z:d1', ts: '2026-09-25T11:01:00.000Z', actor: 'Josh', role: 'service',
    action: 'inspection', serial: d.serial, payload: { action: 'DONE', tech: 'Josh' } };
  await apiInsp({ name: 'Josh', role: 'service' }, [done]);
  const out = await renderRoute('#/inspection/I1005');
  assert.ok(out.includes('done (Josh) — by Josh') && !out.includes('id="insp-status"') && !out.includes('data-sheet="insp-done"'));
  await leaveApi();
});

await check('D67: the engine takes the OPEN mid-save (404 on the take-back) — the fresh OPEN is withdrawn and the tech told', async () => {
  const first = { id: '2026-09-25T11:00:00.000Z:old1', ts: '2026-09-25T11:00:00.000Z', actor: 'Josh', role: 'service',
    action: 'inspection', serial: null, payload: { action: 'OPEN', kind: 'PM' } };
  const snap0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const u = snap0.units.find((x) => !x.inspection_draft && x.unit_state === 'ON-RENT');
  first.serial = u.serial;
  const { posted, deleted } = await apiInsp({ name: 'Josh', role: 'service' }, [first], { delStatus: (id) => (id === first.id ? 404 : 200) });
  await renderRoute(`#/inspection/new/${encodeURIComponent(u.serial)}`);
  await fireOn('input', fieldTarget('readings.hours_key', '50'));
  await fireOn('change', fieldTarget('readings.hours_key', '50'));
  await app.__flushSheets();
  assert.equal(posted.length, 1);
  assert.deepEqual(deleted, [first.id, `${'2026-09-25T12:00:01.000Z'}:t1`], 'old (404), then the fresh one');
  const l = app.__sheetLocal().get(`new:${u.serial}`);
  assert.equal(l.status, 'failed');
  assert.ok(l.error.includes('picked this sheet up'), l.error);
  assert.ok(l.dirty.has('readings'), 'the change is still held for the numbered sheet');
  await leaveApi();
});

await check('D67: Done saves what is unsaved FIRST, then posts DONE with the tech', async () => {
  const { posted } = await apiInsp({ name: 'Josh', role: 'service' });
  await renderRoute('#/inspection/I1005');
  await fireOn('input', fieldTarget('readings.hours_key', '412.5'));      // typed, not yet blurred
  await submitForm({ action: 'inspection', verb: 'DONE', insp: 'I1005', key: 'I1005' }, { tech: 'Zac' });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].payload.action, 'SAVE');
  assert.equal(posted[0].payload.readings.hours_key, 412.5, 'the meter lands before the lock');
  assert.deepEqual(posted[1], { action: 'inspection', serial: null, payload: { action: 'DONE', inspection: 'I1005', tech: 'Zac' } });
  const out = await renderRoute('#/inspection/I1005');
  assert.ok(out.includes('done (Zac)') && !out.includes('id="insp-status"'), 'a pending DONE locks the sheet');
  assert.ok(out.includes('data-ifield="comments" maxlength="1000" placeholder="anything else — for the next tech, or for Matt" disabled'));
  await leaveApi();
});

await check('D67: "Open work order from this inspection" posts work_order OPEN with the back-link and the flagged rows', async () => {
  const { snapshot, posted } = await apiInsp({ name: 'Matt', role: 'owner' });
  const i3 = snapshot.inspections.find((i) => i.id === 'I1003');
  await renderRoute('#/inspection/I1003');
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'insp-wo', id: 'I1003' } }));
  await settle();
  const out = view._html;
  assert.ok(out.includes('data-inspection="I1003"'), 'the form carries the sheet');
  assert.ok(out.includes('>from I1003: Deck curtains / wipers; Check and rotate blades as needed</textarea>'), 'the note, pre-filled');
  assert.ok(/data-toggle="purpose"[\s\S]*?class="tg on" data-val="REPAIR"/.test(out), 'a RETURN finding is a repair');
  await submitForm({ action: 'work_order', verb: 'OPEN', serial: i3.serial, inspection: 'I1003' }, {
    purpose: 'REPAIR', note: 'from I1003: Check and rotate blades as needed',
    p_mfr: ['OTHER'], p_num: ['21-422S'], p_desc: ['Squeegee blade rear'], p_qty: ['2'],
  });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], { action: 'work_order', serial: i3.serial, payload: { action: 'OPEN', purpose: 'REPAIR',
    note: 'from I1003: Check and rotate blades as needed',
    parts: [{ manufacturer: 'OTHER', part_number: '21-422S', description: 'Squeegee blade rear', qty: 2 }], inspection: 'I1003' } });
  const after = await renderRoute('#/inspection/I1003');
  assert.ok(!after.includes('data-sheet="insp-wo"') && after.includes('Work order requested from this sheet'), 'no second one while it is pending');
  await leaveApi();
});

await check('D67: undoing a NEW sheet’s OPEN discards what was typed into it', async () => {
  const snap0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const u = snap0.units.find((x) => !x.inspection_draft && x.unit_state === 'ON-RENT');
  const open = { id: '2026-09-25T11:00:00.000Z:o1', ts: '2026-09-25T11:00:00.000Z', actor: 'Josh', role: 'service',
    action: 'inspection', serial: u.serial, payload: { action: 'OPEN', kind: 'PM' } };
  await apiInsp({ name: 'Josh', role: 'service' }, [open]);
  await renderRoute(`#/inspection/new/${encodeURIComponent(u.serial)}`);
  await tapSeg('ctl.key_switch', 'IN-SPEC');
  assert.ok(app.__sheetLocal().has(`new:${u.serial}`));
  await fireOn('click', fakeTarget('[data-undo]', { dataset: { undo: open.id } }));
  await settle();
  assert.ok(!app.__sheetLocal().has(`new:${u.serial}`), 'nothing lingers to fold into a later sheet');
  await leaveApi();
});

await check('D67: no money KEY on a sheet or the library — and a tech\'s "$40 blade" note is honest data, drawn as typed', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    app.__ui().showInspections = true;
    for (const r of ['#/', ...snap.inspections.map((i) => `#/inspection/${i.id}`)]) {
      const out = r === '#/' ? inspStripOf(await renderRoute(r)) : await renderRoute(r);
      assert.ok(!MONEY_RE.test(out), `${role} ${r}: a dollar figure`);
    }
    app.__ui().showInspections = false;
    assert.ok(!/"(cost|cost_source_inv|rate|price|amount)"\s*:/i.test(JSON.stringify([snap.inspections, snap.inspection_checklist])), `${role}: no money key`);
  }
  // Red-pen #1: the gate is on KEYS. A figure a tech types is theirs to type.
  resetSheets();
  await renderRoute('#/inspection/I1005');
  await tapSeg('sqg.blades', 'REPAIR');
  await fireOn('input', fieldTarget('note:sqg.blades', '$40 blade from RPS'));
  assert.ok((await renderRoute('#/inspection/I1005')).includes('value="$40 blade from RPS"'));
  resetSheets();
  await asFull('owner');
});

await check('D67: when the I-number lands, the NEW route redirects and anything unsaved moves to the numbered sheet', async () => {
  const snap = await asFull('service');
  resetSheets();
  const u = snap.units.find((x) => x.inspection_draft === 'I1005');
  app.__sheetLocal().set(`new:${u.serial}`, { edits: { comments: 'typed before the run', kind: 'CHECKOUT' }, dirty: new Set(['comments', 'kind']),
    status: 'dirty', error: null, timer: null, notes: new Set(), chain: Promise.resolve() });
  const out = await renderRoute(`#/inspection/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('Opening I1005'));
  assert.equal(window.location.hash, '#/inspection/I1005', 'replaced, not pushed');
  const l = app.__sheetLocal().get('I1005');
  assert.ok(l && l.dirty.has('comments') && !l.dirty.has('kind'), 'the comments move across; the kind was the OPEN’s alone');
  assert.equal(l.edits.comments, 'typed before the run');
  assert.ok(!app.__sheetLocal().has(`new:${u.serial}`));
  assert.ok((await renderRoute('#/inspection/I1005')).includes('>typed before the run</textarea>'));
  resetSheets();
  await asFull('owner');
});

await check('every module app.js imports is in the service worker’s shell (an installed app must boot offline)', async () => {
  const appSrc = fs.readFileSync(path.join(DOCS, 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const mods = [...appSrc.matchAll(/from '\.\/([a-z-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(mods.includes('inspections.js'), 'the scan finds the D67 module');
  for (const m of mods) assert.ok(shell.includes(`'${m}'`), `${m} is imported but not precached in sw.js`);
});

console.log(`\n${passed} checks passed.`);
