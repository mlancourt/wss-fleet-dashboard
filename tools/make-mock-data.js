#!/usr/bin/env node
/**
 * make-mock-data.js — FAKE dashboard snapshot generator (schema_version 7).
 *
 * EVERYTHING in this file is invented. Fake customers, fake serials, fake money.
 * No real WSS data may ever be pasted in here — see CLAUDE.md rule 1.
 *
 * Emits three variants so every view can be exercised:
 *   mock-full.json    schema 5 — service queue, dispatch board, pick-ups, holds, leads
 *   mock-empty.json   schema 7 — service_queue: [], dispatch: [] and leads: [] (empty
 *                     states); ON-DEMO row = 0 on the status board
 *   mock-legacy.json  schema 2 — the pre-Dispatch snapshot, kept for one release
 *                     so the board still renders during the cutover
 *
 * Coverage guaranteed by construction:
 *   - all 9 categories, in display order
 *   - every unit_state: AVAILABLE RESERVED ON-RENT ON-DEMO LOANER-OUT IN-SHOP RETIRED
 *   - every readiness: READY NEEDS-PREP DOWN NEEDS-PICKUP
 *   - D56: readiness_since + readiness_age_days on every unit — a NEEDS-PREP at 2d
 *     and at 9d, a never-stamped on-hand unit (both null), a DOWN at 16d that
 *     carries a service_ticket, and an ON-RENT unit holding a DOWN readiness with
 *     an age, which the Shop List must NOT draw
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
// Anchor on today's CENTRAL date — the page's "today" (todayCentral()). The UTC
// date was a day ahead every evening after 7 pm CT, so "yesterday" in the mock
// was today on the page and the date-relative render checks flaked by the clock.
// Generator-side date math only — the PAGE never parses date-only strings
// (CLAUDE.md rule 7).
const CENTRAL_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const TODAY = Date.parse(CENTRAL_TODAY + 'T00:00:00Z');
const d = (offsetDays) => new Date(TODAY + offsetDays * DAY).toISOString().slice(0, 10);

// A log row's `ts` (v2.4) is a DISPLAY STRING the engine has already formatted
// for a Central reader — "2026-09-04 11:09 CT", or a bare date on an imported
// row that only knew the day. It is not an instant and not a business date, so
// the fixture builds both shapes as text and the site renders them verbatim.
const ts = (offsetDays, hhmm) => (hhmm ? `${d(offsetDays)} ${hhmm} CT` : d(offsetDays));
/** `{ts, who, text}` rows, oldest first — the order the engine publishes. */
const logOf = (rows) => rows.map(([t, who, text]) => ({ ts: t, who: who || null, text }));

/**
 * A FAKE document row (schema 6). The id has the right SHAPE — 16 lowercase hex
 * — but there are no bytes behind it: nothing in this repo may carry a real
 * document, and the doc store is the Worker's KV, not the snapshot's. Tapping
 * one of these in mock mode says "documents live on the Worker" and stops,
 * which is the honest answer.
 */
const doc = (id, name, kind, bytes, addedDaysAgo) => ({ id, name, kind, bytes, added: d(addedDaysAgo) });

// D59: an agreement id is OPAQUE and either an int (legacy Integra, 4130) or a
// string on WSS's own paper ("R092526A"). An invoice hangs off it as
// "<agmt>-<cycle>" — and only the int form needs the leading "R" bolted on,
// because the WSS-paper id already carries one. Never string-prefix an
// agreement id without checking which of the two you are holding.
const WSS_PAPER_AGREEMENT = 'R092526A';
const invoiceNo = (agreement, cycle) =>
  `${typeof agreement === 'number' ? `R${agreement}` : String(agreement)}-${cycle}`;

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

/* ------------------------------------------------------- geo (schema 7, D52)
 * A FAKE geocode cache, built the way the real one is: keyed on the ADDRESS
 * STRING. That is the whole reason two rows at the same plant stack on the map
 * — they do not "look close", they carry byte-identical `geo` because they went
 * through the same cache entry. Faking it any other way (a random jitter per
 * row) would produce a mock the stacking code can never be tested against.
 *
 * All of these are real Wisconsin town centroids to ~4dp. They are places, not
 * customers: nothing here is a WSS address (the shop's own is in meta.geo, and
 * it is a business address that is already on the company's website).
 */
const GEO = {
  'Ixonia WI':      { lat: 43.1751, lng: -88.6009, precision: 'city' },
  'Waukesha WI':    { lat: 43.0117, lng: -88.2315, precision: 'street' },
  'Oconomowoc WI':  { lat: 43.1097, lng: -88.4996, precision: 'street' },
  'Madison WI':     { lat: 43.0731, lng: -89.4012, precision: 'street' },
  'Milwaukee WI':   { lat: 43.0389, lng: -87.9065, precision: 'rooftop' },
  'Watertown WI':   { lat: 43.1947, lng: -88.7290, precision: 'rooftop' },
  'Jefferson WI':   { lat: 43.0053, lng: -88.8073, precision: 'street' },
  'Sun Prairie WI': { lat: 43.1836, lng: -89.2137, precision: 'street' },
  'Beloit WI':      { lat: 42.5083, lng: -89.0318, precision: 'rooftop' },
  'Franklin WI':    { lat: 42.8886, lng: -88.0126, precision: 'street' },
  'Kenosha WI':     { lat: 42.5847, lng: -87.8212, precision: 'rooftop' },
  'Janesville WI':  { lat: 42.6828, lng: -89.0187, precision: 'street' },
  'Racine WI':      { lat: 42.7261, lng: -87.7829, precision: 'rooftop' },
  'West Bend WI':   { lat: 43.4253, lng: -88.1834, precision: 'street' },
  // City precision only — no street address on file. Renders hollow (§3.3).
  'Fond du Lac WI': { lat: 43.7730, lng: -88.4470, precision: 'city' },
  // Out of state. A real lead; just not on a map of Wisconsin (§3.7).
  'Toledo OH':      { lat: 41.6528, lng: -83.5379, precision: 'street', in_wi: false },
};

// Fake street lines, so two customers in one town do not share a coordinate.
// Real addresses are street-level; a mock where every row in Watertown lands on
// the same pixel would collapse the whole map into nine pins and leave the
// stacking code (§3.4) untested against anything but an artefact.
const STREETS = [
  '1400 Industrial Dr', '820 Commerce Pkwy', 'W229 N1433 Westwood Dr', '3050 Enterprise Ct',
  '615 Distribution Way', '1201 Riverside Blvd', '4400 Innovation Dr', '77 Logistics Ln',
  '910 Foundry Rd', '2280 Corporate Cir',
];

/** A stable 32-bit hash of a string — same address in, same number out, forever. */
function hash32(v) {
  let h = 2166136261;
  for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * `geo` for an address, or null — exactly the engine's contract. A miss is a
 * miss: no jitter, no city fallback, no guess. The row lands on the off-map
 * list, which is how Matt finds the address to fix in the vault.
 */
function geoFor(address) {
  // The real cache is keyed on the raw address string. This one normalises a
  // trailing ZIP away first ("Oconomowoc WI 53066" -> "Oconomowoc WI") because
  // that is the MOCK's stand-in for a geocoder: two strings naming one town
  // resolve to one point. The CONTRACT being modelled is the important half —
  // the same place yields byte-identical `geo`, which is what makes §3.4
  // stacking testable.
  if (typeof address !== 'string' || !address.trim()) return null;
  const full = address.trim().replace(/\s+\d{5}(-\d{4})?$/, '');
  // The town is the tail of the string; anything before it is a street line.
  const town = /(?:^|,\s*)([A-Za-z. ]+\s(?:WI|OH))$/.exec(full);
  const hit = town ? GEO[town[1].trim()] : GEO[full];
  if (!hit) return null;

  // City precision means the geocoder gave us the town centroid and nothing
  // finer — so every city-precision row in a town legitimately shares a point,
  // and that is exactly what the hollow pin is telling the reader. Street and
  // rooftop hits get a stable offset derived from the WHOLE address string, so
  // two different addresses in one town are two places and the SAME address is
  // always the same place. That second half is the contract §3.4 relies on.
  let { lat, lng } = hit;
  if (hit.precision !== 'city') {
    const h = hash32(full);
    lat += (((h & 0xffff) / 0xffff) - 0.5) * 0.07;          // ~±3.9 km
    lng += ((((h >>> 16) & 0xffff) / 0xffff) - 0.5) * 0.09;  // ~±3.7 km
  }
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    precision: hit.precision,
    in_wi: hit.in_wi !== false,
  };
}
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
      const job_site = out ? `${pick(STREETS)}, ${pick(SITES)}` : null;

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
        // schema 7 (D52): geocoded from job_site, so only an OUT unit has one.
        // A unit at home is not a place a truck goes.
        geo: geoFor(job_site),
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
          last_invoice: invoiceNo(unit.agreement, cycles_billed),
          next_due: oneShot ? null : d(periodEndOffset + 28),
          job_site,
          customer_po: rand() < 0.4 ? `PO-${Math.round(10000 + rand() * 89999)}` : null,
          alerts: [],
          // schema 6. Agreements carry docs too, but there is no agreement
          // DETAIL sheet to render them on yet — the S1 site work is tickets
          // and leads only. The field is here so the contract is complete.
          docs: [],
        });
      }
    });
  });

  // --- shape the agreements array into the edge cases the UI must survive ----

  // A split cycle: invoice number with a ".1" suffix. Opaque string, never parsed.
  agreements[2].last_invoice = `${invoiceNo(agreements[2].agreement, agreements[2].cycles_billed)}.1`;
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
    docs: [],
  };

  // D59: a rental written on WSS's own paper. Its `agreement` is a STRING —
  // "R092526A" — not an int, and the invoice off it is "R092526A-1" with no
  // second "R" bolted on the front. This row exists so every view that touches
  // an agreement id (the Rentals card, unit detail, the pick-up rows, the
  // billing block) is proven to render the id verbatim rather than parse it,
  // coerce it, or sort it against the legacy ints around it. Cycle 1 of an
  // open-ended 28D rental, so cycles_max stays null and the numbers stay honest.
  // It also carries the D59 CONTRACT doc — the signed rental agreement PDF,
  // vault-minted, which renders through the 📄 fallback like any unknown kind.
  const wssPaper = agreements[8];
  const wssPaperUnit = units.find((u) => u.agreement === wssPaper.agreement);
  wssPaper.agreement = WSS_PAPER_AGREEMENT;
  if (wssPaperUnit) wssPaperUnit.agreement = WSS_PAPER_AGREEMENT;
  wssPaper.cycle = '28D';
  wssPaper.cycles_billed = 1;
  wssPaper.cycles_max = null;
  wssPaper.last_invoice = invoiceNo(WSS_PAPER_AGREEMENT, 1);
  wssPaper.next_due = wssPaper.next_due || d(9);
  wssPaper.docs = [doc('5c1f7a2e08b4d963', '2026-09-25-RentalAgreement-R092526A.pdf', 'CONTRACT', 96410, -3)];

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
    // D59: the WSS-paper unit leads this list on purpose. A pick-up row carries
    // an `agreement` of its own, so one of them has to be the string form or the
    // Dispatch path never proves it survives.
    const onRent = units.filter((u) => u.unit_state === 'ON-RENT' && u.agreement != null);
    const pu = [
      ...onRent.filter((u) => u.agreement === WSS_PAPER_AGREEMENT),
      ...onRent.filter((u) => u.agreement !== WSS_PAPER_AGREEMENT).slice(1, 3),
    ];
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

  // ------------------------------------------------ rental lifecycle (D64)
  // The agreement is the spine: PENDING -> ACTIVE -> OFF-RENT -> (ENDED, never
  // shipped). Every row carries the new keys; the legacy rows are ACTIVE with
  // the legacy moves (DELIVER out, PICKUP in). Ages are engine-computed in real
  // life — here they are written directly, never derived by the page.
  for (const a of agreements) {
    const days = a.agreement == null ? null : Math.round(10 + rand() * 300);
    Object.assign(a, {
      status: 'ACTIVE', lead: null,
      out_date: null, out_move: 'DELIVER', in_date: null, in_move: 'PICKUP',
      on_rent_since: days == null ? null : d(-days), days_on_rent: days,
      off_rent: null, delivery: null,
    });
  }
  const d64 = { deliver: null };
  if (withServiceQueue) {
    const released = new Set(pickups.map((p) => String(p.agreement)));
    const plain = agreements.filter((a) => a.agreement != null && !released.has(String(a.agreement)) && a.alerts.length === 0);
    // Three ACTIVE rows with a planned return: overdue, tomorrow, and none.
    if (plain[0]) plain[0].in_date = d(-1);
    if (plain[1]) { plain[1].in_date = d(1); plain[1].on_rent_since = d(0); plain[1].days_on_rent = 0; }
    // OFF-RENT / CUSTOMER-RETURN — the clock is stopped, the machine is still
    // at the customer's until they drive it back. D7: the cycle it was in bills
    // in full, so cycles_max is capped at what was billed.
    const custReturn = plain[3];
    if (custReturn) Object.assign(custReturn, { status: 'OFF-RENT', in_move: 'CUSTOMER-RETURN', off_rent: d(-2),
      cycles_max: custReturn.cycles_billed, next_due: null });
    // OFF-RENT / PICKUP — the released unit whose m-pu row is already claimed.
    const offPickup = pickups[1] && agreements.find((a) => a.agreement === pickups[1].agreement);
    if (offPickup) Object.assign(offPickup, { status: 'OFF-RENT', off_rent: d(-1),
      cycles_max: offPickup.cycles_billed, next_due: null });

    // Two PENDING rentals on units at home. No invoice, no clock, no next_due.
    const pending = (u, extra) => {
      const a = {
        agreement: extra.agreement, customer: extra.customer, serial: u.serial,
        cycle: extra.cycle, cycle_rate: extra.cycle_rate, cycles_billed: 0, cycles_max: extra.cycle === 'ONE-SHOT' ? 1 : null,
        last_invoiced_period_start: null, last_invoiced_period_end: null, last_invoice: null, next_due: null,
        job_site: extra.job_site, customer_po: extra.customer_po || null, alerts: [],
        docs: extra.docs || [],
        status: 'PENDING', lead: extra.lead || null,
        out_date: extra.out_date, out_move: extra.out_move, in_date: extra.in_date, in_move: extra.in_move,
        on_rent_since: null, days_on_rent: null, off_rent: null, delivery: extra.delivery || null,
      };
      agreements.push(a);
      u.pending_agreement = a.agreement;
      // The implied RENTAL hold. Not releasable — the engine refuses an agmt: id.
      hold(u, 0, 0, { id: `agmt:${a.agreement}`, held_by: 'agreement', customer: a.customer, purpose: 'RENTAL',
        start: a.out_date, end: a.in_date || a.out_date, created: null });
      const h = u.reservations[u.reservations.length - 1];
      h.status = status(h);
      if (h.status === 'current' && u.unit_state === 'AVAILABLE') u.unit_state = 'RESERVED';   // D28
      return a;
    };
    const dlUnit = availReady[4];
    const puUnit = availReady[5];
    if (dlUnit) {
      const id = 'R092826A';
      d64.deliver = pending(dlUnit, {
        agreement: id, customer: 'Ironwood Packaging', lead: 'L1008',
        cycle: '28D', cycle_rate: dlUnit.rate_card.monthly,
        job_site: '2200 S Kinnickinnic Ave, Milwaukee WI', customer_po: 'PO-77120',
        out_date: d(1), out_move: 'DELIVER', in_date: d(29), in_move: 'PICKUP',
        delivery: { id: `m-dl-${id}`, driver: 'Kevin', rig: 'TRAILER-6000', date: d(1), status: 'SCHEDULED' },
        docs: [doc('7a0d2c94e1b3f5a8', `2026-09-28-RentalAgreement-${id}.pdf`, 'CONTRACT', 88213, -1)],
      });
      d64.deliverUnit = dlUnit;
    }
    if (puUnit) {
      // Out date YESTERDAY and still PENDING: the tile has to say so, in red.
      pending(puUnit, {
        agreement: 'R092326B', customer: 'Harbor Line Logistics',
        cycle: 'ONE-SHOT', cycle_rate: puUnit.rate_card.weekly || puUnit.rate_card.monthly,
        job_site: 'Harbor Line DC, Kenosha WI',
        out_date: d(-1), out_move: 'CUSTOMER-PICKUP', in_date: d(6), in_move: 'CUSTOMER-RETURN',
      });
    }
  }
  for (const u of units) if (!('pending_agreement' in u)) u.pending_agreement = null;

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
        // schema 6: the ticket's paperwork. Most tickets have none — an empty
        // docs[] must render NOTHING at all, not an empty box.
        docs: [],
        ...t,
      };
      delete row.unit;
      // The day offsets above are NUMBERS for convenience at the call site; the
      // spread would leave them in the snapshot as "-1". Convert after merging.
      row.opened = d(opened);
      row.stage_since = d(stage_since);
      row.age_days = -opened;
      // D62: CLOSED rows carry closed_age_days (engine-computed calendar days);
      // OPEN rows carry null. Pass `closedDays` and both fields follow from it.
      if (t.closedDays != null) {
        row.status = 'CLOSED';
        row.stage = 'COMPLETE';
        row.closed = d(-t.closedDays);
      }
      delete row.closedDays;
      row.closed_age_days = row.status === 'CLOSED' ? (t.closedDays != null ? t.closedDays : 0) : null;
      // schema 7 (D52): geocoded from `site`. A machine already on our bench
      // has nowhere to send a truck, so an IN-SHOP ticket carries geo: null
      // however good its address is — the engine ships it that way too.
      row.geo = row.location === 'IN-SHOP' ? null : geoFor(row.site);
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
      // Two kinds and two icons on one ticket: the work order Josh drives with
      // and the photo the customer texted in.
      docs: [
        doc('4f2a91c07be3d518', '2026-09-07-Ironwood-Workorder.pdf', 'WORKORDER', 18442, -1),
        doc('a10c73be9d4f2205', 'key-switch-panel.jpg', 'PHOTO', 1874300, -1),
      ],
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
      docs: [doc('ab0b83a1b88c21ff', '2026-09-02-FairmontDairy-Quote.pdf', 'QUOTE', 25602, -6)],
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
      docs: [
        doc('c93de4470a1b6688', 'pump-assy-41-2207-parts.pdf', 'PARTS-LIST', 7180, -15),
        doc('0d5e1fa2c7b39940', '2026-08-25-Lakeshore-PM.pdf', 'PM-REPORT', 44100, -15),
      ],
    });

    // 4b — READY-TO-SCHEDULE (D48): approval + parts in hand, we owe them a date. Our court.
    ticket({
      stage: 'READY-TO-SCHEDULE', customer: 'Northgate Foods', equipment: 'Halstead R-440 (customer owned)',
      issue: 'Vac motor replacement — parts on the shelf, needs a truck day', location: 'AT-CUSTOMER',
      intake_move: 'NONE', return_move: 'NONE', assigned: null, opened: -8,
      quote: { number: 'Q-2230', amount: 615, sent: d(-6), approved: d(-2) },
      parts: 'Vac motor 22-0410 — received',
      log: logOf([
        [ts(-2, '09:15'), 'Matt', 'Matt: approved by email. Motor came in this morning.'],
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

    // 7 — COMPLETE + CLOSED this week: draws in the COMPLETE column AND the
    // Completed strip (D62 — the column is the week, the strip is the archive).
    ticket({
      customer: 'Dorsey Plastics',
      equipment: 'Cascade Clean SW-900 (customer owned)', issue: 'Charger fault, replaced onboard charger',
      location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP',
      assigned: 'Josh', opened: -26, closedDays: 2, stage_since: -2,
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
      // D52 §4: a real-looking site the geocoder MISSED -> geo: null -> it shows
      // in the off-map list with its raw address, which is how Matt finds the
      // ones to fix in the vault. Do not add Portage to GEO to "fix" this test.
      location: 'AT-CUSTOMER', site: 'Portage WI', intake_move: 'PICKUP', return_move: 'DELIVER',
      assigned: 'Zac', opened: -13, stage_since: -5, priority: 'LOW',
    });

    // D62 — the 90-day archive. Closed ages spread 5…80 days: one more inside
    // the week (so the column is two deep), the rest only in the Completed
    // strip. One is ours, so the Fleet chip has a row there too; a couple carry
    // paperwork, because the strip's whole point is getting the work order back.
    const closedOld = (closedDays, o) => ticket({
      location: 'IN-SHOP', intake_move: 'CUSTOMER-DROP', return_move: 'CUSTOMER-PICKUP',
      opened: -(closedDays + 6 + Math.round(rand() * 10)), stage_since: -closedDays, closedDays, ...o,
    });
    closedOld(5, { customer: 'Harbor Point Logistics', equipment: 'Meridian R-440 (customer owned)',
      issue: 'Brush deck lift actuator replaced', assigned: 'Zac' });
    closedOld(12, { customer: 'Silverline Cold Storage', equipment: 'Halstead T-500 (customer owned)',
      issue: 'Solution pump + filter screen', assigned: 'Zac',
      parts: 'Solution pump 18-3302 — installed',
      log: logOf([
        [ts(-15, '10:40'), 'Zac', 'Zac: Pump seized, filter screen packed solid. Swapped both, ran it 20 min, no leaks.'],
      ]),
      docs: [
        doc('5be17c02d94a3f60', 'solution-pump-18-3302-parts.pdf', 'PARTS-LIST', 6120, -16),
        doc('e8a4410c7f2b9d13', '2026-08-29-Silverline-Workorder.pdf', 'WORKORDER', 20988, -12),
      ] });
    closedOld(19, { unit: units.find((u) => u.unit_state === 'AVAILABLE' && u.readiness === 'READY' && !u.service_ticket),
      customer: 'WSS', issue: 'Pre-rental PM — squeegee blades, vac hose', assigned: 'Josh', return_move: 'NONE', intake_move: 'NONE' });
    closedOld(23, { customer: 'Maplewood Schools', equipment: 'Nordvale SC-1800 (customer owned)',
      issue: 'Won\'t hold charge — batteries load-tested, two cells replaced', assigned: 'Josh',
      docs: [doc('7c3f9a18e20d4b55', '2026-08-18-Maplewood-Quote.pdf', 'QUOTE', 24110, -30)] });
    closedOld(34, { customer: 'Juniper Metalworks', equipment: 'Ironline BX-27 (customer owned)',
      issue: 'Annual PM', assigned: null });
    closedOld(47, { customer: 'Quarry Road Aggregates', equipment: 'Cascade Clean R-880 (customer owned)',
      issue: 'Drive tire + hub bearing', assigned: 'Zac' });
    closedOld(61, { customer: 'Fairmont Dairy', equipment: 'Halstead SW-900 (customer owned)',
      issue: 'Recovery tank float switch', assigned: 'Josh' });
    closedOld(80, { customer: 'Lakeshore Beverage', equipment: 'Meridian T-500 (customer owned)',
      issue: 'Squeegee assembly rebuild', assigned: 'Zac' });

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
        // D64: every row carries it — the R-number on RENTAL-DELIVER and
        // RENTAL-RETURN rows, null on the rest. Opaque (D59).
        agreement: m.agreement != null ? m.agreement : null,
        geo: geoFor(m.address),          // schema 7 (D52), from `address`
      });
    };

    // RENTAL-RETURN, OPEN — the first released unit, straight off pickups[].
    if (pickupUnits[0]) {
      const p = pickups[0];
      move({ id: `m-pu-${p.serial}`, kind: 'PICKUP', source: 'RENTAL-RETURN', serial: p.serial, agreement: p.agreement,
        what: `${p.model} #${p.serial} off-rent`, customer: p.customer, address: p.job_site,
        date: null, billed_through: p.billed_through, status: 'OPEN', note: p.note });
    }
    // RENTAL-RETURN, SCHEDULED — the second, already claimed.
    if (pickupUnits[1]) {
      const p = pickups[1];
      move({ id: `m-pu-${p.serial}`, kind: 'PICKUP', source: 'RENTAL-RETURN', serial: p.serial, agreement: p.agreement,
        what: `${p.model} #${p.serial} off-rent`, customer: p.customer, address: p.job_site,
        date: d(1), billed_through: p.billed_through, driver: 'Josh', rig: 'JOSH-LIFTGATE',
        status: 'SCHEDULED', note: p.note });
    }
    // RENTAL-DELIVER, SCHEDULED (D64) — derived from the PENDING agreement,
    // claimed by Kevin. No Cancel: it is not MANUAL. Done on it IS the OUT.
    if (d64.deliver) {
      const a = d64.deliver;
      const u = d64.deliverUnit;
      move({ id: a.delivery.id, kind: 'DELIVER', source: 'RENTAL-DELIVER', serial: a.serial, agreement: a.agreement,
        what: `${u.brand} ${u.model} #${u.serial}`, customer: a.customer, address: a.job_site,
        date: a.delivery.date, driver: a.delivery.driver, rig: a.delivery.rig, status: 'SCHEDULED',
        note: a.customer_po ? `PO ${a.customer_po}` : null });
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
  const SERVICE_STAGES = ['RECEIVED', 'CONTACTED', 'NEEDS-QUOTE', 'WAITING-ON-CUSTOMER', 'WAITING-ON-PARTS', 'READY-TO-SCHEDULE', 'SCHEDULED', 'IN-PROGRESS', 'READY-TO-INVOICE', 'COMPLETE'];
  const service_summary = {
    // COMPLETE still means closed <= 7 days (D62), whatever the window carries.
    open_by_stage: Object.fromEntries(SERVICE_STAGES.map((s) => [s, service_queue.filter(
      (t) => t.stage === s && (s === 'COMPLETE' ? t.status === 'CLOSED' && t.closed_age_days <= 7 : t.status === 'OPEN')).length])),
    open_customer: service_queue.filter((t) => t.status === 'OPEN' && t.machine_owner === 'CUSTOMER').length,
    open_wss: service_queue.filter((t) => t.status === 'OPEN' && t.machine_owner === 'WSS').length,
    closed_window_days: 90,                                                       // D62
    closed_in_window: service_queue.filter((t) => t.status === 'CLOSED').length,  // D62
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
    invoice: invoiceNo(a.agreement, a.cycles_billed + 1),
    agreement: a.agreement,
    customer: a.customer,
    amount: a.cycle_rate,
    period_start: a.last_invoiced_period_end,
    period_end: d(0),
  }));

  // ------------------------------------------- readiness aging (D56, schema 7)
  // Runs LAST, on purpose: everything above (holds, pick-ups, tickets) picks its
  // units by unit_state and readiness, so a readiness edit up there would quietly
  // re-cast the whole fixture. Here it can only add the two fields and the one
  // ON-RENT trap the Shop List has to ignore.
  //
  // The ages are hand-assigned, not random: the Shop List's three tone bands, its
  // null case and its exclusions each need a unit, and a random walk can't promise
  // that. `readiness_age_days` is the ENGINE's number in real life — the page never
  // computes it — so the generator writes it out rather than deriving it on read.
  const stamp = (u, age) => {
    u.readiness_since = age == null ? null : d(-age);
    u.readiness_age_days = age == null ? null : age;
  };
  const ON_HAND_MOCK = new Set(['AVAILABLE', 'RESERVED', 'IN-SHOP']);
  if (!withServiceQueue) {
    // The empty variant is where every empty state lives, and a green day is one
    // of them: nothing in prep, nothing down. The flip happens here, after the
    // holds and the board have already chosen their units off the original plan,
    // so it changes the Shop List and the D20 zero rows and nothing else.
    for (const u of units) {
      if (ON_HAND_MOCK.has(u.unit_state) && (u.readiness === 'NEEDS-PREP' || u.readiness === 'DOWN')) {
        u.readiness = 'READY';
        u.readiness_note = null;
      }
    }
  }
  if (withServiceQueue) {
    // One ON-RENT machine that broke in the field and carries a DOWN readiness
    // with a real age. It must NOT appear in the Shop List (D18: readiness is not
    // a concept for an out unit) and must draw no age chip. The trap is the test.
    const outDown = units.find((u) => u.unit_state === 'ON-RENT' && u.readiness === 'READY'
      && u.service_ticket == null && u.agreement != null);
    if (outDown) {
      outDown.readiness = 'DOWN';
      outDown.readiness_note = 'Pump failed on site — customer called it in';
    }
  }
  const shopUnits = units.filter((u) => ON_HAND_MOCK.has(u.unit_state)
    && (u.readiness === 'NEEDS-PREP' || u.readiness === 'DOWN'));
  //          neutral  amber   null (never stamped)  red
  const PREP_AGES = [2, 9, null, 21, 6, 13];
  //          red (the ticketed one)  neutral  amber
  const DOWN_AGES = [16, 5, 7];
  let ip = 0;
  let id = 0;
  for (const u of shopUnits) {
    const plan = u.readiness === 'DOWN' ? DOWN_AGES : PREP_AGES;
    const i = u.readiness === 'DOWN' ? id++ : ip++;
    stamp(u, i < plan.length ? plan[i] : 4);
  }
  // Every other unit gets a stamp too — the engine emits these keys for ALL units,
  // out states included, and the page is what decides nothing shows (D18).
  for (const u of units) {
    if (u.readiness_since === undefined) stamp(u, Math.round(3 + rand() * 90));
  }

  // ------------------------------------------------------- leads (schema 5)
  const { leads, leads_summary, scoreboard, insights } =
    buildLeads({ withLeads: withServiceQueue, demoHold, demoUnit: availReady[1], service_queue });

  // ------------------------------------------------- work orders (D65)
  const { work_orders, work_order_summary } = buildWorkOrders({ withWorkOrders: withServiceQueue, units });

  // ------------------------------------------------- inspections (D67)
  const { inspections, inspection_summary } = buildInspections({ withInspections: withServiceQueue, units, work_orders });

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
      schema_version: 7,
      generated_at: new Date().toISOString(),
      run_id: `mock-${withServiceQueue ? 'full' : 'empty'}-${new Date().toISOString().slice(0, 10)}`,
      fleet_totals: totals,
      utilization,
      // schema 7 (D52). The shop is WSS's own business address, which is on the
      // company's website — not customer data. `bounds` is the SVG's projected
      // box (the whole state); `default_view` is the SE-Wisconsin window the map
      // opens on, because that is where every run actually goes.
      geo: {
        shop: { label: 'WSS — Ixonia', address: 'N8069 County Road F, Ste 106, Ixonia, WI 53036',
          lat: 43.137422, lng: -88.592609 },
        bounds:       { lat_min: 42.45, lat_max: 47.10, lng_min: -92.95, lng_max: -86.75 },
        default_view: { lat_min: 42.45, lat_max: 43.85, lng_min: -90.05, lng_max: -87.22 },   // D53 (engine value; -87.45 clipped Milwaukee)
        precision_legend: {
          rooftop: 'Exact street address',
          street: 'Street address',
          // D53: the sheet renders these as "<lead> — <rest>"; these are the
          // `rest` halves. The lead-in ("City center" / "Approximate") is the
          // site's, so a snapshot cannot accidentally drop the distinction.
          city: 'no street address on file',
          street: 'street, no number',
          none: 'No usable address — fix it in the vault',
        },
      },
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
    // D65 (schema 7, additive): internal work orders. OPEN + CLOSED <= 30d.
    work_orders,
    work_order_summary,
    // D67 (schema 7, additive): the fleet inspection sheet. The row library
    // ships verbatim; every DRAFT + DONE <= 90 days; VOID never ships.
    inspections,
    inspection_summary,
    inspection_checklist: CHECKLIST_FIXTURE,
  };

  return { snapshot, ledger };
}

/* --------------------------------------------------- work orders (D65)
 * Hand-built, like the leads: spec §7 names the exact cases.
 *   W1001  OPEN, RENT-READY, four lines — REQUESTED (1d) · ORDERED · IN-TRANSIT
 *          with a UPS number · a SHOP-STOCK line (D68: born DELIVERED, no PO
 *          trail) — and 2.5 h of labor
 *   W1002  OPEN, PM, labor only (no parts at all — legal)
 *   W1003  OPEN, REPAIR, a REQUESTED line 8 days old (-> red) + an LTL freight
 *          line whose carrier the engine could not detect (tracking, no link);
 *          linked to the unit's open WSS ticket
 *   W1004  CLOSED 5 days ago — DELIVERED lines inside the 30-day window + one
 *          CANCELLED line + a SHOP-STOCK line (the strip's Delivered (30d) chip)
 *   W1005  CLOSED 40 days ago — NOT EMITTED. The window is the engine's; its
 *          absence here is the test.
 * NO money key anywhere: no cost, no cost_source_inv, no rate. The vault holds
 * those (D66) and the builder never emits them — nor does this file.
 * Every unit carries `work_order` + `wo_parts_open` (null / 0 when none), as
 * the engine emits them.
 */
function buildWorkOrders({ withWorkOrders, units }) {
  for (const u of units) { u.work_order = null; u.wo_parts_open = 0; }
  const empty = { open: 0, parts_requested: 0, parts_ordered: 0, parts_in_transit: 0, delivered_30d: 0, closed_window_days: 30 };
  if (!withWorkOrders) return { work_orders: [], work_order_summary: empty };

  const used = new Set();
  const take = (fn) => {
    const u = units.find((x) => !used.has(x.serial) && fn(x));
    if (u) used.add(u.serial);
    return u;
  };
  const prepUnit = take((u) => u.unit_state === 'IN-SHOP' && u.readiness === 'NEEDS-PREP' && !u.service_ticket);
  const pmUnit = take((u) => u.unit_state === 'AVAILABLE' && u.readiness === 'READY' && !u.service_ticket);
  const ticketUnit = take((u) => u.service_ticket && u.unit_state === 'IN-SHOP');
  const closedUnit = take((u) => u.unit_state === 'ON-RENT');

  const line = (n, o) => ({
    line: n, manufacturer: 'FACTORY-CAT', part_number: '', description: null, qty: 1,
    state: 'REQUESTED', ordered: null, vendor: null, vendor_ref: null, tracking: null, carrier: null,
    delivered: null, source: 'VENDOR', ...o,
  });
  const mfr = (u) => {
    const b = String(u.brand || '').toUpperCase().replace(/\s+/g, '-');
    return ['FACTORY-CAT', 'KODIAK', 'TENNANT', 'IPC-EAGLE', 'NILFISK', 'MINUTEMAN'].includes(b) ? b : 'OTHER';
  };
  const wo = (id, u, o) => {
    const row = {
      id, serial: u.serial, asset_item: u.asset_item, ticket: null, status: 'OPEN', purpose: 'REPAIR',
      opened: d(-o.age), opened_by: 'Josh', closed: null, age_days: o.age, note: null,
      parts: [], labor: [], parts_open: 0, hours_total: 0, log: [], ...o,
    };
    delete row.age;
    if (row.status === 'CLOSED') row.age_days = null;
    row.parts_open = row.parts.filter((p) => p.state !== 'DELIVERED' && p.state !== 'CANCELLED').length;
    row.hours_total = row.labor.reduce((n, l) => n + l.hours, 0);
    if (row.status === 'OPEN') { u.work_order = id; u.wo_parts_open = row.parts_open; }
    return row;
  };

  const out = [];
  if (prepUnit) {
    const m = mfr(prepUnit);
    out.push(wo('W1001', prepUnit, {
      age: 1, purpose: 'RENT-READY', note: 'rent-ready for Acme Foods',
      parts: [
        line(1, { manufacturer: m, part_number: '150-4500', description: 'Solution valve 24V', qty: 1 }),
        line(2, { manufacturer: m, part_number: '21-422S', description: 'Squeegee blade rear', qty: 2,
          state: 'ORDERED', ordered: d(-1), vendor: 'RPS', vendor_ref: 'SO-448121' }),
        line(3, { manufacturer: m, part_number: '30-750', description: 'Vac hose 1.5in x 6ft', qty: 1,
          state: 'IN-TRANSIT', ordered: d(-1), vendor: 'RPS', vendor_ref: 'SO-448121',
          tracking: '1Z999AA10123456784', carrier: 'UPS' }),
        line(4, { manufacturer: m, part_number: '264-4086', description: 'Filter', qty: 1,
          state: 'DELIVERED', delivered: d(0), source: 'SHOP-STOCK' }),
      ],
      labor: [
        { date: d(-1), who: 'Josh', hours: 1.5, note: 'teardown, found the valve' },
        { date: d(0), who: 'Zac', hours: 1, note: 'squeegee assembly off' },
      ],
      log: logOf([
        [ts(-1, '09:12'), 'Josh', 'Opened — 3 parts requested'],
        [ts(-1, '14:40'), 'Matt', 'Lines 2, 3 ordered — RPS SO-448121'],
        [ts(0, '08:05'), null, 'Line 3 in transit — UPS'],
        [ts(0, '09:40'), 'Zac', 'Zac pulled #4 264-4086 ×1 (Filter) from shop stock'],
      ]),
    }));
  }
  if (pmUnit) {
    out.push(wo('W1002', pmUnit, {
      age: 2, purpose: 'PM', opened_by: 'Zac',
      labor: [{ date: d(-2), who: 'Zac', hours: 1, note: '250-hour PM, no parts' }],
      log: logOf([[ts(-2, '10:30'), 'Zac', 'Opened — labor only']]),
    }));
  }
  if (ticketUnit) {
    out.push(wo('W1003', ticketUnit, {
      age: 8, purpose: 'REPAIR', ticket: ticketUnit.service_ticket, opened_by: 'Josh',
      parts: [
        line(1, { manufacturer: 'OTHER', part_number: 'DRV-2210', description: 'Drive motor brushes (set)', qty: 1 }),
        line(2, { manufacturer: 'KODIAK', part_number: 'K-88-114', description: 'Battery 6V 415Ah', qty: 6,
          state: 'IN-TRANSIT', ordered: d(-6), vendor: 'OTHER', vendor_ref: null,
          tracking: 'LTL PRO 48213377', carrier: null }),
      ],
      labor: [],
      log: logOf([[ts(-8, '15:02'), 'Josh', `Opened — linked to ${ticketUnit.service_ticket}`]]),
    }));
  }
  if (closedUnit) {
    out.push(wo('W1004', closedUnit, {
      age: 12, status: 'CLOSED', purpose: 'RENT-READY', closed: d(-5), opened_by: 'Matt',
      parts: [
        line(1, { manufacturer: mfr(closedUnit), part_number: '18-3302', description: 'Solution pump', qty: 1,
          state: 'DELIVERED', ordered: d(-11), vendor: 'RPS', vendor_ref: 'SO-447702',
          tracking: '9400111899223856924218', carrier: 'USPS', delivered: d(-7) }),
        line(2, { manufacturer: mfr(closedUnit), part_number: '18-3310', description: 'Filter screen', qty: 1,
          state: 'CANCELLED', source: 'SHOP-STOCK' }),
        line(3, { manufacturer: mfr(closedUnit), part_number: '18-2204', description: 'Brush drive belt', qty: 2,
          state: 'DELIVERED', delivered: d(-7), source: 'SHOP-STOCK' }),
      ],
      labor: [{ date: d(-7), who: 'Josh', hours: 2, note: 'pump swap + test run' }],
      log: logOf([
        [ts(-12, '11:20'), 'Matt', 'Opened — 2 parts requested'],
        [ts(-11, '09:00'), 'Matt', 'Line 1 ordered — RPS SO-447702; line 2 cancelled, found in shop stock'],
        [ts(-5, '16:10'), 'Matt', 'Closed'],
      ]),
    }));
  }
  // W1005 closed 40 days ago would be here — outside closed_window_days, so it never ships.

  const lines = out.flatMap((w) => w.parts.map((p) => ({ w, p })));
  const cnt = (st) => lines.filter(({ p }) => p.state === st).length;
  return {
    work_orders: out,
    work_order_summary: {
      open: out.filter((w) => w.status === 'OPEN').length,
      parts_requested: cnt('REQUESTED'),
      parts_ordered: cnt('ORDERED'),
      parts_in_transit: cnt('IN-TRANSIT'),
      delivered_30d: cnt('DELIVERED'),
      closed_window_days: 30,
    },
  };
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
const LEAD_STAGE_LIST = ['RECEIVED', 'CONTACTED', 'QUOTED', 'DEMO-SCHEDULED', 'DEMO-DONE', 'PO-RECEIVED', 'INVOICED'];   // +PO-RECEIVED, D55
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
      geo: geoFor(o.site),               // schema 7 (D52), from `site`
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
      po: o.po || null,                  // D55 — customer PO #, set on PO-RECEIVED
      machinio_ref: o.machinio_ref || null,
      related_ticket: o.related_ticket || null,
      // v2.4: the lead body, same {ts, who, text} shape as a ticket's.
      log: o.log || [],
      // schema 6. A QUOTE on a lead carries a customer-facing price, which is
      // fine — the customer already has it. Docs are never stripped and never
      // role-gated, so this survives the service money gate untouched.
      docs: o.docs || [],
    };
  };

  const ticket = (service_queue || []).find((t) => t.machine_owner === 'CUSTOMER');

  const leads = !withLeads ? [] : [
    // -- RECEIVED: two nobody has called yet, which is the nav badge's number.
    mk({ lead: 'L1001', stage: 'RECEIVED', customer: 'Cedar Ridge Foods', contact: 'Dana Whitlock',
      phone: '262-555-0148', email: 'dana@cedarridge.example', site: 'Oconomowoc WI 53066',
      source: 'WEB-FORM', interest: 'RENTAL', machine: '28" rider, 3 months', value: 9800,
      priority: 'HIGH', next_action: 'Call this morning', stageDays: 1, totalDays: 1 }),
    // D52 §4: out of state. A real, open, working lead — it just has no place on
    // a map of Wisconsin. in_wi: false, so it is NEVER pinned at the edge; it
    // goes to the off-map list with its address intact.
    mk({ lead: 'L1002', stage: 'RECEIVED', customer: 'Bellmont Distribution', contact: 'Ray Ackerman',
      phone: '419-555-0192', site: 'Toledo OH 43604', source: 'PAID-SEARCH', interest: 'SALE-NEW',
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
      docs: [doc('7e6b02fd419ac83b', '2026-09-03-HarborLine-Quote-990142.pdf', 'QUOTE', 132880, -5)],
      log: logOf([
        [ts(-9, '08:50'), 'Kevin', 'opened by Kevin (RECEIVED, REFERRAL): Sent over by Harbor Line\u2019s maintenance lead.'],
        [ts(-9, '11:55'), 'Kevin', 'Kevin RECEIVED \u2192 CONTACTED: Talked to Marcus. Two shifts, tile and sealed concrete, wants a rider.'],
        // v2.5: a lead log row NEVER carries a dollar figure. The engine writes
        // "value set" / "value updated" and its builder refuses to publish one
        // that has a number in it — which is what let the service strip of
        // leads[].log be reversed. Keep this fixture money-free or the guard in
        // tools/m1-loop.sh and tools/money-gate.mjs is testing nothing.
        [ts(-5, '14:03'), 'Kevin', 'Kevin value set'],
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
      next_action: 'Demo Tuesday, bring the small pad driver', stageDays: 3, totalDays: 11,
      // D59: CONTRACT — the signed rental agreement PDF, vault-minted. Nothing
      // in the site knows the word; it falls back to 📄 and a "Contract" label,
      // which is the whole point of the fallback. Lives here and not only on the
      // agreements row because agreements still have no detail sheet to draw it on.
      docs: [doc('5c1f7a2e08b4d963', '2026-09-25-RentalAgreement-R092526A.pdf', 'CONTRACT', 96410, -3)] }),

    // -- PO-RECEIVED (D55): the PO is in hand, the new build is with the factory,
    // and WSS is waiting on a serial before it can invoice. Nobody's fault, so
    // the sweep leaves it alone until stale_po_bdays (20) — three days in, it is
    // quiet. Its dollars show under Committed AND inside On the table.
    mk({ lead: 'L1015', stage: 'PO-RECEIVED', customer: 'Northgate Fulfillment', contact: 'Priya Raman',
      phone: '608-555-0117', email: 'praman@northgate.example', site: 'Sun Prairie WI 53590',
      source: 'REFERRAL', interest: 'SALE-NEW', machine: 'Nordvale SC-2400 (new build)',
      value: 31750, priority: 'HIGH', po: 'PO-48812', contactHours: 1.5,
      next_action: 'Chase the factory for a serial', stageDays: 3, totalDays: 34,
      log: logOf([
        [ts(-34, '08:12'), 'Kevin', 'opened by Kevin (RECEIVED, REFERRAL): Wants a new rider for the second shift.'],
        [ts(-20, '10:40'), 'Kevin', 'Kevin QUOTED \u2192 PO-RECEIVED: PO 48812; order submitted to the factory.'],
      ]) }),

    // -- a SERVICE lead: no value, and therefore no commission, by contract.
    // D52 §4: city precision only — the geocoder found the town and no street.
    // Draws as a HOLLOW pin and says so in the sheet. Must stay on an OPEN lead:
    // a closed one never reaches the map and would prove nothing.
    mk({ lead: 'L1009', stage: 'CONTACTED', customer: 'Meadowbrook Care', contact: 'Gail Ostrander',
      email: 'gostrander@meadowbrook.example', site: 'Fond du Lac WI 54935', source: 'EMAIL',
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
  // Every stage an OPEN lead can sit in — i.e. all but INVOICED, which is a
  // stage a won deal passes through rather than a column. Derived, not sliced:
  // the old `.slice(0, 5)` silently dropped PO-RECEIVED when D55 added it.
  const OPEN_STAGES = LEAD_STAGE_LIST.filter((s) => s !== 'INVOICED');
  const openByStage = Object.fromEntries(OPEN_STAGES.map((s) => [s, open.filter((l) => l.stage === s).length]));

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

  // D55: PO in hand, order with the factory. A subset of "on the table", not a
  // sibling — the engine sums it the same way (wss_leads.scoreboard).
  const committed = open.filter((l) => l.stage === 'PO-RECEIVED');

  const scoreboard = {
    money: {
      on_table_value: sum(open, 'value'),
      on_table_commission: sum(open, 'potential_commission'),
      committed_value: sum(committed, 'value'),
      committed_commission: sum(committed, 'potential_commission'),
      committed_count: committed.length,
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
      median_bdays_in_stage: Object.fromEntries(LEAD_STAGE_LIST.filter((s) => s !== 'INVOICED').map((s) => {
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

  // D64 postdates schema 2 by five versions: no lifecycle keys, no PENDING rows
  // (they never shipped), no implied agmt: holds, no pending_agreement. Every
  // row that remains is read as ACTIVE, which is exactly what the page must do.
  const D64_KEYS = ['status', 'lead', 'out_date', 'out_move', 'in_date', 'in_move', 'on_rent_since', 'days_on_rent', 'off_rent', 'delivery'];
  snap.agreements = snap.agreements.filter((a) => a.status !== 'PENDING');
  for (const a of snap.agreements) for (const k of D64_KEYS) delete a[k];
  const isAgmt = (h) => String(h.id || '').startsWith('agmt:');
  for (const u of snap.units) {
    delete u.pending_agreement;
    const had = u.reservations.length;
    u.reservations = u.reservations.filter((h) => !isAgmt(h));
    if (had !== u.reservations.length && u.unit_state === 'RESERVED' && !u.reservations.some((h) => h.status === 'current')) {
      u.unit_state = 'AVAILABLE';
    }
  }
  if (snap.reservations) {
    snap.reservations.upcoming = snap.reservations.upcoming.filter((h) => !isAgmt(h));
    snap.reservations.expired = snap.reservations.expired.filter((h) => !isAgmt(h));
  }

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

  // D56 postdates schema 2 by five versions. Their ABSENCE is what an old
  // snapshot looks like, and the Shop List has to draw its rows with no age
  // rather than an "undefinedd" chip.
  for (const u of snap.units) { delete u.readiness_since; delete u.readiness_age_days; }

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
  // D65 postdates it too: no work orders, no summary, no unit keys. The Parts
  // strip must simply not draw and the unit page must offer the button anyway.
  delete snap.work_orders;
  delete snap.work_order_summary;
  for (const u of snap.units) { delete u.work_order; delete u.wo_parts_open; }
  // D67 postdates it too: no library, no sheets, no summary, no unit keys. The
  // strip reads "No inspections yet" and the Inspect button stays hidden.
  delete snap.inspections;
  delete snap.inspection_summary;
  delete snap.inspection_checklist;
  for (const u of snap.units) { delete u.inspection_draft; delete u.last_inspection; delete u.hours_as_of; }
  return snap;
}

/**
 * D67 — the row library, TRIMMED from the vault's real one to three sections
 * that still exercise every axis the page filters on: both scales, `shows_for`
 * on a section (class) and on rows (class · body_style · battery), and a retired
 * row that an old sheet still carries. Labels are generic shop wording.
 */
const CHECKLIST_FIXTURE = {
  version: 'mock-1.0',
  sections: [
    { id: 'bat', title: 'Batteries', instruction: 'WET packs: the cell grid above takes hydrometer, clarity and level per cell.',
      rows: [
        { id: 'bat.terminals', label: 'Battery terminals — clean tops, terminal condition', scale: 'FUNCTION' },
        { id: 'bat.cables', label: 'Battery cables', scale: 'FUNCTION' },
        { id: 'bat.watering', label: 'Single-point watering system', scale: 'FUNCTION', shows_for: { battery: ['WET'] } },
        { id: 'bat.charger', label: 'Battery charger', scale: 'FUNCTION' },
        { id: 'bat.old_gauge', label: 'Analog charge gauge', scale: 'FUNCTION', retired: '2026-09-20' },
      ] },
    { id: 'ctl', title: 'Check operation & condition of', instruction: 'Turn ON and test functionality.',
      rows: [
        { id: 'ctl.key_switch', label: 'Main power / key switch', scale: 'FUNCTION' },
        { id: 'ctl.estop', label: 'E-stop', scale: 'FUNCTION', shows_for: { class: ['SCRUBBER'] } },
        { id: 'ctl.drive_forward', label: 'Drive — forward', scale: 'FUNCTION' },
        { id: 'ctl.horn', label: 'Horn', scale: 'FUNCTION', shows_for: { body_style: ['RIDER', 'STAND-ON'] } },
        { id: 'ctl.seat_switch', label: 'Seat switch', scale: 'FUNCTION', shows_for: { body_style: ['RIDER'] } },
        { id: 'ctl.main_broom_ctl', label: 'Main broom lever / switch', scale: 'FUNCTION', shows_for: { class: ['SWEEPER'] } },
        { id: 'ctl.side_broom_lift', label: 'Side broom lift mechanism', scale: 'FUNCTION', shows_for: { class: ['SWEEPER'], body_style: ['RIDER', 'STAND-ON'] } },
        { id: 'ctl.side_broom', label: 'Side broom condition', scale: 'WEAR', shows_for: { class: ['SWEEPER'] } },
      ] },
    { id: 'deck', title: 'Scrub deck & squeegee', shows_for: { class: ['SCRUBBER'] },
      rows: [
        { id: 'deck.curtains', label: 'Deck curtains / wipers', scale: 'WEAR' },
        { id: 'deck.drivers', label: 'Deck brush drivers', scale: 'WEAR' },
        { id: 'sqg.blades', label: 'Check and rotate blades as needed', scale: 'FUNCTION' },
        { id: 'sqg.vac_hose', label: 'Squeegee vac hose', scale: 'FUNCTION' },
      ] },
  ],
};

/**
 * D67 fixture sheets (Inspection spec §7):
 *   DRAFT CHECKOUT  24V WET 4x6V walk-behind scrubber, 6 rows answered, NO hours
 *                   yet (-> Done disabled), linked to its unit's open ticket
 *   DRAFT PM        rider sweeper, AGM, opened 3 days ago (-> amber)
 *   DONE RETURN     36V WET 3x12V scrubber, 2 flags, NO work order (-> the button)
 *   DONE PM         linked to W1002 (the PM work order), so no button
 *   DONE 100d ago   built and then dropped by the 90-day window — never emitted
 * Every unit carries `inspection_draft` / `last_inspection` / `hours_as_of`;
 * `hours` is null except where a DONE sheet wrote it back (it was null fleet-wide
 * until D67 — the sheet is the only place the meter got read).
 */
function buildInspections({ withInspections, units, work_orders }) {
  for (const u of units) { u.inspection_draft = null; u.last_inspection = null; u.hours = null; u.hours_as_of = null; }
  for (const w of work_orders) w.inspection = null;
  const WINDOW = 90;
  const summary = (rows) => ({
    drafts: rows.filter((r) => r.status === 'DRAFT').length,
    done_7d: rows.filter((r) => r.status === 'DONE' && r.done >= d(-7)).length,
    done_30d: rows.filter((r) => r.status === 'DONE' && r.done >= d(-30)).length,
    flagged_open: rows.filter((r) => r.status === 'DONE' && r.flags && !r.work_order).length,
    done_window_days: WINDOW,
  });
  if (!withInspections) return { inspections: [], inspection_summary: summary([]) };

  const used = new Set();
  const take = (fn) => {
    const u = units.find((x) => !used.has(x.serial) && x.unit_state !== 'RETIRED' && fn(x));
    if (u) used.add(u.serial);
    return u;
  };
  const cat = (u, s) => String(u.category || '').includes(s);
  const blankReadings = () => ({ hours_key: null, hours_traction: null, hours_scrub: null,
    main_broom_pct: null, brush1_pct: null, brush2_pct: null, brushes_rotated: null });
  const cells = (n, per, sgs) => {
    const out = [];
    for (let b = 1; b <= n; b++) for (const c of 'ABCDEF'.slice(0, per)) {
      const sg = sgs.shift();
      if (sg === undefined) return out;
      out.push({ battery: b, cell: c, sg, clarity: sg < 1.2 ? 'CLOUDY' : 'CLEAR', level: sg < 1.2 ? 'LOW' : 'FULL' });
    }
    return out;
  };
  const flagsOf = (items) => items.filter((i) => ['REPAIR', 'PROBLEM', 'REPLACE'].includes(i.result)).length;
  const sheet = (id, u, o) => {
    const row = {
      id, serial: u.serial, asset_item: u.asset_item, kind: 'PM', status: 'DRAFT', opened: d(-(o.age || 0)),
      opened_by: 'Josh', done: null, tech: null, ticket: null, work_order: null, machine_class: 'SCRUBBER',
      body_style: 'WALK-BEHIND', battery: { type: null, voltage: null, pack: null }, readings: blankReadings(),
      cells: [], items: [], comments: null, flags: 0, age_days: null, log: [], ...o,
    };
    row.readings = { ...blankReadings(), ...(o.readings || {}) };
    row.flags = flagsOf(row.items);
    row.age_days = row.status === 'DRAFT' ? (o.age || 0) : null;
    delete row.age;
    return row;
  };
  const stamp = (daysBack, hhmm) => `${d(-daysBack)} ${hhmm} CT`;

  const rows = [];
  const checkoutUnit = take((u) => cat(u, 'Walk-Behind Scrubber') && u.unit_state === 'IN-SHOP' && u.service_ticket)
    || take((u) => cat(u, 'Walk-Behind Scrubber') && u.unit_state === 'IN-SHOP')
    || take((u) => cat(u, 'Scrubber'));
  const pmUnit = take((u) => cat(u, 'Ride-On Sweeper') && ['AVAILABLE', 'IN-SHOP', 'RESERVED'].includes(u.unit_state))
    || take((u) => cat(u, 'Sweeper'));
  const returnUnit = take((u) => cat(u, 'Rider Scrubber') && !u.work_order && ['AVAILABLE', 'IN-SHOP'].includes(u.unit_state))
    || take((u) => cat(u, 'Scrubber') && !u.work_order);
  const w1002 = work_orders.find((w) => w.id === 'W1002');
  const woUnit = w1002 ? units.find((u) => u.serial === w1002.serial) : null;
  if (woUnit) used.add(woUnit.serial);
  const oldUnit = take((u) => cat(u, 'Scrubber'));

  // The 100-day-old sheet: minted first, which is why it has the lowest number.
  if (oldUnit) {
    rows.push(sheet('I1001', oldUnit, { kind: 'PM', status: 'DONE', age: 101, done: d(-100), tech: 'Zac',
      battery: { type: 'WET', voltage: 24, pack: '2x12V' }, readings: { hours_key: 1880 } }));
  }
  if (woUnit) {
    const p = deriveProfileMock(woUnit.category);
    rows.push(sheet('I1002', woUnit, { kind: 'PM', status: 'DONE', age: 4, done: d(-3), tech: 'Zac', opened_by: 'Zac',
      ...p, work_order: 'W1002', battery: { type: 'AGM', voltage: 24, pack: null },
      readings: p.machine_class === 'SWEEPER'
        ? { hours_key: 961.5, main_broom_pct: 45, brushes_rotated: true }
        : { hours_key: 961.5, brush1_pct: 55, brush2_pct: 50, brushes_rotated: true },
      items: [
        { id: 'bat.terminals', result: 'IN-SPEC', note: null }, { id: 'ctl.key_switch', result: 'IN-SPEC', note: null },
        { id: 'ctl.drive_forward', result: 'REPAIR', note: 'hesitates in forward' },
        { id: 'bat.old_gauge', result: 'N/A', note: 'gauge removed' },
      ],
      log: [
        { ts: stamp(4, '08:10'), who: 'Zac', text: 'OPEN by Zac (PM)' },
        { ts: stamp(3, '15:42'), who: 'Zac', text: 'DONE by Zac — 961.5 h written back; 4/9 rows answered; 1 flag(s): Drive — forward' },
        { ts: stamp(3, '16:05'), who: 'Zac', text: 'work order W1002 opened from this inspection' },
      ] }));
    w1002.inspection = 'I1002';
  }
  if (returnUnit) {
    rows.push(sheet('I1003', returnUnit, { kind: 'RETURN', status: 'DONE', age: 1, done: d(-1), tech: 'Josh',
      machine_class: 'SCRUBBER', body_style: deriveProfileMock(returnUnit.category).body_style,
      battery: { type: 'WET', voltage: 36, pack: '3x12V' },
      readings: { hours_key: 412.5, brush1_pct: 60, brush2_pct: 60, brushes_rotated: false },
      cells: cells(3, 6, [1.265, 1.27, 1.26, 1.265, 1.255, 1.27, 1.26, 1.265, 1.19, 1.26, 1.265, 1.27, 1.265, 1.26, 1.27, 1.265, 1.26, 1.265]),
      items: [
        { id: 'bat.terminals', result: 'IN-SPEC', note: null }, { id: 'bat.cables', result: 'IN-SPEC', note: null },
        { id: 'bat.watering', result: 'IN-SPEC', note: null }, { id: 'ctl.key_switch', result: 'IN-SPEC', note: null },
        { id: 'ctl.estop', result: 'IN-SPEC', note: null }, { id: 'deck.curtains', result: 'REPLACE', note: 'rear curtain torn' },
        { id: 'sqg.blades', result: 'REPAIR', note: 'rear blade rolled' },
      ],
      comments: 'came back dirty — recovery tank not drained',
      log: [
        { ts: stamp(1, '09:02'), who: 'Josh', text: 'OPEN by Josh (RETURN)' },
        { ts: stamp(1, '10:31'), who: 'Josh', text: 'DONE by Josh — 412.5 h written back; 7/11 rows answered; 2 flag(s): Deck curtains / wipers; Check and rotate blades as needed' },
      ] }));
  }
  if (pmUnit) {
    rows.push(sheet('I1004', pmUnit, { kind: 'PM', age: 3, opened_by: 'Zac', machine_class: 'SWEEPER',
      body_style: deriveProfileMock(pmUnit.category).body_style, battery: { type: 'AGM', voltage: 36, pack: null },
      readings: { hours_key: 233 },
      items: [{ id: 'ctl.key_switch', result: 'IN-SPEC', note: null }, { id: 'ctl.horn', result: 'PROBLEM', note: 'intermittent' }],
      log: [{ ts: stamp(3, '13:15'), who: 'Zac', text: 'OPEN by Zac (PM)' }, { ts: stamp(3, '13:40'), who: 'Zac', text: 'Zac saved — readings, items×2; 1 flag(s)' }] }));
  }
  if (checkoutUnit) {
    rows.push(sheet('I1005', checkoutUnit, { kind: 'CHECKOUT', age: 0, opened_by: 'Josh', ticket: checkoutUnit.service_ticket || null,
      work_order: checkoutUnit.work_order || null, ...deriveProfileMock(checkoutUnit.category), machine_class: 'SCRUBBER',
      battery: { type: 'WET', voltage: 24, pack: '4x6V' },
      cells: cells(4, 3, [1.265, 1.26, 1.27, 1.255]),
      items: [
        { id: 'bat.terminals', result: 'IN-SPEC', note: null }, { id: 'bat.cables', result: 'IN-SPEC', note: null },
        { id: 'bat.watering', result: 'N/A', note: null }, { id: 'ctl.key_switch', result: 'IN-SPEC', note: null },
        { id: 'ctl.estop', result: 'IN-SPEC', note: null }, { id: 'deck.curtains', result: 'WORN', note: 'ok one more rental' },
      ],
      log: [{ ts: stamp(0, '07:48'), who: 'Josh', text: 'OPEN by Josh (CHECKOUT)' }, { ts: stamp(0, '08:05'), who: 'Josh', text: 'Josh saved — battery, cells×4, items×6; 0 flag(s)' }] }));
  }

  // The engine's window: every DRAFT, DONE within 90 days. The old one goes here.
  const shipped = rows.filter((r) => r.status === 'DRAFT' || (r.status === 'DONE' && r.done >= d(-WINDOW)));
  shipped.sort((a, b) => (a.status === b.status ? 0 : a.status === 'DRAFT' ? -1 : 1) || a.opened.localeCompare(b.opened));
  const bySerial = new Map(units.map((u) => [u.serial, u]));
  for (const r of shipped) {
    const u = bySerial.get(r.serial);
    if (r.status === 'DRAFT') u.inspection_draft = r.id;
    else if (!u.last_inspection || r.done > u.last_inspection.done) {
      u.last_inspection = { id: r.id, kind: r.kind, done: r.done, flags: r.flags };
      const h = r.readings.hours_key ?? r.readings.hours_traction ?? r.readings.hours_scrub;
      if (h != null) { u.hours = h; u.hours_as_of = r.done; }
    }
  }
  return { inspections: shipped, inspection_summary: summary(shipped) };
}
/** The engine's category → class / body_style derivation, for the fixtures. */
function deriveProfileMock(category) {
  const c = String(category || '').toLowerCase();
  return {
    machine_class: c.includes('sweeper') ? 'SWEEPER' : 'SCRUBBER',
    body_style: c.includes('stand-on') || c.includes('chariot') ? 'STAND-ON' : c.includes('rider') || c.includes('ride-on') ? 'RIDER' : 'WALK-BEHIND',
  };
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
// Derived, never pinned: the pick-up rows are numbered off whichever units the
// generator releases, so a hard-coded `m-pu-<serial>` here rots the day that set
// changes (it did, at D59).
const claimedPickup = full.snapshot.dispatch.find((r) => r.source === 'RENTAL-RETURN' && r.status === 'SCHEDULED');
// A unit with no open work order, for the pending OPEN (D65).
const woOpenUnit = full.snapshot.units.find((u) => u.work_order == null && u.unit_state === 'IN-SHOP' && u !== avail[1]);
// D67: a unit with no sheet at all for the pending OPEN; the CHECKOUT draft for the pending SAVE.
const inspNewUnit = full.snapshot.units.find((u) => !u.inspection_draft && !u.last_inspection && u.unit_state === 'ON-RENT');
const inspDraft = full.snapshot.inspections.find((i) => i.status === 'DRAFT' && i.kind === 'CHECKOUT');
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
    payload: { dispatch_id: claimedPickup.id, note: 'Back in the yard' },
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
  // D64: an Off-rent tap on a rental still ACTIVE on the board — keyed on
  // payload.agreement, no top-level serial. Kevin's, so the sales mock can undo it.
  {
    id: 'evt-mock-10',
    ts: ago(7),
    actor: 'Kevin', role: 'sales',
    action: 'rental_update', serial: null,
    payload: { agreement: WSS_PAPER_AGREEMENT, action: 'OFF-RENT', date: d(0), note: 'Plant called — done with it' },
  },
  // D65: a work-order OPEN has no W-number until the engine runs — the strip
  // and the unit page draw a synthetic ⏳ NEW card keyed on the serial.
  {
    id: 'evt-mock-11',
    ts: ago(5),
    actor: 'Josh', role: 'service',
    action: 'work_order', serial: woOpenUnit.serial,
    payload: { action: 'OPEN', purpose: 'REPAIR', note: 'brush motor noisy',
      parts: [{ manufacturer: 'OTHER', part_number: 'BM-1180', description: 'Brush motor', qty: 1 }] },
  },
  // D65: the other verbs badge on payload.work_order. Josh's, so he can undo it.
  {
    id: 'evt-mock-12',
    ts: ago(3),
    actor: 'Josh', role: 'service',
    action: 'work_order', serial: null,
    payload: { action: 'LABOR', work_order: 'W1001', date: d(0), who: 'Josh', hours: 0.75, note: 'valve seat cleaned' },
  },
  // D67: a sheet opened on Josh's phone that the engine hasn't numbered yet —
  // an OPEN carrying its first sections, keyed on the serial (no I-number is
  // ever invented) — and an unapplied SAVE on a numbered DRAFT.
  {
    id: 'evt-mock-13',
    ts: ago(6),
    actor: 'Josh', role: 'service',
    action: 'inspection', serial: inspNewUnit.serial,
    payload: { action: 'OPEN', kind: 'RETURN', readings: { hours_key: 1204, hours_traction: null, hours_scrub: null,
      main_broom_pct: null, brush1_pct: null, brush2_pct: null, brushes_rotated: null } },
  },
  {
    id: 'evt-mock-14',
    ts: ago(2),
    actor: 'Josh', role: 'service',
    action: 'inspection', serial: null,
    payload: { action: 'SAVE', inspection: inspDraft.id, comments: 'needs the rear curtain before it goes out' },
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
