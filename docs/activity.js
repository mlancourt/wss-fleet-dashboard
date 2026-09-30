/* The activity tape (D78) — `activity[]` on the landing.
 *
 * One line per thing somebody did on the tracker, newest first, with the
 * person's name as a coloured pill. The feed costs nothing to build: the Worker
 * already stamps every event with `{ts, actor}`, and the engine already writes a
 * one-line detail for each event it applies. `activity[]` is those two, joined.
 *
 * Pure — no DOM, no network — so tools/selftest-activity.mjs can assert it. The
 * markup lives in app.js beside the other landing strips (partsTracker), which
 * is where the html helper lives.
 *
 * THE RULE THAT SHAPES THIS FILE (D54 — machines, never people): no counts, no
 * totals, no per-person anything. A name is a pill beside what they did, never
 * a number beside a name. If a function here ever grows a tally by actor, it is
 * the wrong function.
 *
 * Time: `ts` is a full UTC instant (the Worker's stamp), so parsing it is
 * correct. It renders in Central — the shop's clock, the one every other
 * instant in this app renders in (fmtInstantCentral) — so a day label means the
 * same day on every phone and in every test run.
 */

import { todayCentral, addDays } from './dates.js';

/** The snapshot's cap. The engine ships at most this many; we never draw more. */
export const MAX_ROWS = 40;

/**
 * Name → pill hue. Grey for anyone else (`Architect`, `engine`, a fifth hire
 * before somebody adds them here). A new person is ONE line: pick a hue that
 * style.css already defines (`.pill-actor.h-<hue>`) — purple · blue · green ·
 * orange · teal · grey. The hues are the D53 pin family (no brand red), darkened
 * so white text holds ≥ 4.5:1 on every one (selftest-activity checks the sums).
 */
export const ACTOR_COLORS = {
  Matt: 'purple',
  Kevin: 'blue',
  Josh: 'green',
  Zac: 'orange',
};
export const DEFAULT_HUE = 'grey';

/** The pill hues as the CSS draws them — here so the contrast test reads the same numbers. */
export const HUE_BG = {
  purple: '#6D28D9', blue: '#1D4ED8', green: '#15803D', orange: '#C2410C', teal: '#0F766E', grey: '#475569',
};

export const actorHue = (name) => ACTOR_COLORS[name] || DEFAULT_HUE;

/** The pill's text. Never blank: a row with no actor still says whose it isn't. */
export const actorLabel = (name) => (typeof name === 'string' && name.trim() ? name.trim() : '—');

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });

const msOf = (ts) => (typeof ts === 'string' ? Date.parse(ts) : NaN);

/** The Central calendar day an instant falls on, as YYYY-MM-DD ('' when junk). */
export function activityDay(ts) {
  const t = msOf(ts);
  return Number.isNaN(t) ? '' : dayFmt.format(new Date(t));
}

/** "9:14" — Central h:mm, no seconds, no date (the day label carries it), no AM/PM. */
export function activityTime(ts) {
  const t = msOf(ts);
  if (Number.isNaN(t)) return '';
  return timeFmt.format(new Date(t)).replace(/\s*[AP]M$/i, '');
}

/** "Today" · "Yesterday" · "Mon 9/28". String surgery on YYYY-MM-DD — never new Date(dateStr). */
export function dayLabel(day, today) {
  if (!day) return '';
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${m}/${d}`;
}

/**
 * The tape, bucketed by Central day, newest first: `[{day, label, rows}]`.
 *
 * `rows` is `activity[]` (absent / not an array reads as empty — a pre-D78
 * snapshot). A row without a parseable `ts` is dropped: it could not be placed
 * on a day, and the engine stamps every row. At most MAX_ROWS filed rows.
 *
 * `pendingRows` (pendingActivityRows) ride at the TOP of Today whatever their
 * own timestamps say — they are the caller's own unapplied taps, and the point
 * is that they are the first thing they see. Today is created for them if the
 * tape has nothing today yet.
 */
export function activityGroups(rows, now = new Date(), pendingRows = []) {
  const today = todayCentral(now);
  const filed = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === 'object' && !Number.isNaN(msOf(r.ts)))
    .map((r, i) => ({ r, i, t: msOf(r.ts) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)   // newest first; the engine's order on a tie
    .slice(0, MAX_ROWS)
    .map((x) => x.r);

  const groups = [];
  for (const r of filed) {
    const day = activityDay(r.ts);
    let g = groups[groups.length - 1];
    if (!g || g.day !== day) { g = { day, label: dayLabel(day, today), rows: [] }; groups.push(g); }
    g.rows.push(r);
  }

  const mine = Array.isArray(pendingRows) ? pendingRows : [];
  if (mine.length) {
    let g = groups.find((x) => x.day === today);
    if (!g) { g = { day: today, label: 'Today', rows: [] }; groups.unshift(g); }
    g.rows = mine.concat(g.rows);
  }
  return groups;
}

/* ------------------------------------------------ your own pending taps -- */

// The Worker's event id is `<utc-iso>:<rand6>` under the KV key `evt:<id>`;
// the engine may echo either form (or `evt_…`). Compare on the bare id.
const bareEvt = (id) => String(id == null ? '' : id).replace(/^evt[:_]/, '');

/** What a pending event is about — the same shapes `activity[].record` uses. */
export function pendingRecord(e) {
  const p = (e && e.payload) || {};
  switch (e && e.action) {
    case 'ticket_update': return p.ticket || null;
    case 'lead_update': case 'lead_close': return p.lead || null;
    case 'work_order': return p.work_order || e.serial || null;
    case 'doc_attach': case 'doc_detach': return p.record || null;
    case 'dispatch_claim': case 'dispatch_done': case 'dispatch_cancel': return p.dispatch_id || null;
    case 'rental_update': return p.agreement ?? null;
    case 'reserve': case 'release': case 'readiness': return e.serial || null;
    default: return null;   // ticket_open, lead_open, dispatch_add: no number until the engine runs
  }
}

// Deliberately short and deliberately ours — the engine writes the real line
// when it applies the event; this is only "we have it".
const LABEL = {
  ticket_open: 'new ticket sent',
  ticket_update: 'update sent',
  lead_open: 'new lead sent',
  lead_update: 'update sent',
  doc_attach: 'document attached',
  doc_detach: 'document removal sent',
  readiness: 'readiness sent',
  reserve: 'hold sent',
};
const WO_LABEL = { LABOR: 'hours logged', OPEN: 'work order sent', 'ADD-PARTS': 'parts added', INSPECT: 'inspection sent' };

/** The ⏳ row's text: "<record>: <label>", or the label alone when there is no record. */
export function pendingLabel(e) {
  const verb = e && e.payload && e.payload.action;
  const label = (e && e.action === 'work_order' && WO_LABEL[verb]) || LABEL[e && e.action] || `${(e && e.action) || 'event'} sent`;
  const rec = pendingRecord(e);
  return rec != null && rec !== '' ? `${rec}: ${label}` : label;
}

/** The `verb` an activity row would carry for this event (work_order only). */
function pendingVerb(e) {
  if (!e || e.action !== 'work_order' || !e.payload) return null;
  const a = e.payload.action;
  return a === 'INSPECT' && e.payload.step ? `INSPECT ${e.payload.step}` : (a || null);
}

/**
 * The caller's own unapplied events as ⏳ tape rows, newest first.
 *
 * Only `me`'s: `pending` is per token anyway, but an owner token sees the whole
 * inbox in mock mode and the rule is "your taps", so filter on the name. Any
 * event whose id already appears as an `activity[].evt` is dropped — the engine
 * applied it and the real line wins (they can briefly overlap while the Worker
 * has not yet been ACKed).
 */
export function pendingActivityRows(pending, me, activity) {
  const name = me && me.name;
  if (!name || !Array.isArray(pending)) return [];
  const filed = new Set((Array.isArray(activity) ? activity : []).map((r) => r && r.evt).filter(Boolean).map(bareEvt));
  return pending
    .filter((e) => e && e.actor === name && !filed.has(bareEvt(e.id)))
    .map((e) => ({
      ts: e.ts, actor: name, role: e.role || (me && me.role) || null, action: e.action,
      verb: pendingVerb(e), record: pendingRecord(e), text: pendingLabel(e), evt: e.id, pending: true,
    }))
    .sort((a, b) => (msOf(b.ts) || 0) - (msOf(a.ts) || 0));
}

/* -------------------------------------------------------------- routing -- */

/**
 * Where a row goes, by the SHAPE of its record — not by its action (a
 * doc_attach is about a ticket or a lead; a work_order row may name a serial).
 *   S1031 → the ticket · L1009 → the lead · W1003 → the work order ·
 *   a serial that is one of ours → the unit · anything else (a dispatch id, an
 *   agreement number, null) → no link: a plain row.
 */
export function activityRoute(record, units) {
  if (record == null || record === '') return null;
  const s = String(record).trim();
  if (/^S\d{4,}$/.test(s)) return `#/ticket/${encodeURIComponent(s)}`;
  if (/^L\d{4,}$/.test(s)) return `#/lead/${encodeURIComponent(s)}`;
  if (/^W\d{4,}$/.test(s)) return `#/wo/${encodeURIComponent(s)}`;
  if (Array.isArray(units) && units.some((u) => u && String(u.serial) === s)) return `#/unit/${encodeURIComponent(s)}`;
  return null;
}
