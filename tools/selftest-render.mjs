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
import { STAGES, STAGE_LABEL, PIPELINE_STAGES, columnsFor } from '../docs/service.js';

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
const nodes = { '#view': view, '#asof': el('span'), '#pending-badge': el('span'), '#tab-dispatch-badge': el('span') };

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

const ROUTES = ['#/', '#/rentals', '#/holds', '#/dispatch', '#/service', '#/billing'];

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
    '#/unit/nope', '#/ticket/S9999',
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

await check('All shows both widgets and all eight columns', async () => {
  const out = await serviceUnder('all');
  assert.ok(out.includes('Fleet status'), 'the fleet board must show under All');
  assert.ok(out.includes('Service pipeline'), 'the pipeline must show under All');
  assert.ok(out.indexOf('Fleet status') < out.indexOf('Service pipeline'), 'board above pipeline');
  assert.ok(out.includes('Customer machines · fleet repairs are on the board above'),
    'the caption explains the split, but only when both are on screen');
  const cols = [...out.matchAll(/id="kan-([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, columnsFor('all'));
});

await check('Fleet shows the board only, six columns, and only WSS tickets', async () => {
  const out = await serviceUnder('WSS');
  assert.ok(out.includes('Fleet status'), 'the board is the Fleet widget');
  assert.ok(!out.includes('Service pipeline'), 'the pipeline is customer work — hidden under Fleet');
  const cols = [...out.matchAll(/id="kan-([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, columnsFor('WSS'));
  assert.equal(cols.length, 6);
  assert.ok(!cols.includes('WAITING-ON-CUSTOMER') && !cols.includes('READY-TO-INVOICE'));
  // every card drawn belongs to a fleet ticket
  const wss = new Set(app.__state().snapshot.service_queue.filter((t) => t.machine_owner === 'WSS').map((t) => t.ticket));
  for (const [, id] of out.matchAll(/class="kan-id">([^<]+)</g)) {
    assert.ok(wss.has(id), `${id} is a customer ticket and must not show under Fleet`);
  }
});

await check('Customer shows the pipeline only, eight columns, and only customer tickets', async () => {
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

await check('the pipeline draws seven tappable rows and a live open pill', async () => {
  const out = await serviceUnder('CUSTOMER');
  const rows = [...out.matchAll(/data-pipe="([A-Z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, PIPELINE_STAGES, 'seven rows in stage order');
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

await check('the pipeline card never hides — zero open tickets still draws seven rows', async () => {
  window.location.href = 'http://localhost:8787/?mock=empty&role=owner';
  window.location.search = '?mock=empty&role=owner';
  await app.__refresh();
  const out = await serviceUnder('CUSTOMER');
  assert.ok(out.includes('Service pipeline'), 'the card stays even with nothing in it');
  assert.ok(out.includes('0 open'), 'the pill reads 0 open');
  assert.ok(!out.includes('closed this week'), 'the closed pill hides at zero');
  assert.equal([...out.matchAll(/data-pipe="[A-Z-]+"/g)].length, 7, 'seven zero rows still render');
  assert.equal([...out.matchAll(/>0%</g)].length >= 7, true, 'and they read 0%');

  // hand the suite back the state it expects: full snapshot, All chip
  window.location.href = 'http://localhost:8787/?mock=full&role=owner';
  window.location.search = '?mock=full&role=owner';
  await app.__refresh();
  await serviceUnder('all');
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

console.log(`\n${passed} checks passed.`);
