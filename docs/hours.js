/**
 * hours.js — D134 v2.0 (2026-11-18): hours on every job. Pure; no DOM, no clock of its own.
 *
 * THE GATE IS THE ENGINE'S. From `meta.hours_required_from` (the engine ships the
 * date; this file never holds one) a work-order Close needs its POOL (H3: the work
 * order + the ticket it is tied to + that ticket's other work orders), a ticket
 * moved into READY-TO-INVOICE or COMPLETE by anyone but the OWNER needs its pool
 * (`hours_total`), and a dispatch Done needs hours (0.25 to 12, quarter steps,
 * never zero). The owner is never gated on a ticket (H5). The page only helps the tech meet the gate: it asks
 * for hours where they are missing, and once the date has come it keeps the button
 * off until they are there. A refusal arrives through the ordinary rejection notice
 * with the engine's own sentence ("hours needed to close S1042 — add them and try again").
 *
 * H6: no nag. Nothing here counts jobs without hours, ages them or lists them —
 * there is no such badge, counter or report anywhere on the page.
 *
 * H10: a snapshot without `meta.hours_required_from` comes from an engine before
 * D134 — it would drop the new keys on the floor — so the page draws no hours UI at
 * all for it (hoursLive false) and renders exactly as it did.
 *
 * Dates are YYYY-MM-DD strings compared as strings (CLAUDE.md rule 7 — a date-only
 * string is never handed to the Date constructor). `today` is the caller's todayCentral().
 */
import { laborPayloads, hoursValid, fmtHours } from './workorders.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** H3: the two ticket stages a move into needs hours. */
export const HOURS_GATED_STAGES = new Set(['READY-TO-INVOICE', 'COMPLETE']);
/** §5: the line under a disabled work-order Close. */
export const NEED_LABOR_LINE = 'Add labor to close';
export const HOURS_FIELD_PROBLEM = 'Put the hours in — quarter hours, 0.25 to 12.';

/** The engine's gate date, or null on a pre-D134 snapshot. */
export const hoursFrom = (snap) => {
  const v = snap && snap.meta ? snap.meta.hours_required_from : null;
  return typeof v === 'string' && DATE_RE.test(v) ? v : null;
};
/** True when the snapshot comes from a D134 engine — the hours UI draws at all. */
export const hoursLive = (snap) => hoursFrom(snap) != null;
/** True from the engine's date on (string compare, Central date strings). */
export const hoursRequired = (snap, today) => {
  const from = hoursFrom(snap);
  return from != null && typeof today === 'string' && DATE_RE.test(today) && today >= from;
};

/** A ticket's own labor entries (H1). A pre-D134 row reads as none. */
export const ticketLabor = (t) => (t && Array.isArray(t.labor) ? t.labor.filter((l) => l && typeof l === 'object') : []);
/** The H3 pool, read off the engine — the page never adds. A row without it reads 0. */
export const ticketHours = (t) => (t ? num(t.hours_total) || 0 : 0);

/**
 * H3, as the snapshot shows it: a work order is tied to this ticket by its
 * `ticket`, by the billing ticket its damage block names, or by the ticket's
 * `damage_wo`.
 */
export const tiedTo = (t, w) => !!t && !!w && ((!!t.ticket && (w.ticket === t.ticket
  || (w.damage && typeof w.damage === 'object' && w.damage.billing_ticket === t.ticket))) || (!!w.id && t.damage_wo === w.id));

/**
 * §Page: "from W1003 · 2 h" — the tied work orders that carry hours of their
 * own, one read-only line each (their hours are already in hours_total).
 */
export function linkedWoHours(t, workOrders) {
  if (!t || !Array.isArray(workOrders)) return [];
  return workOrders
    .filter((w) => tiedTo(t, w) && (num(w.hours_total) || 0) > 0)
    .map((w) => ({ id: w.id, hours: w.hours_total, text: `from ${w.id} · ${fmtHours(w.hours_total)} h` }));
}

/** Pending events that will put hours on this ticket before a move is judged (the engine applies in order). */
export const pendingTicketHours = (pending, ticket) => (Array.isArray(pending) ? pending : []).filter((e) => {
  const p = (e && e.payload) || {};
  return p.ticket === ticket && ((e.action === 'ticket_labor') || (e.action === 'ticket_update' && num(p.hours) != null));
});

/**
 * The stage sheet asks for hours when the move is into READY-TO-INVOICE or
 * COMPLETE, the snapshot is D134's and the pool is empty (a pending
 * ticket_labor counts — it lands first).
 */
export const askHoursOnMove = (snap, t, stage, pendingHours = 0) =>
  hoursLive(snap) && HOURS_GATED_STAGES.has(stage) && ticketHours(t) === 0 && !pendingHours;

/** …and requires them only from the date, and never of the owner (H5 — the owner always moves a ticket). */
export const hoursRequiredOnMove = (snap, today, role) => role !== 'owner' && hoursRequired(snap, today);

/**
 * The one hours field on a stage or Done sheet: '' / 0 is "not filled".
 * Required (the date has come) → a problem until it is a real reading; never
 * required → only a bad reading is a problem.
 */
export function hoursFieldProblem(value, required) {
  const v = value === '' || value == null ? 0 : Number(value);
  if (v === 0) return required ? HOURS_FIELD_PROBLEM : null;
  return hoursValid(v) ? null : HOURS_FIELD_PROBLEM;
}

/** The work order's pool (H3) — `hours_pool`, else its own `hours_total` on a pre-v2.0 row. */
export const woPool = (wo) => (wo ? (num(wo.hours_pool) != null ? num(wo.hours_pool) : num(wo.hours_total) || 0) : 0);

/**
 * From the date, a work order with an empty pool can't close. Labor waiting in
 * this phone's pending list counts — the engine applies it before the Close.
 */
export const woNeedsLabor = (wo, required, pendingLabor = 0) =>
  !!required && !!wo && wo.status === 'OPEN' && !(woPool(wo) > 0) && !pendingLabor;

/**
 * + Hours on a ticket → ticket_labor payloads: the work order's two steppers
 * (TRAVEL first), one event per non-zero stepper; no damage on a ticket (H1).
 */
export function ticketLaborPayloads({ ticket, date = null, who, note = null, travel, labor }) {
  return laborPayloads({ key: { ticket }, date, who, note, travel, labor })
    .map(({ action, damage, ...p }) => p);   // eslint-disable-line no-unused-vars
}
