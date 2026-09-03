#!/usr/bin/env node
/**
 * make-mock-data.js — FAKE dashboard snapshot generator (schema_version 3).
 *
 * EVERYTHING in this file is invented. Fake customers, fake serials, fake money.
 * No real WSS data may ever be pasted in here — see CLAUDE.md rule 1.
 *
 * Emits three variants so every view can be exercised:
 *   mock-full.json    schema 3 — service queue, dispatch board, pick-ups, holds
 *   mock-empty.json   schema 3 — service_queue: [] and dispatch: [] (empty states);
 *                     ON-DEMO row = 0 on the status board
 *   mock-legacy.json  schema 2 — the pre-Dispatch snapshot, kept for one release
 *                     so the board still renders during the cutover
 *
 * Coverage guaranteed by construction:
 *   - all 9 categories, in display order
 *   - every unit_state: AVAILABLE RESERVED ON-RENT ON-DEMO LOANER-OUT IN-SHOP RETIRED
 *   - every readiness: READY NEEDS-PREP DOWN NEEDS-PICKUP
 *   - an agreements row with "agreement": null  (unbilled-rental alert)
 *   - a split-cycle invoice ("R....-7.1") and a bare QBO invoice number
 *   - a LOANER-OUT unit with an agreement number and NO agreements row
 *   - category cards that land on each of the green / yellow / red lights
 *   - D32: ON-RENT units with readiness NEEDS-PICKUP and matching pickups[]
 *     entries (full variant); the empty variant has none
 *   - Reservations v2: a unit with zero holds · one CURRENT hold (state RESERVED) ·
 *     only-FUTURE holds while AVAILABLE (the trap) · ON-RENT with two future holds ·
 *     an EXPIRED hold still holding the unit · four holds on one unit ·
 *     one MALFORMED hold; top-level rollup to match
 *   - schema 3 service: a ticket in every one of the seven stages · both
 *     machine_owners (a WSS ticket on a DOWN in-shop unit, and one on a unit
 *     that's out on rent) · a HIGH customer ticket with intake_move PICKUP and
 *     its SERVICE-IN row · a READY-TO-INVOICE ticket with a SERVICE-OUT DELIVER
 *     row · a CLOSED ticket · a ticket needing no truck at all
 *   - schema 3 dispatch: all three statuses, all four sources, a RENTAL-RETURN
 *     row tied to a NEEDS-PICKUP unit that is also in pickups[], one pick-up NOT
 *     yet on the board, and a dispatch_warnings entry naming two SCHEDULED rows
 *     on the same rig the same day
 *   - NO `reservation` singular anywhere at schema 3 (the legacy file has it)
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

// Per-category long-term rates (per 28-day cycle), as the matrix would publish them.
const r5 = (n) => Math.round(n / 5) * 5;
const LONG_TERM = CATEGORIES.map((_, i) => {
  const base = 700 + i * 275;
  return i === 5 ? { m6: null, m12: null } : { m6: r5(base * 0.75), m12: r5(base * 0.5) };
});

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
          // Long-term commitment rates: category-uniform, published verbatim from the
          // rate matrix (rounded to $5 there). One category carries nulls -> "—".
          long_term_6mo: LONG_TERM[catIdx].m6,
          long_term_12mo: LONG_TERM[catIdx].m12,
        },
        job_site,
        agreement,
        // D33: agreement customer for ON-RENT, placement customer for LOANER-OUT, else null (ON-DEMO too).
        customer: unit_state === 'ON-RENT' || isLoaner ? customer : null,
        reservations: [],                               // v2: the hold list is the truth (filled below)
        service_ticket: null,                           // schema 3: "S1001" when a ticket is open on this unit
      };

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

  // ------------------------------------------------------------- pick-ups (D32)
  // The customer released an out unit; it's still ON-RENT until a truck fetches it.
  const pickups = [];
  const pickupUnits = [];
  if (withServiceQueue) {
    const PU_NOTES = [
      'Customer called — released, unit at the dock',
      'Released Friday; site closes at 3',
      'Job wrapped early — call the plant before you roll',
    ];
    const pu = units.filter((u) => u.unit_state === 'ON-RENT' && u.agreement != null).slice(1, 4);
    pu.forEach((u, i) => {
      u.readiness = 'NEEDS-PICKUP';
      u.readiness_note = PU_NOTES[i];
      const ag = agreements.find((a) => a.agreement === u.agreement);
      pickupUnits.push(u);
      pickups.push({ serial: u.serial, model: `${u.brand} ${u.model}`, category: u.category, unit_state: u.unit_state,
        job_site: u.job_site, agreement: u.agreement, customer: ag ? ag.customer : null,
        billed_through: ag ? ag.last_invoiced_period_end : null, note: u.readiness_note });
    });
  }

  // ---------------------------------------------------------------- holds (v2)
  // Statuses are engine-computed in real life; here from today's date.
  const TODAY_STR = d(0);
  const status = (h) => (!h.start || !h.end || h.end < h.start) ? 'malformed'
    : h.end < TODAY_STR ? 'expired' : h.start > TODAY_STR ? 'future' : 'current';
  let holdSeq = 0;
  const hold = (u, startOff, endOff, extra = {}) => {
    const h = {
      id: `h${u.serial.slice(-4)}${String.fromCharCode(97 + holdSeq++ % 26)}`,
      held_by: pick(['Kevin', 'Matt']),
      customer: pick(CUSTOMERS),
      purpose: pick(['DEMO — Ixonia', 'quote hold', 'replacement for down unit', 'trade-show loaner']),
      start: d(startOff), end: d(endOff), created: d(Math.min(startOff, 0) - 2),
      ...extra,
    };
    h.status = status(h);
    u.reservations.push(h);
  };
  const reservedUnits = units.filter((u) => u.unit_state === 'RESERVED');
  const availReady = units.filter((u) => u.unit_state === 'AVAILABLE' && u.readiness === 'READY');
  const onRent = units.filter((u) => u.unit_state === 'ON-RENT');
  const inShop = units.filter((u) => u.unit_state === 'IN-SHOP');

  hold(reservedUnits[0], -1, 3);                       // one CURRENT hold -> RESERVED
  hold(reservedUnits[1], -9, -3);                      // EXPIRED, still holding the unit (RESERVED)
  hold(reservedUnits[2], 0, 0);                        // four holds: current one-day + three future
  hold(reservedUnits[2], 4, 4);
  hold(reservedUnits[2], 7, 9);
  hold(reservedUnits[2], 14, 14);
  hold(availReady[0], 6, 6);                           // only FUTURE holds, unit stays AVAILABLE (the trap)
  hold(availReady[0], 8, 10);
  hold(onRent[0], 12, 12);                             // ON-RENT with two future holds (the 142812 case)
  hold(onRent[0], 20, 22);
  hold(inShop[0], 5, 3, { purpose: 'bad dates' });     // MALFORMED (end before start)
  // everything else: zero holds

  // Schema 3: the list is the ONLY source. No `reservation` singular is emitted.
  for (const u of units) u.reservations.sort((a, b) => a.start.localeCompare(b.start));
  const rollupRow = (u, h) => ({ serial: u.serial, model: `${u.brand} ${u.model}`, category: u.category,
    id: h.id, held_by: h.held_by, customer: h.customer, purpose: h.purpose, start: h.start, end: h.end });
  const reservations = { upcoming: [], expired: [] };
  for (const u of units) for (const h of u.reservations) {
    if (h.status === 'expired') reservations.expired.push(rollupRow(u, h));
    else reservations.upcoming.push({ ...rollupRow(u, h), status: h.status });
  }
  reservations.upcoming.sort((a, b) => a.start.localeCompare(b.start));
  reservations.expired.sort((a, b) => a.start.localeCompare(b.start));

  // -------------------------------------------------- service queue (schema 3)
  // Hand-built, not generated: §9 of the work order names the exact cases the
  // Service tab has to survive, and a random walk can't promise them.
  const service_queue = [];
  const dispatch = [];
  const dispatch_warnings = [];

  if (withServiceQueue) {
    // The two fleet machines that carry tickets: one DOWN in the shop, one that
    // failed in the field while it's still out on rent.
    const shopDown = units.find((u) => u.unit_state === 'IN-SHOP' && u.readiness === 'DOWN');
    const outOnRent = units.find((u) => u.unit_state === 'ON-RENT' && u.readiness === 'READY' && u.agreement != null);

    let seq = 1000;
    const ticket = (t) => {
      const id = `S${++seq}`;
      const opened = t.opened != null ? t.opened : -Math.round(2 + rand() * 20);
      const stage_since = t.stage_since != null ? t.stage_since : Math.min(0, opened + Math.round(rand() * 4));
      const row = {
        ticket: id,
        status: 'OPEN',
        stage: 'INTAKE',
        machine_owner: 'CUSTOMER',
        customer: pick(CUSTOMERS),
        serial: null,
        equipment: `${pick(BRANDS)} ${pick(MODELS)}`,
        issue: 'needs a look',
        priority: 'MEDIUM',
        site: pick(SITES),
        location: 'IN-SHOP',
        intake_move: 'CUSTOMER-DROP',
        return_move: 'CUSTOMER-PICKUP',
        assigned: null,
        scheduled: null,
        opened: d(opened),
        opened_by: pick(['Matt', 'Kevin', 'Josh', 'Zac']),
        stage_since: d(stage_since),
        age_days: -opened,
        quote: null,
        parts: null,
        machinio_ref: null,
        closed: null,
        ...t,
      };
      delete row.unit;
      // The day offsets above are NUMBERS for convenience at the call site; the
      // spread would leave them in the snapshot as "-1". Convert after merging.
      row.opened = d(opened);
      row.stage_since = d(stage_since);
      row.age_days = -opened;
      // A ticket on one of OUR machines points back at the unit, and the unit
      // points at the ticket (D35) — both directions, or the wrench chip lies.
      if (t.unit) {
        row.machine_owner = 'WSS';
        row.serial = t.unit.serial;
        row.equipment = `${t.unit.brand} ${t.unit.model}`;
        if (row.status === 'OPEN') t.unit.service_ticket = id;
      }
      service_queue.push(row);
      return row;
    };

    // 1 — INTAKE, HIGH, customer machine still at their plant: we go get it. (SERVICE-IN below)
    const t1 = ticket({
      stage: 'INTAKE', priority: 'HIGH', customer: 'Ironwood Packaging',
      equipment: 'Nordvale SC-2400 (customer owned)', issue: 'Scrubber dead — no power at key switch, whole line is mopping by hand',
      location: 'AT-CUSTOMER', site: 'Watertown WI', intake_move: 'PICKUP', return_move: 'DELIVER',
      opened: -1, assigned: 'Josh',
    });

    // 2 — INSPECTION on one of ours, DOWN in the shop.
    ticket({
      stage: 'INSPECTION', unit: shopDown, customer: 'WSS',
      issue: 'Traction motor pulled — checking the controller before we order',
      location: 'IN-SHOP', intake_move: 'NONE', return_move: 'NONE',
      priority: 'MEDIUM', assigned: 'Zac', opened: -9,
    });

    // 3 — QUOTED: customer machine, quote sent, waiting on their yes.
    ticket({
      stage: 'QUOTED', customer: 'Fairmont Dairy', equipment: 'Halstead R-660 (customer owned)',
      issue: 'Squeegee frame bent, deck actuator leaking', location: 'IN-SHOP',
      intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP', assigned: 'Josh', opened: -12,
      quote: { number: 'Q-2211', amount: 2480, sent: d(-6), approved: null },
      machinio_ref: 'MCH-74210',
    });

    // 4 — PARTS-ORDERED: the wait state that eats a shop.
    ticket({
      stage: 'PARTS-ORDERED', customer: 'Lakeshore Beverage', equipment: 'Meridian T-500 (customer owned)',
      issue: 'Pump assembly failed', location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP',
      return_move: 'DELIVER', assigned: 'Zac', opened: -18, scheduled: d(4),
      quote: { number: 'Q-2198', amount: 1140, sent: d(-15), approved: d(-13) },
      parts: 'Pump assy 41-2207 — ETA Thursday, backordered once already',
    });

    // 5 — IN-PROGRESS on one of ours that is OUT ON RENT: a field call, no truck move.
    ticket({
      stage: 'IN-PROGRESS', unit: outOnRent, customer: outOnRent ? outOnRent.customer : 'WSS',
      issue: 'Brush motor cutting out under load — customer kept it, we go to it',
      location: 'AT-CUSTOMER', site: outOnRent ? outOnRent.job_site : null,
      intake_move: 'NONE', return_move: 'NONE', assigned: 'Josh', opened: -3, scheduled: d(1),
      priority: 'HIGH',
    });

    // 6 — READY-TO-INVOICE: done on the bench, we drive it back. (SERVICE-OUT below)
    const t6 = ticket({
      stage: 'READY-TO-INVOICE', customer: 'Cedar Ridge Manufacturing',
      equipment: 'Ironline BX-40 (customer owned)', issue: 'Annual service + new squeegees',
      location: 'IN-SHOP', site: 'Oconomowoc WI', intake_move: 'PICKUP', return_move: 'DELIVER',
      assigned: 'Zac', opened: -21,
      quote: { number: 'Q-2185', amount: 860, sent: d(-19), approved: d(-18) },
    });

    // 7 — COMPLETE + CLOSED. Lingers 7 days so "done this week" is visible.
    ticket({
      stage: 'COMPLETE', status: 'CLOSED', customer: 'Dorsey Plastics',
      equipment: 'Cascade Clean SW-900 (customer owned)', issue: 'Charger fault, replaced onboard charger',
      location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP',
      assigned: 'Josh', opened: -26, closed: d(-2), stage_since: -2,
      quote: { number: 'Q-2170', amount: 1320, sent: d(-24), approved: d(-23) },
      machinio_ref: 'MCH-73988',
    });

    // 8 — a second INTAKE card, LOW, no truck involved at any point.
    ticket({
      stage: 'INTAKE', priority: 'LOW', customer: 'Maplewood Schools',
      equipment: 'Nordvale BX-27 (customer owned)', issue: 'Dropping water on the right side',
      location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP', opened: -4,
    });

    // 9 — a second IN-PROGRESS card so a column isn't always one deep.
    ticket({
      stage: 'IN-PROGRESS', customer: 'Granite Peak Warehouse', equipment: 'Meridian R-880 (customer owned)',
      issue: 'Wheel drive noise; teardown started', location: 'IN-SHOP',
      intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP', assigned: 'Zac', opened: -7,
    });

    // ------------------------------------------------------------- dispatch board
    const move = (m) => {
      dispatch.push({
        id: m.id, kind: m.kind, source: m.source,
        serial: m.serial != null ? m.serial : null,
        ticket: m.ticket != null ? m.ticket : null,
        what: m.what, customer: m.customer, address: m.address,
        date: m.date != null ? m.date : null,
        billed_through: m.billed_through != null ? m.billed_through : null,
        driver: m.driver != null ? m.driver : null,
        rig: m.rig != null ? m.rig : null,
        status: m.status, note: m.note != null ? m.note : null,
        done: m.done != null ? m.done : null,
      });
    };

    // RENTAL-RETURN, OPEN — the first released unit, straight off pickups[].
    if (pickupUnits[0]) {
      const p = pickups[0];
      move({ id: `m-pu-${p.serial}`, kind: 'PICKUP', source: 'RENTAL-RETURN', serial: p.serial,
        what: `${p.model} #${p.serial} off-rent`, customer: p.customer, address: p.job_site,
        date: null, billed_through: p.billed_through, status: 'OPEN', note: p.note });
    }
    // RENTAL-RETURN, SCHEDULED — the second, already claimed.
    if (pickupUnits[1]) {
      const p = pickups[1];
      move({ id: `m-pu-${p.serial}`, kind: 'PICKUP', source: 'RENTAL-RETURN', serial: p.serial,
        what: `${p.model} #${p.serial} off-rent`, customer: p.customer, address: p.job_site,
        date: d(1), billed_through: p.billed_through, driver: 'Josh', rig: 'JOSH-LIFTGATE',
        status: 'SCHEDULED', note: p.note });
    }
    // pickups[2] is deliberately NOT on the board: the engine hasn't spawned its
    // row yet. The Dispatch view has to say so rather than let it go quiet.

    // SERVICE-IN, OPEN — ticket 1 said "we pick it up".
    move({ id: 'm-si-2201', kind: 'PICKUP', source: 'SERVICE-IN', ticket: t1.ticket,
      what: `${t1.equipment} in for repair`, customer: t1.customer, address: t1.site,
      date: d(0), status: 'OPEN', note: 'Dock closes at 2, ask for Ray' });

    // SERVICE-OUT, SCHEDULED — ticket 6 goes home. Shares a rig+day with the manual run below.
    move({ id: 'm-so-2202', kind: 'DELIVER', source: 'SERVICE-OUT', ticket: t6.ticket,
      what: `${t6.equipment} back to customer`, customer: t6.customer, address: t6.site,
      date: d(2), driver: 'Kevin', rig: 'TRAILER-6000', status: 'SCHEDULED' });

    // MANUAL, SCHEDULED — same rig, same day. This is the dispatch_warnings pair.
    move({ id: 'm-a1b2c3', kind: 'DELIVER', source: 'MANUAL', serial: units.find((u) => u.unit_state === 'AVAILABLE').serial,
      what: 'Demo unit out to the Beloit plant', customer: 'Quarry Road Aggregates', address: 'Beloit WI',
      date: d(2), driver: 'Kevin', rig: 'TRAILER-6000', status: 'SCHEDULED', note: 'Kevin riding along for the walkthrough' });

    dispatch_warnings.push({ rig: 'TRAILER-6000', date: d(2), ids: ['m-so-2202', 'm-a1b2c3'] });

    // MANUAL, DONE — a parts run, no unit and no ticket. Lingers 7 days.
    move({ id: 'm-d4e5f6', kind: 'PICKUP', source: 'MANUAL',
      what: 'Parts pickup — Milwaukee supplier', customer: 'Halstead Parts Depot', address: 'Milwaukee WI',
      date: d(-2), driver: 'Zac', rig: 'JOSH-LIFTGATE', status: 'DONE', done: d(-2),
      note: 'Picked up both pump assemblies' });
  }

  // The seven-stage rollup the Service tab draws its column counts from.
  // COMPLETE is "closed in the last 7 days", not an open-work count (CLAUDE.md).
  const SERVICE_STAGES = ['INTAKE', 'INSPECTION', 'QUOTED', 'PARTS-ORDERED', 'IN-PROGRESS', 'READY-TO-INVOICE', 'COMPLETE'];
  const service_summary = {
    open_by_stage: Object.fromEntries(SERVICE_STAGES.map((s) => [s, service_queue.filter(
      (t) => t.stage === s && (s === 'COMPLETE' ? true : t.status === 'OPEN')).length])),
    open_customer: service_queue.filter((t) => t.status === 'OPEN' && t.machine_owner === 'CUSTOMER').length,
    open_wss: service_queue.filter((t) => t.status === 'OPEN' && t.machine_owner === 'WSS').length,
  };

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
      schema_version: 3,
      generated_at: new Date().toISOString(),
      run_id: `mock-${withServiceQueue ? 'full' : 'empty'}-${new Date().toISOString().slice(0, 10)}`,
      fleet_totals: totals,
      // Deliberate unknown field — the app must ignore it silently.
      mock: true,
    },
    categories: CATEGORIES,
    units,
    agreements,
    reservations,
    pickups,
    service_queue,
    service_summary,
    dispatch,
    dispatch_warnings,
    // Still emitted for the engine's own consumers; the app must NOT render it (D39).
    billing: { due_next_7_days, created_last_run },
  };
}

/**
 * The pre-Dispatch snapshot, rebuilt from a schema-3 one. Kept for one release
 * so a board pointed at a stale KV value still renders during the cutover:
 * the old six-stage service queue with `ticket_id` / `unit_desc`, the singular
 * `units[].reservation` mirror, and none of the schema-3 arrays.
 */
function downgradeToSchema2(s3) {
  const OLD_STAGES = ['INTAKE', 'DIAGNOSED', 'AWAITING-PARTS', 'IN-PROGRESS', 'READY-TO-INVOICE', 'DONE'];
  const snap = JSON.parse(JSON.stringify(s3));

  snap.meta.schema_version = 2;
  snap.meta.run_id = `mock-legacy-${new Date().toISOString().slice(0, 10)}`;

  for (const u of snap.units) {
    const cur = u.reservations.find((h) => h.status === 'current') || u.reservations.find((h) => h.status === 'future');
    u.reservation = cur
      ? { held_by: cur.held_by, purpose: cur.purpose, customer: cur.customer, until: cur.end }
      : { held_by: null, purpose: null, customer: null, until: null };
  }

  snap.service_queue = s3.service_queue.map((t, i) => ({
    ticket_id: `SVC-${1200 + i}`,
    customer: t.customer,
    serial: t.serial,
    unit_desc: t.equipment,
    stage: OLD_STAGES[i % OLD_STAGES.length],
    assigned: t.assigned || 'Josh',
    opened: t.opened,
    quote: t.quote ? t.quote.amount : null,
    machinio_ref: t.machinio_ref,
  }));
  // The old snapshot pointed units at the old ticket ids.
  const bySerial = new Map(snap.service_queue.filter((t) => t.serial).map((t) => [String(t.serial), t.ticket_id]));
  for (const u of snap.units) u.service_ticket = bySerial.get(String(u.serial)) || null;

  delete snap.service_summary;
  delete snap.dispatch;
  delete snap.dispatch_warnings;
  return snap;
}

// ------------------------------------------------------------------------ main
const outdir = process.argv[2] || path.join(HERE, '..', 'docs', 'mock');
fs.mkdirSync(outdir, { recursive: true });

const full = build({ withServiceQueue: true });
const empty = build({ withServiceQueue: false });

for (const [name, snapshot] of [
  ['mock-full.json', full],
  ['mock-empty.json', empty],
  ['mock-legacy.json', downgradeToSchema2(full)],
]) {
  const file = path.join(outdir, name);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(
    `${name}: schema ${snapshot.meta.schema_version} · ${snapshot.units.length} units, ` +
    `${snapshot.agreements.length} agreements, ${snapshot.service_queue.length} tickets, ` +
    `${(snapshot.dispatch || []).length} dispatch rows -> ${path.relative(process.cwd(), file)}`
  );
}

// Sample UNAPPLIED events, shaped exactly as the Worker stores them. This is not
// part of the snapshot contract — the Worker returns pending separately — so it
// gets its own file, loaded only by ?mock=full&pending=1.
const avail = full.units.filter((u) => u.unit_state === 'AVAILABLE');
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
const pending = [
  {
    id: 'evt-mock-1',
    ts: ago(180),
    actor: 'Kevin', role: 'sales',
    action: 'reserve', serial: avail[0].serial,
    payload: { customer: 'Ironwood Packaging', purpose: 'quote hold', start: d(3), end: d(6) },
  },
  {
    id: 'evt-mock-2',
    ts: ago(40),
    actor: 'Josh', role: 'service',
    action: 'readiness', serial: avail[1].serial,
    payload: { readiness: 'NEEDS-PREP', note: 'squeegee blades ordered' },
  },
  // The one write with no id of its own: the engine assigns the ticket number.
  // The Service tab has to badge it as a synthetic INTAKE card (§3.1, §8).
  {
    id: 'evt-mock-3',
    ts: ago(12),
    actor: 'Josh', role: 'service',
    action: 'ticket_open', serial: null,
    payload: {
      machine_owner: 'CUSTOMER', serial: null, equipment: 'Halstead T-320 (customer owned)',
      customer: 'Northgate Fulfillment', issue: 'Batteries not holding a charge overnight',
      priority: 'HIGH', site: 'Sun Prairie WI', location: 'AT-CUSTOMER',
      intake_move: 'PICKUP', return_move: 'DELIVER',
    },
  },
  // A claim on an existing row -> the row badges pending and stays in Open.
  {
    id: 'evt-mock-4',
    ts: ago(6),
    actor: 'Kevin', role: 'sales',
    action: 'dispatch_claim', serial: null,
    payload: { dispatch_id: 'm-si-2201', rig: 'TRAILER-6000', date: d(1), driver: 'Kevin' },
  },
  // A stage move on a ticket -> the ticket badges pending, the card does not move.
  {
    id: 'evt-mock-5',
    ts: ago(3),
    actor: 'Zac', role: 'service',
    action: 'ticket_update', serial: null,
    payload: { ticket: 'S1004', stage: 'IN-PROGRESS', note: 'Pump landed early' },
  },
];
const pfile = path.join(outdir, 'mock-pending.json');
fs.writeFileSync(pfile, JSON.stringify(pending, null, 2) + '\n');
console.log(`mock-pending.json: ${pending.length} unapplied events -> ${path.relative(process.cwd(), pfile)}`);
