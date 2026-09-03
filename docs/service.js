/* Service module + Dispatch board — schema 3 logic.
 *
 * Pure on purpose: no DOM, no network, no Date parsing of date-only strings
 * (they compare correctly as YYYY-MM-DD text). tools/selftest-service.mjs
 * asserts every rule below.
 *
 * The engine owns the truth. Nothing here decides whether a stage change is
 * legal in the business sense — it decides only what buttons a role is offered,
 * which is a convenience. The engine (and the Worker) re-check everything.
 */
import { isDateStr } from './dates.js';

/* ------------------------------------------------------------------ enums --
 * Fixed lists from CLAUDE.md / the Service-Dispatch spec. The Worker validates
 * against the same values; keep the two in step. */

export const STAGES = ['INTAKE', 'INSPECTION', 'QUOTED', 'PARTS-ORDERED', 'IN-PROGRESS', 'READY-TO-INVOICE', 'COMPLETE'];
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
export const LOCATIONS = ['AT-CUSTOMER', 'IN-SHOP'];
export const INTAKE_MOVES = ['NONE', 'PICKUP', 'CUSTOMER-DROP'];
export const RETURN_MOVES = ['NONE', 'DELIVER', 'CUSTOMER-PICKUP'];
export const MACHINE_OWNERS = ['CUSTOMER', 'WSS'];

export const KINDS = ['PICKUP', 'DELIVER'];
export const RIGS = ['KEVIN-LIFTGATE', 'JOSH-LIFTGATE', 'TRAILER-6000', 'TRAILER-3000'];
export const DRIVERS = ['Matt', 'Kevin', 'Josh', 'Zac'];
export const SOURCES = ['RENTAL-RETURN', 'SERVICE-IN', 'SERVICE-OUT', 'MANUAL'];
export const DISPATCH_STATUSES = ['OPEN', 'SCHEDULED', 'DONE'];

/* Shop-floor wording. The enum is the wire value; these are what a glove reads. */
export const STAGE_LABEL = {
  INTAKE: 'Intake', INSPECTION: 'Inspection', QUOTED: 'Quoted', 'PARTS-ORDERED': 'Parts ordered',
  'IN-PROGRESS': 'In progress', 'READY-TO-INVOICE': 'Ready to invoice', COMPLETE: 'Complete',
};
export const MOVE_LABEL = {
  NONE: 'nothing to move', PICKUP: 'we pick it up', 'CUSTOMER-DROP': "they're dropping it off",
  DELIVER: 'we deliver it back', 'CUSTOMER-PICKUP': "they'll pick it up",
};
export const SOURCE_GLYPH = { 'RENTAL-RETURN': '📦', 'SERVICE-IN': '🔧', 'SERVICE-OUT': '🔧', MANUAL: '✏️' };

/* --------------------------------------------------------------- tickets -- */

/** The stages a ticket can show. QUOTED / READY-TO-INVOICE are customer-billing
 *  stages — a fleet machine of ours never gets quoted or invoiced. */
export function stagesFor(machineOwner) {
  return machineOwner === 'WSS'
    ? STAGES.filter((s) => s !== 'QUOTED' && s !== 'READY-TO-INVOICE')
    : STAGES.slice();
}

/**
 * May this role move this ticket to this stage?
 *   stage changes at all   service | owner
 *   COMPLETE on a customer ticket   owner only (Matt closes after invoicing)
 */
export function canStage(ticket, stage, role) {
  if (role !== 'service' && role !== 'owner') return false;
  if (!stagesFor(ticket && ticket.machine_owner).includes(stage)) return false;
  if (stage === 'COMPLETE' && (!ticket || ticket.machine_owner !== 'WSS') && role !== 'owner') return false;
  return true;
}

/** The stage picker as data: what to draw, what's filled, what's disabled and why. */
export function stageOptions(ticket, role) {
  return stagesFor(ticket && ticket.machine_owner).map((stage) => ({
    stage,
    label: STAGE_LABEL[stage] || stage,
    current: !!ticket && ticket.stage === stage,
    enabled: canStage(ticket, stage, role),
    caption: stage === 'COMPLETE' && ticket && ticket.machine_owner !== 'WSS' && role !== 'owner'
      ? 'Matt closes after invoicing.' : null,
  }));
}

/** 'all' | 'CUSTOMER' | 'WSS' */
export function filterTickets(queue, filter) {
  const list = Array.isArray(queue) ? queue : [];
  if (filter === 'CUSTOMER' || filter === 'WSS') return list.filter((t) => t.machine_owner === filter);
  return list.slice();
}

/**
 * Kanban columns in stage order. A stage the engine invents that we don't know
 * about still gets a column at the end — never drop a ticket on the floor.
 * `count` prefers service_summary.open_by_stage when it is trustworthy (no
 * filter applied); otherwise it is what's actually rendered.
 */
export function columnize(queue, { summary = null, filter = 'all' } = {}) {
  const list = filterTickets(queue, filter);
  const extra = [...new Set((Array.isArray(queue) ? queue : [])
    .map((t) => t && t.stage).filter((s) => s && !STAGES.includes(s)))];
  const byStage = STAGES.concat(extra);
  const open = summary && summary.open_by_stage;
  return byStage.map((stage) => {
    const tickets = list.filter((t) => t.stage === stage);
    const fromSummary = filter === 'all' && open && typeof open[stage] === 'number' ? open[stage] : null;
    return { stage, label: STAGE_LABEL[stage] || stage, tickets, count: fromSummary == null ? tickets.length : fromSummary };
  });
}

/** Open tickets first, HIGH first, then oldest — for anything that needs one list. */
const PRI_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
export function sortTickets(list) {
  return (list || []).slice().sort((a, b) =>
    (a.status === 'CLOSED') - (b.status === 'CLOSED')
    || (PRI_RANK[a.priority] ?? 3) - (PRI_RANK[b.priority] ?? 3)
    || (Number(b.age_days) || 0) - (Number(a.age_days) || 0)
    || String(a.ticket || '').localeCompare(String(b.ticket || '')));
}

/** A move the ticket says it needs but that has no live dispatch row yet.
 *  -> { intake: bool, ret: bool } — which "Add a …" offers to show. */
export function missingMoves(ticket, rows) {
  const live = (rows || []).filter((r) => r.status !== 'DONE');
  return {
    intake: !!ticket && ticket.intake_move === 'NONE' && !live.some((r) => r.kind === 'PICKUP'),
    ret: !!ticket && ticket.return_move === 'NONE' && !live.some((r) => r.kind === 'DELIVER'),
  };
}

/* -------------------------------------------------------------- dispatch -- */

export const isLive = (r) => r && r.status !== 'DONE';

/** Nav badge + "how much is on the board": OPEN + SCHEDULED. DONE rows linger 7 days and don't count. */
export const openCount = (dispatch) => (dispatch || []).filter(isLive).length;

/** The ticket's own truck moves, live ones first. */
export function dispatchFor(dispatch, ticketId) {
  if (!ticketId) return [];
  return (dispatch || []).filter((r) => r.ticket === ticketId)
    .sort((a, b) => (a.status === 'DONE') - (b.status === 'DONE') || String(a.id).localeCompare(String(b.id)));
}

export const dispatchById = (dispatch, id) => (dispatch || []).find((r) => r.id === id) || null;

/** Does this unit have a live truck move? (unit page + kanban 🚚 glyph) */
export const dispatchForSerial = (dispatch, serial) =>
  (dispatch || []).filter((r) => serial != null && String(r.serial) === String(serial));

/** Dated rows by date ascending, undated after. Ties broken by id so the order is stable. */
export function sortOpen(rows) {
  return (rows || []).slice().sort((a, b) => {
    const ad = isDateStr(a.date);
    const bd = isDateStr(b.date);
    if (ad !== bd) return ad ? -1 : 1;
    if (ad && a.date !== b.date) return a.date < b.date ? -1 : 1;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

/** Scheduled rows grouped by date: [{ date, rows }], dated first, undated last. */
export function groupByDate(rows) {
  const map = new Map();
  for (const r of sortOpen(rows)) {
    const k = isDateStr(r.date) ? r.date : '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return [...map.entries()].map(([date, list]) => ({ date, rows: list }));
}

/** The three sections of the board, in the order they're stacked. */
export function sections(dispatch) {
  const all = Array.isArray(dispatch) ? dispatch : [];
  return {
    open: sortOpen(all.filter((r) => r.status === 'OPEN')),
    scheduled: groupByDate(all.filter((r) => r.status === 'SCHEDULED')),
    scheduledCount: all.filter((r) => r.status === 'SCHEDULED').length,
    done: sortOpen(all.filter((r) => r.status === 'DONE')),
  };
}

/**
 * Same rig, same day. Warn, NEVER block — two runs on one trailer is often
 * exactly the plan. Trusts `dispatch_warnings` when the engine sent one, and
 * also looks at the snapshot itself so a claim made this minute still warns.
 * -> null, or { rig, date, ids }
 */
export function rigClash({ dispatch, warnings, rig, date, excludeId = null }) {
  if (!rig || !isDateStr(date)) return null;
  const fromEngine = (warnings || []).find((w) => w && w.rig === rig && w.date === date);
  const ids = (dispatch || [])
    .filter((r) => r.status === 'SCHEDULED' && r.rig === rig && r.date === date && r.id !== excludeId)
    .map((r) => r.id);
  if (fromEngine) return { rig, date, ids: [...new Set([...(fromEngine.ids || []), ...ids])] };
  return ids.length ? { rig, date, ids } : null;
}

/** Who this person may put behind the wheel. Owner picks anyone; everyone else is themselves. */
export function driverChoices(me) {
  const role = (me && me.role) || '';
  const name = (me && me.name) || '';
  if (role === 'owner') return DRIVERS.slice();
  // A name that isn't one of the four (mock user, a new hire not yet in the
  // list) can't be narrowed to "just me" without offering nothing at all.
  return DRIVERS.includes(name) ? [name] : DRIVERS.slice();
}

export const defaultDriver = (me) => {
  const choices = driverChoices(me);
  const name = (me && me.name) || '';
  return choices.includes(name) ? name : choices[0] || '';
};

/** owner may cancel, and only a run someone typed in by hand. */
export const canCancel = (row, role) => role === 'owner' && !!row && row.source === 'MANUAL';

/**
 * Pick-ups the engine hasn't put on the board yet: a pickups[] entry whose
 * serial has no live RENTAL-RETURN row. Normally empty — it exists so a unit
 * the customer released can never go quiet just because a row is missing.
 */
export function unbookedPickups(pickups, dispatch) {
  const booked = new Set((dispatch || [])
    .filter((r) => r.source === 'RENTAL-RETURN' && isLive(r) && r.serial != null)
    .map((r) => String(r.serial)));
  return (pickups || []).filter((p) => !booked.has(String(p.serial)));
}
