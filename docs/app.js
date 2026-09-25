/* WSS Fleet — app shell.
 *
 * Reads a dashboard-data snapshot (schema_version 3) and renders it.
 * ZERO data lives in this repo: the snapshot comes from the Worker at runtime,
 * or from docs/mock/*.json in mock mode (fake data only).
 *
 * Two rules this file exists to not break:
 *   1. Business dates are date-only Central strings. NEVER new Date("YYYY-MM-DD")
 *      — JS reads that as UTC midnight and Central users see yesterday.
 *      All date-only handling below is string surgery. See fmtDate/addBusinessDays.
 *   2. Writes are proposals. A submitted event renders as "pending", never as
 *      if the vault had already accepted it.
 *
 * v1.6 (schema 3): the Billing view is gone — its recurring-revenue block moved
 * to the top of Rentals (D21/D39) and its nav slot became the Dispatch board.
 * `snapshot.billing` still arrives for the engine's other consumers; we ignore it.
 */

import {
  fmtDate, fmtDateFull, fmtRange, todayCentral, addBusinessDays,
  fmtInstantCentral, hoursSince, fmtMoney, isDateStr, fmtDateDow, fmtMD, addDays,
} from './dates.js';
import { holdsOf, holdStatus, currentHold, futureHolds, findOverlaps, validateWindow, groupByDate } from './holds.js';
import { loadData, postEvent, deleteEvent, uploadDoc, mockVariant, resolveApiBase } from './api.js';
import { utilizationFrom, statusBoard, recurringRevenue } from './metrics.js';
import {
  KINDS, RIGS, DRIVERS, STAGE_LABEL, MOVE_LABEL, SOURCE_GLYPH,
  stageOptions, columnize, pipeline, sortTickets, completedTickets, closedWindowDays, missingMoves, openCount, dispatchFor, dispatchById,
  sections as dispatchSections, rigClash, driverChoices, defaultDriver, canCancel, unbookedPickups,
} from './service.js';
import { logRows, pendingNotes } from './notes.js';
import {
  PURPOSES, PURPOSE_LABEL, MANUFACTURERS, MANUFACTURER_LABEL, VENDORS, VENDOR_LABEL, PART_STATE_LABEL, PART_VERB_LABEL,
  MAX_LINES, HOURS_MIN, HOURS_MAX, HOURS_STEP,
  workOrdersOf, woById, laborOf, isOpenLine, stripGroups, openPartCount, requestedTone, lineTone, trackingUrl,
  fmtHours, hoursValid, woChipText, defaultPurpose, manufacturerFor, vendorFor, partActions,
  closeShown, closeEnabled, cancelShown, pendingOpens, pendingOpenFor, pendingForWo, describeWoEvent,
} from './workorders.js';
import {
  KINDS as INSP_KINDS, KIND_LABEL as INSP_KIND_LABEL, CLASSES, CLASS_LABEL, BODY_STYLES, BODY_STYLE_LABEL,
  BATTERY_TYPES, BATTERY_LABEL, VOLTAGES, PACKS_BY_VOLTAGE, PACK_LABEL, CLARITY, CLARITY_LABEL, LEVEL, LEVEL_LABEL,
  SCALES, RESULT_LABEL, READINGS, SECTION_KEYS, MAX_COMMENTS, MAX_ITEM_NOTE, MAX_NOTE,
  inspectionsOf, inspById, checklistOf, forSerial, deriveProfile, defaultKind, visibleSections, profileOf,
  cellLayout, cellKey, parseSg, sheetFrom, overlay, firstHours, doneReady, isFlag, flagCount, answeredIn,
  flaggedLabels, sectionValue, reopenShown, voidShown, woPrefill, woButtonShown, fmtReading, resumeText, chipText,
  stripCounts, stripGroups as inspStripGroups, draftTone, pendingOpens as inspPendingOpens, pendingOpensFor,
  pendingForInsp, byTs, describeInspEvent,
} from './inspections.js';
import {
  statusOf, outMove, inMove, rentalGroups, rentalActions, dueBackTone, outDatePassed, clampToToday,
  deliveryRow, returnRow, agreementForRow, pendingForAgreement, agreementHref, agreementByRoute,
  STATUS_LABEL as RENTAL_STATUS_LABEL,
} from './rentals.js';
import {
  projector, boxToViewBox, viewBoxStr, clampViewBox, zoomAt,
  collect, stack, stackKind, groupOff, geoMeta, hasGeo, precisionNote,
  navUrl, routeUrl, MAX_STOPS, KINDS as MAP_KINDS, KIND_LABEL as MAP_KIND_LABEL,
  EDGE_LABEL_ALLOWANCE,
} from './map.js';
import {
  docRows, docUrl, pendingDocRows, resolveKind, sanitizeName, retypeName, cameraName,
  isImageMime, humanBytes, kindLabel, docIcon, KIND_CHOICES, DOC_RECORD_RE,
} from './attachments.js';
import {
  NO_DATA, LEAD_PRIORITIES,
  STAGE_LABEL as LEAD_STAGE_LABEL, STATUS_LABEL as LEAD_STATUS_LABEL,
  SOURCE_LABEL, INTEREST_LABEL, REASON_LABEL,
  optionsFrom, hasMoney, amount, boardColumns, closedLeads, chipCounts, leadById,
  canEditLead, canCloseLead, stageOptions as leadStageOptions, stageNeeds,
  delta, pctOr, statOr, leadForHold, isDemoHold, isStale,
} from './leads.js';

/* ============================================================ 1. config ==== */

// The Worker origin (API_BASE) lives in docs/api.js.
const BUILD = '2026-09-25-d67b';   // shown on gate screens so a phone report pins the build
const TOKEN_KEY = 'wss_fleet_token';
const STALE_HOURS = 36;

/* ==================================================== 2. tiny html helper == */

const RAW = Symbol('raw');
const raw = (s) => ({ [RAW]: String(s) });

function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function interp(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(interp).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
}

// Tagged template: interpolations are escaped unless wrapped in raw().
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += interp(vals[i]) + strings[i + 1];
  return out;
}

const $ = (sel) => document.querySelector(sel);

/* ================================== 3. date + money (see docs/dates.js) ==== */

// Date handling lives in its own pure module so tools/selftest-dates.mjs can
// assert it. Do not re-implement any of this inline.
/* ============================================================== 4. state == */

const state = {
  me: null,          // {name, role}
  snapshot: null,
  pending: [],       // unapplied events from the Worker
  error: null,
  source: null,      // 'mock:full' | 'mock:empty' | 'mock:legacy' | 'api'
  loading: false,
  explainedPending: false,
};

/**
 * Transient view state. Lives outside `state` because none of it comes from the
 * snapshot — it is which sheet is open and which filter is on. Kept at module
 * scope so it survives render(), which rewrites the whole view on every change
 * (including after a write lands in `pending`).
 */
// The Service chip is remembered per device (D43) so a tech who lives in Fleet
// lands there. Storage can be blocked or purged — any failure just means All.
const FILTER_KEY = 'wss_fleet_service_filter';
function storedFilter() {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === 'CUSTOMER' || v === 'WSS' || v === 'all' ? v : 'all';
  } catch (_) { return 'all'; }
}

// The Leads chip is remembered the same way. 'mine' is the one a salesperson
// lives in, so it has to survive a reload or it isn't worth having.
// D52. The segmented control and the pin filters are remembered per device, for
// the same reason every other chip in this app is: a dispatcher who works off
// the map should land on the map, and a tech who only ever wants pick-ups
// should not re-tap four chips every morning. Storage can be blocked or purged
// — every failure falls back to the useful default, never to an error.
const DISPATCH_VIEW_KEY = 'wss.dispatch.view';
function storedDispatchView() {
  try { return localStorage.getItem(DISPATCH_VIEW_KEY) === 'map' ? 'map' : 'list'; } catch (_) { return 'list'; }
}
const MAP_KINDS_KEY = 'wss.dispatch.mapkinds';
function storedMapKinds() {
  try {
    const raw = localStorage.getItem(MAP_KINDS_KEY);
    if (!raw) return new Set(MAP_KINDS);
    const on = String(raw).split(',').filter((k) => MAP_KINDS.includes(k));
    // An empty set is a blank map, which reads as a broken map. If somebody
    // switched everything off and left, give them everything back.
    return on.length ? new Set(on) : new Set(MAP_KINDS);
  } catch (_) { return new Set(MAP_KINDS); }
}
const rememberMapKinds = () => {
  try { localStorage.setItem(MAP_KINDS_KEY, [...ui.mapKinds].join(',')); } catch (_) { /* ignore */ }
};

// D65: the Parts strip's open/closed state lives for the SESSION, not the
// device — it opens for a job and should be folded again tomorrow morning.
const PARTS_OPEN_KEY = 'wss.parts.open';
const INSP_OPEN_KEY = 'wss.inspections.open';
function storedInspOpen() {
  try { return sessionStorage.getItem(INSP_OPEN_KEY) === '1'; } catch (_) { return false; }
}
function storedPartsOpen() {
  try { return sessionStorage.getItem(PARTS_OPEN_KEY) === '1'; } catch (_) { return false; }
}
const LEAD_FILTER_KEY = 'wss_fleet_lead_filter';
function storedLeadFilter() {
  try {
    const v = localStorage.getItem(LEAD_FILTER_KEY);
    return v === 'mine' || v === 'stale' || v === 'all' ? v : 'all';
  } catch (_) { return 'all'; }
}

const ui = {
  dispatchView: storedDispatchView(),  // 'list' | 'map' (D52)
  mapKinds: storedMapKinds(),          // Set of the five pin kinds currently on
  mapSheet: null,                      // the stack key whose detail sheet is open
  mapPlan: false,                      // "Plan a run" select mode
  mapStops: [],                        // stack keys, in tap order
  mapBackToShop: true,
  ticketFilter: storedFilter(),   // 'all' | 'CUSTOMER' | 'WSS'
  leadFilter: storedLeadFilter(), // 'all' | 'mine' | 'stale'
  form: null,            // { kind, id } — the one open sheet, if any
  msg: null,             // { tone: 'ok'|'bad', text } — shown once at the top of the view
  showDone: false,       // Dispatch: "Done this week" is collapsed by default
  // null = "nobody has tapped it yet", so the role default applies (§3.1: the
  // scoreboard is open for Kevin and folded away for everyone else). Once it is
  // tapped the choice is theirs for the session, whatever their role.
  showScore: null,
  showInsights: false,   // §3.2 — collapsed by default
  showClosedLeads: false,
  showCompleted: false,  // D62: the Service tab's Completed strip — collapsed by default, per session
  completedQuery: '',    // D62: its search box
  showParts: storedPartsOpen(),   // D65: the landing Parts strip — collapsed by default, remembered per session
  showPartsDelivered: false,      // D65: Delivered (30d) inside it — always starts folded
  showInspections: storedInspOpen(),   // D67: the landing Inspections strip — collapsed by default, per session
};

/* ---- uploads in flight (S2) --------------------------------------------
 * A file a tech picked, resized, and is trying to send. Module scope so it
 * survives render(), which rewrites the whole view on every state change.
 *
 * DELIBERATELY NOT PERSISTED. No localStorage of blobs, no IndexedDB queue, no
 * service-worker background sync — the work order rules all three out and it is
 * the right call: a queue that survives the page is a promise to deliver, and
 * this app cannot keep that promise from a warehouse with one bar. So the copy
 * says exactly what is true — "leaving this page discards it" — and a failed
 * send stays one tap from a retry for as long as the tech is looking at it.
 *
 *   uploads  localId -> { localId, record, kind, name, mime, blob, thumb, state, error }
 *            state: 'sending' | 'failed'   (a success deletes the entry — the
 *            stored doc_attach event becomes the row from then on)
 *   thumbs   docId -> data: URL, for images sent THIS session. The snapshot
 *            carries no thumbnails and never will; this is only so the row a
 *            tech just created shows the photo he just took.
 */
const uploads = new Map();
const thumbs = new Map();

/* ---- the map (D52) -------------------------------------------------------
 * Module scope, because render() rewrites the view's innerHTML on every change
 * and none of this comes from the snapshot:
 *
 *   mapSvg      the vendored asset's source text, fetched ONCE. It is ~145 KB
 *               and identical every time; re-fetching it on every render would
 *               be the single most expensive thing this app does.
 *   mapProject  the projection built from the SVG root's data-lat0/lng0/kx/ky.
 *               Read off the file, never hardcoded — the vault regenerates the
 *               asset and the constants travel with it.
 *   mapView     the live viewBox. Pan and zoom mutate the SVG attribute
 *               directly (no re-render — a 145 KB innerHTML per pointermove is
 *               not a gesture, it is a slideshow) and park the result here so
 *               the next real render picks up where the finger left off.
 */
let mapSvg = null;
let mapSvgState = 'idle';        // 'idle' | 'loading' | 'ready' | 'error'
let mapProject = null;
let mapOuter = null;             // the whole-state viewBox — the pan/zoom clamp
let mapHome = null;              // meta.geo.default_view, projected
let mapView = null;
let uploadSeq = 0;
// The file chosen but not yet given a kind. Held here rather than in `ui` so a
// File object never lands in something we might one day serialise.
let pendingPick = null;

const openSheet = (kind, id = null) => { ui.form = { kind, id }; ui.msg = null; render(); };
const closeSheet = () => { ui.form = null; render(); };
const sheetOpen = (kind, id = null) => !!ui.form && ui.form.kind === kind && ui.form.id === id;

/* ======================================================== 5. token + auth == */

/**
 * Token plumbing (D24): the URL is the durable carrier, localStorage the backup.
 *   ?t= present  -> save it, leave it in the address bar (bookmarks keep working)
 *   ?t= missing  -> if storage has one, put it back into the URL via replaceState
 *   neither      -> null; the caller shows the "ask Matt for your link" gate
 * Stripping it (the old behaviour) broke bookmarks of the stripped URL, and iOS
 * purges a regular site's storage, so storage-only recovery was never durable.
 */
function bootToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  let stored = null;
  try { stored = localStorage.getItem(TOKEN_KEY); } catch (_) { /* storage blocked */ }

  if (fromUrl) {
    if (fromUrl !== stored) { try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch (_) { /* ignore */ } }
    return fromUrl;
  }
  if (stored) {
    url.searchParams.set('t', stored);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return stored;
  }
  return null;
}

/* ================================================ 6. api (see docs/api.js) == */

// loadData / postEvent / mockVariant are imported from docs/api.js — pure, so
// tools/selftest-api.mjs can prove the mock knobs are inert in production.
const ctx = () => ({ url: window.location.href, token: bootToken(), apiBase: resolveApiBase(window.location.href, devApiOverride()) });

// Dev only: `?api=http://localhost:8788` on localhost points the page at
// `wrangler dev`. Stored like the token; resolveApiBase() ignores it off-localhost.
const API_KEY = 'wss_fleet_api';
function devApiOverride() {
  const url = new URL(window.location.href);
  const a = url.searchParams.get('api');
  try {
    if (a === '') localStorage.removeItem(API_KEY);
    else if (a) localStorage.setItem(API_KEY, a);
    return localStorage.getItem(API_KEY);
  } catch (_) { return a || null; }
}

/* ========================================================== 7. selectors == */

const units = () => (state.snapshot && state.snapshot.units) || [];
const agreements = () => (state.snapshot && state.snapshot.agreements) || [];
const serviceQueue = () => (state.snapshot && state.snapshot.service_queue) || [];
const serviceSummary = () => (state.snapshot && state.snapshot.service_summary) || null;
const dispatchRows = () => (state.snapshot && state.snapshot.dispatch) || [];
const dispatchWarnings = () => (state.snapshot && state.snapshot.dispatch_warnings) || [];
const categories = () => (state.snapshot && state.snapshot.categories) || [];
// schema 5. All four may be missing entirely (a schema-4 snapshot still on KV),
// which is what hides the Leads tab's contents rather than throwing.
const leads = () => (state.snapshot && state.snapshot.leads) || [];
const leadsSummary = () => (state.snapshot && state.snapshot.leads_summary) || null;
const scoreboard = () => (state.snapshot && state.snapshot.scoreboard) || null;
const insights = () => (state.snapshot && state.snapshot.insights) || null;
// D65. Absent on a pre-D65 snapshot, which reads as "no work orders" — the
// strip draws empty and the unit page still offers the button.
const workOrders = () => workOrdersOf(state.snapshot);
const woSummary = () => (state.snapshot && state.snapshot.work_order_summary) || null;
// D67 — the inspection sheet. Absent keys (a pre-D67 snapshot) read as none.
const inspections = () => inspectionsOf(state.snapshot);
const inspSummary = () => (state.snapshot && state.snapshot.inspection_summary) || null;
const checklist = () => checklistOf(state.snapshot);
const meName = () => (state.me && state.me.name) || '';
const hasLeads = () => !!(state.snapshot && (Array.isArray(state.snapshot.leads) || state.snapshot.leads_summary));
// `snapshot.billing` is deliberately NOT read: the Billing view was retired at
// v1.6 (D39). The field stays in the contract for the engine's own consumers.

const role = () => (state.me && state.me.role) || '';
const ticketById = (id) => serviceQueue().find((t) => t.ticket === id) || null;

/** Display name: brand + model ("Factory Cat Model 34"). asset_item is an identifier, shown on the sub-line.
 *  A trailing model year ("MODEL 34 2026") is dropped from the name only — the full
 *  model string still shows in the detail card. Display rule, not a data change. */
const stripYear = (m) => String(m || '').replace(/\s+(19|20)\d{2}\s*$/, '').trim();
const unitName = (u) => [u.brand, stripYear(u.model)].filter(Boolean).join(' ') || u.asset_item || 'Unit';
/** Sub-line identifiers: "#serial · A-1042" (asset # only when present). */
const unitIds = (u) => [`#${u.serial}`, u.asset_item].filter(Boolean).join(' · ');

const unitBySerial = (s) => units().find((u) => String(u.serial) === String(s)) || null;
const pendingFor = (serial) => (serial == null ? [] : state.pending.filter((e) => e.serial != null && String(e.serial) === String(serial)));
const pendingReleases = (serial, holdId) => pendingFor(serial).filter((e) => e.action === 'release' && e.payload && e.payload.hold_id === holdId);

/* Pending writes keyed the schema-3 way (§8). Keys: `ticket` for ticket_update,
 * `dispatch_id` for the dispatch_* actions, `serial` for the older three. A
 * pending ticket_open has NO id of its own — the engine assigns the number —
 * so it is drawn as a synthetic RECEIVED card and never invents "S????". */
const pl = (e) => (e && e.payload) || {};
const pendingForTicket = (id) => (id ? state.pending.filter((e) => e.action === 'ticket_update' && pl(e).ticket === id) : []);
const pendingForDispatch = (id) => (id ? state.pending.filter((e) => String(e.action).startsWith('dispatch_') && pl(e).dispatch_id === id) : []);
const pendingTicketOpens = () => state.pending.filter((e) => e.action === 'ticket_open');
const pendingDispatchAdds = () => state.pending.filter((e) => e.action === 'dispatch_add');
// schema 5: keyed on `lead`, and — like ticket_open — a pending lead_open has no
// number of its own until the engine assigns one.
const pendingForLead = (id) => (id ? state.pending.filter((e) =>
  (e.action === 'lead_update' || e.action === 'lead_close') && pl(e).lead === id) : []);
const pendingLeadOpens = () => state.pending.filter((e) => e.action === 'lead_open');
// schema 6 / S2: keyed on `record`, which is a ticket id OR a lead id — the one
// action whose key spans both boards. Deliberately NOT folded into
// pendingForTicket: a doc_attach is not a change to the ticket, it is a
// document arriving, and it renders in the Documents group rather than in the
// "pending changes" list at the top of the record.
const pendingDocsFor = (recordId) => (recordId ? pendingDocRows(state.pending, recordId) : []);

/** Top-level holds rollup (v2). Derived from units when a snapshot lacks it. */
function holdsRollup() {
  const r = state.snapshot && state.snapshot.reservations;
  if (r && (Array.isArray(r.upcoming) || Array.isArray(r.expired))) {
    return { upcoming: r.upcoming || [], expired: r.expired || [] };
  }
  const out = { upcoming: [], expired: [] };
  for (const u of units()) for (const h of holdsOf(u)) {
    const row = { serial: u.serial, model: unitName(u), category: u.category, ...h };
    (holdStatus(h, todayCentral()) === 'expired' ? out.expired : out.upcoming).push(row);
  }
  return out;
}

// Readiness is an on-hand concept (D18). For units that are out — ON-RENT,
// ON-DEMO, LOANER-OUT — "[ON-RENT] [READY]" reads as a contradiction, so the
// readiness chip is not rendered and readiness is not counted. The data keeps it.
const ON_HAND = new Set(['AVAILABLE', 'RESERVED', 'IN-SHOP']);
const showsReadiness = (u) => ON_HAND.has(u.unit_state);

/**
 * D56 — the readiness clock's tone bands, in CALENDAR days.
 *
 * Same two numbers for NEEDS-PREP and DOWN on purpose: a machine in prep for a
 * fortnight and a machine down for a fortnight are the same size problem, which
 * is an unrentable asset. Matt retunes these two and nothing else.
 *
 * The AGE ITSELF is never computed here — `readiness_age_days` arrives from the
 * engine, on the engine's Central clock, like every other age in the snapshot.
 */
const AGE_AMBER = 7;
const AGE_RED = 14;
/**
 * D65 — the Parts strip's tone, in CALENDAR days on the work order's own
 * `age_days` (engine-computed). Amber once a REQUESTED line has sat 3 days
 * unordered, red at a week. Matt retunes these two, beside the two above.
 */
const PARTS_AMBER = 3;
const PARTS_RED = 7;
// D67: the Inspections strip goes amber when a DRAFT sheet has sat this many
// days (engine `age_days`). The strip exists so a half-done sheet is never lost.
const INSPECT_AMBER = 2;
// The readiness values the Shop List is about. NEEDS-PICKUP is deliberately not
// one: it's an out-unit state and Dispatch owns its clock (D32/D38).
const SHOP_READINESS = ['NEEDS-PREP', 'DOWN'];
const showsAge = (u) => showsReadiness(u) && SHOP_READINESS.includes(u.readiness)
  && typeof u.readiness_age_days === 'number';
// "3d" · "today". Bare days — the readiness chip beside it already says what for.
const ageText = (n) => (n === 0 ? 'today' : `${n}d`);
const ageTone = (n) => (n >= AGE_RED ? ' red' : n >= AGE_AMBER ? ' amber' : '');

/**
 * Category counts — on-hand math only (D18).
 *   ready    AVAILABLE and READY   — the only thing that can go out today
 *   in prep  NEEDS-PREP, on-hand states
 *   down     DOWN, on-hand states
 *   reserved unit_state RESERVED   — its own chip, never counted available
 *   onRent   unit_state ON-RENT    — D25, shown last in the sub-line, chip blue
 *   pickup   readiness NEEDS-PICKUP — D32, appended only when > 0; still out, still on rent
 */
function countCategory(cat) {
  const us = units().filter((u) => u.category === cat);
  const onHand = us.filter(showsReadiness);
  return {
    total: us.length,
    ready: us.filter((u) => u.unit_state === 'AVAILABLE' && u.readiness === 'READY').length,
    prep: onHand.filter((u) => u.readiness === 'NEEDS-PREP').length,
    down: onHand.filter((u) => u.readiness === 'DOWN').length,
    reserved: us.filter((u) => u.unit_state === 'RESERVED').length,
    onRent: us.filter((u) => u.unit_state === 'ON-RENT').length,
    pickup: us.filter((u) => u.unit_state !== 'RETIRED' && u.readiness === 'NEEDS-PICKUP').length,
  };
}

// 🟢 ≥2 ready · 🟡 exactly 1 · 🔴 none — rendered as a CSS dot; the label carries the meaning.
function light(readyCount) {
  const k = readyCount >= 2 ? 'g' : readyCount === 1 ? 'y' : 'r';
  const label = readyCount >= 2 ? 'good availability' : readyCount === 1 ? 'one ready' : 'none ready';
  return raw(html`<span class="dot dot-${k}" role="img" aria-label="${label}"></span>`);
}
const CHEV = raw('<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>');

/* =========================================================== 8. fragments == */

const STATE_CLASS = {
  AVAILABLE: 'ok', RESERVED: 'hold', 'ON-RENT': 'rent', 'ON-DEMO': 'out',
  'LOANER-OUT': 'out', 'IN-SHOP': 'warn', RETIRED: '',
};
const READY_CLASS = { READY: 'ok', 'NEEDS-PREP': 'warn', DOWN: 'bad', 'NEEDS-PICKUP': 'pickup' };
// D32: the customer released an out unit and it's waiting for a truck. Orange — nothing's broken.
const READY_LABEL = { 'NEEDS-PICKUP': 'Needs pick-up' };
const readyLabel = (r) => READY_LABEL[r] || r;

const chip = (text, cls) => html`<span class="chip ${cls || ''}">${text}</span>`;

function unitChips(u, opts = {}) {
  const p = pendingFor(u.serial);
  return html`<div class="chips">
    ${raw(chip(u.unit_state, STATE_CLASS[u.unit_state]))}
    ${opts.rental && u.pending_agreement != null ? raw(html`<a class="chip hold" href="${agreementHref(u.pending_agreement)}">Reserved for rental ${u.pending_agreement}</a>`) : ''}
    ${showsReadiness(u) || u.readiness === 'NEEDS-PICKUP' ? raw(chip(readyLabel(u.readiness), READY_CLASS[u.readiness])) : ''}
    ${showsAge(u) ? raw(chip(ageText(u.readiness_age_days), `age${ageTone(u.readiness_age_days)}`)) : ''}
    ${u.service_ticket ? raw(chip(`🔧 ${u.service_ticket}`, 'wrench')) : ''}
    ${p.length ? raw(chip(`⏳ ${p.length} pending`, 'pending')) : ''}
  </div>`;
}

/** "📅 2" — future holds on a unit that may well be AVAILABLE today. List rows only. */
function calChip(u) {
  const n = futureHolds(u, todayCentral()).length;
  return n ? html`<span class="chip cal" title="${n} upcoming hold${n > 1 ? 's' : ''}">📅 ${n}</span>` : '';
}

const PILL = {
  current: ['now', 'HELD NOW'],
  future: ['future', null],            // label = start date
  expired: ['expired', 'EXPIRED — release or extend'],
  malformed: ['bad', '⚠ bad dates, tell Matt'],
};
function holdPill(h) {
  const st = holdStatus(h, todayCentral());
  const [cls, label] = PILL[st] || PILL.malformed;
  return html`<span class="pill pill-${cls}">${label || fmtDate(h.start)}</span>`;
}

function emptyState(title, sub) {
  return html`<div class="empty"><strong>${title}</strong>${sub || ''}</div>`;
}

/* =============================================================== 9. views == */

function viewCategories() {
  const cats = categories();
  if (!cats.length) return emptyState('No categories in this snapshot.', 'The run engine publishes them.');

  const cards = cats.map((cat) => {
    const c = countCategory(cat);
    // Each segment is one flex item ("2 on rent" never splits); the line wraps between
    // segments and the separators are drawn by CSS, so nothing can run out of the card.
    const n = (v, label, cls = '') => html`<span class="seg ${cls}"><span class="${v ? 'n' : 'zero'}">${v}</span>&nbsp;${raw(label.replace(/ /g, '&nbsp;'))}</span>`;
    return html`
      <a class="card cat-card" href="#/cat/${raw(encodeURIComponent(cat))}">
        ${light(c.ready)}
        <span class="cat-body">
          <span class="cat-name">${cat}</span>
          <span class="cat-sub">
            ${raw(n(c.ready, 'ready'))}${raw(n(c.prep, 'in prep'))}${raw(n(c.down, 'down'))}${raw(n(c.reserved, 'reserved'))}${raw(n(c.onRent, 'on rent', 'rent'))}${c.pickup ? raw(n(c.pickup, 'to pick up', 'pickup')) : ''}
          </span>
        </span>
        ${CHEV}
      </a>`;
  });

  // Landing = utilization bar (D19) + category cards (D15) + the Shop List (D56).
  // D15 is amended, not repealed: the cards still own the top of the page, and
  // the work list sits UNDER them so Kevin's read (the lights) is unchanged.
  // D65: the Parts strip sits directly under the utilization card, above the
  // cards — but folded, so the lights still read first (D15 intact; a work
  // list, not a totals block, like the D56 Shop List).
  // D67: the Inspections strip sits under the Parts strip, same folded pattern.
  return html`<h1>Fleet</h1>${raw(utilBar())}${raw(partsStrip())}${raw(inspectionsStrip())}${raw(cards.join(''))}${raw(shopList())}`;
}

/**
 * The Parts strip (D65 §3) — "what job does this box go to".
 *
 * Collapsed it is one row: 🔩 Parts ▸ N open, where N is every line still
 * REQUESTED, ORDERED or IN-TRANSIT (the engine's summary), toned amber/red when
 * a REQUESTED line has sat unordered on an old work order. Expanded, the rows
 * are PART LINES, not work orders, grouped Ordered · In transit · Requested,
 * with Delivered folded inside. Every row leads with the W-number labelled PO,
 * because that is what is written on the packing slip in the tech's hand.
 * No money anywhere — the snapshot carries none to draw.
 */
function partsStrip() {
  const list = workOrders();
  const g = stripGroups(list);
  const opens = pendingOpens(state.pending);
  const n = openPartCount(woSummary(), list);
  const tone = requestedTone(list, PARTS_AMBER, PARTS_RED);
  const open = ui.showParts;

  const group = (title, rows) => (rows.length ? html`
    <div class="parts-g">${title} <span class="count">${rows.length}</span></div>
    ${raw(rows.map(partStripRow).join(''))}` : '');
  const body = open ? html`
    <div class="parts-body" id="parts-body">
      ${raw(opens.map(pendingWoCard).join(''))}
      ${raw(group('Ordered', g.ordered))}
      ${raw(group('In transit', g.inTransit))}
      ${raw(group('Requested', g.requested))}
      ${!g.ordered.length && !g.inTransit.length && !g.requested.length && !opens.length
        ? raw('<div class="hold-empty">Nothing on order. Open a work order from a unit page.</div>') : ''}
      ${g.delivered.length ? raw(html`
        <button type="button" class="parts-sub" data-parts-delivered-toggle="1" aria-expanded="${ui.showPartsDelivered ? 'true' : 'false'}">
          Delivered (30d) <span class="count">${g.delivered.length}</span> ${ui.showPartsDelivered ? '▾' : '▸'}</button>
        ${ui.showPartsDelivered ? raw(g.delivered.map(partStripRow).join('')) : ''}`) : ''}
    </div>` : '';

  return html`
    <section class="parts card" aria-label="Parts on order">
      <button type="button" class="parts-head" data-parts-toggle="1" aria-expanded="${open ? 'true' : 'false'}" aria-controls="parts-body">
        <span class="parts-t">🔩 Parts ${open ? '▾' : '▸'}</span>
        <span class="parts-n${tone ? ' ' + tone : ''}${n ? '' : ' zero'}">${n} open</span>
        ${opens.length ? raw(html`<span class="parts-new">⏳ ${opens.length} new</span>`) : ''}
      </button>
      ${raw(body)}
    </section>`;
}

/**
 * The Inspections strip (D67 §5) — "📋 Inspections ▸ N drafts · M done this week".
 *
 * It exists so a half-done sheet is never lost, not as a report: collapsed it
 * is one row, amber when a DRAFT has sat INSPECT_AMBER days (engine age).
 * Expanded: Drafts (oldest first, each with Resume), then Done in the last
 * seven days. A sheet opened on a phone but not yet numbered by the engine
 * shows as a ⏳ NEW card keyed on its serial — never with an invented I-number.
 */
function inspectionsStrip() {
  const list = inspections();
  const weekAgo = addDays(todayCentral(), -7);
  const opens = inspPendingOpens(state.pending);
  const c = stripCounts(inspSummary(), list, weekAgo);
  const g = inspStripGroups(list, weekAgo);
  const tone = draftTone(list, INSPECT_AMBER);
  const open = ui.showInspections;
  const none = !list.length && !opens.length;
  const pill = none ? 'No inspections yet'
    : `${c.drafts} draft${c.drafts === 1 ? '' : 's'} · ${c.done7} done this week`;

  const group = (title, rows, fn) => (rows.length ? html`
    <div class="parts-g">${title} <span class="count">${rows.length}</span></div>
    ${raw(rows.map(fn).join(''))}` : '');
  const body = open ? html`
    <div class="parts-body" id="insp-body">
      ${raw(opens.map(pendingInspCard).join(''))}
      ${raw(group('Drafts', g.drafts, inspDraftRow))}
      ${raw(group('Done (7d)', g.done, inspDoneRow))}
      ${!g.drafts.length && !g.done.length && !opens.length
        ? raw(html`<div class="hold-empty">${none ? 'No inspections yet.' : 'No drafts, nothing done this week.'} Start one from a unit page — Inspect.</div>`) : ''}
    </div>` : '';
  return html`
    <section class="parts insp-strip card" aria-label="Inspections">
      <button type="button" class="parts-head" data-insp-toggle="1" aria-expanded="${open ? 'true' : 'false'}" aria-controls="insp-body">
        <span class="parts-t">📋 Inspections ${open ? '▾' : '▸'}</span>
        <span class="parts-n${tone ? ' ' + tone : ''}${c.drafts ? '' : ' zero'}">${pill}</span>
        ${opens.length ? raw(html`<span class="parts-new">⏳ ${opens.length} new</span>`) : ''}
      </button>
      ${raw(body)}
    </section>`;
}
const inspAsset = (i) => {
  const u = unitBySerial(i.serial);
  return i.asset_item || (u && u.asset_item) || `#${i.serial}`;
};
function inspDraftRow(i) {
  const tone = typeof i.age_days === 'number' && i.age_days >= INSPECT_AMBER ? ' amber' : '';
  return html`
    <div class="prow">
      <a class="prow-main" href="#/inspection/${raw(enc(i.id))}">
        <span class="prow-po"><strong>${i.id}</strong></span>
        <span class="prow-part">${INSP_KIND_LABEL[i.kind] || i.kind || '—'}</span>
        <span class="prow-desc">opened by ${i.opened_by || '—'}${i.opened ? ` · ${fmtDate(i.opened)}` : ''} — Resume ›</span>
      </a>
      <div class="chips">
        <a class="chip asset" href="#/unit/${raw(enc(i.serial))}">${inspAsset(i)}</a>
        ${typeof i.age_days === 'number' ? raw(chip(ageText(i.age_days), `age${tone}`)) : ''}
        ${i.flags ? raw(chip(`${i.flags} ⚑`, 'warn')) : ''}
      </div>
    </div>`;
}
function inspDoneRow(i) {
  const h = firstHours(i.readings);
  return html`
    <div class="prow">
      <a class="prow-main" href="#/inspection/${raw(enc(i.id))}">
        <span class="prow-po"><strong>${i.id}</strong></span>
        <span class="prow-part">${INSP_KIND_LABEL[i.kind] || i.kind || '—'}</span>
        <span class="prow-desc">${i.tech || '—'}${i.done ? ` · ${fmtDate(i.done)}` : ''}${h != null ? ` · ${fmtReading(h)} h` : ''}</span>
      </a>
      <div class="chips">
        <a class="chip asset" href="#/unit/${raw(enc(i.serial))}">${inspAsset(i)}</a>
        ${i.flags ? raw(chip(`${i.flags} ⚑`, 'warn')) : raw(chip('no flags', 'ok'))}
        ${i.work_order ? raw(html`<a class="chip wo" href="#/wo/${raw(enc(i.work_order))}">🔩 ${i.work_order}</a>`) : ''}
      </div>
    </div>`;
}
/** A pending OPEN: no I-number yet, so none is shown (§2). Keyed on the serial. */
function pendingInspCard(e) {
  const u = unitBySerial(e.serial);
  const p = pl(e);
  return html`
    <div class="prow pending-card">
      <a class="prow-main" href="#/inspection/new/${raw(enc(e.serial))}">⏳ NEW — ${(u && u.asset_item) || `#${e.serial}`} — ${INSP_KIND_LABEL[p.kind] || 'inspection'} — numbered at the next run</a>
      <div class="kan-foot"><span class="kan-pend">by ${e.actor || 'someone'}</span></div>
    </div>`;
}

/** One part line in the strip. The PO leads; the chips say where it is and whose it is. */
function partStripRow({ wo, part }) {
  const u = unitBySerial(wo.serial);
  const asset = wo.asset_item || (u && u.asset_item) || `#${wo.serial}`;
  const tone = lineTone(wo, part, PARTS_AMBER, PARTS_RED);
  return html`
    <div class="prow">
      <a class="prow-main" href="#/wo/${raw(enc(wo.id))}">
        <span class="prow-po">PO <strong>${wo.id}</strong></span>
        <span class="prow-part"><span class="unit-serial">${part.part_number || '—'}</span> × ${part.qty ?? 1}</span>
        ${part.description ? raw(html`<span class="prow-desc">${part.description}</span>`) : ''}
      </a>
      <div class="chips">
        <a class="chip asset" href="#/unit/${raw(enc(wo.serial))}">${asset}</a>
        ${part.ordered ? raw(chip(`ordered ${fmtDate(part.ordered)}`, 'cal')) : ''}
        ${part.vendor ? raw(chip(VENDOR_LABEL[part.vendor] || part.vendor, 'rig')) : ''}
        ${raw(trackingChip(part))}
        ${part.delivered ? raw(chip(`delivered ${fmtDate(part.delivered)}`, 'ok')) : ''}
        ${isOpenLine(part) && typeof wo.age_days === 'number' ? raw(chip(ageText(wo.age_days), `age${tone ? ' ' + tone : ''}`)) : ''}
        ${wo.ticket ? raw(html`<a class="chip wrench" href="#/ticket/${raw(enc(wo.ticket))}">🔧 ${wo.ticket}</a>`) : ''}
      </div>
    </div>`;
}

/** Tracking: a carrier link only when the engine named the carrier; else plain text. */
function trackingChip(part) {
  if (!part.tracking) return '';
  const url = trackingUrl(part.carrier, part.tracking);
  return url
    ? html`<a class="chip track" href="${url}" target="_blank" rel="noopener noreferrer">${part.carrier} ${part.tracking} ↗</a>`
    : html`<span class="chip track">${part.tracking}</span>`;
}

/** A pending OPEN: no W-number yet, so none is shown (§2). Keyed on the serial. */
function pendingWoCard(e) {
  const p = pl(e);
  const u = unitBySerial(e.serial);
  const n = Array.isArray(p.parts) ? p.parts.length : 0;
  return html`
    <div class="prow pending-card">
      <div class="prow-main">⏳ NEW — ${(u && u.asset_item) || `#${e.serial}`} — ${n ? `${n} part${n === 1 ? '' : 's'}` : 'labor only'} — applies at the next run</div>
      <div class="kan-foot"><span class="kan-pend">by ${e.actor || 'someone'}</span></div>
      ${raw(undoControl(e))}
    </div>`;
}

/**
 * "In the shop" (D56) — every on-hand machine that isn't rentable, and how long
 * it hasn't been.
 *
 * The mechanism: readiness was a flag with no clock. A unit flipped to
 * NEEDS-PREP the day it came home and the board looked identical on day 1 and
 * day 19 — the only way to notice a stalled prep was to open nine categories
 * and remember last week. The category sub-line says "3 in prep"; it never says
 * which three or since when, and D20's percentage is not something anyone can
 * act on. This is the list.
 *
 * Scope is on-hand only (D18): an out unit's readiness isn't a concept, and
 * NEEDS-PICKUP belongs to Dispatch. Prep before down — Matt's ruling, and the
 * shorter path back to a rentable machine. Oldest first inside each group (D50).
 * No group headers: the readiness chip on the row is the group marker, and a
 * group with nothing in it is simply absent.
 *
 * D54 holds: this surfaces machines, never people. There is no "who let it sit".
 */
function shopList() {
  const rank = { 'NEEDS-PREP': 0, DOWN: 1 };
  const rows = units()
    .filter((u) => showsReadiness(u) && SHOP_READINESS.includes(u.readiness))
    // Oldest first, nulls last (an unstamped unit has no claim on the top of the
    // list), serial as the tiebreak so the order never shuffles between runs.
    .sort((a, b) => rank[a.readiness] - rank[b.readiness]
      || (b.readiness_age_days ?? -1) - (a.readiness_age_days ?? -1)
      || String(a.serial).localeCompare(String(b.serial)))
    .map((u) => html`
      <a class="card unit-row" href="#/unit/${raw(encodeURIComponent(u.serial))}">
        <span class="unit-main">
          <span class="unit-title">${unitName(u)}</span>
          <span class="unit-loc"><span class="unit-serial">${unitIds(u)}</span> · ${u.category || '—'}</span>
          ${raw(unitChips(u))}
          ${u.readiness_note ? raw(html`<span class="unit-note">${u.readiness_note}</span>`) : ''}
        </span>
        ${CHEV}
      </a>`);

  return html`<section class="shop-list"><h2>In the shop</h2>
    ${rows.length ? raw(rows.join('')) : raw(html`<div class="quiet">Nothing in prep, nothing down.</div>`)}
  </section>`;
}

/** Fleet-utilization bar (D19). The word label is mandatory: two bands are red. */
/**
 * Fleet utilization: one card, two bars (D19 units + D44 dollars).
 *
 * The same fleet measured two ways, because they answer different questions —
 * how many machines are out, and how much of the money in the yard is earning.
 * A few expensive riders out on rent can put the dollar bar a band above the
 * unit bar, which is the point of showing both.
 *
 * The band colour lives on each bar, not the card: the two can legitimately
 * disagree.
 */
function utilBar() {
  // Schema 4 hands us the percentages already computed and ships no costs at
  // all; schema 3 gets computed here. utilizationFrom() picks (D45).
  const u = utilizationFrom(state.snapshot);
  if (u.units.pct == null && u.dollars.pct == null) return '';

  const bar = (caption, m, subline) => (m.pct == null ? '' : html`
    <div class="util-bar util-${m.color}" aria-label="${caption} — ${m.pct}% ${m.label}">
      <div class="util-row">
        <span class="util-cap">${caption}</span>
        <span class="util-v"><strong>${m.pct}%</strong><span class="util-l">${m.label}</span></span>
      </div>
      <div class="util-track"><div class="util-fill" style="width:${m.pct}%"></div></div>
      ${subline ? raw(html`<div class="util-s">${raw(subline)}</div>`) : ''}
    </div>`);

  // The dollar bar's sub-line names what the percentage is OF, and carries no
  // number of its own (D46) — schema 4 ships no amounts and on schema 3 we
  // decline to show the ones we could still add up (D45). A percentage is all
  // the money anybody reads on this site.
  const n = u.dollars.excluded;
  const unitsSub = u.units.onRent != null && u.units.total != null
    ? html`${u.units.onRent} of ${u.units.total} rental units on rent` : '';
  return html`
    <section class="util" aria-label="Fleet utilization">
      <div class="util-t">Fleet utilization</div>
      ${raw(bar('Units', u.units, unitsSub))}
      ${raw(bar('Dollars', u.dollars, 'Fleet value on rent'))}
      ${n ? raw(html`<div class="util-fn">${n} unit${n === 1 ? '' : 's'} without a cost excluded</div>`) : ''}
    </section>`;
}

function viewCategory(cat) {
  const us = units().filter((u) => u.category === cat);
  const c = countCategory(cat);

  // Sort so what's rentable today floats to the top.
  const rank = { AVAILABLE: 0, RESERVED: 1, 'IN-SHOP': 2, 'ON-DEMO': 3, 'ON-RENT': 4, 'LOANER-OUT': 5, RETIRED: 6 };
  us.sort((a, b) => (rank[a.unit_state] ?? 9) - (rank[b.unit_state] ?? 9)
    || String(a.serial).localeCompare(String(b.serial)));

  const rows = us.map((u) => {
    // No job_site means it hasn't left the yard. A current hold names who it's held for.
    // D33: an out unit's customer (agreement / loaner placement) leads the location.
    const cur = currentHold(u, todayCentral());
    const loc = u.job_site || (cur && cur.customer ? `held for ${cur.customer}` : 'shop');
    const where = u.customer
      ? html`<span class="cust">${u.customer}</span>${u.job_site ? raw(html` · ${u.job_site}`) : ''}`
      : html`${loc}`;
    return html`
      <a class="card unit-row" href="#/unit/${raw(encodeURIComponent(u.serial))}">
        <span class="unit-main">
          <span class="unit-title">${unitName(u)}</span>
          <span class="unit-loc"><span class="unit-serial">${unitIds(u)}</span> · ${raw(where)}</span>
          ${raw(unitChips(u).replace('</div>', calChip(u) + '</div>'))}
        </span>
        ${CHEV}
      </a>`;
  });

  return html`
    <a class="crumb" href="#/">‹ Fleet</a>
    <h1>${light(c.ready)}${cat}</h1>
    <div class="sub">${c.ready} ready · ${c.prep} in prep · ${c.down} down · ${c.reserved} reserved · <span class="rent">${c.onRent} on rent</span>${c.pickup ? raw(html` · <span class="pickup">${c.pickup} to pick up</span>`) : ''}</div>
    ${us.length ? raw(rows.join('')) : raw(emptyState('No units in this category.'))}`;
}

function kvRow(label, value, cls) {
  const empty = value === '' || value == null;
  return html`<div class="kv-row"><dt>${label}</dt>
    <dd class="${cls || ''}${empty ? ' muted' : ''}">${empty ? '—' : value}</dd></div>`;
}

/** rate_card rows (D17): null/missing renders as a muted "—", never blank. */
const rateRow = (label, v, suffix = '') => kvRow(label, typeof v === 'number' ? fmtMoney(v) + suffix : '', 'num');

function viewUnit(serial) {
  const u = unitBySerial(serial);
  if (!u) return html`<a class="crumb" href="#/">‹ Fleet</a>${raw(emptyState('Unit not found.', 'It may have left the snapshot.'))}`;

  const ag = u.agreement != null ? agreements().find((a) => a.agreement === u.agreement) : null;
  const rc = u.rate_card || {};
  const p = pendingFor(u.serial);

  const pendingLine = (e) => html`<div class="pend-row">
    ${e.action === 'reserve'
      ? raw(html`<span>⏳ hold pending — ${e.payload && e.payload.customer ? e.payload.customer + ', ' : ''}${fmtRange(e.payload && e.payload.start, e.payload && (e.payload.end || e.payload.until))} by ${e.actor || 'someone'}</span>`)
      : e.action === 'work_order'
        ? raw(html`<span>${describeWoEvent(e)} by ${e.actor || 'someone'}</span>`)
        : e.action === 'inspection'
          ? raw(html`<span>⏳ ${describeInspEvent(e)} by ${e.actor || 'someone'}</span>`)
          : raw(html`<span>${e.action} by ${e.actor || 'someone'}</span>`)}
    ${raw(undoControl(e))}
  </div>`;
  const pendingBlock = p.length ? html`
    <div class="note">
      <strong>⏳ ${p.length} pending change${p.length > 1 ? 's' : ''}</strong>
      ${raw(p.map(pendingLine).join(''))}
      ${state.explainedPending ? '' : raw('<div style="margin-top:6px">Applies at the next run — the board still shows the current truth.</div>')}
    </div>` : '';
  if (p.length) state.explainedPending = true;

  const loanerPlacement = u.unit_state === 'LOANER-OUT' && u.agreement != null && !ag;

  return html`
    <a class="crumb" href="#/cat/${raw(encodeURIComponent(u.category || ''))}">‹ ${u.category || 'Fleet'}</a>
    ${raw(msgBlock())}
    <div class="detail-head">
      <div class="h">${unitName(u)}</div>
      <div class="s"><span class="unit-serial">${unitIds(u)}</span> · ${u.category || '—'}</div>
      ${/* D67: the meter, now that a DONE sheet writes it back. */
        typeof u.hours === 'number' ? raw(html`<div class="s hours-line">${fmtReading(u.hours)} h${u.hours_as_of ? ` · as of ${fmtMD(u.hours_as_of)}` : ''}</div>`) : ''}
      ${raw(unitChips(u, { rental: true }))}
    </div>
    ${raw(pendingBlock)}
    ${u.readiness_note ? raw(html`<div class="note"><strong>Readiness note</strong>${u.readiness_note}</div>`) : ''}

    <h2>Unit</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Brand / model', [u.brand, u.model].filter(Boolean).join(' ')))}
      ${raw(kvRow('Asset #', u.asset_item))}
      ${raw(kvRow('Serial', u.serial))}
      ${raw(kvRow('Description', u.description))}
      ${raw(kvRow('Status', u.status))}
      ${/* D56: the clock, for the two readiness values it means something for.
            A READY age is a brag, not a task, and an out unit has no readiness
            to age — both omit the row entirely rather than print a dash. */
        showsReadiness(u) && SHOP_READINESS.includes(u.readiness)
        ? raw(kvRow('Readiness since', u.readiness_since
          ? fmtDateFull(u.readiness_since)
            + (typeof u.readiness_age_days === 'number' ? ` · ${ageText(u.readiness_age_days)}` : '')
          : ''))
        : ''}
      ${raw(kvRow('Hours', typeof u.hours === 'number'
        ? `${u.hours.toLocaleString('en-US')}${u.hours_as_of ? ` · as of ${fmtDateFull(u.hours_as_of)}` : ''}` : '', 'num'))}
      ${raw(kvRow('In service', fmtDateFull(u.in_service)))}
      ${u.customer ? raw(kvRow('Customer', u.customer)) : ''}
      ${raw(kvRow('Location', u.job_site))}
      ${raw(kvRow('Service ticket', u.service_ticket
        ? raw(html`<a href="#/ticket/${raw(encodeURIComponent(u.service_ticket))}">🔧 ${u.service_ticket}</a>`) : ''))}
    </dl></div>

    ${raw(unitMoves(u))}

    <h2>Money</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Ask', fmtMoney(u.ask), 'num'))}
      ${raw(rateRow('Rate — full day', rc.full_day))}
      ${raw(rateRow('Rate — weekend', rc.weekend))}
      ${raw(rateRow('Rate — weekly', rc.weekly))}
      ${raw(rateRow('Rate — monthly', rc.monthly))}
      <div class="kv-sub">Long-term (signed commitment)</div>
      ${raw(rateRow('6-month', rc.long_term_6mo, ' /cycle'))}
      ${raw(rateRow('12-month', rc.long_term_12mo, ' /cycle'))}
    </dl></div>

    ${raw(holdsSection(u))}

    ${ag ? raw(html`
      <h2>Agreement</h2>
      <div class="card"><dl class="kv">
        ${raw(kvRow('Agreement', raw(html`<a href="${agreementHref(ag.agreement)}">${ag.agreement}</a>`)))}
        ${raw(kvRow('Customer', ag.customer))}
        ${raw(kvRow('Cycle', ag.cycle))}
        ${raw(kvRow('Cycle rate', fmtMoney(ag.cycle_rate), 'num'))}
        ${raw(kvRow('Cycles billed', ag.cycles_max != null ? `${ag.cycles_billed} of ${ag.cycles_max}` : ag.cycles_billed, 'num'))}
        ${raw(kvRow('Last invoiced', ag.last_invoiced_period_start
          ? `${fmtDate(ag.last_invoiced_period_start)} – ${fmtDateFull(ag.last_invoiced_period_end)}` : ''))}
        ${raw(kvRow('Last invoice', ag.last_invoice))}
        ${raw(kvRow('Next due', fmtDateFull(ag.next_due)))}
        ${raw(kvRow('Customer PO', ag.customer_po))}
      </dl></div>
      ${raw(rowAlerts(ag))}`) : ''}

    ${loanerPlacement ? raw(html`<h2>Placement</h2>
      <div class="info">Loaner out${u.customer ? raw(html` to <strong>${u.customer}</strong>`) : ''} on agreement ${u.agreement}. Loaners carry no billing row — that's expected, not a missing record.</div>`) : ''}

    ${u.unit_state === 'ON-DEMO' ? raw(html`
      <h2>Placement</h2><div class="info">Out on demo. No agreement.</div>`) : ''}

    ${raw(actionsFor(u))}
    ${raw(unitInspections(u))}`;
}

/**
 * D67 — the unit page's Inspect control, beside Work order (§3):
 *   a DRAFT on this serial    "📋 Resume I1001 · CHECKOUT · 3 ⚑" -> the sheet
 *   a pending OPEN            "⏳ Resume new sheet" (yours) / "⏳ New sheet by Josh"
 *   neither                   "📋 Inspect" -> Check-out · Return · PM
 * One DRAFT per serial is the engine's rule; the page just never offers a
 * second. No library in the snapshot = no new sheet (a resume still works).
 */
function inspectControl(u) {
  if (u.inspection_draft) {
    const i = inspById(inspections(), u.inspection_draft);
    return html`<a class="btn ghost insp-chip" href="#/inspection/${raw(enc(u.inspection_draft))}">📋 ${resumeText(i, u.inspection_draft)}</a>`;
  }
  const opens = pendingOpensFor(state.pending, u.serial).sort(byTs);
  if (opens.length) {
    const last = opens[opens.length - 1];
    const mine = opens.some((e) => e.actor === meName());
    const kind = INSP_KIND_LABEL[pl(last).kind] || '';
    return html`<a class="btn ghost insp-chip" href="#/inspection/new/${raw(enc(u.serial))}">⏳ ${mine ? 'Resume new sheet' : `New sheet by ${last.actor || 'someone'}`}${kind ? ` · ${kind}` : ''}</a>`;
  }
  if (!checklist()) return '';
  return html`<button class="btn ghost" type="button" data-form="insp-open">📋 Inspect</button>`;
}

/** The kind picker (§3), mounted into #write-form. The default (§2) is filled in. */
function inspPickForm(u) {
  const def = defaultKind(u);
  return html`
    <div class="write insp-pick">
      <label>Which sheet?</label>
      <div class="actions row">
        ${raw(INSP_KINDS.map((k) => html`<button class="btn${k === def ? '' : ' ghost'}" type="button" data-insp-open="${k}" data-serial="${u.serial}">${INSP_KIND_LABEL[k]}</button>`).join(''))}
      </div>
      <div class="form-note">The sheet opens now and saves as you go. The engine gives it an I-number at the next run.</div>
    </div>`;
}

/** The unit's last five sheets (§3): "I1001 · PM · 9/26 · Josh · 412 h · 2 ⚑". */
function unitInspections(u) {
  const rows = forSerial(inspections(), u.serial).slice(0, 5);
  if (!rows.length && !checklist()) return '';
  const line = (i) => {
    const h = firstHours(i.readings);
    const bits = [i.id, i.kind || '—', fmtMD(i.status === 'DONE' ? i.done : i.opened) || '—',
      (i.status === 'DONE' ? i.tech : i.opened_by) || '—'];
    if (h != null) bits.push(`${fmtReading(h)} h`);
    if (i.flags) bits.push(`${i.flags} ⚑`);
    return html`<a class="irow-link" href="#/inspection/${raw(enc(i.id))}">
      <span>${bits.join(' · ')}</span>${i.status === 'DRAFT' ? raw(chip('DRAFT', 'warn')) : ''}${CHEV}</a>`;
  };
  return html`
    <h2>Inspections${rows.length ? raw(html` <span class="count">${rows.length}</span>`) : ''}</h2>
    <div class="card dlist">${rows.length ? raw(rows.map(line).join('')) : raw('<div class="hold-empty">No inspections yet.</div>')}</div>`;
}

/**
 * The unit's truck moves (§5). A NEEDS-PICKUP unit says where its run lives so
 * a released machine is never a dead end — and says so even when the engine
 * hasn't spawned the row yet.
 */
function unitMoves(u) {
  const rows = dispatchRows().filter((r) => r.serial != null && String(r.serial) === String(u.serial));
  const live = rows.filter((r) => r.status !== 'DONE');
  const pickupLine = u.readiness === 'NEEDS-PICKUP'
    ? (live.length
      ? html`<div class="info">Waiting for a truck — <a href="#/dispatch/${raw(encodeURIComponent(live[0].id))}">on the Dispatch board</a>.</div>`
      : html`<div class="info">Released by the customer. No run on the Dispatch board yet — the next engine run adds one, or add it yourself below.</div>`)
    : '';
  if (!rows.length) return pickupLine;
  return html`
    ${raw(pickupLine)}
    <h2>Moves</h2>
    <div class="card dlist">${raw(rows.map((r) => dispatchRow(r, { compact: true })).join(''))}</div>`;
}

/* ---- holds (v2): the list is the calendar; the chip is the state ---- */

const canReserveRole = () => ['sales', 'owner'].includes((state.me && state.me.role) || '');

function holdsSection(u) {
  const holds = holdsOf(u);
  const canRelease = canReserveRole();
  const rows = holds.map((h) => {
    const rel = pendingReleases(u.serial, h.id);
    // §4: a DEMO hold is a lead with a truck booked. Linked by hold id only —
    // the engine sets `demo.hold_id`, and matching on customer + date instead
    // would eventually put the wrong lead on somebody's unit page.
    const lead = isDemoHold(h) ? leadForHold(leads(), h.id) : null;
    if (isAgmtHold(h)) return agmtHoldRow(h);
    return html`
      <div class="hrow hold-${holdStatus(h, todayCentral())}">
        <div class="hold-top">
          <span class="hold-win">${fmtRange(h.start, h.end)}</span>
          ${raw(holdPill(h))}
          ${isDemoHold(h) ? raw(chip('demo', 'out')) : ''}
        </div>
        <div class="hold-who">${h.customer || '—'}${h.purpose ? raw(html` · ${h.purpose}`) : ''}${lead ? raw(html` · <a href="#/lead/${raw(enc(lead.lead))}">${lead.lead}</a>`) : ''}</div>
        <div class="hold-meta">held by ${h.held_by || '—'}${h.created ? raw(html` · placed ${fmtDate(h.created)}`) : ''}</div>
        ${rel.length ? raw(html`<div class="hold-pending">⏳ release pending — applies at the next run
          ${raw(rel.map(undoControl).join(''))}</div>`) : ''}
        ${canRelease && !rel.length && h.id ? raw(html`<button class="btn sm ghost" type="button" data-release="${h.id}">Release</button>`) : ''}
      </div>`;
  });
  return html`
    <h2>Holds</h2>
    <div class="card holds">
      ${holds.length ? raw(rows.join('')) : raw('<div class="hold-empty">No holds.</div>')}
    </div>`;
}

/**
 * D64: the implied RENTAL hold a PENDING agreement puts on its unit. It is not
 * a hold anybody placed, so nobody releases it — the engine refuses an agmt:
 * id — and it goes away on its own when the machine goes out.
 */
const isAgmtHold = (h) => !!h && String(h.id || '').startsWith('agmt:');
const agmtIdOf = (h) => String(h.id).slice('agmt:'.length);
function agmtHoldRow(h) {
  const a = agreementByRoute(agreements(), agmtIdOf(h));
  const id = a ? a.agreement : agmtIdOf(h);
  return html`
    <div class="hrow hold-${holdStatus(h, todayCentral())}">
      <div class="hold-top">
        <span class="hold-win">${fmtRange(h.start, h.end)}</span>
        ${raw(holdPill(h))}
        ${raw(chip('rental', 'rent'))}
      </div>
      <div class="hold-who">${h.customer || '—'} · RENTAL · <a href="${agreementHref(id)}">${id}</a></div>
      <div class="hold-meta">${a && outMove(a) === 'CUSTOMER-PICKUP' ? 'clears itself when it goes out' : 'clears itself on delivery'}</div>
    </div>`;
}

/* ---- writes (proposals only) ---- */

function actionsFor(u) {
  // v2: holds are legal on any non-retired unit in any state (future holds on an out unit).
  const canReserve = canReserveRole() && u.unit_state !== 'RETIRED';
  const canReadiness = role() === 'service' || role() === 'owner';
  // Booking a truck is everyone's job (§4) — a run is a proposal like any other.
  const canMove = u.unit_state !== 'RETIRED';
  // D65: a work order is anyone's to open — the tech with it apart knows the part #.
  const canWo = u.unit_state !== 'RETIRED';
  if (!canReserve && !canReadiness && !canMove && !canWo) return '';

  // In mock mode the forms still open — the UI is reviewable — but submitting
  // is refused in postEvent(). Nothing fake ever enters the pending list.
  const mock = !!mockVariant(window.location.href);
  return html`
    <h2>Actions</h2>
    ${mock ? raw('<div class="info">Mock mode — the forms open, but submitting is refused until the Worker is live (M1).</div>') : ''}
    <div class="actions">
      ${canReserve ? raw(html`<button class="btn" type="button" data-form="reserve">${u.unit_state === 'AVAILABLE' ? 'Reserve this unit' : 'Reserve for later'}</button>`) : ''}
      ${canReadiness ? raw('<button class="btn ghost" type="button" data-form="readiness">Set readiness</button>') : ''}
      ${canWo ? raw(woControl(u)) : ''}
      ${u.unit_state !== 'RETIRED' ? raw(inspectControl(u)) : ''}
      ${canMove && u.pending_agreement == null ? raw('<button class="btn ghost" type="button" data-form="dispatch">Schedule delivery</button>') : ''}
    </div>
    ${u.pending_agreement != null ? raw(rentalDeliveryLink(u)) : ''}
    <div id="write-form"></div>
    <div id="write-msg"></div>`;
}

/**
 * D65 — the unit page's Work order control, beside Set readiness (§4):
 *   an OPEN work order    the chip "W1001 · 2 parts open · 3.5 h" -> #/wo/W1001
 *   a pending OPEN        "⏳ New work order — applies at the next run" (no id yet)
 *   neither               "Open work order"
 * One OPEN per serial is the engine's rule; the page just doesn't offer a second.
 */
function woControl(u) {
  if (u.work_order) {
    const wo = woById(workOrders(), u.work_order);
    return html`<a class="btn ghost wo-chip" href="#/wo/${raw(enc(u.work_order))}">🔩 ${woChipText(wo, u)}</a>`;
  }
  if (pendingOpenFor(state.pending, u.serial).length) {
    return html`<button class="btn ghost" type="button" disabled>⏳ New work order — applies at the next run</button>`;
  }
  return html`<button class="btn ghost" type="button" data-form="wo-open">Open work order</button>`;
}

/** One part line's inputs: make · part # · description · qty. The OPEN and + Add parts sheets share it. */
function partLineRow(mfr) {
  const opt = (m) => html`<option value="${m}"${m === mfr ? raw(' selected') : ''}>${MANUFACTURER_LABEL[m]}</option>`;
  return html`
    <div class="wo-line">
      <select name="p_mfr" aria-label="Make">${raw(MANUFACTURERS.map(opt).join(''))}</select>
      <input name="p_num" maxlength="40" placeholder="Part #" autocomplete="off" aria-label="Part number">
      <input name="p_desc" maxlength="80" placeholder="Description" autocomplete="off" aria-label="Description">
      <input name="p_qty" type="number" inputmode="numeric" min="1" max="99" step="1" value="1" aria-label="Quantity">
    </div>`;
}
function partLinesEditor(mfr, required) {
  return html`
    <label>Parts${required ? '' : ' (optional — a labor-only work order is fine)'}</label>
    <div class="wo-lines" data-mfr="${mfr}">${raw(partLineRow(mfr))}</div>
    <button class="btn sm ghost" type="button" data-wo-addline="1">+ line</button>
    <div class="form-note">Up to ${MAX_LINES} lines. Part # and quantity — no prices here; cost comes off the vendor invoice.</div>`;
}

/** The OPEN sheet (§4), mounted into the unit page's #write-form — or, from a
 *  DONE inspection (D67), into that sheet's page with `prefill` {purpose, note,
 *  inspection}: the back-link rides in the payload, the parts are the tech's. */
function woOpenForm(u, prefill = null) {
  const mfr = manufacturerFor(u.brand);
  const pre = prefill || {};
  return html`
    <form class="write${prefill ? ' sheet' : ''}" data-action="work_order" data-verb="OPEN" data-serial="${u.serial}"${pre.inspection ? raw(html` data-inspection="${pre.inspection}"`) : ''}>
      <label>Purpose</label>
      ${raw(toggle('purpose', PURPOSES.map((p) => [p, PURPOSE_LABEL[p]]), pre.purpose || defaultPurpose(u)))}
      ${raw(partLinesEditor(mfr, false))}
      <label for="wo-note">Note (optional)</label>
      <textarea id="wo-note" name="note" maxlength="200" placeholder="what it's for — rent-ready for …">${pre.note || ''}</textarea>
      ${u.service_ticket ? raw(html`<div class="info">Links to ${u.service_ticket}.</div>`) : ''}
      ${pre.inspection ? raw(html`<div class="info">Links to inspection ${pre.inspection}.</div>`) : ''}
      ${prefill ? raw(sheetButtons('Open work order')) : raw('<div class="actions"><button class="btn" type="submit">Submit</button></div>')}
      <div class="form-note">A proposal. The engine assigns the W-number — the PO you give the vendor — at the next run.</div>
    </form>`;
}

/** D64: a unit promised to a PENDING rental gets its delivery from the engine,
 *  not from a hand-added run — so the page points at that run instead. */
function rentalDeliveryLink(u) {
  const a = agreementByRoute(agreements(), String(u.pending_agreement));
  const row = a ? deliveryRow(a, dispatchRows()) : null;
  if (row) return html`<div class="info">Delivery for ${u.pending_agreement} is <a href="#/dispatch/${raw(enc(row.id))}">on the Dispatch board</a>.</div>`;
  if (a && outMove(a) === 'CUSTOMER-PICKUP') return html`<div class="info">The customer picks this one up — <a href="${agreementHref(a.agreement)}">rental ${a.agreement}</a>.</div>`;
  return html`<div class="info">Delivery for <a href="${agreementHref(u.pending_agreement)}">${u.pending_agreement}</a> lands on the Dispatch board at the next run.</div>`;
}

function reserveForm(u) {
  const start = todayCentral();
  const end = addBusinessDays(start, 5);   // +5 business days from START, Sat/Sun skipped
  return html`
    <form class="write" data-action="reserve" data-serial="${u.serial}">
      <label for="f-cust">Customer</label>
      <input id="f-cust" name="customer" required autocomplete="off">
      <label for="f-purp">Purpose</label>
      <input id="f-purp" name="purpose" placeholder="DEMO — Ixonia, quote hold…" autocomplete="off">
      <div class="dates">
        <div><label for="f-start">Start</label><input id="f-start" name="start" type="date" value="${start}" required></div>
        <div><label for="f-end">End</label><input id="f-end" name="end" type="date" value="${end}" required></div>
      </div>
      <div class="quick">
        <button class="btn sm ghost" type="button" data-quick="1">1 day</button>
        <button class="btn sm ghost" type="button" data-quick="5">5 business days</button>
      </div>
      <div id="win-hint" class="hint" hidden></div>
      <div class="actions"><button class="btn" type="submit">Submit reservation</button></div>
      <div class="form-note">A proposal — it shows as pending until the next run applies it. Overlaps are refused by the engine, not here.</div>
    </form>`;
}

/** Inline window feedback: a validation message, or a non-blocking overlap warning. */
function updateWindowHint(form) {
  const u = unitBySerial(form.dataset.serial);
  const hint = form.querySelector('#win-hint');
  if (!u || !hint) return null;
  const start = form.querySelector('[name=start]').value;
  const end = form.querySelector('[name=end]').value;
  const err = validateWindow(start, end, todayCentral());
  if (err) { hint.hidden = false; hint.className = 'hint bad'; hint.textContent = err; return err; }
  const clash = findOverlaps(holdsOf(u), start, end);
  if (clash.length) {
    hint.hidden = false; hint.className = 'hint';
    hint.textContent = `Overlaps ${clash.map((h) => `${h.customer || 'a hold'}, ${fmtRange(h.start, h.end)}`).join('; ')} — the snapshot may be a day stale; you can still submit and the engine will decide.`;
  } else { hint.hidden = true; hint.textContent = ''; }
  return null;
}

function readinessForm(u) {
  const opt = (v) => html`<option value="${v}"${v === u.readiness ? raw(' selected') : ''}>${readyLabel(v)}</option>`;
  return html`
    <form class="write" data-action="readiness" data-serial="${u.serial}">
      <label for="f-ready">Readiness</label>
      <select id="f-ready" name="readiness">
        ${raw(['READY', 'NEEDS-PREP', 'DOWN', 'NEEDS-PICKUP'].map(opt).join(''))}
      </select>
      <label for="f-note">Note</label>
      <textarea id="f-note" name="note" placeholder="what's wrong / what it needs — for a pick-up: who called, when"></textarea>
      <div class="actions"><button class="btn" type="submit">Submit readiness</button></div>
      <div class="form-note">This is a proposal. It shows as pending until the next run applies it.</div>
    </form>`;
}

/* ---- rentals / billing / service ---- */

/**
 * The Rentals tab (D64). The agreement is the spine: every tile is one
 * agreement, grouped by its lifecycle status — Pending, On rent, Off-rent —
 * and ENDED rows never ship, so a finished rental simply leaves the tab.
 * D21's revenue block still leads (it sums ACTIVE + OFF-RENT only).
 *
 * A pre-D64 snapshot has no `status`: every row reads as ACTIVE and lands
 * under On rent, and the only button it can offer is Off-rent.
 */
function viewRentals() {
  const rows = agreements();
  const head = html`<h1>Rentals</h1>${raw(msgBlock())}${raw(revenueCard())}`;
  if (!rows.length) return head + emptyState('No agreements in this snapshot.');

  const g = rentalGroups(rows);
  const count = (n) => (n ? html` <span class="count">${n}</span>` : '');
  const group = (title, list, tile, always, emptyText) => (list.length || always ? html`
    <h2>${title}${raw(count(list.length))}</h2>
    ${list.length ? raw(list.map(tile).join('')) : raw(html`<div class="card"><div class="hold-empty">${emptyText}</div></div>`)}` : '');

  return head
    + group('Pending', g.pending, pendingTile, false, '')
    + group('On rent', g.active, activeTile, true, 'Nothing out on rent.')
    + group('Off-rent', g.offRent, offRentTile, false, '');
}

/* ---- rental tiles: shared parts ---- */

/** The R-number chip, linking to the agreement. Rendered VERBATIM (D59). */
function agmtChip(a) {
  if (a.agreement == null) return html`<span class="chip bad">no agreement</span>`;
  return html`<a class="chip agmt" href="${agreementHref(a.agreement)}">${a.agreement}</a>`;
}
const leadChip = (id) => (id ? html`<a class="chip leadref" href="#/lead/${raw(enc(id))}">${id}</a>` : '');

/** Customer · unit line — the head every tile shares. */
function rentalHead(a, chipsExtra) {
  const u = unitBySerial(a.serial);
  return html`
    <div class="unit-row">
      <span class="unit-main">
        <span class="unit-title">${a.customer || 'Unknown customer'}</span>
        <span class="unit-loc">
          ${a.serial != null ? raw(html`<a href="#/unit/${raw(enc(a.serial))}">#${a.serial}</a>`) : '—'}
          ${u ? raw(html` · ${unitName(u)}`) : ''}${a.job_site ? raw(html` · ${a.job_site}`) : ''}
        </span>
      </span>
    </div>
    <div class="chips">${raw(agmtChip(a))}${raw(chipsExtra || '')}${raw(leadChip(a.lead))}</div>`;
}

const cyclesText = (a) => (a.cycles_max != null ? `${a.cycles_billed} of ${a.cycles_max}` : `${a.cycles_billed == null ? '—' : a.cycles_billed}`);
const rateText = (a) => `${a.cycle || '—'} · ${fmtMoney(a.cycle_rate)}`;
const daysChip = (a) => (typeof a.days_on_rent === 'number' ? html`<span class="chip age">${a.days_on_rent}d on rent</span>` : '');

/** Filed docs on a tile (the CONTRACT lives here) — the same rows and the same
 *  tap-to-open as a ticket's Documents group, without the add buttons. */
function tileDocs(a) {
  const rows = docRows(a);
  if (!rows.length) return '';
  return html`<div class="tile-docs">${raw(rows.map((d) => html`
    <button class="docrow" type="button" data-doc="${d.id}">
      <span class="doc-ico" aria-hidden="true">${d.icon}</span>
      <span class="doc-name">${d.label} — ${d.name}</span>
      ${d.size ? raw(html`<span class="doc-size">${d.size}</span>`) : ''}
      <span class="doc-go" aria-hidden="true">›</span>
    </button>`).join(''))}</div>`;
}

/** "Due back Sat Sep 26" — loud: bold always, amber the day before, red once passed. */
function dueBack(a) {
  if (!a.in_date) return '';
  const tone = dueBackTone(a.in_date, todayCentral());
  return html`<div class="due${tone ? ' ' + tone : ''}">Due back ${fmtDateDow(a.in_date)}${tone === 'red' ? ' — overdue' : ''}</div>`;
}

/** A dispatch row as a one-line link: "m-dl-R… · SCHEDULED Kevin / TRAILER-6000". */
function runLink(id, st, driver, rig) {
  const who = [driver, rig].filter(Boolean).join(' / ');
  return html`<a href="#/dispatch/${raw(enc(id))}">${id}</a> · ${st || 'OPEN'}${who ? ` ${who}` : ''}`;
}

/** How and when a PENDING rental leaves the yard. */
function outLine(a) {
  if (outMove(a) === 'CUSTOMER-PICKUP') {
    return html`<div class="rline">Customer picks up ${a.out_date ? fmtDateDow(a.out_date) : '— no date'}</div>`;
  }
  const row = deliveryRow(a, dispatchRows());
  const dl = a.delivery || {};
  const id = dl.id || (row && row.id) || null;
  const date = dl.date || (row && row.date) || a.out_date;
  const link = id && row
    ? raw(runLink(id, dl.status || row.status, dl.driver || row.driver, dl.rig || row.rig))
    : raw(html`<span class="muted">not on the board yet — the next run adds it</span>`);
  return html`<div class="rline">Delivery ${date ? fmtDateDow(date) : '— no date'} · ${link}</div>`;
}

/** Pending writes on a tile + the undo valve, keyed on payload.agreement. */
function rentalPending(a) {
  const p = pendingForAgreement(state.pending, a.agreement);
  if (!p.length) return { html: '', busy: false };
  return {
    busy: true,
    html: html`${raw(pendingLine(p.length))}${raw(p.map((e) => html`<div class="pend-row"><span>${RENTAL_VERB_LABEL[pl(e).action] || 'Change'}${pl(e).date ? ` ${fmtDate(pl(e).date)}` : ''} — ${e.actor || 'someone'}</span>${raw(undoControl(e))}</div>`).join(''))}`,
  };
}
const RENTAL_VERB_LABEL = { OUT: 'Went out', 'OFF-RENT': 'Off-rent', IN: 'Back in shop' };

/**
 * One verb's button + its sheet. The sheet asks for the date (default today,
 * capped at today — the engine refuses a future one too) and an optional note.
 */
function rentalControl(a, verb, opts = {}) {
  const key = `${verb}|${String(a.agreement)}`;
  const open = sheetOpen('rental', key);
  const pend = opts.busy;
  const today = todayCentral();
  const sheet = open ? html`
    <form class="write sheet" data-action="rental_update" data-verb="${verb}" data-id="${String(a.agreement)}">
      <label for="rf-date">${verb === 'OUT' ? 'Went out on' : verb === 'IN' ? 'Back in the shop on' : 'Off-rent as of'}</label>
      <input id="rf-date" name="date" type="date" value="${today}" max="${today}" required>
      <label for="rf-note">Note (optional)</label>
      <textarea id="rf-note" name="note" maxlength="200" placeholder="${verb === 'OFF-RENT' ? 'who called, where it is on site' : 'hours on the meter, who signed'}"></textarea>
      ${raw(sheetButtons(verb === 'OUT' ? 'Mark it out' : verb === 'IN' ? 'Mark it back in' : 'Take it off-rent'))}
      <div class="form-note">A proposal — the tile moves at the next run.</div>
    </form>` : '';
  return html`
    <div class="drow-btns">
      <button class="btn${opts.ghost ? ' ghost' : ''}" type="button" data-sheet="rental" data-id="${key}"${pend ? raw(' disabled') : ''}>${opts.label}</button>
    </div>
    ${opts.caption ? raw(html`<div class="form-note">${raw(opts.caption)}</div>`) : ''}
    ${raw(sheet)}`;
}

/* ---- the three tiles ---- */

function pendingTile(a) {
  const today = todayCentral();
  const late = outDatePassed(a, today);
  const acts = rentalActions(a, role());
  const pend = rentalPending(a);
  return html`
    <div class="card rtile" data-agreement="${String(a.agreement)}">
      ${raw(rentalHead(a, late ? html`<span class="chip bad">${outMove(a) === 'DELIVER' ? 'not delivered' : 'not picked up'} — out date passed</span>` : ''))}
      ${raw(outLine(a))}
      <div class="rline">${rateText(a)}</div>
      ${raw(tileDocs(a))}
      ${raw(rowAlerts(a))}
      ${raw(pend.html)}
      ${acts.wentOut ? raw(rentalControl(a, 'OUT', { label: 'Went out', busy: pend.busy })) : ''}
    </div>`;
}

function activeTile(a) {
  const acts = rentalActions(a, role());
  const pend = rentalPending(a);
  const caption = inMove(a) === 'CUSTOMER-RETURN'
    ? 'Stops the clock. Tap <strong>Back in shop</strong> when it lands.'
    : 'Stops the clock and puts a pickup on Dispatch.';
  return html`
    <div class="card rtile" data-agreement="${String(a.agreement)}">
      ${raw(rentalHead(a, daysChip(a)))}
      ${raw(dueBack(a))}
      <dl class="kv" style="margin-top:10px">
        ${a.on_rent_since ? raw(kvRow('On rent since', fmtDateFull(a.on_rent_since))) : ''}
        ${raw(kvRow('Cycle', rateText(a)))}
        ${raw(kvRow('Cycles billed', cyclesText(a), 'num'))}
        ${raw(kvRow('Last invoice', a.last_invoice))}
        ${raw(kvRow('Next due', a.next_due ? fmtDateFull(a.next_due) : ''))}
      </dl>
      ${raw(tileDocs(a))}
      ${raw(rowAlerts(a))}
      ${raw(pend.html)}
      ${acts.offRent ? raw(rentalControl(a, 'OFF-RENT', { label: 'Off-rent', busy: pend.busy, caption })) : ''}
    </div>`;
}

function offRentTile(a) {
  const acts = rentalActions(a, role());
  const pend = rentalPending(a);
  const pickup = inMove(a) === 'PICKUP';
  const row = pickup ? returnRow(a, dispatchRows()) : null;
  const pickupLine = pickup
    ? html`<div class="rline">Pickup · ${row
      ? raw(html`${raw(runLink(row.id, row.status, row.driver, row.rig))}${row.date && isDateStr(row.date) ? ` · ${fmtDateDow(row.date)}` : ''}`)
      : raw(html`<span class="muted">not on the board yet — the next run adds it</span>`)}</div>`
    : html`<div class="rline">Customer brings it back</div>`;
  return html`
    <div class="card rtile" data-agreement="${String(a.agreement)}">
      ${raw(rentalHead(a, daysChip(a)))}
      <dl class="kv" style="margin-top:10px">
        ${raw(kvRow('Off-rent', a.off_rent ? fmtDateFull(a.off_rent) : ''))}
        ${raw(kvRow('Billed through', a.last_invoiced_period_end ? fmtDateFull(a.last_invoiced_period_end) : ''))}
        ${raw(kvRow('Cycles billed', cyclesText(a), 'num'))}
        ${raw(kvRow('Last invoice', a.last_invoice))}
      </dl>
      ${raw(pickupLine)}
      ${raw(tileDocs(a))}
      ${raw(rowAlerts(a))}
      ${raw(pend.html)}
      ${acts.backInShop ? raw(rentalControl(a, 'IN', {
        label: 'Back in shop', busy: pend.busy, ghost: pickup,
        caption: pickup ? 'Owner override — only for a pickup that happened off the board.' : '',
      })) : ''}
    </div>`;
}

/**
 * Agreement detail (`#/agreement/<id>`). Same anatomy as ticket detail: the
 * tile's fields in full, its truck moves, its documents. Agreements carry no
 * `log[]` in schema 7, so there is no Notes timeline here — not an empty one.
 */
function viewAgreement(seg) {
  const a = agreementByRoute(agreements(), seg);
  if (!a) return html`<a class="crumb" href="#/rentals">‹ Rentals</a>${raw(emptyState('Agreement not found.', 'An ended rental leaves the snapshot.'))}`;
  const st = statusOf(a);
  const acts = rentalActions(a, role());
  const pend = rentalPending(a);
  const u = unitBySerial(a.serial);
  const moves = [deliveryRow(a, dispatchRows()), returnRow(a, dispatchRows())].filter(Boolean);
  const outText = a.out_date || outMove(a)
    ? `${outMove(a) === 'CUSTOMER-PICKUP' ? 'Customer picks up' : 'We deliver'}${a.out_date ? ` · ${fmtDateFull(a.out_date)}` : ''}` : '';
  const inText = `${inMove(a) === 'CUSTOMER-RETURN' ? 'Customer brings it back' : 'We pick it up'}${a.in_date ? ` · ${fmtDateFull(a.in_date)}` : ''}`;

  return html`
    <a class="crumb" href="#/rentals">‹ Rentals</a>
    ${raw(msgBlock())}
    <div class="detail-head">
      <div class="h">${a.customer || 'Unknown customer'}</div>
      <div class="s">${a.agreement == null ? 'no agreement' : a.agreement} · ${RENTAL_STATUS_LABEL[st]}</div>
      <div class="chips">
        ${raw(chip(RENTAL_STATUS_LABEL[st], st === 'ACTIVE' ? 'rent' : st === 'PENDING' ? 'hold' : 'pickup'))}
        ${raw(daysChip(a))}${raw(leadChip(a.lead))}
        ${st === 'PENDING' && outDatePassed(a, todayCentral()) ? raw(html`<span class="chip bad">out date passed</span>`) : ''}
      </div>
    </div>
    ${st === 'ACTIVE' ? raw(dueBack(a)) : ''}
    ${raw(rowAlerts(a))}

    <h2>Agreement</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Agreement', a.agreement == null ? raw('<span class="none">none</span>') : a.agreement))}
      ${raw(kvRow('Customer', a.customer))}
      ${raw(kvRow('Unit', a.serial != null ? raw(html`<a href="#/unit/${raw(enc(a.serial))}">#${a.serial}</a>${u ? ` · ${unitName(u)}` : ''}`) : ''))}
      ${raw(kvRow('Job site', a.job_site))}
      ${raw(kvRow('Customer PO', a.customer_po))}
      ${raw(kvRow('Lead', a.lead ? raw(html`<a href="#/lead/${raw(enc(a.lead))}">${a.lead}</a>`) : ''))}
      ${raw(kvRow('Cycle', rateText(a)))}
      ${raw(kvRow('Cycles billed', cyclesText(a), 'num'))}
      ${raw(kvRow('Last invoiced', a.last_invoiced_period_start
        ? `${fmtDate(a.last_invoiced_period_start)} – ${fmtDateFull(a.last_invoiced_period_end)}` : ''))}
      ${raw(kvRow('Last invoice', a.last_invoice))}
      ${raw(kvRow('Next due', a.next_due ? fmtDateFull(a.next_due) : ''))}
    </dl></div>

    <h2>On rent</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Goes out', outText))}
      ${raw(kvRow('On rent since', a.on_rent_since ? fmtDateFull(a.on_rent_since) : ''))}
      ${raw(kvRow('Days on rent', typeof a.days_on_rent === 'number' ? `${a.days_on_rent}` : '', 'num'))}
      ${raw(kvRow('Comes home', inText))}
      ${raw(kvRow('Off-rent', a.off_rent ? fmtDateFull(a.off_rent) : ''))}
    </dl></div>

    ${pend.html ? raw(html`<div class="note"><strong>⏳ Pending</strong>${raw(pend.html)}</div>`) : ''}
    ${acts.wentOut ? raw(rentalControl(a, 'OUT', { label: 'Went out', busy: pend.busy })) : ''}
    ${acts.offRent ? raw(rentalControl(a, 'OFF-RENT', { label: 'Off-rent', busy: pend.busy,
      caption: inMove(a) === 'CUSTOMER-RETURN' ? 'Stops the clock. Tap <strong>Back in shop</strong> when it lands.' : 'Stops the clock and puts a pickup on Dispatch.' })) : ''}
    ${acts.backInShop ? raw(rentalControl(a, 'IN', { label: 'Back in shop', busy: pend.busy, ghost: inMove(a) === 'PICKUP',
      caption: inMove(a) === 'PICKUP' ? 'Owner override — only for a pickup that happened off the board.' : '' })) : ''}

    ${moves.length ? raw(html`<h2>Moves</h2>
      <div class="card dlist">${raw(moves.map((r) => dispatchRow(r, { compact: true })).join(''))}</div>`) : ''}

    ${raw(docsSection(a, String(a.agreement)))}`;
}

/**
 * Alerts for an agreements row. `agreement: null` is the unbilled-rental case and
 * must be loud, but the engine usually says so in `alerts` too — don't say it twice.
 */
function rowAlerts(a) {
  const alerts = (a.alerts || []).slice();
  if (a.agreement == null && !alerts.some((x) => /unbilled/i.test(x))) {
    alerts.unshift('UNBILLED RENTAL — unit is out with no agreement');
  }
  return alerts.map((x) => html`<div class="alert">⚠️ ${x}</div>`).join('');
}

/** Recurring revenue card (D21). Never says "monthly" in the headline — 13.04 cycles a year. */
function revenueCard() {
  const r = recurringRevenue(agreements());
  return html`
    <section class="rev" aria-label="Recurring revenue per 28-day cycle">
      <div class="rev-h">Recurring revenue — per 28-day cycle</div>
      <div class="rev-v">${fmtMoney(r.total)}</div>
      <div class="rev-s">across ${r.count} agreement${r.count === 1 ? '' : 's'}</div>
      <div class="rev-m">≈ ${fmtMoney(r.perMonth)} / month</div>
    </section>`;
}

/** The fetch list (D32): engine-computed pickups[], derived from units if a snapshot lacks it. */
function pickupsList() {
  const p = state.snapshot && state.snapshot.pickups;
  if (Array.isArray(p)) return p;
  return units().filter((u) => u.readiness === 'NEEDS-PICKUP' && u.unit_state !== 'RETIRED').map((u) => {
    const ag = u.agreement != null ? agreements().find((a) => a.agreement === u.agreement) : null;
    return { serial: u.serial, model: unitName(u), category: u.category, unit_state: u.unit_state, job_site: u.job_site,
      agreement: u.agreement, customer: ag ? ag.customer : null, billed_through: ag ? ag.last_invoiced_period_end : null, note: u.readiness_note };
  });
}

/** Fleet status board (D20): six exclusive buckets of the non-retired fleet. Zero rows stay, greyed. */
function boardView() {
  const b = statusBoard(units());
  const rows = b.rows.map((r) => html`
    <div class="brow brow-${r.color}${r.count ? '' : ' zero'}">
      <span class="brow-l">${r.label}</span>
      <span class="brow-n">${r.count}</span>
      <span class="brow-track"><span class="brow-fill" style="width:${r.pct}%"></span></span>
      <span class="brow-p">${r.pct}%</span>
    </div>`);
  return html`
    <section class="board" aria-label="Fleet status board">
      <div class="board-h"><span>Fleet status</span><span class="c">${b.total} units</span></div>
      ${raw(rows.join(''))}
    </section>`;
}

/* ====================================== service: kanban + ticket detail ==== */

const enc = (s) => encodeURIComponent(String(s == null ? '' : s));

/** The one-shot confirmation line after a write. Cleared on the next navigation. */
function msgBlock() {
  if (!ui.msg) return '';
  const m = ui.msg;
  if (m.tone === 'bad') return html`<div class="alert">⚠️ ${m.text}</div>`;
  // A document says "Attached", not "Submitted": the bytes really did land, and
  // it is only the filing that waits for the run.
  if (m.tone === 'doc') return html`<div class="note"><strong>Attached ✓</strong>${m.text}</div>`;
  return html`<div class="note"><strong>Submitted</strong>${m.text}</div>`;
}

/** "⏳ pending" line for a row that has unapplied writes against it. */
function pendingLine(n) {
  return n ? html`<div class="row-pending">⏳ ${n} pending — applies at the next run</div>` : '';
}

/* ---- Documents (schema 6) -----------------------------------------------
 * `service_queue[].docs[]` and `leads[].docs[]` — the quote, the work order,
 * the photo of the cracked squeegee. One flat list, no viewer: a tap opens the
 * file in a NEW TAB straight from the Worker and the phone's own viewer takes
 * it from there (see the [data-doc] handler).
 *
 * THREE TIERS, in this order, and the order is the whole point:
 *
 *   1. FILED     rows from the snapshot. The engine has them; they are real.
 *                Engine order, never re-sorted (same rule as the notes log).
 *   2. PENDING   a `doc_attach` that has been accepted by the Worker but not
 *                yet applied by the engine. The BYTES are safe — they went up
 *                first, and the record binding is in `docmeta` — but the row is
 *                not in `docs[]` yet, so it must never render as if it were.
 *   3. UNSENT    a file that failed on the way out, or is still going. Not an
 *                event at all yet. Newest last, at the end, where the tech's
 *                eye already is after tapping.
 *
 * S1 said an empty `docs[]` renders nothing at all. S2 supersedes that HERE and
 * only here: the two add buttons live in this group, so on a detail view the
 * group always draws — an empty one is not a placeholder, it is the way to put
 * a document on the ticket. Everywhere else the S1 rule stands.
 */
function docsSection(entity, recordId) {
  const filed = docRows(entity);
  const pendingRows = pendingDocsFor(recordId);
  const unsent = uploadsFor(recordId);
  // Uploading needs a record the Worker will accept. A detail view always has
  // one; the guard is so a future caller can't quietly ship a broken button.
  const canAdd = DOC_RECORD_RE.test(String(recordId || ''));
  const total = filed.length + pendingRows.length + unsent.length;
  if (!total && !canAdd) return '';

  const row = (inner, cls, attrs) => html`<button class="docrow${cls ? ' ' + cls : ''}" type="button" ${raw(attrs || '')}>${raw(inner)}</button>`;
  const face = (d, thumb) => html`
    ${thumb ? raw(html`<img class="doc-thumb" src="${thumb}" alt="">`) : raw(html`<span class="doc-ico" aria-hidden="true">${d.icon}</span>`)}
    <span class="doc-name">${d.label} — ${d.name}</span>`;

  return html`
    <h2>Documents${total ? raw(html` <span class="count">${total}</span>`) : ''}</h2>
    <div class="card docs">
      ${raw(filed.map((d) => row(html`
        ${raw(face(d, thumbs.get(d.id)))}
        ${d.size ? raw(html`<span class="doc-size">${d.size}</span>`) : ''}
        <span class="doc-go" aria-hidden="true">›</span>`, '', `data-doc="${esc(d.id)}"`)).join(''))}

      ${raw(pendingRows.map((d) => row(html`
        ${raw(face(d, thumbs.get(d.docId)))}
        <span class="doc-pend">⏳ filing</span>`, 'is-pending', 'data-doc-pending="1"')).join(''))}

      ${raw(unsent.map((u) => row(u.state === 'sending'
        ? html`${raw(face(u, u.thumb))}<span class="doc-pend">Sending…</span>`
        : html`${raw(face(u, u.thumb))}<span class="doc-fail">${u.error || "Didn't send"} — tap to retry</span>`,
        u.state === 'sending' ? 'is-sending' : 'is-failed',
        u.state === 'sending' ? 'disabled' : `data-doc-retry="${esc(u.localId)}"`)).join(''))}

      ${canAdd ? raw(docAddRow(recordId)) : ''}
    </div>
    ${canAdd && sheetOpen('doc-kind', recordId) ? raw(kindSheet(recordId)) : ''}`;
}

/** The unsent files for one record, oldest first — insertion order of the Map. */
const uploadsFor = (recordId) => [...uploads.values()].filter((u) => u.record === recordId);

/**
 * The two doors, side by side, for any role.
 *
 * 📷 goes straight to the camera (`capture="environment"` — the back lens, not
 * a selfie); 📎 goes to the Files picker, which is where a scan-to-PDF lands.
 * Neither takes `multiple`: a two-page work order is two taps, and a
 * multi-select would need a queue this app has deliberately not got.
 *
 * The inputs are real but hidden; the buttons click them. `capture` on the
 * camera input is what makes iOS skip the "Photo Library / Take Photo" sheet.
 */
function docAddRow(recordId) {
  return html`
    <div class="doc-add">
      <button class="btn sm ghost" type="button" data-doc-pick="camera">📷 Photo</button>
      <button class="btn sm ghost" type="button" data-doc-pick="file">📎 File</button>
      <input type="file" accept="image/*" capture="environment" data-doc-input="camera" data-record="${recordId}" hidden>
      <input type="file" accept="image/*,application/pdf" data-doc-input="file" data-record="${recordId}" hidden>
    </div>`;
}

/**
 * One tap to say what it is. Three big buttons, Work order highlighted because
 * it is what a tech is holding nine times out of ten.
 *
 * PHOTO is not on it — resolveKind() works that out from the file (see
 * docs/attachments.js), so nobody has to tell the app that the photo they just
 * took is a photo.
 */
function kindSheet(recordId) {
  const pick = pendingPick;
  if (!pick || pick.record !== recordId) return '';
  return html`
    <div class="sheet doc-sheet">
      <div class="sheet-h">What is it?</div>
      <div class="doc-preview">
        ${pick.thumb ? raw(html`<img class="doc-thumb lg" src="${pick.thumb}" alt="">`) : raw('<span class="doc-ico lg" aria-hidden="true">📄</span>')}
        <div>
          <div class="doc-preview-name">${pick.name}</div>
          <div class="doc-preview-size">${pick.sizeText}</div>
        </div>
      </div>
      <div class="kinds">
        ${raw(KIND_CHOICES.map((c, i) => html`
          <button class="btn${i ? ' ghost' : ''}" type="button" data-doc-kind="${c.kind}">${c.label}</button>`).join(''))}
      </div>
      <div class="actions row"><button class="btn ghost" type="button" data-sheet-close="1">Cancel</button></div>
      <div class="form-note">It uploads now and files at the next run. Leaving this page before it sends discards it.</div>
    </div>`;
}

/* ---- Notes timeline (v2.4) ---------------------------------------------
 * `service_queue[].log[]` and `leads[].log[]` render the same way, so tickets
 * and leads share this. Matt reads a tech's diagnosis here to price the job,
 * which is the whole reason the field exists — so the TEXT is the primary
 * line, and `who` is a chip only when the engine managed to parse one.
 *
 * `ts` is rendered VERBATIM. The engine already formatted it for a Central
 * reader ("2026-09-04 11:09 CT", or a bare "2026-09-03" on an import), so it
 * is neither an instant to format nor a business date to reformat — see
 * docs/notes.js. Nothing here goes near `new Date()`.
 *
 * This session's unapplied notes sit BELOW the record, newest last (v2.5).
 * They ARE the newest thing on the timeline — a note you just typed belongs
 * where your eye already is, at the end, not above thirty older ones. The tint
 * and the badge are what say "not applied yet"; the position says "most
 * recent", which is true.
 */
function notesSection(entity, pending) {
  const rows = logRows(entity);
  const mine = pendingNotes(pending);
  if (!rows.length && !mine.length) {
    return html`<h2>Notes</h2>
      <div class="card notes"><div class="hold-empty">No notes yet.</div></div>`;
  }

  const meta = (who, ts, extra) => html`<div class="nmeta">
    ${who ? raw(html`<span class="nwho">${who}</span>`) : ''}
    ${ts ? raw(html`<span class="nts">${ts}</span>`) : ''}
    ${extra ? raw(extra) : ''}
  </div>`;

  return html`
    <h2>Notes${rows.length ? raw(html` <span class="count">${rows.length}</span>`) : ''}</h2>
    <div class="card notes">
      ${raw(rows.map((n) => html`
        <div class="nrow">
          <div class="ntext">${n.text}</div>
          ${raw(meta(n.who, n.ts, null))}
        </div>`).join(''))}
      ${raw(mine.map((n) => html`
        <div class="nrow is-pending">
          <div class="ntext">${n.text}</div>
          ${raw(meta(n.who, null, html`<span class="npend">⏳ applies at the next run</span>`))}
        </div>`).join(''))}
    </div>`;
}

/* ---- undo a pending event (D46) ----------------------------------------
 * You may take back your OWN tap, and only while it is still pending. This is
 * a "wrong button" valve, not moderation: somebody else's pending write renders
 * exactly as it did before, with no control at all. The Worker enforces the
 * same rule — this is only about which buttons get drawn. */

const canUndo = (e) => !!e && !!e.id && !!state.me && e.actor === state.me.name;

/** The Undo button, or the confirm sheet when it is armed. '' for others' events. */
function undoControl(e) {
  if (!canUndo(e)) return '';
  if (!sheetOpen('undo', e.id)) {
    return html`<button class="btn sm ghost undo" type="button" data-sheet="undo" data-id="${e.id}">Undo</button>`;
  }
  return html`
    <div class="undo-confirm">
      <div class="undo-q">Undo this tap? It hasn't been applied yet.</div>
      <div class="actions row">
        <button class="btn sm" type="button" data-undo="${e.id}">Yes, undo it</button>
        <button class="btn sm ghost" type="button" data-sheet-close="1">Keep it</button>
      </div>
    </div>`;
}

const PRI_LABEL = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

/**
 * Service tab (D43). Top to bottom: + New ticket · filter chips · the widget
 * zone the chip selects · the kanban.
 *
 * Which widgets a chip shows:
 *   All       Fleet Status, then the Service Pipeline — the whole shop
 *   Fleet     Fleet Status only    (our machines' condition)
 *   Customer  Service Pipeline only (their repairs' progress)
 */
function viewService() {
  const q = serviceQueue();
  const opens = pendingTicketOpens();
  const filter = ui.ticketFilter;
  const s = serviceSummary();

  // All / Fleet / Customer, by machine_owner — whose MACHINE it is, not the
  // `owner` role. Fleet sits left of Customer (D43). Counts from the summary
  // when the engine sent one.
  const counts = { all: (s ? s.open_customer + s.open_wss : q.filter((t) => t.status === 'OPEN').length),
    CUSTOMER: s ? s.open_customer : q.filter((t) => t.status === 'OPEN' && t.machine_owner === 'CUSTOMER').length,
    WSS: s ? s.open_wss : q.filter((t) => t.status === 'OPEN' && t.machine_owner === 'WSS').length };
  const chips = [['all', 'All'], ['WSS', 'Fleet'], ['CUSTOMER', 'Customer']].map(([v, label]) =>
    html`<button type="button" class="fchip${filter === v ? ' on' : ''}" data-filter="${v}">${label}<span class="c">${counts[v]}</span></button>`);

  const widgets = filter === 'WSS' ? boardView()
    : filter === 'CUSTOMER' ? pipelineView(false)
    : boardView() + pipelineView(true);

  const head = html`<h1>Service</h1>${raw(msgBlock())}
    <div class="actions"><button class="btn" type="button" data-sheet="new-ticket">+ New ticket</button></div>
    ${sheetOpen('new-ticket') ? raw(newTicketForm()) : ''}
    <div class="fchips" role="group" aria-label="Filter tickets">${raw(chips.join(''))}</div>
    ${raw(widgets)}`;

  // The widgets stand on their own — an empty queue still shows the shop's
  // shape, so only the kanban is replaced by the empty state.
  if (!q.length && !opens.length) {
    return head + emptyState('Nothing in the shop.',
      'Open a ticket above — it shows here as pending until the next run picks it up.');
  }

  const cols = columnize(q, { summary: s, filter }).map((c) => {
    // A pending ticket_open has no number yet (§3.1) — it sits at the head of
    // RECEIVED as a synthetic card and never invents an id.
    const synth = c.stage === 'RECEIVED'
      ? opens.filter((e) => filter === 'all' || pl(e).machine_owner === filter).map(pendingTicketCard)
      : [];
    const cards = synth.concat(sortTickets(c.tickets).map(ticketCard));
    return html`<section class="kan-col" id="kan-${c.stage}">
      <div class="kan-head"><span>${c.label}</span><span class="c">${c.count}</span></div>
      <div class="kan-body">${cards.length ? raw(cards.join('')) : raw('<div class="kan-empty">nothing here</div>')}</div>
    </section>`;
  });

  return html`${raw(head)}
    <div class="kan-wrap"><div class="kanban">${raw(cols.join(''))}</div></div>
    <div class="form-note">Swipe the columns sideways. Tap a card for the whole ticket.</div>`;
}

/**
 * D62b — the pipeline widget's tenth row: the door to every CLOSED ticket the
 * snapshot carries (90 days from the engine; 7 on a pre-D62 publish), newest
 * first, searchable. Not a stage: no bar, no percent, and it never scrolls the
 * kanban. The label is a maroon button so it reads as tappable next to the nine
 * plain stage labels. The pill is the engine's closed_in_window under All (like
 * the column counts); otherwise what's drawn, so it always matches the list.
 */
function completedRow(q, filter, summary) {
  const all = completedTickets(q, { filter });
  const n = filter === 'all' && summary && typeof summary.closed_in_window === 'number'
    ? summary.closed_in_window : all.length;
  return html`
    <div class="brow pipe-done">
      <button type="button" class="done-btn" data-completed-toggle="1" aria-expanded="${ui.showCompleted ? 'true' : 'false'}"
        aria-controls="completed-panel">Completed ${ui.showCompleted ? '▾' : '▸'}</button>
      <span class="done-n">${n}</span>
    </div>
    ${ui.showCompleted ? raw(html`<div class="done-panel" id="completed-panel">
      ${all.length ? raw(html`<input type="search" class="completed-q" id="completed-q" value="${ui.completedQuery}"
        placeholder="customer, machine, or S-number" autocomplete="off" aria-label="Search completed tickets">`) : ''}
      <div id="completed-list">${raw(completedRows(q, filter, summary))}</div>
    </div>`) : ''}`;
}

/** Just the rows — the search box re-renders this and nothing else, so it keeps focus. */
function completedRows(q, filter, summary) {
  const rows = completedTickets(q, { filter, query: ui.completedQuery });
  if (!rows.length) {
    return completedTickets(q, { filter }).length
      ? '<div class="hold-empty">No completed tickets match.</div>'
      : html`<div class="hold-empty">Nothing completed in the last ${closedWindowDays(summary)} days.</div>`;
  }
  return rows.map((t) => {
    const what = t.machine_owner === 'WSS'
      ? html`<span class="unit-serial">#${t.serial}</span> ${t.equipment || ''}`
      : html`${t.equipment || '—'}`;
    const docs = Array.isArray(t.docs) ? t.docs.length : 0;
    return html`
      <a class="drow lead-closed done-ticket" href="#/ticket/${raw(enc(t.ticket))}">
        <div class="drow-top">
          <span class="drow-what">${t.customer || '—'}</span>
          ${raw(chip(t.ticket, 'out'))}
        </div>
        <div class="drow-meta">${raw(what)}${t.closed ? raw(html` · Closed ${fmtDateFull(t.closed)}`) : ''}${t.assigned ? raw(html` <span class="who" title="${t.assigned}">${String(t.assigned).slice(0, 1)}</span>`) : ''}${docs ? raw(html` <span class="doc-n" title="${docs} document${docs > 1 ? 's' : ''}">📎${docs}</span>`) : ''}</div>
      </a>`;
  }).join('');
}

/**
 * Service Pipeline widget (D43) — a sibling of the Fleet Status board, same
 * card and row anatomy. Customer machines only; fleet repairs are what the
 * board is for, which the caption says out loud when both are on screen.
 * Rows are buttons: tapping one scrolls the kanban to that column.
 */
function pipelineView(withCaption) {
  const p = pipeline(serviceQueue());
  const rows = p.rows.map((r) => html`
    <button type="button" class="brow pipe-${r.color}${r.count ? '' : ' zero'}" data-pipe="${r.stage}">
      <span class="brow-l">${r.label}</span>
      <span class="brow-n">${r.count}</span>
      <span class="brow-track"><span class="brow-fill" style="width:${r.pct}%"></span></span>
      <span class="brow-p">${r.pct}%</span>
    </button>`);
  return html`
    <section class="board pipe" aria-label="Service pipeline — customer machines">
      <div class="board-h">
        <span>Service pipeline</span>
        <span class="pills">
          <span class="c">${p.open} open</span>
          ${p.closedThisWeek ? raw(html`<span class="c muted">${p.closedThisWeek} closed this week</span>`) : ''}
        </span>
      </div>
      ${withCaption ? raw('<div class="board-cap">Customer machines · fleet repairs are on the board above</div>') : ''}
      ${raw(rows.join(''))}
      ${raw(completedRow(serviceQueue(), ui.ticketFilter, serviceSummary()))}
    </section>`;
}

/** City from a free-text site line ("3939 W McKinley Ave, Milwaukee, WI 53208" -> "Milwaukee").
 *  We only service Wisconsin, so the state is noise on a tile; drop it. Null when we can't tell. */
function siteCity(site) {
  if (!site) return null;
  let s = String(site).replace(/\(.*?\)/g, ' ').replace(/[—–].*$/, ' ');
  const m = s.match(/^(.*)[,\s]+(WI|Wisconsin)\b/i); // greedy: the LAST WI, not 'E Wisconsin Ave'
  if (!m) return /^[A-Za-z][A-Za-z .'-]{1,30}$/.test(s.trim()) ? s.trim() : null; // a bare city typed into the form
  const parts = m[1].split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let city = parts[parts.length - 1];
  // "815 Park Avenue Columbus" — no comma before the city; keep the last word.
  if (/^\d/.test(city) || /\b(ave|avenue|st|street|dr|drive|rd|road|blvd|pkwy|parkway|ln|lane|way|ct|hwy)\.?$/i.test(city)) {
    const w = city.split(/\s+/); city = w[w.length - 1];
    if (/^\d/.test(city) || /^(ave|avenue|st|street|dr|drive|rd|road|blvd|pkwy|parkway|ln|lane|way|ct|hwy)\.?$/i.test(city)) return null;
  }
  return city.replace(/\.$/, '') || null;
}

function ticketCard(t) {
  const moves = dispatchFor(dispatchRows(), t.ticket);
  const hasMove = moves.some((r) => r.status !== 'DONE');
  const pend = pendingForTicket(t.ticket);
  const closed = t.status === 'CLOSED';
  // A fleet machine is identified by its serial; a customer's by whatever they told us.
  const what = t.machine_owner === 'WSS'
    ? html`<span class="unit-serial">#${t.serial}</span> ${t.equipment || ''}`
    : html`${t.equipment || '—'}`;
  return html`
    <a class="kan-card pri-${t.priority || 'MEDIUM'}${closed ? ' closed' : ''}" href="#/ticket/${raw(enc(t.ticket))}">
      <div class="kan-row">
        <span class="kan-t">${t.customer || '—'}</span>
        <span class="kan-age">${t.age_days != null ? `${t.age_days}d` : ''}</span>
      </div>
      <div class="kan-eq">${raw(what)}</div>
      <div class="kan-issue">${t.issue || ''}</div>
      <div class="kan-foot">
        <span class="kan-id">${t.ticket}</span>
        ${t.assigned ? raw(html`<span class="who" title="${t.assigned}">${String(t.assigned).slice(0, 1)}</span>`) : ''}
        ${hasMove ? raw('<span class="truck" title="has a truck move">🚚</span>') : ''}
        ${siteCity(t.site) ? raw(html`<span class="kan-city" title="${t.site}">${siteCity(t.site)}</span>`) : ''}
        ${pend.length ? raw('<span class="kan-pend">⏳</span>') : ''}
      </div>
    </a>`;
}

/** The one write with no id of its own (§8). Badged, never counted as truth. */
function pendingTicketCard(e) {
  const p = pl(e);
  return html`
    <div class="kan-card pending-card">
      <div class="kan-row"><span class="kan-t">⏳ NEW — ${p.customer || '—'}</span></div>
      <div class="kan-eq">${p.equipment || (p.serial ? `#${p.serial}` : '')}</div>
      <div class="kan-issue">${p.issue || ''}</div>
      <div class="kan-foot"><span class="kan-pend">applies at the next run</span></div>
      ${raw(undoControl(e))}
    </div>`;
}

/* ---- + New ticket (any role) ---- */

function unitOptions(selected) {
  return units().filter((u) => u.unit_state !== 'RETIRED')
    .sort((a, b) => String(a.serial).localeCompare(String(b.serial)))
    .map((u) => html`<option value="${u.serial}"${String(u.serial) === String(selected || '') ? raw(' selected') : ''}>#${u.serial} — ${unitName(u)}${u.customer ? raw(html` (${u.customer})`) : ''}</option>`)
    .join('');
}

/** A segmented control backed by a hidden input, so the value survives no JS state. */
function toggle(field, options, value) {
  const btns = options.map(([v, label]) =>
    html`<button type="button" class="tg${v === value ? ' on' : ''}" data-val="${v}">${label}</button>`).join('');
  return html`<div class="toggle" data-toggle="${field}">${raw(btns)}</div>
    <input type="hidden" name="${field}" value="${value}">`;
}

function newTicketForm() {
  return html`
    <form class="write sheet" data-action="ticket_open">
      <label>Whose machine?</label>
      ${raw(toggle('machine_owner', [['CUSTOMER', "Customer's"], ['WSS', 'Ours (fleet)']], 'CUSTOMER'))}

      <div data-when="machine_owner=CUSTOMER">
        <label for="nt-cust">Customer</label>
        <input id="nt-cust" name="customer" autocomplete="off">
        <label for="nt-eq">Equipment</label>
        <input id="nt-eq" name="equipment" placeholder="brand / model / serial if you have it" autocomplete="off">
      </div>
      <div data-when="machine_owner=WSS" hidden>
        <label for="nt-unit">Which unit</label>
        <select id="nt-unit" name="serial">${raw(unitOptions())}</select>
        <div class="form-note">A unit out on rent can need a ticket too — the list holds everything but retired.</div>
      </div>

      <label for="nt-issue">What's wrong</label>
      <textarea id="nt-issue" name="issue" required placeholder="what it's doing, what the customer said"></textarea>

      <label>Where is it?</label>
      ${raw(toggle('location', [['AT-CUSTOMER', 'At the customer'], ['IN-SHOP', 'In our shop']], 'IN-SHOP'))}

      <div data-when="location=AT-CUSTOMER" hidden>
        <label>Getting it here</label>
        ${raw(toggle('intake_move', [['NONE', "We'll go to it"], ['PICKUP', 'We pick it up'], ['CUSTOMER-DROP', "They're dropping it off"]], 'NONE'))}
      </div>

      <label>Getting it back</label>
      ${raw(toggle('return_move', [['NONE', 'Done on site / n.a.'], ['DELIVER', 'We deliver it back'], ['CUSTOMER-PICKUP', "They'll pick it up"]], 'NONE'))}

      <label>Priority</label>
      ${raw(toggle('priority', [['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']], 'MEDIUM'))}

      <label for="nt-site">Site address</label>
      <input id="nt-site" name="site" placeholder="optional — needed if a truck is going" autocomplete="off">
      <div class="hint" data-hint="site" hidden>A truck is going — put the address in so the driver isn't calling around.</div>

      ${raw(sheetButtons('Open the ticket'))}
      <div class="form-note">A proposal. The engine assigns the ticket number at the next run.</div>
    </form>`;
}

const sheetButtons = (label) => html`
  <div class="actions row">
    <button class="btn" type="submit">${label}</button>
    <button class="btn ghost" type="button" data-sheet-close="1">Cancel</button>
  </div>`;

/* ---- ticket detail ---- */

function viewTicket(id) {
  const t = ticketById(id);
  if (!t) {
    return html`<a class="crumb" href="#/service">‹ Service</a>
      ${raw(emptyState('Ticket not found.', 'It may have closed and left the snapshot.'))}`;
  }
  const u = t.serial ? unitBySerial(t.serial) : null;
  const moves = dispatchFor(dispatchRows(), t.ticket);
  const pend = pendingForTicket(t.ticket);
  const gaps = missingMoves(t, moves);
  const canWork = role() === 'service' || role() === 'owner';

  const q = t.quote && typeof t.quote === 'object' ? t.quote : null;

  return html`
    <a class="crumb" href="#/service">‹ Service</a>
    ${raw(msgBlock())}
    <div class="detail-head">
      <div class="h">${t.customer || '—'}</div>
      <div class="s"><span class="unit-serial">${t.ticket}</span> · ${t.equipment || '—'}</div>
      <div class="chips">
        ${raw(chip(STAGE_LABEL[t.stage] || t.stage, 'stage'))}
        ${raw(chip(PRI_LABEL[t.priority] || t.priority || '—', `pri-chip pri-${t.priority || 'MEDIUM'}`))}
        ${raw(chip(t.machine_owner === 'WSS' ? 'Our machine' : "Customer's machine", t.machine_owner === 'WSS' ? 'rent' : 'out'))}
        ${t.status === 'CLOSED' ? raw(chip('CLOSED', 'ok')) : ''}
        ${u && u.work_order ? raw(html`<a class="chip wo" href="#/wo/${raw(enc(u.work_order))}">🔩 ${u.work_order}</a>`) : ''}
        ${/* D67: read-only — the sheets the engine linked to this ticket at OPEN. */
          raw(inspections().filter((i) => i.ticket === t.ticket).map((i) => html`<a class="chip insp" href="#/inspection/${raw(enc(i.id))}">${chipText(i)}</a>`).join(''))}
        ${pend.length ? raw(chip(`⏳ ${pend.length} pending`, 'pending')) : ''}
      </div>
    </div>

    ${pend.length ? raw(html`<div class="note"><strong>⏳ ${pend.length} pending change${pend.length > 1 ? 's' : ''}</strong>
      ${raw(pend.map((e) => html`<div class="pend-row"><span>${describeUpdate(e)} — by ${e.actor || 'someone'}</span>${raw(undoControl(e))}</div>`).join(''))}
      <div style="margin-top:6px">Applies at the next run — the board still shows the current truth.</div></div>`) : ''}

    <h2>Ticket</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Issue', t.issue))}
      ${raw(kvRow('Machine', u
        ? raw(html`<a href="#/unit/${raw(enc(u.serial))}">#${u.serial} ${unitName(u)}</a>`)
        : (t.equipment || '')))}
      ${raw(kvRow('Where', t.location === 'AT-CUSTOMER' ? 'At the customer' : 'In our shop'))}
      ${raw(kvRow('Site', t.site))}
      ${raw(kvRow('Assigned', t.assigned))}
      ${raw(kvRow('Scheduled', fmtDateFull(t.scheduled)))}
      ${raw(kvRow('Opened', `${fmtDateFull(t.opened)}${t.opened_by ? ` by ${t.opened_by}` : ''}`))}
      ${raw(kvRow('In this stage since', `${fmtDateFull(t.stage_since)}${t.age_in_stage_days != null ? ` · ${t.age_in_stage_days}d in stage` : ''}${t.age_days != null ? ` · ${t.age_days}d old` : ''}`))}
      ${raw(kvRow('Getting it here', MOVE_LABEL[t.intake_move] || t.intake_move))}
      ${raw(kvRow('Getting it back', MOVE_LABEL[t.return_move] || t.return_move))}
      ${q ? raw(kvRow('Quote', `${q.number ? q.number + ' · ' : ''}${fmtMoney(q.amount)}${q.approved ? ' · approved ' + fmtDate(q.approved) : q.sent ? ' · sent ' + fmtDate(q.sent) : ''}`)) : ''}
      ${!q && t.quote != null ? raw(kvRow('Quote', fmtMoney(t.quote), 'num')) : ''}
      ${raw(kvRow('Parts', t.parts))}
      ${raw(kvRow('Machinio', t.machinio_ref))}
      ${t.closed ? raw(kvRow('Closed', fmtDateFull(t.closed))) : ''}
    </dl></div>

    ${raw(docsSection(t, t.ticket))}
    ${raw(notesSection(t, pend))}
    ${raw(stagePicker(t, canWork))}
    ${raw(ticketActions(t))}
    ${raw(ticketMoves(t, moves, gaps))}`;
}

/** A one-line English rendering of a pending ticket_update, whatever it carried. */
function describeUpdate(e) {
  const p = pl(e);
  const bits = [];
  if (p.stage) bits.push(`stage → ${STAGE_LABEL[p.stage] || p.stage}`);
  if (p.assigned) bits.push(`assigned to ${p.assigned}`);
  if (p.scheduled) bits.push(`scheduled ${fmtDate(p.scheduled)}`);
  if (p.intake_move) bits.push(`intake → ${MOVE_LABEL[p.intake_move] || p.intake_move}`);
  if (p.return_move) bits.push(`return → ${MOVE_LABEL[p.return_move] || p.return_move}`);
  if (p.note) bits.push('note added');
  return bits.length ? bits.join(', ') : e.action;
}

function stagePicker(t, canWork) {
  const opts = stageOptions(t, role());
  if (!canWork) {
    return html`<h2>Stage</h2>
      <div class="info">${STAGE_LABEL[t.stage] || t.stage}. Techs and Matt move the stage.</div>`;
  }
  const btns = opts.map((o) => html`
    <button type="button" class="stg${o.current ? ' on' : ''}" data-stage="${o.stage}"
      ${o.enabled && !o.current ? '' : raw('disabled')} title="${o.caption || ''}">${o.label}</button>`);
  const caption = opts.find((o) => o.caption && !o.enabled);
  return html`
    <h2>Stage</h2>
    <div class="stages">${raw(btns.join(''))}</div>
    ${caption ? raw(html`<div class="form-note">${caption.caption}</div>`) : ''}
    ${ui.form && ui.form.kind === 'stage' && ui.form.id === t.ticket ? raw(stageForm(t, ui.form.arg)) : ''}`;
}

function stageForm(t, stage) {
  return html`
    <form class="write sheet" data-action="ticket_update" data-id="${t.ticket}" data-mode="stage">
      <input type="hidden" name="stage" value="${stage}">
      <label for="sf-note">Move to ${STAGE_LABEL[stage] || stage} — note (optional)</label>
      <textarea id="sf-note" name="note" placeholder="what you found, what you did"></textarea>
      ${raw(sheetButtons(`Move to ${STAGE_LABEL[stage] || stage}`))}
    </form>`;
}

/** Note / Assign / Schedule — any role (§3.3). */
function ticketActions(t) {
  const open = ui.form && ui.form.id === t.ticket ? ui.form.kind : null;
  return html`
    <h2>Update</h2>
    <div class="actions row">
      <button class="btn ghost" type="button" data-sheet="note" data-id="${t.ticket}">Add a note</button>
      <button class="btn ghost" type="button" data-sheet="assign" data-id="${t.ticket}">Assign</button>
      <button class="btn ghost" type="button" data-sheet="schedule" data-id="${t.ticket}">Schedule</button>
    </div>
    ${open === 'note' ? raw(html`
      <form class="write sheet" data-action="ticket_update" data-id="${t.ticket}" data-mode="note">
        <label for="tn-note">Note</label>
        <textarea id="tn-note" name="note" required placeholder="what happened"></textarea>
        ${raw(sheetButtons('Add the note'))}
      </form>`) : ''}
    ${open === 'assign' ? raw(html`
      <form class="write sheet" data-action="ticket_update" data-id="${t.ticket}" data-mode="assign">
        <label>Who's on it</label>
        ${raw(toggle('assigned', DRIVERS.map((n) => [n, n]), t.assigned && DRIVERS.includes(t.assigned) ? t.assigned : DRIVERS[0]))}
        ${raw(sheetButtons('Assign'))}
      </form>`) : ''}
    ${open === 'schedule' ? raw(html`
      <form class="write sheet" data-action="ticket_update" data-id="${t.ticket}" data-mode="schedule">
        <label for="ts-date">Day</label>
        <input id="ts-date" name="scheduled" type="date" value="${t.scheduled && isDateStr(t.scheduled) ? t.scheduled : todayCentral()}" required>
        ${raw(sheetButtons('Schedule it'))}
      </form>`) : ''}`;
}

/** The ticket's truck moves, plus the offer to book one the ticket says it lacks. */
function ticketMoves(t, moves, gaps) {
  const rows = moves.map((r) => dispatchRow(r, { compact: true }));
  const offers = [];
  if (gaps.intake) offers.push(html`<button class="btn ghost" type="button" data-move="intake" data-id="${t.ticket}">Add a pick-up</button>`);
  if (gaps.ret) offers.push(html`<button class="btn ghost" type="button" data-move="return" data-id="${t.ticket}">Add a return delivery</button>`);
  return html`
    <h2>Moves</h2>
    <div class="card dlist">
      ${rows.length ? raw(rows.join('')) : raw('<div class="hold-empty">No truck runs on this ticket.</div>')}
    </div>
    ${offers.length ? raw(html`<div class="actions row">${raw(offers.join(''))}</div>`) : ''}
    ${ui.form && ui.form.kind === 'move' && ui.form.id === t.ticket ? raw(moveForm(t, ui.form.arg)) : ''}`;
}

/** Booking a missing move is a ticket_update — the engine spawns the row (§3.3). */
function moveForm(t, which) {
  const intake = which === 'intake';
  const field = intake ? 'intake_move' : 'return_move';
  const opts = intake ? [['PICKUP', 'We pick it up'], ['CUSTOMER-DROP', "They're dropping it off"]]
    : [['DELIVER', 'We deliver it back'], ['CUSTOMER-PICKUP', "They'll pick it up"]];
  return html`
    <form class="write sheet" data-action="ticket_update" data-id="${t.ticket}" data-mode="move">
      <label>${intake ? 'Getting it here' : 'Getting it back'}</label>
      ${raw(toggle(field, opts, opts[0][0]))}
      ${raw(sheetButtons('Book it'))}
      <div class="form-note">The engine puts the run on the Dispatch board at the next run.</div>
    </form>`;
}

/* ========================================================= work order == */

/**
 * `#/wo/W1001` (D65 §5) — same anatomy as ticket detail. The header leads with
 * "PO W1001", big, because that is the number Matt reads to the vendor and the
 * number a tech looks for on the box. Parts, then labor, then close.
 *
 * NO RATE, NO DOLLARS, NO COST COLUMN — the snapshot carries none, and when
 * pricing reaches a phone it comes through the owner-only gate (D66+), not here.
 */
function viewWorkOrder(id) {
  const wo = woById(workOrders(), id);
  if (!wo) {
    return html`<a class="crumb" href="#/">‹ Fleet</a>
      ${raw(emptyState('Work order not found.', 'A closed one leaves after 30 days; a new one gets its W-number at the next run.'))}`;
  }
  const u = unitBySerial(wo.serial);
  const pend = pendingForWo(state.pending, wo.id);
  const isOpen = wo.status !== 'CLOSED';
  const parts = Array.isArray(wo.parts) ? wo.parts.filter(Boolean) : [];
  const labor = laborOf(wo);
  const me = (state.me && state.me.name) || '';
  const statusText = isOpen
    ? `OPEN${typeof wo.age_days === 'number' ? ` ${ageText(wo.age_days)}` : ''}`
    : `CLOSED${wo.closed ? ` ${fmtDate(wo.closed)}` : ''}`;

  const partRows = parts.map((part) => woPartRow(wo, part, pend, me)).join('');
  const laborRows = labor.map((l) => html`
    <div class="lrow">
      <span class="lrow-d">${fmtDate(l.date) || '—'}</span>
      <span class="lrow-w">${l.who || '—'}</span>
      <span class="lrow-h">${fmtHours(l.hours)} h</span>
      ${l.note ? raw(html`<span class="lrow-n">${l.note}</span>`) : ''}
    </div>`).join('');
  const log = Array.isArray(wo.log) ? wo.log.filter(Boolean).slice().reverse() : [];

  return html`
    <a class="crumb" href="${u ? raw(`#/unit/${enc(u.serial)}`) : '#/'}">‹ ${u ? unitName(u) : 'Fleet'}</a>
    ${raw(msgBlock())}
    <div class="detail-head">
      <div class="po-big">PO <span>${wo.id}</span></div>
      <div class="s">${wo.id} · ${wo.asset_item || `#${wo.serial}`} · ${statusText} · ${PURPOSE_LABEL[wo.purpose] || wo.purpose || '—'}</div>
      <div class="chips">
        <a class="chip asset" href="#/unit/${raw(enc(wo.serial))}">#${wo.serial}${u ? ` ${unitName(u)}` : ''}</a>
        ${wo.ticket ? raw(html`<a class="chip wrench" href="#/ticket/${raw(enc(wo.ticket))}">🔧 ${wo.ticket}</a>`) : ''}
        ${wo.inspection ? raw(html`<a class="chip insp" href="#/inspection/${raw(enc(wo.inspection))}">📋 ${wo.inspection}</a>`) : ''}
        ${isOpen ? '' : raw(chip('CLOSED', 'ok'))}
        ${pend.length ? raw(chip(`⏳ ${pend.length} pending`, 'pending')) : ''}
      </div>
    </div>

    ${pend.length ? raw(html`<div class="note"><strong>⏳ ${pend.length} pending change${pend.length > 1 ? 's' : ''}</strong>
      ${raw(pend.map((e) => html`<div class="pend-row"><span>${describeWoEvent(e)} — by ${e.actor || 'someone'}</span>${raw(undoControl(e))}</div>`).join(''))}
      <div style="margin-top:6px">Applies at the next run — the page still shows the current truth.</div></div>`) : ''}
    ${wo.note ? raw(html`<div class="note"><strong>Note</strong>${wo.note}</div>`) : ''}

    <h2>Parts${parts.length ? raw(html` <span class="count">${parts.length}</span>`) : ''}</h2>
    <div class="card dlist">
      ${parts.length ? raw(partRows) : raw('<div class="hold-empty">No parts on this work order — labor only.</div>')}
    </div>
    ${isOpen ? raw(html`<div class="actions row"><button class="btn ghost" type="button" data-sheet="wo-add" data-id="${wo.id}">+ Add parts</button></div>`) : ''}
    ${sheetOpen('wo-add', wo.id) ? raw(woAddPartsForm(wo)) : ''}

    <h2>Labor · ${fmtHours(wo.hours_total)} h</h2>
    <div class="card dlist">
      ${labor.length ? raw(laborRows) : raw('<div class="hold-empty">No hours logged yet.</div>')}
    </div>
    ${isOpen ? raw(html`<div class="actions row"><button class="btn ghost" type="button" data-sheet="wo-labor" data-id="${wo.id}">+ Log hours</button></div>`) : ''}
    ${sheetOpen('wo-labor', wo.id) ? raw(woLaborForm(wo)) : ''}

    <h2>Work order</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('PO / work order', wo.id))}
      ${raw(kvRow('Purpose', PURPOSE_LABEL[wo.purpose] || wo.purpose))}
      ${raw(kvRow('Opened', `${fmtDateFull(wo.opened)}${wo.opened_by ? ` by ${wo.opened_by}` : ''}`))}
      ${raw(kvRow('Ticket', wo.ticket ? raw(html`<a href="#/ticket/${raw(enc(wo.ticket))}">🔧 ${wo.ticket}</a>`) : ''))}
      ${wo.closed ? raw(kvRow('Closed', fmtDateFull(wo.closed))) : ''}
    </dl></div>

    ${raw(woFooter(wo, me))}

    <h2>Log${log.length ? raw(html` <span class="count">${log.length}</span>`) : ''}</h2>
    <div class="card notes">
      ${log.length ? raw(log.map((n) => html`
        <div class="nrow">
          <div class="ntext">${n.text}</div>
          <div class="nmeta">${n.who ? raw(html`<span class="nwho">${n.who}</span>`) : ''}${n.ts ? raw(html`<span class="nts">${n.ts}</span>`) : ''}</div>
        </div>`).join('')) : raw('<div class="hold-empty">Nothing logged yet.</div>')}
    </div>`;
}

/** One part line on the work-order page, with the buttons its state + your role get. */
function woPartRow(wo, part, pend, me) {
  const mine = pend.filter((e) => pl(e).action === 'PART-STATE' && pl(e).line === part.line);
  const acts = mine.length ? [] : partActions(wo, part, role(), me);
  const cls = { REQUESTED: 'warn', ORDERED: 'hold', 'IN-TRANSIT': 'rent', DELIVERED: 'ok', CANCELLED: '' }[part.state] || '';
  const tone = lineTone(wo, part, PARTS_AMBER, PARTS_RED);
  const open = ui.form && ui.form.kind === 'wo-part' ? String(ui.form.id).split('|') : null;
  const sheetState = open && open[0] === wo.id && Number(open[1]) === part.line ? open[2] : null;
  return html`
    <div class="drow wo-part${part.state === 'CANCELLED' ? ' cancelled' : ''}">
      <div class="drow-top">
        <span class="drow-what"><span class="wo-ln">${part.line}</span> <span class="unit-serial">${part.part_number || '—'}</span> × ${part.qty ?? 1}</span>
        ${raw(chip(PART_STATE_LABEL[part.state] || part.state, cls))}
      </div>
      <div class="drow-meta">${part.description || ''}${part.manufacturer ? raw(html` · ${MANUFACTURER_LABEL[part.manufacturer] || part.manufacturer}`) : ''}${part.source && part.source !== 'VENDOR' ? ` · ${part.source.toLowerCase().replace('-', ' ')}` : ''}</div>
      <div class="chips">
        ${part.ordered ? raw(chip(`ordered ${fmtDate(part.ordered)}`, 'cal')) : ''}
        ${part.vendor ? raw(chip(VENDOR_LABEL[part.vendor] || part.vendor, 'rig')) : ''}
        ${part.vendor_ref ? raw(chip(part.vendor_ref, 'cal')) : ''}
        ${raw(trackingChip(part))}
        ${part.delivered ? raw(chip(`delivered ${fmtDate(part.delivered)}`, 'ok')) : ''}
        ${tone && typeof wo.age_days === 'number' ? raw(chip(`${ageText(wo.age_days)} unordered`, `age ${tone}`)) : ''}
      </div>
      ${mine.length ? raw(html`<div class="row-pending">⏳ → ${PART_STATE_LABEL[pl(mine[0]).state] || pl(mine[0]).state} — applies at the next run</div>`) : ''}
      ${acts.length ? raw(html`<div class="drow-btns">${raw(acts.map((st) => html`
        <button class="btn sm${st === 'CANCELLED' ? ' ghost' : ''}" type="button" data-sheet="wo-part" data-id="${wo.id}|${part.line}|${st}">${PART_VERB_LABEL[st]}</button>`).join(''))}</div>`) : ''}
      ${sheetState ? raw(woPartStateForm(wo, part, sheetState)) : ''}
    </div>`;
}

/** The sheet behind one line button. Each state asks only for what it stamps. */
function woPartStateForm(wo, part, st) {
  const today = todayCentral();
  const vendor = part.vendor || vendorFor(part.manufacturer);
  const vopt = (v) => html`<option value="${v}"${v === vendor ? raw(' selected') : ''}>${VENDOR_LABEL[v]}</option>`;
  const fields = st === 'ORDERED' ? html`
      <label for="wp-date">Ordered on</label>
      <input id="wp-date" name="date" type="date" value="${today}" max="${today}" required>
      <label for="wp-vendor">Vendor</label>
      <select id="wp-vendor" name="vendor">${raw(VENDORS.map(vopt).join(''))}</select>
      <label for="wp-ref">Vendor order # (optional)</label>
      <input id="wp-ref" name="vendor_ref" maxlength="40" autocomplete="off" placeholder="SO-…">
      <div class="form-note">Give them <strong>PO ${wo.id}</strong> — it prints on the packing slip.</div>`
    : st === 'IN-TRANSIT' ? html`
      <label for="wp-track">Tracking # (optional)</label>
      <input id="wp-track" name="tracking" maxlength="60" autocomplete="off" placeholder="UPS 1Z… · FedEx · USPS">`
    : st === 'DELIVERED' ? html`
      <label for="wp-date">Delivered on</label>
      <input id="wp-date" name="date" type="date" value="${today}" max="${today}" required>
      <div class="form-note">Shelve it under #${wo.serial}.</div>`
    : '';
  return html`
    <form class="write sheet" data-action="work_order" data-verb="PART-STATE" data-wo="${wo.id}" data-line="${part.line}" data-state="${st}">
      ${raw(fields)}
      <label for="wp-note">Note (optional)</label>
      <textarea id="wp-note" name="note" maxlength="200" placeholder="${st === 'CANCELLED' ? 'found in shop stock, wrong part…' : 'backorder, ETA…'}"></textarea>
      ${raw(sheetButtons(`${PART_VERB_LABEL[st]} — line ${part.line}`))}
    </form>`;
}

function woAddPartsForm(wo) {
  const u = unitBySerial(wo.serial);
  const first = Array.isArray(wo.parts) && wo.parts[0] ? wo.parts[0].manufacturer : null;
  return html`
    <form class="write sheet" data-action="work_order" data-verb="ADD-PARTS" data-wo="${wo.id}">
      ${raw(partLinesEditor(first || manufacturerFor(u && u.brand), true))}
      ${raw(sheetButtons('Add the parts'))}
      <div class="form-note">A proposal — the lines appear at the next run, REQUESTED.</div>
    </form>`;
}

function woLaborForm(wo) {
  const today = todayCentral();
  const me = state.me && DRIVERS.includes(state.me.name) ? state.me.name : DRIVERS[0];
  return html`
    <form class="write sheet" data-action="work_order" data-verb="LABOR" data-wo="${wo.id}">
      <label for="wl-date">Day</label>
      <input id="wl-date" name="date" type="date" value="${today}" max="${today}" required>
      <label>Who</label>
      ${raw(toggle('who', DRIVERS.map((n) => [n, n]), me))}
      <label for="wl-hours">Hours</label>
      <div class="stepper">
        <button class="btn sm ghost" type="button" data-hours-step="-1" aria-label="Quarter hour less">−</button>
        <input id="wl-hours" name="hours" type="number" inputmode="decimal" min="${HOURS_MIN}" max="${HOURS_MAX}" step="${HOURS_STEP}" value="1" required>
        <button class="btn sm ghost" type="button" data-hours-step="1" aria-label="Quarter hour more">+</button>
      </div>
      <label for="wl-note">Note (optional)</label>
      <textarea id="wl-note" name="note" maxlength="200" placeholder="what got done"></textarea>
      ${raw(sheetButtons('Log the hours'))}
      <div class="form-note">Hours only — the shop rate lives in the vault, not on the phone.</div>
    </form>`;
}

/** Close (owner, every line settled) and Cancel (owner, or the opener before anything is ordered). */
function woFooter(wo, me) {
  const r = role();
  const showClose = closeShown(wo, r);
  const showCancel = cancelShown(wo, r, me);
  if (!showClose && !showCancel) return '';
  const canClose = closeEnabled(wo);
  return html`
    <div class="actions row">
      ${showClose ? raw(html`<button class="btn" type="button" data-sheet="wo-close" data-id="${wo.id}"${canClose ? '' : raw(' disabled')}>Close work order</button>`) : ''}
      ${showCancel ? raw(html`<button class="btn ghost" type="button" data-sheet="wo-cancel" data-id="${wo.id}">Cancel work order</button>`) : ''}
    </div>
    ${showClose && !canClose ? raw('<div class="form-note">Every line has to be delivered or cancelled before it closes.</div>') : ''}
    ${sheetOpen('wo-close', wo.id) && canClose ? raw(html`
      <form class="write sheet" data-action="work_order" data-verb="CLOSE" data-wo="${wo.id}">
        <label for="wc-note">Note (optional)</label>
        <textarea id="wc-note" name="note" maxlength="200"></textarea>
        ${raw(sheetButtons(`Close ${wo.id}`))}
      </form>`) : ''}
    ${sheetOpen('wo-cancel', wo.id) ? raw(html`
      <form class="write sheet" data-action="work_order" data-verb="CANCEL" data-wo="${wo.id}">
        <label for="wx-note">Why (optional)</label>
        <textarea id="wx-note" name="note" maxlength="200" placeholder="found it in shop stock…"></textarea>
        ${raw(sheetButtons(`Cancel ${wo.id}`))}
      </form>`) : ''}`;
}

/* ============================================= the inspection sheet (D67) == */

/**
 * `#/inspection/I1001` — and `#/inspection/new/<serial>` for a sheet opened on
 * this phone that the engine hasn't numbered yet (§2: the tech must not wait an
 * hour to start typing). Phone-first, one long scroll (§4): header · machine ·
 * readings · battery + cell grid · the library's sections · comments · footer.
 *
 * WHAT IS ON SCREEN, in layers, bottom to top:
 *   1. the snapshot's row (the vault's truth), or for a NEW sheet the defaults
 *      the engine will derive (class / body style from the category, the battery
 *      from this unit's last sheet);
 *   2. this sheet's still-pending taps, in the order they were made — badged
 *      pending, never drawn as applied;
 *   3. what's been typed on this page and not saved yet (`sheetLocal`).
 *
 * SAVING (§2, merge by section). Every change marks its section dirty and a
 * save follows a moment later, or at once when a field loses focus — one SAVE
 * per section, carrying ONLY that section. A newer save of the same section
 * takes the older unapplied one back (D46), so the inbox holds one per section.
 *
 * A NEW SHEET HAS NO I-NUMBER, and the engine's SAVE is keyed on one. What it
 * does accept is an OPEN that carries the first sections. So until the number
 * lands, each save re-issues the pending OPEN with every section typed so far
 * and takes the previous one back: one OPEN in the inbox, always the latest.
 * Done waits for the number — the engine cannot mark a sheet done that it has
 * not filed yet.
 *
 * NOT PERSISTED. `sheetLocal` is module state; a save that fails stays one tap
 * from a retry for as long as the page is open, and the copy says so.
 */
const sheetLocal = new Map();
const FLUSH_MS = 2500;

function localFor(key) {
  let l = sheetLocal.get(key);
  if (!l) {
    l = { edits: {}, dirty: new Set(), status: 'idle', error: null, timer: null, notes: new Set(), chain: Promise.resolve() };
    sheetLocal.set(key, l);
  }
  return l;
}
const withEdits = (key, sheet, editable) => {
  const l = sheetLocal.get(key);
  return l && editable ? { ...sheet, ...l.edits } : sheet;
};
const inspArg = () => {
  const m = /^#\/inspection\/(.+)$/.exec(window.location.hash || '');
  return m ? m[1] : null;
};
const argForKey = (key) => (key.startsWith('new:') ? `new/${enc(key.slice(4))}` : enc(key));
const mineOnly = (list) => list.filter((e) => e.actor === meName());

/** Everything the view and the save path need, from the route's argument. */
function sheetCtx(arg) {
  const lib = checklist();
  if (arg.startsWith('new/')) {
    const serial = decodeURIComponent(arg.slice(4));
    const key = `new:${serial}`;
    const u = unitBySerial(serial);
    if (u && u.inspection_draft) return { key, serial, u, redirect: u.inspection_draft };
    const opens = pendingOpensFor(state.pending, serial).sort(byTs);
    const mine = mineOnly(opens);
    const openEvt = (mine.length ? mine : opens).slice(-1)[0] || null;
    if (!openEvt) return { key, serial, u, isNew: true, missing: true };
    const prior = forSerial(inspections(), serial).find((i) => i.battery && i.battery.type) || null;
    let sheet = sheetFrom({
      serial, asset_item: u && u.asset_item, kind: defaultKind(u), status: 'DRAFT', opened_by: openEvt.actor,
      ...(u ? deriveProfile(u.category) : {}), battery: prior ? prior.battery : null,
    });
    sheet = overlay(sheet, pl(openEvt));
    const editable = mine.length > 0;
    return { key, serial, u, isNew: true, openEvt, pend: opens, lib, editable, sheet: withEdits(key, sheet, editable) };
  }
  const id = decodeURIComponent(arg);
  const row = inspById(inspections(), id);
  if (!row) return { key: id, id, missing: true };
  const pend = pendingForInsp(state.pending, id).sort(byTs);
  let sheet = sheetFrom(row);
  for (const e of pend) if (pl(e).action === 'SAVE') sheet = overlay(sheet, pl(e));
  const locked = pend.find((e) => ['DONE', 'VOID'].includes(pl(e).action)) || null;
  const editable = row.status === 'DRAFT' && !locked;
  return { key: id, id, row, u: unitBySerial(row.serial), serial: row.serial, pend, locked, lib, editable, sheet: withEdits(id, sheet, editable) };
}

/** The NEW sheet got its number: carry anything unsaved across to it. */
function migrateNew(key, id) {
  const l = sheetLocal.get(key);
  if (!l) return;
  sheetLocal.delete(key);
  const into = localFor(id);
  into.edits = { ...l.edits, ...into.edits };
  delete into.edits.kind;                       // the kind was the OPEN's; a SAVE cannot change it
  for (const k of l.dirty) if (SECTION_KEYS.includes(k)) into.dirty.add(k);
  for (const n of l.notes) into.notes.add(n);
  if (into.dirty.size) into.status = 'dirty';
}

function viewInspection(arg) {
  const c = sheetCtx(arg);
  if (c.redirect) {
    migrateNew(c.key, c.redirect);
    window.location.replace(`#/inspection/${enc(c.redirect)}`);
    return html`<div class="loading">Opening ${c.redirect}…</div>`;
  }
  const back = c.u || (c.serial ? unitBySerial(c.serial) : null);
  const crumb = back
    ? html`<a class="crumb" href="#/unit/${raw(enc(back.serial))}">‹ ${unitName(back)}</a>`
    : html`<a class="crumb" href="#/">‹ Fleet</a>`;
  if (c.missing) {
    return html`${raw(crumb)}${raw(msgBlock())}${raw(emptyState('Sheet not found.', c.isNew
      ? 'Nothing is open on this unit — start one from the unit page (Inspect).'
      : 'A voided sheet never ships, and a finished one leaves after 90 days.'))}`;
  }

  const { sheet, lib, editable } = c;
  const done = sheet.status === 'DONE';
  const dis = editable ? '' : raw(' disabled');
  const l = sheetLocal.get(c.key) || { status: 'idle', notes: new Set() };   // reading never creates one
  const carried = new Set(sheet.items.keys());
  const visible = lib ? visibleSections(lib, profileOf(sheet), carried) : [];
  const flags = done ? (sheet.flags || 0) : flagCount(sheet, visible);
  const title = [c.id || '⏳ NEW', sheet.asset_item || `#${sheet.serial}`, sheet.kind || '—', done ? 'DONE' : 'DRAFT'].join(' · ');
  const sub = done
    ? `done by ${sheet.tech || '—'}${sheet.done ? ` · ${fmtMD(sheet.done)}` : ''} · opened by ${sheet.opened_by || '—'}`
    : `opened by ${sheet.opened_by || '—'}${sheet.opened ? ` · ${fmtMD(sheet.opened)}` : ''}${typeof sheet.age_days === 'number' ? ` · ${ageText(sheet.age_days)}` : ''}`;
  const wo = sheet.work_order;

  const pendRows = (c.pend || []).map((e) => html`<div class="pend-row"><span>${describeInspEvent(e)} — by ${e.actor || 'someone'}</span>${raw(undoControl(e))}</div>`).join('');
  const pendBlock = c.isNew ? html`
    <div class="note"><strong>⏳ New sheet — not numbered yet</strong>
      The engine gives it an I-number at the next run. ${editable ? 'Keep going — everything you enter rides along with it.' : `It's ${c.openEvt.actor || 'someone'}'s to fill in until then.`}
      ${raw(pendRows)}</div>`
    : c.pend.length ? html`<div class="note"><strong>⏳ ${c.pend.length} pending change${c.pend.length > 1 ? 's' : ''}</strong>
      ${raw(pendRows)}<div style="margin-top:6px">Applies at the next run — the sheet shows them now, badged.</div></div>` : '';

  return html`
    ${raw(crumb)}
    ${raw(msgBlock())}
    <div class="detail-head insp-head">
      <div class="h">${title}</div>
      <div class="s">${sub}</div>
      <div class="chips">
        ${back ? raw(html`<a class="chip asset" href="#/unit/${raw(enc(back.serial))}">#${back.serial} ${unitName(back)}</a>`) : ''}
        ${sheet.ticket ? raw(html`<a class="chip wrench" href="#/ticket/${raw(enc(sheet.ticket))}">🔧 ${sheet.ticket}</a>`) : ''}
        ${wo ? raw(html`<a class="chip wo" href="#/wo/${raw(enc(wo))}">🔩 ${wo}</a>`) : ''}
        ${raw(chip(`${flags} ⚑`, flags ? 'warn' : 'ok'))}
        ${done ? raw(chip('DONE', 'ok')) : ''}
      </div>
    </div>
    ${raw(pendBlock)}
    ${editable ? raw(html`<div class="insp-status${l.status === 'failed' ? ' is-bad' : ''}" id="insp-status" data-key="${c.key}">${raw(inspStatusHtml(c.key))}</div>`) : ''}

    <div class="insp" data-insp-key="${c.key}">
      <h2>Machine</h2>
      <div class="card insp-card">
        ${c.isNew ? raw(selectField('kind', 'Sheet', INSP_KINDS, INSP_KIND_LABEL, sheet.kind, dis, false)) : ''}
        <div class="insp-2">
          ${raw(selectField('machine_class', 'Class', CLASSES, CLASS_LABEL, sheet.machine_class, dis, false))}
          ${raw(selectField('body_style', 'Body style', BODY_STYLES, BODY_STYLE_LABEL, sheet.body_style, dis, false))}
        </div>
        ${editable ? raw('<div class="form-note">Pre-set from the unit — change it if it\'s wrong. The rows below follow; nothing you answered is lost.</div>') : ''}
      </div>

      <h2>Readings</h2>
      ${raw(readingsCard(sheet, dis, editable))}

      <h2>Battery</h2>
      ${raw(batteryCard(sheet, dis))}

      ${lib ? raw(visible.map(({ section, rows }) => sectionCard(section, rows, sheet, l, dis, editable)).join(''))
        : raw('<div class="alert">⚠️ The row library didn\'t come with this snapshot. Readings, battery and comments still save; the rows come back at the next run.</div>')}

      <h2>Comments</h2>
      <div class="card insp-card">
        <textarea data-ifield="comments" maxlength="${MAX_COMMENTS}" placeholder="anything else — for the next tech, or for Matt"${dis}>${sheet.comments || ''}</textarea>
      </div>
    </div>

    ${raw(inspFooter(c, flags))}

    <h2>Log${sheet.log.length ? raw(html` <span class="count">${sheet.log.length}</span>`) : ''}</h2>
    <div class="card notes">
      ${sheet.log.length ? raw(sheet.log.map((n) => html`
        <div class="nrow">
          <div class="ntext">${n.text}</div>
          <div class="nmeta">${n.who ? raw(html`<span class="nwho">${n.who}</span>`) : ''}${n.ts ? raw(html`<span class="nts">${n.ts}</span>`) : ''}</div>
        </div>`).join('')) : raw('<div class="hold-empty">Nothing logged yet.</div>')}
    </div>`;
}

function selectField(field, label, values, labels, cur, dis, blank) {
  const opts = values.map((v) => html`<option value="${v}"${String(v) === String(cur) ? raw(' selected') : ''}>${labels[v] || v}</option>`).join('');
  return html`<label class="ifl"><span>${label}</span>
    <select data-ifield="${field}"${dis}>${blank || cur == null ? raw('<option value="">—</option>') : ''}${raw(opts)}</select></label>`;
}

function readingsCard(sheet, dis, editable) {
  const r = sheet.readings;
  // v1.2: broom / brush wear is "% life remaining" — whole numbers, the number pad, a % on the field.
  const numField = (d) => (d.pct
    ? html`<label class="ifl"><span>${d.label}</span>
      <span class="pct-wrap"><input type="number" inputmode="numeric" pattern="[0-9]*" step="1" min="0" max="100" data-ifield="readings.${d.key}" value="${r[d.key] == null ? '' : r[d.key]}"${dis}><span class="pct-suf" aria-hidden="true">%</span></span></label>`
    : html`<label class="ifl${d.hours ? ' big' : ''}"><span>${d.label}</span>
      <input type="number" inputmode="decimal" step="any" min="0" max="${d.max}" data-ifield="readings.${d.key}" value="${r[d.key] == null ? '' : r[d.key]}"${dis}></label>`);
  const shown = READINGS.filter((d) => !d.class || d.class === sheet.machine_class);
  const rot = r.brushes_rotated;
  const rb = (v, label) => html`<button type="button" class="seg-b${rot === v ? ' on' : ''}" data-irot="${String(v)}" aria-pressed="${rot === v ? 'true' : 'false'}"${dis}>${label}</button>`;
  return html`
    <div class="card insp-card">
      <div class="insp-hours">${raw(shown.filter((d) => d.hours).map(numField).join(''))}</div>
      <div class="insp-2">${raw(shown.filter((d) => !d.hours).map(numField).join(''))}</div>
      <div class="ifl"><span>Brushes rotated</span><div class="iseg">${raw(rb(true, 'Yes'))}${raw(rb(false, 'No'))}</div></div>
      ${editable && !doneReady(sheet) ? raw('<div class="form-note" id="insp-hours-hint">Done needs at least one hours reading — the meter is the one thing this sheet never leaves blank.</div>') : ''}
    </div>`;
}

function batteryCard(sheet, dis) {
  const b = sheet.battery || {};
  const layout = cellLayout(b);
  const packs = PACKS_BY_VOLTAGE[b.voltage] || [];
  const clar = (v) => html`<option value="">—</option>${raw(CLARITY.map((x) => html`<option value="${x}"${x === v ? raw(' selected') : ''}>${CLARITY_LABEL[x]}</option>`).join(''))}`;
  const lev = (v) => html`<option value="">—</option>${raw(LEVEL.map((x) => html`<option value="${x}"${x === v ? raw(' selected') : ''}>${LEVEL_LABEL[x]}</option>`).join(''))}`;
  const grid = layout ? layout.map((g) => html`
    <div class="cell-g">
      <div class="cell-gh">Battery ${g.battery}</div>
      ${raw(g.cells.map((cl) => {
        const k = cellKey(g.battery, cl);
        const v = sheet.cells.get(k) || {};
        return html`<div class="cell-r">
          <span class="cell-l">${k}</span>
          <input type="text" inputmode="decimal" placeholder="1.___" aria-label="Cell ${k} specific gravity" data-ifield="cell:${k}:sg" value="${v.sg == null ? '' : v.sg.toFixed(3)}"${dis}>
          <select aria-label="Cell ${k} clarity" data-ifield="cell:${k}:clarity"${dis}>${raw(clar(v.clarity))}</select>
          <select aria-label="Cell ${k} level" data-ifield="cell:${k}:level"${dis}>${raw(lev(v.level))}</select>
        </div>`;
      }).join(''))}
    </div>`).join('') : '';
  const hint = b.type === 'WET' && !layout ? 'Pick the voltage and the pack to draw the cell grid.'
    : b.type && b.type !== 'WET' ? 'Sealed pack — no cell readings.'
      : !b.type ? 'Pick the battery type. Most of the fleet is wet cell.' : '';
  return html`
    <div class="card insp-card">
      <div class="insp-3">
        ${raw(selectField('battery.type', 'Type', BATTERY_TYPES, BATTERY_LABEL, b.type, dis, true))}
        ${raw(selectField('battery.voltage', 'Voltage', VOLTAGES, { 24: '24V', 36: '36V' }, b.voltage, dis, true))}
        ${b.type === 'WET' ? raw(selectField('battery.pack', 'Pack', packs, PACK_LABEL, b.pack, dis, true)) : ''}
      </div>
      ${hint ? raw(html`<div class="form-note">${hint}</div>`) : ''}
      ${layout ? raw(html`<div class="cell-head"><span></span><span>Hydrometer</span><span>Clarity</span><span>Level</span></div>${raw(grid)}`) : ''}
    </div>`;
}

function sectionCard(section, rows, sheet, l, dis, editable) {
  const n = answeredIn(sheet, rows);
  const row = (r) => {
    const a = sheet.items.get(r.id) || {};
    const scale = SCALES[r.scale] || SCALES.FUNCTION;
    const flag = isFlag(a.result);
    const noteOpen = !!(flag || a.note || l.notes.has(r.id));
    const seg = scale.map((v) => html`<button type="button" class="seg-b${a.result === v ? ' on' : ''}${isFlag(v) ? ' f' : ''}" data-iseg="${r.id}" data-val="${v}" aria-pressed="${a.result === v ? 'true' : 'false'}"${dis}>${RESULT_LABEL[v] || v}</button>`).join('');
    const note = noteOpen
      ? (editable
        ? html`<input class="inote" type="text" maxlength="${MAX_ITEM_NOTE}" data-ifield="note:${r.id}" placeholder="${flag ? "what's wrong — it goes on the work order" : 'note'}" value="${a.note || ''}">`
        : (a.note ? html`<div class="inote-ro">${a.note}</div>` : ''))
      : (editable ? html`<button type="button" class="inote-add" data-inote="${r.id}">+ note</button>` : '');
    // "+ note" rides on the label line: a row per button would double the scroll.
    return html`<div class="irow${flag ? ' flag' : ''}">
      <div class="irow-top"><span class="irow-l">${r.label || r.id}${r.retired ? ' (retired)' : ''}</span>${noteOpen ? '' : raw(note)}</div>
      <div class="iseg" role="group" aria-label="${r.label || r.id}">${raw(seg)}</div>
      ${noteOpen ? raw(note) : ''}
    </div>`;
  };
  return html`
    <h2>${section.title || section.id} <span class="count">${n}/${rows.length} answered</span></h2>
    ${section.instruction ? raw(html`<div class="form-note insp-instr">${section.instruction}</div>`) : ''}
    <div class="card insp-rows">${raw(rows.map(row).join(''))}</div>`;
}

/**
 * The footer (§4.7). DRAFT: Done (disabled until an hours reading exists, and
 * until a NEW sheet has its number) · Void (owner, or the opener). DONE:
 * read-only, Reopen (owner, or the tech within 24 h), and — flags and no work
 * order — Open work order from this inspection.
 */
function inspFooter(c, flags) {
  const r = role();
  const me = meName();
  const sh = c.sheet;
  if (c.isNew) {
    return html`<div class="actions row insp-foot"><button class="btn" type="button" disabled>Done</button></div>
      <div class="form-note">Done unlocks once the engine numbers this sheet (next run). Keep filling it in — nothing is lost.</div>`;
  }
  const row = c.row;
  const verbPending = c.pend.some((e) => ['DONE', 'VOID', 'REOPEN'].includes(pl(e).action));
  if (sh.status === 'DRAFT') {
    if (c.locked) return '';
    const ready = doneReady(sh);
    const canVoid = voidShown(row, r, me);
    const techs = DRIVERS.map((n) => [n, n]);
    return html`
      <div class="actions row insp-foot">
        <button class="btn" type="button" data-sheet="insp-done" data-id="${c.key}"${ready ? '' : raw(' disabled')}>Done</button>
        ${canVoid ? raw(html`<button class="btn ghost danger-btn" type="button" data-sheet="insp-void" data-id="${c.key}">Void</button>`) : ''}
      </div>
      ${ready ? '' : raw('<div class="form-note">Done needs an hours reading.</div>')}
      ${sheetOpen('insp-done', c.key) && ready ? raw(html`
        <form class="write sheet" data-action="inspection" data-verb="DONE" data-insp="${c.id}" data-key="${c.key}">
          <label>Tech</label>
          ${raw(toggle('tech', techs, DRIVERS.includes(me) ? me : DRIVERS[0]))}
          <div class="form-note">${fmtReading(firstHours(sh.readings))} h goes on the unit · ${flags} flag${flags === 1 ? '' : 's'}. The sheet locks at the next run.</div>
          ${raw(sheetButtons(`Mark ${c.id} done`))}
        </form>`) : ''}
      ${sheetOpen('insp-void', c.key) && canVoid ? raw(voidForm(c)) : ''}`;
  }
  // DONE — read-only.
  const canReopen = !verbPending && reopenShown(row, r, me);
  const canVoid = !verbPending && voidShown(row, r, me);
  const woPend = state.pending.some((e) => e.action === 'work_order' && pl(e).action === 'OPEN' && pl(e).inspection === c.id);
  const u = c.u;
  const woBtn = woButtonShown(row) && !woPend;
  return html`
    <div class="actions row insp-foot">
      ${woBtn && u && !u.work_order ? raw(html`<button class="btn" type="button" data-sheet="insp-wo" data-id="${c.key}">Open work order from this inspection</button>`) : ''}
      ${canReopen ? raw(html`<button class="btn ghost" type="button" data-sheet="insp-reopen" data-id="${c.key}">Reopen</button>`) : ''}
      ${canVoid ? raw(html`<button class="btn ghost danger-btn" type="button" data-sheet="insp-void" data-id="${c.key}">Void</button>`) : ''}
    </div>
    ${woBtn && u && u.work_order ? raw(html`<div class="info">${u.work_order} is already open on this unit — <a href="#/wo/${raw(enc(u.work_order))}">add the parts there</a>.</div>`) : ''}
    ${woPend ? raw('<div class="info">⏳ Work order requested from this sheet — the W-number comes at the next run.</div>') : ''}
    ${sheetOpen('insp-wo', c.key) && woBtn && u && !u.work_order
      ? raw(woOpenForm(u, { ...woPrefill(row, flaggedLabels(sh, c.lib)), inspection: c.id })) : ''}
    ${sheetOpen('insp-reopen', c.key) && canReopen ? raw(html`
      <form class="write sheet" data-action="inspection" data-verb="REOPEN" data-insp="${c.id}" data-key="${c.key}">
        <label for="ir-note">Why (optional)</label>
        <textarea id="ir-note" name="note" maxlength="${MAX_NOTE}" placeholder="missed the recovery tank…"></textarea>
        ${raw(sheetButtons(`Reopen ${c.id}`))}
        <div class="form-note">It goes back to DRAFT. The hours already on the unit stay until the next Done.</div>
      </form>`) : ''}
    ${sheetOpen('insp-void', c.key) && canVoid ? raw(voidForm(c)) : ''}`;
}
function voidForm(c) {
  return html`
    <form class="write sheet" data-action="inspection" data-verb="VOID" data-insp="${c.id}" data-key="${c.key}">
      <label for="iv-note">Why (optional)</label>
      <textarea id="iv-note" name="note" maxlength="${MAX_NOTE}" placeholder="wrong unit…"></textarea>
      ${raw(sheetButtons(`Void ${c.id}`))}
      <div class="form-note">A voided sheet never comes back, and it frees the unit for a new one.</div>
    </form>`;
}

function inspStatusHtml(key) {
  const l = sheetLocal.get(key);
  const st = l ? l.status : 'idle';
  if (st === 'saving') return '<span class="ist">Saving…</span>';
  if (st === 'dirty') return '<span class="ist">Saving in a moment…</span>';
  if (st === 'saved') return '<span class="ist ok">Saved ✓ — applies at the next run</span>';
  if (st === 'failed') {
    return html`<span class="ist bad">⚠️ Didn't save — ${l.error || 'no connection'}. Leaving this page discards it.</span>
      <button class="btn sm" type="button" data-insp-retry="${key}">Tap to retry</button>`;
  }
  return '<span class="ist">Saves as you go — each change is a proposal until the next run.</span>';
}
/** Repaint the save line and the Done button in place — a render would take the keyboard away. */
function paintStatus(key) {
  const el = $('#insp-status');
  if (el && el.dataset && el.dataset.key === key) {
    el.innerHTML = inspStatusHtml(key);
    const l = sheetLocal.get(key);
    el.className = `insp-status${l && l.status === 'failed' ? ' is-bad' : ''}`;
  }
  const arg = inspArg();
  if (!arg) return;
  const c = sheetCtx(arg);
  if (c.key !== key || !c.sheet) return;
  const btn = document.querySelector('[data-sheet="insp-done"]');
  if (btn) btn.disabled = !doneReady(c.sheet);
  const hint = $('#insp-hours-hint');
  if (hint) hint.hidden = doneReady(c.sheet);
}

/**
 * One change to the sheet on screen. `fn(local, sheet)` writes the new section
 * value into local.edits (whole sections — a SAVE replaces the section); the
 * named sections go dirty and a save follows.
 */
function editSheet(fn, sections, { now = false, redraw = true } = {}) {
  const arg = inspArg();
  if (arg == null) return;
  const c = sheetCtx(arg);
  if (!c.editable || !c.sheet) return;
  const l = localFor(c.key);
  fn(l, c.sheet);
  for (const k of sections) l.dirty.add(k);
  l.status = 'dirty';
  if (redraw) render(); else paintStatus(c.key);
  if (now) flushSheet(c.key); else scheduleFlush(c.key);
}
function scheduleFlush(key) {
  const l = localFor(key);
  clearTimeout(l.timer);
  l.timer = setTimeout(() => { flushSheet(key); }, FLUSH_MS);
  if (l.timer && typeof l.timer === 'object' && l.timer.unref) l.timer.unref();
}
/** Saves run one at a time per sheet, so two quick blurs can't fold the same OPEN twice. */
function flushSheet(key) {
  const l = localFor(key);
  l.chain = l.chain.then(() => doFlush(key)).catch(() => {});
  return l.chain;
}
function flushAllSheets() {
  for (const [key, l] of sheetLocal) if (l.dirty.size) flushSheet(key);
}

async function doFlush(key) {
  const l = sheetLocal.get(key);
  if (!l || !l.dirty.size) return;
  clearTimeout(l.timer);
  l.timer = null;
  const c = sheetCtx(argForKey(key));
  if (c.redirect) { migrateNew(key, c.redirect); await doFlush(c.redirect); return; }
  if (!c.editable || !c.sheet) {
    l.status = 'failed';
    l.error = c.locked ? 'the sheet is marked done — undo that first' : 'this sheet is no longer open here — reload';
    paintStatus(key);
    return;
  }
  const secs = [...l.dirty];
  l.dirty.clear();
  l.status = 'saving';
  l.error = null;
  paintStatus(key);
  try {
    if (c.isNew) await foldIntoOpen(c, secs);
    else await saveSections(c, secs);
    l.status = l.dirty.size ? 'dirty' : 'saved';
  } catch (err) {
    for (const k of secs) l.dirty.add(k);
    l.status = 'failed';
    l.error = err && err.message ? err.message : 'no connection';
  }
  paintStatus(key);
  renderHeader();
}

const sectionsIn = (e) => SECTION_KEYS.filter((k) => k in pl(e));

/** A numbered sheet: one SAVE per dirty section, then take back my older unapplied save of that same section. */
async function saveSections(c, secs) {
  // Library order, not tap order: the battery lands before the cells it legalises.
  for (const k of SECTION_KEYS.filter((x) => secs.includes(x))) {
    if (!SECTION_KEYS.includes(k)) continue;
    if (k === 'items' && !c.lib) continue;          // no library, no way to know which answers are on the sheet
    const stored = await postEvent(ctx(), 'inspection', null, { action: 'SAVE', inspection: c.id, [k]: sectionValue(c.sheet, k, c.lib) });
    state.pending.push(stored);
    const older = state.pending.filter((e) => e.id !== stored.id && e.action === 'inspection' && e.actor === meName()
      && pl(e).action === 'SAVE' && pl(e).inspection === c.id && sectionsIn(e).length === 1 && sectionsIn(e)[0] === k);
    for (const e of older) {
      try {
        await deleteEvent(ctx(), e.id);
        state.pending = state.pending.filter((x) => x.id !== e.id);
      } catch (err) {
        // Drained already, or no signal: the newer save lands after it either way.
        if (err && err.status === 404) state.pending = state.pending.filter((x) => x.id !== e.id);
      }
    }
  }
}

/**
 * A NEW sheet: re-issue the pending OPEN with every section typed so far, then
 * take back the older OPEN(s). If the engine drained the old one between the
 * two calls (a 404 on the take-back), the sheet is being numbered right now:
 * the fresh OPEN would only be refused, so it is taken back too and the tech
 * is told to finish on the numbered sheet.
 */
async function foldIntoOpen(c, secs) {
  const mine = mineOnly(pendingOpensFor(state.pending, c.serial)).sort(byTs);
  const base = mine[mine.length - 1];
  if (!base) throw new Error('this new sheet is no longer pending — reload the page');
  const payload = { ...pl(base), action: 'OPEN' };
  if (c.sheet.kind) payload.kind = c.sheet.kind;
  const keys = new Set([...SECTION_KEYS.filter((k) => k in payload), ...secs.filter((k) => SECTION_KEYS.includes(k))]);
  if (!c.lib) keys.delete('items');
  for (const k of SECTION_KEYS) if (keys.has(k)) payload[k] = sectionValue(c.sheet, k, c.lib);
  const stored = await postEvent(ctx(), 'inspection', c.serial, payload);
  state.pending.push(stored);
  let raced = false;
  for (const e of mine) {
    try {
      await deleteEvent(ctx(), e.id);
      state.pending = state.pending.filter((x) => x.id !== e.id);
    } catch (err) {
      if (err && err.status === 404) { raced = true; state.pending = state.pending.filter((x) => x.id !== e.id); } else throw err;
    }
  }
  if (raced) {
    try { await deleteEvent(ctx(), stored.id); } catch (_) { /* refused by the engine anyway */ }
    state.pending = state.pending.filter((x) => x.id !== stored.id);
    throw new Error('the engine picked this sheet up mid-save. Reload after the next publish, open the numbered sheet and re-enter your last change');
  }
}

/** A typed field on the sheet. `committed` = the change event (blur / pick) — save now. */
function onInspField(el, committed) {
  const f = el.dataset.ifield;
  const v = String(el.value == null ? '' : el.value);
  const isSelect = String(el.tagName || '').toUpperCase() === 'SELECT';
  if (isSelect && !committed) return;              // a select acts on change
  const bad = (on) => { if (el.classList) el.classList[on ? 'add' : 'remove']('bad'); };
  const soon = { redraw: false, now: committed };

  if (f === 'kind') { editSheet((l) => { l.edits.kind = v || null; }, ['kind'], { now: true }); return; }
  if (f === 'machine_class' || f === 'body_style') {
    // "Answers already given are kept" (§4.2): the page holds every answer, so
    // flipping back brings them back. The vault gets the rows this machine sees.
    editSheet((l, sh) => { l.edits[f] = v || null; if (!l.edits.items) l.edits.items = new Map(sh.items); }, [f, 'items'], { now: true });
    return;
  }
  if (f.startsWith('battery.')) {
    const part = f.slice(8);
    editSheet((l, sh) => {
      const b = { ...sh.battery };
      if (part === 'type') { b.type = v || null; if (b.type !== 'WET') b.pack = null; }
      if (part === 'voltage') { b.voltage = v ? Number(v) : null; if (!(PACKS_BY_VOLTAGE[b.voltage] || []).includes(b.pack)) b.pack = null; }
      if (part === 'pack') b.pack = v || null;
      l.edits.battery = b;
      // Off a WET pack the engine drops the cells; the page keeps them, so a
      // mis-tap on the type dropdown doesn't cost twelve hydrometer readings.
      if (!l.edits.items) l.edits.items = new Map(sh.items);
      if (!l.edits.cells) l.edits.cells = new Map(sh.cells);
    }, ['battery', 'items', 'cells'], { now: true });
    return;
  }
  if (f.startsWith('readings.')) {
    const k = f.slice(9);
    const d = READINGS.find((x) => x.key === k);
    let n = v.trim() === '' ? null : Number(v);
    if (n != null && d && d.pct && isFinite(n)) n = Math.round(n);     // a percent is a whole number
    if (n != null && (!isFinite(n) || n < 0 || (d && n > d.max))) { bad(true); return; }
    bad(false);
    editSheet((l, sh) => { l.edits.readings = { ...sh.readings, [k]: n }; }, ['readings'], soon);
    return;
  }
  if (f.startsWith('cell:')) {
    const [, k, which] = f.split(':');
    let val = v || null;
    if (which === 'sg') {
      val = parseSg(v);
      if (Number.isNaN(val)) { bad(true); return; }
      bad(false);
    }
    editSheet((l, sh) => {
      const cells = new Map(sh.cells);
      cells.set(k, { sg: null, clarity: null, level: null, ...(cells.get(k) || {}), [which]: val });
      l.edits.cells = cells;
    }, ['cells'], { redraw: false, now: committed });
    return;
  }
  if (f.startsWith('note:')) {
    const id = f.slice(5);
    editSheet((l, sh) => {
      const items = new Map(sh.items);
      items.set(id, { result: null, ...(items.get(id) || {}), note: v.slice(0, MAX_ITEM_NOTE) || null });
      l.edits.items = items;
    }, ['items'], soon);
    return;
  }
  if (f === 'comments') editSheet((l) => { l.edits.comments = v.slice(0, MAX_COMMENTS) || null; }, ['comments'], soon);
}

/* ============================================================== dispatch == */

function viewDispatch(highlight) {
  // D52: `#/dispatch/map` selects the map so a run report can link straight to
  // it. Dispatch ids all look like "m-…", so "map" can never be one — but the
  // check is explicit rather than relying on that.
  if (highlight === 'map' || (highlight == null && ui.dispatchView === 'map')) {
    // A deep link sets the tab's view for THIS session but is not written to
    // storage: following somebody's map link should not silently re-default a
    // dispatcher who works off the list. Tapping the control does persist.
    ui.dispatchView = 'map';
    return viewDispatchMap();
  }

  const all = dispatchRows();
  const s = dispatchSections(all);
  const adds = pendingDispatchAdds();
  const unbooked = unbookedPickups(pickupsList(), all);

  const head = html`<h1>Dispatch</h1>${raw(msgBlock())}${raw(dispatchSwitch('list'))}
    <div class="actions"><button class="btn" type="button" data-sheet="add-run">+ Add a run</button></div>
    ${sheetOpen('add-run') ? raw(addRunForm((ui.form && ui.form.arg) || {})) : ''}
    ${adds.length ? raw(html`<div class="note"><strong>⏳ ${adds.length} new run${adds.length > 1 ? 's' : ''} pending</strong>
      ${raw(adds.map((e) => html`<div class="pend-row"><span>${pl(e).kind === 'DELIVER' ? 'Deliver' : 'Pick up'} — ${pl(e).what || ''}${pl(e).customer ? ` · ${pl(e).customer}` : ''}</span>${raw(undoControl(e))}</div>`).join(''))}
      <div style="margin-top:6px">On the board after the next run.</div></div>`) : ''}`;

  if (!all.length && !adds.length && !unbooked.length) {
    return head + emptyState('Nothing to move.', 'Pick-ups, service runs and deliveries land here.');
  }

  const openSec = html`
    <h2>Open${s.open.length ? raw(html` <span class="count">${s.open.length}</span>`) : ''}</h2>
    <div class="card dlist">
      ${s.open.length ? raw(s.open.map((r) => dispatchRow(r, { highlight })).join('')) : raw('<div class="hold-empty">Nothing unclaimed.</div>')}
    </div>`;

  // Only ever non-empty when a released unit has no run yet. Loud, because the
  // alternative is a machine sitting on a customer's dock with nobody assigned.
  const gapSec = unbooked.length ? html`
    <h2 class="danger">Released, not on the board${raw(html` <span class="count">${unbooked.length}</span>`)}</h2>
    <div class="card dlist danger">
      ${raw(unbooked.map((p) => html`
        <div class="drow">
          <div class="drow-top"><span class="chip pickup">PICKUP</span>
            <span class="drow-what"><a href="#/unit/${raw(enc(p.serial))}">#${p.serial} ${p.model || ''}</a></span></div>
          <div class="drow-who">${p.customer || '—'}${p.job_site ? raw(html` · ${p.job_site}`) : ''}</div>
          <div class="drow-meta">${p.billed_through ? raw(html`billed through ${fmtDateFull(p.billed_through)}`) : ''}${p.note ? raw(html`${p.billed_through ? ' · ' : ''}${p.note}`) : ''}</div>
          <div class="drow-btns"><button class="btn sm ghost" type="button" data-sheet="add-run" data-serial="${p.serial}">Add the run</button></div>
        </div>`).join(''))}
    </div>` : '';

  const schedSec = html`
    <h2>Scheduled${s.scheduledCount ? raw(html` <span class="count">${s.scheduledCount}</span>`) : ''}</h2>
    ${s.scheduledCount ? raw(s.scheduled.map((g) => html`
      <div class="daygroup"><div class="dayhead">${g.date ? fmtDateFull(g.date) : 'No date'}</div>
      <div class="card dlist">${raw(g.rows.map((r) => dispatchRow(r, { highlight })).join(''))}</div></div>`).join(''))
      : raw('<div class="card dlist"><div class="hold-empty">Nothing on a truck yet.</div></div>')}`;

  const doneSec = html`
    <h2><button type="button" class="disclose" data-done-toggle="1" aria-expanded="${ui.showDone ? 'true' : 'false'}">
      ${ui.showDone ? '▾' : '▸'} Done this week${s.done.length ? raw(html` <span class="count">${s.done.length}</span>`) : ''}</button></h2>
    ${ui.showDone ? raw(html`<div class="card dlist">
      ${s.done.length ? raw(s.done.map((r) => dispatchRow(r, { highlight })).join('')) : raw('<div class="hold-empty">Nothing finished this week.</div>')}
    </div>`) : ''}`;

  return head + openSec + gapSec + schedSec + doneSec;
}

/* ================================================ the map (D52) =========== */

/**
 * Fetch the vendored map ONCE and read its projection contract off the root.
 *
 * The four constants (`data-lat0/lng0/kx/ky`) live on the asset because the
 * vault generates the asset — a different projection ships as a different file,
 * and a hardcoded constant here would put every pin in the wrong place with no
 * error to notice. So: parse the root tag, build the projector, and if any of
 * it is missing refuse to draw rather than draw a lie.
 */
async function loadMap() {
  if (mapSvgState === 'loading' || mapSvgState === 'ready') return;
  mapSvgState = 'loading';
  try {
    const res = await fetch('wi-map.svg', { cache: 'force-cache' });
    if (!res.ok) throw new Error(`map ${res.status}`);
    const text = await res.text();
    const root = /<svg\b[^>]*>/i.exec(text);
    if (!root) throw new Error('no <svg> root');

    const attrs = new Map();
    for (const m of root[0].matchAll(/([a-zA-Z0-9-]+)\s*=\s*"([^"]*)"/g)) attrs.set(m[1], m[2]);
    const project = projector(attrs);
    if (!project) throw new Error('the map is missing its projection constants');

    const vb = String(attrs.get('viewBox') || '').trim().split(/\s+/).map(Number);
    if (vb.length !== 4 || vb.some((n) => !isFinite(n))) throw new Error('no viewBox');

    mapSvg = text.slice(root.index + root[0].length).replace(/<\/svg>\s*$/i, '');
    mapProject = project;
    mapOuter = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
    mapSvgState = 'ready';
  } catch (err) {
    mapSvgState = 'error';
    console.warn('[wss-fleet] map:', err.message);
  }
  render();
}

/** The opening window: meta.geo.default_view, or the whole state if it is absent. */
function mapDefaultView(g) {
  const wanted = g && g.default_view ? boxToViewBox(g.default_view, mapProject) : null;
  return clampViewBox(wanted || mapOuter, mapOuter);
}

/**
 * Pin sizes are in SVG user units, so they grow as you zoom in — which would
 * turn a 7-unit dot into a dinner plate. Counter-scaling by the viewBox width
 * keeps every pin and label the same size ON SCREEN at any zoom, which is the
 * only size that matters to the person holding the phone.
 */
const MAP_ZOOM_MIN_SPAN = 40;              // ~25 km across: tight enough for one industrial park

/**
 * Chips disappear above 1.6x the opening view — i.e. only when you have zoomed
 * out past the region and are looking at the whole state, where the pills would
 * overlap into a grey smear. Anywhere at or tighter than the default view, every
 * pin shows its ID; that is the point of D53.
 */
const CHIP_HIDE_FACTOR = 1.6;
const chipHideSpan = () => (mapHome ? mapHome.w : (mapOuter ? mapOuter.w : 370)) * CHIP_HIDE_FACTOR;

/**
 * The map box is sized to the OPENING VIEW's shape, not the whole state's —
 * D52 sized it square-ish and left a band of empty map under Wisconsin on every
 * phone.
 *
 * The ratio is deliberately a little WIDER than the view itself — see
 * EDGE_LABEL_ALLOWANCE in docs/map.js for why (the asset's eastern city labels
 * run past `default_view`'s east edge, and a box matched exactly to the view
 * slices the tail off "Milwaukee").
 *
 * The allowance itself lives in docs/map.js so tools/selftest-map.mjs can hold
 * it to account against the asset's real label geometry.
 */
const mapBoxRatio = () => {
  const v = mapHome || mapOuter;
  if (!v || !(v.h > 0)) return '4 / 3';
  return `${(v.w * EDGE_LABEL_ALLOWANCE).toFixed(2)} / ${v.h.toFixed(2)}`;
};

/**
 * Markers are drawn in SVG user units, so they grow as you zoom in — a 22 px
 * teardrop would become a dinner plate. Counter-scaling by the viewBox width
 * holds every pin, chip and badge at one size ON SCREEN, which is the only size
 * the person holding the phone experiences.
 */
const pinScale = () => {
  const base = mapHome ? mapHome.w : (mapOuter ? mapOuter.w : 350);
  return Math.max(0.35, Math.min(2.6, (mapView ? mapView.w : base) / base));
};

/**
 * A teardrop whose TIP sits on the coordinate (0,0) and whose head is above it,
 * so the marker points at the place rather than covering it. ~22 units tall,
 * which is ~22 px at the opening zoom after counter-scaling.
 *
 * A demo lead keeps its own glyph — a triangle inside the head instead of the
 * usual dot — because a demo is the one lead with a truck and a date already
 * attached to it, and that is worth seeing without tapping.
 */
const TEARDROP = 'M0,0 C-3.4,-6.2 -8,-8.6 -8,-13.6 A8,8 0 1 1 8,-13.6 C8,-8.6 3.4,-6.2 0,0 Z';
const PIN_HEAD_Y = -13.6;

function pinShape(kind, demo) {
  const eye = demo
    ? `<path class="eye" d="M0,${PIN_HEAD_Y - 3.4} L3,${PIN_HEAD_Y + 2.2} L-3,${PIN_HEAD_Y + 2.2} Z"/>`
    : `<circle class="eye" cy="${PIN_HEAD_Y}" r="3"/>`;
  return `<path class="pg" d="${TEARDROP}"/>${eye}`;
}

/**
 * The ID chip: a white pill just right of the pin head carrying the ticket
 * number, lead id or serial in the kind's colour.
 *
 * Width is estimated from the character count rather than measured — measuring
 * needs a laid-out DOM and this markup is built as a string like every other
 * view in this app. 5.4 units per character at 9px is a shade generous for a
 * bold sans, which is the right way to be wrong: a pill slightly too wide looks
 * deliberate, one too narrow clips the text it exists to show.
 */
function pinChip(text) {
  const t = String(text == null ? '' : text);
  if (!t) return '';
  const w = Math.max(18, t.length * 5.4 + 8);
  const h = 13;
  const x = 9;
  const y = PIN_HEAD_Y - h / 2;
  return `<g class="chip"><rect class="chip-bg" x="${x}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}"/>` +
    `<text class="chip-tx" x="${(x + w / 2).toFixed(1)}" y="${PIN_HEAD_Y + 0.4}" text-anchor="middle">${esc(t)}</text></g>`;
}

/** The Dispatch map. Chips, the surface, the stop strip, the off-map list. */
function viewDispatchMap() {
  const g = geoMeta(state.snapshot);
  const head = html`<h1>Dispatch</h1>${raw(msgBlock())}${raw(dispatchSwitch('map'))}`;

  if (!g) {
    return head + emptyState('No map in this snapshot.',
      'The engine has not sent geo data yet — the List view has everything.');
  }
  if (mapSvgState === 'error') {
    return head + emptyState('The map did not load.', 'Pull to refresh, or use the List view.');
  }
  if (mapSvgState !== 'ready') return head + '<div class="loading">Loading the map…</div>';

  const { pins, off } = collect(state.snapshot);
  const on = ui.mapKinds;
  const shown = pins.filter((p) => on.has(p.kind));
  const stacks = stack(shown);
  const offShown = off.filter((r) => on.has(r.kind));

  if (!mapHome) mapHome = mapDefaultView(g);
  if (!mapView) mapView = mapHome;

  const counts = {};
  for (const k of MAP_KINDS) counts[k] = pins.filter((p) => p.kind === k).length;

  const chips = MAP_KINDS.map((k) => html`
    <button type="button" class="fchip${on.has(k) ? ' on' : ''} mk-${k}" data-mapkind="${k}"
      aria-pressed="${on.has(k) ? 'true' : 'false'}">${MAP_KIND_LABEL[k]}<span class="c">${counts[k]}</span></button>`).join('');

  const stops = ui.mapStops.map((key) => stacks.find((st) => st.key === key)).filter(Boolean);

  return html`
    ${raw(head)}
    <div class="mapchips">${raw(chips)}</div>
    <div class="mapwrap">
      ${raw(mapSurface(g, stacks))}
      <div class="mapbtns">
        <button class="mapbtn" type="button" data-map="home" title="Back to the usual view" aria-label="Default view">⌂</button>
        <button class="mapbtn" type="button" data-map="fit" title="Fit the whole state" aria-label="Whole state">⤢</button>
      </div>
    </div>
    ${raw(mapLegend())}
    ${raw(planStrip(stops, g))}
    ${ui.mapSheet ? raw(stackSheet(stacks.find((st) => st.key === ui.mapSheet), g)) : ''}
    ${raw(offMapList(offShown))}`;
}

/**
 * The SVG, inline.
 *
 * Inline and not an <img>, because pins have to be real children of the same
 * document: an <img> would isolate them, and the CSS variables that repaint the
 * counties to match the app palette would never reach it.
 *
 * The whole thing is a string, like every other view here — the map's own
 * markup with our root tag and our pins spliced in. Pan and zoom then mutate
 * the live viewBox attribute in place, so a gesture never costs a re-render.
 */
function mapSurface(g, stacks) {
  const scale = pinScale();
  const far = mapView.w > chipHideSpan();
  const stopIndex = new Map(ui.mapStops.map((k, i) => [k, i + 1]));

  // The shop is always drawn, never filterable, and keeps the brand red — it is
  // the one marker on this map that is not a job.
  const shop = g.shop ? (() => {
    const p = mapProject(g.shop.lat, g.shop.lng);
    return html`<g class="pin shop" data-x="${p.x}" data-y="${p.y}" transform="translate(${p.x},${p.y}) scale(${scale})">
      <path class="pg" d="M0,0 C-3.4,-6.2 -8,-8.6 -8,-13.6 A8,8 0 1 1 8,-13.6 C8,-8.6 3.4,-6.2 0,0 Z"/>
      <path class="house" d="M0,-18.6 L5.6,-13.6 L3.8,-13.6 L3.8,-8.6 L-3.8,-8.6 L-3.8,-13.6 L-5.6,-13.6 Z"/>
      ${raw(pinChip('WSS'))}
    </g>`;
  })() : '';

  const pins = stacks.map((st) => {
    const p = mapProject(st.lat, st.lng);
    const kind = stackKind(st);
    const first = st.rows[0];
    const n = st.rows.length;
    const stop = stopIndex.get(st.key);
    // A stack draws ONE marker with a count on its head, and its chip names the
    // first row plus how many more — never five pills fighting over one point.
    return html`<g class="pin k-${kind}${ui.mapSheet === st.key ? ' on' : ''}${stop ? ' stop' : ''}"
        data-stack="${st.key}" data-x="${p.x}" data-y="${p.y}" transform="translate(${p.x},${p.y}) scale(${scale})"
        role="button" tabindex="0" aria-label="${n > 1 ? `${n} at this address` : `${first.label} ${first.customer || ''}`}">
      ${raw(pinShape(kind, !!first.demo))}
      ${n > 1 ? raw(html`<g class="badge"><circle cx="0" cy="${raw(String(PIN_HEAD_Y))}" r="5.4"/><text x="0" y="${raw(String(PIN_HEAD_Y + 2.6))}">${n}</text></g>`) : ''}
      ${stop ? raw(html`<g class="stopbadge"><circle cx="-8.5" cy="-20" r="6.5"/><text x="-8.5" y="-17.4">${stop}</text></g>`) : ''}
      ${raw(pinChip(n > 1 ? `${first.label} +${n - 1}` : first.label))}
    </g>`;
  }).join('');

  return html`<svg id="wimap" class="wimap${far ? ' far' : ''}${ui.mapPlan ? ' planning' : ''}"
      style="aspect-ratio: ${raw(mapBoxRatio())}"
      viewBox="${raw(viewBoxStr(mapView))}" role="img" aria-label="Wisconsin — dispatch map" data-scale="${scale}">
    ${raw(mapSvg)}
    <g id="pins">${raw(pins)}${raw(shop)}</g>
  </svg>`;
}

function mapLegend() {
  // Kind swatches and the shop, and nothing else. The solid/hollow sentence went
  // with the hollow marker (D53) — precision is a line in the tap sheet now.
  const sw = MAP_KINDS.map((k) => html`<span class="lg mk-${k}"><i class="sw k-${k}"></i>${MAP_KIND_LABEL[k]}</span>`).join('');
  return html`<div class="maplegend">
    ${raw(sw)}<span class="lg"><i class="sw shop"></i>WSS</span>
  </div>`;
}

/**
 * "Plan a run" — a stop list that exists only in a URL.
 *
 * Nothing here is written anywhere: no event, no snapshot field, no storage.
 * The route is handed to the driver's phone as a Google Maps link and that is
 * the end of it. (Assigning a planned run to a rig WOULD be a dispatch event,
 * and is deliberately not in D52.)
 */
function planStrip(stops, g) {
  const toggle = html`<button class="btn sm${ui.mapPlan ? '' : ' ghost'}" type="button" data-map="plan">
    ${ui.mapPlan ? '✓ Planning a run' : 'Plan a run'}</button>`;
  if (!ui.mapPlan) return html`<div class="planbar">${raw(toggle)}</div>`;

  const url = g.shop ? routeUrl(g.shop, stops.map((st) => ({ lat: st.lat, lng: st.lng })), ui.mapBackToShop) : null;
  const full = stops.length >= MAX_STOPS;

  return html`
    <div class="planbar">
      ${raw(toggle)}
      ${stops.length ? raw(html`<button class="btn sm ghost" type="button" data-map="clear">Clear</button>`) : ''}
    </div>
    <div class="card planlist">
      ${stops.length ? raw(stops.map((st, i) => html`
        <div class="prow">
          <span class="pnum">${i + 1}</span>
          <span class="pwhat">${st.rows[0].customer || st.rows[0].label}${st.rows.length > 1 ? raw(html` <span class="muted">+${st.rows.length - 1}</span>`) : ''}</span>
          <span class="paddr">${st.rows[0].address || ''}</span>
          <button class="btn sm ghost" type="button" data-map="drop" data-key="${st.key}">Remove</button>
        </div>`).join('')) : raw('<div class="hold-empty">Tap pins to add stops. They go in the order you tap them.</div>')}
      ${full ? raw('<div class="form-note">Nine stops is the most a directions link can carry.</div>') : ''}
      <label class="chk"><input type="checkbox" data-map="back"${ui.mapBackToShop ? ' checked' : ''}> Back to the shop at the end</label>
      <div class="actions row">
        ${url ? raw(html`<a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">Open route (${stops.length})</a>`)
              : raw('<button class="btn" type="button" disabled>Open route</button>')}
      </div>
      <div class="form-note">Opens Google Maps. Nothing is saved — the run lives in the link.</div>
    </div>`;
}

/** Tap a pin: everything at that address, and the two ways out of it. */
function stackSheet(st, g) {
  if (!st) return '';
  const first = st.rows[0];
  const nav = navUrl(st.lat, st.lng);
  const planned = ui.mapStops.includes(st.key);
  // D53: precision is said in words, here, instead of being drawn as a shape.
  // Rooftop says nothing — it is the normal case and needs no apology.
  const prec = precisionNote(st.precision, g.precision_legend);
  return html`
    <div class="sheet mapsheet">
      <div class="sheet-h">${first.customer || first.label}${st.rows.length > 1 ? raw(html` <span class="count">${st.rows.length}</span>`) : ''}</div>
      <div class="sheet-addr">${first.address || 'No address on file'}</div>
      ${prec ? raw(html`<div class="sheet-prec"><strong>${prec.lead}</strong> — ${prec.rest}</div>`) : ''}
      <div class="card dlist">
        ${raw(st.rows.map((r) => html`
          <div class="srow">
            <span class="chip mk-${r.kind}">${MAP_KIND_LABEL[r.kind]}</span>
            <span class="sid">${r.label}</span>
            <span class="sline">${r.line}</span>
            <a class="btn sm ghost" href="${r.href}">Open</a>
          </div>`).join(''))}
      </div>
      <div class="actions row">
        ${nav ? raw(html`<a class="btn" href="${nav}" target="_blank" rel="noopener noreferrer">Navigate</a>`) : ''}
        ${ui.mapPlan ? raw(html`<button class="btn ghost" type="button" data-map="${planned ? 'drop' : 'add'}" data-key="${st.key}">
          ${planned ? 'Remove from run' : 'Add to run'}</button>`) : ''}
        <button class="btn ghost" type="button" data-map="close">Close</button>
      </div>
    </div>`;
}

/**
 * Off the map — the rows that wanted a pin and could not have one.
 *
 * This is not an error list, it is a WORK list: every line is an address the
 * vault needs fixed, or a customer who is genuinely out of state. Hiding them
 * would make the map quietly lie about how much work it is showing.
 */
function offMapList(rows) {
  if (!rows.length) return '';
  const groups = groupOff(rows);
  return html`
    <h2>Off the map <span class="count">${rows.length}</span></h2>
    <div class="card dlist offmap">
      <div class="form-note">No usable address — fix these in the vault and they appear next run.</div>
      ${raw(groups.map((grp) => html`
        <div class="offgrp"><div class="offhead">${grp.label}</div>
          ${raw(grp.rows.map((r) => html`
            <div class="srow">
              <span class="sid">${r.label}</span>
              <span class="sline">${r.customer || r.line}</span>
              <span class="paddr">${r.address || '(no address)'}</span>
              <a class="btn sm ghost" href="${r.href}">Open</a>
            </div>`).join(''))}
        </div>`).join(''))}
    </div>`;
}

/** List | Map. The List view below it is untouched by D52. */
function dispatchSwitch(nowShowing) {
  const tab = (v, label) => html`<button type="button" class="seg${nowShowing === v ? ' on' : ''}"
    data-dview="${v}" aria-pressed="${nowShowing === v ? 'true' : 'false'}">${label}</button>`;
  return html`<div class="segbar">${raw(tab('list', 'List'))}${raw(tab('map', 'Map'))}</div>`;
}

const KIND_LABEL = { PICKUP: 'PICKUP', DELIVER: 'DELIVER' };

/**
 * One run. `compact` (unit page, ticket detail) drops the buttons and links out
 * to the board instead — one place owns the actions.
 * Addresses are tap-to-copy on purpose: no map links (this supersedes the
 * earlier pick-ups order's tap-to-map line).
 */
function dispatchRow(r, opts = {}) {
  const pend = pendingForDispatch(r.id);
  const compact = !!opts.compact;
  const mine = opts.highlight && opts.highlight === r.id;
  const claim = sheetOpen('claim', r.id);
  const done = sheetOpen('done', r.id);

  const btns = [];
  if (!compact && r.status === 'OPEN') btns.push(html`<button class="btn sm" type="button" data-sheet="claim" data-id="${r.id}">Claim</button>`);
  if (!compact && r.status === 'SCHEDULED') {
    btns.push(html`<button class="btn sm" type="button" data-sheet="done" data-id="${r.id}">Done</button>`);
    btns.push(html`<button class="btn sm ghost" type="button" data-sheet="claim" data-id="${r.id}">Reassign</button>`);
  }
  if (!compact && r.status !== 'DONE' && canCancel(r, role())) {
    btns.push(html`<button class="btn sm ghost danger-btn" type="button" data-cancel="${r.id}">Cancel</button>`);
  }

  return html`
    <div class="drow${r.status === 'DONE' ? ' is-done' : ''}${mine ? ' hot' : ''}" id="d-${r.id}">
      <div class="drow-top">
        ${raw(chip(KIND_LABEL[r.kind] || r.kind, r.kind === 'PICKUP' ? 'pickup' : 'rent'))}
        ${r.source === 'RENTAL-DELIVER' ? raw(chip('Rental delivery', 'rent')) : ''}
        <span class="drow-what">${r.what || '—'}</span>
        <span class="drow-src" title="${r.source}">${SOURCE_GLYPH[r.source] || ''}</span>
      </div>
      ${r.customer ? raw(html`<div class="drow-who">${r.customer}</div>`) : ''}
      ${r.address ? raw(html`<button type="button" class="addr" data-copy="${r.address}" title="Tap to copy">${r.address}</button>`) : ''}
      <div class="drow-meta">
        <span class="when">${r.date && isDateStr(r.date) ? fmtDateFull(r.date) : 'any time'}</span>
        ${r.billed_through ? raw(html` · billed through ${fmtDateFull(r.billed_through)}`) : ''}
        ${r.serial ? raw(html` · <a href="#/unit/${raw(enc(r.serial))}">#${r.serial}</a>`) : ''}
        ${r.ticket ? raw(html` · <a href="#/ticket/${raw(enc(r.ticket))}">${r.ticket}</a>`) : ''}
        ${r.agreement != null ? raw(html` · <a class="chip agmt" href="${agreementHref(r.agreement)}">${r.agreement}</a>`) : ''}
      </div>
      ${r.rig || r.driver ? raw(html`<div class="chips">
        ${r.driver ? raw(chip(r.driver, 'driver')) : ''}${r.rig ? raw(chip(r.rig, 'rig')) : ''}
        ${r.status === 'DONE' && r.done ? raw(chip(`done ${fmtDate(r.done)}`, 'ok')) : ''}</div>`) : ''}
      ${r.note ? raw(html`<div class="drow-note">${r.note}</div>`) : ''}
      ${raw(pendingLine(pend.length))}
      ${raw(pend.map(undoControl).join(''))}
      ${compact ? raw(html`<div class="drow-btns"><a class="btn sm ghost" href="#/dispatch/${raw(enc(r.id))}">On the board</a></div>`)
        : (btns.length ? raw(html`<div class="drow-btns">${raw(btns.join(''))}</div>`) : '')}
      ${claim ? raw(claimForm(r)) : ''}
      ${done ? raw(doneForm(r)) : ''}
    </div>`;
}

function claimForm(r) {
  const drivers = driverChoices(state.me);
  const date = r.date && isDateStr(r.date) ? r.date : todayCentral();
  return html`
    <form class="write sheet" data-action="dispatch_claim" data-id="${r.id}">
      <label>Who's driving</label>
      ${raw(toggle('driver', drivers.map((n) => [n, n]), r.driver && drivers.includes(r.driver) ? r.driver : defaultDriver(state.me)))}
      <label for="cf-rig">Rig</label>
      <select id="cf-rig" name="rig" required>
        ${raw(RIGS.map((x) => html`<option value="${x}"${x === r.rig ? raw(' selected') : ''}>${x}</option>`).join(''))}
      </select>
      <label for="cf-date">Day</label>
      <input id="cf-date" name="date" type="date" value="${date}" required>
      <div class="hint" data-hint="rig" hidden></div>
      ${raw(sheetButtons(r.status === 'SCHEDULED' ? 'Reassign' : 'Claim it'))}
      <div class="form-note">A proposal — the row stays where it is until the next run moves it.</div>
    </form>`;
}

function doneForm(r) {
  return html`
    <form class="write sheet" data-action="dispatch_done" data-id="${r.id}">
      ${r.source === 'RENTAL-RETURN' ? raw(html`<div class="note"><strong>Bringing it home</strong>This brings ${r.serial ? `#${r.serial}` : 'the unit'} home and ends the agreement at the next run.</div>`) : ''}
      ${r.source === 'RENTAL-DELIVER' ? raw(deliverDoneNote(r)) : ''}
      <label for="df-note">Note (optional)</label>
      <textarea id="df-note" name="note" placeholder="hours on the meter, damage, who signed"></textarea>
      ${raw(sheetButtons('Mark it done'))}
    </form>`;
}

/** D64: Done on a rental delivery IS the out. Say what the tap sets off. */
function deliverDoneNote(r) {
  const a = agreementForRow(r, agreements());
  const id = r.agreement != null ? r.agreement : (a ? a.agreement : null);
  const lead = a && a.lead ? a.lead : null;
  return html`<div class="note"><strong>Delivering it</strong>Marks ${id != null ? id : 'the rental'} on rent from today${lead ? ` and closes lead ${lead} as won` : ''}.</div>`;
}

/** + Add a run. Reached from Dispatch, a unit page, or a hold row (§4). */
function addRunForm(prefill = {}) {
  const p = { kind: 'DELIVER', serial: '', what: '', customer: '', address: '', ticket: null, ...prefill };
  return html`
    <form class="write sheet" data-action="dispatch_add"${p.ticket ? raw(html` data-ticket="${p.ticket}"`) : ''}>
      <label>What kind of run</label>
      ${raw(toggle('kind', KINDS.map((k) => [k, k === 'PICKUP' ? 'Pick something up' : 'Deliver something']), p.kind))}
      <label for="ar-what">What's moving</label>
      <input id="ar-what" name="what" required value="${p.what}" placeholder="unit, parts, whatever it is" autocomplete="off">
      <label for="ar-cust">Customer</label>
      <input id="ar-cust" name="customer" value="${p.customer}" autocomplete="off">
      <label for="ar-addr">Address</label>
      <input id="ar-addr" name="address" value="${p.address}" autocomplete="off">
      <label for="ar-date">Day (optional)</label>
      <input id="ar-date" name="date" type="date">
      <label for="ar-serial">Unit (optional)</label>
      <select id="ar-serial" name="serial"><option value="">— none —</option>${raw(unitOptions(p.serial))}</select>
      <label for="ar-note">Note</label>
      <textarea id="ar-note" name="note" placeholder="gate code, who to ask for"></textarea>
      ${raw(sheetButtons('Add the run'))}
      <div class="form-note">A proposal — it appears on the board after the next run.</div>
    </form>`;
}

/** Pre-fill for "Schedule delivery" from a unit page or a hold row. */
function runPrefillForUnit(u, hold) {
  const ag = u.agreement != null ? agreements().find((a) => a.agreement === u.agreement) : null;
  return {
    kind: u.readiness === 'NEEDS-PICKUP' ? 'PICKUP' : 'DELIVER',
    serial: u.serial,
    what: `${unitName(u)} #${u.serial}`,
    customer: (hold && hold.customer) || u.customer || (ag && ag.customer) || '',
    address: u.job_site || (ag && ag.job_site) || '',
  };
}

/* ---- holds view (v2): expired first and loud, then upcoming by date ---- */

function viewHolds() {
  const r = holdsRollup();
  const unitLink = (h) => html`<a href="#/unit/${raw(encodeURIComponent(h.serial))}"><span class="unit-serial">#${h.serial}</span>${h.model ? raw(html` ${h.model}`) : ''}</a>`;
  // A hold is a promise to put a machine somewhere on a day — so the row books
  // the truck for it (§4), pre-filled from the unit and the hold's customer.
  const row = (h, withPill) => html`
    <div class="hrow">
      <div class="hold-top"><span class="hold-win">${fmtRange(h.start, h.end)}</span>${withPill ? raw(holdPill(h)) : ''}</div>
      <div class="hold-who">${raw(unitLink(h))}</div>
      <div class="hold-meta">${h.customer || '—'}${h.purpose ? raw(html` · ${h.purpose}`) : ''} · held by ${h.held_by || '—'}</div>
      ${isAgmtHold(h)
        ? raw(html`<div class="hold-meta">Rental <a href="${agreementHref(agmtIdOf(h))}">${agmtIdOf(h)}</a> — clears itself on delivery</div>`)
        : raw(html`<button class="btn sm ghost" type="button" data-sheet="add-run" data-serial="${h.serial}" data-hold="${h.id || ''}">Schedule delivery</button>`)}
    </div>`;

  if (!r.expired.length && !r.upcoming.length) return html`<h1>Holds</h1>${raw(emptyState('Nothing on hold.'))}`;

  const expired = r.expired.length ? html`
    <h2 class="danger">Expired holds — release or extend</h2>
    <div class="card holds danger">${raw(r.expired.map((h) => row({ ...h, status: 'expired' }, true)).join(''))}</div>` : '';

  const groups = groupByDate(r.upcoming).map((g) => html`
    <h2>${g.date ? fmtDateFull(g.date) : 'Unknown date'}</h2>
    <div class="card holds">${raw(g.items.map((h) => row(h, true)).join(''))}</div>`);

  return html`<h1>Holds</h1>${raw(msgBlock())}
    <div class="sub">${r.upcoming.length} upcoming${r.expired.length ? raw(html` · <span class="none">${r.expired.length} expired</span>`) : ''}</div>
    ${sheetOpen('add-run') ? raw(addRunForm((ui.form && ui.form.arg) || {})) : ''}
    ${raw(expired)}${raw(groups.join(''))}`;
}

/* ============================================== leads (schema 5) ========== */

/**
 * The Leads tab. Top to bottom: scoreboard · insights · + New lead · chips ·
 * the five-column board · the closed strip.
 *
 * ONE RULE ABOVE THE REST: money here is ABSENT, not zero. The Worker deletes
 * `value`, `potential_commission`, `leads_summary.commission_rates` and
 * `scoreboard.money` before the response leaves the edge for a `service` token
 * (spec §6). So every money render below is guarded by hasMoney()/amount(), and
 * a guard that fails draws NOTHING — no "—", no "$0", no greyed placeholder.
 * A placeholder would tell Josh exactly where the number he can't see lives.
 */

const leadOpts = () => optionsFrom(leadsSummary());

/**
 * `quote.file` is a URL the engine put in the snapshot, and it becomes an
 * href. Escaping stops it breaking the attribute but not a `javascript:` or
 * `data:` scheme, so the scheme is checked here and a link is drawn only for
 * one we would follow ourselves. Anything else renders as no link at all.
 */
const httpUrl = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null);
const moneyVisible = () => hasMoney(state.snapshot);
const scoreOpen = () => (ui.showScore == null ? role() === 'sales' : ui.showScore);
const seesInsights = () => role() === 'owner' || role() === 'sales';

function viewLeads() {
  if (!hasLeads()) {
    return html`<h1>Leads</h1>${raw(emptyState('No leads in this snapshot.',
      'This board is running on an older snapshot — leads arrive with the next run.'))}`;
  }
  const all = leads();
  const opens = pendingLeadOpens();
  const filter = ui.leadFilter;
  const meName = (state.me && state.me.name) || null;
  const counts = chipCounts(all, meName);

  const chips = [['all', 'All'], ['mine', 'Mine'], ['stale', 'Stale']].map(([v, label]) =>
    html`<button type="button" class="fchip${filter === v ? ' on' : ''}" data-lead-filter="${v}">${label}<span class="c">${counts[v]}</span></button>`);

  const head = html`<h1>Leads</h1>${raw(msgBlock())}
    ${raw(scoreCard())}
    ${seesInsights() ? raw(insightsCard()) : ''}
    <div class="actions"><button class="btn" type="button" data-sheet="new-lead">+ New lead</button></div>
    ${sheetOpen('new-lead') ? raw(newLeadForm()) : ''}
    ${opens.length ? raw(html`<div class="note"><strong>⏳ ${opens.length} new lead${opens.length > 1 ? 's' : ''} pending</strong>
      ${raw(opens.map((e) => html`<div class="pend-row"><span>${pl(e).customer || '—'}${pl(e).machine ? ` · ${pl(e).machine}` : ''}</span>${raw(undoControl(e))}</div>`).join(''))}
      <div style="margin-top:6px">The engine assigns the lead number at the next run.</div></div>`) : ''}
    <div class="fchips" role="group" aria-label="Filter leads">${raw(chips.join(''))}</div>`;

  if (!all.length && !opens.length) {
    return head + emptyState('No leads yet.', 'Write one down above — it shows here as pending until the next run picks it up.');
  }

  const cols = boardColumns(all, { filter, me: state.me, summary: leadsSummary() }).map((c) => html`
    <section class="kan-col col-${raw(enc(c.key))}" id="lead-col-${raw(enc(c.key))}">
      <div class="kan-head"><span>${c.label}</span><span class="c">${c.count}</span></div>
      <div class="kan-body">${c.leads.length ? raw(c.leads.map(leadCard).join('')) : raw('<div class="kan-empty">nothing here</div>')}</div>
    </section>`);

  return html`${raw(head)}
    <div class="kan-wrap"><div class="kanban">${raw(cols.join(''))}</div></div>
    <div class="form-note">Swipe the columns sideways. Tap a card for the whole lead.</div>
    ${raw(closedStrip(filter, meName))}`;
}

/** LOST + DEAD, folded away. They linger 14 days so a post-mortem is possible. */
function closedStrip(filter, meName) {
  const rows = closedLeads(leads(), filter, meName);
  return html`
    <h2><button type="button" class="disclose" data-closed-toggle="1" aria-expanded="${ui.showClosedLeads ? 'true' : 'false'}">
      ${ui.showClosedLeads ? '▾' : '▸'} Closed${rows.length ? raw(html` <span class="count">${rows.length}</span>`) : ''}</button></h2>
    ${ui.showClosedLeads ? raw(html`<div class="card dlist">
      ${rows.length ? raw(rows.map((l) => html`
        <a class="drow lead-closed" href="#/lead/${raw(enc(l.lead))}">
          <div class="drow-top">
            ${raw(chip(LEAD_STATUS_LABEL[l.status] || l.status, l.status === 'LOST' ? 'bad' : 'out'))}
            <span class="drow-what">${l.customer || '—'}</span>
          </div>
          <div class="drow-meta">${l.machine || INTEREST_LABEL[l.interest] || '—'}${l.close_reason ? raw(html` · ${REASON_LABEL[l.close_reason] || l.close_reason}`) : ''}${l.closed ? raw(html` · ${fmtDateFull(l.closed)}`) : ''}</div>
          ${l.close_note ? raw(html`<div class="drow-note">${l.close_note}</div>`) : ''}
        </a>`).join('')) : raw('<div class="hold-empty">Nothing closed in the last 14 days.</div>')}
    </div>`) : ''}`;
}

/**
 * One card (§3.4). The money line is omitted wholesale when there is no money
 * to show — see the rule at the top of this section.
 */
function leadCard(l) {
  const pend = pendingForLead(l.lead);
  const v = amount(l.value);
  const c = amount(l.potential_commission);
  const stale = l.stale === 'red' ? '🔴' : l.stale === 'yellow' ? '🟡' : '';
  const money = v == null && c == null ? '' : html`<div class="lead-money">
    ${v != null ? fmtMoney(v) : ''}${v != null && c != null ? ' · ' : ''}${c != null ? raw(html`<span class="lead-comm">${fmtMoney(c)} potential</span>`) : ''}</div>`;
  return html`
    <a class="kan-card lead-card pri-${l.priority || 'MEDIUM'}${l.status !== 'OPEN' ? ' closed' : ''}" href="#/lead/${raw(enc(l.lead))}">
      <div class="kan-row">
        <span class="kan-t">${l.customer || '—'}</span>
        <span class="kan-age${l.stale ? ` stale-${l.stale}` : ''}">${stale}${l.age_in_stage_days != null ? `${l.age_in_stage_days}d` : ''}</span>
      </div>
      <div class="kan-eq">${l.machine || INTEREST_LABEL[l.interest] || '—'}</div>
      ${raw(money)}
      ${l.next_action ? raw(html`<div class="kan-issue">${l.next_action}</div>`) : ''}
      <div class="kan-foot">
        <span class="lead-src">${SOURCE_LABEL[l.source] || l.source || ''}</span>
        ${l.assigned ? raw(html`<span class="who" title="${l.assigned}">${String(l.assigned).slice(0, 1)}</span>`) : ''}
        ${l.suggest_dead ? raw('<span class="skull" title="nothing has moved — consider marking it dead">💀</span>') : ''}
        ${pend.length ? raw('<span class="kan-pend">⏳</span>') : ''}
      </div>
    </a>`;
}

/* ---- scoreboard (§3.1) ---- */

/**
 * Five rows, in the spec's order. Rows 1–2 are money and simply do not exist
 * for a `service` token — no placeholder, no explanation, because explaining
 * would itself be the disclosure.
 */
function scoreCard() {
  const sb = scoreboard();
  if (!sb) return '';
  const open = scoreOpen();
  const money = sb.money && typeof sb.money === 'object' ? sb.money : null;
  const base = (money && money.baseline) || {};

  const body = open ? html`
    ${money ? raw(sbOnTable(money)) : ''}
    ${money ? raw(sbCommitted(money)) : ''}
    ${money ? raw(sbThisMonth(sb, money, base)) : ''}
    ${raw(sbSpeed(sb.speed || {}))}
    ${raw(sbConversion(sb.conversion || {}))}
    ${raw(sbStale(sb.stale || {}))}` : '';

  return html`
    <section class="score" aria-label="Sales scoreboard">
      <button type="button" class="score-h" data-score-toggle="1" aria-expanded="${open ? 'true' : 'false'}">
        <span>${open ? '▾' : '▸'} Scoreboard</span>
        ${!open && sb.open && sb.open.count != null ? raw(html`<span class="c">${sb.open.count} open</span>`) : ''}
      </button>
      ${raw(body)}
    </section>`;
}

/** Never "commission" alone: it is paid on cash received, not on a handshake. */
function sbOnTable(money) {
  const v = amount(money.on_table_value);
  const c = amount(money.on_table_commission);
  return html`
    <div class="sb-row">
      <div class="sb-l">On the table</div>
      <div class="sb-v">
        <strong>${v == null ? NO_DATA : fmtMoney(v)}</strong>
        ${c != null ? raw(html`<span class="sb-sub">${fmtMoney(c)} potential commission</span>`) : ''}
      </div>
    </div>`;
}

/**
 * "Committed" (D55) — PO in hand, order with the factory, waiting on a serial.
 *
 * It sits directly under "On the table" and is a SUBSET of it, not a sibling:
 * a dollar on an open card is on the table (Matt, 9/4), and a PO does not stop
 * that being true. What it adds is which part of that number is already won
 * and only waiting on the factory — the thing the board could not say before,
 * when a decided deal sat in QUOTED looking undecided.
 *
 * Hidden at zero. "Committed $0" is a row that says nothing on most days, and a
 * scoreboard people scroll past is a scoreboard nobody reads.
 *
 * Money-gated by construction: the whole block only renders when `money` is
 * present, and the Worker deletes `scoreboard.money` outright for a `service`
 * token — so a tech gets no row rather than a row of blanks.
 */
function sbCommitted(money) {
  const n = amount(money.committed_count);
  if (!n) return '';
  const v = amount(money.committed_value);
  const c = amount(money.committed_commission);
  const sub = [`${n} PO${n === 1 ? '' : 's'} in hand`, c != null ? `${fmtMoney(c)} potential commission` : null]
    .filter(Boolean).join(' · ');
  return html`
    <div class="sb-row sb-committed">
      <div class="sb-l">Committed</div>
      <div class="sb-v">
        <strong>${v == null ? NO_DATA : fmtMoney(v)}</strong>
        <span class="sb-sub">${sub}</span>
      </div>
    </div>`;
}

const ARROW = { up: '↑', down: '↓', flat: '—' };

/**
 * Three figures, each against the same three-month baseline the engine sent.
 * The delta is a direction and the average it is measured against — not a
 * percentage change, which on a two-deal month is noise wearing a suit.
 * The caption names the comparison once so three arrows don't have to.
 */
function sbThisMonth(sb, money, base) {
  const tm = sb.this_month || {};
  const stat = (label, value, shown, avg, fmt) => {
    const d = delta(value, avg);
    return html`<div class="sb-stat">
      <b>${shown == null ? NO_DATA : shown}</b>
      <span>${label}</span>
      ${d.dir === 'none' ? '' : raw(html`<em class="d-${d.dir}">${ARROW[d.dir]} ${fmt(d.avg)}</em>`)}
    </div>`;
  };
  const plain = (n) => (n == null ? '' : String(Math.round(n * 10) / 10));
  const wonValue = amount(money.this_month_won_value);
  const comm = amount(money.this_month_commission);
  const wins = amount(tm.won_count);
  const winsAvg = amount(tm.baseline_won_count_avg != null ? tm.baseline_won_count_avg : base.won_count_avg);
  const months = Array.isArray(base.months) && base.months.length ? base.months.length : 3;

  return html`
    <div class="sb-row">
      <div class="sb-l">This month${tm.month ? raw(html` <span class="sb-m">${tm.month}</span>`) : ''}</div>
      <div class="sb-stats">
        ${raw(stat('wins', wins, wins, winsAvg, plain))}
        ${raw(stat('won', wonValue, wonValue == null ? null : fmtMoney(wonValue), amount(base.won_value_avg), fmtMoney))}
        ${raw(stat('potential commission', comm, comm == null ? null : fmtMoney(comm), amount(base.commission_avg), fmtMoney))}
      </div>
      <div class="sb-cap">vs. your last ${months} mo avg</div>
    </div>`;
}

function sbSpeed(sp) {
  const streak = Number(sp.same_day_streak) || 0;
  return html`
    <div class="sb-row">
      <div class="sb-l">Speed</div>
      <div class="sb-v">
        <strong>${statOr(sp.median_hours_to_contact, 'h')}</strong>
        <span class="sb-sub">median to first contact${sp.n != null ? ` · n=${sp.n}` : ''}${sp.window_days ? ` · last ${sp.window_days}d` : ''}</span>
      </div>
      <div class="sb-cap">${streak >= 3 ? '🔥 ' : ''}${streak} same-day streak</div>
    </div>`;
}

function sbConversion(cv) {
  // `insufficient` is the engine saying "don't read anything into this yet".
  // Honour it for the whole row — three individually-hedged numbers still read
  // as a rate to somebody scanning the page.
  if (cv.insufficient) {
    const min = (insights() && insights().min_n) || 5;
    return html`
      <div class="sb-row">
        <div class="sb-l">Conversion</div>
        <div class="sb-v"><span class="sb-none">not enough data yet (n=${cv.n == null ? 0 : cv.n}/${min})</span></div>
      </div>`;
  }
  return html`
    <div class="sb-row">
      <div class="sb-l">Conversion${cv.window_days ? raw(html` <span class="sb-m">last ${cv.window_days}d</span>`) : ''}</div>
      <div class="sb-stats">
        <div class="sb-stat"><b>${pctOr(cv.received_to_quoted_pct)}</b><span>received → quoted</span></div>
        <div class="sb-stat"><b>${pctOr(cv.quoted_to_won_pct)}</b><span>quoted → won</span></div>
        <div class="sb-stat"><b>${statOr(cv.median_days_to_win, 'd')}</b><span>median to win</span></div>
      </div>
    </div>`;
}

/** Tapping the row applies the Stale chip below — the row IS the filter. */
function sbStale(st) {
  const n = Number(st.count) || 0;
  return html`
    <button type="button" class="sb-row sb-tap" data-lead-filter="stale">
      <div class="sb-l">Stale</div>
      <div class="sb-v">
        <strong>${n}</strong>
        <span class="sb-chips">
          ${st.red ? raw(chip(`🔴 ${st.red}`, 'bad')) : ''}
          ${st.yellow ? raw(chip(`🟡 ${st.yellow}`, 'warn')) : ''}
          ${!n ? raw('<span class="sb-sub">nothing rotting</span>') : ''}
        </span>
      </div>
      ${n ? raw('<div class="sb-cap">tap to show just these</div>') : ''}
    </button>`;
}

/* ---- insights (§3.2) ---- */

/** A small table. `rows` is [[cell, cell, …], …]; empty renders the null phrase. */
function insightTable(title, headers, rows, caption) {
  return html`
    <div class="ins-t">
      <div class="ins-h">${title}</div>
      ${rows.length ? raw(html`<table class="ins">
        <thead><tr>${raw(headers.map((h, i) => html`<th${i ? raw(' class="n"') : ''}>${h}</th>`).join(''))}</tr></thead>
        <tbody>${raw(rows.map((r) => html`<tr>${raw(r.map((c, i) => html`<td${i ? raw(' class="n"') : ''}>${c}</td>`).join(''))}</tr>`).join(''))}</tbody>
      </table>`) : raw(html`<div class="ins-none">${NO_DATA}</div>`)}
      ${caption ? raw(html`<div class="ins-cap">${caption}</div>`) : ''}
    </div>`;
}

/** Sorted entries of an insights sub-object, skipping the `_`-prefixed extras. */
function insEntries(obj, sortKey = 'leads') {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj)
    .filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object')
    .sort((a, b) => (Number(b[1][sortKey]) || 0) - (Number(a[1][sortKey]) || 0) || a[0].localeCompare(b[0]));
}

function insightsCard() {
  const ins = insights();
  if (!ins) return '';
  const open = ui.showInsights;
  const win = ins.window_days || 90;

  const body = open ? html`
    ${ins.insufficient ? raw(html`<div class="ins-warn">${NO_DATA} yet — ${ins.n == null ? 0 : ins.n} of ${ins.min_n == null ? 5 : ins.min_n} closed leads in the window. The tables fill in as deals close.</div>`) : ''}
    ${raw(insightTable('By source', ['Source', 'Leads', 'Won', 'Win rate'],
      insEntries(ins.by_source).map(([k, v]) => [SOURCE_LABEL[k] || k, v.leads ?? 0, v.won ?? 0, pctOr(v.win_rate_pct)])))}
    ${raw(insightTable('By interest', ['Interest', 'Leads', 'Won', 'Win rate'],
      insEntries(ins.by_interest).map(([k, v]) => [INTEREST_LABEL[k] || k, v.leads ?? 0, v.won ?? 0, pctOr(v.win_rate_pct)]),
      ins.by_interest && ins.by_interest._rental_share_of_wins_pct != null
        ? `Rental is ${pctOr(ins.by_interest._rental_share_of_wins_pct)} of wins` : null))}
    ${raw(insightTable('Machines asked for', ['Machine', 'Leads', 'Won'],
      insEntries(ins.machines).map(([k, v]) => [k, v.leads ?? 0, v.won ?? 0])))}
    ${raw(insightTable('Why we lose', ['Reason', 'Count'],
      Object.entries((ins.lost && ins.lost.reasons) || {}).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => [REASON_LABEL[k] || k, n]),
      lostCaption(ins.lost)))}
    ${raw(insightTable('Funnel — median business days', ['Stage', 'Days'],
      Object.entries((ins.funnel && ins.funnel.median_bdays_in_stage) || {})
        .map(([k, v]) => [LEAD_STAGE_LABEL[k] || k, statOr(v)]),
      ins.funnel ? `Quote to decision: ${statOr(ins.funnel.median_quote_to_decision_bdays, ' business days')}` : null))}
    ${raw(insightTable('By ZIP', ['ZIP', 'Leads', 'Won'],
      insEntries(ins.by_zip).map(([k, v]) => [k, v.leads ?? 0, v.won ?? 0])))}` : '';

  return html`
    <section class="ins-card" aria-label="Pipeline insights">
      <button type="button" class="score-h" data-insights-toggle="1" aria-expanded="${open ? 'true' : 'false'}">
        <span>${open ? '▾' : '▸'} Pipeline insights — last ${win} days</span>
      </button>
      ${raw(body)}
    </section>`;
}

function lostCaption(lost) {
  if (!lost) return null;
  const w = amount(lost.median_value_won);
  const l = amount(lost.median_value_lost);
  if (w == null && l == null) return null;
  return `Median deal — won ${w == null ? NO_DATA : fmtMoney(w)} · lost ${l == null ? NO_DATA : fmtMoney(l)}`;
}

/* ---- + New lead (§3.3, any role) ---- */

function newLeadForm() {
  const o = leadOpts();
  const meName = (state.me && state.me.name) || '';
  const mine = o.assignees.includes(meName) ? meName : o.assignees[0];
  const short = (list, labels) => list.map((v) => [v, labels[v] || v]);
  return html`
    <form class="write sheet" data-action="lead_open">
      <label for="nl-cust">Customer</label>
      <input id="nl-cust" name="customer" required autocomplete="off">

      <label for="nl-contact">Who you talked to</label>
      <input id="nl-contact" name="contact" autocomplete="off">
      <div class="dates">
        <div><label for="nl-phone">Phone</label><input id="nl-phone" name="phone" type="tel" autocomplete="off"></div>
        <div><label for="nl-email">Email</label><input id="nl-email" name="email" type="email" autocomplete="off"></div>
      </div>

      <label>How they found us</label>
      ${raw(toggle('source', short(o.sources, SOURCE_LABEL), o.sources.includes('PHONE') ? 'PHONE' : o.sources[0]))}

      <label>What they want</label>
      ${raw(toggle('interest', short(o.interests, INTEREST_LABEL), o.interests.includes('RENTAL') ? 'RENTAL' : o.interests[0]))}

      <label>Which machine</label>
      ${raw(toggle('machine_mode', [['TEXT', 'Type it'], ['UNIT', 'Pick one of ours']], 'TEXT'))}
      <div data-when="machine_mode=TEXT">
        <input id="nl-machine" name="machine" placeholder="what they asked for — brand, size, anything" autocomplete="off">
      </div>
      <div data-when="machine_mode=UNIT" hidden>
        <select id="nl-serial" name="serial"><option value="">— none —</option>${raw(unitOptions())}</select>
      </div>

      <label for="nl-site">Site</label>
      <input id="nl-site" name="site" placeholder="city, or the address if you have it" autocomplete="off">

      <label>Priority</label>
      ${raw(toggle('priority', LEAD_PRIORITIES.map((p) => [p, PRI_LABEL[p] || p]), 'MEDIUM'))}

      <label>Whose lead</label>
      ${raw(toggle('assigned', o.assignees.map((n) => [n, n]), mine))}

      <label for="nl-next">Next action</label>
      <input id="nl-next" name="next_action" placeholder="call back Thursday, send the quote…" autocomplete="off">

      <label for="nl-note">Note</label>
      <textarea id="nl-note" name="note" placeholder="what they said"></textarea>

      ${raw(sheetButtons('Open the lead'))}
      <div class="form-note">A proposal. The engine assigns the lead number at the next run, and flags a duplicate in the run report rather than here.</div>
    </form>`;
}

/* ---- lead detail (§3.5) ---- */

function viewLead(id) {
  const l = leadById(leads(), id);
  if (!l) {
    return html`<a class="crumb" href="#/leads">‹ Leads</a>
      ${raw(emptyState('Lead not found.', 'It may have closed and left the snapshot.'))}`;
  }
  const pend = pendingForLead(l.lead);
  const u = l.serial ? unitBySerial(l.serial) : null;
  const v = amount(l.value);
  const c = amount(l.potential_commission);
  const q = l.quote && typeof l.quote === 'object' ? l.quote : null;
  const dm = l.demo && typeof l.demo === 'object' ? l.demo : null;
  const demoUnit = dm && dm.serial ? unitBySerial(dm.serial) : null;

  const contact = [
    l.phone ? html`<a href="tel:${raw(encodeURIComponent(String(l.phone).replace(/[^\d+]/g, '')))}">${l.phone}</a>` : '',
    l.email ? html`<a href="mailto:${raw(encodeURIComponent(l.email))}">${l.email}</a>` : '',
  ].filter(Boolean).join(' · ');

  return html`
    <a class="crumb" href="#/leads">‹ Leads</a>
    ${raw(msgBlock())}
    <div class="detail-head">
      <div class="h">${l.customer || '—'}</div>
      <div class="s"><span class="unit-serial">${l.lead}</span> · ${l.machine || INTEREST_LABEL[l.interest] || '—'}</div>
      <div class="chips">
        ${raw(chip(LEAD_STAGE_LABEL[l.stage] || l.stage, 'stage'))}
        ${raw(chip(PRI_LABEL[l.priority] || l.priority || '—', `pri-chip pri-${l.priority || 'MEDIUM'}`))}
        ${raw(chip(SOURCE_LABEL[l.source] || l.source || '—', 'out'))}
        ${l.status !== 'OPEN' ? raw(chip(LEAD_STATUS_LABEL[l.status] || l.status, l.status === 'WON' ? 'ok' : 'bad')) : ''}
        ${l.stale ? raw(chip(l.stale === 'red' ? '🔴 stale' : '🟡 going stale', l.stale === 'red' ? 'bad' : 'warn')) : ''}
        ${pend.length ? raw(chip(`⏳ ${pend.length} pending`, 'pending')) : ''}
      </div>
    </div>

    ${pend.length ? raw(html`<div class="note"><strong>⏳ ${pend.length} pending change${pend.length > 1 ? 's' : ''}</strong>
      ${raw(pend.map((e) => html`<div class="pend-row"><span>${describeLead(e)} — by ${e.actor || 'someone'}</span>${raw(undoControl(e))}</div>`).join(''))}
      <div style="margin-top:6px">Applies at the next run — the board still shows the current truth.</div></div>`) : ''}

    ${l.stale_reason ? raw(html`<div class="note"><strong>Going stale</strong>${l.stale_reason}</div>`) : ''}
    ${l.suggest_dead ? raw('<div class="info">💀 Nothing has moved on this in a long time. Close it out or give it a next action.</div>') : ''}
    ${l.next_action ? raw(html`<div class="info"><strong>Next:</strong> ${l.next_action}</div>`) : ''}

    <h2>Who</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Customer', l.customer))}
      ${raw(kvRow('Contact', l.contact))}
      ${raw(kvRow('Reach them', contact ? raw(contact) : ''))}
      ${raw(kvRow('Site', l.site))}
      ${raw(kvRow('Source', SOURCE_LABEL[l.source] || l.source))}
      ${raw(kvRow('Assigned', l.assigned))}
    </dl></div>

    <h2>The deal</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Wants', INTEREST_LABEL[l.interest] || l.interest))}
      ${raw(kvRow('Machine', u
        ? raw(html`<a href="#/unit/${raw(enc(u.serial))}">#${u.serial} ${unitName(u)}</a>`)
        : (l.machine || '')))}
      ${v != null ? raw(kvRow('Value', fmtMoney(v), 'num')) : ''}
      ${c != null ? raw(kvRow('Potential commission', fmtMoney(c), 'num')) : ''}
      ${raw(kvRow('Quote', q
        ? raw(html`${q.number || '—'}${q.sent ? raw(html` · sent ${fmtDate(q.sent)}`) : ''}${httpUrl(q.file) ? raw(html` · <a href="${q.file}" rel="noopener noreferrer" target="_blank">open</a>`) : ''}`)
        : ''))}
      ${raw(kvRow('Demo', dm
        ? raw(html`${fmtDateFull(dm.date)}${demoUnit ? raw(html` · <a href="#/unit/${raw(enc(demoUnit.serial))}">#${demoUnit.serial} ${unitName(demoUnit)}</a>`) : (dm.serial ? raw(html` · #${dm.serial}`) : '')}`)
        : ''))}
      ${raw(kvRow('PO', l.po))}
      ${raw(kvRow('Invoice', l.invoice))}
      ${raw(kvRow('Machinio', l.machinio_ref))}
      ${raw(kvRow('Service ticket', l.related_ticket
        ? raw(html`<a href="#/ticket/${raw(enc(l.related_ticket))}">🔧 ${l.related_ticket}</a>`) : ''))}
    </dl></div>

    <h2>Timing</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Opened', `${fmtDateFull(l.opened)}${l.opened_by ? ` by ${l.opened_by}` : ''}`))}
      ${raw(kvRow('First contact', l.first_contact
        ? `${fmtInstantCentral(l.first_contact)}${l.hours_to_contact != null ? ` · ${statOr(l.hours_to_contact, 'h')} after it landed` : ''}`
        : raw('<span class="none">none yet</span>')))}
      ${raw(kvRow('In this stage since', l.stage_since ? fmtInstantCentral(l.stage_since) : ''))}
      ${raw(kvRow('Age', `${l.age_in_stage_days != null ? `${l.age_in_stage_days}d in stage` : ''}${l.age_in_stage_days != null && l.age_total_days != null ? ' · ' : ''}${l.age_total_days != null ? `${l.age_total_days}d total` : ''}`))}
      ${l.closed ? raw(kvRow('Closed', `${fmtDateFull(l.closed)}${l.close_reason ? ` · ${REASON_LABEL[l.close_reason] || l.close_reason}` : ''}`)) : ''}
      ${l.close_note ? raw(kvRow('Close note', l.close_note)) : ''}
    </dl></div>

    ${raw(docsSection(l, l.lead))}
    ${raw(notesSection(l, pend))}
    ${raw(leadStagePicker(l))}
    ${raw(leadActions(l))}`;
}

/** One-line English for a pending lead write, whatever it carried. */
function describeLead(e) {
  const p = pl(e);
  if (e.action === 'lead_close') {
    return `closing as ${p.outcome}${p.reason ? ` — ${REASON_LABEL[p.reason] || p.reason}` : ''}`;
  }
  const bits = [];
  if (p.stage) bits.push(`stage → ${LEAD_STAGE_LABEL[p.stage] || p.stage}`);
  if (p.value != null) bits.push(`value ${fmtMoney(p.value)}`);
  if (p.assigned) bits.push(`assigned to ${p.assigned}`);
  if (p.priority) bits.push(`priority ${PRI_LABEL[p.priority] || p.priority}`);
  if (p.demo_date) bits.push(`demo ${fmtDate(p.demo_date)}${p.demo_serial ? ` on #${p.demo_serial}` : ''}`);
  if (p.invoice) bits.push(`invoice ${p.invoice}`);
  if (p.next_action) bits.push('next action set');
  if (p.note) bits.push('note added');
  return bits.length ? bits.join(', ') : e.action;
}

function leadStagePicker(l) {
  const canEdit = canEditLead(role());
  if (!canEdit) {
    return html`<h2>Stage</h2>
      <div class="info">${LEAD_STAGE_LABEL[l.stage] || l.stage}. Kevin and Matt work the pipeline; you can still add a note below.</div>`;
  }
  if (l.status !== 'OPEN') {
    return html`<h2>Stage</h2>
      <div class="info">This lead is ${LEAD_STATUS_LABEL[l.status] || l.status}. Reopening one is the vault's job — tell Matt.</div>`;
  }
  const opts = leadStageOptions(l, role(), leadsSummary());
  const btns = opts.map((o) => html`
    <button type="button" class="stg${o.current ? ' on' : ''}" data-lead-stage="${o.stage}"
      ${o.enabled && !o.current ? '' : raw('disabled')}>${o.label}</button>`);
  return html`
    <h2>Stage</h2>
    <div class="stages">${raw(btns.join(''))}</div>
    ${role() !== 'owner' ? raw('<div class="form-note">Matt marks a deal invoiced — it names a real invoice.</div>') : ''}
    ${ui.form && ui.form.kind === 'lead-stage' && ui.form.id === l.lead ? raw(leadStageForm(l, ui.form.arg)) : ''}`;
}

/**
 * The stage sheet. Four stages ask for something before they can be proposed
 * (stageNeeds): a demo needs a day and a machine, an invoice needs its number,
 * a quote needs a value if we never wrote one down, and PO received needs the
 * customer's PO number unless the lead already carries one (D55).
 */
function leadStageForm(l, stage) {
  const need = stageNeeds(l, stage);
  const label = LEAD_STAGE_LABEL[stage] || stage;
  const body = need === 'demo' ? html`
      <label for="ls-date">Demo day</label>
      <input id="ls-date" name="demo_date" type="date" value="${todayCentral()}" required>
      <label for="ls-unit">Which unit is going</label>
      <select id="ls-unit" name="demo_serial" required>${raw(unitOptions(l.serial || (l.demo && l.demo.serial)))}</select>
      <div class="form-note">The engine puts the hold on that unit and books the truck at the next run.</div>`
    : need === 'invoice' ? html`
      <label for="ls-inv">Invoice number</label>
      <input id="ls-inv" name="invoice" required autocomplete="off" placeholder="as it reads in QuickBooks">`
    : need === 'value' ? html`
      <label for="ls-val">Deal value</label>
      <input id="ls-val" name="value" type="number" min="0" step="1" required inputmode="decimal" placeholder="what you quoted">
      <div class="form-note">The engine works the commission out from this — don't put one in yourself.</div>`
    : need === 'po' ? html`
      <label for="ls-po">Customer PO #</label>
      <input id="ls-po" name="po" required autocomplete="off" maxlength="64" placeholder="as it reads on their PO">
      <div class="form-note">The engine refuses the move without it — the PO is the commitment.</div>`
    : '';
  return html`
    <form class="write sheet" data-action="lead_update" data-id="${l.lead}" data-mode="stage">
      <input type="hidden" name="stage" value="${stage}">
      ${raw(body)}
      <label for="ls-note">Move to ${label} — note (optional)</label>
      <textarea id="ls-note" name="note" placeholder="what was said"></textarea>
      ${raw(sheetButtons(`Move to ${label}`))}
    </form>`;
}

/** Note (any role) · value / assign / priority / next action / close (sales + owner). */
function leadActions(l) {
  const open = ui.form && ui.form.id === l.lead ? ui.form.kind : null;
  const canEdit = canEditLead(role());
  const o = leadOpts();
  const v = amount(l.value);

  return html`
    <h2>Update</h2>
    <div class="actions row">
      <button class="btn ghost" type="button" data-sheet="lead-note" data-id="${l.lead}">Add a note</button>
      ${canEdit ? raw(html`<button class="btn ghost" type="button" data-sheet="lead-value" data-id="${l.lead}">Value</button>`) : ''}
      ${canEdit ? raw(html`<button class="btn ghost" type="button" data-sheet="lead-next" data-id="${l.lead}">Next action</button>`) : ''}
      ${canEdit ? raw(html`<button class="btn ghost" type="button" data-sheet="lead-assign" data-id="${l.lead}">Assign</button>`) : ''}
      ${canEdit ? raw(html`<button class="btn ghost" type="button" data-sheet="lead-priority" data-id="${l.lead}">Priority</button>`) : ''}
    </div>
    ${open === 'lead-note' ? raw(html`
      <form class="write sheet" data-action="lead_update" data-id="${l.lead}" data-mode="note">
        <label for="ln-note">Note</label>
        <textarea id="ln-note" name="note" required placeholder="what happened"></textarea>
        ${raw(sheetButtons('Add the note'))}
        <div class="form-note">Notes land in the lead's file at the next run; yours shows as pending until then.</div>
      </form>`) : ''}
    ${open === 'lead-value' ? raw(html`
      <form class="write sheet" data-action="lead_update" data-id="${l.lead}" data-mode="value">
        <label for="lv-val">Deal value</label>
        <input id="lv-val" name="value" type="number" min="0" step="1" required inputmode="decimal" value="${v == null ? '' : v}">
        ${raw(sheetButtons('Set the value'))}
      </form>`) : ''}
    ${open === 'lead-next' ? raw(html`
      <form class="write sheet" data-action="lead_update" data-id="${l.lead}" data-mode="next">
        <label for="lx-next">Next action</label>
        <input id="lx-next" name="next_action" required value="${l.next_action || ''}" autocomplete="off">
        ${raw(sheetButtons('Set it'))}
      </form>`) : ''}
    ${open === 'lead-assign' ? raw(html`
      <form class="write sheet" data-action="lead_update" data-id="${l.lead}" data-mode="assign">
        <label>Whose lead</label>
        ${raw(toggle('assigned', o.assignees.map((n) => [n, n]), o.assignees.includes(l.assigned) ? l.assigned : o.assignees[0]))}
        ${raw(sheetButtons('Assign'))}
      </form>`) : ''}
    ${open === 'lead-priority' ? raw(html`
      <form class="write sheet" data-action="lead_update" data-id="${l.lead}" data-mode="priority">
        <label>Priority</label>
        ${raw(toggle('priority', LEAD_PRIORITIES.map((p) => [p, PRI_LABEL[p] || p]), l.priority || 'MEDIUM'))}
        ${raw(sheetButtons('Set priority'))}
      </form>`) : ''}

    ${canCloseLead(role()) && l.status === 'OPEN' ? raw(html`
      <h2>Close it out</h2>
      <div class="actions"><button class="btn ghost danger-btn" type="button" data-sheet="lead-close" data-id="${l.lead}">Lost or dead</button></div>
      ${open === 'lead-close' ? raw(closeLeadForm(l, o)) : ''}
      <div class="form-note">A win is not closed here — move the stage to Invoiced and the engine marks it won.</div>`) : ''}`;
}

function closeLeadForm(l, o) {
  return html`
    <form class="write sheet" data-action="lead_close" data-id="${l.lead}">
      <label>What happened</label>
      ${raw(toggle('outcome', [['LOST', 'Lost it'], ['DEAD', 'Went nowhere']], 'LOST'))}
      <div data-when="outcome=LOST">
        <label>Why</label>
        ${raw(toggle('reason', o.lostReasons.map((r) => [r, REASON_LABEL[r] || r]), o.lostReasons[0]))}
      </div>
      <label for="lc-note">Note</label>
      <textarea id="lc-note" name="note" placeholder="who they went with, what the number was"></textarea>
      ${raw(sheetButtons('Close the lead'))}
      <div class="form-note">A proposal — it stays on the board until the next run.</div>
    </form>`;
}

/* ---- gate / error screens ---- */

function viewGate(code) {
  return gateBody(code) + diag(code);
}

/** Small diagnostic line under every gate screen: reason · build · where the token came from. */
function diag(code) {
  const hasT = new URL(window.location.href).searchParams.has('t');
  let stored = 'n/a';
  try { stored = localStorage.getItem(TOKEN_KEY) ? 'yes' : 'no'; } catch (_) { stored = 'blocked'; }
  const detail = state.error && state.error.message && code === 'error' ? ` · ${state.error.message}` : '';
  return html`<div class="form-note">reason: ${code} · token in url: ${hasT ? 'yes' : 'no'} · in storage: ${stored} · build ${BUILD}${detail}</div>`;
}

function gateBody(code) {
  if (code === 'no-token') {
    return html`<h1>WSS Fleet Tracker</h1>
      <div class="card">
        <p>This board opens from your personal link.</p>
        <p><strong>Ask Matt for your link</strong> — then bookmark it or add it to your home screen.</p>
      </div>`;
  }
  if (code === 'bad-token') {
    return html`<h1>Link not recognized</h1>
      <div class="card"><p>That link isn't active any more. Ask Matt for a new one.</p></div>`;
  }
  if (code === 'no-snapshot') {
    return html`<h1>Nothing published yet</h1>
      <div class="card">
        <p>Your link works. The fleet snapshot hasn't been published to the board yet.</p>
        <p>It arrives with the next run — pull down or tap ↻ later.</p>
        <div class="actions"><button class="btn" type="button" id="retry">Check again</button></div>
      </div>`;
  }
  if (code === 'no-api') {
    return html`<h1>Not wired up yet</h1>
      <div class="card">
        <p>The Worker endpoint isn't configured in this build.</p>
        <p>Open <code>?mock=full</code> or <code>?mock=empty</code> to preview with fake data,
        or on localhost <code>?api=http://localhost:8788</code> to use <code>wrangler dev</code>.</p>
      </div>`;
  }
  return html`<h1>Can't load the board</h1>
    <div class="card"><p>${state.error || 'Unknown error.'}</p>
    <div class="actions"><button class="btn" type="button" id="retry">Try again</button></div></div>`;
}

/* ============================================================= 10. header == */

function renderHeader() {
  const asof = $('#asof');
  const badge = $('#pending-badge');

  if (!state.snapshot) {
    asof.textContent = state.loading ? 'loading…' : '';
    asof.classList.remove('stale');
    badge.hidden = true;
    return;
  }

  const gen = (state.snapshot.meta && state.snapshot.meta.generated_at) || '';
  const stale = gen && hoursSince(gen) > STALE_HOURS;
  asof.textContent = `${stale ? '⚠️ ' : ''}data as of ${fmtInstantCentral(gen)}` +
    (state.source && state.source.startsWith('mock') ? ` · ${state.source}` : '');
  asof.classList.toggle('stale', !!stale);

  const n = state.pending.length;
  badge.hidden = n === 0;
  badge.textContent = `⏳ ${n} pending`;
}

function renderTabs(route) {
  const tab = route.startsWith('#/rentals') || route.startsWith('#/agreement/') ? 'rentals'
    : route.startsWith('#/holds') ? 'holds'
    : route.startsWith('#/dispatch') ? 'dispatch'
    : route.startsWith('#/leads') || route.startsWith('#/lead/') ? 'leads'
    : route.startsWith('#/service') || route.startsWith('#/ticket') ? 'service' : 'fleet';
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('on', el.dataset.tab === tab));
  // The count badge moved from Service to Dispatch at v1.6 (§1): everything
  // still needing a truck, OPEN + SCHEDULED. DONE rows linger and don't count.
  const badge = $('#tab-dispatch-badge');
  if (badge) {
    const n = state.snapshot ? openCount(dispatchRows()) : 0;
    badge.hidden = n === 0;
    badge.textContent = n;
  }
  // Leads badge = leads nobody has called yet (§1). Visible pressure, by design:
  // it is the one number on this board that only goes down by picking up a phone.
  const lb = $('#tab-leads-badge');
  if (lb) {
    const s = leadsSummary();
    const n = s && typeof s.received_uncontacted === 'number' ? s.received_uncontacted : 0;
    lb.hidden = n === 0;
    lb.textContent = n;
  }
}

/* ============================================================= 11. router == */

/* D63: the hash the last full render drew. A render at the SAME hash is an
 * in-place redraw (a write landed, a sheet opened, a chip flipped) and keeps
 * the reader where they were; a new hash is a navigation and starts at the top.
 * null until the first real render, so boot always starts at the top. */
let lastRenderedHash = null;

function render() {
  const view = $('#view');
  const hash = window.location.hash || '#/';
  renderTabs(hash);

  if (state.error) { view.innerHTML = viewGate(state.error.code); renderHeader(); return; }
  if (!state.snapshot) { view.innerHTML = '<div class="loading">Loading…</div>'; renderHeader(); return; }

  const parts = hash.replace(/^#\/?/, '').split('/');
  const section = parts[0] || '';
  const arg = parts.slice(1).join('/');

  // The Billing view is gone (D39). Old bookmarks and home-screen icons still
  // point at it, so send them to the tab that took its slot rather than a blank.
  if (section === 'billing') { window.location.replace('#/dispatch'); return; }

  let out;
  if (section === 'rentals') out = viewRentals();
  else if (section === 'agreement') out = viewAgreement(decodeURIComponent(arg || ''));
  else if (section === 'holds') out = viewHolds();
  else if (section === 'dispatch') out = viewDispatch(arg ? decodeURIComponent(arg) : null);
  else if (section === 'service') out = viewService();
  else if (section === 'ticket') out = viewTicket(decodeURIComponent(arg || ''));
  else if (section === 'leads') out = viewLeads();
  else if (section === 'lead') out = viewLead(decodeURIComponent(arg || ''));
  else if (section === 'cat') out = viewCategory(decodeURIComponent(arg || ''));
  else if (section === 'unit') out = viewUnit(decodeURIComponent(arg || ''));
  else if (section === 'wo') out = viewWorkOrder(decodeURIComponent(arg || ''));
  else if (section === 'inspection') out = viewInspection(arg || '');
  else out = viewCategories();

  // D63: capture before the swap — a shorter view can clamp the scroll.
  const sameView = hash === lastRenderedHash;
  const keepY = sameView ? window.scrollY : 0;
  const keepTop = sameView ? view.scrollTop : 0;

  view.innerHTML = out;
  ui.msg = null;                 // the confirmation line shows once, then clears
  renderHeader();
  lastRenderedHash = hash;

  // D52: the map asset is fetched once, lazily — nobody who never opens the map
  // pays for 145 KB. loadMap() re-renders when it lands.
  if (section === 'dispatch' && (arg === 'map' || (!arg && ui.dispatchView === 'map'))) {
    if (mapSvgState === 'idle') loadMap();
    else if (mapSvgState === 'ready') bindMap();
  }

  // Deep link from a ticket or a unit page: put the named run on screen rather
  // than dumping the reader at the top of a long board.
  const hot = arg && section === 'dispatch' && arg !== 'map'
    ? $(`#d-${CSS.escape(decodeURIComponent(arg))}`) : null;
  if (hot) { hot.scrollIntoView({ block: 'center' }); return; }

  // D63: an in-place re-render (stage change, claim, readiness, note…) must not
  // throw the reader to the top. Put back only what drifted — never add a
  // scroll of our own, and never chase the confirmation line.
  if (sameView) {
    if (view.scrollTop !== keepTop) view.scrollTop = keepTop;
    if (window.scrollY !== keepY) window.scrollTo(0, keepY);
    return;
  }
  view.scrollTop = 0;
  window.scrollTo(0, 0);
}

/* =============================================================== 12. boot == */

async function refresh() {
  state.loading = true;
  renderHeader();
  try {
    const d = await loadData(ctx());
    state.me = d.me;
    state.snapshot = d.snapshot;
    state.pending = d.pending;
    state.source = d.source;
    state.error = null;
  } catch (err) {
    state.error = err;
    state.error.code = err.code || 'error';
    console.warn('[wss-fleet] load failed:', err.message);
  } finally {
    state.loading = false;
    render();
  }
}

/* ---- map gestures (D52) --------------------------------------------------
 * Pinch-zoom and drag-pan, on pointer events, with no library.
 *
 * The viewBox attribute is mutated IN PLACE and the pins are re-scaled by hand.
 * A re-render per pointermove would rebuild 145 KB of innerHTML forty times a
 * second, which is not a gesture — it is a slideshow. render() picks the live
 * viewBox back up out of `mapView` the next time something real changes.
 *
 * THE SCROLL RULE (exit criterion): at minimum zoom the map is showing the
 * whole state and cannot pan anywhere, so a drag there must belong to the PAGE
 * — the off-map list is underneath and a tech has to be able to reach it. So
 * `touch-action` is set from the zoom level: `pan-y` when we are at the bottom
 * stop, `none` once there is somewhere to pan to. Two fingers always zoom.
 */
function bindMap() {
  const svg = document.getElementById('wimap');
  if (!svg || svg.dataset.bound === '1') return;
  svg.dataset.bound = '1';

  const pts = new Map();               // live pointers, for the pinch
  let start = null;                    // the gesture's anchor
  let moved = false;

  const atMinZoom = () => !!mapOuter && !!mapView && mapView.w >= mapOuter.w - 0.5;
  const syncTouchAction = () => { svg.style.touchAction = atMinZoom() ? 'pan-y' : 'none'; };

  /**
   * Client px -> SVG user units, through a GIVEN viewBox.
   *
   * The view is an argument and not `mapView` on purpose. A gesture anchors on
   * the viewBox it STARTED in; re-deriving the anchor from the live one every
   * frame makes each move re-measure against the position the previous move
   * just set, so a drag tracks only the last few pixels and the map crawls
   * behind the finger. That reads as lag and is actually arithmetic.
   *
   * preserveAspectRatio is the default (meet), so the drawing is letterboxed:
   * one scale for both axes, centred. Ignoring the letterbox puts every gesture
   * a few pixels out, which feels like drift.
   */
  const unitsPerPx = (view, r) => Math.max(view.w / r.width, view.h / r.height);
  const toSvg = (cx, cy, view) => {
    const r = svg.getBoundingClientRect();
    const k = unitsPerPx(view, r);
    return {
      x: view.x + (cx - r.left - (r.width - view.w / k) / 2) * k,
      y: view.y + (cy - r.top - (r.height - view.h / k) / 2) * k,
    };
  };

  const apply = (next) => {
    mapView = clampViewBox(next, mapOuter, MAP_ZOOM_MIN_SPAN);
    svg.setAttribute('viewBox', viewBoxStr(mapView));
    const scale = pinScale();
    svg.classList.toggle('far', mapView.w > chipHideSpan());
    for (const pin of svg.querySelectorAll('#pins .pin')) {
      pin.setAttribute('transform', `translate(${pin.dataset.x},${pin.dataset.y}) scale(${scale})`);
    }
    syncTouchAction();
  };
  mapApply = apply;
  syncTouchAction();

  const spread = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  svg.addEventListener('pointerdown', (ev) => {
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    moved = false;
    if (pts.size === 1) {
      if (atMinZoom()) { start = null; return; }   // let the page scroll
      svg.setPointerCapture(ev.pointerId);
      start = { mode: 'pan', client: { x: ev.clientX, y: ev.clientY }, view: { ...mapView } };
    } else if (pts.size === 2) {
      const m = mid();
      start = { mode: 'pinch', dist: spread(), at: toSvg(m.x, m.y, mapView), view: { ...mapView } };
    }
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!pts.has(ev.pointerId)) return;
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (!start) return;

    if (start.mode === 'pan' && pts.size === 1) {
      // Both the anchor and the scale come from start.view, so the map stays
      // welded to the finger for the whole drag however far it travels.
      const k = unitsPerPx(start.view, svg.getBoundingClientRect());
      const dx = (start.client.x - ev.clientX) * k;
      const dy = (start.client.y - ev.clientY) * k;
      if (Math.abs(dx) + Math.abs(dy) > 1.5) moved = true;
      apply({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
    } else if (start.mode === 'pinch' && pts.size === 2) {
      moved = true;
      const d = spread();
      if (!start.dist || !d) return;
      apply(zoomAt(start.view, d / start.dist, start.at.x, start.at.y));
    }
  });

  const release = (ev) => {
    pts.delete(ev.pointerId);
    // Lifting one finger out of a pinch re-anchors the survivor as a pan,
    // rather than leaving a dead gesture that ignores the finger still down.
    const left = [...pts.values()][0];
    start = pts.size === 1 && left && !atMinZoom()
      ? { mode: 'pan', client: { x: left.x, y: left.y }, view: { ...mapView } }
      : pts.size >= 2 ? start : null;
    if (svg.hasPointerCapture && svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);

  // Desktop: the wheel zooms about the cursor. Only with a real map under it,
  // and only when it is actually zoomable, so the page keeps its scroll.
  svg.addEventListener('wheel', (ev) => {
    if (atMinZoom() && ev.deltaY > 0) return;
    ev.preventDefault();
    const at = toSvg(ev.clientX, ev.clientY, mapView);
    apply(zoomAt(mapView, ev.deltaY < 0 ? 1.18 : 1 / 1.18, at.x, at.y));
  }, { passive: false });

  // A pin tap that was really the end of a drag must not open a sheet.
  svg.addEventListener('click', (ev) => {
    if (!moved) return;
    ev.stopPropagation();
    ev.preventDefault();
    moved = false;
  }, true);
}

// Set by bindMap so the ⌂ / ⤢ buttons can move the map without a full re-render.
let mapApply = null;

/* ---- schema-3 interaction: sheets, segmented toggles, tap-to-copy ---- */

/**
 * Show or hide the parts of a form that depend on a segmented control, and
 * keep the dependent values honest:
 *   location IN-SHOP  -> intake_move NONE (it's already here; no truck to book)
 *   a truck is going  -> nudge for the site address
 */
function applyConditionals(form) {
  const val = (name) => {
    const el = form.querySelector(`[name="${name}"]`);
    return el ? el.value : null;
  };
  form.querySelectorAll('[data-when]').forEach((el) => {
    const [field, want] = String(el.dataset.when).split('=');
    el.hidden = val(field) !== want;
  });

  if (form.dataset.action === 'ticket_open') {
    if (val('location') === 'IN-SHOP') setToggle(form, 'intake_move', 'NONE');
    const hint = form.querySelector('[data-hint="site"]');
    if (hint) {
      const truck = val('intake_move') === 'PICKUP' || val('return_move') === 'DELIVER';
      const site = form.querySelector('[name="site"]');
      hint.hidden = !(truck && site && !site.value.trim());
    }
  }
}

/** Set a segmented control's value from code (the buttons and the hidden input). */
function setToggle(form, field, value) {
  const group = form.querySelector(`.toggle[data-toggle="${field}"]`);
  const input = form.querySelector(`input[name="${field}"]`);
  if (input) input.value = value;
  if (group) group.querySelectorAll('.tg').forEach((b) => b.classList.toggle('on', b.dataset.val === value));
}

/** The same-rig-same-day warning, live as the driver picks (§4). Warns, never blocks. */
function updateRigHint(form) {
  const hint = form.querySelector('[data-hint="rig"]');
  if (!hint) return;
  const clash = rigClash({
    dispatch: dispatchRows(), warnings: dispatchWarnings(),
    rig: form.querySelector('[name=rig]').value,
    date: form.querySelector('[name=date]').value,
    excludeId: form.dataset.id,
  });
  hint.hidden = !clash;
  hint.textContent = clash
    ? `${clash.rig} already has a run on ${fmtDateFull(clash.date)}. That may be the plan — you can still claim it.`
    : '';
}

async function copyText(text, el) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else throw new Error('no clipboard');
    if (el) { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1200); }
  } catch (_) {
    // No clipboard (http, old browser): select it so a long-press can copy.
    if (el && window.getSelection) {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
}

// Delegated events — the view is re-rendered wholesale, so nothing binds directly.
/* ====================================== documents: upload (S2) ============ */

/**
 * Longest edge a photo is allowed to keep, and the JPEG quality it keeps it at.
 *
 * A phone camera hands over 8-12 MB; 1600px at q0.7 lands around 200-400 KB.
 * That is the difference between a tech attaching the photo and a tech giving
 * up on one bar of LTE — and 1600px is still more than enough to read a serial
 * plate or see a cracked squeegee.
 */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.7;
const THUMB_EDGE = 160;

/**
 * Decode a picked image with its EXIF rotation already applied.
 *
 * A phone shoots portrait by writing landscape pixels plus an orientation tag.
 * Draw those pixels to a canvas naively and the photo comes out on its side —
 * which is exactly what would happen to every single photo a tech takes. So:
 * `createImageBitmap(file, {imageOrientation:'from-image'})` where it exists,
 * then a plain createImageBitmap, then an <img> (modern Safari applies EXIF to
 * an <img> by default). Three doors because this one bug would be invisible in
 * every desktop test and wrong on every phone.
 */
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* older engines reject the options bag */ }
    try { return await createImageBitmap(file); } catch (_) { /* fall through to <img> */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that image.")); };
    img.src = url;
  });
}

/** Draw `src` into a fresh canvas scaled to fit `edge`. -> canvas */
function fitToCanvas(src, edge) {
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const scale = Math.min(1, edge / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/**
 * Turn a picked file into the bytes we will actually send.
 *
 * PDFs pass through UNTOUCHED — no canvas, no re-encode, no "conversion". A
 * scan-to-PDF from the Files app is already the document; anything we did to it
 * could only lose text. Images are resized and re-encoded as JPEG (a PNG
 * screenshot of a parts diagram is several MB for no gain), and get a
 * thumbnail so the row shows the photo the tech just took.
 *
 * -> { blob, mime, name, thumb, sizeText }
 */
async function prepareFile(file, source, record) {
  const type = String(file.type || '').split(';')[0].trim().toLowerCase();

  if (type === 'application/pdf') {
    return {
      blob: file, mime: 'application/pdf', thumb: null,
      name: sanitizeName(file.name, 'document.pdf'),
      sizeText: humanSize(file.size),
    };
  }
  if (!isImageMime(type) && !/^image\//.test(type)) {
    throw new Error('PDF or photo only');
  }

  const src = await decodeImage(file);
  const blob = await toBlob(fitToCanvas(src, MAX_EDGE), 'image/jpeg', JPEG_QUALITY);
  if (!blob) throw new Error("Couldn't read that image.");
  const thumb = fitToCanvas(src, THUMB_EDGE).toDataURL('image/jpeg', 0.6);
  if (src.close) src.close();

  // The camera gives every photo the same useless name; a picked file keeps its
  // own, retyped because a PNG that came out as JPEG is no longer a .png.
  const name = source === 'camera'
    ? cameraName(record, 'image/jpeg')
    : sanitizeName(retypeName(file.name || 'photo.jpg', 'image/jpeg'), 'photo.jpg');

  return { blob, mime: 'image/jpeg', name, thumb, sizeText: humanSize(blob.size) };
}

const humanSize = (n) => (typeof n === 'number' && isFinite(n) ? humanBytes(n) : '');

/**
 * Send one upload: bytes first, then the event that points at them.
 *
 * The two calls are deliberately in this order and deliberately not atomic. If
 * the event fails after the bytes landed, the document is still in the store
 * WITH its record binding in `docmeta`, and the engine sweeps unfiled crew docs
 * on its next run — so the worst case is a delay, never a lost photo. That is
 * why the binding is a header on the upload and not only a field on the event.
 */
async function sendUpload(up) {
  up.state = 'sending';
  up.error = null;
  render();
  try {
    const stored = await uploadDoc(ctx(), {
      blob: up.blob, mime: up.mime, name: up.name, record: up.record, kind: up.kind,
    });
    const event = await postEvent(ctx(), 'doc_attach', null, {
      record: up.record, doc_id: stored.id, kind: up.kind, name: up.name,
    });
    if (up.thumb) thumbs.set(stored.id, up.thumb);
    state.pending.push(event);
    uploads.delete(up.localId);
    ui.msg = { tone: 'doc', text: 'Filing at the next run.' };
  } catch (err) {
    // The blob stays in memory, so the retry costs the tech one tap and no
    // second trip to the machine.
    up.state = 'failed';
    up.error = err && err.message ? err.message : "Didn't send";
  }
  render();
}

document.addEventListener('click', async (ev) => {
  // Segmented control: set the hidden input, then re-evaluate the form's
  // conditional blocks. No re-render — the typed-in fields must survive.
  const tg = ev.target.closest('.toggle .tg');
  if (tg) {
    const form = tg.closest('form');
    setToggle(form, tg.closest('.toggle').dataset.toggle, tg.dataset.val);
    applyConditionals(form);
    if (form.dataset.action === 'dispatch_claim') updateRigHint(form);
    return;
  }

  /* ---- the inspection sheet (D67) ---- */
  // A row's segmented control. Tapping the lit answer again clears it. A flag
  // opens the row's note — that note is what goes on the work order.
  const iseg = ev.target.closest('[data-iseg]');
  if (iseg) {
    if (iseg.disabled) return;
    const id = iseg.dataset.iseg;
    const val = iseg.dataset.val;
    editSheet((l, sh) => {
      const items = new Map(sh.items);
      const cur = items.get(id) || { result: null, note: null };
      const result = cur.result === val ? null : val;
      items.set(id, { ...cur, result });
      l.edits.items = items;
      if (isFlag(result)) l.notes.add(id);
    }, ['items']);
    return;
  }
  const inote = ev.target.closest('[data-inote]');
  if (inote) {
    const arg = inspArg();
    if (arg == null) return;
    localFor(sheetCtx(arg).key).notes.add(inote.dataset.inote);
    render();
    const input = document.querySelector(`[data-ifield="note:${CSS.escape(inote.dataset.inote)}"]`);
    if (input && input.focus) input.focus();
    return;
  }
  const irot = ev.target.closest('[data-irot]');
  if (irot) {
    if (irot.disabled) return;
    const want = irot.dataset.irot === 'true';
    editSheet((l, sh) => {
      l.edits.readings = { ...sh.readings, brushes_rotated: sh.readings.brushes_rotated === want ? null : want };
    }, ['readings']);
    return;
  }
  const iretry = ev.target.closest('[data-insp-retry]');
  if (iretry) { flushSheet(iretry.dataset.inspRetry); return; }
  // Check-out · Return · PM: posts the OPEN and goes straight to the sheet —
  // it is filled in now, numbered at the next run.
  const iopen = ev.target.closest('[data-insp-open]');
  if (iopen) {
    iopen.disabled = true;
    const serial = iopen.dataset.serial;
    try {
      const stored = await postEvent(ctx(), 'inspection', serial, { action: 'OPEN', kind: iopen.dataset.inspOpen });
      state.pending.push(stored);
      sheetLocal.delete(`new:${serial}`);
      window.location.hash = `#/inspection/new/${enc(serial)}`;
    } catch (err) {
      iopen.disabled = false;
      const msg = $('#write-msg');
      if (msg) msg.innerHTML = html`<div class="alert">⚠️ ${err.message}</div>`;
    }
    return;
  }

  // Open one of the schema-3 sheets. `data-serial` pre-fills a run from a
  // released unit; `data-id` names the ticket or dispatch row it belongs to.
  const sheet = ev.target.closest('[data-sheet]');
  if (sheet) {
    const kind = sheet.dataset.sheet;
    const id = sheet.dataset.id || null;
    if (sheetOpen(kind, id)) { closeSheet(); return; }
    ui.form = { kind, id, arg: null };
    if (kind === 'add-run' && sheet.dataset.serial) {
      const u = unitBySerial(sheet.dataset.serial);
      const hold = u && sheet.dataset.hold
        ? holdsOf(u).find((h) => h.id === sheet.dataset.hold) || null : null;
      if (u) ui.form.arg = runPrefillForUnit(u, hold);
    }
    ui.msg = null;
    render();
    return;
  }
  if (ev.target.closest('[data-sheet-close]')) { pendingPick = null; closeSheet(); return; }

  // A stage tap asks for an optional note before it proposes anything (§3.3).
  const stg = ev.target.closest('[data-stage]');
  if (stg && !stg.disabled) {
    const ticket = decodeURIComponent(window.location.hash.split('/').pop());
    ui.form = { kind: 'stage', id: ticket, arg: stg.dataset.stage };
    ui.msg = null;
    render();
    return;
  }

  // "Add a pick-up" / "Add a return delivery" from a ticket.
  const mv = ev.target.closest('[data-move]');
  if (mv) {
    ui.form = { kind: 'move', id: mv.dataset.id, arg: mv.dataset.move };
    ui.msg = null;
    render();
    return;
  }

  // A lead stage tap: same shape as a ticket's, but the sheet it opens depends
  // on the stage (a demo needs a day and a machine — see stageNeeds).
  const lstg = ev.target.closest('[data-lead-stage]');
  if (lstg && !lstg.disabled) {
    const lead = decodeURIComponent(window.location.hash.split('/').pop());
    ui.form = { kind: 'lead-stage', id: lead, arg: lstg.dataset.leadStage };
    ui.msg = null;
    render();
    return;
  }

  if (ev.target.closest('[data-done-toggle]')) { ui.showDone = !ui.showDone; render(); return; }
  // D65: the Parts strip. Remembered for the session, not the device.
  if (ev.target.closest('[data-parts-toggle]')) {
    ui.showParts = !ui.showParts;
    try { sessionStorage.setItem(PARTS_OPEN_KEY, ui.showParts ? '1' : '0'); } catch (_) { /* storage blocked */ }
    render();
    return;
  }
  // D67: the Inspections strip, same rule as Parts — remembered for the session.
  if (ev.target.closest('[data-insp-toggle]')) {
    ui.showInspections = !ui.showInspections;
    try { sessionStorage.setItem(INSP_OPEN_KEY, ui.showInspections ? '1' : '0'); } catch (_) { /* storage blocked */ }
    render();
    return;
  }
  if (ev.target.closest('[data-parts-delivered-toggle]')) { ui.showPartsDelivered = !ui.showPartsDelivered; render(); return; }

  // D65 "+ line": appended in place — a render() would wipe what's been typed.
  const addLine = ev.target.closest('[data-wo-addline]');
  if (addLine) {
    const form = addLine.closest('form');
    const wrap = form && form.querySelector('.wo-lines');
    if (!wrap) return;
    const rows = wrap.querySelectorAll('.wo-line');
    if (rows.length >= MAX_LINES) {
      addLine.disabled = true;
      addLine.textContent = `${MAX_LINES} lines max — add more after the next run`;
      return;
    }
    // A new line takes the make of the line above it: one machine, one make, usually.
    const last = rows[rows.length - 1];
    const mfr = (last && last.querySelector('[name=p_mfr]') && last.querySelector('[name=p_mfr]').value) || wrap.dataset.mfr;
    wrap.insertAdjacentHTML('beforeend', partLineRow(mfr));
    const added = wrap.querySelectorAll('.wo-line');
    const input = added[added.length - 1] && added[added.length - 1].querySelector('[name=p_num]');
    if (input) input.focus();
    return;
  }
  // D65 hours stepper: quarter hours, clamped to 0.25–12. In place, no render.
  const step = ev.target.closest('[data-hours-step]');
  if (step) {
    const input = step.closest('form') && step.closest('form').querySelector('[name=hours]');
    if (!input) return;
    const cur = Number(input.value) || 0;
    const next = Math.min(HOURS_MAX, Math.max(HOURS_MIN, Math.round((cur + Number(step.dataset.hoursStep) * HOURS_STEP) * 4) / 4));
    input.value = String(next);
    return;
  }
  if (ev.target.closest('[data-completed-toggle]')) { ui.showCompleted = !ui.showCompleted; render(); return; }
  if (ev.target.closest('[data-closed-toggle]')) { ui.showClosedLeads = !ui.showClosedLeads; render(); return; }
  if (ev.target.closest('[data-score-toggle]')) { ui.showScore = !scoreOpen(); render(); return; }
  if (ev.target.closest('[data-insights-toggle]')) { ui.showInsights = !ui.showInsights; render(); return; }

  // The Leads chips, and the scoreboard's stale row, which is one of them.
  const lchip = ev.target.closest('[data-lead-filter]');
  if (lchip) {
    ui.leadFilter = lchip.dataset.leadFilter;
    try { localStorage.setItem(LEAD_FILTER_KEY, ui.leadFilter); } catch (_) { /* storage blocked */ }
    if (!window.location.hash.startsWith('#/leads')) { window.location.hash = '#/leads'; return; }
    render();
    return;
  }

  const fchip = ev.target.closest('[data-filter]');
  if (fchip) {
    ui.ticketFilter = fchip.dataset.filter;
    try { localStorage.setItem(FILTER_KEY, ui.ticketFilter); } catch (_) { /* storage blocked */ }
    render();
    return;
  }

  // A pipeline row scrolls the kanban to its column. It never changes the chip
  // — the widget is a way to read the board, not a way to re-filter it.
  const pipe = ev.target.closest('[data-pipe]');
  if (pipe) {
    const col = document.getElementById(`kan-${pipe.dataset.pipe}`);
    if (col && col.scrollIntoView) col.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
    return;
  }

  // A document opens in a NEW TAB, straight from the Worker (schema 6).
  //
  // Not an iframe: iOS renders a PDF badly in one. Not fetch-then-blob: the
  // window.open would land after an await and be popup-blocked, and the whole
  // file would come through this page's memory to no purpose. The token rides
  // in `?t=` because a new tab cannot send an Authorization header. The OS
  // viewer is the viewer — we do not have one and are not building one.
  /* ---- map (D52) ---- */

  // List | Map. The route carries it so a run report can link to the map, and
  // localStorage carries it so the choice survives the next visit.
  const dv = ev.target.closest('[data-dview]');
  if (dv) {
    const v = dv.dataset.dview === 'map' ? 'map' : 'list';
    ui.dispatchView = v;
    try { localStorage.setItem(DISPATCH_VIEW_KEY, v); } catch (_) { /* ignore */ }
    ui.mapSheet = null;
    // replace(), not assign(): flipping the segmented control is not a place in
    // history a Back tap should have to walk through.
    window.location.replace(v === 'map' ? '#/dispatch/map' : '#/dispatch');
    render();
    return;
  }

  const mk = ev.target.closest('[data-mapkind]');
  if (mk) {
    const k = mk.dataset.mapkind;
    if (ui.mapKinds.has(k)) ui.mapKinds.delete(k); else ui.mapKinds.add(k);
    if (!ui.mapKinds.size) ui.mapKinds = new Set(MAP_KINDS);   // a blank map reads as a broken one
    rememberMapKinds();
    // A filtered-out stop is not on the map any more, so it is not in the run.
    ui.mapStops = ui.mapStops.filter((key) => stackKeysOnScreen().has(key));
    if (ui.mapSheet && !stackKeysOnScreen().has(ui.mapSheet)) ui.mapSheet = null;
    render();
    return;
  }

  const pin = ev.target.closest('[data-stack]');
  if (pin) {
    const key = pin.dataset.stack;
    if (ui.mapPlan) { toggleStop(key); return; }
    ui.mapSheet = ui.mapSheet === key ? null : key;
    render();
    return;
  }

  const mb = ev.target.closest('[data-map]');
  if (mb) {
    const what = mb.dataset.map;
    if (what === 'home' || what === 'fit') {
      // Move the live viewBox rather than re-rendering: same reason the
      // gestures do, and it keeps the reset instant on a phone.
      const next = what === 'home' ? mapHome : mapOuter;
      if (next && mapApply) mapApply(next);
      else if (next) { mapView = next; render(); }
      return;
    }
    if (what === 'plan') {
      ui.mapPlan = !ui.mapPlan;
      ui.mapSheet = null;
      if (!ui.mapPlan) ui.mapStops = [];
      render();
      return;
    }
    if (what === 'clear') { ui.mapStops = []; render(); return; }
    if (what === 'add' || what === 'drop') { toggleStop(mb.dataset.key); return; }
    if (what === 'close') { ui.mapSheet = null; render(); return; }
    return;
  }

  // 📷 / 📎 — the buttons click the hidden inputs. Nothing else happens here;
  // the work starts when the OS hands a file back (the 'change' listener).
  const pick = ev.target.closest('[data-doc-pick]');
  if (pick) {
    const input = pick.parentNode.querySelector(`[data-doc-input="${pick.dataset.docPick}"]`);
    if (input) input.click();
    return;
  }

  // The kind sheet's three buttons: one tap, then it goes.
  const kindBtn = ev.target.closest('[data-doc-kind]');
  if (kindBtn && pendingPick) {
    const p = pendingPick;
    pendingPick = null;
    ui.form = null;
    const up = {
      localId: `u${++uploadSeq}`,
      record: p.record,
      kind: resolveKind(kindBtn.dataset.docKind, p.mime),
      name: p.name, mime: p.mime, blob: p.blob, thumb: p.thumb,
      label: '', icon: '', state: 'sending', error: null,
    };
    // The row has to draw before the first byte moves, so decorate it now.
    Object.assign(up, { label: kindLabel(up.kind), icon: docIcon(up.kind) });
    uploads.set(up.localId, up);
    sendUpload(up);
    return;
  }

  // "Didn't send — tap to retry". Same blob, no second trip to the machine.
  const retry = ev.target.closest('[data-doc-retry]');
  if (retry) {
    const up = uploads.get(retry.dataset.docRetry);
    if (up && up.state !== 'sending') sendUpload(up);
    return;
  }

  // A pending row is not a document yet — there is nothing to open.
  if (ev.target.closest('[data-doc-pending]')) {
    ui.msg = { tone: 'bad', text: 'Filing on the next run — it opens once the engine has it.' };
    render();
    return;
  }

  const docBtn = ev.target.closest('[data-doc]');
  if (docBtn) {
    const c = ctx();
    if (mockVariant(c.url, c.apiBase)) {
      ui.msg = { tone: 'bad', text: 'Mock mode — documents live on the Worker.' };
      render();
      return;
    }
    const href = docUrl(c.apiBase, docBtn.dataset.doc, c.token);
    if (!href) {
      ui.msg = { tone: 'bad', text: 'No link for that document — check your token.' };
      render();
      return;
    }
    window.open(href, '_blank', 'noopener');
    return;
  }

  // Addresses copy, they do not navigate. No map links (§4).
  const addr = ev.target.closest('[data-copy]');
  if (addr) { copyText(addr.dataset.copy, addr); return; }

  // Undo: take back your own still-pending tap (D46). Unlike every other button
  // here this is NOT a proposal — the event never reaches the engine at all.
  const undo = ev.target.closest('[data-undo]');
  if (undo) {
    undo.disabled = true;
    const id = undo.dataset.undo;
    const undone = state.pending.find((e) => e.id === id);
    try {
      await deleteEvent(ctx(), id);
      // D67: taking back a NEW sheet's OPEN takes back the sheet. Nothing typed
      // into it may linger and fold itself into a later one.
      if (undone && undone.action === 'inspection' && pl(undone).action === 'OPEN'
        && !mineOnly(pendingOpensFor(state.pending, undone.serial)).some((e) => e.id !== id)) {
        sheetLocal.delete(`new:${undone.serial}`);
      }
      // Drop it locally so the badge goes at once, then re-read /api/data so
      // what is on screen is the server's list and not our guess at it.
      state.pending = state.pending.filter((e) => e.id !== id);
      ui.form = null;
      ui.msg = { tone: 'ok', text: 'Taken back. It never reaches the engine.' };
      render();
      await refresh();
    } catch (err) {
      ui.form = null;
      if (err.status === 404) {
        // It drained between the tap and the confirm. Saying "already applied"
        // is the honest reading, and a new tap is the only way to change it.
        state.pending = state.pending.filter((e) => e.id !== id);
        ui.msg = { tone: 'bad', text: 'Already applied — change it with a new tap.' };
        render();
        await refresh();
      } else {
        ui.msg = { tone: 'bad', text: err.status === 403 ? 'Not yours to undo.' : err.message };
        render();
      }
    }
    return;
  }

  // Cancel a manual run: two taps, then a proposal like any other write.
  const cancel = ev.target.closest('[data-cancel]');
  if (cancel) {
    if (!cancel.dataset.armed) {
      cancel.dataset.armed = '1';
      cancel.textContent = 'Confirm cancel';
      return;
    }
    cancel.disabled = true;
    try {
      const stored = await postEvent(ctx(), 'dispatch_cancel', null, { dispatch_id: cancel.dataset.cancel });
      state.pending.push(stored);
      ui.form = null;
      ui.msg = { tone: 'ok', text: 'The run comes off the board at the next run.' };
    } catch (err) {
      ui.msg = { tone: 'bad', text: err.message };
    }
    render();
    return;
  }

  // Reserve form quick-set: "1 day" = end == start; "5 business days" = start + 5bd.
  const quick = ev.target.closest('[data-quick]');
  if (quick) {
    const form = quick.closest('form.write');
    const start = form.querySelector('[name=start]').value || todayCentral();
    form.querySelector('[name=end]').value = quick.dataset.quick === '1' ? start : addBusinessDays(start, 5);
    updateWindowHint(form);
    return;
  }
  // Per-hold release: two taps (gloves), then a proposal like any other write.
  const rel = ev.target.closest('[data-release]');
  if (rel) {
    if (!rel.dataset.armed) { rel.dataset.armed = '1'; rel.textContent = 'Confirm release'; rel.classList.remove('ghost'); return; }
    rel.disabled = true;
    const serial = decodeURIComponent(window.location.hash.split('/').pop());
    try {
      const stored = await postEvent(ctx(), 'release', serial, { hold_id: rel.dataset.release });
      state.pending.push(stored);
      render();
    } catch (err) {
      rel.disabled = false; rel.dataset.armed = ''; rel.textContent = 'Release'; rel.classList.add('ghost');
      const msg = $('#write-msg'); if (msg) msg.innerHTML = html`<div class="alert">⚠️ ${err.message}</div>`;
    }
    return;
  }
  const openForm = ev.target.closest('[data-form]');
  if (openForm) {
    const serial = window.location.hash.split('/').pop();
    const u = unitBySerial(decodeURIComponent(serial));
    if (!u) return;
    const kind = openForm.dataset.form;
    // "Schedule delivery" is the same add-a-run sheet the Dispatch board uses,
    // pre-filled from the unit's placement (§4).
    const form = kind === 'reserve' ? reserveForm(u)
      : kind === 'dispatch' ? addRunForm(runPrefillForUnit(u, currentHold(u, todayCentral())))
      : kind === 'wo-open' ? woOpenForm(u)
      : kind === 'insp-open' ? inspPickForm(u)
      : readinessForm(u);
    $('#write-form').innerHTML = form;
    const el = $('#write-form form');
    if (el) applyConditionals(el);
    return;
  }
  if (ev.target.id === 'retry') refresh();
  if (ev.target.closest('#refresh')) {
    $('#refresh').classList.add('spin');
    refresh().finally(() => $('#refresh').classList.remove('spin'));
  }
});

document.addEventListener('input', (ev) => {
  // D67: a typed field on the inspection sheet — kept, and saved a moment later.
  const ifield = ev.target.closest && ev.target.closest('[data-ifield]');
  if (ifield) { onInspField(ifield, false); return; }
  // D62: typing in the Completed search redraws the list only — a full render()
  // would rebuild the input under the thumb and drop the keyboard.
  if (ev.target.id === 'completed-q') {
    ui.completedQuery = ev.target.value;
    const list = $('#completed-list');
    if (list) list.innerHTML = completedRows(serviceQueue(), ui.ticketFilter, serviceSummary());
    return;
  }
  const form = ev.target.closest('form.write');
  if (!form) return;
  if (form.dataset.action === 'reserve' && ['start', 'end'].includes(ev.target.name)) updateWindowHint(form);
  if (form.dataset.action === 'ticket_open') applyConditionals(form);
  if (form.dataset.action === 'dispatch_claim' && ['rig', 'date'].includes(ev.target.name)) updateRigHint(form);
});
/** The stack keys currently drawable — used to drop stops a filter just hid. */
function stackKeysOnScreen() {
  const { pins } = collect(state.snapshot);
  return new Set(stack(pins.filter((p) => ui.mapKinds.has(p.kind))).map((st) => st.key));
}

/** Add or remove a stop, in tap order. Nine is Google's ceiling, not ours. */
function toggleStop(key) {
  if (!key) return;
  const at = ui.mapStops.indexOf(key);
  if (at >= 0) ui.mapStops.splice(at, 1);
  else if (ui.mapStops.length >= MAX_STOPS) {
    ui.msg = { tone: 'bad', text: `Nine stops is the most a directions link can carry.` };
  } else {
    ui.mapStops.push(key);
  }
  render();
}

/**
 * A file came back from the camera or the Files picker.
 *
 * The File is captured into module state IMMEDIATELY, before any render: the
 * next render() rewrites the view's innerHTML, which destroys the <input> and
 * its `.files` list with it. Read it late and it is gone.
 */
document.addEventListener('change', async (ev) => {
  // D67: a field on the inspection sheet was left (or a dropdown picked) — save now.
  const ifield = ev.target.closest && ev.target.closest('[data-ifield]');
  if (ifield) { onInspField(ifield, true); return; }
  // D52: "Back to the shop" reshapes the directions URL — the shop becomes the
  // destination and every stop moves into the waypoints.
  const back = ev.target.closest('input[data-map="back"]');
  if (back) { ui.mapBackToShop = !!back.checked; render(); return; }

  const input = ev.target.closest('[data-doc-input]');
  if (input) {
    const file = input.files && input.files[0];
    input.value = '';                        // so picking the same file twice fires again
    if (!file) return;
    const record = input.dataset.record;
    const source = input.dataset.docInput;
    try {
      const prepared = await prepareFile(file, source, record);
      pendingPick = { record, source, ...prepared };
      ui.form = { kind: 'doc-kind', id: record, arg: null };
      ui.msg = null;
    } catch (err) {
      pendingPick = null;
      ui.form = null;
      ui.msg = { tone: 'bad', text: err && err.message ? err.message : "Couldn't read that file." };
    }
    render();
    return;
  }
  const form = ev.target.closest('form.write');
  if (form && form.dataset.action === 'dispatch_claim' && ['rig', 'date'].includes(ev.target.name)) updateRigHint(form);
});

/**
 * Build the event body for a form. Returns { serial, payload } — `serial` rides
 * at the top level whenever the write concerns a unit, so the existing
 * pending-badge-by-serial logic keeps working (§6).
 */
function eventBody(action, form, fd) {
  const s = (k) => {
    const v = fd.get(k);
    return v == null ? '' : String(v).trim();
  };
  const orNull = (k) => s(k) || null;

  if (action === 'reserve') {
    return { serial: form.dataset.serial,
      payload: { customer: s('customer'), purpose: s('purpose'), start: s('start'), end: s('end') } };
  }
  if (action === 'readiness') {
    return { serial: form.dataset.serial, payload: { readiness: s('readiness'), note: s('note') } };
  }
  if (action === 'ticket_open') {
    const wss = s('machine_owner') === 'WSS';
    const serial = wss ? orNull('serial') : null;
    const u = serial ? unitBySerial(serial) : null;
    return {
      serial,
      payload: {
        machine_owner: s('machine_owner'),
        serial,
        // Ours: name the machine from the snapshot so two techs describe it the
        // same way. Theirs: whatever they typed.
        equipment: wss ? (u ? `${u.brand || ''} ${u.model || ''}`.trim() : null) : (orNull('equipment')),
        // Pre-fill the customer from the unit when it's out; otherwise it's ours.
        customer: wss ? ((u && u.customer) || 'WSS') : s('customer'),
        issue: s('issue'),
        priority: s('priority'),
        site: orNull('site'),
        location: s('location'),
        intake_move: s('intake_move'),
        return_move: s('return_move'),
      },
    };
  }
  if (action === 'ticket_update') {
    // Only the keys being changed travel (§6). `data-mode` says which sheet it was.
    const payload = { ticket: form.dataset.id };
    for (const k of ['stage', 'note', 'assigned', 'scheduled', 'intake_move', 'return_move']) {
      const v = s(k);
      if (v) payload[k] = v;
    }
    const t = ticketById(form.dataset.id);
    return { serial: t && t.serial ? t.serial : null, payload };
  }
  if (action === 'dispatch_add') {
    const serial = orNull('serial');
    return {
      serial,
      payload: {
        kind: s('kind'), serial, ticket: form.dataset.ticket || null,
        what: s('what'), customer: orNull('customer'), address: orNull('address'),
        date: orNull('date'), note: orNull('note'),
      },
    };
  }
  if (action === 'dispatch_claim') {
    const r = dispatchById(dispatchRows(), form.dataset.id);
    return { serial: r && r.serial ? r.serial : null,
      payload: { dispatch_id: form.dataset.id, rig: s('rig'), date: s('date'), driver: s('driver') } };
  }
  if (action === 'dispatch_done') {
    const r = dispatchById(dispatchRows(), form.dataset.id);
    return { serial: r && r.serial ? r.serial : null,
      payload: { dispatch_id: form.dataset.id, note: orNull('note') } };
  }

  /* --------------------------------------------------------- schema 5 ---- */

  if (action === 'lead_open') {
    // The machine is EITHER free text OR one of ours (§3.3). `machine_mode` is
    // a form-only control and never travels; whichever side it hides sends null,
    // so a serial typed and then switched away from can't ride along.
    const unit = s('machine_mode') === 'UNIT';
    const serial = unit ? orNull('serial') : null;
    const u = serial ? unitBySerial(serial) : null;
    return {
      serial,
      payload: {
        customer: s('customer'),
        contact: orNull('contact'),
        phone: orNull('phone'),
        email: orNull('email'),
        site: orNull('site'),
        source: s('source'),
        interest: s('interest'),
        // Name one of ours from the snapshot so two people describe it the same
        // way; anything else is whatever they typed.
        machine: unit ? (u ? unitName(u) : null) : orNull('machine'),
        serial,
        value: null,
        priority: s('priority'),
        assigned: orNull('assigned'),
        next_action: orNull('next_action'),
        note: orNull('note'),
        related_ticket: null,
        machinio_ref: null,
      },
    };
  }
  if (action === 'lead_update') {
    // Only the keys being changed travel (§5). `data-mode` says which sheet.
    const payload = { lead: form.dataset.id };
    for (const k of ['stage', 'note', 'next_action', 'assigned', 'priority', 'demo_date', 'demo_serial', 'invoice', 'po']) {
      const v = s(k);
      if (v) payload[k] = v;
    }
    const val = s('value');
    if (val !== '') payload.value = Number(val);
    const l = leadById(leads(), form.dataset.id);
    return { serial: l && l.serial ? l.serial : null, payload };
  }
  if (action === 'lead_close') {
    const outcome = s('outcome');
    const l = leadById(leads(), form.dataset.id);
    return {
      serial: l && l.serial ? l.serial : null,
      // A DEAD lead has no reason to give — that IS the reason. Sending the
      // hidden LOST chip's value with it would put a why on a lead nobody chose.
      payload: { lead: form.dataset.id, outcome, reason: outcome === 'LOST' ? s('reason') : null, note: orNull('note') },
    };
  }
  if (action === 'work_order') return woEventBody(form, fd, s, orNull);
  if (action === 'rental_update') {
    // The id travels in the TYPE the snapshot gave it — an int stays an int, a
    // WSS-paper string stays a string (D59). The form only carries it as text,
    // so it is looked up again rather than parsed back out of the attribute.
    // No top-level serial: the contract keys this action on payload.agreement.
    const a = agreementByRoute(agreements(), form.dataset.id);
    return {
      serial: null,
      payload: {
        agreement: a ? a.agreement : form.dataset.id,
        action: form.dataset.verb,
        date: clampToToday(s('date'), todayCentral()),
        note: orNull('note'),
      },
    };
  }
  return { serial: null, payload: {} };
}

/**
 * D65: one action, six verbs. `serial` rides at the top level on OPEN only —
 * that is how the pending OPEN finds its unit before it has a W-number. Every
 * other verb is keyed on payload.work_order. No cost / rate / price key is ever
 * built here; the Worker would refuse it by name if one were.
 */
function woEventBody(form, fd, s, orNull) {
  const verb = form.dataset.verb;
  const wo = form.dataset.wo || null;
  if (verb === 'OPEN') {
    const payload = { action: 'OPEN', purpose: s('purpose'), note: orNull('note'), parts: woLines(fd) };
    // D67: opened from an inspection sheet — the engine links the two both ways.
    if (form.dataset.inspection) payload.inspection = form.dataset.inspection;
    return { serial: form.dataset.serial, payload };
  }
  if (verb === 'ADD-PARTS') return { serial: null, payload: { action: verb, work_order: wo, parts: woLines(fd) } };
  if (verb === 'PART-STATE') {
    const payload = { action: verb, work_order: wo, line: Number(form.dataset.line), state: form.dataset.state };
    for (const k of ['date', 'vendor', 'vendor_ref', 'tracking']) { const v = orNull(k); if (v) payload[k] = v; }
    payload.note = orNull('note');
    return { serial: null, payload };
  }
  if (verb === 'LABOR') {
    return { serial: null, payload: { action: verb, work_order: wo, date: orNull('date'), who: s('who'), hours: Number(s('hours')), note: orNull('note') } };
  }
  return { serial: null, payload: { action: verb, work_order: wo, note: orNull('note') } };
}
/** The typed lines, in order. A row with nothing typed is not a line. */
function woLines(fd) {
  const nums = fd.getAll('p_num');
  const mfrs = fd.getAll('p_mfr');
  const descs = fd.getAll('p_desc');
  const qtys = fd.getAll('p_qty');
  return nums.map((n, i) => ({
    manufacturer: String(mfrs[i] || 'OTHER'),
    part_number: String(n || '').trim(),
    description: String(descs[i] || '').trim() || null,
    qty: Number(qtys[i]),
  })).filter((l) => l.part_number || l.description);
}
/** What's wrong with a work-order form before it goes, or null. */
function woFormProblem(form, fd) {
  const verb = form.dataset.verb;
  const today = todayCentral();
  const date = String(fd.get('date') || '').trim();
  if (date && (!isDateStr(date) || date > today)) return 'That date is in the future — pick today or earlier.';
  if (verb === 'OPEN' || verb === 'ADD-PARTS') {
    const lines = woLines(fd);
    if (verb === 'ADD-PARTS' && !lines.length) return 'Put at least one part number in.';
    if (lines.some((l) => !l.part_number)) return 'Every line needs a part number.';
    if (lines.some((l) => !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 99)) return 'Quantity is a whole number, 1 to 99.';
    if (lines.length > MAX_LINES) return `${MAX_LINES} lines per tap — add the rest after the next run.`;
  }
  if (verb === 'LABOR' && !hoursValid(Number(fd.get('hours')))) return `Hours go in quarter hours, ${HOURS_MIN} to ${HOURS_MAX}.`;
  return null;
}
const WO_MSG = {
  OPEN: 'The engine assigns the W-number at the next run.',
  'ADD-PARTS': 'The lines appear at the next run.',
  'PART-STATE': 'The line moves at the next run.',
  LABOR: 'The hours land at the next run.',
  CLOSE: 'It closes at the next run.',
  CANCEL: 'It comes off the board at the next run.',
};

const SUBMIT_MSG = {
  ticket_open: 'The engine assigns the ticket number at the next run.',
  ticket_update: 'Applies at the next run.',
  dispatch_add: 'The run appears on the board at the next run.',
  dispatch_claim: 'The row moves to Scheduled at the next run.',
  dispatch_done: 'It clears at the next run.',
  lead_open: 'The engine assigns the lead number at the next run.',
  lead_update: 'Applies at the next run.',
  lead_close: 'It moves to Closed at the next run.',
};
// D64: one action, three verbs — say what each one will actually do.
const RENTAL_MSG = {
  OUT: 'It moves to On rent at the next run.',
  'OFF-RENT': 'The clock stops at the next run.',
  IN: 'It leaves the tab at the next run.',
};

// Writes opened from the unit page report into that page's #write-msg; the ones
// living inside a re-rendered Service/Dispatch view report through ui.msg.
const INLINE_MSG = new Set(['reserve', 'readiness']);
const isInline = (action, form) => INLINE_MSG.has(action) || !!form.closest('#write-form');

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form.write');
  if (!form) return;
  ev.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  const fd = new FormData(form);
  const action = form.dataset.action;
  if (action === 'reserve' && updateWindowHint(form)) return;   // only end<start / past windows block; overlaps never do
  if (action === 'inspection') { await submitInspection(form, fd, btn); return; }

  // A customer ticket needs a customer; a fleet one takes it from the unit.
  if (action === 'ticket_open' && fd.get('machine_owner') === 'CUSTOMER' && !String(fd.get('customer') || '').trim()) {
    const el = form.querySelector('[name=customer]');
    if (el) el.focus();
    ui.msg = { tone: 'bad', text: 'Who is it for? Put a customer on it.' };
    render();
    return;
  }
  // D64: the picker caps at today, but a typed date can still get past it. The
  // engine refuses a future date too — this just says so before the round trip.
  if (action === 'rental_update') {
    const date = String(fd.get('date') || '').trim();
    if (date && (!isDateStr(date) || date > todayCentral())) {
      ui.msg = { tone: 'bad', text: 'That date is in the future — pick today or earlier.' };
      render();
      return;
    }
  }
  // D65: say what's wrong before the round trip — the Worker refuses it anyway.
  if (action === 'work_order') {
    const problem = woFormProblem(form, fd);
    if (problem) {
      if (isInline(action, form)) {
        const msg = $('#write-msg');
        if (msg) msg.innerHTML = html`<div class="alert">⚠️ ${problem}</div>`;
      } else {
        ui.msg = { tone: 'bad', text: problem };
        render();
      }
      return;
    }
  }
  // A lead with no customer is a note to nobody.
  if (action === 'lead_open' && !String(fd.get('customer') || '').trim()) {
    const el = form.querySelector('[name=customer]');
    if (el) el.focus();
    ui.msg = { tone: 'bad', text: 'Who called? Put a customer on it.' };
    render();
    return;
  }

  btn.disabled = true;
  const inline = isInline(action, form);
  const { serial, payload } = eventBody(action, form, fd);

  try {
    const stored = await postEvent(ctx(), action, serial, payload);
    state.pending.push(stored);
    if (inline) {
      render();
      const msg = $('#write-msg');
      const text = action === 'work_order' ? WO_MSG[form.dataset.verb] : 'Applies at the next run.';
      if (msg) msg.innerHTML = html`<div class="note"><strong>Submitted</strong>${text}</div>`;
    } else {
      ui.form = null;
      ui.msg = { tone: 'ok', text: (action === 'rental_update' && RENTAL_MSG[form.dataset.verb])
        || (action === 'work_order' && WO_MSG[form.dataset.verb]) || SUBMIT_MSG[action] || 'Applies at the next run.' };
      render();
    }
  } catch (err) {
    if (inline) {
      const msg = $('#write-msg');
      if (msg) msg.innerHTML = html`<div class="alert">⚠️ ${err.message}</div>`;
      btn.disabled = false;
    } else {
      ui.msg = { tone: 'bad', text: err.message };
      render();
    }
  }
});

/**
 * D67 — Done / Void / Reopen on a sheet. Done saves whatever is still unsaved
 * FIRST (the engine applies in order, so the last section lands before the
 * lock), and refuses to go if that save failed.
 */
const INSP_MSG = {
  DONE: 'Done. The hours reach the unit at the next run.',
  VOID: 'The sheet goes away at the next run.',
  REOPEN: 'It goes back to DRAFT at the next run.',
};
async function submitInspection(form, fd, btn) {
  const verb = form.dataset.verb;
  const id = form.dataset.insp;
  const key = form.dataset.key;
  if (btn) btn.disabled = true;
  try {
    let payload;
    if (verb === 'DONE') {
      await flushSheet(key);
      const l = sheetLocal.get(key);
      if (l && (l.dirty.size || l.status === 'failed')) throw new Error("The last change didn't save — retry it, then Done.");
      payload = { action: 'DONE', inspection: id, tech: String(fd.get('tech') || '') || null };
    } else {
      payload = { action: verb, inspection: id, note: String(fd.get('note') || '').trim() || null };
    }
    const stored = await postEvent(ctx(), 'inspection', null, payload);
    state.pending.push(stored);
    ui.form = null;
    ui.msg = { tone: 'ok', text: INSP_MSG[verb] || 'Applies at the next run.' };
  } catch (err) {
    ui.msg = { tone: 'bad', text: err.message };
    if (btn) btn.disabled = false;
  }
  render();
}

// D67: a sheet with unsaved changes saves on the way out — a new route, the
// app going to the background, the tab closing. Best effort; the save line
// says so when it could not.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAllSheets(); });
window.addEventListener('pagehide', flushAllSheets);

window.addEventListener('hashchange', () => {
  flushAllSheets();
  ui.form = null; ui.msg = null; pendingPick = null;
  // The sheet is about one pin and does not survive a navigation. The VIEWPORT
  // does: coming back to the map should land where you left it, not re-home.
  ui.mapSheet = null;
  render();
});

// Service worker on real hosts only. On localhost a cached shell just makes you
// debug yesterday's CSS; iOS requires HTTPS for install anyway, so dev loses nothing.
const IS_LOCAL = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
if ('serviceWorker' in navigator && location.protocol === 'https:' && !IS_LOCAL) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[wss-fleet] sw:', e.message));
  });
} else if ('serviceWorker' in navigator && IS_LOCAL) {
  // Clean up a worker left behind by an earlier build on this port.
  navigator.serviceWorker.getRegistrations()
    .then((rs) => rs.forEach((r) => r.unregister()))
    .catch(() => {});
  if (window.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
}

refresh();

/* ------------------------------------------------------------ test seam --
 * tools/selftest-render.mjs imports this module and drives the REAL views in a
 * stub DOM, so a view that throws or renders "undefined" fails `npm test`
 * instead of a phone in a warehouse. Nothing in the page reads these. */
export { render as __render, refresh as __refresh };
export const __state = () => state;
export const __ui = () => ui;
export const __flushSheets = async () => { flushAllSheets(); for (const l of sheetLocal.values()) await l.chain; };
export const __sheetLocal = () => sheetLocal;
