/* WSS Fleet — app shell.
 *
 * Reads a dashboard-data snapshot (schema_version 1) and renders it.
 * ZERO data lives in this repo: the snapshot comes from the Worker at runtime,
 * or from docs/mock/*.json in mock mode (fake data only).
 *
 * Two rules this file exists to not break:
 *   1. Business dates are date-only Central strings. NEVER new Date("YYYY-MM-DD")
 *      — JS reads that as UTC midnight and Central users see yesterday.
 *      All date-only handling below is string surgery. See fmtDate/addBusinessDays.
 *   2. Writes are proposals. A submitted event renders as "pending", never as
 *      if the vault had already accepted it.
 */

import {
  fmtDate, fmtDateFull, fmtRange, todayCentral, addBusinessDays,
  fmtInstantCentral, hoursSince, fmtMoney,
} from './dates.js';
import { holdsOf, holdStatus, currentHold, futureHolds, findOverlaps, validateWindow, groupByDate } from './holds.js';
import { loadData, postEvent, mockVariant, resolveApiBase } from './api.js';
import { utilization, statusBoard, recurringRevenue } from './metrics.js';

/* ============================================================ 1. config ==== */

// The Worker origin (API_BASE) lives in docs/api.js.
const BUILD = '2026-09-02g';   // shown on gate screens so a phone report pins the build
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
  source: null,      // 'mock:full' | 'mock:empty' | 'api'
  loading: false,
  explainedPending: false,
};

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
const categories = () => (state.snapshot && state.snapshot.categories) || [];
const billing = () => (state.snapshot && state.snapshot.billing) || {};

/** Display name: brand + model ("Factory Cat Model 34"). asset_item is an identifier, shown on the sub-line.
 *  A trailing model year ("MODEL 34 2026") is dropped from the name only — the full
 *  model string still shows in the detail card. Display rule, not a data change. */
const stripYear = (m) => String(m || '').replace(/\s+(19|20)\d{2}\s*$/, '').trim();
const unitName = (u) => [u.brand, stripYear(u.model)].filter(Boolean).join(' ') || u.asset_item || 'Unit';
/** Sub-line identifiers: "#serial · A-1042" (asset # only when present). */
const unitIds = (u) => [`#${u.serial}`, u.asset_item].filter(Boolean).join(' · ');

const unitBySerial = (s) => units().find((u) => String(u.serial) === String(s)) || null;
const pendingFor = (serial) => state.pending.filter((e) => String(e.serial) === String(serial));
const pendingReleases = (serial, holdId) => pendingFor(serial).filter((e) => e.action === 'release' && e.payload && e.payload.hold_id === holdId);
const pendingReserves = (serial) => pendingFor(serial).filter((e) => e.action === 'reserve');

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
const READY_CLASS = { READY: 'ok', 'NEEDS-PREP': 'warn', DOWN: 'bad' };

const chip = (text, cls) => html`<span class="chip ${cls || ''}">${text}</span>`;

function unitChips(u) {
  const p = pendingFor(u.serial);
  return html`<div class="chips">
    ${raw(chip(u.unit_state, STATE_CLASS[u.unit_state]))}
    ${showsReadiness(u) ? raw(chip(u.readiness, READY_CLASS[u.readiness])) : ''}
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
    // Non-breaking space: a segment ("2 on rent") wraps as a unit, only at the separators.
    const n = (v, label) => html`<span class="${v ? 'n' : 'zero'}">${v}</span>&nbsp;${raw(label.replace(/ /g, '&nbsp;'))}`;
    return html`
      <a class="card cat-card" href="#/cat/${raw(encodeURIComponent(cat))}">
        ${light(c.ready)}
        <span class="cat-body">
          <span class="cat-name">${cat}</span>
          <span class="cat-sub">
            ${raw(n(c.ready, 'ready'))}<span class="sep">·</span>${raw(n(c.prep, 'in prep'))}<span class="sep">·</span>${raw(n(c.down, 'down'))}<span class="sep">·</span>${raw(n(c.reserved, 'reserved'))}<span class="sep">·</span><span class="rent">${raw(n(c.onRent, 'on rent'))}</span>
          </span>
        </span>
        ${CHEV}
      </a>`;
  });

  // Landing = utilization bar (D19) + category cards (D15). Nothing else.
  return html`<h1>Fleet</h1>${raw(utilBar())}${raw(cards.join(''))}`;
}

/** Fleet-utilization bar (D19). The word label is mandatory: two bands are red. */
function utilBar() {
  const u = utilization(units());
  if (u.pct == null) return '';
  return html`
    <section class="util util-${u.color}" aria-label="Fleet utilization ${u.pct}% — ${u.label}">
      <div class="util-row">
        <span class="util-t">Fleet utilization</span>
        <span class="util-v"><strong>${u.pct}%</strong><span class="util-l">${u.label}</span></span>
      </div>
      <div class="util-track"><div class="util-fill" style="width:${u.pct}%"></div></div>
      <div class="util-s">${u.onRent} of ${u.denom} rental units on rent</div>
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
    const cur = currentHold(u, todayCentral());
    const loc = u.job_site || (cur && cur.customer ? `held for ${cur.customer}` : 'shop');
    return html`
      <a class="card unit-row" href="#/unit/${raw(encodeURIComponent(u.serial))}">
        <span class="unit-main">
          <span class="unit-title">${unitName(u)}</span>
          <span class="unit-loc"><span class="unit-serial">${unitIds(u)}</span> · ${loc}</span>
          ${raw(unitChips(u).replace('</div>', calChip(u) + '</div>'))}
        </span>
        ${CHEV}
      </a>`;
  });

  return html`
    <a class="crumb" href="#/">‹ Fleet</a>
    <h1>${light(c.ready)}${cat}</h1>
    <div class="sub">${c.ready} ready · ${c.prep} in prep · ${c.down} down · ${c.reserved} reserved · <span class="rent">${c.onRent} on rent</span></div>
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

  const pendingLine = (e) => e.action === 'reserve'
    ? html`<div>⏳ hold pending — ${e.payload && e.payload.customer ? e.payload.customer + ', ' : ''}${fmtRange(e.payload && e.payload.start, e.payload && (e.payload.end || e.payload.until))} by ${e.actor || 'someone'}</div>`
    : html`<div>${e.action} by ${e.actor || 'someone'}</div>`;
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
      ${raw(kvRow('Location', u.job_site))}
      ${raw(kvRow('Service ticket', u.service_ticket))}
    </dl></div>

    <h2>Money</h2>
    <div class="card"><dl class="kv">
      ${raw(kvRow('Acquisition cost', fmtMoney(u.acquisition_cost), 'num'))}
      ${raw(kvRow('Book', fmtMoney(u.book), 'num'))}
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
      <div class="info">Loaner out on agreement ${u.agreement}. Loaners carry no billing row — that's expected, not a missing record.</div>`) : ''}

    ${u.unit_state === 'ON-DEMO' ? raw(html`
      <h2>Placement</h2><div class="info">Out on demo. No agreement.</div>`) : ''}

    ${raw(actionsFor(u))}`;
}

/* ---- holds (v2): the list is the calendar; the chip is the state ---- */

const canReserveRole = () => ['sales', 'owner'].includes((state.me && state.me.role) || '');

function holdsSection(u) {
  const holds = holdsOf(u);
  const canRelease = canReserveRole();
  const rows = holds.map((h) => {
    const rel = pendingReleases(u.serial, h.id);
    return html`
      <div class="hrow hold-${holdStatus(h, todayCentral())}">
        <div class="hold-top">
          <span class="hold-win">${fmtRange(h.start, h.end)}</span>
          ${raw(holdPill(h))}
        </div>
        <div class="hold-who">${h.customer || '—'}${h.purpose ? raw(html` · ${h.purpose}`) : ''}</div>
        <div class="hold-meta">held by ${h.held_by || '—'}${h.created ? raw(html` · placed ${fmtDate(h.created)}`) : ''}</div>
        ${rel.length ? raw('<div class="hold-pending">⏳ release pending — applies at the next run</div>') : ''}
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
  const role = (state.me && state.me.role) || '';
  // v2: holds are legal on any non-retired unit in any state (future holds on an out unit).
  const canReserve = canReserveRole() && u.unit_state !== 'RETIRED';
  const canReadiness = role === 'service' || role === 'owner';
  if (!canReserve && !canReadiness) return '';

  // In mock mode the forms still open — the UI is reviewable — but submitting
  // is refused in postEvent(). Nothing fake ever enters the pending list.
  const mock = !!mockVariant(window.location.href);
  return html`
    <h2>Actions</h2>
    ${mock ? raw('<div class="info">Mock mode — the forms open, but submitting is refused until the Worker is live (M1).</div>') : ''}
    <div class="actions">
      ${canReserve ? raw(html`<button class="btn" type="button" data-form="reserve">${u.unit_state === 'AVAILABLE' ? 'Reserve this unit' : 'Reserve for later'}</button>`) : ''}
      ${canReadiness ? raw('<button class="btn ghost" type="button" data-form="readiness">Set readiness</button>') : ''}
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
  const opt = (v) => html`<option value="${v}"${v === u.readiness ? raw(' selected') : ''}>${v}</option>`;
  return html`
    <form class="write" data-action="readiness" data-serial="${u.serial}">
      <label for="f-ready">Readiness</label>
      <select id="f-ready" name="readiness">
        ${raw(['READY', 'NEEDS-PREP', 'DOWN'].map(opt).join(''))}
      </select>
      <label for="f-note">Note</label>
      <textarea id="f-note" name="note" placeholder="what's wrong / what it needs"></textarea>
      <div class="actions"><button class="btn" type="submit">Submit readiness</button></div>
      <div class="form-note">This is a proposal. It shows as pending until the next run applies it.</div>
    </form>`;
}

/* ---- rentals / billing / service ---- */

function viewRentals() {
  const rows = agreements();
  if (!rows.length) return html`<h1>Rentals</h1>${raw(emptyState('No agreements in this snapshot.'))}`;

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

  return html`<h1>Rentals</h1><div class="sub">${rows.length} agreements</div>${raw(cards.join(''))}`;
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

function viewBilling() {
  const b = billing();
  const due = b.due_next_7_days || [];
  const made = b.created_last_run || [];

  const dueRows = due.map((x) => html`
    <div class="card">
      <div class="unit-row"><span class="unit-main">
        <span class="unit-title">${x.customer || '—'}</span>
        <span class="unit-loc">Agreement ${x.agreement ?? '—'} ·
          <a href="#/unit/${raw(encodeURIComponent(x.serial))}">#${x.serial}</a></span>
      </span></div>
      <dl class="kv" style="margin-top:10px">
        ${raw(kvRow('Amount', fmtMoney(x.amount), 'num'))}
        ${raw(kvRow('Due', fmtDateFull(x.due)))}
      </dl>
    </div>`);

  const madeRows = made.map((x) => html`
    <div class="card">
      <div class="unit-row"><span class="unit-main">
        <span class="unit-title">${x.customer || '—'}</span>
        <span class="unit-loc">Invoice ${x.invoice} · agreement ${x.agreement ?? '—'}</span>
      </span></div>
      <dl class="kv" style="margin-top:10px">
        ${raw(kvRow('Amount', fmtMoney(x.amount), 'num'))}
        ${raw(kvRow('Period', `${fmtDate(x.period_start)} – ${fmtDateFull(x.period_end)}`))}
      </dl>
    </div>`);

  return html`
    <h1>Cycle (Periodic) Invoicing</h1>
    <div class="sub">Units on rent for 1+ months.</div>
    ${raw(revenueCard())}
    <h2>Due next 7 days</h2>
    ${due.length ? raw(dueRows.join('')) : raw(emptyState('Nothing due in the next 7 days.'))}
    <h2>Created last run</h2>
    ${made.length ? raw(madeRows.join('')) : raw(emptyState('No invoices created on the last run.'))}
    ${made.length ? raw('<div class="form-note">Created last night — awaiting Matt.</div>') : ''}`;
}

const STAGES = ['INTAKE', 'DIAGNOSED', 'AWAITING-PARTS', 'IN-PROGRESS', 'READY-TO-INVOICE', 'DONE'];

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

function viewService() {
  const q = serviceQueue();
  if (!q.length) {
    return html`<h1>Service</h1>${raw(boardView())}${raw(emptyState('Service queue is empty.',
      'Tickets appear here once the service module starts publishing.'))}`;
  }

  // Any stage the engine sends that we don't know about still gets a column.
  const stages = STAGES.concat(q.map((t) => t.stage).filter((s) => s && !STAGES.includes(s)));
  const cols = [...new Set(stages)].map((stage) => {
    const tix = q.filter((t) => t.stage === stage);
    const cards = tix.map((t) => html`
      <div class="kan-card">
        <div class="kan-t">${t.customer || '—'}</div>
        <div class="kan-s">${t.unit_desc || '—'}</div>
        <div class="kan-s">${t.ticket_id}${t.assigned ? raw(html` · ${t.assigned}`) : ''} · opened ${fmtDate(t.opened)}</div>
        ${t.serial ? raw(html`<div class="kan-s"><a href="#/unit/${raw(encodeURIComponent(t.serial))}">#${t.serial}</a></div>`) : ''}
        ${t.quote != null ? raw(html`<div class="kan-s">Quote ${fmtMoney(t.quote)}</div>`) : ''}
        ${t.machinio_ref ? raw(html`<div class="kan-s">${t.machinio_ref}</div>`) : ''}
      </div>`);
    return html`<section class="kan-col">
      <div class="kan-head"><span>${stage}</span><span class="c">${tix.length}</span></div>
      ${tix.length ? raw(cards.join('')) : raw('<div class="kan-empty">nothing here</div>')}
    </section>`;
  });

  return html`<h1>Service</h1>${raw(boardView())}<div class="kanban">${raw(cols.join(''))}</div>`;
}

/* ---- holds view (v2): expired first and loud, then upcoming by date ---- */

function viewHolds() {
  const r = holdsRollup();
  const unitLink = (h) => html`<a href="#/unit/${raw(encodeURIComponent(h.serial))}"><span class="unit-serial">#${h.serial}</span>${h.model ? raw(html` ${h.model}`) : ''}</a>`;
  const row = (h, withPill) => html`
    <div class="hrow">
      <div class="hold-top"><span class="hold-win">${fmtRange(h.start, h.end)}</span>${withPill ? raw(holdPill(h)) : ''}</div>
      <div class="hold-who">${raw(unitLink(h))}</div>
      <div class="hold-meta">${h.customer || '—'}${h.purpose ? raw(html` · ${h.purpose}`) : ''} · held by ${h.held_by || '—'}</div>
    </div>`;

  if (!r.expired.length && !r.upcoming.length) return html`<h1>Holds</h1>${raw(emptyState('Nothing on hold.'))}`;

  const expired = r.expired.length ? html`
    <h2 class="danger">Expired holds — release or extend</h2>
    <div class="card holds danger">${raw(r.expired.map((h) => row({ ...h, status: 'expired' }, true)).join(''))}</div>` : '';

  const groups = groupByDate(r.upcoming).map((g) => html`
    <h2>${g.date ? fmtDateFull(g.date) : 'Unknown date'}</h2>
    <div class="card holds">${raw(g.items.map((h) => row(h, true)).join(''))}</div>`);

  return html`<h1>Holds</h1>
    <div class="sub">${r.upcoming.length} upcoming${r.expired.length ? raw(html` · <span class="none">${r.expired.length} expired</span>`) : ''}</div>
    ${raw(expired)}${raw(groups.join(''))}`;
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
    : route.startsWith('#/billing') ? 'billing'
    : route.startsWith('#/service') ? 'service' : 'fleet';
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('on', el.dataset.tab === tab));
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

  let out;
  if (section === 'rentals') out = viewRentals();
  else if (section === 'holds') out = viewHolds();
  else if (section === 'billing') out = viewBilling();
  else if (section === 'service') out = viewService();
  else if (section === 'cat') out = viewCategory(decodeURIComponent(arg || ''));
  else if (section === 'unit') out = viewUnit(decodeURIComponent(arg || ''));
  else out = viewCategories();

  view.innerHTML = out;
  renderHeader();
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

// Delegated events — the view is re-rendered wholesale, so nothing binds directly.
document.addEventListener('click', async (ev) => {
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
    $('#write-form').innerHTML = openForm.dataset.form === 'reserve' ? reserveForm(u) : readinessForm(u);
    return;
  }
  if (ev.target.id === 'retry') refresh();
  if (ev.target.closest('#refresh')) {
    $('#refresh').classList.add('spin');
    refresh().finally(() => $('#refresh').classList.remove('spin'));
  }
});

document.addEventListener('input', (ev) => {
  const form = ev.target.closest('form.write[data-action=reserve]');
  if (form && ['start', 'end'].includes(ev.target.name)) updateWindowHint(form);
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form.write');
  if (!form) return;
  ev.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  const fd = new FormData(form);
  const action = form.dataset.action;
  if (action === 'reserve' && updateWindowHint(form)) return;   // only end<start / past windows block; overlaps never do
  btn.disabled = true;
  const payload = action === 'reserve'
    ? { customer: fd.get('customer'), purpose: fd.get('purpose') || '', start: fd.get('start'), end: fd.get('end') }
    : { readiness: fd.get('readiness'), note: fd.get('note') || '' };

  try {
    const stored = await postEvent(ctx(), action, form.dataset.serial, payload);
    state.pending.push(stored);
    render();
    const msg = $('#write-msg');
    if (msg) msg.innerHTML = '<div class="note"><strong>Submitted</strong>Applies at the next run.</div>';
  } catch (err) {
    const msg = $('#write-msg');
    if (msg) msg.innerHTML = html`<div class="alert">⚠️ ${err.message}</div>`;
    btn.disabled = false;
  }
});

window.addEventListener('hashchange', render);

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
