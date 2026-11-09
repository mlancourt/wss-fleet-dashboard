/* Shop stock (D127) — stock replenishment orders (K-numbers) + the shelf ledger.
 *
 * A K-order is a work order with everything a shelf restock has no use for
 * taken out: no serial, no inspection sheet, no labor, no Close (the engine
 * closes it when the last line is DELIVERED or CANCELLED). Every K line is a
 * vendor line — there is no Use-from-stock on a stock order. The K-number is
 * the vendor PO, like W, S and P.
 *
 * `stock[]` is the ledger, one row per part number, as the engine derived it.
 * on_hand may be negative: there is no opening count, so a pull of a part the
 * ledger has not seen yet reads −1 and corrects itself at the first restock —
 * drawn muted as "pre-ledger", never as an alarm.
 *
 * MONEY: `last_cost` / `value` / `value_total` arrive only for owner/sales and
 * only once the engine ships them (SHIP_VALUE) — the Worker strips them for
 * service. Nothing here invents a figure: absent or null draws "—".
 *
 * Pure — no DOM, no network — so the selftests can drive it.
 */

export const K_ID_RE = /^K\d{4}$/;
export const K_STATES = ['REQUESTED', 'ORDERED', 'IN-TRANSIT', 'DELIVERED', 'CANCELLED'];
export const K_OPEN_STATES = new Set(['REQUESTED', 'ORDERED', 'IN-TRANSIT']);
export const K_MAX_LINES = 20;                       // per tap (the Worker's cap); the engine holds 30 per order
export const K_DEFAULT_MFR = 'FACTORY-CAT';

export const stockHref = (id) => `#/stock/${encodeURIComponent(id)}`;
export const newStockHref = (evtId) => `#/stock/new/${encodeURIComponent(evtId)}`;

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
export const kParts = (k) => arr(k && k.parts);
export const isOpenK = (k) => !!k && k.status === 'OPEN';
export const kById = (list, id) => arr(list).find((k) => k.id === id) || null;

/** A unit cost in cents ("$12.40") — a filter is not "$12". Value and the shelf total stay whole dollars (fmtMoney). */
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtUnitCost = (n) => (typeof n === 'number' && isFinite(n) ? usd2.format(n) : '—');

/** A money figure we may draw — a finite number, else null ("—"). */
export const stockMoney = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** Pre-ledger = the shelf gave out a part it was never seen receiving. Muted, informational. */
export const isPreLedger = (row) => !!row && typeof row.on_hand === 'number' && row.on_hand < 0;

/**
 * The fold head: `14 parts · 3 on order · 2 pre-ledger`. Engine counts first,
 * the rows as a fallback. "On order" is the open K lines (REQUESTED counts —
 * from the shelf's side, a part somebody asked for is on order).
 */
export function stockFoldCounts(stock, summary, orders) {
  const rows = arr(stock);
  const s = summary && typeof summary === 'object' ? summary : {};
  const num = (v, alt) => (typeof v === 'number' && isFinite(v) ? v : alt);
  const openLines = arr(orders).filter(isOpenK).reduce((n, k) => n + kParts(k).filter((l) => K_OPEN_STATES.has(l.state)).length, 0);
  return {
    parts: num(s.parts_tracked, rows.length),
    onOrder: num(s.lines_open, openLines),
    preLedger: num(s.negative_count, rows.filter(isPreLedger).length),
  };
}

/** The fold head text — zero segments drop, nothing at all reads "no shelf history yet". */
export function stockFoldText(c) {
  const segs = [[c.parts, c.parts === 1 ? 'part' : 'parts'], [c.onOrder, 'on order'], [c.preLedger, 'pre-ledger']]
    .filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
  return segs.length ? segs.join(' · ') : 'no shelf history yet';
}

/** The newest OPEN K that has this part on an open line — where the "on order" chip goes. */
export function newestOpenKFor(orders, partNumber) {
  const n = norm(partNumber);
  const hits = arr(orders).filter((k) => isOpenK(k) && kParts(k).some((l) => K_OPEN_STATES.has(l.state) && norm(l.part_number) === n));
  hits.sort((a, b) => String(b.opened || '').localeCompare(String(a.opened || '')) || String(b.id).localeCompare(String(a.id)));
  return hits[0] || null;
}
export const norm = (pn) => String(pn || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The shelf value footer — only when the engine shipped value_total (owner/sales, SHIP_VALUE on). */
export const shelfValue = (summary) => stockMoney(summary && summary.value_total);

/* ---- the 📦 Parts tracker band ---- */

/** Open K lines by state, for the tracker head. REQUESTED is always "to order" — a K has no sheet to wait on. */
export function kTrackerCounts(orders) {
  const c = { toOrder: 0, ordered: 0, inTransit: 0 };
  for (const k of arr(orders).filter(isOpenK)) {
    for (const l of kParts(k)) {
      if (l.state === 'REQUESTED') c.toOrder++;
      else if (l.state === 'ORDERED') c.ordered++;
      else if (l.state === 'IN-TRANSIT') c.inTransit++;
    }
  }
  return c;
}

/**
 * The band: OPEN K-orders with a line still open — ORDERED / IN-TRANSIT, and
 * (like a W in the tracker) REQUESTED too, so the "to order" in the head has a
 * row to tap. Oldest first (K-number ties). One row per order. `delivered` = K-orders with a DELIVERED
 * line (the engine ships closed ones 30 days — the window is its), newest
 * delivery first, for the Delivered (30d) fold.
 */
export function kTrackerRows(orders) {
  const active = arr(orders).filter((k) => isOpenK(k) && kParts(k).some((l) => K_OPEN_STATES.has(l.state)))
    .sort((a, b) => String(a.opened || '').localeCompare(String(b.opened || '')) || String(a.id).localeCompare(String(b.id)));
  const delivered = arr(orders).filter((k) => kParts(k).some((l) => l.state === 'DELIVERED' && l.delivered))
    .map((k) => ({ k, newest: kParts(k).filter((l) => l.state === 'DELIVERED' && l.delivered).map((l) => l.delivered).sort().pop() }))
    .sort((a, b) => String(b.newest).localeCompare(String(a.newest)) || String(b.k.id).localeCompare(String(a.k.id)));
  return { active, delivered };
}

/** The earliest `ordered` among a K's moving lines — "ordered Nov 10" on the band row. */
export const kOrderedOn = (k) => kParts(k).map((l) => l.ordered).filter(Boolean).sort()[0] || null;
/** The newest moving box on a K (in transit first) — the tracking chip on the band row. */
export function kTrackingLine(k) {
  const ls = kParts(k).filter((l) => l.tracking && l.state !== 'CANCELLED');
  return ls.find((l) => l.state === 'IN-TRANSIT') || ls[ls.length - 1] || null;
}
/** The vendors a K's ordered lines went to — usually one (RPS). */
export const kVendors = (k) => [...new Set(kParts(k).map((l) => l.vendor).filter(Boolean))];

/* ---- the K page ---- */

/**
 * Which line buttons a role is offered (the D65 matrix, no Use-from-stock):
 *   REQUESTED   owner: Mark ordered · Cancel line   the opener: Cancel line
 *   ORDERED     owner/service: In transit · Delivered · (owner) Cancel line
 *   IN-TRANSIT  owner/service: Delivered
 * Nothing on a closed or cancelled order. The engine still referees every one.
 */
export function kPartActions(k, part, role, meName) {
  if (!isOpenK(k) || !part) return [];
  const works = role === 'owner' || role === 'service';
  if (part.state === 'REQUESTED') {
    if (role === 'owner') return ['ORDERED', 'CANCELLED'];
    return meName && k.opened_by === meName ? ['CANCELLED'] : [];
  }
  if (part.state === 'ORDERED') return works ? ['IN-TRANSIT', 'DELIVERED'].concat(role === 'owner' ? ['CANCELLED'] : []) : [];
  if (part.state === 'IN-TRANSIT') return works ? ['DELIVERED'] : [];
  return [];
}

/** Cancel the whole order: owner, or the opener — and only while every line is still REQUESTED (or cancelled). */
export function kCancelShown(k, role, meName) {
  if (!isOpenK(k)) return false;
  if (!(role === 'owner' || (meName && k.opened_by === meName))) return false;
  return kParts(k).every((l) => l.state === 'REQUESTED' || l.state === 'CANCELLED');
}
/** + Add parts: any crew role, on an open order. */
export const kCanAdd = (k, role) => isOpenK(k) && ['owner', 'sales', 'service'].includes(role);

/** The header's status words: `OPEN 2d` · `CLOSED Nov 14 · auto` · `CANCELLED Nov 14`. fmt renders a date verbatim-safe. */
export function kStatusText(k, fmt, ageText) {
  if (!k) return '';
  if (k.status === 'OPEN') return `OPEN${typeof k.age_days === 'number' ? ` ${ageText(k.age_days)}` : ''}`;
  if (k.status === 'CLOSED') return `CLOSED${k.closed ? ` ${fmt(k.closed)}` : ''} · auto`;
  return `${k.status || '—'}${k.closed ? ` ${fmt(k.closed)}` : ''}`;
}

/* ---- pending ---- */

const pl = (e) => (e && e.payload && typeof e.payload === 'object' ? e.payload : {});
/** My-and-everyone's pending OPENs — no K yet; the nonce is the Worker's event id. */
export const pendingStockOpens = (pending) => arr(pending).filter((e) => e.action === 'stock_order' && pl(e).action === 'OPEN');
/** Pending taps on one K-order. */
export const pendingForStock = (pending, id) => arr(pending).filter((e) => e.action === 'stock_order' && pl(e).stock_order === id);

/** Where a pending OPEN went, once the engine applied it — the activity row with the same evt names the K. */
export function landedK(activity, evtId) {
  const bare = (id) => String(id == null ? '' : id).replace(/^evt[:_]/, '');
  const row = arr(activity).find((r) => r.evt && bare(r.evt) === bare(evtId) && K_ID_RE.test(String(r.record || '')));
  return row ? row.record : null;
}

/** One pending K tap in words — the ⏳ rows on the K page and the Parts tab. No money: a K payload carries none. */
export function describeStockEvent(e) {
  const p = pl(e);
  const n = Array.isArray(p.parts) ? p.parts.length : 0;
  if (p.action === 'OPEN') return `⏳ stock order — ${n} line${n === 1 ? '' : 's'}${p.note ? ` (${p.note})` : ''} — numbered at the next run`;
  if (p.action === 'ADD-PARTS') return `⏳ ${n} line${n === 1 ? '' : 's'} added`;
  if (p.action === 'CANCEL') return '⏳ cancel the order';
  if (p.action === 'PART-STATE') {
    const words = { ORDERED: 'ordered', 'IN-TRANSIT': 'in transit', DELIVERED: 'delivered — on the shelf', CANCELLED: 'cancelled' };
    return `⏳ line ${p.line} → ${words[p.state] || p.state}`;
  }
  return '⏳ stock order change';
}

/** The lines a stock-order sheet typed, in order. A row with no part # is not a line. */
export function stockLines(fields) {
  const { mfr, nums = [], descs = [], qtys = [] } = fields || {};
  return nums.map((n, i) => ({
    manufacturer: String(mfr || K_DEFAULT_MFR),
    part_number: String(n || '').trim(),
    description: String(descs[i] || '').trim() || null,
    qty: Math.trunc(Number(qtys[i] || 1)),
  })).filter((l) => l.part_number);
}

/** What's wrong with a stock-order sheet before the round trip, or null. */
export function stockFormProblem(lines) {
  if (!lines.length) return 'Put in at least one part number.';
  if (lines.length > K_MAX_LINES) return `${K_MAX_LINES} lines a tap — add the rest after the next run.`;
  const bad = lines.find((l) => !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 99);
  if (bad) return `Quantity for ${bad.part_number} — a whole number, 1 to 99.`;
  const long = lines.find((l) => l.part_number.length > 40 || (l.description && l.description.length > 80));
  if (long) return `${long.part_number.slice(0, 20)}… — part # up to 40, description up to 80.`;
  return null;
}
