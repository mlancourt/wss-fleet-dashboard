#!/usr/bin/env node
/**
 * make-mock-data.js — FAKE dashboard snapshot generator (schema_version 5).
 *
 * EVERYTHING in this file is invented. Fake customers, fake serials, fake money.
 * No real WSS data may ever be pasted in here — see CLAUDE.md rule 1.
 *
 * Emits three variants so every view can be exercised:
 *   mock-full.json    schema 5 — service queue, dispatch board, pick-ups, holds, leads
 *   mock-empty.json   schema 5 — service_queue: [], dispatch: [] and leads: [] (empty
 *                     states); ON-DEMO row = 0 on the status board
 *   mock-legacy.json  schema 2 — the pre-Dispatch snapshot, kept for one release
 *                     so the board still renders during the cutover
 *
 * Coverage guaranteed by construction:
 *   - all 9 categories, in display order
 *   - every unit_state: AVAILABLE RESERVED ON-RENT ON-DEMO LOANER-OUT IN-SHOP RETIRED
 *   - every readiness: READY NEEDS-PREP DOWN NEEDS-PICKUP
 *   - an agreements row with "agreement": null  (unbilled-rental alert)
 *   - D45: NO acquisition_cost and NO book on any unit, fleet_totals is a count
 *     only, and meta.utilization carries percentages with no amounts. One
 *     rentable unit is left out of the generator's cost ledger (full variant
 *     only) so utilization.dollars.excluded is non-zero and the footnote shows
 *   - a split-cycle invoice ("R....-7.1") and a bare QBO invoice number
 *   - a LOANER-OUT unit with an agreement number and NO agreements row
 *   - category cards that land on each of the green / yellow / red lights
 *   - D32: ON-RENT units with readiness NEEDS-PICKUP and matching pickups[]
 *     entries (full variant); the empty variant has none
 *   - Reservations v2: a unit with zero holds · one CURRENT hold (state RESERVED) ·
 *     only-FUTURE holds while AVAILABLE (the trap) · ON-RENT with two future holds ·
 *     an EXPIRED hold still holding the unit · four holds on one unit ·
 *     one MALFORMED hold; top-level rollup to match
 *   - schema 3 service: a ticket in every one of the nine stages (D47's
 *     NEEDS-QUOTE twice, so the new column is never one deep, and CUSTOMER-owned
 *     both times — a WSS machine can never take it) · both
 *     machine_owners (a WSS ticket on a DOWN in-shop unit, and one on a unit
 *     that's out on rent) · a HIGH customer ticket with intake_move PICKUP and
 *     its SERVICE-IN row · a READY-TO-INVOICE ticket with a SERVICE-OUT DELIVER
 *     row · a CLOSED ticket · a ticket needing no truck at all
 *   - D46: an OPEN DELIVER row dated later than the OPEN pick-ups, so the board
 *     visibly leads with deliveries
 *   - schema 3 dispatch: all three statuses, all four sources, a RENTAL-RETURN
 *     row tied to a NEEDS-PICKUP unit that is also in pickups[], one pick-up NOT
 *     yet on the board, and a dispatch_warnings entry naming two SCHEDULED rows
 *     on the same rig the same day
 *   - NO `reservation` singular anywhere at schema 3 (the legacy file has it)
 *   - schema 5 leads: thirteen leads across every stage and status · two stale
 *     (one red, one yellow) · one `suggest_dead` · one WON inside this month ·
 *     two LOST with reasons and one DEAD · a SERVICE lead and a PARTS lead with
 *     `value: null` and therefore `potential_commission: null` · a lead whose
 *     `demo.hold_id` matches a real DEMO hold on a real unit (§4) · a lead
 *     pointing at a live service ticket · a `scoreboard` and `insights` DERIVED
 *     from those rows, so the tab's totals and the cards agree. The empty
 *     variant ships `leads: []` with zeroed money and every rate/median null —
 *     the real snapshot's shape on a quiet day, which is NOT the same as the
 *     legacy file's total absence of the keys.
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

// A log row's `ts` (v2.4) is a DISPLAY STRING the engine has already formatted
// for a Central reader — "2026-09-04 11:09 CT", or a bare date on an imported
// row that only knew the day. It is not an instant and not a business date, so
// the fixture builds both shapes as text and the site renders them verbatim.
const ts = (offsetDays, hhmm) => (hhmm ? `${d(offsetDays)} ${hhmm} CT` : d(offsetDays));
/** `{ts, who, text}` rows, oldest first — the order the engine publishes. */
const logOf = (rows) => rows.map(([t, who, text]) => ({ ts: t, who: who || null, text }));

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
  // serial -> { cost, book }. Returned BESIDE the snapshot, never inside it, so
  // there is no path by which these get serialised into a published file (D45).
  // The engine holds the equivalent in the vault.
  const ledger = new Map();
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

      // Cost and book are generated but NEVER emitted (schema 4, D45). Cost is
      // kept on the side purely so the generator can compute meta.utilization
      // the way the engine does — the same numbers, none of them published.
      const cost = money(4000, 26000, 100);
      const book = Math.round(cost * (0.45 + rand() * 0.4));
      const ask = Math.round(book * (1.25 + rand() * 0.3) / 50) * 50;
      ledger.set(serial, { cost, book });

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
        ask,   // schema 4 (D45): acquisition_cost and book do NOT ship. `ask` stays.
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

  // D44: one rentable unit with NO acquisition cost, in the full variant only.
  // The dollar-utilization bar must skip it on both sides and footnote it — the
  // empty variant keeps every cost so the no-footnote path is covered too.
  if (withServiceQueue) {
    const costless = units.find((u) => u.status === 'RENTAL' && u.unit_state === 'AVAILABLE');
    if (costless) ledger.delete(costless.serial);
  }

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
    return h;
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
  // schema 5 §4: a DEMO hold a lead booked. The unit stays AVAILABLE (the hold
  // is future), and leads[].demo.hold_id points back at this id — which is the
  // ONLY thing that links the two.
  const demoHold = hold(availReady[1], 3, 3,
    { purpose: 'DEMO — customer site', customer: 'Cedar Ridge Foods', held_by: 'Kevin' });
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
        stage: 'RECEIVED',
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
        // v2.4: the ticket body as {ts, who, text}, oldest first. Most tickets
        // have none — an empty log must render the empty state, not a gap.
        log: [],
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

    // 1 — RECEIVED, HIGH, customer machine still at their plant: we go get it. (SERVICE-IN below)
    const t1 = ticket({
      stage: 'RECEIVED', priority: 'HIGH', customer: 'Ironwood Packaging',
      equipment: 'Nordvale SC-2400 (customer owned)', issue: 'Scrubber dead — no power at key switch, whole line is mopping by hand',
      location: 'AT-CUSTOMER', site: 'Watertown WI', intake_move: 'PICKUP', return_move: 'DELIVER',
      opened: -1, assigned: 'Josh',
      log: logOf([
        [ts(-1, '07:42'), 'Kevin', 'opened by Kevin (RECEIVED, PHONE): Scrubber dead, no power at the key switch. Whole line is mopping by hand.'],
        // An imported row with no author and only a day — both shapes the site
        // has to render verbatim.
        [ts(-1), null, 'import note: called the shop line at 07:38, asked for Josh by name.'],
        [ts(0, '08:15'), 'Josh', 'Josh: Truck is booked for this afternoon. Bringing the spare key switch and a charger just in case.'],
      ]),
    });

    // 2 — CONTACTED on one of ours, DOWN in the shop.
    ticket({
      stage: 'CONTACTED', unit: shopDown, customer: 'WSS',
      issue: 'Traction motor pulled — checking the controller before we order',
      location: 'IN-SHOP', intake_move: 'NONE', return_move: 'NONE',
      priority: 'MEDIUM', assigned: 'Zac', opened: -9,
    });

    // 3 — WAITING-ON-CUSTOMER: customer machine, quote sent, waiting on their yes.
    ticket({
      stage: 'WAITING-ON-CUSTOMER', customer: 'Fairmont Dairy', equipment: 'Halstead R-660 (customer owned)',
      issue: 'Squeegee frame bent, deck actuator leaking', location: 'IN-SHOP',
      intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP', assigned: 'Josh', opened: -12,
      quote: { number: 'Q-2211', amount: 2480, sent: d(-6), approved: null },
      machinio_ref: 'MCH-74210',
    });

    // 4 — WAITING-ON-PARTS: the wait state that eats a shop.
    ticket({
      stage: 'WAITING-ON-PARTS', customer: 'Lakeshore Beverage', equipment: 'Meridian T-500 (customer owned)',
      issue: 'Pump assembly failed', location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP',
      return_move: 'DELIVER', assigned: 'Zac', opened: -18, scheduled: d(4),
      quote: { number: 'Q-2198', amount: 1140, sent: d(-15), approved: d(-13) },
      parts: 'Pump assy 41-2207 — ETA Thursday, backordered once already',
      log: logOf([
        [ts(-13, '11:02'), 'Zac', 'Zac: Quote approved over the phone. Pump ordered.'],
        [ts(-4, '16:30'), null, 'supplier note: backordered a second time, new ETA Thursday.'],
      ]),
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

    // 8 — a second RECEIVED card, LOW, no truck involved at any point.
    ticket({
      stage: 'RECEIVED', priority: 'LOW', customer: 'Maplewood Schools',
      equipment: 'Nordvale BX-27 (customer owned)', issue: 'Dropping water on the right side',
      location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP', opened: -4,
    });

    // 9 — a second IN-PROGRESS card so a column isn't always one deep.
    ticket({
      stage: 'IN-PROGRESS', customer: 'Granite Peak Warehouse', equipment: 'Meridian R-880 (customer owned)',
      issue: 'Wheel drive noise; teardown started', location: 'IN-SHOP',
      intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP', assigned: 'Zac', opened: -7,
    });

    // 10 — SCHEDULED (D42): parts are in and the day is booked, but nobody has
    // picked up a wrench yet. Without this the SCHEDULED column is never drawn
    // with anything in it.
    ticket({
      stage: 'SCHEDULED', customer: 'Redtail Automotive', equipment: 'Cascade Clean T-500 (customer owned)',
      issue: 'Drive belt + idler pulley — parts in, on the bench Tuesday',
      location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP', return_move: 'DELIVER',
      assigned: 'Josh', opened: -10, scheduled: d(3),
      quote: { number: 'Q-2205', amount: 640, sent: d(-8), approved: d(-6) },
    });

    // 11 + 12 — NEEDS-QUOTE (D47): diagnosed, and now the ball is in OUR court
    // because Matt owes them a number. Two of them, so the new column is never
    // one deep — and both CUSTOMER-owned, because a WSS machine can never take
    // this stage (nobody quotes us to us).
    ticket({
      stage: 'NEEDS-QUOTE', customer: 'Birchwood Cold Storage',
      equipment: 'Halstead SW-900 (customer owned)',
      issue: 'Both drive motors worn — priced the pair, waiting on Matt for the number',
      location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP',
      assigned: 'Josh', opened: -6, stage_since: -2, priority: 'HIGH',
      log: logOf([
        [ts(-6, '13:20'), 'Matt', 'opened by Matt (RECEIVED): Dropped off. Customer says it crawls and pulls right.'],
        [ts(-5, '09:05'), 'Josh', 'Josh RECEIVED \u2192 CONTACTED: Called Dana, confirmed they want it looked at before any work.'],
        [ts(-4, '15:48'), 'Josh', 'Josh: Pulled both drive motors. Left one has scored brushes and the commutator is pitted; right one is worn but serviceable for now. Recommend replacing the pair \u2014 doing one and coming back costs them a second teardown.'],
        [ts(-2, '10:12'), 'Josh', 'Josh CONTACTED \u2192 NEEDS-QUOTE: Parts priced, labour is about six hours. Matt owes them a number.'],
      ]),
    });
    ticket({
      stage: 'NEEDS-QUOTE', customer: 'Stillman Foundry',
      equipment: 'Ironline R-660 (customer owned)',
      issue: 'Deck rebuild — teardown done, parts list handed over',
      location: 'AT-CUSTOMER', site: 'Waukesha WI', intake_move: 'PICKUP', return_move: 'DELIVER',
      assigned: 'Zac', opened: -13, stage_since: -5, priority: 'LOW',
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

    // MANUAL, DELIVER, OPEN — unclaimed, and dated LATER than the open pick-ups
    // below it, so the board demonstrates D46: deliveries lead regardless of date.
    move({ id: 'm-de-2203', kind: 'DELIVER', source: 'MANUAL',
      what: 'Loaner out to the Jefferson plant', customer: 'Juniper Metalworks', address: 'Jefferson WI',
      date: d(4), status: 'OPEN', note: 'They open at 6; ask for the maintenance lead' });

    // MANUAL, DONE — a parts run, no unit and no ticket. Lingers 7 days.
    move({ id: 'm-d4e5f6', kind: 'PICKUP', source: 'MANUAL',
      what: 'Parts pickup — Milwaukee supplier', customer: 'Halstead Parts Depot', address: 'Milwaukee WI',
      date: d(-2), driver: 'Zac', rig: 'JOSH-LIFTGATE', status: 'DONE', done: d(-2),
      note: 'Picked up both pump assemblies' });
  }

  // The nine-stage rollup the Service tab draws its column counts from.
  // COMPLETE is "closed in the last 7 days", not an open-work count (CLAUDE.md).
  const SERVICE_STAGES = ['RECEIVED', 'CONTACTED', 'NEEDS-QUOTE', 'WAITING-ON-CUSTOMER', 'WAITING-ON-PARTS', 'SCHEDULED', 'IN-PROGRESS', 'READY-TO-INVOICE', 'COMPLETE'];
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

  // ------------------------------------------------------- leads (schema 5)
  const { leads, leads_summary, scoreboard, insights } =
    buildLeads({ withLeads: withServiceQueue, demoHold, demoUnit: availReady[1], service_queue });

  // schema 4: a count and nothing else. No cost, no book, no ask (D45).
  const totals = { units: units.length };

  // meta.utilization, computed the way the engine computes it — from costs the
  // snapshot never carries. Percentages and an exclusion count only: no amount
  // appears here, so no amount can be reconstructed from the published file.
  const rentable = units.filter((u) => u.status === 'RENTAL' && u.unit_state !== 'RETIRED');
  const rentedOut = rentable.filter((u) => u.unit_state === 'ON-RENT');
  const costOf = (u) => (ledger.get(u.serial) || {}).cost;
  const withCost = rentable.filter((u) => typeof costOf(u) === 'number');
  const sumCost = (list) => list.reduce((n, u) => n + costOf(u), 0);
  const dollarTotal = sumCost(withCost);
  const utilization = {
    units: { on_rent: rentedOut.length, total: rentable.length,
      pct: rentable.length ? Math.round((rentedOut.length / rentable.length) * 100) : null },
    dollars: {
      pct: dollarTotal ? Math.round((sumCost(withCost.filter((u) => u.unit_state === 'ON-RENT')) / dollarTotal) * 100) : null,
      excluded: rentable.length - withCost.length,
    },
  };

  const snapshot = {
    meta: {
      schema_version: 5,
      generated_at: new Date().toISOString(),
      run_id: `mock-${withServiceQueue ? 'full' : 'empty'}-${new Date().toISOString().slice(0, 10)}`,
      fleet_totals: totals,
      utilization,
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
    // schema 5 (Leads spec §2). Additive: everything above is byte-identical.
    leads,
    leads_summary,
    scoreboard,
    insights,
  };

  return { snapshot, ledger };
}

/* --------------------------------------------------------- leads (schema 5)
 * Hand-built, not generated: §8 of the work order names the exact cases the
 * Leads tab has to survive, and a random walk can't promise them.
 *
 * The engine derives ages, staleness, medians and percentages from a lead's
 * stage history. There is no history here — the derived fields are written
 * directly, chosen so the scoreboard and the insights tables agree with the
 * leads[] rows a reader can count for themselves.
 *
 * `withLeads: false` produces the shape the REAL snapshot has on a quiet day:
 * no leads at all, money rows that are zero, and every rate/median null with
 * `insufficient: true`. That is the empty state the tab must render — not an
 * absent key, which is what a schema-4 snapshot looks like instead.
 */

// Commission is engine-computed from the deal value. Reproduced here only so
// the mock's numbers add up; the site never does this arithmetic.
const COMMISSION_RATES = { 'SALE-NEW': 0.045, 'SALE-USED': 0.045, RENTAL: 0.07 };
const LEAD_STAGE_LIST = ['RECEIVED', 'CONTACTED', 'QUOTED', 'DEMO-SCHEDULED', 'INVOICED'];
const LEAD_SOURCE_LIST = ['WEB-FORM', 'PAID-SEARCH', 'PHONE', 'EMAIL', 'WALK-IN', 'REFERRAL', 'OUTBOUND', 'SERVICE-UPSELL', 'MACHINIO'];
const LEAD_INTEREST_LIST = ['SALE-NEW', 'SALE-USED', 'RENTAL', 'SERVICE', 'PARTS'];
const LEAD_LOST_REASONS = ['PRICE', 'COMPETITOR', 'NO-BUDGET', 'TIMING', 'OTHER'];
const LEAD_ASSIGNEES = ['Kevin', 'Matt'];

/** An instant, N days back and at a plausible hour — `stage_since` is a datetime. */
const dt = (daysBack, hour = 14) => new Date(TODAY - daysBack * DAY + hour * 3600000).toISOString();
/** "2026-09" for N months back. Built from parts; never string-sliced arithmetic. */
function monthBack(n) {
  const now = new Date(TODAY);
  const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return m.toISOString().slice(0, 7);
}
const median = (nums) => {
  const a = nums.filter((n) => typeof n === 'number').sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round(((a[mid - 1] + a[mid]) / 2) * 10) / 10;
};

function buildLeads({ withLeads, demoHold, demoUnit, service_queue }) {
  const commissionOf = (interest, value) => {
    const rate = COMMISSION_RATES[interest];
    // null when unset OR when the interest earns no commission (SERVICE/PARTS).
    return rate == null || value == null ? null : Math.round(value * rate * 100) / 100;
  };

  const mk = (o) => {
    const value = o.value == null ? null : o.value;
    return {
      lead: o.lead,
      status: o.status || 'OPEN',
      stage: o.stage,
      customer: o.customer,
      contact: o.contact || null,
      phone: o.phone || null,
      email: o.email || null,
      site: o.site || null,
      source: o.source,
      interest: o.interest,
      machine: o.machine || null,
      serial: o.serial || null,
      value,
      potential_commission: commissionOf(o.interest, value),
      quote: o.quote || null,
      demo: o.demo || null,
      assigned: o.assigned || 'Kevin',
      priority: o.priority || 'MEDIUM',
      next_action: o.next_action || null,
      opened: d(-o.totalDays),
      opened_by: o.opened_by || 'Kevin',
      stage_since: dt(o.stageDays, 10),
      first_contact: o.contactHours == null ? null : dt(o.totalDays - (o.contactHours / 24), 9),
      hours_to_contact: o.contactHours == null ? null : o.contactHours,
      age_in_stage_days: o.stageDays,
      age_total_days: o.totalDays,
      stale: o.stale || null,
      stale_reason: o.stale_reason || null,
      suggest_dead: !!o.suggest_dead,
      closed: o.closedDays == null ? null : d(-o.closedDays),
      close_reason: o.close_reason || null,
      close_note: o.close_note || null,
      invoice: o.invoice || null,
      machinio_ref: o.machinio_ref || null,
      related_ticket: o.related_ticket || null,
      // v2.4: the lead body, same {ts, who, text} shape as a ticket's.
      log: o.log || [],
    };
  };

  const ticket = (service_queue || []).find((t) => t.machine_owner === 'CUSTOMER');

  const leads = !withLeads ? [] : [
    // -- RECEIVED: two nobody has called yet, which is the nav badge's number.
    mk({ lead: 'L1001', stage: 'RECEIVED', customer: 'Cedar Ridge Foods', contact: 'Dana Whitlock',
      phone: '262-555-0148', email: 'dana@cedarridge.example', site: 'Oconomowoc WI 53066',
      source: 'WEB-FORM', interest: 'RENTAL', machine: '28" rider, 3 months', value: 9800,
      priority: 'HIGH', next_action: 'Call this morning', stageDays: 1, totalDays: 1 }),
    mk({ lead: 'L1002', stage: 'RECEIVED', customer: 'Bellmont Distribution', contact: 'Ray Ackerman',
      phone: '414-555-0192', site: 'Franklin WI 53132', source: 'PAID-SEARCH', interest: 'SALE-NEW',
      machine: 'Walk-behind, 20" disk', value: 12400, assigned: 'Matt', opened_by: 'Matt',
      stale: 'yellow', stale_reason: 'Four business days in Received with no call logged',
      next_action: 'Nobody has called — do it today', stageDays: 4, totalDays: 4 }),

    // -- CONTACTED: one healthy, one rotting hard enough that the engine says so.
    mk({ lead: 'L1003', stage: 'CONTACTED', customer: 'Northgate Fulfillment', contact: 'Priya Raman',
      phone: '608-555-0117', email: 'praman@northgate.example', site: 'Sun Prairie WI 53590',
      source: 'PHONE', interest: 'RENTAL', machine: 'Rider scrubber, 6 weeks', value: 7350,
      contactHours: 1.5, next_action: 'Send the weekly rate sheet', stageDays: 2, totalDays: 3 }),
    mk({ lead: 'L1004', stage: 'CONTACTED', customer: 'Juniper Metalworks', contact: 'Tom Beier',
      phone: '920-555-0163', site: 'Jefferson WI 53549', source: 'MACHINIO', interest: 'SALE-USED',
      machine: 'Used 32" rider under $18k', value: 16500, assigned: 'Matt', opened_by: 'Matt',
      contactHours: 26, stale: 'red', stale_reason: 'Eleven business days since the last contact',
      suggest_dead: true, machinio_ref: 'MCH-88421', next_action: null, stageDays: 11, totalDays: 14,
      log: logOf([
        [ts(-14), null, 'imported from Machinio MCH-88421: enquiry on a used 32" rider.'],
        [ts(-13, '09:10'), 'Matt', 'Matt RECEIVED \u2192 CONTACTED: Left a voicemail.'],
        [ts(-8, '09:15'), 'Matt', 'Matt: Second voicemail. No callback.'],
      ]) }),

    // -- QUOTED: one with the quote object filled in, one big one.
    mk({ lead: 'L1005', stage: 'QUOTED', customer: 'Harbor Line Logistics', contact: 'Marcus Idle',
      phone: '262-555-0175', email: 'm.idle@harborline.example', site: 'Kenosha WI 53142',
      source: 'REFERRAL', interest: 'SALE-NEW', machine: 'Nordvale SC-2400', value: 28900,
      quote: { number: '990142', file: null, sent: d(-5) }, contactHours: 3,
      next_action: 'Follow up Thursday', stageDays: 5, totalDays: 9,
      log: logOf([
        [ts(-9, '08:50'), 'Kevin', 'opened by Kevin (RECEIVED, REFERRAL): Sent over by Harbor Line\u2019s maintenance lead.'],
        [ts(-9, '11:55'), 'Kevin', 'Kevin RECEIVED \u2192 CONTACTED: Talked to Marcus. Two shifts, tile and sealed concrete, wants a rider.'],
        [ts(-5, '14:03'), 'Kevin', 'Kevin value \u2192 $28,900.00'],
        [ts(-5, '14:06'), 'Kevin', 'Kevin CONTACTED \u2192 QUOTED: Quote 990142 sent. He is taking it to their CFO Thursday.'],
      ]) }),
    mk({ lead: 'L1006', stage: 'QUOTED', customer: 'Quarry Road Aggregates', contact: 'Lena Faust',
      phone: '608-555-0134', site: 'Beloit WI 53511', source: 'OUTBOUND', interest: 'RENTAL',
      machine: 'Two riders, 6 months', value: 41200, priority: 'HIGH',
      quote: { number: '990139', file: null, sent: d(-2) }, contactHours: 0.5,
      next_action: 'They want a long-term number', stageDays: 2, totalDays: 12 }),

    // -- DEMO-SCHEDULED: one wired to a real hold (§4), one wired to a ticket.
    mk({ lead: 'L1007', stage: 'DEMO-SCHEDULED', customer: 'Cedar Ridge Foods', contact: 'Dana Whitlock',
      phone: '262-555-0148', site: 'Oconomowoc WI 53066', source: 'WALK-IN', interest: 'SALE-NEW',
      machine: demoUnit ? `${demoUnit.brand} ${demoUnit.model}` : 'Rider scrubber',
      serial: demoUnit ? demoUnit.serial : null, value: 24600, priority: 'HIGH',
      demo: demoHold ? { date: demoHold.start, serial: demoUnit.serial, hold_id: demoHold.id } : null,
      contactHours: 2, next_action: 'Confirm the dock time', stageDays: 1, totalDays: 6 }),
    mk({ lead: 'L1008', stage: 'DEMO-SCHEDULED', customer: 'Ironwood Packaging', contact: 'Sal Kittredge',
      phone: '414-555-0128', email: 'sal@ironwoodpack.example', site: 'Milwaukee WI 53207',
      source: 'SERVICE-UPSELL', interest: 'RENTAL', machine: 'Compact walk-behind', value: 5400,
      assigned: 'Matt', contactHours: 4.5, related_ticket: ticket ? ticket.ticket : null,
      next_action: 'Demo Tuesday, bring the small pad driver', stageDays: 3, totalDays: 11 }),

    // -- a SERVICE lead: no value, and therefore no commission, by contract.
    mk({ lead: 'L1009', stage: 'CONTACTED', customer: 'Meadowbrook Care', contact: 'Gail Ostrander',
      email: 'gostrander@meadowbrook.example', site: 'Waukesha WI 53186', source: 'EMAIL',
      interest: 'SERVICE', machine: 'Their own Halstead T-320', value: null,
      contactHours: 6, next_action: 'Quote the annual PM', stageDays: 3, totalDays: 3 }),

    // -- the win: stage INVOICED, status WON, closed inside this month.
    mk({ lead: 'L1010', stage: 'INVOICED', status: 'WON', customer: 'Lakeshore Bottling', contact: 'Erik Nyholm',
      phone: '920-555-0181', site: 'Sheboygan WI 53081', source: 'REFERRAL', interest: 'SALE-NEW',
      machine: 'Ironline T-500', value: 31500, invoice: '990665', quote: { number: '990131', file: null, sent: d(-19) },
      contactHours: 0.75, closedDays: 4, close_reason: 'WON', close_note: 'Took the demo unit',
      stageDays: 4, totalDays: 23 }),

    // -- two losses with reasons, and one that simply went quiet.
    mk({ lead: 'L1011', stage: 'QUOTED', status: 'LOST', customer: 'Prairie State Millwork', contact: 'Hank Obuya',
      site: 'Janesville WI 53545', source: 'PAID-SEARCH', interest: 'SALE-USED', machine: 'Used 26" rider',
      value: 14750, contactHours: 5, closedDays: 3, close_reason: 'PRICE',
      close_note: 'Came in $2,400 under us on a private sale', stageDays: 3, totalDays: 17 }),
    mk({ lead: 'L1012', stage: 'QUOTED', status: 'LOST', customer: 'Blue Fox Brewing', contact: 'Marta Reyes',
      site: 'Madison WI 53713', source: 'WEB-FORM', interest: 'RENTAL', machine: 'Walk-behind, 2 months',
      value: 4300, assigned: 'Matt', contactHours: 22, closedDays: 9, close_reason: 'COMPETITOR',
      close_note: 'Went with the Madison dealer for the shorter drive', stageDays: 9, totalDays: 26 }),
    // The fifth closed lead in the window, which is what tips `insufficient`
    // false and makes the conversion row and the insights tables render with
    // real numbers. Below five they must all read "not enough data" instead —
    // that path is the empty variant's job.
    mk({ lead: 'L1014', stage: 'CONTACTED', status: 'LOST', customer: 'Halcyon Print Works', contact: 'Owen Brisk',
      site: 'Racine WI 53403', source: 'PHONE', interest: 'SALE-NEW', machine: 'Nordvale SC-1700',
      value: 19800, contactHours: 8, closedDays: 12, close_reason: 'NO-BUDGET',
      close_note: 'Capital freeze until the new fiscal year', stageDays: 12, totalDays: 30 }),
    mk({ lead: 'L1013', stage: 'RECEIVED', status: 'DEAD', customer: 'Fenwick Auto Group',
      site: 'Brookfield WI 53045', source: 'MACHINIO', interest: 'PARTS', machine: 'Squeegee blades, unknown model',
      value: null, machinio_ref: 'MCH-88109', closedDays: 6, close_reason: 'SILENT',
      close_note: 'Three calls, no answer', stageDays: 6, totalDays: 21 }),
  ];

  /* ---- everything below is DERIVED from the rows above, so the tab's numbers
     and the cards a reader can count always agree. ---- */

  const open = leads.filter((l) => l.status === 'OPEN');
  const won = leads.filter((l) => l.status === 'WON');
  const lost = leads.filter((l) => l.status === 'LOST');
  const dead = leads.filter((l) => l.status === 'DEAD');
  const stale = leads.filter((l) => l.stale === 'red' || l.stale === 'yellow');
  const sum = (list, key) => Math.round(list.reduce((n, l) => n + (l[key] || 0), 0) * 100) / 100;
  const openByStage = Object.fromEntries(LEAD_STAGE_LIST.slice(0, 4)
    .map((s) => [s, open.filter((l) => l.stage === s).length]));

  const leads_summary = {
    open_by_stage: openByStage,
    received_uncontacted: open.filter((l) => l.stage === 'RECEIVED' && !l.first_contact).length,
    stale_count: stale.length,
    closed_recent: { WON: won.length, LOST: lost.length, DEAD: dead.length },
    money_fields: ['value', 'potential_commission'],
    stages: LEAD_STAGE_LIST,
    sources: LEAD_SOURCE_LIST,
    interests: LEAD_INTEREST_LIST,
    lost_reasons: LEAD_LOST_REASONS,
    assignees: LEAD_ASSIGNEES,
    commission_rates: COMMISSION_RATES,
  };

  const contacted = leads.filter((l) => typeof l.hours_to_contact === 'number');
  const closedForRates = won.length + lost.length + dead.length;
  const enoughToRate = closedForRates >= 5;

  const scoreboard = {
    money: {
      on_table_value: sum(open, 'value'),
      on_table_commission: sum(open, 'potential_commission'),
      this_month_won_value: sum(won, 'value'),
      this_month_commission: sum(won, 'potential_commission'),
      baseline: {
        months: [monthBack(1), monthBack(2), monthBack(3)],
        won_count_avg: withLeads ? 1.7 : 0,
        won_value_avg: withLeads ? 24300 : 0,
        commission_avg: withLeads ? 1150.5 : 0,
      },
    },
    this_month: { month: monthBack(0), won_count: won.length, baseline_won_count_avg: withLeads ? 1.7 : 0 },
    speed: {
      median_hours_to_contact: median(contacted.map((l) => l.hours_to_contact)),
      n: contacted.length,
      window_days: 30,
      same_day_streak: withLeads ? 4 : 0,          // >= 3 lights the 🔥
    },
    conversion: {
      window_days: 90,
      n: closedForRates,
      received_to_quoted_pct: enoughToRate ? 62 : null,
      quoted_to_won_pct: enoughToRate ? 33 : null,
      median_days_to_win: enoughToRate ? 21 : null,
      insufficient: !enoughToRate,
    },
    stale: {
      count: stale.length,
      red: stale.filter((l) => l.stale === 'red').length,
      yellow: stale.filter((l) => l.stale === 'yellow').length,
      leads: stale.map((l) => l.lead),
    },
    open: { count: open.length, by_stage: openByStage },
  };

  // A group-by that mirrors what the engine publishes: counts, a win rate that
  // is null until there is something to divide, and won_value as DEAL SIZE —
  // which is why insights survives the §6 money strip untouched.
  const groupBy = (key) => {
    const out = {};
    for (const l of leads) {
      const k = l[key];
      if (!k) continue;
      const g = out[k] || (out[k] = { leads: 0, won: 0, lost: 0, won_value: 0, win_rate_pct: null });
      g.leads++;
      if (l.status === 'WON') { g.won++; g.won_value += l.value || 0; }
      if (l.status === 'LOST' || l.status === 'DEAD') g.lost++;
    }
    for (const g of Object.values(out)) {
      const decided = g.won + g.lost;
      g.win_rate_pct = decided ? Math.round((g.won / decided) * 100) : null;
    }
    return out;
  };

  const byInterest = groupBy('interest');
  const wonTotal = won.length;
  byInterest._rental_share_of_wins_pct = wonTotal
    ? Math.round((won.filter((l) => l.interest === 'RENTAL').length / wonTotal) * 100) : null;

  const machines = {};
  for (const l of leads) {
    if (!l.machine) continue;
    const g = machines[l.machine] || (machines[l.machine] = { leads: 0, won: 0 });
    g.leads++;
    if (l.status === 'WON') g.won++;
  }

  const ZIP_RE = /\b(\d{5})\b/;
  const by_zip = {};
  for (const l of leads) {
    const m = l.site && ZIP_RE.exec(l.site);
    if (!m) continue;
    const g = by_zip[m[1]] || (by_zip[m[1]] = { leads: 0, won: 0 });
    g.leads++;
    if (l.status === 'WON') g.won++;
  }

  const lostReasons = {};
  for (const l of lost.concat(dead)) {
    if (!l.close_reason) continue;
    lostReasons[l.close_reason] = (lostReasons[l.close_reason] || 0) + 1;
  }

  const insights = {
    window_days: 90,
    n: leads.length,
    min_n: 5,
    insufficient: !enoughToRate,
    by_source: groupBy('source'),
    by_interest: byInterest,
    machines,
    lost: {
      n: lost.length + dead.length,
      reasons: lostReasons,
      median_value_won: median(won.map((l) => l.value)),
      median_value_lost: median(lost.map((l) => l.value)),
    },
    funnel: {
      median_bdays_in_stage: Object.fromEntries(LEAD_STAGE_LIST.slice(0, 4).map((s) => {
        const rows = leads.filter((l) => l.stage === s);
        return [s, rows.length ? median(rows.map((l) => l.age_in_stage_days)) : null];
      })),
      median_quote_to_decision_bdays: enoughToRate ? 6 : null,
    },
    by_zip,
  };

  return { leads, leads_summary, scoreboard, insights };
}

/**
 * The pre-Dispatch snapshot, rebuilt from a schema-3 one. Kept for one release
 * so a board pointed at a stale KV value still renders during the cutover:
 * the old six-stage service queue with `ticket_id` / `unit_desc`, the singular
 * `units[].reservation` mirror, and none of the schema-3 arrays.
 */
function downgradeToSchema2(s3, ledger) {
  // The PRE-schema-3 vocabulary, verbatim. These are not our stage names any
  // more and must not be renamed with them — the whole point of this file is to
  // be an authentic old snapshot. 'INTAKE' here is correct; leave it alone.
  const OLD_STAGES = ['INTAKE', 'DIAGNOSED', 'AWAITING-PARTS', 'IN-PROGRESS', 'READY-TO-INVOICE', 'DONE'];
  const snap = JSON.parse(JSON.stringify(s3));

  snap.meta.schema_version = 2;
  snap.meta.run_id = `mock-legacy-${new Date().toISOString().slice(0, 10)}`;

  // Schema 2 carried acquisition_cost and book on every unit and a four-part
  // fleet_totals. Put them back from the ledger: this file's only job is to be
  // an authentic OLD snapshot, and it doubles as proof that the page ignores
  // those fields now rather than merely not being sent them. It also has no
  // meta.utilization, so rendering it exercises the client-side fallback.
  delete snap.meta.utilization;
  const totals = { units: 0, cost: 0, book: 0, ask: 0 };
  for (const u of snap.units) {
    const money = (ledger && ledger.get(u.serial)) || {};
    u.acquisition_cost = typeof money.cost === 'number' ? money.cost : null;
    u.book = typeof money.book === 'number' ? money.book : null;
    totals.units += 1;
    totals.cost += u.acquisition_cost || 0;
    totals.book += u.book || 0;
    totals.ask += u.ask || 0;
  }
  snap.meta.fleet_totals = totals;

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
  // Schema 2 predates leads by three schema versions. Their ABSENCE (not an
  // empty array) is what a stale KV value looks like, and the Leads tab has to
  // say so rather than draw an empty board.
  delete snap.leads;
  delete snap.leads_summary;
  delete snap.scoreboard;
  delete snap.insights;
  return snap;
}

// ------------------------------------------------------------------------ main
const outdir = process.argv[2] || path.join(HERE, '..', 'docs', 'mock');
fs.mkdirSync(outdir, { recursive: true });

const full = build({ withServiceQueue: true });
const empty = build({ withServiceQueue: false });

for (const [name, snapshot] of [
  ['mock-full.json', full.snapshot],
  ['mock-empty.json', empty.snapshot],
  ['mock-legacy.json', downgradeToSchema2(full.snapshot, full.ledger)],
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
const avail = full.snapshot.units.filter((u) => u.unit_state === 'AVAILABLE');
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
  // The Service tab has to badge it as a synthetic RECEIVED card (§3.1, §8).
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
  // Zac is deliberately NOT one of the three mock identities (owner=Matt,
  // sales=Kevin, service=Josh), so this event is undoable by nobody on the
  // board — which is how the render test proves the Undo control is per-actor
  // and not merely per-role (D46).
  {
    id: 'evt-mock-5',
    ts: ago(3),
    actor: 'Zac', role: 'service',
    action: 'ticket_update', serial: null,
    payload: { ticket: 'S1004', stage: 'IN-PROGRESS', note: 'Pump landed early' },
  },
  // Matt's own tap, so the owner has something to undo — and something to be
  // refused on (evt-mock-5 above).
  {
    id: 'evt-mock-6',
    ts: ago(2),
    actor: 'Matt', role: 'owner',
    action: 'dispatch_done', serial: null,
    payload: { dispatch_id: 'm-pu-900149', note: 'Back in the yard' },
  },
  // schema 5. Like ticket_open, a pending lead_open has no number of its own —
  // the Leads tab has to badge it without inventing "L????".
  {
    id: 'evt-mock-7',
    ts: ago(25),
    actor: 'Josh', role: 'service',
    action: 'lead_open', serial: null,
    payload: {
      customer: 'Stonebridge Cold Storage', contact: 'Nadia Kohl', phone: '262-555-0199',
      email: null, site: 'Pewaukee WI 53072', source: 'PHONE', interest: 'RENTAL',
      machine: 'Rider for a freezer floor', serial: null, value: null, priority: 'HIGH',
      assigned: 'Kevin', next_action: 'Kevin to call back', note: 'Called the shop line',
      related_ticket: null, machinio_ref: null, force: false,
    },
  },
  // A stage move on a lead -> the lead badges pending, the card does not move.
  {
    id: 'evt-mock-8',
    ts: ago(9),
    actor: 'Kevin', role: 'sales',
    action: 'lead_update', serial: null,
    payload: { lead: 'L1005', stage: 'DEMO-SCHEDULED', demo_date: d(2), demo_serial: '900107', note: 'They asked to see it run' },
  },
  // A close proposal on a lead that is still OPEN on the board.
  {
    id: 'evt-mock-9',
    ts: ago(4),
    actor: 'Kevin', role: 'sales',
    action: 'lead_close', serial: null,
    payload: { lead: 'L1004', outcome: 'DEAD', reason: null, note: 'Four calls, nothing back' },
  },
];
const pfile = path.join(outdir, 'mock-pending.json');
fs.writeFileSync(pfile, JSON.stringify(pending, null, 2) + '\n');
console.log(`mock-pending.json: ${pending.length} unapplied events -> ${path.relative(process.cwd(), pfile)}`);
