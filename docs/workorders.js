/* Internal work orders (D65) — inspection + parts + labor on a fleet unit, pure.
 *
 * D69 (2026-09-27): one record per touch. The inspection sheet is a section of
 * the work order (inspections.js holds its machinery); `purpose` absorbed the
 * D67 sheet kinds; Close needs the sheet DONE or SKIPPED as well as every line
 * settled, and the close IS the ready call (CLOSE {ready}). Any verb but OPEN
 * may go out keyed on the serial before the W-number exists.
 *
 * The W-number IS the vendor PO: Matt reads "PO W1001" to the vendor, it prints
 * on the packing slip, and the techs match the box to the job by it. So this
 * file's one job beyond the rules is to put that number where a person holding
 * a box will look for it.
 *
 * Same rules as rentals.js / service.js: no DOM, no network, no Date parsing
 * of a date-only string. The engine owns every age (`age_days`), every count
 * (`parts_open`, `hours_total`, the summary) and every state move — a part
 * line only goes forward, and the engine referees that. What this file decides
 * is which line goes in which group and which buttons a role is OFFERED; the
 * Worker and the engine re-check everything.
 *
 * NO MONEY. `work_orders[]` carries no cost, rate or price key, for any role,
 * and nothing here reads, derives or formats one. Cost is backfilled in the
 * vault from the vendor invoice (D66). tools/selftest-workorders.mjs asserts it.
 */

import { blockOf, isSettled, chipText as sheetChip, describeStep } from './inspections.js';

/** D69: the D67 sheet kinds folded into `purpose`. RENT-READY is a pre-D69 row (the engine maps it to CHECKOUT). */
export const PURPOSES = ['CHECKOUT', 'RETURN', 'PM', 'REPAIR', 'OTHER'];
export const PURPOSE_LABEL = {
  CHECKOUT: 'Check-out', RETURN: 'Return', PM: 'PM', REPAIR: 'Repair', OTHER: 'Other', 'RENT-READY': 'Rent-ready',
};
export const MANUFACTURERS = ['FACTORY-CAT', 'KODIAK', 'TENNANT', 'IPC-EAGLE', 'NILFISK', 'MINUTEMAN', 'OTHER'];
export const MANUFACTURER_LABEL = {
  'FACTORY-CAT': 'Factory Cat', KODIAK: 'Kodiak', TENNANT: 'Tennant', 'IPC-EAGLE': 'IPC Eagle',
  NILFISK: 'Nilfisk', MINUTEMAN: 'Minuteman', OTHER: 'Other',
};
export const VENDORS = ['RPS', 'IPC-EAGLE', 'NILFISK', 'MINUTEMAN', 'TENNANT', 'OTHER'];
export const VENDOR_LABEL = { RPS: 'RPS', 'IPC-EAGLE': 'IPC Eagle', NILFISK: 'Nilfisk', MINUTEMAN: 'Minuteman', TENNANT: 'Tennant', OTHER: 'Other' };
export const PART_STATES = ['REQUESTED', 'ORDERED', 'IN-TRANSIT', 'DELIVERED', 'CANCELLED'];
export const PART_STATE_LABEL = {
  REQUESTED: 'Requested', ORDERED: 'Ordered', 'IN-TRANSIT': 'In transit', DELIVERED: 'Delivered', CANCELLED: 'Cancelled',
};
/** The verb on the button that moves a line INTO this state. SHOP-STOCK is the
 *  D68 pull — a source, not a state, but it rides the same button row. */
export const PART_VERB_LABEL = {
  ORDERED: 'Mark ordered', 'IN-TRANSIT': 'In transit', DELIVERED: 'Delivered', CANCELLED: 'Cancel line', 'SHOP-STOCK': 'Use from stock',
};
/**
 * D68: where a part comes from. A fact about the part, not a step in the
 * ladder — a SHOP-STOCK line is born DELIVERED (it is already on the bench) and
 * never had an order, a vendor or a box in transit. WARRANTY still walks the
 * vendor ladder. A line without `source` (pre-D68) is VENDOR.
 */
export const SOURCES = ['VENDOR', 'SHOP-STOCK', 'WARRANTY'];
export const sourceOf = (p) => (p && SOURCES.includes(p.source) ? p.source : 'VENDOR');
/** A line that came off the shelf: drawn "stock", never with a PO trail or a carrier link. */
export const isStockLine = (p) => !!p && sourceOf(p) === 'SHOP-STOCK' && p.state === 'DELIVERED';
export const OPEN_PART_STATES = new Set(['REQUESTED', 'ORDERED', 'IN-TRANSIT']);
export const MAX_LINES = 10;                   // per tap — the Worker's cap too
export const WO_ID_RE = /^W\d{4}$/;
export const HOURS_MIN = 0.25;
export const HOURS_MAX = 12;
export const HOURS_STEP = 0.25;
/** D70: the strip's Delivered group stays 30 days now that CLOSED work orders ship a year (engine clock: `delivered_age_days`). */
export const DELIVERED_DAYS = 30;
/** D71: a labor row is time on the machine or time in the truck — one shop rate, two bill rates (the rates are the vault's). */
export const LABOR_KINDS = ['TRAVEL', 'LABOR'];
export const LABOR_KIND_LABEL = { TRAVEL: '🚚 Travel', LABOR: '🔧 Labor' };
export const laborKindOf = (l) => (l && String(l.kind || '').toUpperCase() === 'TRAVEL' ? 'TRAVEL' : 'LABOR');

/** `work_orders[]`, or [] on a pre-D65 snapshot (the key is simply absent). */
export const workOrdersOf = (snap) => (snap && Array.isArray(snap.work_orders) ? snap.work_orders.filter(Boolean) : []);
export const woById = (list, id) => (Array.isArray(list) ? list.find((w) => w && w.id === id) || null : null);
const partsOf = (w) => (w && Array.isArray(w.parts) ? w.parts.filter(Boolean) : []);
export const laborOf = (w) => (w && Array.isArray(w.labor) ? w.labor.filter(Boolean) : []);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
/** Ascending date text, nulls last. */
const byDateAsc = (x, y) => (x && y ? x.localeCompare(y) : x ? -1 : y ? 1 : 0);

/** Lines still waiting on something — the engine's `parts_open`, as a filter. */
export const isOpenLine = (p) => !!p && OPEN_PART_STATES.has(p.state);
export const openLinesOf = (w) => partsOf(w).filter(isOpenLine);

/**
 * The Parts strip's groups (§3), in the order they draw: Ordered · In transit ·
 * Requested, then Delivered. Each entry is a PART LINE with its work order —
 * the strip is "what job does this box go to", so the row is the box.
 *
 *   ordered     oldest order first (it has been on order longest)
 *   inTransit   oldest order first
 *   requested   oldest work order first — the one nobody has ordered yet
 *   delivered   newest delivery first, ≤ DELIVERED_DAYS old (D70)
 * Ties break on W-number, then line, so the order never shuffles between runs.
 * A CANCELLED line is in none of them. Only OPEN work orders feed the three
 * working groups; a delivered line from a closed one still shows in Delivered.
 */
export function stripGroups(list) {
  const rows = (Array.isArray(list) ? list : []).filter(Boolean)
    .flatMap((wo) => partsOf(wo).map((part) => ({ wo, part })));
  const tie = (a, b) => String(a.wo.id).localeCompare(String(b.wo.id)) || (num(a.part.line) || 0) - (num(b.part.line) || 0);
  const open = (r) => r.wo.status !== 'CLOSED';
  const age = (r) => num(r.wo.age_days);
  return {
    ordered: rows.filter((r) => open(r) && r.part.state === 'ORDERED')
      .sort((a, b) => byDateAsc(a.part.ordered, b.part.ordered) || tie(a, b)),
    inTransit: rows.filter((r) => open(r) && r.part.state === 'IN-TRANSIT')
      .sort((a, b) => byDateAsc(a.part.ordered, b.part.ordered) || tie(a, b)),
    requested: rows.filter((r) => open(r) && r.part.state === 'REQUESTED')
      .sort((a, b) => ((age(b) ?? -1) - (age(a) ?? -1)) || tie(a, b)),
    // D70: the snapshot keeps a year of closed work orders; the strip keeps 30
    // days of boxes. A pre-D70 line without the key reads 0 (inside the window).
    delivered: rows.filter((r) => r.part.state === 'DELIVERED' && (num(r.part.delivered_age_days) ?? 0) <= DELIVERED_DAYS)
      .sort((a, b) => byDateAsc(b.part.delivered, a.part.delivered) || tie(a, b)),
  };
}

/**
 * D75 — the Parts tracker: the strip's part lines, grouped BY WORK ORDER, so
 * one job's boxes stay together while the AP sweep moves them between states.
 * Built off stripGroups() — the same rows, the same 30-day window (D70), the
 * same "CANCELLED never" — just folded by W-number instead of by state.
 *
 *   active     work orders with ≥ 1 open line (REQUESTED / ORDERED / IN-TRANSIT
 *              — stripGroups only yields those on non-CLOSED work orders), oldest
 *              `age_days` first, W-number breaking ties. Their in-window
 *              DELIVERED lines ride inside the same group.
 *   delivered  work orders whose in-window lines are ALL delivered — newest
 *              delivery first. A CLOSED work order only ever lands here.
 * Lines inside a group are `line` ascending. `worstTone` is the worst lineTone
 * among the group's open lines (red > amber > ''), given the thresholds app.js
 * owns (PARTS_AMBER / PARTS_RED); without them it is ''.
 */
export function trackerGroups(list, amber, red) {
  const g = stripGroups(list);
  const byWo = new Map();
  for (const r of [...g.requested, ...g.ordered, ...g.inTransit, ...g.delivered]) {
    const k = r.wo.id;
    if (!byWo.has(k)) byWo.set(k, { wo: r.wo, lines: [] });
    byWo.get(k).lines.push(r.part);
  }
  const rank = { '': 0, amber: 1, red: 2 };
  const groups = [...byWo.values()].map((x) => {
    const lines = x.lines.sort((a, b) => (num(a.line) || 0) - (num(b.line) || 0));
    const n = (st) => lines.filter((p) => p.state === st).length;
    const counts = { requested: n('REQUESTED'), ordered: n('ORDERED'), inTransit: n('IN-TRANSIT'), delivered: n('DELIVERED') };
    let worstTone = '';
    if (amber != null && red != null) {
      for (const p of lines) {
        const t = lineTone(x.wo, p, amber, red);
        if (rank[t] > rank[worstTone]) worstTone = t;
      }
    }
    const newestDelivered = lines.map((p) => p.delivered).filter(Boolean).sort().pop() || null;
    return { wo: x.wo, lines, counts, worstTone, newestDelivered };
  });
  const isActive = (x) => x.counts.requested + x.counts.ordered + x.counts.inTransit > 0;
  const id = (a, b) => String(a.wo.id).localeCompare(String(b.wo.id));
  return {
    active: groups.filter(isActive)
      .sort((a, b) => ((num(b.wo.age_days) ?? -1) - (num(a.wo.age_days) ?? -1)) || id(a, b))
      .map(({ wo, lines, counts, worstTone }) => ({ wo, lines, counts, worstTone })),
    delivered: groups.filter((x) => !isActive(x))
      .sort((a, b) => byDateAsc(b.newestDelivered, a.newestDelivered) || id(a, b))
      .map(({ wo, lines, counts, newestDelivered }) => ({ wo, lines, counts, newestDelivered })),
  };
}
/** D75: the tracker's head pill — open lines on non-CLOSED work orders, counted from the rows. */
export function trackerCounts(list) {
  const g = stripGroups(list);
  return { requested: g.requested.length, ordered: g.ordered.length, inTransit: g.inTransit.length };
}

/**
 * The pill: lines REQUESTED + ORDERED + IN-TRANSIT. The engine's summary when
 * it ships one (it is the one clock and the one count); counted from the rows
 * only for a snapshot that carries work orders without a summary.
 */
export function openPartCount(summary, list) {
  if (summary && typeof summary === 'object') {
    const n = [summary.parts_requested, summary.parts_ordered, summary.parts_in_transit].map(num);
    if (n.every((v) => v != null)) return n[0] + n[1] + n[2];
  }
  const g = stripGroups(list);
  return g.ordered.length + g.inTransit.length + g.requested.length;
}

/**
 * The strip's tone: amber if any REQUESTED line sits on a work order at least
 * `amber` days old, red at `red`. Ages are the engine's `age_days` — nothing
 * here subtracts a date. The thresholds come in from app.js (PARTS_AMBER /
 * PARTS_RED, beside AGE_AMBER), so Matt retunes them in one place.
 */
export function requestedTone(list, amber, red) {
  let worst = -1;
  for (const { wo } of stripGroups(list).requested) {
    const a = num(wo.age_days);
    if (a != null && a > worst) worst = a;
  }
  return worst >= red ? 'red' : worst >= amber ? 'amber' : '';
}
/** One line's age tone — only a REQUESTED line is late; an ordered part is Matt's to chase, not a stall. */
export const lineTone = (wo, part, amber, red) => {
  if (!part || part.state !== 'REQUESTED') return '';
  const a = num(wo && wo.age_days);
  return a == null ? '' : a >= red ? 'red' : a >= amber ? 'amber' : '';
};

/**
 * A carrier link, ONLY when the engine detected the carrier (UPS / FEDEX /
 * USPS). Anything else — LTL freight, a vendor's own number — is plain text:
 * a link that goes nowhere is worse than none. A leading carrier word the
 * vendor pasted in ("UPS 1Z…") is dropped from the number.
 */
const TRACK_URL = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  FEDEX: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
};
export function trackingUrl(carrier, tracking) {
  const f = TRACK_URL[carrier];
  if (!f || typeof tracking !== 'string' || !tracking.trim()) return null;
  const n = tracking.trim().replace(/^(ups|fedex|usps)\s+/i, '').replace(/\s+/g, '');
  return n ? f(encodeURIComponent(n)) : null;
}

/**
 * D70 §3 — a machine's service history: its CLOSED work orders and its CLOSED
 * fleet tickets, one list, newest `closed` first (string compare — never a Date
 * of a date-only string), ties by id descending. A work order and the ticket it
 * hangs off are two records, so two rows. A customer ticket (`serial: null`)
 * never matches. The OPEN work order / ticket live elsewhere on the unit page.
 */
export function unitHistory(serial, workOrders, tickets) {
  if (serial == null || serial === '') return [];
  const s = String(serial);
  const wos = (Array.isArray(workOrders) ? workOrders : []).filter((w) => w && w.status === 'CLOSED'
    && w.serial != null && String(w.serial) === s)
    .map((w) => ({ kind: 'wo', id: w.id, closed: w.closed || null, wo: w }));
  const tks = (Array.isArray(tickets) ? tickets : []).filter((t) => t && t.status === 'CLOSED'
    && t.serial != null && String(t.serial) === s)
    .map((t) => ({ kind: 'ticket', id: t.ticket, closed: t.closed || null, ticket: t }));
  return [...wos, ...tks].sort((a, b) => byDateAsc(b.closed, a.closed) || String(b.id || '').localeCompare(String(a.id || '')));
}
/** The caption under the history: each list's window, from the summaries (legacy fallbacks 30 / 7, per D62). */
export function historyCaption(woSummary, serviceSummary) {
  const w = num(woSummary && woSummary.closed_window_days) ?? 30;
  const t = num(serviceSummary && serviceSummary.closed_window_days) ?? 7;
  return `Work orders ${w === 365 ? 'a year back' : `${w} days back`} · tickets ${t} days`;
}
export const HISTORY_FIRST = 5;
/** "Josh" / "Josh, Zac" — who put hours on it, in the order they first did. */
export const laborWho = (w) => [...new Set(laborOf(w).map((l) => l.who).filter(Boolean))];

/** 1 -> "1", 2.5 -> "2.5", 0.75 -> "0.75". Hours, never money. */
export const fmtHours = (h) => {
  const n = num(h);
  return n == null ? '0' : String(Math.round(n * 100) / 100);
};
export const hoursValid = (h) => typeof h === 'number' && isFinite(h)
  && h >= HOURS_MIN && h <= HOURS_MAX && Math.round(h * 4) === h * 4;

/** D71: each stepper on its own — 0 (nothing to send) or a real quarter-hour reading. */
export const stepperValid = (h) => h === 0 || hoursValid(h);
/** D71: the travel hours on a work order — plain addition over labor[]; hours_total stays the engine's. */
export const travelHours = (w) => laborOf(w).filter((l) => laborKindOf(l) === 'TRAVEL')
  .reduce((sum, l) => sum + (num(l.hours) || 0), 0);
export const LABOR_HOURS_PROBLEM = 'Put the hours in Travel, Labor, or both — quarter hours, 0.25 to 12.';
/** What's wrong with the two steppers, or null. */
export function laborProblem(travel, labor) {
  if (!stepperValid(travel) || !stepperValid(labor)) return LABOR_HOURS_PROBLEM;
  if (travel === 0 && labor === 0) return LABOR_HOURS_PROBLEM;
  return null;
}
/**
 * D71: the + Log hours sheet → LABOR payloads, one per non-zero stepper,
 * TRAVEL first (the drive comes before the wrench). Same key, day, who and
 * note on both. [] when there's nothing valid to send — laborProblem says why.
 */
export function laborPayloads({ key = {}, date = null, who, note = null, travel, labor }) {
  if (laborProblem(travel, labor)) return [];
  return [['TRAVEL', travel], ['LABOR', labor]].filter(([, h]) => h > 0)
    .map(([kind, hours]) => ({ action: 'LABOR', ...key, date, who, hours, kind, note }));
}

/** "W1003 · RETURN · 📋 pending · 2 parts open · 1.5 h" — the unit page's chip (D69 §3). Engine counts only. */
export function woChipText(wo, unit) {
  const id = (wo && wo.id) || (unit && unit.work_order) || '';
  const open = num(wo ? wo.parts_open : unit && unit.wo_parts_open) ?? 0;
  const hours = num(wo && wo.hours_total);
  const bits = [id];
  if (wo && wo.purpose) bits.push(wo.purpose);
  const st = wo ? blockOf(wo) : unit && unit.wo_inspection ? { status: unit.wo_inspection } : null;
  if (st) bits.push(`📋 ${sheetChip(st)}`);
  bits.push(`${open} part${open === 1 ? '' : 's'} open`);
  if (hours != null) bits.push(`${fmtHours(hours)} h`);
  return bits.join(' · ');
}

/**
 * OPEN sheet default (D69 §2 — the engine's default_purpose, mirrored): it just
 * came back → RETURN · down, or out on rent → REPAIR · ready → CHECKOUT (the
 * pre-rental sheet) · anything else → PM. A default the picker shows, never a rule.
 */
export function defaultPurpose(unit) {
  const r = unit && unit.readiness;
  if (r === 'NEEDS-PREP') return 'RETURN';
  if (r === 'DOWN' || (unit && unit.unit_state === 'ON-RENT')) return 'REPAIR';
  if (r === 'READY') return 'CHECKOUT';
  return 'PM';
}

/** The unit's brand, as the manufacturer enum. Unknown makes are OTHER. */
export function manufacturerFor(brand) {
  const k = String(brand || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const map = {
    FACTORYCAT: 'FACTORY-CAT', KODIAK: 'KODIAK', TENNANT: 'TENNANT', IPCEAGLE: 'IPC-EAGLE', IPC: 'IPC-EAGLE',
    NILFISK: 'NILFISK', MINUTEMAN: 'MINUTEMAN',
  };
  return map[k] || 'OTHER';
}
/** Who we buy a make from — Factory Cat and Kodiak come through RPS (§1.1). */
export function vendorFor(manufacturer) {
  if (manufacturer === 'FACTORY-CAT' || manufacturer === 'KODIAK') return 'RPS';
  return VENDORS.includes(manufacturer) ? manufacturer : 'OTHER';
}

/**
 * Which state buttons a role is OFFERED on one line (§5's table):
 *
 *   state        owner                                   service                                         sales
 *   REQUESTED    Mark ordered · Use from stock · Cancel   Use from stock · Cancel line (own work order)   —
 *   ORDERED      In transit · Delivered                  In transit · Delivered                          —
 *   IN-TRANSIT   Delivered                               Delivered                                       —
 *
 * "Use from stock" (D68) is returned as 'SHOP-STOCK': REQUESTED only — once
 * Matt has called the order in, the box is coming and the shelf is moot.
 *
 * Nothing on a closed work order. "Own work order" is `opened_by` against the
 * signed-in name — shown here so a tech isn't offered a button the engine will
 * refuse; the engine is still what enforces it.
 */
export function partActions(wo, part, role, meName) {
  if (!wo || wo.status === 'CLOSED' || !part) return [];
  const works = role === 'owner' || role === 'service';
  if (part.state === 'REQUESTED') {
    if (role === 'owner') return ['ORDERED', 'SHOP-STOCK', 'CANCELLED'];
    if (role === 'service') return meName && wo.opened_by === meName ? ['SHOP-STOCK', 'CANCELLED'] : ['SHOP-STOCK'];
    return [];
  }
  if (part.state === 'ORDERED') return works ? ['IN-TRANSIT', 'DELIVERED'] : [];
  if (part.state === 'IN-TRANSIT') return works ? ['DELIVERED'] : [];
  return [];
}

/** Close: owner's — once every line is DELIVERED or CANCELLED AND the sheet is DONE or SKIPPED (D69; the engine guards both). */
export const closeShown = (wo, role) => !!wo && wo.status !== 'CLOSED' && role === 'owner';
/**
 * What is holding Close, in the words the disabled button shows — null when
 * nothing is. Both can hold it at once; the sentence names both.
 */
export function closeBlocker(wo) {
  if (!wo || wo.status === 'CLOSED') return null;
  const n = openLinesOf(wo).length;
  const lines = n ? `${n} part line${n === 1 ? '' : 's'} still open — deliver or cancel ${n === 1 ? 'it' : 'them'}` : '';
  const sheet = isSettled(wo) ? '' : 'the inspection is still pending — Done it, or No inspection with a reason';
  if (!lines && !sheet) return null;
  return [lines, sheet].filter(Boolean).join('; and ');
}
export const closeEnabled = (wo) => !!wo && wo.status !== 'CLOSED' && closeBlocker(wo) == null;
/** ☑ Mark READY (D69 §4.5) is offered only on a unit at home — the engine never touches an out unit's readiness. */
const HOME = new Set(['AVAILABLE', 'RESERVED', 'IN-SHOP']);
export const readyOffered = (unit) => !!unit && HOME.has(unit.unit_state);
/** Cancel the whole order: owner, or whoever opened it while nothing has left REQUESTED. */
export function cancelShown(wo, role, meName) {
  if (!wo || wo.status === 'CLOSED') return false;
  if (role === 'owner') return true;
  return !!meName && wo.opened_by === meName && partsOf(wo).every((p) => p.state === 'REQUESTED');
}

/* ---- the strip's headline (D69 §5) ----
 * "🔧 Work orders ▸ 2 open · 1 inspection pending · 3 parts open". The engine's
 * summary when it ships one; counted from the rows otherwise. */
export function stripCounts(summary, list) {
  const rows = (Array.isArray(list) ? list : []).filter(Boolean);
  const s = summary && typeof summary === 'object' ? summary : {};
  const open = num(s.open) ?? rows.filter((w) => w.status === 'OPEN').length;
  const pending = num(s.inspections_pending) ?? rows.filter((w) => w.status === 'OPEN' && blockOf(w).status === 'PENDING').length;
  return { open, pending, parts: openPartCount(summary, rows) };
}
/**
 * The strip's tone (D69 §5): the D65 parts rule (a REQUESTED line on an old
 * work order — amber / red), OR amber when an OPEN work order's sheet has sat
 * PENDING `inspectAmber` days or more (engine `age_days`). Red only ever comes
 * from parts.
 */
export function stripTone(summary, list, { partsAmber, partsRed, inspectAmber }) {
  const parts = requestedTone(list, partsAmber, partsRed);
  if (parts === 'red') return 'red';
  return inspectTone(summary, list, inspectAmber) || parts;
}
/**
 * The inspection half of the tone alone: amber when an OPEN work order's sheet
 * has sat PENDING `inspectAmber` days or more. D75: the Work orders strip's
 * whole tone — the parts half moved to the Parts tracker (requestedTone).
 */
export function inspectTone(summary, list, inspectAmber) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const anyPending = num(s.inspections_pending) == null || s.inspections_pending > 0;
  const stale = anyPending && (Array.isArray(list) ? list : []).some((w) => w && w.status === 'OPEN'
    && blockOf(w).status === 'PENDING' && num(w.age_days) != null && w.age_days >= inspectAmber);
  return stale ? 'amber' : '';
}
/** The OPEN work orders the strip lists (D69 §5), oldest first; the W-number breaks ties. */
export const openWorkOrders = (list) => (Array.isArray(list) ? list : []).filter((w) => w && w.status === 'OPEN')
  .sort((a, b) => ((num(b.age_days) ?? -1) - (num(a.age_days) ?? -1)) || String(a.id).localeCompare(String(b.id)));

/* ---- pending (§2) ----
 * OPEN has no W-number until the engine runs, so it is keyed on the top-level
 * serial and drawn as a synthetic ⏳ NEW card — never with an invented id.
 * Every other verb carries payload.work_order — or, sent before the number
 * existed (D69 serial fallback), no work_order and the top-level serial, which
 * the engine resolves to that serial's one OPEN work order. */
const pl = (e) => (e && e.payload) || {};
const isWo = (e) => !!e && e.action === 'work_order';
export const pendingOpens = (pending) => (Array.isArray(pending) ? pending.filter((e) => isWo(e) && pl(e).action === 'OPEN') : []);
export const pendingOpenFor = (pending, serial) => (serial == null ? [] : pendingOpens(pending)
  .filter((e) => e.serial != null && String(e.serial) === String(serial)));
export const pendingForWo = (pending, id) => (!id || !Array.isArray(pending) ? []
  : pending.filter((e) => isWo(e) && pl(e).action !== 'OPEN' && pl(e).work_order === id));
/** Non-OPEN taps sent keyed on the serial (no W-number yet) — they belong to that serial's OPEN work order. */
export const pendingBySerial = (pending, serial) => (serial == null || !Array.isArray(pending) ? []
  : pending.filter((e) => isWo(e) && pl(e).action !== 'OPEN' && !pl(e).work_order
    && e.serial != null && String(e.serial) === String(serial)));
/** Oldest first — the order the engine will apply them in. */
export const byTs = (a, b) => String(a.ts || a.id || '').localeCompare(String(b.ts || b.id || ''));

/** Where a pending PART-STATE sends its line: "from stock" for a D68 pull, else the state. */
export const pendingLineLabel = (p) => (p && p.source === 'SHOP-STOCK' ? 'from stock'
  : (p && (PART_STATE_LABEL[p.state] || p.state)) || '');

/** One line of English for a pending work_order tap, whatever verb it was. */
export function describeWoEvent(e) {
  const p = pl(e);
  const n = Array.isArray(p.parts) ? p.parts.length : 0;
  const parts = `${n} part${n === 1 ? '' : 's'}`;
  switch (p.action) {
    case 'OPEN': return `new ${p.purpose ? `${PURPOSE_LABEL[p.purpose] || p.purpose} ` : ''}work order${n ? ` — ${parts}` : ''}`;
    case 'ADD-PARTS': {
      const stock = Array.isArray(p.parts) ? p.parts.filter((x) => x && x.source === 'SHOP-STOCK').length : 0;
      return `${parts} added${stock ? ` (${stock} from stock)` : ''}`;
    }
    case 'PART-STATE': return `line ${p.line} → ${pendingLineLabel(p)}`;
    case 'LABOR': return `${fmtHours(p.hours)} h${laborKindOf(p) === 'TRAVEL' ? ' travel' : ''} logged for ${p.who || 'someone'}`;
    case 'CLOSE': return p.ready === false ? 'close (readiness left alone)' : 'close';
    case 'CANCEL': return 'cancel the work order';
    case 'INSPECT': return describeStep(p);
    default: return 'work order change';
  }
}
