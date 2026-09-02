#!/usr/bin/env node
/**
 * make-mock-data.js — FAKE dashboard snapshot generator (schema_version 1).
 *
 * EVERYTHING in this file is invented. Fake customers, fake serials, fake money.
 * No real WSS data may ever be pasted in here — see CLAUDE.md rule 1.
 *
 * Emits two variants so every view can be exercised:
 *   mock-full.json   non-empty service queue; every status-board row non-zero
 *   mock-empty.json  service_queue: [] (that module seeds later); ON-DEMO row = 0
 *
 * Coverage guaranteed by construction:
 *   - all 9 categories, in display order
 *   - every unit_state: AVAILABLE RESERVED ON-RENT ON-DEMO LOANER-OUT IN-SHOP RETIRED
 *   - every readiness: READY NEEDS-PREP DOWN
 *   - an agreements row with "agreement": null  (unbilled-rental alert)
 *   - a split-cycle invoice ("R....-7.1") and a bare QBO invoice number
 *   - a LOANER-OUT unit with an agreement number and NO agreements row
 *   - category cards that land on each of the green / yellow / red lights
 *
 * Usage: node tools/make-mock-data.js [outdir]     (default: docs/mock)
 * No dependencies. Node 18+.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- rng + dates

// mulberry32 — deterministic, so money/hours don't churn between runs.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260901);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const money = (lo, hi, step = 25) => Math.round((lo + rand() * (hi - lo)) / step) * step;

const DAY = 86400000;
// Anchor on today's UTC date. Generator-side date math only — the PAGE never
// parses date-only strings (CLAUDE.md rule 7).
const TODAY = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const d = (offsetDays) => new Date(TODAY + offsetDays * DAY).toISOString().slice(0, 10);

// ---------------------------------------------------------------- fake corpus

// The real 9 rental-rate-matrix bands, in canonical display order (confirmed by
// the Architect, Sep 2026). The real snapshot emits exactly this order.
const CATEGORIES = [
  'Walk-Behind Sweeper',
  'Ride-On Sweeper',
  'Small Walk-Behind Scrubber',
  'Mid-Size Walk-Behind Scrubber',
  'Large Walk-Behind Scrubber',
  'Chariot (Stand-on) Scrubber',
  'Small Rider Scrubber',
  'Mid-Size Rider Scrubber',
  'Large Rider Scrubber',
];

const BRANDS = ['Nordvale', 'Ironline', 'Cascade Clean', 'Meridian', 'Halstead'];
const MODELS = ['SC-1700', 'SC-2400', 'T-320', 'T-500', 'R-660', 'R-880', 'SW-900', 'BX-27', 'BX-40'];
const CUSTOMERS = [
  'Acme Foods', 'Bluebird Logistics', 'Cedar Ridge Manufacturing', 'Dorsey Plastics',
  'Evergreen Distribution', 'Fairmont Dairy', 'Granite Peak Warehouse', 'Harborview Foods',
  'Ironwood Packaging', 'Juniper Metalworks', 'Kestrel Print', 'Lakeshore Beverage',
  'Maplewood Schools', 'Northgate Fulfillment', 'Oakhill Casting', 'Pinnacle Cold Storage',
  'Quarry Road Aggregates', 'Redtail Automotive', 'Summit Fabrication',
];
const SITES = [
  'Ixonia WI', 'Waukesha WI', 'Oconomowoc WI', 'Madison WI', 'Milwaukee WI',
  'Watertown WI', 'Jefferson WI', 'Sun Prairie WI', 'Beloit WI',
];
const NOTES_PREP = [
  'squeegee blades ordered', 'needs deck wash + charge', 'brush worn, swap before ship',
  'battery watering due', 'seat switch intermittent',
];
const NOTES_DOWN = [
  'traction motor pulled', 'controller fault F14', 'awaiting pump assembly',
  'frame crack at caster - out of service',
];

// ------------------------------------------------------------------ unit plan
// [state, readiness] per unit, grouped by category index. Hand-built so the
// coverage promises above hold and the 9 cards show a mix of lights.
const PLAN = [
  // 0 Walk-Behind Sweeper -> 2 available+ready = GREEN
  [['AVAILABLE', 'READY'], ['AVAILABLE', 'READY'], ['ON-RENT', 'READY'], ['ON-RENT', 'READY']],
  // 1 Ride-On Sweeper -> 2 available+ready = GREEN
  [['AVAILABLE', 'READY'], ['AVAILABLE', 'READY'], ['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['RESERVED', 'READY']],
  // 2 Small Walk-Behind Scrubber -> 1 available+ready = YELLOW
  [['AVAILABLE', 'READY'], ['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['IN-SHOP', 'DOWN'], ['RESERVED', 'NEEDS-PREP']],
  // 3 Mid-Size Walk-Behind Scrubber -> 1 available but NEEDS-PREP = RED
  [['AVAILABLE', 'NEEDS-PREP'], ['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['ON-DEMO', 'READY'], ['IN-SHOP', 'NEEDS-PREP']],
  // 4 Large Walk-Behind Scrubber -> 0 available = RED
  [['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['LOANER-OUT', 'READY']],
  // 5 Chariot (Stand-on) Scrubber -> 1 available+ready = YELLOW
  [['AVAILABLE', 'READY'], ['ON-RENT', 'READY'], ['ON-DEMO', 'READY'], ['RETIRED', 'DOWN']],
  // 6 Small Rider Scrubber -> 0 available = RED
  [['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['LOANER-OUT', 'READY'], ['IN-SHOP', 'DOWN']],
  // 7 Mid-Size Rider Scrubber -> 0 available = RED
  [['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['RESERVED', 'READY']],
  // 8 Large Rider Scrubber -> 1 available, NEEDS-PREP = RED
  [['AVAILABLE', 'NEEDS-PREP'], ['ON-RENT', 'READY'], ['ON-RENT', 'READY'], ['RETIRED', 'NEEDS-PREP']],
];

const OUT_STATES = new Set(['ON-RENT', 'ON-DEMO', 'LOANER-OUT']);

function build({ withServiceQueue }) {
  const units = [];
  const agreements = [];
  let serialSeq = 900100;
  let agmtSeq = 4100;
  let loanerCount = 0;

  PLAN.forEach((plan, catIdx) => {
    const category = CATEGORIES[catIdx];
    plan.forEach(([state0, readiness]) => {
      // Empty variant: no demos out, so the board shows a zero row (D20).
      const unit_state = !withServiceQueue && state0 === 'ON-DEMO' ? 'AVAILABLE' : state0;
      const serial = String(serialSeq += 7);
      const brand = pick(BRANDS);
      const model = pick(MODELS) + (units.length % 4 === 0 ? ' 2026' : '');   // some models carry a year
      const isLoaner = unit_state === 'LOANER-OUT';
      const out = OUT_STATES.has(unit_state);

      // The first LOANER-OUT gets an agreement number but NO agreements row —
      // that is correct per the contract, not a bug. The second is a bare loan.
      const loanerPlacement = isLoaner && loanerCount++ === 0;

      let agreement = null;
      if (unit_state === 'ON-RENT') agreement = (agmtSeq += 3);
      else if (loanerPlacement) agreement = (agmtSeq += 3);

      const cost = money(4000, 26000, 100);
      const book = Math.round(cost * (0.45 + rand() * 0.4));
      const ask = Math.round(book * (1.25 + rand() * 0.3) / 50) * 50;

      const note =
        readiness === 'NEEDS-PREP' ? pick(NOTES_PREP) :
        readiness === 'DOWN' ? pick(NOTES_DOWN) : null;

      const customer = out ? pick(CUSTOMERS) : null;
      const job_site = out ? pick(SITES) : null;

      const unit = {
        serial,
        asset_item: `A-${1000 + units.length + 1}`,
        brand,
        model,
        description: `${category} — ${brand} ${model}`,
        category,
        status: isLoaner ? 'LOANER' : 'RENTAL',
        unit_state,
        readiness,
        readiness_note: note,
        hours: unit_state === 'RETIRED' ? null : Math.round(200 + rand() * 3400),
        in_service: d(-Math.round(300 + rand() * 1500)),
        acquisition_cost: cost,
        book, ask,
        rate_card: {                       // D17 — any of the four may be null
          full_day: money(150, 600, 5),
          weekend: units.length % 5 === 1 ? null : money(250, 900, 5),
          weekly: units.length % 7 === 3 ? null : money(400, 1600, 25),
          monthly: money(450, 2400, 25),
        },
        job_site,
        agreement,
        reservation: { held_by: null, purpose: null, customer: null, until: null },
        service_ticket: null,
      };

      if (unit_state === 'RESERVED') {
        unit.reservation = {
          held_by: pick(['Kevin', 'Matt']),
          purpose: pick(['quote hold', 'demo next week', 'replacement for down unit']),
          customer: pick(CUSTOMERS),
          until: d(Math.round(3 + rand() * 12)),
        };
      }

      units.push(unit);

      // One agreements row per ON-RENT unit. Loaner placements get none.
      if (unit_state === 'ON-RENT') {
        const cycles_billed = Math.round(1 + rand() * 14);
        const oneShot = rand() < 0.2;
        const periodEndOffset = -Math.round(rand() * 20);
        agreements.push({
          agreement: unit.agreement,
          customer,
          serial,
          cycle: oneShot ? 'ONE-SHOT' : '28D',
          cycle_rate: unit.rate_card.monthly,
          cycles_billed,
          cycles_max: oneShot ? 1 : (rand() < 0.3 ? cycles_billed + Math.round(1 + rand() * 5) : null),
          last_invoiced_period_start: d(periodEndOffset - 27),
          last_invoiced_period_end: d(periodEndOffset),
          last_invoice: `R${unit.agreement}-${cycles_billed}`,
          next_due: oneShot ? null : d(periodEndOffset + 28),
          job_site,
          customer_po: rand() < 0.4 ? `PO-${Math.round(10000 + rand() * 89999)}` : null,
          alerts: [],
        });
      }
    });
  });

  // --- shape the agreements array into the edge cases the UI must survive ----

  // A split cycle: invoice number with a ".1" suffix. Opaque string, never parsed.
  agreements[2].last_invoice = `R${agreements[2].agreement}-${agreements[2].cycles_billed}.1`;
  agreements[2].alerts = ['split cycle — partial period billed'];

  // A bare QuickBooks invoice number instead of the R<agmt>-<cycle> form.
  agreements[5].last_invoice = '519665';

  // Past cycles_max — loud on the rentals view.
  agreements[7].cycles_max = agreements[7].cycles_billed - 1;
  agreements[7].alerts = ['past max cycles — confirm extension or pick up'];

  // A 28D row with no billing seed yet: next_due unknown, but the rate still
  // counts as recurring revenue (D21).
  agreements[3].cycle = '28D';
  agreements[3].next_due = null;
  agreements[3].alerts = ['no billing seed — next due unknown'];

  // The unbilled-rental alert: a unit out with no agreement number at all.
  const orphanUnit = units.find((u) => u.unit_state === 'ON-RENT' && u.agreement === agreements[10].agreement);
  orphanUnit.agreement = null;
  agreements[10] = {
    agreement: null,
    customer: orphanUnit.job_site ? pick(CUSTOMERS) : 'Unknown',
    serial: orphanUnit.serial,
    cycle: 'ONE-SHOT',
    cycle_rate: 0,
    cycles_billed: 0,
    cycles_max: null,
    last_invoiced_period_start: null,
    last_invoiced_period_end: null,
    last_invoice: null,
    next_due: null,
    job_site: orphanUnit.job_site,
    customer_po: null,
    alerts: ['UNBILLED RENTAL — unit is out with no agreement'],
  };

  // ------------------------------------------------------------- service queue
  const STAGES = ['INTAKE', 'DIAGNOSED', 'AWAITING-PARTS', 'IN-PROGRESS', 'READY-TO-INVOICE', 'DONE'];
  let service_queue = [];
  if (withServiceQueue) {
    const inShop = units.filter((u) => u.unit_state === 'IN-SHOP');
    service_queue = STAGES.flatMap((stage, i) => {
      const n = stage === 'DONE' ? 1 : (i % 2 === 0 ? 2 : 1);
      return Array.from({ length: n }, (_, k) => {
        const ticket_id = `SVC-${1200 + i * 10 + k}`;
        // A couple of tickets are customer-owned machines: serial null, desc only.
        const own = inShop[(i + k) % Math.max(inShop.length, 1)];
        const attach = own && (i + k) % 3 !== 2;
        if (attach) own.service_ticket = own.service_ticket || ticket_id;
        return {
          ticket_id,
          customer: pick(CUSTOMERS),
          serial: attach ? own.serial : null,
          unit_desc: attach ? `${own.brand} ${own.model}` : `${pick(BRANDS)} ${pick(MODELS)} (customer owned)`,
          stage,
          assigned: pick(['Josh', 'Zac']),
          opened: d(-Math.round(1 + rand() * 25)),
          quote: rand() < 0.5 ? money(180, 2600, 10) : null,
          machinio_ref: rand() < 0.4 ? `MCH-${Math.round(70000 + rand() * 9999)}` : null,
        };
      });
    });
  }

  // -------------------------------------------------------------------- billing
  const billable = agreements.filter((a) => a.next_due && a.agreement);
  const due_next_7_days = billable.slice(0, 5).map((a, i) => ({
    agreement: a.agreement,
    customer: a.customer,
    serial: a.serial,
    amount: a.cycle_rate,
    due: d(i + 1),
  }));
  const created_last_run = billable.slice(5, 8).map((a) => ({
    invoice: `R${a.agreement}-${a.cycles_billed + 1}`,
    agreement: a.agreement,
    customer: a.customer,
    amount: a.cycle_rate,
    period_start: a.last_invoiced_period_end,
    period_end: d(0),
  }));

  const totals = units.reduce((acc, u) => {
    acc.units += 1;
    acc.cost += u.acquisition_cost;
    acc.book += u.book;
    acc.ask += u.ask;
    return acc;
  }, { units: 0, cost: 0, book: 0, ask: 0 });

  return {
    meta: {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      run_id: `mock-${withServiceQueue ? 'full' : 'empty'}-${new Date().toISOString().slice(0, 10)}`,
      fleet_totals: totals,
      // Deliberate unknown field — the app must ignore it silently.
      mock: true,
    },
    categories: CATEGORIES,
    units,
    agreements,
    service_queue,
    billing: { due_next_7_days, created_last_run },
  };
}

// ------------------------------------------------------------------------ main
const outdir = process.argv[2] || path.join(HERE, '..', 'docs', 'mock');
fs.mkdirSync(outdir, { recursive: true });

let firstSnapshot = null;
for (const [name, opts] of [
  ['mock-full.json', { withServiceQueue: true }],
  ['mock-empty.json', { withServiceQueue: false }],
]) {
  const snapshot = build(opts);
  if (!firstSnapshot) firstSnapshot = snapshot;
  const file = path.join(outdir, name);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(
    `${name}: ${snapshot.units.length} units, ${snapshot.agreements.length} agreements, ` +
    `${snapshot.service_queue.length} tickets -> ${path.relative(process.cwd(), file)}`
  );
}

// Sample UNAPPLIED events, shaped exactly as the Worker stores them. This is not
// part of the snapshot contract — the Worker returns pending separately — so it
// gets its own file, loaded only by ?mock=full&pending=1.
const avail = firstSnapshot.units.filter((u) => u.unit_state === 'AVAILABLE');
const pending = [
  {
    id: 'evt-mock-1',
    ts: new Date(Date.now() - 3 * 3600000).toISOString(),
    actor: 'Kevin', role: 'sales',
    action: 'reserve', serial: avail[0].serial,
    payload: { customer: 'Ironwood Packaging', purpose: 'quote hold', until: d(6) },
  },
  {
    id: 'evt-mock-2',
    ts: new Date(Date.now() - 40 * 60000).toISOString(),
    actor: 'Josh', role: 'service',
    action: 'readiness', serial: avail[1].serial,
    payload: { readiness: 'NEEDS-PREP', note: 'squeegee blades ordered' },
  },
];
const pfile = path.join(outdir, 'mock-pending.json');
fs.writeFileSync(pfile, JSON.stringify(pending, null, 2) + '\n');
console.log(`mock-pending.json: ${pending.length} unapplied events -> ${path.relative(process.cwd(), pfile)}`);
