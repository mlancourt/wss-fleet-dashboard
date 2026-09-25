/* Internal work orders (D65) — parts + labor on a fleet unit, pure.
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

export const PURPOSES = ['RENT-READY', 'REPAIR', 'PM', 'OTHER'];
export const PURPOSE_LABEL = { 'RENT-READY': 'Rent-ready', REPAIR: 'Repair', PM: 'PM', OTHER: 'Other' };
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
/** The verb on the button that moves a line INTO this state. */
export const PART_VERB_LABEL = { ORDERED: 'Mark ordered', 'IN-TRANSIT': 'In transit', DELIVERED: 'Delivered', CANCELLED: 'Cancel line' };
export const OPEN_PART_STATES = new Set(['REQUESTED', 'ORDERED', 'IN-TRANSIT']);
export const MAX_LINES = 10;                   // per tap — the Worker's cap too
export const WO_ID_RE = /^W\d{4}$/;
export const HOURS_MIN = 0.25;
export const HOURS_MAX = 12;
export const HOURS_STEP = 0.25;

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
 *   delivered   newest delivery first
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
    delivered: rows.filter((r) => r.part.state === 'DELIVERED')
      .sort((a, b) => byDateAsc(b.part.delivered, a.part.delivered) || tie(a, b)),
  };
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

/** 1 -> "1", 2.5 -> "2.5", 0.75 -> "0.75". Hours, never money. */
export const fmtHours = (h) => {
  const n = num(h);
  return n == null ? '0' : String(Math.round(n * 100) / 100);
};
export const hoursValid = (h) => typeof h === 'number' && isFinite(h)
  && h >= HOURS_MIN && h <= HOURS_MAX && Math.round(h * 4) === h * 4;

/** "W1001 · 2 parts open · 3.5 h" — the unit page's chip. Engine counts only. */
export function woChipText(wo, unit) {
  const id = (wo && wo.id) || (unit && unit.work_order) || '';
  const open = num(wo ? wo.parts_open : unit && unit.wo_parts_open) ?? 0;
  const hours = num(wo && wo.hours_total);
  const bits = [id, `${open} part${open === 1 ? '' : 's'} open`];
  if (hours != null) bits.push(`${fmtHours(hours)} h`);
  return bits.join(' · ');
}

/** OPEN sheet default (§4): a unit in prep is being made rent-ready; anything else is a repair. */
export const defaultPurpose = (unit) => (unit && unit.readiness === 'NEEDS-PREP' ? 'RENT-READY' : 'REPAIR');

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
 *   state        owner                          service                          sales
 *   REQUESTED    Mark ordered · Cancel line     Cancel line (own work order)     —
 *   ORDERED      In transit · Delivered         In transit · Delivered           —
 *   IN-TRANSIT   Delivered                      Delivered                        —
 *
 * Nothing on a closed work order. "Own work order" is `opened_by` against the
 * signed-in name — shown here so a tech isn't offered a button the engine will
 * refuse; the engine is still what enforces it.
 */
export function partActions(wo, part, role, meName) {
  if (!wo || wo.status === 'CLOSED' || !part) return [];
  const works = role === 'owner' || role === 'service';
  if (part.state === 'REQUESTED') {
    if (role === 'owner') return ['ORDERED', 'CANCELLED'];
    if (role === 'service' && meName && wo.opened_by === meName) return ['CANCELLED'];
    return [];
  }
  if (part.state === 'ORDERED') return works ? ['IN-TRANSIT', 'DELIVERED'] : [];
  if (part.state === 'IN-TRANSIT') return works ? ['DELIVERED'] : [];
  return [];
}

/** Close: owner's, and only once every line is DELIVERED or CANCELLED (the engine guards it too). */
export const closeShown = (wo, role) => !!wo && wo.status !== 'CLOSED' && role === 'owner';
export const closeEnabled = (wo) => !!wo && wo.status !== 'CLOSED' && openLinesOf(wo).length === 0;
/** Cancel the whole order: owner, or whoever opened it while nothing has left REQUESTED. */
export function cancelShown(wo, role, meName) {
  if (!wo || wo.status === 'CLOSED') return false;
  if (role === 'owner') return true;
  return !!meName && wo.opened_by === meName && partsOf(wo).every((p) => p.state === 'REQUESTED');
}

/* ---- pending (§2) ----
 * OPEN has no W-number until the engine runs, so it is keyed on the top-level
 * serial and drawn as a synthetic ⏳ NEW card — never with an invented id. Every
 * other verb carries payload.work_order and badges that record. */
const pl = (e) => (e && e.payload) || {};
const isWo = (e) => !!e && e.action === 'work_order';
export const pendingOpens = (pending) => (Array.isArray(pending) ? pending.filter((e) => isWo(e) && pl(e).action === 'OPEN') : []);
export const pendingOpenFor = (pending, serial) => (serial == null ? [] : pendingOpens(pending)
  .filter((e) => e.serial != null && String(e.serial) === String(serial)));
export const pendingForWo = (pending, id) => (!id || !Array.isArray(pending) ? []
  : pending.filter((e) => isWo(e) && pl(e).action !== 'OPEN' && pl(e).work_order === id));

/** One line of English for a pending work_order tap, whatever verb it was. */
export function describeWoEvent(e) {
  const p = pl(e);
  const n = Array.isArray(p.parts) ? p.parts.length : 0;
  const parts = `${n} part${n === 1 ? '' : 's'}`;
  switch (p.action) {
    case 'OPEN': return `new work order — ${n ? parts : 'labor only'}`;
    case 'ADD-PARTS': return `${parts} added`;
    case 'PART-STATE': return `line ${p.line} → ${PART_STATE_LABEL[p.state] || p.state}`;
    case 'LABOR': return `${fmtHours(p.hours)} h logged for ${p.who || 'someone'}`;
    case 'CLOSE': return 'close';
    case 'CANCEL': return 'cancel the work order';
    default: return 'work order change';
  }
}
