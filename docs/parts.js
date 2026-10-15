/* Parts sales — D88 logic (Parts-Site-Spec).
 *
 * Pure on purpose: no DOM, no network, no Date parsing of date-only strings.
 * tools/selftest-parts.mjs asserts every rule below.
 *
 * A parts order is a lead-shaped front (REQUESTED → QUOTED → APPROVED) bolted
 * to a ticket-order-shaped tail (ORDERED → IN-TRANSIT → DELIVERED), and the
 * P-number IS the vendor PO, the way W and S are. Three things to keep straight:
 *
 *   1. MONEY IS ABSENT, NOT ZERO. The Worker deletes `value` (every key in
 *      `parts_summary.money_fields`) for a `service` token, and until the
 *      engine flips SHIP_VALUE it ships `value: null` for everyone. Nothing
 *      here invents a figure; a null draws nothing.
 *   2. THE GATE. Leaving APPROVED spends money, so ORDERED (and DELIVERED on a
 *      SHOP-STOCK order, which skips the vendor) needs, by `terms`:
 *        CASH     paid date + invoice #  (cash orders ship after payment)
 *        ACCOUNT  customer PO            (account orders need the PO)
 *      The engine refuses the move otherwise — and it refuses at the NEXT RUN,
 *      silently from where the phone stands. So the page asks for the gate
 *      fields in the same sheet and sends them in the same event.
 *   3. The engine owns the truth. Ages, stale flags, the closed window and the
 *      counts all arrive computed; we sort and lay out.
 */

export const P_STAGES = ['REQUESTED', 'QUOTED', 'APPROVED', 'ORDERED', 'IN-TRANSIT', 'DELIVERED'];
export const P_SOURCES = ['PHONE', 'EMAIL', 'WEB-CART', 'WEB-FORM', 'WALK-IN', 'SERVICE', 'WEB-CHAT'];   // WEB-CHAT: D99
export const P_TERMS = ['CASH', 'ACCOUNT'];
export const P_SUPPLY = ['VENDOR', 'SHOP-STOCK'];
export const P_SHIP_TO = ['CUSTOMER', 'SHOP'];
export const P_VENDORS = ['RPS', 'IPC-EAGLE', 'NILFISK', 'MINUTEMAN', 'TENNANT', 'OTHER'];
export const P_LOST_REASONS = ['PRICE', 'NO-RESPONSE', 'SOURCED-ELSEWHERE', 'OTHER'];
export const P_ASSIGNEES = ['Matt', 'Kevin'];
/** The closed statuses the Closed strip draws (an OPEN order lives on the board). */
export const P_CLOSED = ['CLOSED', 'LOST', 'DEAD'];

export const P_STAGE_LABEL = {
  REQUESTED: 'Requested', QUOTED: 'Quoted', APPROVED: 'Approved',
  ORDERED: 'Ordered', 'IN-TRANSIT': 'In transit', DELIVERED: 'Delivered',
};
export const P_SOURCE_LABEL = {
  PHONE: 'phone', EMAIL: 'email', 'WEB-CART': 'web cart', 'WEB-FORM': 'web form', 'WALK-IN': 'walk-in', SERVICE: 'service', 'WEB-CHAT': 'web chat',
};
export const P_REASON_LABEL = {
  PRICE: 'Price', 'NO-RESPONSE': 'No response', 'SOURCED-ELSEWHERE': 'Got it elsewhere', OTHER: 'Other',
  SILENT: 'Went silent', COMPLETE: 'Complete',
};
/** The outcome chip in the Closed strip: what `status` + `close_reason` add up to. */
export const P_OUTCOME_LABEL = { CLOSED: 'COMPLETE', LOST: 'LOST', DEAD: 'DEAD' };

const listOr = (v, fallback) => (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') ? v.slice() : fallback.slice());

/** The engine's own lists from `parts_summary`, else ours — a new source needs no deploy. */
export function partsOptions(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  return {
    stages: listOr(s.stages, P_STAGES),
    sources: listOr(s.sources, P_SOURCES),
    terms: listOr(s.terms, P_TERMS),
    supply: listOr(s.supply, P_SUPPLY),
    shipTo: listOr(s.ship_to, P_SHIP_TO),
    vendors: listOr(s.vendors, P_VENDORS),
    lostReasons: listOr(s.lost_reasons, P_LOST_REASONS),
    assignees: listOr(s.assignees, P_ASSIGNEES),
  };
}

export const isOpenOrder = (o) => !!o && o.status === 'OPEN';
export const isStock = (o) => !!o && o.supply === 'SHOP-STOCK';
/** A number we may print. Absent (stripped) or null (not shipped yet) is NOT zero. */
export const partsValue = (o) => (o && typeof o.value === 'number' && isFinite(o.value) ? o.value : null);
export const orderById = (list, id) => (list || []).find((o) => o && o.order === id) || null;

/** The first line of the free-text `parts`, for a card. Multi-line safe. */
export function firstLine(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines[0] || '';
}

/* ------------------------------------------------------------------ board -- */

const STALE_RANK = { red: 0, yellow: 1 };

/** Inside a column: red, then yellow, then longest in stage, then P-number. */
export function sortOrders(list) {
  return (list || []).slice().sort((a, b) =>
    (STALE_RANK[a.stale] ?? 2) - (STALE_RANK[b.stale] ?? 2)
    || (Number(b.age_in_stage_days) || 0) - (Number(a.age_in_stage_days) || 0)
    || String(a.order || '').localeCompare(String(b.order || '')));
}

/**
 * Six columns by stage. Counts from `parts_summary.open_by_stage` (the engine's
 * number) when it has one for that stage, else the rows we drew. An OPEN order
 * in a stage we don't know still gets a column — hiding one is a display
 * choice, dropping an order is data loss.
 */
export function partsColumns(orders, summary = null) {
  const open = (orders || []).filter(isOpenOrder);
  const base = partsOptions(summary).stages;
  const extra = [...new Set(open.map((o) => o.stage).filter((s) => s && !base.includes(s)))];
  const counts = summary && summary.open_by_stage && typeof summary.open_by_stage === 'object' ? summary.open_by_stage : {};
  return base.concat(extra).map((stage) => {
    const rows = sortOrders(open.filter((o) => o.stage === stage));
    return { stage, label: P_STAGE_LABEL[stage] || stage, orders: rows,
      count: typeof counts[stage] === 'number' ? counts[stage] : rows.length };
  });
}

/** The Closed (14d) strip: CLOSED · LOST · DEAD, most recently closed first. */
export function closedOrders(orders) {
  return (orders || []).filter((o) => o && P_CLOSED.includes(o.status))
    .sort((a, b) => String(b.closed || '').localeCompare(String(a.closed || ''))
      || String(a.order || '').localeCompare(String(b.order || '')));
}

/** The nav badge: requests nobody has quoted — the engine's count. */
export function partsBadge(summary) {
  const n = summary && summary.requested_unquoted;
  return typeof n === 'number' && n > 0 ? n : 0;
}

/* ----------------------------------------------------------- stage picker -- */

export const canEditOrder = (role) => role === 'sales' || role === 'owner';
/** LOST / DEAD: owner any time; sales only before money moved (spec §3). The engine referees too. */
export const canCloseOrder = (role, o) => role === 'owner'
  || (role === 'sales' && !!o && ['REQUESTED', 'QUOTED', 'APPROVED'].includes(o.stage));
/** Done (COMPLETE) is Matt's, and only once the box has landed. */
export const canComplete = (role, o) => role === 'owner' && isOpenOrder(o) && o.stage === 'DELIVERED';

/**
 * The stages this order can be offered. SHOP-STOCK never goes ORDERED or
 * IN-TRANSIT — it was already on the shelf: APPROVED → DELIVERED on the gate.
 * Forward-only, except the owner may step back ONE inside REQUESTED…ORDERED
 * (a mis-tap). ORDERED itself is the owner's tap. Everything else the engine
 * referees — this only keeps the obviously-refused buttons from being offered.
 */
export function partsStageOptions(o, role, summary = null) {
  const all = partsOptions(summary).stages.filter((s) => !(isStock(o) && (s === 'ORDERED' || s === 'IN-TRANSIT')));
  const order = P_STAGES;
  const cur = order.indexOf(o && o.stage);
  return all.map((stage) => {
    const i = order.indexOf(stage);
    const current = !!o && o.stage === stage;
    const back = cur >= 0 && i >= 0 && i < cur;
    const stepBack = role === 'owner' && back && i === cur - 1 && cur <= order.indexOf('ORDERED');
    const ownerOnly = stage === 'ORDERED';
    const enabled = canEditOrder(role) && !current && (!back || stepBack) && (!ownerOnly || role === 'owner');
    return { stage, label: P_STAGE_LABEL[stage] || stage, current, enabled, ownerOnly };
  });
}

/** Does moving into this stage pass through the money gate? */
export const isGated = (o, stage) => stage === 'ORDERED' || (stage === 'DELIVERED' && isStock(o));

/**
 * What the stage sheet must ask for, so the event the engine sees is one it
 * can apply. Each entry: { key, label, type, required, value } — `value` is the
 * record's current one (the pre-fill), never invented.
 *   QUOTED      quote # + value
 *   ORDERED     vendor (+ vendor ref), then the gate by terms
 *   IN-TRANSIT  tracking
 *   DELIVERED   on SHOP-STOCK only: the gate (it skipped ORDERED)
 */
export function stageFields(o, stage) {
  const r = o || {};
  const q = r.quote && typeof r.quote === 'object' ? r.quote : null;
  const f = (key, label, type, required, value) => ({ key, label, type, required, value: value == null ? '' : value });
  const gate = () => ((r.terms || 'CASH') === 'ACCOUNT'
    ? [f('customer_po', 'Customer PO #', 'text', true, r.customer_po)]
    : [f('paid', 'Paid on', 'date', true, r.paid), f('invoice', 'Invoice #', 'text', true, r.invoice)]);
  if (stage === 'QUOTED') return [f('quote', 'Quote #', 'text', true, q && q.number), f('value', 'Quoted value (pre-tax)', 'money', true, partsValue(r))];
  if (stage === 'ORDERED') return [f('vendor', 'Vendor', 'vendor', true, r.vendor), f('vendor_ref', 'Vendor ref', 'text', false, r.vendor_ref), ...gate()];
  if (stage === 'IN-TRANSIT') return [f('tracking', 'Tracking #', 'text', true, r.tracking)];
  if (stage === 'DELIVERED' && isStock(r)) return gate();
  return [];
}

/** The gate's sentence, for the sheet — the engine's own words. */
export const gateText = (o) => ((o && o.terms) === 'ACCOUNT'
  ? 'Account order — needs the customer’s PO before it ships.'
  : 'Cash order — ships after payment: paid date and invoice # first.');

/* -------------------------------------------------------- shipments (D98) --
 * One entry per box (Web-Order-Fulfillment-Site-Spec §1). A web cart is
 * typically a shelf item shipped from Ixonia plus an RPS drop-ship: two boxes,
 * two carriers, two delivery dates. The record's own tracking/carrier/delivered
 * mirror the LATEST box; `boxes_open` (tracking, not delivered) and
 * `legs_pending` (VENDOR supply, no vendor box yet) are the engine's counts.
 */

export const P_SHIP_FROM = ['SHOP', 'VENDOR'];

/** The boxes, as the engine sent them. A pre-D98 row has none. */
export const shipmentsOf = (o) => (o && Array.isArray(o.shipments) ? o.shipments.filter((b) => b && typeof b === 'object') : []);

/** The engine's open-box count; absent on a pre-D98 row → 0. */
export const boxesOpen = (o) => (o && typeof o.boxes_open === 'number' && isFinite(o.boxes_open) ? o.boxes_open : 0);

/** The newest box with a tracking number: latest `shipped`, then highest id. */
export function latestShipment(o) {
  const list = shipmentsOf(o).filter((b) => b.tracking);
  if (!list.length) return null;
  return list.slice().sort((a, b) => String(b.shipped || '').localeCompare(String(a.shipped || ''))
    || (Number(b.id) || 0) - (Number(a.id) || 0))[0];
}

/** Ship from shop: owner/sales, an OPEN order from APPROVED on. */
export const canShipBox = (role, o) => canEditOrder(role) && isOpenOrder(o)
  && P_STAGES.indexOf(o.stage) >= P_STAGES.indexOf('APPROVED');

/* ---------------------------------------------------- landing tracker band -- */

/**
 * The 📦 tracker's Parts sales band: OPEN orders at ORDERED or IN-TRANSIT —
 * and (D98) any OPEN order with a box moving, whatever its stage (a shop box
 * that left before the vendor order was placed). Oldest order first.
 */
export function partsInFlight(orders) {
  return (orders || []).filter((o) => isOpenOrder(o) && (o.stage === 'ORDERED' || o.stage === 'IN-TRANSIT' || boxesOpen(o) > 0))
    .sort((a, b) => flightDate(a).localeCompare(flightDate(b)) || String(a.order).localeCompare(String(b.order)));
}

/** When it went in flight: the vendor order, else the first box out (a shop box before the vendor order). */
function flightDate(o) {
  if (o.ordered) return String(o.ordered);
  const shipped = shipmentsOf(o).map((b) => b.shipped).filter(Boolean).map(String).sort();
  return shipped[0] || '';
}

/** {ordered, inTransit} over the in-flight rows. A box moving counts as in transit, whatever the stage. */
export function inFlightCounts(rows) {
  const list = rows || [];
  return {
    ordered: list.filter((o) => o.stage === 'ORDERED' && !boxesOpen(o)).length,
    inTransit: list.filter((o) => o.stage === 'IN-TRANSIT' || boxesOpen(o) > 0).length,
  };
}

/* ------------------------------------------------------------- stats strip --
 * D103 (2026-10-15). `parts_summary.stats` is the engine's read of the WHOLE
 * ledger (every P file, not the 14-day window this page gets): per window,
 * `windows[w]` = { days, opened, per_day, complete, lost, dead } for everyone and
 * `money[w]` = { quoted, avg_value, won_value } for owner/sales only — the
 * Worker deletes `stats.money` for a service token, and the engine omits it
 * until that strip is live. Absent money draws nothing; it is not zero.
 * One muted line under the board, not a scoreboard (Matt, 10/15): the board's
 * job is what needs quoting and what's in a box; the figures wait to be asked.
 */

export const P_STAT_WINDOWS = ['30d', '90d', 'all'];
export const P_STAT_LABEL = { '30d': '30d', '90d': '90d', all: 'All time' };

/** The next window on a tap: 30d → 90d → all → 30d. An unknown one starts over. */
export function nextStatWindow(w) {
  const i = P_STAT_WINDOWS.indexOf(w);
  return P_STAT_WINDOWS[(i < 0 ? 0 : i + 1) % P_STAT_WINDOWS.length];
}

/**
 * The strip's segments for one window, as { text, kind } in draw order — or
 * null when the snapshot has no stats (pre-D103) or nothing was ever opened.
 *   counts  "8 orders" · "1.0/day" · "1 complete" · "1 lost" · "1 dead" (zero lost/dead are left out)
 *   money   "avg $531" (only over orders that carry a value) · "won $1,809" (when > 0)
 * `fmt` is the page's money formatter; the strip never formats a dollar itself.
 */
export function partsStripSegments(summary, win, fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`) {
  const st = summary && summary.stats && typeof summary.stats === 'object' ? summary.stats : null;
  const w = st && st.windows && typeof st.windows === 'object' ? st.windows[win] : null;
  if (!w || typeof w.opened !== 'number') return null;
  const seg = [];
  seg.push({ text: `${w.opened} order${w.opened === 1 ? '' : 's'}`, kind: 'count' });
  if (w.opened > 0 && typeof w.per_day === 'number') seg.push({ text: `${w.per_day.toFixed(w.per_day >= 10 ? 0 : 1)}/day`, kind: 'count' });
  const m = st.money && typeof st.money === 'object' && st.money[win] && typeof st.money[win] === 'object' ? st.money[win] : null;
  if (m && typeof m.avg_value === 'number' && isFinite(m.avg_value)) seg.push({ text: `avg ${fmt(m.avg_value)}`, kind: 'money' });
  if (typeof w.complete === 'number') seg.push({ text: `${w.complete} complete`, kind: 'ok' });
  if (m && typeof m.won_value === 'number' && m.won_value > 0) seg.push({ text: `won ${fmt(m.won_value)}`, kind: 'money' });
  if (w.lost > 0) seg.push({ text: `${w.lost} lost`, kind: 'bad' });
  if (w.dead > 0) seg.push({ text: `${w.dead} dead`, kind: 'out' });
  return seg;
}
