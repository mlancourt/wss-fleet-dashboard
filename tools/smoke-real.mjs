#!/usr/bin/env node
/**
 * smoke-real.mjs — render every view against a REAL snapshot, without ever
 * putting one in this repo.
 *
 * The file is read from the path you pass and served to the app from memory.
 * Nothing is written, nothing is copied into docs/. This tool contains no data
 * of its own, which is why it can live here (CLAUDE.md rule 1).
 *
 *   node tools/smoke-real.mjs ~/.wss-runs/real-snapshot-schema5.json
 *
 * It fails on a thrown view, an `undefined` in the markup, and — the point of
 * running it on a real file — on any field the engine actually publishes that
 * the mock generator happens not to produce.
 *
 * This is the "real-snapshot smoke" step of the Leads spec §9 exit. It does NOT
 * check the money gate: that is a WORKER behaviour and is proven by the curl
 * check in tools/m1-loop.sh against a running Worker.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, '..', 'docs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/smoke-real.mjs <path-to-snapshot.json>');
  process.exit(2);
}
const real = JSON.parse(fs.readFileSync(file, 'utf8'));

/* --------------------------------------------------------------- tiny DOM --
 * Same stub as tools/selftest-render.mjs. Kept separate rather than shared
 * because that file is the mock suite's harness and this one has to survive
 * being pointed at a snapshot nobody has seen yet. */

function el() {
  return {
    _html: '', dataset: {}, style: {}, hidden: false, textContent: '', children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    querySelector: () => null, querySelectorAll: () => [],
    appendChild(c) { this.children.push(c); return c; },
    scrollIntoView() {}, focus() {}, closest: () => null,
  };
}
const view = el();
const nodes = {
  '#view': view, '#asof': el(), '#pending-badge': el(),
  '#tab-dispatch-badge': el(), '#tab-leads-badge': el(),
};

globalThis.window = {
  location: {
    href: 'http://localhost:8787/?mock=full&role=owner', hash: '#/', hostname: 'localhost',
    protocol: 'http:', pathname: '/', search: '?mock=full&role=owner',
    replace(h) { this.hash = String(h); },
  },
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
globalThis.document = {
  querySelector: (sel) => nodes[sel] || null,
  querySelectorAll: () => [],
  addEventListener() {},
  createRange: () => ({ selectNodeContents() {} }),
};

// The app asks for its mock file; hand it the real one from memory instead.
// Everything else (there is nothing else) falls through to docs/.
globalThis.fetch = async (url) => {
  const name = String(url).split('?')[0];
  if (name.startsWith('mock/mock-')) {
    if (name.includes('pending')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(real)) };
  }
  const f = path.join(DOCS, name);
  if (!fs.existsSync(f)) return { ok: false, status: 404 };
  const text = fs.readFileSync(f, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

const app = await import(path.join(DOCS, 'app.js'));
const settle = () => new Promise((r) => setTimeout(r, 30));
await settle();

let passed = 0;
let failed = 0;
const note = (ok, msg) => { if (ok) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); } };

async function renderRoute(hash) {
  window.location.hash = hash;
  view._html = '';
  app.__render();
  await settle();
  return view._html;
}

console.log(`real-snapshot smoke — ${path.basename(file)} (schema ${real.meta && real.meta.schema_version})`);
console.log(`  ${(real.units || []).length} units · ${(real.service_queue || []).length} tickets · ` +
  `${(real.dispatch || []).length} runs · ${(real.leads || []).length} leads\n`);

for (const role of ['owner', 'sales', 'service']) {
  window.location.href = `http://localhost:8787/?mock=full&role=${role}`;
  window.location.search = `?mock=full&role=${role}`;
  await app.__refresh();
  const snap = app.__state().snapshot;

  const routes = ['#/', '#/rentals', '#/holds', '#/dispatch', '#/service', '#/leads']
    .concat((snap.categories || []).map((c) => `#/cat/${encodeURIComponent(c)}`))
    .concat((snap.units || []).map((u) => `#/unit/${encodeURIComponent(u.serial)}`))
    .concat((snap.service_queue || []).map((t) => `#/ticket/${encodeURIComponent(t.ticket)}`))
    .concat((snap.dispatch || []).map((r) => `#/dispatch/${encodeURIComponent(r.id)}`))
    .concat((snap.leads || []).map((l) => `#/lead/${encodeURIComponent(l.lead)}`));

  let bad = null;
  for (const hash of routes) {
    let out;
    try {
      out = await renderRoute(hash);
    } catch (err) {
      bad = `${hash} threw: ${err.message}`;
      break;
    }
    const leak = /undefined|\[object Object\]|NaN/.exec(out);
    if (leak) {
      bad = `${hash} leaked "${leak[0]}": ${(/.{0,70}(undefined|\[object Object\]|NaN).{0,70}/.exec(out) || [])[0]}`;
      break;
    }
  }
  note(!bad, `every route renders as ${role} (${routes.length} pages)` + (bad ? ` — ${bad}` : ''));
}

/* --------------------------------------------------------- schema-5 shape --
 * Not a contract test — the Architect owns the contract. These say only that
 * the tab found what it needs, so a silent "renders fine because it rendered
 * nothing" can't pass for a smoke test. */

window.location.href = 'http://localhost:8787/?mock=full&role=sales';
window.location.search = '?mock=full&role=sales';
await app.__refresh();
const snap = app.__state().snapshot;

note(snap.meta.schema_version >= 5, `meta.schema_version is ${snap.meta.schema_version} (expected 5+)`);
note(Array.isArray(snap.leads), 'leads[] is present');
note(!!snap.leads_summary, 'leads_summary is present');
note(!!snap.scoreboard, 'scoreboard is present');
note(!!snap.insights, 'insights is present');

const out = await renderRoute('#/leads');
note(out.includes('Leads'), 'the Leads tab renders');
if (snap.leads.length) {
  note(out.includes('kan-head'), 'the board draws its columns');
  const shown = snap.leads.filter((l) => l.status === 'OPEN')
    .every((l) => out.includes(`href="#/lead/${l.lead}"`));
  note(shown, 'every OPEN lead is on the board');
} else {
  note(out.includes('No leads yet.'), 'an empty leads[] renders the empty board, not a crash');
  note(!out.includes('undefined'), 'and the scoreboard survives every null');
}

/* --------------------------------------------------- notes timeline (v2.4) --
 * The reason this order shipped: Matt reads a tech's diagnosis on his phone to
 * price the job. So the smoke test proves the real rows are actually on screen,
 * not merely that the page didn't throw. */

const logged = snap.service_queue.filter((t) => Array.isArray(t.log) && t.log.length);
note(logged.length > 0, `${logged.length} of ${snap.service_queue.length} tickets carry a log`);

if (logged.length) {
  const t = logged.reduce((a, b) => (b.log.length > a.log.length ? b : a));
  const out2 = await renderRoute(`#/ticket/${encodeURIComponent(t.ticket)}`);
  const shown = t.log.filter((r) => out2.includes(esc(r.text).slice(0, 40)));
  note(shown.length === t.log.length,
    `${t.ticket}: all ${t.log.length} log rows on screen` + (shown.length === t.log.length ? '' : ` (only ${shown.length})`));
  note(t.log.every((r) => !r.ts || out2.includes(`class="nts">${esc(r.ts)}<`)),
    'every timestamp renders verbatim — both the "… CT" and bare-date shapes');
  note(!/Invalid Date|GMT|T00:00:00/.test(out2), 'and none of them reached new Date()');
  const authored = t.log.filter((r) => r.who);
  note([...out2.matchAll(/class="nwho">/g)].length === authored.length,
    `who is a chip on ${authored.length} of ${t.log.length} rows and absent on the rest`);
}

// The one the order named by number.
const s1014 = snap.service_queue.find((t) => t.ticket === 'S1014');
if (s1014) {
  const out3 = await renderRoute('#/ticket/S1014');
  const josh = (s1014.log || []).find((r) => r.who === 'Josh');
  note(!!josh && out3.includes(esc(josh.text).slice(0, 60)), "S1014 shows Josh's diagnosis in full");
  note(out3.includes('class="nwho">Josh<'), 'attributed to Josh');
} else {
  note(true, 'S1014 is not in this snapshot (skipped)');
}

function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The engine may publish a stage, source or interest we have no label for. That
// is fine — but it must fall through as the raw enum, never as "undefined".
const known = new Set(['RECEIVED', 'CONTACTED', 'QUOTED', 'DEMO-SCHEDULED', 'INVOICED']);
const strange = [...new Set(snap.leads.map((l) => l.stage).filter((s) => s && !known.has(s)))];
note(true, strange.length ? `unknown stages tolerated: ${strange.join(', ')}` : 'no unknown lead stages');

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
