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
globalThis.CSS = { escape: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '\\$&') };
// Node 22 already defines navigator (getter-only) — app.js only reads it.
globalThis.document = {
  querySelector: (sel) => nodes[sel] || null,
  querySelectorAll: () => [],
  addEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).concat(fn)); },
  createRange: () => ({ selectNodeContents() {} }),
};

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
    '#/unit/nope', '#/ticket/S9999', '#/lead/L9999',
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
  assert.ok(out.indexOf('Recurring revenue') < out.indexOf('Agreements'), 'revenue must lead the page');
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

await check('All shows both widgets and all nine columns', async () => {
  const out = await serviceUnder('all');
  assert.ok(out.includes('Fleet status'), 'the fleet board must show under All');
  assert.ok(out.includes('Service pipeline'), 'the pipeline must show under All');
  assert.ok(out.indexOf('Fleet status') < out.indexOf('Service pipeline'), 'board above pipeline');
  assert.ok(out.includes('Customer machines · fleet repairs are on the board above'),
    'the caption explains the split, but only when both are on screen');
  const cols = [...out.matchAll(/id="kan-([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, columnsFor('all'));
  assert.equal(cols.length, 9, 'D47 took the board from eight columns to nine');
  assert.equal(cols[2], 'NEEDS-QUOTE', 'and it sits straight after CONTACTED');
});

await check('Fleet shows the board only, six columns, and only WSS tickets', async () => {
  const out = await serviceUnder('WSS');
  assert.ok(out.includes('Fleet status'), 'the board is the Fleet widget');
  assert.ok(!out.includes('Service pipeline'), 'the pipeline is customer work — hidden under Fleet');
  const cols = [...out.matchAll(/id="kan-([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, columnsFor('WSS'));
  assert.equal(cols.length, 6, 'Fleet stays at six — D47 added a stage it can never take');
  assert.ok(!cols.includes('WAITING-ON-CUSTOMER') && !cols.includes('READY-TO-INVOICE'));
  assert.ok(!cols.includes('NEEDS-QUOTE'), 'nobody quotes us to us (D47)');
  // every card drawn belongs to a fleet ticket
  const wss = new Set(app.__state().snapshot.service_queue.filter((t) => t.machine_owner === 'WSS').map((t) => t.ticket));
  for (const [, id] of out.matchAll(/class="kan-id">([^<]+)</g)) {
    assert.ok(wss.has(id), `${id} is a customer ticket and must not show under Fleet`);
  }
});

await check('Customer shows the pipeline only, nine columns, and only customer tickets', async () => {
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

await check('the pipeline draws eight tappable rows and a live open pill', async () => {
  const out = await serviceUnder('CUSTOMER');
  const rows = [...out.matchAll(/data-pipe="([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, PIPELINE_STAGES, 'eight rows in stage order');
  // D47: our court, so the same maroon as RECEIVED and not WAITING's amber.
  assert.ok(out.includes('pipe-new" data-pipe="NEEDS-QUOTE"'), 'the Needs quote row is maroon');
  assert.ok(out.includes('>Needs quote<'), 'and reads in shop-floor words');
  assert.ok(!rows.includes('COMPLETE'), 'COMPLETE is the header pill, not a row');
  const q = app.__state().snapshot.service_queue;
  const open = q.filter((t) => t.machine_owner === 'CUSTOMER' && t.status === 'OPEN').length;
  const closed = q.filter((t) => t.machine_owner === 'CUSTOMER' && t.status === 'CLOSED').length;
  assert.ok(out.includes(`${open} open`), `header pill should read "${open} open"`);
  assert.equal(out.includes('closed this week'), closed > 0, 'the closed pill hides at zero');
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

await check('the pipeline card never hides — zero open tickets still draws eight rows', async () => {
  window.location.href = 'http://localhost:8787/?mock=empty&role=owner';
  window.location.search = '?mock=empty&role=owner';
  await app.__refresh();
  const out = await serviceUnder('CUSTOMER');
  assert.ok(out.includes('Service pipeline'), 'the card stays even with nothing in it');
  assert.ok(out.includes('0 open'), 'the pill reads 0 open');
  assert.ok(!out.includes('closed this week'), 'the closed pill hides at zero');
  assert.equal([...out.matchAll(/data-pipe="[A-Z-]+"/g)].length, 8, 'eight zero rows still render');
  assert.equal([...out.matchAll(/>0%</g)].length >= 8, true, 'and they read 0%');

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
  const routes = ['#/', '#/dispatch', '#/service', '#/holds', '#/leads']
    .concat(snap.units.map((u) => `#/unit/${encodeURIComponent(u.serial)}`))
    .concat(snap.service_queue.map((t) => `#/ticket/${encodeURIComponent(t.ticket)}`))
    .concat((snap.leads || []).map((l) => `#/lead/${encodeURIComponent(l.lead)}`));
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
  assert.equal([...mine.matchAll(/data-stage="[A-Z-]+"/g)].length, 6, 'six buttons on a fleet ticket');

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
  // `log` goes with the money: the engine writes "value → $X" rows into it, so
  // shipping the sentence would undo the fields being deleted. See worker.js.
  for (const l of snap.leads) { delete l.value; delete l.potential_commission; delete l.log; }
  delete snap.leads_summary.commission_rates;
  delete snap.leads_summary.money_fields;
  delete snap.scoreboard.money;
  return renderRoute(hash);
}

await check('the Leads board draws five columns, RECEIVED first and Won last', async () => {
  const out = await leadsAs('sales');
  const heads = [...out.matchAll(/<div class="kan-head"><span>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(heads.slice(0, 4), BOARD_STAGES.map((s) => STAGE_LABEL[s] || s).map((x, i) =>
    ['Received', 'Contacted', 'Quoted', 'Demo booked'][i]), 'the four open stages, in pipeline order');
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

await check('this session\'s pending note sits above the record, badged', async () => {
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
  assert.ok(out.indexOf('is-pending') < out.indexOf(esc(t.log[0].text).slice(0, 24)),
    'it sits above the record, not inside it');
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

await check('a service token gets no lead log — the engine writes money into it', async () => {
  // Real rows read "<name> value → $<amount>". Deleting `value` while shipping
  // the sentence that spells it out would defeat the §6 gate in one response,
  // so the Worker drops the whole lead log for a service token. TICKET logs are
  // untouched — that is where the shop's work is written down.
  const out = await leadsAsStrippedService('#/lead/L1005');
  // A log row is `class="nrow"`; a pending note is `class="nrow is-pending"`.
  // The tech keeps their own side's unapplied notes — those are the crew's
  // proposals, not the snapshot — and loses the record's.
  assert.ok(!out.includes('class="nrow">'), 'no lead log rows for a tech');
  assert.ok(!/\$\d/.test(out), 'and no dollar figure anywhere on the page');

  // Kevin still gets both.
  window.location.href = 'http://localhost:8787/?mock=full&role=sales';
  window.location.search = '?mock=full&role=sales';
  await app.__refresh();
  const kevin = await renderRoute('#/lead/L1005');
  assert.ok(kevin.includes('class="nrow">'), 'sales keeps the lead log');
  assert.ok(kevin.includes('value → $28,900.00'), 'including the row that made this gate necessary');

  // And a tech keeps every ticket log, which carries no lead money.
  window.location.href = 'http://localhost:8787/?mock=full&role=service';
  window.location.search = '?mock=full&role=service';
  await app.__refresh();
  const t = app.__state().snapshot.service_queue.find((x) => (x.log || []).length >= 3);
  const josh = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  assert.ok(josh.includes('class="nrow">'), 'ticket logs are not gated');
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

console.log(`\n${passed} checks passed.`);
