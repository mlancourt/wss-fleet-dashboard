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
  fmtInstantCentral, hoursSince, fmtMoney, isDateStr,
} from './dates.js';
import { holdsOf, holdStatus, currentHold, futureHolds, findOverlaps, validateWindow, groupByDate } from './holds.js';
import { loadData, postEvent, deleteEvent, mockVariant, resolveApiBase } from './api.js';
import { utilizationFrom, statusBoard, recurringRevenue } from './metrics.js';
import {
  KINDS, RIGS, DRIVERS, STAGE_LABEL, MOVE_LABEL, SOURCE_GLYPH,
  stageOptions, columnize, pipeline, sortTickets, missingMoves, openCount, dispatchFor, dispatchById,
  sections as dispatchSections, rigClash, driverChoices, defaultDriver, canCancel, unbookedPickups,
} from './service.js';
import { logRows, pendingNotes } from './notes.js';
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
const BUILD = '2026-09-04-notes2';   // shown on gate screens so a phone report pins the build
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
const LEAD_FILTER_KEY = 'wss_fleet_lead_filter';
function storedLeadFilter() {
  try {
    const v = localStorage.getItem(LEAD_FILTER_KEY);
    return v === 'mine' || v === 'stale' || v === 'all' ? v : 'all';
  } catch (_) { return 'all'; }
}

const ui = {
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
};

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

function unitChips(u) {
  const p = pendingFor(u.serial);
  return html`<div class="chips">
    ${raw(chip(u.unit_state, STATE_CLASS[u.unit_state]))}
    ${showsReadiness(u) || u.readiness === 'NEEDS-PICKUP' ? raw(chip(readyLabel(u.readiness), READY_CLASS[u.readiness])) : ''}
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

  // Landing = utilization bar (D19) + category cards (D15). Nothing else.
  return html`<h1>Fleet</h1>${raw(utilBar())}${raw(cards.join(''))}`;
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
      ${raw(unitChips(u))}
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
      ${raw(kvRow('Hours', u.hours != null ? u.hours.toLocaleString('en-US') : '', 'num'))}
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
        ${raw(kvRow('Agreement', ag.agreement))}
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

    ${raw(actionsFor(u))}`;
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

/* ---- writes (proposals only) ---- */

function actionsFor(u) {
  // v2: holds are legal on any non-retired unit in any state (future holds on an out unit).
  const canReserve = canReserveRole() && u.unit_state !== 'RETIRED';
  const canReadiness = role() === 'service' || role() === 'owner';
  // Booking a truck is everyone's job (§4) — a run is a proposal like any other.
  const canMove = u.unit_state !== 'RETIRED';
  if (!canReserve && !canReadiness && !canMove) return '';

  // In mock mode the forms still open — the UI is reviewable — but submitting
  // is refused in postEvent(). Nothing fake ever enters the pending list.
  const mock = !!mockVariant(window.location.href);
  return html`
    <h2>Actions</h2>
    ${mock ? raw('<div class="info">Mock mode — the forms open, but submitting is refused until the Worker is live (M1).</div>') : ''}
    <div class="actions">
      ${canReserve ? raw(html`<button class="btn" type="button" data-form="reserve">${u.unit_state === 'AVAILABLE' ? 'Reserve this unit' : 'Reserve for later'}</button>`) : ''}
      ${canReadiness ? raw('<button class="btn ghost" type="button" data-form="readiness">Set readiness</button>') : ''}
      ${canMove ? raw('<button class="btn ghost" type="button" data-form="dispatch">Schedule delivery</button>') : ''}
    </div>
    <div id="write-form"></div>
    <div id="write-msg"></div>`;
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

function viewRentals() {
  const rows = agreements();
  // D21 headline, moved here from the retired Billing view (D39). It leads the
  // page: the first thing about rentals is what they are worth per cycle.
  if (!rows.length) return html`<h1>Rentals</h1>${raw(revenueCard())}${raw(emptyState('No agreements in this snapshot.'))}`;

  // Unbilled rentals and alerts first — those are the ones that cost money.
  const sorted = rows.slice().sort((a, b) => {
    const sev = (r) => (r.agreement == null ? 0 : (r.alerts && r.alerts.length ? 1 : 2));
    return sev(a) - sev(b) || String(a.customer || '').localeCompare(String(b.customer || ''));
  });

  const cards = sorted.map((a) => {
    const u = unitBySerial(a.serial);
    const cycles = a.cycles_max != null ? `${a.cycles_billed} of ${a.cycles_max}` : `${a.cycles_billed}`;
    return html`
      <div class="card">
        <div class="unit-row">
          <span class="unit-main">
            <span class="unit-title">${a.customer || 'Unknown customer'}</span>
            <span class="unit-loc">
              <a href="#/unit/${raw(encodeURIComponent(a.serial))}">#${a.serial}</a>
              ${u ? raw(html` · ${unitName(u)}`) : ''}${a.job_site ? raw(html` · ${a.job_site}`) : ''}
            </span>
          </span>
        </div>
        <dl class="kv" style="margin-top:10px">
          ${raw(kvRow('Agreement', a.agreement == null ? raw('<span class="none">none</span>') : a.agreement))}
          ${raw(kvRow('Cycle', `${a.cycle || '—'} · ${fmtMoney(a.cycle_rate)}`))}
          ${raw(kvRow('Cycles billed', cycles, 'num'))}
          ${raw(kvRow('Last invoice', a.last_invoice))}
          ${raw(kvRow('Next due', a.next_due ? fmtDateFull(a.next_due) : ''))}
        </dl>
        ${raw(rowAlerts(a))}
      </div>`;
  });

  return html`<h1>Rentals</h1>${raw(revenueCard())}
    <h2>Agreements</h2><div class="sub">${rows.length} agreements</div>${raw(cards.join(''))}`;
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
  return m.tone === 'bad'
    ? html`<div class="alert">⚠️ ${m.text}</div>`
    : html`<div class="note"><strong>Submitted</strong>${m.text}</div>`;
}

/** "⏳ pending" line for a row that has unapplied writes against it. */
function pendingLine(n) {
  return n ? html`<div class="row-pending">⏳ ${n} pending — applies at the next run</div>` : '';
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
    </section>`;
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
      ${raw(kvRow('In this stage since', `${fmtDateFull(t.stage_since)}${t.age_days != null ? ` · ${t.age_days}d old` : ''}`))}
      ${raw(kvRow('Getting it here', MOVE_LABEL[t.intake_move] || t.intake_move))}
      ${raw(kvRow('Getting it back', MOVE_LABEL[t.return_move] || t.return_move))}
      ${q ? raw(kvRow('Quote', `${q.number ? q.number + ' · ' : ''}${fmtMoney(q.amount)}${q.approved ? ' · approved ' + fmtDate(q.approved) : q.sent ? ' · sent ' + fmtDate(q.sent) : ''}`)) : ''}
      ${!q && t.quote != null ? raw(kvRow('Quote', fmtMoney(t.quote), 'num')) : ''}
      ${raw(kvRow('Parts', t.parts))}
      ${raw(kvRow('Machinio', t.machinio_ref))}
      ${t.closed ? raw(kvRow('Closed', fmtDateFull(t.closed))) : ''}
    </dl></div>

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

/* ============================================================== dispatch == */

function viewDispatch(highlight) {
  const all = dispatchRows();
  const s = dispatchSections(all);
  const adds = pendingDispatchAdds();
  const unbooked = unbookedPickups(pickupsList(), all);

  const head = html`<h1>Dispatch</h1>${raw(msgBlock())}
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
      <label for="df-note">Note (optional)</label>
      <textarea id="df-note" name="note" placeholder="hours on the meter, damage, who signed"></textarea>
      ${raw(sheetButtons('Mark it done'))}
    </form>`;
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
      <button class="btn sm ghost" type="button" data-sheet="add-run" data-serial="${h.serial}" data-hold="${h.id || ''}">Schedule delivery</button>
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
    <section class="kan-col" id="lead-col-${raw(enc(c.key))}">
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
        : raw('<span class="none">nobody has called yet</span>')))}
      ${raw(kvRow('In this stage since', l.stage_since ? fmtInstantCentral(l.stage_since) : ''))}
      ${raw(kvRow('Age', `${l.age_in_stage_days != null ? `${l.age_in_stage_days}d in stage` : ''}${l.age_in_stage_days != null && l.age_total_days != null ? ' · ' : ''}${l.age_total_days != null ? `${l.age_total_days}d total` : ''}`))}
      ${l.closed ? raw(kvRow('Closed', `${fmtDateFull(l.closed)}${l.close_reason ? ` · ${REASON_LABEL[l.close_reason] || l.close_reason}` : ''}`)) : ''}
      ${l.close_note ? raw(kvRow('Close note', l.close_note)) : ''}
    </dl></div>

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
 * The stage sheet. Three stages ask for something before they can be proposed
 * (stageNeeds): a demo needs a day and a machine, an invoice needs its number,
 * and a quote needs a value if we never wrote one down.
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
  const tab = route.startsWith('#/rentals') ? 'rentals'
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
  else if (section === 'holds') out = viewHolds();
  else if (section === 'dispatch') out = viewDispatch(arg ? decodeURIComponent(arg) : null);
  else if (section === 'service') out = viewService();
  else if (section === 'ticket') out = viewTicket(decodeURIComponent(arg || ''));
  else if (section === 'leads') out = viewLeads();
  else if (section === 'lead') out = viewLead(decodeURIComponent(arg || ''));
  else if (section === 'cat') out = viewCategory(decodeURIComponent(arg || ''));
  else if (section === 'unit') out = viewUnit(decodeURIComponent(arg || ''));
  else out = viewCategories();

  view.innerHTML = out;
  ui.msg = null;                 // the confirmation line shows once, then clears
  renderHeader();

  // Deep link from a ticket or a unit page: put the named run on screen rather
  // than dumping the reader at the top of a long board.
  const hot = arg && section === 'dispatch' ? $(`#d-${CSS.escape(decodeURIComponent(arg))}`) : null;
  if (hot) { hot.scrollIntoView({ block: 'center' }); return; }
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
  if (ev.target.closest('[data-sheet-close]')) { closeSheet(); return; }

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

  // Addresses copy, they do not navigate. No map links (§4).
  const addr = ev.target.closest('[data-copy]');
  if (addr) { copyText(addr.dataset.copy, addr); return; }

  // Undo: take back your own still-pending tap (D46). Unlike every other button
  // here this is NOT a proposal — the event never reaches the engine at all.
  const undo = ev.target.closest('[data-undo]');
  if (undo) {
    undo.disabled = true;
    const id = undo.dataset.undo;
    try {
      await deleteEvent(ctx(), id);
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
  const form = ev.target.closest('form.write');
  if (!form) return;
  if (form.dataset.action === 'reserve' && ['start', 'end'].includes(ev.target.name)) updateWindowHint(form);
  if (form.dataset.action === 'ticket_open') applyConditionals(form);
  if (form.dataset.action === 'dispatch_claim' && ['rig', 'date'].includes(ev.target.name)) updateRigHint(form);
});
document.addEventListener('change', (ev) => {
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
    for (const k of ['stage', 'note', 'next_action', 'assigned', 'priority', 'demo_date', 'demo_serial', 'invoice']) {
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
  return { serial: null, payload: {} };
}

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

  // A customer ticket needs a customer; a fleet one takes it from the unit.
  if (action === 'ticket_open' && fd.get('machine_owner') === 'CUSTOMER' && !String(fd.get('customer') || '').trim()) {
    const el = form.querySelector('[name=customer]');
    if (el) el.focus();
    ui.msg = { tone: 'bad', text: 'Who is it for? Put a customer on it.' };
    render();
    return;
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
      if (msg) msg.innerHTML = '<div class="note"><strong>Submitted</strong>Applies at the next run.</div>';
    } else {
      ui.form = null;
      ui.msg = { tone: 'ok', text: SUBMIT_MSG[action] || 'Applies at the next run.' };
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

window.addEventListener('hashchange', () => { ui.form = null; ui.msg = null; render(); });

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
