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
    // D69: every unit with a last inspection, and every ⏳ NEW work order (the sheet is waiting on it).
    ...snap.units.filter((u) => u.last_inspection).map((u) => `#/unit/${encodeURIComponent(u.serial)}`),
    ...app.__state().pending.filter((e) => e.action === 'work_order' && e.payload && e.payload.action === 'OPEN' && e.serial)
      .map((e) => `#/wo/new/${encodeURIComponent(e.serial)}`),
    '#/unit/nope', '#/ticket/S9999', '#/lead/L9999', '#/wo/W9999', '#/wo/new/nope',
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
  const open = q.filter((t) => t.machine_owner === 'CUSTOMER' && t.status === 'OPEN' && !t.dormant).length;   // D81: the shelf is not the pipeline
  // D62: the snapshot carries 90 days of closed tickets; the pill is this week's only.
  const closed = q.filter((t) => t.machine_owner === 'CUSTOMER' && t.status === 'CLOSED' && t.closed_age_days <= 7).length;
  assert.ok(q.some((t) => t.machine_owner === 'CUSTOMER' && t.status === 'CLOSED' && t.closed_age_days > 7), 'the mock carries older closes');
  assert.ok(out.includes(`${open} open`), `header pill should read "${open} open"`);
  assert.equal(out.includes('closed this week'), closed > 0, 'the closed pill hides at zero');
  if (closed) assert.ok(out.includes(`${closed} closed this week`), `closed pill should read ${closed}, not the 90-day total`);
});

await check('D81: a dormant ticket draws no card and no count; the 💤 Dormant row sits above Completed, opens, lists it; detail says so', async () => {
  const snap = app.__state().snapshot;
  const q = snap.service_queue;
  const dorm = q.filter((t) => t.status === 'OPEN' && t.dormant === true);
  assert.ok(dorm.length >= 1, 'the mock carries a dormant ticket');
  const noResp = q.find((t) => t.status === 'CLOSED' && t.close_reason === 'NO-RESPONSE');
  assert.ok(noResp, 'and one the engine closed NO-RESPONSE');
  const out = await serviceUnder('all');
  const kan = out.split('class="kan-wrap"')[1];
  for (const t of dorm) assert.ok(!kan.includes(`>${t.ticket}<`), `${t.ticket} must not draw a card`);
  const col = out.split('id="kan-WAITING-ON-CUSTOMER"')[1].split('</section>')[0];
  const drawn = [...col.matchAll(/href="#\/ticket\/(S\d+)"/g)].length;
  assert.ok(col.includes(`<span class="c">${drawn}</span>`), 'the column count matches the cards (summary excludes dormant)');
  assert.equal(snap.service_summary.open_by_stage['WAITING-ON-CUSTOMER'], drawn);
  const live = q.filter((t) => t.status === 'OPEN' && !t.dormant).length;
  assert.ok(out.includes(`data-filter="all">All<span class="c">${live}</span>`), 'the All chip leaves dormant out');
  // The row: above Completed, inside the pipeline card, no bar, collapsed by default, engine pill.
  const pipe = out.split('aria-label="Service pipeline')[1].split('</section>')[0];
  const di = pipe.indexOf('data-dormant-toggle'); const ci = pipe.indexOf('data-completed-toggle'); const ri = pipe.indexOf('data-pipe="READY-TO-INVOICE"');
  assert.ok(di > ri && ci > di, 'Ready to invoice → Dormant → Completed');
  assert.ok(pipe.includes('data-dormant-toggle="1" aria-expanded="false"'), 'collapsed by default');
  assert.ok(pipe.includes(`💤 Dormant ▸</button>\n      <span class="done-n">${snap.service_summary.dormant}</span>`), 'pill = summary.dormant');
  assert.ok(!pipe.includes('id="dormant-list"'), 'no list while collapsed');
  assert.ok(out.includes(`${q.filter((t) => t.machine_owner === 'CUSTOMER' && t.status === 'OPEN' && !t.dormant).length} open`), 'the open pill leaves the shelf out');
  const toggle = async () => {
    for (const fn of listeners.get('click') || []) await fn({ target: { closest: (sel) => (sel === '[data-dormant-toggle]' ? {} : null) } });
    return view._html;
  };
  const open = await toggle();
  const list = open.split('id="dormant-list">')[1].split('</section>')[0];
  const ids = [...list.matchAll(/href="#\/ticket\/(S\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, dorm.slice().sort((a, b) => b.waiting_days - a.waiting_days || a.ticket.localeCompare(b.ticket)).map((t) => t.ticket), 'every dormant ticket, quietest first');
  assert.ok(list.includes(`quiet ${dorm[0].waiting_days}d`) && list.includes(`closes in ${60 - dorm[0].waiting_days}d`), 'quiet / closes-in on the row');
  assert.ok(open.includes('closes itself at 60 days'), 'the caption names the auto-close');
  assert.ok(!list.includes(noResp.ticket), 'a closed ticket is never on the shelf');
  await toggle();
  // Fleet chip: no pipeline, so no Dormant row either (same as Completed).
  assert.ok(!(await serviceUnder('WSS')).includes('data-dormant-toggle'));
  // Ticket detail: the chip + the customer clock; the stage picker is the way back (unchanged).
  const det = await renderRoute(`#/ticket/${dorm[0].ticket}`);
  assert.ok(det.includes('💤 Dormant'), 'dormant chip');
  assert.ok(det.includes(`${dorm[0].waiting_days} days · dormant, off the board · closes itself in ${60 - dorm[0].waiting_days}d without a reply`), 'the Customer quiet row');
  assert.ok(det.includes('data-stage="READY-TO-SCHEDULE"'), 'the stage picker still draws — it is the way back');
  assert.ok((await renderRoute(`#/ticket/${noResp.ticket}`)).includes('CLOSED · no response'), 'a NO-RESPONSE close says so');
  await renderRoute('#/service');
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
    // D69: a sheet change on a ⏳ NEW work order only shows on that page.
    .concat(app.__state().pending.filter((e) => e.action === 'work_order' && e.payload && e.payload.action === 'OPEN' && e.serial)
      .map((e) => `#/wo/new/${encodeURIComponent(e.serial)}`));
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
  // evt-mock-8 is Kevin's pending stage move on this lead; evt-mock-15 (D77)
  // his photo coming off it — both ride the same pending list.
  assert.ok(out.includes('⏳ 2 pending changes'), 'the pending writes are badged');
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

/* ================================ remove a crew upload — D77 =============== */

const crewIds = (entity) => (entity.docs || []).filter((d) => d.crew === true).map((d) => d.id);
const detachIds = (out) => [...out.matchAll(/data-doc-detach="([0-9a-f]{16})"/g)].map((m) => m[1]);

await check('D77: the ✕ sits only on crew:true filed rows — every role, ticket and lead', async () => {
  for (const role of ['owner', 'sales', 'service']) {
    const snap = await asFull(role);
    const t = snap.service_queue.find((x) => crewIds(x).length && (x.docs || []).some((d) => d.crew === false));
    const l = snap.leads.find((x) => crewIds(x).length && (x.docs || []).some((d) => d.crew === false));
    assert.ok(t && l, 'the fixture must carry a crew and a vault doc on a ticket and on a lead');
    for (const [hash, rec, id] of [[`#/ticket/${t.ticket}`, t, t.ticket], [`#/lead/${l.lead}`, l, l.lead]]) {
      const out = await renderRoute(hash);
      assert.deepEqual(detachIds(out), crewIds(rec), `${role} ${id}: ✕ on exactly the crew rows`);
      for (const d of rec.docs) assert.ok(out.includes(`data-doc="${d.id}"`), `${d.name} still opens`);
      // Beside the row, never inside it: the row button closes before the ✕ opens.
      assert.ok(/<\/button>\s*<button class="docx" type="button" data-doc-detach="/.test(out), 'the ✕ must not nest in the row');
      assert.ok(out.includes(`data-record="${id}"`) && out.includes(`aria-label="Remove `) && out.includes(` from ${id}"`));
    }
    // A vault-only ticket (the quote) has no ✕ at all.
    const q = snap.service_queue.find((x) => (x.docs || []).length && !crewIds(x).length);
    assert.deepEqual(detachIds(await renderRoute(`#/ticket/${q.ticket}`)), []);
  }
});

await check('D77: an absent crew key reads false — no ✕; pending attach rows never get one', async () => {
  const snap = await asFull('owner');
  const t = snap.service_queue.find((x) => crewIds(x).length);
  for (const d of t.docs) delete d.crew;
  app.__state().pending.push({ id: 'pa', action: 'doc_attach', actor: 'Matt', role: 'owner', serial: null,
    payload: { record: t.ticket, doc_id: '9999888877776666', kind: 'WORKORDER', name: 'wo2.pdf' } });
  const out = await renderRoute(`#/ticket/${t.ticket}`);
  assert.ok(out.includes('is-pending') && out.includes('wo2.pdf'));
  assert.deepEqual(detachIds(out), [], 'no crew flag, no ✕ — and a pending row never has one');
  app.__state().pending.length = 0;
  await asFull('owner');
});

await check('D77: a pending doc_detach strikes the row through, drops its ✕, keeps it openable, offers Undo', async () => {
  const out = await leadsAs('sales', '#/lead/L1005');
  const ev = app.__state().pending.find((e) => e.action === 'doc_detach');
  assert.ok(ev && ev.payload.record === 'L1005', 'the pending fixture must carry the detach');
  const id = ev.payload.doc_id;
  assert.ok(new RegExp(`class="docrow is-detaching"[^>]*data-doc="${id}"`).test(out), 'struck-through row, still openable');
  assert.ok(out.includes('⏳ removing'));
  assert.ok(!out.includes(`data-doc-detach="${id}"`), 'no ✕ on a row already on its way off');
  assert.ok(out.includes('removing Photo — WO-L1005-'), 'the pending list names what is coming off');
  assert.ok(out.includes(`data-sheet="undo" data-id="${ev.id}"`), "Kevin's own tap gets the ordinary Undo");
  // Josh sees it pending too, but it is not his to undo.
  const josh = await leadsAs('service', '#/lead/L1005');
  assert.ok(josh.includes('is-detaching') && !josh.includes(`data-id="${ev.id}"`));
  await asFull('owner');
});

await check('D77: ✕ → confirm sheet → Remove posts {record, doc_id}; a 4xx toasts the Worker and changes nothing', async () => {
  const posted = [];
  let reply = 201;
  const snap = await apiMode(async (u, init) => {
    const body = JSON.parse(init.body);
    posted.push(body);
    if (reply !== 201) return { ok: false, status: reply, json: async () => ({ error: 'bad doc_id' }) };
    return { ok: true, status: 201, json: async () => ({ id: 'evt-d1', ts: 'x', actor: 'Josh', role: 'service', action: body.action, serial: null, payload: body.payload }) };
  });
  const t = snap.service_queue.find((x) => crewIds(x).length);
  const [id] = crewIds(t);
  const hash = `#/ticket/${t.ticket}`;
  await renderRoute(hash);

  await fireOn('click', fakeTarget('[data-doc-detach]', { dataset: { docDetach: id, record: t.ticket } }));
  let out = await renderRoute(hash);
  assert.ok(out.includes(`Remove this document from ${t.ticket}?`));
  assert.ok(out.includes('The file stays in the office archive — nothing is deleted.'));
  assert.ok(out.includes(`data-doc-detach-go="${id}"`) && out.includes('data-sheet-close="1"'));

  // A 4xx: the Worker's words, the row as it was.
  reply = 400;
  await fireOn('click', fakeTarget('[data-doc-detach-go]', { dataset: { docDetachGo: id, record: t.ticket } }));
  await settle();
  out = view._html;   // the message shows once — read the handler's own render
  assert.ok(out.includes('Event rejected (400): bad doc_id'), 'the toast carries the Worker message');
  assert.ok(!out.includes('is-detaching') && out.includes(`data-doc-detach="${id}"`));

  reply = 201;
  await fireOn('click', fakeTarget('[data-doc-detach-go]', { dataset: { docDetachGo: id, record: t.ticket } }));
  out = await renderRoute(hash);
  const last = posted[posted.length - 1];
  assert.deepEqual(last, { action: 'doc_detach', serial: null, payload: { record: t.ticket, doc_id: id } });
  assert.ok(out.includes('is-detaching') && out.includes('⏳ removing'));
  assert.ok(!out.includes(`data-doc-detach="${id}"`));
  assert.ok(out.includes('data-sheet="undo" data-id="evt-d1"'), 'my own detach gets Undo in the pending list');
  await backToMock();
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
/** One landing strip by its aria-label ('Work orders' by default, 'Parts tracker'). */
const sectionOf = (out, label) => {
  const i = out.indexOf(`<section class="parts card" aria-label="${label}">`);
  if (i < 0) return '';
  return out.slice(i, out.indexOf('</section>', i) + 10);
};
const partsStripOf = (out) => sectionOf(out, 'Work orders');
const trackerOf = (out) => sectionOf(out, 'Parts tracker');
const setParts = (open) => {
  const u = app.__ui();
  u.showParts = open; u.showPartsDelivered = open; u.showTracker = open; u.trackerOpen = new Set();
};
/** A tracker group's markup, header + (when unfolded) its lines. */
const trackerGroupOf = (st, id) => {
  const i = st.indexOf(`data-tracker-wo="${id}"`);
  if (i < 0) return '';
  const start = st.lastIndexOf('<div class="ptrk">', i);
  const next = st.indexOf('<div class="ptrk">', i);
  const sub = st.indexOf('class="parts-sub"', i);
  const ends = [next, sub, st.indexOf('</section>', i)].filter((x) => x > 0);
  return st.slice(start, Math.min(...ends));
};

await check('D75: two strips under the utilization card — Work orders, then Parts tracker — both folded, above the cards', async () => {
  const snap = await asFull('owner');
  setParts(false);
  const out = await renderRoute('#/');
  assert.equal([...out.matchAll(/<section class="parts card"/g)].length, 2, 'two section.parts');
  const util = out.indexOf('class="util"');
  const wo = out.indexOf('aria-label="Work orders"');
  const trk = out.indexOf('aria-label="Parts tracker"');
  const card = out.indexOf('cat-card');
  assert.ok(util >= 0 && wo > util && trk > wo && card > trk, 'util → Work orders → Parts tracker → category cards');
  const s = snap.work_order_summary;
  const st = partsStripOf(out);
  assert.ok(st.includes('🔧 Work orders ▸'), 'reads 🔧 Work orders ▸');
  assert.ok(st.includes(`>${s.open} open · ${s.inspections_pending} inspection pending<`), 'pill = open · inspections pending — no parts segment');
  assert.ok(!st.includes('parts open<'), 'the parts count moved to the tracker');
  assert.ok(/parts-n amber/.test(st) && !/parts-n red/.test(st), 'Work orders tones by the inspection rule only (W1001 PENDING 3 days → amber, never red)');
  assert.ok(!st.includes('id="parts-body"'), 'collapsed by default');
  const tr = trackerOf(out);
  assert.ok(tr.includes('📦 Parts tracker ▸'), 'reads 📦 Parts tracker ▸');
  const open = snap.work_orders.filter((w) => w.status !== 'CLOSED').flatMap((w) => w.parts);
  // D79: the customer orders on OPEN tickets count in ordered / in transit (requested stays work-order only).
  const orders = snap.service_queue.filter((t) => t.status === 'OPEN' && t.order).map((t) => t.order);
  const n = (st2) => open.filter((p) => p.state === st2).length + orders.filter((o) => o.state === st2).length;
  assert.ok(orders.some((o) => o.state === 'ORDERED') && orders.some((o) => o.state === 'IN-TRANSIT'), 'mock carries both');
  assert.ok(tr.includes(`>${n('ORDERED')} ordered · ${n('IN-TRANSIT')} in transit · ${n('REQUESTED')} requested<`), 'pill = ordered · in transit · requested');
  assert.ok(/parts-n red/.test(tr), 'a REQUESTED line on an 8-day-old work order is red — on the tracker');
  assert.ok(!tr.includes('id="tracker-body"'), 'collapsed by default');
  assert.ok(!out.includes('📋 Inspections'), 'the D67 strip is gone');
});

await check('D75: Work orders expanded — the open work orders with their 📋 chip, and no part lines', async () => {
  const snap = await asFull('owner');
  setParts(false);
  app.__ui().showParts = true;
  const st = partsStripOf(await renderRoute('#/'));
  assert.ok(st.includes('>Open <'), 'Open group');
  for (const g of ['>Ordered <', '>In transit <', '>Requested <', 'Delivered (30d)']) assert.ok(!st.includes(g), `no ${g} group`);
  assert.ok(!st.includes('🔩'), 'no 🔩 part rows');
  assert.ok(!st.includes('wo-ref'), 'no W-number chips');
  assert.ok(st.includes('>📋 pending</span>') && /chip insp amber">📋 pending/.test(st), 'W1001: pending, amber (3 days)');
  assert.ok(st.includes('>📋 ✓ 2 ⚑</span>'), 'W1002: done, two flags');
  assert.ok(st.includes('>📋 skipped</span>'), 'W1003: skipped');
  const rows = [...st.matchAll(/<div class="prow">/g)].length;
  assert.equal(rows, snap.work_orders.filter((w) => w.status === 'OPEN').length, 'one row per open work order');
  assert.ok(st.includes('PO <strong>W1001</strong>') && st.includes('href="#/wo/W1001"'), 'W-number labelled PO, tap → #/wo/');
  assert.ok(!MONEY_RE.test(st), 'no money in the strip');
  setParts(false);
});

await check('D75: Parts tracker expanded — one fold per work order, oldest first, each folded, header counts + worst-tone age', async () => {
  const snap = await asFull('owner');
  setParts(false);
  app.__ui().showTracker = true;
  const tr = trackerOf(await renderRoute('#/'));
  assert.ok(tr.includes('id="tracker-body"'));
  assert.ok(!tr.includes('🔩'), 'every group starts folded — no lines drawn');
  const order = [...tr.matchAll(/data-tracker-wo="(W\d{4})"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['W1003', 'W1001', 'W1002'], 'Active: oldest age_days first; Delivered (30d) folded');
  assert.ok(tr.includes('Delivered (30d) <span class="count">2</span>'), 'Delivered (30d) counts work orders (W1004), not lines — plus the one DELIVERED customer order (D79)');
  assert.ok(!tr.includes('W1005'), 'the 40-day-old closed work order never shows');
  assert.ok(!/>Active</i.test(tr), 'no label on the Active band');
  const w1 = trackerGroupOf(tr, 'W1001');
  assert.ok(w1.includes('role="button"') && w1.includes('aria-expanded="false"'), 'the header is the toggle');
  assert.ok(w1.includes('<a class="prow-po" href="#/wo/W1001">PO <strong>W1001</strong></a>'), 'PO W1001, red mono, a link to the work order');
  const w = snap.work_orders.find((x) => x.id === 'W1001');
  assert.ok(w1.includes(`<span class="ptrk-asset">${w.asset_item}</span>`), 'asset as plain text, not a chip');
  assert.ok(w1.includes('>1 requested · 1 ordered · 1 in transit · 1 delivered<'), 'per-state counts, requested → delivered');
  assert.ok(w1.includes('<span class="chip age amber">3d</span>'), 'age chip toned by the worst open line (REQUESTED on a 3-day WO → amber)');
  const w3 = trackerGroupOf(tr, 'W1003');
  assert.ok(w3.includes('>1 requested · 1 in transit<'), 'zero segments dropped');
  assert.ok(w3.includes('<span class="chip age red">8d</span>'), '8 days → red');
  assert.ok(!MONEY_RE.test(tr), 'no money in the tracker');
  setParts(false);
});

await check('D75: tapping a fold (the real click handler) drops its lines — no W-number chip, state chip, tracking chip intact', async () => {
  await asFull('owner');
  setParts(false);
  app.__ui().showTracker = true;
  await renderRoute('#/');
  // A tap on the PO link inside the header is the link's — it must not toggle.
  const linkTap = fakeTarget('[data-tracker-wo]', { dataset: { trackerWo: 'W1001' } });
  const inner = linkTap.closest;
  linkTap.closest = (q) => (q === 'a' ? { href: '#/wo/W1001' } : inner(q));
  await fireOn('click', linkTap);
  await settle();
  assert.ok(!app.__ui().trackerOpen.has('W1001'), 'a tap on PO W1001 navigates, never folds');
  await fireOn('click', fakeTarget('[data-tracker-wo]', { dataset: { trackerWo: 'W1001' } }));
  await settle();
  assert.ok(app.__ui().trackerOpen.has('W1001'));
  const tr = trackerOf(view._html);
  const g = trackerGroupOf(tr, 'W1001');
  assert.ok(g.includes('aria-expanded="true"') && g.includes('class="ptrk-lines"'), 'unfolded');
  const lines = g.split('<div class="prow">').slice(1);
  assert.equal(lines.length, 4, 'all four in-window lines of W1001, delivered included');
  assert.deepEqual(lines.map((r) => r.match(/unit-serial">([^<]+)</)[1]), ['150-4500', '21-422S', '30-750', '264-4086'], 'line ascending');
  assert.ok(!g.includes('wo-ref') && !g.includes('chip asset'), 'no W-number or asset chip on the lines');
  assert.ok(lines.every((r) => r.includes('href="#/wo/W1001"')), 'each line still links to the work order');
  assert.ok(lines[0].includes('<span class="chip warn">requested</span>'), 'requested → warn');
  assert.ok(lines[1].includes('<span class="chip hold">ordered</span>'), 'ordered → hold');
  assert.ok(lines[2].includes('<span class="chip rent">in transit</span>'), 'in transit → rent');
  assert.ok(lines[2].includes('href="https://www.ups.com/track?tracknum=1Z999AA10123456784"'), 'the D66 carrier + tracking chip');
  assert.ok(lines[3].includes('<span class="chip stock">stock</span>') && !/chip (warn|hold|rent)"/.test(lines[3]), 'a delivered stock line: stock chip, no state chip');
  assert.ok(!lines.some((r) => /chip age/.test(r)), 'no per-line age chip');
  assert.ok(!trackerGroupOf(tr, 'W1003').includes('🔩'), 'the other folds stay folded');
  // The LTL line on W1003 keeps its plain-text tracking, and the ticket chip rides the line.
  await fireOn('click', fakeTarget('[data-tracker-wo]', { dataset: { trackerWo: 'W1003' } }));
  await settle();
  const g3 = trackerGroupOf(trackerOf(view._html), 'W1003');
  assert.ok(g3.includes('<span class="chip track">LTL PRO 48213377</span>'), 'unknown carrier → plain text');
  assert.ok(g3.includes('href="#/ticket/S1002"'), 'the 🔧 ticket chip');
  // Tap again → folded.
  await fireOn('click', fakeTarget('[data-tracker-wo]', { dataset: { trackerWo: 'W1001' } }));
  await settle();
  assert.ok(!trackerGroupOf(trackerOf(view._html), 'W1001').includes('🔩'), 'a second tap folds it');
  setParts(false);
});

await check('D75: Delivered (30d) band — all-delivered work orders, newest first, "delivered <date>" in the header, CANCELLED never', async () => {
  const snap = await asFull('owner');
  setParts(false);
  app.__ui().showTracker = true; app.__ui().showPartsDelivered = true;
  app.__ui().trackerOpen = new Set(['W1004']);
  const tr = trackerOf(await renderRoute('#/'));
  const g = trackerGroupOf(tr, 'W1004');
  const w = snap.work_orders.find((x) => x.id === 'W1004');
  assert.ok(g.includes('>2 delivered<'), 'counts the delivered lines; the CANCELLED one is not a line here');
  const newest = w.parts.filter((p) => p.state === 'DELIVERED').map((p) => p.delivered).sort().pop();
  assert.ok(/<span class="chip ok">delivered [^<]+<\/span>\s*<\/div>/.test(g.slice(0, g.indexOf('ptrk-lines'))), `delivered ${newest} in the header, no age`);
  assert.ok(!g.includes('18-3310'), 'the CANCELLED line never draws');
  assert.ok(g.includes('tools.usps.com'), 'USPS links');
  assert.ok(!tr.includes('18-1150'), 'W1005 (40 days) stays out');
  setParts(false);
});

await check('D75: the tracker toggle is remembered for the session, on its own key', async () => {
  await asFull('owner');
  setParts(false);
  await renderRoute('#/');
  await fireOn('click', fakeTarget('[data-tracker-toggle]', {}));
  await settle();
  assert.equal(app.__ui().showTracker, true);
  assert.equal(app.__ui().showParts, false, 'the Work orders strip is untouched');
  assert.equal(sessionStorage.getItem('wss.tracker.open'), '1');
  assert.ok(trackerOf(view._html).includes('id="tracker-body"'));
  setParts(false);
  sessionStorage.removeItem('wss.tracker.open');
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

await check('D65/D75: empty Work orders strip and NO tracker on the legacy fixture (no work_orders key) and on the quiet one', async () => {
  for (const v of ['legacy', 'empty']) {
    window.location.href = `http://localhost:8787/?mock=${v}&role=owner`;
    window.location.search = `?mock=${v}&role=owner`;
    await app.__refresh();
    app.__ui().showParts = true; app.__ui().showTracker = true;
    const out = await renderRoute('#/');
    const st = partsStripOf(out);
    assert.ok(st.includes('>0 open<') && st.includes('parts-n zero'), `${v}: 0 open, quiet`);
    assert.ok(!st.includes('class="prow"'), `${v}: no rows`);
    assert.ok(st.includes('No open work orders.'), `${v}: says so`);
    assert.ok(!out.includes('Parts tracker'), `${v}: no lines anywhere → no tracker card at all`);
  }
  setParts(false);
  await asFull('owner');
});

await check('D65/D69: unit page — the chip when a work order is open, "Work order" when not, any role; no Inspect', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    const u = snap.units.find((x) => x.work_order === 'W1001');
    const wo = snap.work_orders.find((w) => w.id === 'W1001');
    const out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
    assert.ok(out.includes(`href="#/wo/W1001">🔧 W1001 · RETURN · 📋 pending · ${wo.parts_open} parts open · ${wo.hours_total} h<`), `${role}: the chip`);
    assert.ok(!out.includes('data-form="wo-open"'), `${role}: no second work order on the serial`);
    assert.ok(!out.includes('Inspect') && !out.includes('<h2>Inspections'), `${role}: the D67 Inspect button and list are gone`);
    const plain = snap.units.find((x) => !x.work_order && x.unit_state !== 'RETIRED');
    assert.ok((await renderRoute(`#/unit/${encodeURIComponent(plain.serial)}`)).includes('data-form="wo-open">Work order<'), `${role}: the button`);
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
  assert.equal(sheet.purpose, u.readiness === 'NEEDS-PREP' ? 'RETURN' : sheet.purpose);
  // A line with a description but no part # never leaves the phone.
  const msg = await submitWo({ verb: 'OPEN', serial: u.serial },
    { purpose: 'RETURN', note: '', p_mfr: ['OTHER'], p_num: [''], p_desc: ['valve'], p_qty: ['1'] }, true);
  assert.equal(posted.length, 0);
  assert.ok(msg.includes('part number'), 'it says why');
  await submitWo({ verb: 'OPEN', serial: u.serial }, {
    purpose: 'RETURN', note: 'rent-ready for Acme Foods',
    p_mfr: ['FACTORY-CAT', 'FACTORY-CAT', 'FACTORY-CAT'], p_num: ['150-4500', '21-422S', ''],
    p_desc: ['Solution valve 24V', 'Squeegee blade rear', ''], p_qty: ['1', '2', '1'],
  }, true);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], { action: 'work_order', serial: u.serial, payload: { action: 'OPEN', purpose: 'RETURN', note: 'rent-ready for Acme Foods',
    parts: [
      { manufacturer: 'FACTORY-CAT', part_number: '150-4500', description: 'Solution valve 24V', qty: 1 },
      { manufacturer: 'FACTORY-CAT', part_number: '21-422S', description: 'Squeegee blade rear', qty: 2 },
    ] } }, 'the blank third row is not a line');
  assert.ok(!JSON.stringify(posted[0]).match(/cost|rate|price/i), 'no money key is ever built');
  assert.equal(window.location.hash, `#/wo/new/${encodeURIComponent(u.serial)}`, 'D69: straight to the new work order — the sheet is waiting');
  const newOut = await renderRoute(window.location.hash);
  assert.ok(newOut.includes('PO <span>⏳ NEW</span>') && newOut.includes('not numbered yet'), 'drawn as NEW — never an invented W-number');
  assert.ok(newOut.includes('📋 Inspection ▾') && newOut.includes('data-ifield="readings.hours_key"'), 'the sheet, open and waiting');
  const unitOut = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(unitOut.includes(`href="#/wo/new/${encodeURIComponent(u.serial)}">⏳ New work order — sheet waiting<`), 'the unit page links to it');
  assert.ok(!unitOut.includes('data-form="wo-open"'), 'and offers no second OPEN');
  app.__ui().showParts = true;
  const st = partsStripOf(await renderRoute('#/'));
  assert.ok(st.includes(`⏳ NEW — ${u.asset_item} — Return — 2 parts — 📋 sheet waiting · numbered at the next run`), 'the synthetic card, keyed on the serial');
  assert.ok(st.includes(`href="#/wo/new/${encodeURIComponent(u.serial)}"`), 'and it opens the new work order');
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
      assert.ok(out.includes("Can't close yet — 3 part lines still open") && out.includes('inspection is still pending'), 'and says why — both');
    } else if (role === 'service') {
      assert.ok(!ordered, 'service is never offered Mark ordered');
      assert.ok(transit && delivered, 'service moves boxes: In transit + Delivered');
      assert.ok(!out.includes('data-sheet="wo-close"'), 'no Close for service');
    } else {
      assert.ok(!ordered && !transit && !delivered, 'sales moves no line');
      assert.ok(!out.includes('data-sheet="wo-close"'), 'no Close for sales');
    }
  }
  // D69: a labor-only work order with its sheet DONE has nothing holding it: the owner may close it.
  const snap = await asFull('owner');
  snap.work_orders.find((w) => w.id === 'W1002').parts = [];
  const pm = await renderRoute('#/wo/W1002');
  assert.ok(/data-sheet="wo-close" data-id="W1002">/.test(pm), 'labor-only + sheet DONE → Close enabled');
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
  await submitWo({ verb: 'LABOR', wo: 'W1001' }, { date: '2026-09-24', who: 'Zac', travel: '0', labor: '1.3', note: '' });
  assert.equal(posted.length, 1, '1.3 h is refused before the POST');
  await submitWo({ verb: 'LABOR', wo: 'W1001' }, { date: '2026-09-24', who: 'Zac', travel: '0', labor: '1.5', note: 'rebuild' });
  assert.deepEqual(posted[1].payload, { action: 'LABOR', work_order: 'W1001', date: '2026-09-24', who: 'Zac', hours: 1.5, kind: 'LABOR', note: 'rebuild' });
  const out = await renderRoute('#/wo/W1001');
  assert.ok(out.includes('⏳ 2 pending') && out.includes('line 1 → Ordered') && out.includes('1.5 h logged for Zac'), 'badged on payload.work_order');
  assert.ok(out.includes('⏳ → Ordered — applies at the next run') && !/data-id="W1001\|1\|ORDERED"/.test(out), 'the line waits, its buttons go');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

/* ----------------------------------- D70: service history + the catch --- */

await check('D70: the unit page draws Service history after Moves — closed WOs + fleet tickets, newest first, 5 then Show all', async () => {
  const snap = await asFull('owner');
  const w4 = snap.work_orders.find((w) => w.id === 'W1004');
  const u = snap.units.find((x) => x.serial === w4.serial);
  let out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  const at = out.indexOf('<h2>Service history');
  assert.ok(at > 0, 'the section draws');
  assert.ok(at < out.indexOf('<h2>Money</h2>'), 'before Money');
  const moves = out.indexOf('<h2>Moves</h2>');
  if (moves > 0) assert.ok(moves < at, 'after Moves');
  const sec = out.slice(at, out.indexOf('<h2>Money</h2>'));
  const ids = [...sec.matchAll(/href="#\/(wo|ticket)\/([A-Z]\d+)"/g)].map((m) => m[2]);
  const closedTk = snap.service_queue.find((t) => t.status === 'CLOSED' && t.serial === u.serial);
  assert.ok(closedTk, 'the mock gives this unit a closed fleet ticket');
  assert.deepEqual(ids, ['W1004', closedTk.ticket, 'W1005'], 'newest closed first: 5d, 26d, 40d');
  assert.ok(sec.includes('🔧 W1004') && sec.includes('Check-out') && sec.includes('2.75 h · Josh') && sec.includes('3 parts'), 'WO row anatomy');
  assert.ok(sec.includes('📋 ✓'), 'the sheet chip');
  assert.ok(sec.includes(`🎫 ${closedTk.ticket}`) && sec.includes('Field call'), 'ticket row: id + issue');
  assert.ok(sec.includes('Work orders a year back · tickets 90 days'), 'the caption');
  assert.ok(!sec.includes('Show all'), 'three rows: no Show all');
  assert.ok(!/\$\s?\d/.test(sec), 'no money in the history');
  // Pad it to seven: five rows + "Show all 7", then all seven.
  for (const [i, closed] of [[6, '2026-06-01'], [7, '2026-05-01'], [8, '2026-04-01'], [9, '2026-03-01']]) {
    snap.work_orders.push({ ...w4, id: `W10${i}0`, closed, labor: [], hours_total: 0, parts: [], ticket: null, note: null });
  }
  out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  let hist = out.slice(out.indexOf('<h2>Service history'), out.indexOf('<h2>Money</h2>'));
  assert.equal((hist.match(/class="drow hist-row"/g) || []).length, 5, 'first five');
  assert.ok(hist.includes('data-history-all="1">Show all 7<'), 'Show all N');
  await fireOn('click', fakeTarget('[data-history-all]'));
  await settle();
  hist = view._html.slice(view._html.indexOf('<h2>Service history'), view._html.indexOf('<h2>Money</h2>'));
  assert.equal((hist.match(/class="drow hist-row"/g) || []).length, 7, 'all seven');
  assert.ok(!hist.includes('Show all'));
  app.__ui().historyExpanded = false;
  await asFull('owner');
});

await check('D70: a unit with no closed records draws no Service history heading at all', async () => {
  const snap = await asFull('owner');
  const ids = new Set([...snap.work_orders.filter((w) => w.status === 'CLOSED').map((w) => String(w.serial)),
    ...snap.service_queue.filter((t) => t.status === 'CLOSED' && t.serial).map((t) => String(t.serial))]);
  const u = snap.units.find((x) => !ids.has(String(x.serial)));
  const out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('<h2>Money</h2>') && !out.includes('Service history'), 'nothing, not even an empty line');
});

await check('D70: + New ticket — a fleet serial typed on a customer ticket shows the nudge; the button flips it to Ours on that unit', async () => {
  const snap = await asFull('owner');
  const u = snap.units.find((x) => x.unit_state === 'ON-RENT' && x.customer);
  const fields = {
    machine_owner: { value: 'CUSTOMER' }, customer: { value: 'Acme Foods' }, equipment: { value: `Scrubber ${u.serial} Unit H6` },
    issue: { value: 'brakes drag' }, location: { value: 'AT-CUSTOMER' }, intake_move: { value: 'NONE' },
    return_move: { value: 'NONE' }, site: { value: 'x' },
  };
  const hint = { hidden: true, dataset: {}, innerHTML: '' };
  const serialSel = { value: '' };
  const tgButtons = [{ dataset: { val: 'CUSTOMER' }, classList: { toggle() {} } }, { dataset: { val: 'WSS' }, classList: { toggle() {} } }];
  const form = {
    dataset: { action: 'ticket_open' },
    querySelector: (q) => {
      const m = q.match(/^(?:input)?\[name="?([a-z_]+)"?\]$/);
      if (m && fields[m[1]]) return fields[m[1]];
      if (q === '[data-hint="fleet"]') return hint;
      if (q === 'select[name=serial]') return serialSel;
      if (q.startsWith('.toggle[data-toggle=')) return { querySelectorAll: () => tgButtons };
      return null;
    },
    querySelectorAll: () => [],
  };
  const typing = { closest: (q) => (q === 'form.write' ? form : null), name: 'equipment' };
  await fireOn('input', typing);
  assert.equal(hint.hidden, false, 'the hint shows');
  assert.ok(hint.innerHTML.includes(`⚠️ #${u.serial} is ours`) && hint.innerHTML.includes(`on rent to ${u.customer}`), 'names the unit and where it is');
  assert.ok(hint.innerHTML.includes(`data-fleet-switch="${u.serial}"`) && hint.innerHTML.includes("keep the machine's history and costs"));
  // The button: Ours (fleet), that unit selected, the rest of the form kept.
  const btn = { dataset: { fleetSwitch: u.serial }, closest: (q) => (q === '[data-fleet-switch]' ? btn : q === 'form' ? form : null) };
  await fireOn('click', btn);
  assert.equal(fields.machine_owner.value, 'WSS');
  assert.equal(serialSel.value, u.serial);
  assert.equal(fields.issue.value, 'brakes drag', 'issue kept');
  assert.equal(hint.hidden, true, 'WSS → the hint goes');
  // No match / short tokens → no hint. Never a gate: nothing here touches submit.
  fields.machine_owner.value = 'CUSTOMER';
  fields.equipment.value = 'XR 36 24V H6';
  await fireOn('input', typing);
  assert.equal(hint.hidden, true, 'no match, no hint');
});

/* ------------------------------------ D71: travel vs labor hours ------- */

await check('D71: + Log hours has Travel + Labor steppers — one event per non-zero, TRAVEL first; 0/0 never leaves', async () => {
  const { posted } = await apiAs({ name: 'Josh', role: 'service' });
  await renderRoute('#/wo/W1001');
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'wo-labor', id: 'W1001' } }));
  await settle();
  const sheet = view._html;
  assert.ok(sheet.includes('Travel (drive time)') && sheet.includes('Labor (on the machine)'), 'two steppers, labelled');
  assert.ok(/name="travel"[^>]*value="0"/.test(sheet) && /name="labor"[^>]*value="1"/.test(sheet), 'Travel 0 · Labor 1 by default');
  assert.ok(sheet.includes('The day the work happened.'), 'the Day field says what day it wants');
  assert.ok(sheet.indexOf('name="date"') < sheet.indexOf('name="travel"'), 'Day sits above the steppers');
  assert.ok(sheet.includes('the shop rate lives in the vault, not on the phone'), 'the footnote stays true');
  await submitWo({ verb: 'LABOR', wo: 'W1001' }, { date: '2026-09-25', who: 'Josh', travel: '0', labor: '0', note: '' });
  assert.equal(posted.length, 0, '0 / 0 is refused before any POST');
  assert.ok(view._html.includes('Put the hours in Travel, Labor, or both'), 'and says how to fix it');
  await submitWo({ verb: 'LABOR', wo: 'W1001' }, { date: '2026-09-25', who: 'Josh', travel: '0.5', labor: '1', note: 'brakes' });
  assert.equal(posted.length, 2, 'two events');
  assert.deepEqual(posted.map((e) => [e.payload.kind, e.payload.hours]), [['TRAVEL', 0.5], ['LABOR', 1]], 'TRAVEL first');
  for (const e of posted) {
    assert.equal(e.payload.date, '2026-09-25'); assert.equal(e.payload.who, 'Josh'); assert.equal(e.payload.note, 'brakes');
    assert.ok(!/cost|rate|price/i.test(JSON.stringify(e)), 'no money key');
  }
  await submitWo({ verb: 'LABOR', wo: 'W1001' }, { date: '2026-09-25', who: 'Josh', travel: '0.75', labor: '0', note: '' });
  assert.equal(posted.length, 3, 'travel only → one event');
  assert.equal(posted[2].payload.kind, 'TRAVEL');
  const out = await renderRoute('#/wo/W1001');
  assert.ok(out.includes('0.5 h travel logged for Josh') && out.includes('1 h logged for Josh'), 'both are ordinary pendings');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D71: the Labor card draws 🚚 / 🔧 before the hours and a travel suffix on the header', async () => {
  await asFull('owner');
  const out = await renderRoute('#/wo/W1004');
  assert.ok(out.includes('🚚 Travel') && out.includes('🔧 Labor'), 'a chip per row');
  assert.ok(/<h2>Labor · 2\.75 h · 0\.75 travel<\/h2>/.test(out), 'header: total + travel');
  const plain = await renderRoute('#/wo/W1002');
  assert.ok(/<h2>Labor · 1 h<\/h2>/.test(plain), 'no travel → no suffix');
  // A pre-D71 row (no kind) reads Labor.
  const w = app.__state().snapshot.work_orders.find((x) => x.id === 'W1002');
  delete w.labor[0].kind;
  assert.ok((await renderRoute('#/wo/W1002')).includes('🔧 Labor'), 'legacy row → Labor');
  await asFull('owner');
});

/* ------------------------------------------- D68: use from stock ------- */

/** The one `.drow wo-part` block for a line on a rendered WO page. */
const partRowOf = (out, line) => {
  const blocks = out.split('<div class="drow wo-part').slice(1);
  return blocks.find((b) => b.includes(`<span class="wo-ln">${line}</span>`)) || '';
};

await check('D68: a stock line on the WO page reads "stock", dashes the order trail, no carrier link — open, closed and pending', async () => {
  const snap = await asFull('owner');
  const w1 = snap.work_orders.find((w) => w.id === 'W1001');
  const stock = w1.parts.find((p) => p.source === 'SHOP-STOCK');
  assert.ok(stock && stock.state === 'DELIVERED' && !stock.ordered && !stock.vendor, 'fixture: a stock line, born DELIVERED, no PO trail');
  // 1 — on an OPEN work order
  const out = await renderRoute('#/wo/W1001');
  const row = partRowOf(out, stock.line);
  assert.ok(row.includes('<span class="chip stock">stock</span>'), 'the state chip reads stock');
  assert.ok(!row.includes('>Delivered<'), 'not "Delivered"');
  assert.ok(row.includes('ordered — · vendor — · tracking —'), 'the order trail is dashes');
  assert.ok(row.includes('<span class="chip ok">delivered '), 'the delivered date shows');
  assert.ok(!/ups\.com|fedex\.com|usps\.com/.test(row), 'never a carrier link');
  assert.ok(!row.includes('data-sheet="wo-part"'), 'a stock line offers no buttons');
  // Close is still held by the vendor lines — stock never was in the way.
  assert.ok(/data-sheet="wo-close" data-id="W1001" disabled/.test(out));
  // 2 — on a CLOSED work order
  const closed = await renderRoute('#/wo/W1004');
  const w4 = snap.work_orders.find((w) => w.id === 'W1004');
  const cs = w4.parts.find((p) => p.source === 'SHOP-STOCK' && p.state === 'DELIVERED');
  const crow = partRowOf(closed, cs.line);
  assert.ok(crow.includes('<span class="chip stock">stock</span>') && crow.includes('ordered — · vendor — · tracking —'));
  const cancelled = partRowOf(closed, w4.parts.find((p) => p.state === 'CANCELLED').line);
  assert.ok(cancelled.includes('>Cancelled<') && !cancelled.includes('chip stock'), 'a cancelled line still reads Cancelled');
  const vend = partRowOf(closed, w4.parts.find((p) => p.source === 'VENDOR' && p.state === 'DELIVERED').line);
  assert.ok(vend.includes('>Delivered<') && vend.includes('tools.usps.com'), 'a vendor delivery keeps its trail + link');
  // 3 — a pending pull on a REQUESTED line (the D67c pattern: badge + undo)
  const req = w1.parts.find((p) => p.state === 'REQUESTED');
  const pull = { id: '2026-09-25T12:00:00.000Z:zz1', ts: '2026-09-25T12:00:00.000Z', actor: 'Zac', role: 'service', action: 'work_order', serial: null,
    payload: { action: 'PART-STATE', work_order: 'W1001', line: req.line, source: 'SHOP-STOCK', note: 'bin A3' } };
  await apiAs({ name: 'Zac', role: 'service' }, [pull]);
  const pend = await renderRoute('#/wo/W1001');
  const prow = partRowOf(pend, req.line);
  assert.ok(prow.includes('⏳ → from stock — applies at the next run'), 'the line waits, saying where it is going');
  assert.ok(!prow.includes('data-sheet="wo-part"'), 'its buttons go while it waits');
  assert.ok(pend.includes(`line ${req.line} → from stock — by Zac`) && pend.includes('>Undo<'), 'badged, with Undo for the tapper');
  assert.ok(!MONEY_RE.test(pend), 'no money');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D68/D75: the tracker — a stock line draws the stock chip, no PO trail, no carrier link; W1005 stays out', async () => {
  const snap = await asFull('owner');
  setParts(false);
  app.__ui().showTracker = true; app.__ui().showPartsDelivered = false;
  app.__ui().trackerOpen = new Set(['W1001', 'W1004']);
  const folded = trackerOf(await renderRoute('#/'));
  assert.ok(!folded.includes('18-2204'), 'W1004 (all delivered) sits in the folded Delivered (30d) band');
  app.__ui().showPartsDelivered = true;
  const st = trackerOf(await renderRoute('#/'));
  const rowsOf = (pn) => st.split('<div class="prow">').slice(1).filter((b) => b.includes(`>${pn}</span>`));
  for (const pn of ['264-4086', '18-2204']) {
    const [r] = rowsOf(pn);
    assert.ok(r, `${pn} is in the tracker`);
    assert.ok(r.includes('<span class="chip stock">stock</span>') && r.includes('ordered — · vendor — · tracking —'), `${pn}: stock chip, dashed trail`);
    assert.ok(r.includes('delivered '), `${pn}: the delivered date`);
    assert.ok(!/ups\.com|fedex\.com|usps\.com/.test(r), `${pn}: no carrier link`);
  }
  assert.equal(snap.work_order_summary.delivered_30d, snap.work_orders.flatMap((w) => w.parts)
    .filter((p) => p.state === 'DELIVERED' && p.delivered_age_days <= 30).length,
    'delivered_30d counts stock lines (and only the last 30 days — D70)');
  // D70: W1005's 40-day-old box is in the snapshot (a year of closed WOs) but not in the tracker.
  assert.ok(snap.work_orders.some((w) => w.id === 'W1005'), 'the mock ships a CLOSED work order older than 30 days');
  assert.equal(rowsOf('18-1150').length, 0, 'a 40-day-old delivery stays out of Delivered (30d)');
  assert.ok((await renderRoute('#/wo/W1005')).includes('18-1150'), 'the WO page still shows every line');
  assert.ok(!MONEY_RE.test(st), 'no money in the tracker');
  setParts(false);
});

await check('D68: "Use from stock" by role — owner + service on REQUESTED lines only, never sales, never once ordered', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    const w1 = snap.work_orders.find((w) => w.id === 'W1001');
    const out = await renderRoute('#/wo/W1001');
    for (const p of w1.parts) {
      const has = out.includes(`data-id="W1001|${p.line}|SHOP-STOCK">Use from stock<`);
      const want = p.state === 'REQUESTED' && (role === 'owner' || role === 'service');
      assert.equal(has, want, `${role} · line ${p.line} ${p.state}: ${want ? 'offered' : 'not offered'}`);
    }
    if (role === 'owner') {
      const r1 = partRowOf(out, w1.parts.find((p) => p.state === 'REQUESTED').line);
      const order = ['>Mark ordered<', '>Use from stock<', '>Cancel line<'].map((t) => r1.indexOf(t));
      assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'owner: Mark ordered · Use from stock · Cancel line');
    }
  }
  await asFull('owner');
});

await check('D68: the Use-from-stock sheet — one confirm line, optional note, posts {work_order, line, source} with no state', async () => {
  const { posted } = await apiAs({ name: 'Zac', role: 'service' });
  const w1 = app.__state().snapshot.work_orders.find((w) => w.id === 'W1001');
  const req = w1.parts.find((p) => p.state === 'REQUESTED');
  await renderRoute('#/wo/W1001');
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'wo-part', id: `W1001|${req.line}|SHOP-STOCK` } }));
  await settle();
  assert.ok(view._html.includes(`Pulled <strong>${req.part_number}</strong> ×${req.qty} from the shelf?`), 'the confirm line names the part');
  assert.ok(!view._html.includes('name="vendor"') && !view._html.includes('id="wp-date"'), 'no vendor, no date');
  await submitWo({ verb: 'PART-STATE', wo: 'W1001', line: String(req.line), state: 'SHOP-STOCK' }, { note: '' });
  assert.deepEqual(posted[0], { action: 'work_order', serial: null,
    payload: { action: 'PART-STATE', work_order: 'W1001', line: req.line, source: 'SHOP-STOCK', note: null } });
  const out = await renderRoute('#/wo/W1001');
  assert.ok(out.includes('⏳ 1 pending') && out.includes('→ from stock'), 'pending badge');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D68: the line sheet — Order · Stock per row, default Order; Stock rows post source SHOP-STOCK, Order rows post none', async () => {
  const snap = await asFull('service');
  const u = snap.units.find((x) => !x.work_order && x.unit_state !== 'RETIRED');
  const { posted } = await apiAs({ name: 'Zac', role: 'service' });
  // The editor: every row starts on Order, and the helper copy is hidden until a row is Stock.
  await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
  const mount = { innerHTML: '' };
  nodes['#write-form'] = mount;
  try {
    await fireOn('click', fakeTarget('[data-form]', { dataset: { form: 'wo-open' } }));
  } finally { delete nodes['#write-form']; }
  const sheet = mount.innerHTML;
  assert.ok(sheet.includes('<button type="button" class="tg on" data-wo-src="VENDOR">Order</button>'), 'Order is lit by default');
  assert.ok(sheet.includes('data-wo-src="SHOP-STOCK">Stock</button>') && sheet.includes('name="p_src" value="VENDOR"'));
  assert.ok(sheet.includes('data-stock-note hidden>Stock lines are delivered now — nothing to order.<'), 'helper copy, hidden until a Stock row');
  // The tap: sets that row's hidden input, lights the button, shows the copy.
  const input = { value: 'VENDOR' };
  const btns = [{ dataset: { woSrc: 'VENDOR' }, classList: { on: true, toggle(c, v) { this.on = v; } } }];
  const note = { hidden: true };
  const row = { querySelector: (q) => (q === '[name=p_src]' ? input : null), querySelectorAll: () => btns };
  const form = { querySelector: (q) => (q === '[data-stock-note]' ? note : null), querySelectorAll: () => [input] };
  const tap = { dataset: { woSrc: 'SHOP-STOCK' }, classList: { on: false, toggle(c, v) { this.on = v; } } };
  btns.push(tap);
  tap.closest = (q) => (q === '[data-wo-src]' ? tap : q === '.wo-line' ? row : q === 'form' ? form : null);
  await fireOn('click', tap);
  assert.equal(input.value, 'SHOP-STOCK', 'the row now posts stock');
  assert.ok(tap.classList.on && !btns[0].classList.on, 'Stock lit, Order dark');
  assert.equal(note.hidden, false, 'the copy shows');
  // OPEN: one Stock row, one Order row.
  await submitWo({ verb: 'OPEN', serial: u.serial }, {
    purpose: 'REPAIR', note: '', p_mfr: ['FACTORY-CAT', 'FACTORY-CAT'], p_num: ['264-4086', '150-4500'],
    p_desc: ['Filter', 'Solution valve'], p_qty: ['1', '1'], p_src: ['SHOP-STOCK', 'VENDOR'],
  }, true);
  assert.deepEqual(posted[0].payload.parts, [
    { manufacturer: 'FACTORY-CAT', part_number: '264-4086', description: 'Filter', qty: 1, source: 'SHOP-STOCK' },
    { manufacturer: 'FACTORY-CAT', part_number: '150-4500', description: 'Solution valve', qty: 1 },
  ]);
  // ADD-PARTS: same rows, same rule.
  await submitWo({ verb: 'ADD-PARTS', wo: 'W1001' }, { p_mfr: ['KODIAK'], p_num: ['21-422S'], p_desc: [''], p_qty: ['2'], p_src: ['SHOP-STOCK'] });
  assert.deepEqual(posted[1].payload, { action: 'ADD-PARTS', work_order: 'W1001',
    parts: [{ manufacturer: 'KODIAK', part_number: '21-422S', description: null, qty: 2, source: 'SHOP-STOCK' }] });
  assert.ok(!posted.some((b) => /"(cost|rate|price)"/i.test(JSON.stringify(b)) || MONEY_RE.test(JSON.stringify(b))), 'money gate: nothing built carries money');
  assert.ok((await renderRoute('#/wo/W1001')).includes('1 part added (1 from stock)'), 'the pending row says so');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D68: money gate on the new fixtures — no money key or figure on any stock line, any role', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    const stock = snap.work_orders.flatMap((w) => w.parts).filter((p) => p.source === 'SHOP-STOCK');
    assert.ok(stock.length >= 2, 'fixture carries stock lines');
    const text = JSON.stringify(snap.work_orders);
    assert.ok(!/"(cost|cost_source_inv|rate|price)"/.test(text) && !MONEY_RE.test(text), `${role}: no money`);
    for (const id of ['W1001', 'W1004']) assert.ok(!MONEY_RE.test(await renderRoute(`#/wo/${id}`)), `${role} ${id}: rendered page carries no figure`);
  }
  await asFull('owner');
});

await check('D69: ticket detail carries a read-only 🔧 W · 📋 chip for the work orders on it', async () => {
  const snap = await asFull('service');
  const w = snap.work_orders.find((x) => x.ticket);
  let out = await renderRoute(`#/ticket/${w.ticket}`);
  assert.ok(out.includes(`<a class="chip wo" href="#/wo/${w.id}">🔧 ${w.id} · 📋 skipped</a>`), 'W1003 skipped its sheet');
  w.inspection = { ...w.inspection, status: 'DONE', flags: 2, skipped_reason: null };
  out = await renderRoute(`#/ticket/${w.ticket}`);
  assert.ok(out.includes(`<a class="chip wo" href="#/wo/${w.id}">🔧 ${w.id} · 📋 2 ⚑</a>`), 'a DONE sheet: 📋 2 ⚑ (was 📋 I1001)');
  assert.ok(!out.includes('#/inspection/'), 'no I-number link anywhere');
  const plain = snap.service_queue.find((t) => !t.serial || !(snap.units.find((u) => u.serial === t.serial) || {}).work_order);
  assert.ok(!(await renderRoute(`#/ticket/${plain.ticket}`)).includes('class="chip wo"'));
  await asFull('owner');
});

await check('D65: the mock itself carries no money key on any work order; D70: W1005 (closed 40d) ships inside the 365-day window', async () => {
  const snap = await asFull('owner');
  const text = JSON.stringify(snap.work_orders);
  assert.ok(!/"(cost|cost_source_inv|rate|price)"/.test(text), 'no money key');
  assert.ok(!MONEY_RE.test(text), 'no figure');
  assert.ok(snap.work_orders.some((w) => w.id === 'W1005' && w.status === 'CLOSED'), 'D70: CLOSED ships a year');
  assert.equal(snap.work_order_summary.closed_window_days, 365);
  assert.ok(snap.work_orders.every((w) => w.status !== 'CLOSED' || w.age_days === null), 'age_days is null once CLOSED');
});

/* ------------------------------- D69: the inspection sheet ON the work order */

const resetSheets = () => { app.__sheetLocal().clear(); app.__ui().form = null; app.__ui().sheetCard.clear(); };
const fieldTarget = (ifield, value, tag = 'INPUT') => {
  const node = { dataset: { ifield }, value, tagName: tag, classList: { add() {}, remove() {} } };
  node.closest = (q) => (q === '[data-ifield]' ? node : null);
  return node;
};
const tapSeg = (id, val) => fireOn('click', fakeTarget('[data-iseg]', { dataset: { iseg: id, val } }));
const { fmtMD: FMT_MD } = await import('../docs/dates.js');
/** The 📋 card on a rendered work-order page. */
const sheetCardOf = (out) => {
  const i = out.indexOf('<section class="sheet-card');
  return i < 0 ? '' : out.slice(i, out.indexOf('</section>', i) + 10);
};

/** A fake Worker for the sheet's saves: POSTs are stored and echoed; DELETE answers delStatus(id). */
async function apiInsp(me, extraPending = [], { delStatus = () => 200, mutate = null } = {}) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  if (mutate) mutate(snapshot);
  const posted = [];
  const deleted = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    // A DELETE takes an event out of the inbox, as the Worker does — so a re-read after an undo is honest.
    if (u.endsWith('/api/data')) return { ok: true, status: 200, json: async () => ({ me, snapshot, pending: extraPending.filter((e) => !deleted.includes(e.id)) }) };
    if (u.endsWith('/api/event') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posted.push(body);
      n++;
      const ts = `2026-09-27T12:00:${String(n).padStart(2, '0')}.000Z`;
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
/** Submit any form.write the way the page does. `checks` answers querySelector('[name=x]') with {checked}. */
async function submitForm(dataset, fields, checks = {}) {
  const form = { dataset, querySelector: (q) => {
    if (q === 'button[type=submit]') return { disabled: false };
    const m = /^\[name=(\w+)\]$/.exec(q);
    return m && m[1] in checks ? { checked: checks[m[1]] } : null;
  } };
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
/** A pending event, as the Worker stores it. */
const evt = (id, ts, actor, role, serial, payload) => ({ id, ts, actor, role, action: 'work_order', serial, payload });
const newUnitOf = (snap) => snap.units.find((x) => !x.work_order && x.unit_state === 'IN-SHOP')
  || snap.units.find((x) => !x.work_order && x.unit_state !== 'RETIRED');

await check('D69: no 📋 Inspections strip on any fixture; the old sheet route lands on the board', async () => {
  for (const v of ['full', 'empty', 'legacy']) {
    window.location.href = `http://localhost:8787/?mock=${v}&role=owner`;
    window.location.search = `?mock=${v}&role=owner`;
    await app.__refresh();
    const out = await renderRoute('#/');
    assert.ok(!out.includes('📋 Inspections') && !out.includes('insp-strip') && !out.includes('data-insp-toggle'), `${v}: no D67 strip`);
    const snap = app.__state().snapshot;
    assert.ok(!('inspections' in snap) && !('inspection_summary' in snap), `${v}: the retired keys are not in the mock`);
    assert.ok(snap.units.every((u) => !('inspection_draft' in u)), `${v}: no unit carries inspection_draft`);
  }
  await asFull('owner');
  await renderRoute('#/inspection/I1001');
  assert.equal(window.location.hash, '#/', '#/inspection/<I> redirects to the board');
});

await check('D69: the strip goes amber from a sheet PENDING ≥ 2 days even with no stale part, and not at 1 day', async () => {
  const snap = await asFull('owner');
  app.__ui().showParts = false;
  // Take every REQUESTED line out so only the sheet can tone it.
  for (const w of snap.work_orders) w.parts = w.parts.filter((p) => p.state !== 'REQUESTED');
  let st = partsStripOf(await renderRoute('#/'));
  assert.ok(/parts-n amber/.test(st), 'W1001 PENDING for 3 days → amber');
  snap.work_orders.find((w) => w.id === 'W1001').age_days = 1;
  st = partsStripOf(await renderRoute('#/'));
  assert.ok(!/parts-n (amber|red)/.test(st), 'one day PENDING — quiet');
  await asFull('owner');
});

await check('D69: unit page — Last inspection line (tap → the WO), the hours header, no Inspect; a pre-D69 unit has neither', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    const u = snap.units.find((x) => x.last_inspection && x.last_inspection.work_order === 'W1002');
    const out = await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
    assert.ok(out.includes(`<div class="s hours-line">961.5 h · as of ${FMT_MD(u.hours_as_of)}</div>`), `${role}: the meter in the header`);
    assert.ok(out.includes(`href="#/wo/W1002">`) && out.includes(`Last inspection</span> PM · ${FMT_MD(u.last_inspection.done)} · Zac · 961.5 h · 2 ⚑ · W1002`), `${role}: the line`);
    const closed = snap.units.find((x) => x.last_inspection && x.last_inspection.work_order === 'W1004');
    const cout = await renderRoute(`#/unit/${encodeURIComponent(closed.serial)}`);
    assert.ok(cout.includes(`Last inspection</span> Check-out · ${FMT_MD(closed.last_inspection.done)} · Josh · 412.5 h · 2 ⚑ · W1004`), `${role}: a closed CHECKOUT`);
    assert.ok(!cout.includes('Inspect<'), `${role}: no Inspect button`);
  }
  const snap = await asFull('service');
  const bare = snap.units.find((u) => !u.last_inspection && !u.hours && u.unit_state !== 'RETIRED');
  const out = await renderRoute(`#/unit/${encodeURIComponent(bare.serial)}`);
  assert.ok(!out.includes('hours-line') && !out.includes('Last inspection'), 'no meter, no line');
  await asFull('owner');
});

await check('D69: the OPEN sheet — purpose picker Check-out · Return · PM · Repair · Other, defaulted from readiness', async () => {
  const snap = await asFull('service');
  const want = { 'NEEDS-PREP': 'RETURN', DOWN: 'REPAIR', READY: 'CHECKOUT' };
  const cases = [
    snap.units.find((u) => !u.work_order && u.unit_state === 'IN-SHOP' && u.readiness === 'NEEDS-PREP'),
    snap.units.find((u) => !u.work_order && u.unit_state === 'IN-SHOP' && u.readiness === 'DOWN'),
    snap.units.find((u) => !u.work_order && u.unit_state === 'AVAILABLE' && u.readiness === 'READY'),
    snap.units.find((u) => !u.work_order && u.unit_state === 'ON-RENT'),
  ].filter(Boolean);
  assert.ok(cases.length >= 3, 'the fixture has the cases');
  for (const u of cases) {
    await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`);
    const mount = { innerHTML: '' };
    nodes['#write-form'] = mount;
    try { await fireOn('click', fakeTarget('[data-form]', { dataset: { form: 'wo-open' } })); } finally { delete nodes['#write-form']; }
    const sheet = mount.innerHTML;
    const labels = [...sheet.matchAll(/data-toggle="purpose"|class="tg[^"]*" data-val="([A-Z-]+)"/g)].map((m) => m[1]).filter(Boolean);
    assert.deepEqual(labels.slice(0, 5), ['CHECKOUT', 'RETURN', 'PM', 'REPAIR', 'OTHER'], 'the five, in order');
    const def = u.unit_state === 'ON-RENT' ? 'REPAIR' : want[u.readiness];
    assert.ok(new RegExp(`class="tg on" data-val="${def}"`).test(sheet), `${u.readiness}/${u.unit_state} → ${def}`);
    assert.equal(sheet.includes('out on rent'), u.unit_state === 'ON-RENT', 'the wrong-unit guard shows on an ON-RENT unit only');
    assert.ok(!sheet.includes('RENT-READY'), 'RENT-READY is not offered');
  }
  await asFull('owner');
});

await check('D69: #/wo — PENDING sheet expanded, DONE and SKIPPED folded with their pill; a tap unfolds', async () => {
  await asFull('owner');
  resetSheets();
  const p = sheetCardOf(await renderRoute('#/wo/W1001'));
  assert.ok(p.includes('📋 Inspection ▾') && p.includes('>PENDING</span>') && p.includes('data-ifield="readings.hours_key"'), 'W1001: open, PENDING');
  const out1 = await renderRoute('#/wo/W1001');
  const card = out1.indexOf('<section class="sheet-card'); const head = out1.indexOf('po-big'); const parts = out1.indexOf('<h2>Parts');
  assert.ok(head < card && card < parts, 'between the header and Parts');
  const d = sheetCardOf(await renderRoute('#/wo/W1002'));
  assert.ok(d.includes('📋 Inspection ▸') && !d.includes('data-ifield='), 'W1002: folded');
  assert.ok(/DONE · Zac · \d+\/\d+ · 2 ⚑/.test(d), 'the DONE pill: tech · date · flags');
  const sk = sheetCardOf(await renderRoute('#/wo/W1003'));
  assert.ok(sk.includes('SKIPPED · Josh: drive motor only'), 'the SKIPPED pill carries the reason');
  await renderRoute('#/wo/W1002');
  await fireOn('click', fakeTarget('[data-sheet-card]', { dataset: { sheetCard: 'W1002' } }));
  await settle();
  const open = sheetCardOf(view._html);
  assert.ok(open.includes('📋 Inspection ▾') && open.includes('data-iseg="ctl.drive_forward"'), 'a tap unfolds it, read-only');
  assert.ok([...open.matchAll(/data-(ifield|iseg)="[^"]*"[^>]*>/g)].every((m) => / disabled>$/.test(m[0])), 'every control disabled');
  resetSheets();
});

await check('D69: the sheet renders FROM the checklist on the work order — library order, filtered for the machine', async () => {
  const snap = await asFull('service');
  resetSheets();
  const out = await renderRoute('#/wo/W1001');
  const lib = snap.inspection_checklist.sections;
  const titles = lib.map((s) => s.title).filter((t) => out.includes(`<h3>${t.replace(/&/g, '&amp;')} <span class="count">`));
  assert.deepEqual(titles, ['Batteries', 'Check operation & condition of', 'Scrub deck & squeegee'], 'library order, scrubber sees the deck');
  assert.ok(out.includes('data-iseg="ctl.estop"') && !out.includes('data-iseg="ctl.main_broom_ctl"'), 'class filter');
  assert.ok(!out.includes('data-iseg="ctl.horn"'), 'walk-behind: no horn');
  assert.ok(out.includes('data-iseg="bat.watering"'), 'WET: the watering row');
  assert.ok(!out.includes('data-iseg="bat.old_gauge"'), 'a retired row stays off a sheet that never answered it');
  assert.ok(out.includes('data-ifield="readings.brush1_pct"') && !out.includes('readings.main_broom_pct'), 'readings follow the class');
  assert.ok(/<input type="number" inputmode="numeric" pattern="\[0-9\]\*" step="1" min="0" max="100" data-ifield="readings.brush1_pct"/.test(out), 'a numeric-keypad percent field');
  assert.ok(out.includes('<span>Body style</span>') && !out.includes('data-ifield="kind"'), 'no kind dropdown — purpose is the work order\'s');
  // D74: four meters, the Scrub head toggle on a scrubber, brush rows while the head is unset.
  assert.ok(out.includes('data-ifield="readings.hours_vac"'), 'vac motor hours is a meter field');
  assert.ok(out.includes('data-ihead="BRUSH"') && out.includes('data-ihead="PAD"'), 'scrub head toggle on a scrubber');
  assert.ok(!out.includes('data-ipad='), 'no pad block until the head is PAD');
  await fireOn('click', fakeTarget('[data-ihead]', { dataset: { ihead: 'PAD' } }));
  let pad = await renderRoute('#/wo/W1001');
  assert.ok(!pad.includes('data-ifield="readings.brush1_pct"') && !pad.includes('data-irot='), 'PAD hides the brush rows + rotated');
  assert.ok(['pad_drivers_needed', 'pad_holders_needed', 'pads_needed'].every((k) => pad.includes(`data-ipad="${k}"`)), 'the three needs');
  assert.ok(!pad.includes('readings.pad_diameter'), 'no diameter until Pads is lit');
  await fireOn('click', fakeTarget('[data-ipad]', { dataset: { ipad: 'pads_needed' } }));
  pad = await renderRoute('#/wo/W1001');
  assert.ok(/<input type="number" inputmode="decimal" step="any" min="0" max="60" data-ifield="readings.pad_diameter"/.test(pad), 'diameter is a real input, not escaped markup');
  assert.ok(/<input type="text" maxlength="20" autocomplete="off" placeholder="red" data-ifield="readings.pad_color"/.test(pad), 'color is a real input');
  assert.ok(!pad.includes('&lt;input'), 'no escaped markup anywhere on the sheet');
  await fireOn('click', fakeTarget('[data-ihead]', { dataset: { ihead: 'PAD' } }));   // tap the lit one → unset
  pad = await renderRoute('#/wo/W1001');
  assert.ok(pad.includes('data-ifield="readings.brush1_pct"') && !pad.includes('data-ipad='), 'unset head brings the brush rows back');
  resetSheets();
  assert.ok(out.includes('<span class="count">3/4 answered</span>'), 'Batteries: 3 of 4');
  assert.ok(/data-iseg="deck.curtains" data-val="REPLACE"/.test(out) && !/data-iseg="deck.curtains" data-val="REPAIR"/.test(out));
  // A DONE sheet that carries the retired row still draws it.
  app.__ui().sheetCard.set('W1002', true);
  assert.ok((await renderRoute('#/wo/W1002')).includes('Analog charge gauge (retired)'));
  resetSheets();
});

await check('D69: switching body style keeps every answer; the WET cell grid follows voltage and pack', async () => {
  await asFull('service');
  resetSheets();
  await renderRoute('#/wo/W1001');
  await tapSeg('ctl.key_switch', 'REPAIR');
  await fireOn('change', fieldTarget('body_style', 'RIDER', 'SELECT'));
  await settle();
  let out = view._html;
  assert.ok(out.includes('data-iseg="ctl.horn"') && out.includes('data-iseg="ctl.key_switch" data-val="REPAIR" aria-pressed="true"'));
  assert.ok(out.includes('data-iseg="deck.curtains" data-val="WORN" aria-pressed="true"'), 'the engine’s answers too');
  resetSheets();
  out = await renderRoute('#/wo/W1001');
  const rows = (o) => [...o.matchAll(/class="cell-r"/g)].length;
  const groups = (o) => [...o.matchAll(/class="cell-gh">Battery \d/g)].length;
  assert.equal(rows(out), 12, '24V: 12 cells');
  assert.equal(groups(out), 4, '4 × 6V');
  await fireOn('change', fieldTarget('battery.pack', '2x12V', 'SELECT'));
  await settle();
  assert.equal(groups(view._html), 2, '2 × 12V');
  await fireOn('change', fieldTarget('battery.type', 'AGM', 'SELECT'));
  await settle();
  assert.equal(rows(view._html), 0, 'AGM: no grid');
  resetSheets();
});

await check('D69: Done is disabled until an hours field has a value; No inspection is always offered on a PENDING sheet', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    await asFull(role);
    resetSheets();
    let out = await renderRoute('#/wo/W1001');
    assert.ok(/data-sheet="insp-done" data-id="W1001" disabled>Done</.test(out), `${role}: no hours: disabled`);
    assert.ok(out.includes('data-sheet="insp-skip" data-id="W1001">No inspection<'), `${role}: No inspection`);
    await fireOn('input', fieldTarget('readings.hours_traction', '88.5'));
    out = await renderRoute('#/wo/W1001');
    assert.ok(/data-sheet="insp-done" data-id="W1001">Done</.test(out), `${role}: traction hours count`);
  }
  resetSheets();
  await asFull('owner');
});

await check('D69: No inspection needs a reason — a blank one never leaves the phone; a real one posts SKIP by W-number', async () => {
  const { posted } = await apiInsp({ name: 'Zac', role: 'service' });
  await renderRoute('#/wo/W1001');
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'insp-skip', id: 'W1001' } }));
  await settle();
  assert.ok(view._html.includes('Why no inspection?') && view._html.includes('name="reason" maxlength="120" required'), 'the one-line reason');
  await submitForm({ action: 'work_order', verb: 'INSPECT', step: 'SKIP', key: 'W1001', wo: 'W1001' }, { reason: '   ' });
  assert.equal(posted.length, 0, 'blank → refused before the POST');
  assert.ok(view._html.includes('Say why there is no inspection'), 'and says so');
  await submitForm({ action: 'work_order', verb: 'INSPECT', step: 'SKIP', key: 'W1001', wo: 'W1001' }, { reason: 'gasket only — inspected last week' });
  assert.deepEqual(posted[0], { action: 'work_order', serial: null, payload: { action: 'INSPECT', step: 'SKIP', work_order: 'W1001', reason: 'gasket only — inspected last week' } });
  const out = await renderRoute('#/wo/W1001');
  assert.ok(out.includes('⏳ NO INSPECTION — at the next run') && out.includes('no inspection — gasket only'), 'pending, badged');
  assert.ok(!out.includes('id="insp-status"') && !out.includes('data-sheet="insp-done"'), 'the sheet locks');
  await leaveApi();
});

await check('D69: flagged rows tint and grow + part — it opens + Add parts with the row label as the description', async () => {
  const { posted } = await apiInsp({ name: 'Zac', role: 'service' });
  app.__ui().sheetCard.set('W1002', true);
  let out = await renderRoute('#/wo/W1002');
  assert.equal([...sheetCardOf(out).matchAll(/class="irow flag"/g)].length, 2, 'two flags, two tinted rows');
  assert.ok(out.includes('data-sheet="wo-add" data-id="W1002" data-desc="Battery charger">+ part<'), '+ part on a flagged row');
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'wo-add', id: 'W1002', desc: 'Battery charger' } }));
  await settle();
  out = view._html;
  assert.ok(out.includes('For the flagged row: <strong>Battery charger</strong>'));
  assert.ok(out.includes('aria-label="Description" value="Battery charger"'), 'the description is prefilled');
  await submitForm({ action: 'work_order', verb: 'ADD-PARTS', wo: 'W1002' }, { p_mfr: ['OTHER'], p_num: ['CHG-2436'], p_desc: ['Battery charger'], p_qty: ['1'], p_src: ['VENDOR'] });
  assert.deepEqual(posted[0].payload, { action: 'ADD-PARTS', work_order: 'W1002', parts: [{ manufacturer: 'OTHER', part_number: 'CHG-2436', description: 'Battery charger', qty: 1 }] });
  // A fresh flag on the PENDING sheet grows one at once.
  await renderRoute('#/wo/W1001');
  await tapSeg('sqg.blades', 'REPAIR');
  assert.ok(view._html.includes('data-desc="Check and rotate blades as needed">+ part<'), 'a fresh flag grows + part');
  await leaveApi();
});

await check('D69: Close — disabled with the reason (lines vs sheet); the sheet has ☑ Mark READY, on by default, hidden when out', async () => {
  let snap = await asFull('owner');
  let out = await renderRoute('#/wo/W1002');
  assert.ok(/data-sheet="wo-close" data-id="W1002" disabled/.test(out), 'a REQUESTED line holds W1002');
  assert.ok(out.includes('<div class="form-note close-why">Can\'t close yet — 1 part line still open — deliver or cancel it.</div>'), 'the line, not the sheet');
  snap.work_orders.find((w) => w.id === 'W1002').parts[0].state = 'DELIVERED';
  out = await renderRoute('#/wo/W1002');
  assert.ok(/data-sheet="wo-close" data-id="W1002">/.test(out) && !out.includes("Can't close yet"), 'settled + DONE → enabled');
  const w1 = snap.work_orders.find((w) => w.id === 'W1001');
  w1.parts = w1.parts.map((p) => ({ ...p, state: 'DELIVERED' }));
  out = await renderRoute('#/wo/W1001');
  assert.ok(out.includes('<div class="form-note close-why">Can\'t close yet — the inspection is still pending — Done it, or No inspection with a reason.</div>'), 'the sheet, not the lines');
  // The close sheet.
  await renderRoute('#/wo/W1002');
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'wo-close', id: 'W1002' } }));
  await settle();
  assert.ok(/<input type="checkbox" name="ready" value="1" checked>\s*Mark READY/.test(view._html), 'Mark READY, checked');
  // The same work order on a unit that is out: no box.
  snap = app.__state().snapshot;
  const u2 = snap.units.find((u) => u.serial === snap.work_orders.find((w) => w.id === 'W1002').serial);
  u2.unit_state = 'ON-RENT';
  app.__ui().form = { kind: 'wo-close', id: 'W1002', arg: null };
  out = await renderRoute('#/wo/W1002');
  assert.ok(!out.includes('name="ready"') && out.includes('its readiness is left alone'), 'ON-RENT: hidden, and it says why');
  app.__ui().form = null;
  await asFull('owner');
});

await check('D69: CLOSE posts {ready} from the box — true, false, or absent when the box is not drawn', async () => {
  const { posted } = await apiInsp({ name: 'Matt', role: 'owner' });
  await submitForm({ action: 'work_order', verb: 'CLOSE', wo: 'W1002' }, { note: '' }, { ready: true });
  await submitForm({ action: 'work_order', verb: 'CLOSE', wo: 'W1002' }, { note: 'leave it in prep' }, { ready: false });
  await submitForm({ action: 'work_order', verb: 'CLOSE', wo: 'W1002' }, { note: '' });
  assert.deepEqual(posted.map((p) => p.payload), [
    { action: 'CLOSE', work_order: 'W1002', note: null, ready: true },
    { action: 'CLOSE', work_order: 'W1002', note: 'leave it in prep', ready: false },
    { action: 'CLOSE', work_order: 'W1002', note: null },
  ]);
  assert.ok((await renderRoute('#/wo/W1002')).includes('close (readiness left alone)'), 'the pending row says so');
  await leaveApi();
});

await check('D69: Reopen on a settled sheet — owner yes, sales no; never on a CLOSED work order', async () => {
  for (const role of ['owner', 'sales']) {
    await asFull(role);
    resetSheets();
    assert.equal((await renderRoute('#/wo/W1002')).includes('data-sheet="insp-reopen"'), role === 'owner', `${role}: DONE`);
    assert.equal((await renderRoute('#/wo/W1003')).includes('data-sheet="insp-reopen"'), role === 'owner', `${role}: SKIPPED`);
    assert.ok(!(await renderRoute('#/wo/W1004')).includes('data-sheet="insp-reopen"'), `${role}: closed`);
  }
  const { posted } = await apiInsp({ name: 'Matt', role: 'owner' });
  await submitForm({ action: 'work_order', verb: 'INSPECT', step: 'REOPEN', key: 'W1002', wo: 'W1002' }, { note: 'missed the recovery tank' });
  assert.deepEqual(posted[0].payload, { action: 'INSPECT', step: 'REOPEN', work_order: 'W1002', note: 'missed the recovery tank' });
  assert.ok(!(await renderRoute('#/wo/W1002')).includes('data-sheet="insp-reopen"'), 'pending — no second tap');
  await leaveApi();
});

await check('D69: a legacy row — inspection a string or null — renders a PENDING-shaped sheet, no crash', async () => {
  for (const legacy of ['I1001', null]) {
    const snap = await asFull('owner');
    resetSheets();
    const w = snap.work_orders.find((x) => x.id === 'W1002');
    w.inspection = legacy;
    const out = await renderRoute('#/wo/W1002');
    assert.ok(!/undefined|NaN|\[object Object\]|Invalid Date/.test(out), `${legacy}: no placeholder leaked`);
    const card = sheetCardOf(out);
    assert.ok(card.includes('>PENDING</span>') && card.includes('📋 Inspection ▾'), `${legacy}: PENDING, open`);
    assert.ok(card.includes('data-ifield="machine_class"'), `${legacy}: the sheet, derived from the unit`);
    assert.ok(!card.includes('I1001'), `${legacy}: the I-number is not drawn as the sheet`);
    assert.ok(/data-sheet="wo-close" data-id="W1002" disabled/.test(out), `${legacy}: a PENDING sheet holds Close`);
    app.__ui().showParts = true;
    assert.ok(partsStripOf(await renderRoute('#/')).includes('>📋 pending</span>'), `${legacy}: the strip chip`);
    const u = snap.units.find((x) => x.serial === w.serial);
    assert.ok((await renderRoute(`#/unit/${encodeURIComponent(u.serial)}`)).includes('📋 pending'), `${legacy}: the unit chip`);
    app.__ui().showParts = false;
  }
  resetSheets();
  await asFull('owner');
});

await check('D69: a numbered sheet saves ONE section per INSPECT SAVE keyed on the W-number, and takes back its own older save', async () => {
  const { posted, deleted } = await apiInsp({ name: 'Josh', role: 'service' });
  await renderRoute('#/wo/W1001');
  await tapSeg('sqg.blades', 'REPAIR');
  await app.__flushSheets();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].action, 'work_order');
  assert.equal(posted[0].serial, null);
  assert.deepEqual(Object.keys(posted[0].payload).sort(), ['action', 'items', 'step', 'work_order']);
  assert.equal(posted[0].payload.step, 'SAVE');
  assert.equal(posted[0].payload.items.length, 7, 'the six the engine had + the new one — the whole section');
  await fireOn('change', fieldTarget('comments', 'rear blade rolled', 'TEXTAREA'));
  await app.__flushSheets();
  assert.deepEqual(posted[1].payload, { action: 'INSPECT', step: 'SAVE', work_order: 'W1001', comments: 'rear blade rolled' }, 'comments alone');
  await fireOn('change', fieldTarget('note:sqg.blades', 'rolled'));
  await app.__flushSheets();
  assert.equal(posted[2].payload.items.find((i) => i.id === 'sqg.blades').note, 'rolled');
  assert.ok(deleted.length === 1 && /:t1$/.test(deleted[0]), 'the older items SAVE is taken back; the comments SAVE is not');
  await fireOn('change', fieldTarget('body_style', 'RIDER', 'SELECT'));
  await fireOn('change', fieldTarget('readings.brush1_pct', '62.6'));
  await app.__flushSheets();
  assert.deepEqual(posted.find((p) => 'body_style' in p.payload).payload, { action: 'INSPECT', step: 'SAVE', work_order: 'W1001', body_style: 'RIDER' });
  assert.equal(posted.filter((p) => 'readings' in p.payload).pop().payload.readings.brush1_pct, 63, 'a percent goes out whole');
  assert.ok(!posted.some((p) => /"(cost|rate|price)"/.test(JSON.stringify(p))), 'no money key');
  // The mock's own pending SAVE on W1001 (by W-number) belongs to this page too.
  const out = await renderRoute('#/wo/W1001');
  assert.ok(out.includes('sheet saved — items') && out.includes('sheet saved — comments'), 'pending saves badge on the sheet');
  await leaveApi();
});

await check('D69: Done saves what is unsaved FIRST, then posts INSPECT DONE with the tech; the sheet locks', async () => {
  const { posted } = await apiInsp({ name: 'Josh', role: 'service' });
  await renderRoute('#/wo/W1001');
  await fireOn('input', fieldTarget('readings.hours_key', '412.5'));      // typed, not yet blurred
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'insp-done', id: 'W1001' } }));
  await settle();
  assert.ok(view._html.includes('412.5 h goes on the unit') && view._html.includes('>Mark the sheet done<'));
  await submitForm({ action: 'work_order', verb: 'INSPECT', step: 'DONE', key: 'W1001', wo: 'W1001' }, { tech: 'Zac' });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].payload.step, 'SAVE');
  assert.equal(posted[0].payload.readings.hours_key, 412.5, 'the meter lands before the lock');
  assert.deepEqual(posted[1], { action: 'work_order', serial: null, payload: { action: 'INSPECT', step: 'DONE', work_order: 'W1001', tech: 'Zac' } });
  const out = await renderRoute('#/wo/W1001');
  assert.ok(out.includes('⏳ DONE — at the next run') && out.includes('sheet done (Zac)'), 'pending, badged');
  assert.ok(!out.includes('id="insp-status"') && /data-ifield="comments"[^>]* disabled>/.test(out), 'locked');
  await tapSeg('ctl.key_switch', 'IN-SPEC');
  await app.__flushSheets();
  assert.equal(posted.length, 2, 'nothing more goes out after Done');
  await leaveApi();
});

await check('D69: a NEW work order — the sheet saves keyed on the serial (no W-number), Done works, then it locks', async () => {
  const snap0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const u = newUnitOf(snap0);
  const open = evt('2026-09-27T11:00:00.000Z:o1', '2026-09-27T11:00:00.000Z', 'Zac', 'service', u.serial, { action: 'OPEN', purpose: 'RETURN', note: null, parts: [] });
  const { posted, deleted } = await apiInsp({ name: 'Zac', role: 'service' }, [open]);
  const key = `new:${u.serial}`;
  let out = await renderRoute(`#/wo/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('PO <span>⏳ NEW</span>') && out.includes('Fill the sheet in now'), 'the page, not numbered');
  assert.ok(out.includes(`data-sheet="insp-done" data-id="${key}" disabled>Done<`), 'no hours: disabled');
  await fireOn('change', fieldTarget('readings.hours_key', '41'));
  await app.__flushSheets();
  assert.deepEqual(posted[0], { action: 'work_order', serial: u.serial, payload: { action: 'INSPECT', step: 'SAVE', readings:
    { hours_key: 41, hours_traction: null, hours_scrub: null, hours_vac: null, main_broom_pct: null, brush1_pct: null, brush2_pct: null, brushes_rotated: null,
      head_type: null, pad_drivers_needed: null, pad_holders_needed: null, pads_needed: null, pad_diameter: null, pad_color: null } } },
    'keyed on the serial — no invented work_order key');
  await fireOn('change', fieldTarget('readings.hours_key', '42'));
  await app.__flushSheets();
  assert.deepEqual(deleted, [posted.length && `2026-09-27T12:00:01.000Z:t1`], 'the older readings save is taken back');
  out = await renderRoute(`#/wo/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes(`data-sheet="insp-done" data-id="${key}">Done<`), 'hours → Done');
  // + Add parts and + Log hours work before the number, keyed on the serial too.
  assert.ok(out.includes(`data-sheet="wo-add" data-id="${key}"`) && out.includes(`data-sheet="wo-labor" data-id="${key}"`));
  await submitForm({ action: 'work_order', verb: 'LABOR', serial: u.serial }, { date: '2026-09-27', who: 'Zac', travel: '0', labor: '1.5', note: '' });
  assert.deepEqual(posted[2], { action: 'work_order', serial: u.serial, payload: { action: 'LABOR', date: '2026-09-27', who: 'Zac', hours: 1.5, kind: 'LABOR', note: null } });
  await submitForm({ action: 'work_order', verb: 'INSPECT', step: 'DONE', key, serial: u.serial }, { tech: 'Zac' });
  assert.deepEqual(posted[3], { action: 'work_order', serial: u.serial, payload: { action: 'INSPECT', step: 'DONE', tech: 'Zac' } });
  out = await renderRoute(`#/wo/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('⏳ DONE — at the next run') && !out.includes('id="insp-status"'), 'locked');
  assert.ok(!out.includes('data-sheet="wo-close"'), 'Close waits for the number');
  await leaveApi();
});

await check('D69: someone else\'s NEW work order is read-only here; undoing mine takes back everything keyed on its serial', async () => {
  const snap0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));
  const u = newUnitOf(snap0);
  const open = evt('2026-09-27T11:00:00.000Z:o1', '2026-09-27T11:00:00.000Z', 'Zac', 'service', u.serial, { action: 'OPEN', purpose: 'PM', parts: [] });
  const save = evt('2026-09-27T11:01:00.000Z:s1', '2026-09-27T11:01:00.000Z', 'Zac', 'service', u.serial, { action: 'INSPECT', step: 'SAVE', readings: { hours_key: 9 } });
  const done = evt('2026-09-27T11:02:00.000Z:d1', '2026-09-27T11:02:00.000Z', 'Zac', 'service', u.serial, { action: 'INSPECT', step: 'DONE', tech: 'Zac' });
  await apiInsp({ name: 'Josh', role: 'service' }, [open, save]);
  let out = await renderRoute(`#/wo/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('to fill in until then') && out.includes('Zac') && !out.includes('id="insp-status"'), 'Josh: read-only');
  assert.ok(out.includes('value="9"'), 'but Zac\'s pending save shows');
  const { deleted } = await apiInsp({ name: 'Zac', role: 'service' }, [open, save, done]);
  await renderRoute(`#/wo/new/${encodeURIComponent(u.serial)}`);
  await tapSeg('ctl.key_switch', 'IN-SPEC');
  await fireOn('click', fakeTarget('[data-undo]', { dataset: { undo: open.id } }));
  await settle();
  assert.deepEqual(deleted, [open.id, save.id, done.id], 'the OPEN, then my save and Done against its serial');
  assert.ok(!app.__sheetLocal().has(`new:${u.serial}`), 'nothing typed lingers to land on a later work order');
  out = await renderRoute(`#/wo/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('Work order not found.'), 'gone');
  await leaveApi();
});

await check('D69: when the W-number lands, the NEW route redirects and anything unsaved moves to the numbered work order', async () => {
  const snap = await asFull('service');
  resetSheets();
  const u = snap.units.find((x) => x.work_order === 'W1001');
  app.__sheetLocal().set(`new:${u.serial}`, { edits: { comments: 'typed before the run' }, dirty: new Set(['comments']),
    status: 'dirty', error: null, timer: null, notes: new Set(), chain: Promise.resolve() });
  const out = await renderRoute(`#/wo/new/${encodeURIComponent(u.serial)}`);
  assert.ok(out.includes('Opening W1001'));
  assert.equal(window.location.hash, '#/wo/W1001', 'replaced, not pushed');
  const l = app.__sheetLocal().get('W1001');
  assert.ok(l && l.dirty.has('comments') && l.edits.comments === 'typed before the run');
  assert.ok(!app.__sheetLocal().has(`new:${u.serial}`));
  assert.ok((await renderRoute('#/wo/W1001')).includes('>typed before the run</textarea>'));
  resetSheets();
  await asFull('owner');
});

await check('D69: the mock\'s pending serial-keyed SAVE badges on the ⏳ NEW work order it belongs to', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=service&pending=1';
  window.location.search = '?mock=full&role=service&pending=1';
  await app.__refresh();
  const snap = app.__state().snapshot;
  const opens = app.__state().pending.filter((e) => e.action === 'work_order' && e.payload.action === 'OPEN');
  assert.equal(opens.length, 1);
  const out = await renderRoute(`#/wo/new/${encodeURIComponent(opens[0].serial)}`);
  assert.ok(out.includes('sheet saved — readings') && out.includes('value="1204"'), 'the hours typed before the number');
  assert.ok(!/undefined|NaN|\[object Object\]/.test(out));
  assert.ok(snap.work_orders.every((w) => w.inspection && typeof w.inspection === 'object'), 'every fixture row carries an object');
  await asFull('owner');
});

await check('D69: no money KEY on a sheet or the library — and a tech\'s "$40 blade" note is honest data, drawn as typed', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    for (const w of snap.work_orders) {
      app.__ui().sheetCard.set(w.id, true);
      assert.ok(!MONEY_RE.test(await renderRoute(`#/wo/${w.id}`)), `${role} ${w.id}: a dollar figure`);
    }
    app.__ui().sheetCard.clear();
    assert.ok(!/"(cost|cost_source_inv|rate|price|amount)"\s*:/i.test(JSON.stringify([snap.work_orders.map((w) => w.inspection), snap.inspection_checklist])), `${role}: no money key`);
  }
  // Red-pen #1: the gate is on KEYS. A figure a tech types is theirs to type.
  resetSheets();
  await renderRoute('#/wo/W1001');
  await tapSeg('sqg.blades', 'REPAIR');
  await fireOn('input', fieldTarget('note:sqg.blades', '$40 blade from RPS'));
  assert.ok((await renderRoute('#/wo/W1001')).includes('value="$40 blade from RPS"'));
  resetSheets();
  await asFull('owner');
});

/* ============================================ D78 — the Activity tape ====== */

const activityOf = (out) => {
  const i = out.indexOf('<section class="activity card" aria-label="Activity">');
  if (i < 0) return '';
  return out.slice(i, out.indexOf('</section>', i) + 10);
};
const headOf = (sec) => sec.slice(sec.indexOf('data-activity-toggle'), sec.indexOf('</button>'));
const setActivity = (open) => { app.__ui().showActivity = open; };
/** D54 guard: strip tags; after every pill's name comes a time or nothing — never a bare number. */
const noCountAfterPill = (markup, where) => {
  for (const m of markup.matchAll(/<span class="pill-actor[^"]*">([^<]*)<\/span>([^]*?)(?=<span class="pill-actor|$)/g)) {
    assert.ok(!/\d/.test(m[1]), `${where}: a digit inside a pill (${m[1]})`);
    const next = m[2].replace(/<[^>]+>/g, ' ').trimStart();
    assert.ok(!/^\d/.test(next) || /^\d{1,2}:\d{2}(\D|$)/.test(next), `${where}: a number right after ${m[1]}: "${next.slice(0, 20)}"`);
  }
};

await check('D78: the Activity strip draws for every role, under the Parts tracker, folded, head = the newest line', async () => {
  for (const role of ['owner', 'service', 'sales']) {
    const snap = await asFull(role);
    setActivity(false);
    const out = await renderRoute('#/');
    const sec = activityOf(out);
    assert.ok(sec, `${role}: strip present`);
    const trk = out.indexOf('aria-label="Parts tracker"');
    const act = out.indexOf('aria-label="Activity"');
    assert.ok(trk >= 0 && act > trk && out.indexOf('cat-card') > act, `${role}: tracker → activity → cards`);
    assert.ok(!sec.includes('id="activity-body"'), 'folded by default');
    const head = headOf(sec);
    assert.ok(head.includes('📣 Activity ▸'));
    const newest = snap.activity[0];
    assert.ok(head.includes(`>${newest.actor}</span>`) && head.includes(newest.text), `${role}: head is the newest row`);
    assert.ok(head.includes('pill-actor h-green'), 'Josh is green');
    noCountAfterPill(head, `${role} head`);
    assert.ok(!MONEY_RE.test(sec), `${role}: no figure on the tape`);
  }
});

await check('D78: open — day labels, rows linked by record shape, unknown actor grey, no counts anywhere', async () => {
  const snap = await asFull('sales');
  setActivity(true);
  const sec = activityOf(await renderRoute('#/'));
  assert.ok(sec.includes('id="activity-body"'));
  assert.ok(sec.includes('>Today</div>'), 'Today label');
  assert.ok(sec.includes('>Yesterday</div>'), 'Yesterday label');
  assert.equal([...sec.matchAll(/class="act-row/g)].length, snap.activity.length, 'one row per filed line (sales has no pending here)');
  assert.ok(sec.includes('href="#/wo/W1003"'));
  assert.ok(sec.includes(`href="#/lead/${snap.activity[1].record}"`));
  const serialRow = snap.activity.find((r) => r.action === 'readiness');
  assert.ok(sec.includes(`href="#/unit/${serialRow.record}"`), 'a serial routes to the unit');
  const disp = snap.activity.find((r) => r.action === 'dispatch_done');
  assert.ok(!sec.includes(`href="#/dispatch/${disp.record}"`) && sec.includes(`<div class="act-row">`), 'dispatch id / null → a plain row');
  assert.ok(sec.includes('<span class="pill-actor h-grey">Architect</span>'), 'unknown actor: grey, name as given');
  noCountAfterPill(sec, 'body');
  setActivity(false);
});

await check('D78: my own pending taps ride on top of Today as ⏳ rows; one already filed (same evt) is suppressed', async () => {
  window.location.href = 'http://localhost:8787/?mock=full&role=owner&pending=1';
  window.location.search = '?mock=full&role=owner&pending=1';
  await app.__refresh();
  const st = app.__state();
  setActivity(true);
  let sec = activityOf(await renderRoute('#/'));
  const mine = st.pending.filter((e) => e.actor === 'Matt');
  assert.ok(mine.some((e) => e.id === 'evt-mock-6'), 'fixture: Matt has evt-mock-6 pending');
  assert.ok(st.snapshot.activity.some((r) => r.evt === 'evt-mock-6'), 'fixture: and it is already on the tape');
  const pend = [...sec.matchAll(/class="act-row pending"/g)].length;
  assert.equal(pend, mine.length - 1, 'every Matt pending but the filed one');
  assert.ok(!headOf(sec).includes('⏳'), "Matt's only pending is filed — the head is the real line");
  // Josh (service) has several unapplied taps and none is on the tape yet.
  window.location.href = 'http://localhost:8787/?mock=full&role=service&pending=1';
  window.location.search = '?mock=full&role=service&pending=1';
  await app.__refresh();
  sec = activityOf(await renderRoute('#/'));
  const joshes = app.__state().pending.filter((e) => e.actor === 'Josh');
  assert.ok(joshes.length >= 2, 'fixture: Josh has pending taps');
  assert.equal([...sec.matchAll(/class="act-row pending"/g)].length, joshes.length);
  const firstRow = sec.indexOf('class="act-row');
  assert.ok(sec.slice(firstRow, firstRow + 40).includes('pending'), 'the ⏳ rows sit at the top');
  assert.ok(sec.indexOf('>Today</div>') < firstRow);
  assert.ok(!/>(Kevin|Matt|Zac)<\/span><span class="act-time">[^<]*<\/span><span class="act-text">⏳/.test(sec), "nobody else's pending shows");
  // head leads with my newest pending
  assert.ok(headOf(sec).includes('⏳'));
  setActivity(false);
  await asFull('owner');
});

await check('D78: activity: [] → "nothing yet" and the strip still draws; absent key (pre-D78) → the same', async () => {
  window.location.href = 'http://localhost:8787/?mock=empty&role=owner';
  window.location.search = '?mock=empty&role=owner';
  await app.__refresh();
  assert.deepEqual(app.__state().snapshot.activity, []);
  let sec = activityOf(await renderRoute('#/'));
  assert.ok(sec && sec.includes('parts-n zero">nothing yet<'), 'empty: nothing yet');
  window.location.href = 'http://localhost:8787/?mock=legacy&role=owner';
  window.location.search = '?mock=legacy&role=owner';
  await app.__refresh();
  assert.ok(!('activity' in app.__state().snapshot));
  sec = activityOf(await renderRoute('#/'));
  assert.ok(sec && sec.includes('nothing yet'), 'legacy: still draws');
  const snap = await asFull('owner');
  delete snap.activity;
  setActivity(true);
  sec = activityOf(await renderRoute('#/'));
  assert.ok(sec.includes('Nothing on the tape yet.') && !/undefined|NaN/.test(sec), 'full minus the key: renders, empty body');
  setActivity(false);
  await asFull('owner');
});

/* ------------------------------------------------------------------ D79 -- */
const orderTicket = (snap, state) => snap.service_queue.find((t) => t.status === 'OPEN' && t.order && t.order.state === state);
const orderBlockOf = (out) => {
  const i = out.indexOf('<section class="card order-block"');
  return i < 0 ? '' : out.slice(i, out.indexOf('</section>', i) + 10);
};

await check('D79: ticket detail — the order block under the stage chips: state chip, vendor · ref · ordered, UPS link, note; no money', async () => {
  const snap = await asFull('service');
  const tr = orderTicket(snap, 'IN-TRANSIT');
  const out = await renderRoute(`#/ticket/${tr.ticket}`);
  const b = orderBlockOf(out);
  assert.ok(b, 'drawn');
  assert.ok(out.indexOf('class="detail-head"') < out.indexOf('order-block') && out.indexOf('order-block') < out.indexOf('<h2>Ticket'), 'directly under the stage chip row, above the Ticket card');
  assert.ok(b.includes(`🔩 Parts order · PO <strong class="unit-serial">${tr.ticket}</strong>`), 'PO = the S-number');
  assert.ok(b.includes('<span class="chip rent">in transit</span>'), 'IN-TRANSIT → blue (rent)');
  assert.ok(b.includes('RPS · ref SO0001234 · ordered '), 'vendor · ref · ordered');
  assert.ok(b.includes('href="https://www.ups.com/track?tracknum=1Z999AA10198765430"') && b.includes('UPS 1Z999AA10198765430 ↗'), 'the carrier link');
  assert.ok(b.includes('Pump assy 41-2207, backordered once'), 'the note');
  assert.ok(b.includes('data-sheet="order"') && b.includes('>Edit order<'), 'WAITING-ON-PARTS → Edit order');
  assert.ok(!MONEY_RE.test(b) && !/cost/i.test(b), 'no money in the block');
  assert.ok(out.includes('Pump assy 41-2207 — ETA Thursday'), '`parts` free text still renders where it did');

  const o = orderTicket(snap, 'ORDERED');
  const bo = orderBlockOf(await renderRoute(`#/ticket/${o.ticket}`));
  assert.ok(bo.includes('<span class="chip hold">ordered</span>') && bo.includes('Tennant · ordered '), 'ORDERED → grey (hold); no ref segment when there is none');
  assert.ok(!bo.includes('chip track') && !bo.includes('ups.com'), 'no tracking yet → no chip, no link');

  const dl = orderTicket(snap, 'DELIVERED');
  const bd = orderBlockOf(await renderRoute(`#/ticket/${dl.ticket}`));
  assert.ok(bd.includes('<span class="chip ok">delivered</span>'), 'DELIVERED → green');
  assert.ok(/<span class="chip ok">delivered [A-Z][a-z]{2} \d{1,2}<\/span>/.test(bd), 'and "delivered <date>"');
  assert.ok(!bd.includes('Edit order'), 'not WAITING-ON-PARTS → no Edit order');

  const none = snap.service_queue.find((t) => t.status === 'OPEN' && !t.order);
  assert.ok(!(await renderRoute(`#/ticket/${none.ticket}`)).includes('order-block'), 'order null → nothing');
});

await check('D79: Parts tracker — a Customer orders band between the active work orders and Delivered (30d), oldest ordered first', async () => {
  const snap = await asFull('owner');
  setParts(false);
  app.__ui().showTracker = true;
  const tr = trackerOf(await renderRoute('#/'));
  const band = tr.indexOf('<div class="parts-g">Customer orders</div>');
  assert.ok(band > tr.lastIndexOf('data-tracker-wo="W1002"') && band < tr.indexOf('Delivered (30d)'), 'between the Active WO groups and Delivered (30d)');
  const rows = tr.slice(band, tr.indexOf('class="parts-sub"')).split('<div class="prow">').slice(1);
  const it = orderTicket(snap, 'IN-TRANSIT');
  const od = orderTicket(snap, 'ORDERED');
  assert.deepEqual(rows.map((r) => r.match(/PO <strong>(S\d{4})<\/strong>/)[1]), [it.ticket, od.ticket], 'oldest `ordered` first; DELIVERED not in the band');
  assert.ok(rows[0].includes(`<a class="chip asset" href="#/ticket/${it.ticket}">${it.customer}</a>`), 'customer chip → the ticket');
  assert.ok(rows[0].includes('>RPS<') && rows[0].includes('>SO0001234<') && rows[0].includes('ups.com/track?tracknum=1Z999AA10198765430'), 'vendor · ref · UPS link');
  assert.ok(rows[0].includes('<span class="chip rent">in transit</span>') && rows[0].includes(`<span class="chip age">${it.age_in_stage_days}d</span>`), 'state chip + the engine\'s age_in_stage_days');
  assert.ok(rows[1].includes('<span class="chip hold">ordered</span>') && rows[1].includes('<span class="chip age">1d</span>'), 'ORDERED, 1d');
  assert.ok(!MONEY_RE.test(tr), 'no money in the strip');
  // Delivered (30d): the DELIVERED order of an OPEN ticket is a row in the fold.
  app.__ui().showPartsDelivered = true;
  const tr2 = trackerOf(await renderRoute('#/'));
  const fold = tr2.slice(tr2.indexOf('class="parts-sub"'));
  const dl = orderTicket(snap, 'DELIVERED');
  assert.ok(fold.includes(`PO <strong>${dl.ticket}</strong>`) && /chip ok">delivered [A-Z]/.test(fold), 'delivered order row, with its date');
  assert.ok(!fold.slice(fold.indexOf(dl.ticket)).includes('chip age'), 'no age in the delivered band');
  assert.ok(!MONEY_RE.test(tr2), 'no money in the fold');
  setParts(false);
});

await check('D79: CLOSED tickets never draw; orders alone still draw the strip; neither → nothing at all', async () => {
  const snap = await asFull('owner');
  setParts(false);
  app.__ui().showTracker = true; app.__ui().showPartsDelivered = true;
  const closed = snap.service_queue.find((t) => t.status === 'CLOSED');
  closed.order = { state: 'IN-TRANSIT', vendor: 'RPS', vendor_ref: 'CLOSEDREF', ordered: '2026-09-01', tracking: null, carrier: null, delivered: null, note: null };
  assert.ok(!trackerOf(await renderRoute('#/')).includes('CLOSEDREF'), 'a CLOSED ticket\'s order never shows');
  snap.work_orders = [];
  const only = trackerOf(await renderRoute('#/'));
  assert.ok(only.includes('Customer orders') && only.includes('>1 ordered · 1 in transit<'), 'no part lines, orders only: still drawn, head counts the orders');
  for (const t of snap.service_queue) t.order = null;
  assert.equal(trackerOf(await renderRoute('#/')), '', 'no lines and no orders → no card');
  setParts(false);
  await asFull('owner');
});

await check('D79: pipeline — "N ordered · M in transit" under Waiting on parts; tap opens the 📦 tracker on the board', async () => {
  const snap = await asFull('owner');
  setParts(false);
  const out = await renderRoute('#/service');
  const want = snap.service_queue.filter((t) => t.status === 'OPEN' && t.machine_owner === 'CUSTOMER' && t.stage === 'WAITING-ON-PARTS' && t.order);
  assert.equal(want.length, 2, 'fixture: two orders waiting');
  const row = out.indexOf('data-pipe="WAITING-ON-PARTS"');
  const chipAt = out.indexOf('data-orders-jump="1"');
  assert.ok(chipAt > row && chipAt < out.indexOf('data-pipe="READY-TO-SCHEDULE"'), 'right after the Waiting-on-parts row');
  assert.ok(out.includes('>🔩 1 ordered · 1 in transit</button>'), 'the chip text');
  assert.ok(out.slice(row, chipAt).includes('</button>'), 'its own button — the row\'s closes first, never nested');
  assert.ok(!out.slice(out.indexOf('data-pipe="READY-TO-SCHEDULE"')).includes('data-orders-jump'), 'one chip only');
  await fireOn('click', fakeTarget('[data-orders-jump]', {}));
  await settle();
  assert.equal(app.__ui().showTracker, true, 'tracker expanded');
  assert.equal(window.location.hash, '#/', 'to the board');
  // No orders → no chip.
  for (const t of snap.service_queue) t.order = null;
  assert.ok(!(await renderRoute('#/service')).includes('data-orders-jump'), 'no orders → no chip');
  setParts(false);
  await asFull('owner');
});

await check('D79: the WAITING-ON-PARTS stage sheet posts vendor / vendor_ref / order_note; Edit order posts them without a stage', async () => {
  const { snapshot, posted } = await apiAs({ name: 'Josh', role: 'service' });
  const t = snapshot.service_queue.find((x) => x.status === 'OPEN' && x.stage === 'IN-PROGRESS' && x.machine_owner === 'CUSTOMER');
  await renderRoute(`#/ticket/${t.ticket}`);
  await fireOn('click', fakeTarget('[data-stage]', { dataset: { stage: 'WAITING-ON-PARTS' } }));
  await settle();
  const sheet = view._html.slice(view._html.indexOf('data-mode="stage"'));
  assert.ok(sheet.includes('name="vendor"') && sheet.includes('name="vendor_ref"') && sheet.includes('placeholder="order / confirmation #"'), 'vendor + ref');
  assert.ok(sheet.includes('name="order_note"') && !/name="note"/.test(sheet.slice(0, sheet.indexOf('</form>'))), 'the note on THIS sheet is order_note');
  const opts = [...sheet.slice(0, sheet.indexOf('</select>')).matchAll(/<option value="([A-Z-]*)"/g)].map((m) => m[1]);
  assert.deepEqual(opts, ['', 'RPS', 'NILFISK', 'IPC-EAGLE', 'MINUTEMAN', 'TENNANT', 'OTHER'], 'optional, spec order');
  await submitForm({ action: 'ticket_update', id: t.ticket, mode: 'stage' }, { stage: 'WAITING-ON-PARTS', vendor: 'RPS', vendor_ref: 'SO1', order_note: '2 squeegees' });
  assert.deepEqual(posted.pop(), { action: 'ticket_update', serial: null,
    payload: { ticket: t.ticket, stage: 'WAITING-ON-PARTS', vendor: 'RPS', vendor_ref: 'SO1', order_note: '2 squeegees' } });
  // Another stage keeps its plain note.
  await fireOn('click', fakeTarget('[data-stage]', { dataset: { stage: 'SCHEDULED' } }));
  await settle();
  const other = view._html.slice(view._html.indexOf('data-mode="stage"'));
  assert.ok(other.includes('name="note"') && !other.slice(0, other.indexOf('</form>')).includes('name="vendor"'), 'SCHEDULED: note, no vendor');

  // Edit order on a ticket sitting in WAITING-ON-PARTS with an order.
  const w = snapshot.service_queue.find((x) => x.status === 'OPEN' && x.stage === 'WAITING-ON-PARTS' && x.order && x.order.vendor_ref);
  await renderRoute(`#/ticket/${w.ticket}`);
  await fireOn('click', fakeTarget('[data-sheet]', { dataset: { sheet: 'order', id: w.ticket } }));
  await settle();
  const ed = orderBlockOf(view._html);
  assert.ok(ed.includes('data-mode="order"') && ed.includes(`value="${w.order.vendor_ref}"`) && ed.includes(`<option value="${w.order.vendor}" selected`), 'prefilled');
  assert.ok(!ed.includes('name="stage"'), 'no stage on Edit order');
  const n = posted.length;
  await submitForm({ action: 'ticket_update', id: w.ticket, mode: 'order' }, { vendor: '', vendor_ref: '', order_note: '' });
  assert.equal(posted.length, n, 'all blank → nothing posts');
  assert.ok(view._html.includes('Pick a vendor or put in a ref or a note.'), 'and it says why');
  await submitForm({ action: 'ticket_update', id: w.ticket, mode: 'order' }, { vendor: 'RPS', vendor_ref: 'SO0001235', order_note: '' });
  assert.deepEqual(posted.pop().payload, { ticket: w.ticket, vendor: 'RPS', vendor_ref: 'SO0001235' });
  const after = await renderRoute(`#/ticket/${w.ticket}`);
  assert.ok(after.includes('order: RPS · SO0001235') && after.includes('>Undo<'), 'ordinary pending + undo');
  globalThis.fetch = realFetch;
  window.location.hostname = 'localhost';
  window.location.protocol = 'http:';
  await asFull('owner');
});

await check('D79: a pre-D79 snapshot (no `order` key anywhere) renders byte-identical to order: null, with no D79 markup', async () => {
  const pages = async () => {
    const snap = app.__state().snapshot;
    const out = [];
    for (const h of ['#/', '#/service', ...snap.service_queue.map((t) => `#/ticket/${t.ticket}`)]) out.push(await renderRoute(h));
    return out.join('\n');
  };
  for (const open of [false, true]) {
    const snap = await asFull('owner');
    setParts(open);
    for (const t of snap.service_queue) delete t.order;
    const absent = await pages();
    for (const t of snap.service_queue) t.order = null;
    const nul = await pages();
    assert.equal(absent, nul, `absent ≡ null (tracker ${open ? 'open' : 'folded'})`);
    for (const m of ['Customer orders', 'order-block', 'data-orders-jump', '🔩 Parts order', 'Edit order']) assert.ok(!absent.includes(m), `no ${m}`);
  }
  setParts(false);
  await asFull('owner');
});

await check('every module app.js imports is in the service worker’s shell (an installed app must boot offline)', async () => {
  const appSrc = fs.readFileSync(path.join(DOCS, 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const mods = [...appSrc.matchAll(/from '\.\/([a-z-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(mods.includes('inspections.js'), 'the scan finds the D67 / D69 sheet module');
  for (const m of mods) assert.ok(shell.includes(`'${m}'`), `${m} is imported but not precached in sw.js`);
});

console.log(`\n${passed} checks passed.`);
