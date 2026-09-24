/* Rental lifecycle (D64) — the Rentals tab's rules, pure.
 *
 * The agreement is the spine: PENDING -> ACTIVE -> OFF-RENT -> ENDED. ENDED
 * never ships, so an ended rental simply leaves the tab. The unit follows the
 * agreement, and the delivery (m-dl-<agreement>) is derived by the engine the
 * same way the return (m-pu-<serial>) always was.
 *
 * Same rules as service.js: no DOM, no network, and no Date parsing of a
 * date-only string (they compare correctly as YYYY-MM-DD text). The engine
 * owns every age — `days_on_rent` arrives computed and is never recomputed
 * here. What this file decides is only which tile goes where and which
 * buttons a role is OFFERED; the Worker and the engine re-check everything.
 *
 * `agreement` is OPAQUE (D59): an int on legacy Integra paper (4130), a string
 * on WSS paper ("R092526A"). Matched with ===, never coerced, and never sorted
 * int-against-string — every tiebreak below goes through String().
 * tools/selftest-rentals.mjs asserts every rule.
 */
import { addDays, isDateStr } from './dates.js';

export const RENTAL_STATUSES = ['PENDING', 'ACTIVE', 'OFF-RENT'];
export const RENTAL_VERBS = ['OUT', 'OFF-RENT', 'IN'];
export const STATUS_LABEL = { PENDING: 'Pending', ACTIVE: 'On rent', 'OFF-RENT': 'Off-rent' };

/** A pre-D64 row has no status. Everything that shipped then was on rent. */
export const statusOf = (a) => (a && RENTAL_STATUSES.includes(a.status) ? a.status : 'ACTIVE');
/** Legacy rows went out on our truck and came home on it. */
export const outMove = (a) => (a && a.out_move === 'CUSTOMER-PICKUP' ? 'CUSTOMER-PICKUP' : 'DELIVER');
export const inMove = (a) => (a && a.in_move === 'CUSTOMER-RETURN' ? 'CUSTOMER-RETURN' : 'PICKUP');

const idKey = (a) => String(a && a.agreement != null ? a.agreement : '');
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
/** Ascending date text, nulls last. */
const byDateAsc = (x, y) => (x && y ? x.localeCompare(y) : x ? -1 : y ? 1 : 0);

/**
 * The three groups, each in its own order (§3):
 *   pending   soonest out_date first
 *   active    longest days_on_rent first — then, for a legacy file where every
 *             age is null, the pre-D64 order: unbilled, then alerts, then name
 *   offRent   oldest off_rent first
 */
export function rentalGroups(agreements) {
  const rows = Array.isArray(agreements) ? agreements.filter(Boolean) : [];
  const sev = (a) => (a.agreement == null ? 0 : (a.alerts && a.alerts.length ? 1 : 2));
  const pending = rows.filter((a) => statusOf(a) === 'PENDING')
    .sort((a, b) => byDateAsc(a.out_date, b.out_date) || idKey(a).localeCompare(idKey(b)));
  const active = rows.filter((a) => statusOf(a) === 'ACTIVE').sort((a, b) => {
    const da = num(a.days_on_rent);
    const db = num(b.days_on_rent);
    if (da !== db) {
      if (da == null) return 1;
      if (db == null) return -1;
      return db - da;
    }
    return sev(a) - sev(b) || String(a.customer || '').localeCompare(String(b.customer || ''))
      || idKey(a).localeCompare(idKey(b));
  });
  const offRent = rows.filter((a) => statusOf(a) === 'OFF-RENT')
    .sort((a, b) => byDateAsc(a.off_rent, b.off_rent) || idKey(a).localeCompare(idKey(b)));
  return { pending, active, offRent };
}

/**
 * Which buttons a role gets on a tile (§3). `service` gets none: a rental is a
 * sales record and the engine refuses them. A row with no agreement id (the
 * unbilled-rental alert) gets none either — there is nothing to name in the
 * event, and that row's fix is paperwork, not a tap.
 *
 *   wentOut     PENDING, customer picks it up. A DELIVER tile has no button:
 *               the truck's Done tap IS the out.
 *   offRent     ACTIVE.
 *   backInShop  OFF-RENT the customer brings back — or, for the owner only,
 *               OFF-RENT on our pickup, as the override for a pickup that
 *               happened off the board.
 */
export function rentalActions(a, role) {
  const none = { wentOut: false, offRent: false, backInShop: false };
  if (!a || a.agreement == null || (role !== 'sales' && role !== 'owner')) return none;
  const st = statusOf(a);
  return {
    wentOut: st === 'PENDING' && outMove(a) === 'CUSTOMER-PICKUP',
    offRent: st === 'ACTIVE',
    backInShop: st === 'OFF-RENT' && (inMove(a) === 'CUSTOMER-RETURN' || role === 'owner'),
  };
}

/** Due back (§3): red once it has passed, amber from the day before. '' otherwise. */
export function dueBackTone(inDate, today) {
  if (!isDateStr(inDate) || !isDateStr(today)) return '';
  if (inDate < today) return 'red';
  if (inDate <= addDays(today, 1)) return 'amber';
  return '';
}

/** A PENDING rental whose out date has already gone by — it never left. */
export const outDatePassed = (a, today) =>
  statusOf(a) === 'PENDING' && isDateStr(a.out_date) && isDateStr(today) && a.out_date < today;

/** The date a sheet may not go past. The engine refuses a future date too. */
export const clampToToday = (date, today) => (isDateStr(date) && date <= today ? date : null);

/** The derived delivery row: `m-dl-<agreement>` (or the id the claim names). */
export function deliveryRow(a, dispatch) {
  if (!a || a.agreement == null) return null;
  const rows = Array.isArray(dispatch) ? dispatch : [];
  const id = (a.delivery && a.delivery.id) || `m-dl-${a.agreement}`;
  return rows.find((r) => r.id === id) || null;
}

/** The return row: a RENTAL-RETURN tagged with this agreement, else m-pu-<serial>. */
export function returnRow(a, dispatch) {
  if (!a) return null;
  const rows = (Array.isArray(dispatch) ? dispatch : []).filter((r) => r.source === 'RENTAL-RETURN');
  return (a.agreement != null && rows.find((r) => r.agreement === a.agreement))
    || (a.serial != null && rows.find((r) => r.id === `m-pu-${a.serial}`))
    || null;
}

/** The agreement a dispatch row belongs to — by the row's own `agreement` key. */
export const agreementForRow = (r, agreements) =>
  (r && r.agreement != null ? (agreements || []).find((a) => a.agreement === r.agreement) || null : null);

/** Unapplied rental_update events for one agreement (strict: the id keeps its type). */
export const pendingForAgreement = (pending, id) => (id == null ? [] : (pending || []).filter((e) =>
  e && e.action === 'rental_update' && e.payload && e.payload.agreement === id));

/** The route segment for an agreement, and the lookup back from it. A route is
 *  text, so this is the one place an id is compared as a string. */
export const agreementHref = (id) => `#/agreement/${encodeURIComponent(String(id))}`;
export const agreementByRoute = (agreements, seg) =>
  (agreements || []).find((a) => a && a.agreement != null && String(a.agreement) === seg) || null;

/** Recurring revenue (D21, amended by D64) counts ACTIVE and OFF-RENT only —
 *  a rental with a clock. A legacy row (no status) was on rent. A PENDING one,
 *  or a status this build has never heard of, is not money yet. */
export const billsNow = (a) => !!a && (a.status == null || a.status === 'ACTIVE' || a.status === 'OFF-RENT');
