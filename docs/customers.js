/* D115 (2026-10-20) — Customers: the pure rules behind #/customers and #/customer/<id>.
 *
 * The engine (the stack's ONE QuickBooks client) pushes an index + one card per customer
 * to the Worker; this module searches the index, keeps the recent list, words a card and
 * finds the Tracker records that belong to the same customer. No DOM, no fetch — so
 * tools/selftest-customers.mjs can drive it.
 *
 * Money here is what the CUSTOMER paid (an invoice total). D128 (2026-11-09): it reaches owner · sales ·
 * service whole — Matt's 12:08 ruling, the only figures off a service token are commissions and a card has
 * none; intake is 403. Nothing in a card is ever our cost.
 *
 * D128 also makes the box find OUR machines (searchUnits, over the snapshot the page already holds — no
 * fetch) and gives a customer ticket its one-tap way to the card (ticketCustomerLink).
 */

export const SEARCH_LIMIT = 25;
export const RECENT_MAX = 5;
export const RECENT_KEY = 'wss.customers.recent';
export const INDEX_KEY = 'wss.customers.index';
export const INDEX_TTL_MS = 24 * 3600 * 1000;
export const RECHECK_MS = 5 * 60 * 1000;   // the D109 rule: a cached index draws at once, the server is asked again after 5 min

const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,234.56" — invoices carry cents; "—" for anything that isn't a number. */
export function fmtCents(n) {
  return typeof n === 'number' && isFinite(n) ? usd2.format(n) : '—';
}

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** The composer's rule: every typed word must appear somewhere in name · company · city. Top N, name order kept. */
export function searchCustomers(index, query, limit = SEARCH_LIMIT) {
  const rows = index && Array.isArray(index.customers) ? index.customers : [];
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const c of rows) {
    if (!c || typeof c !== 'object') continue;
    const hay = fold(`${c.name || ''} ${c.company || ''} ${c.city || ''}`);
    if (words.every((w) => hay.includes(w))) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export const UNIT_LIMIT = 10;
export const UNIT_MIN_CHARS = 3;

/**
 * D128 — our machines by serial / asset # / brand · model. Over non-RETIRED `units[]`:
 * a hit when the folded query is a PREFIX of `serial` or `asset_item` (≥ 3 chars), or every word of it appears
 * in `brand · model · asset_item · serial` (the composer's rule). Below 3 chars nothing — "1" would claim the fleet.
 * Order: exact serial, then prefix hits, then word hits; serial breaks ties. Top 10.
 */
export function searchUnits(query, units, limit = UNIT_LIMIT) {
  const q = fold(query).trim();
  if (q.length < UNIT_MIN_CHARS || !Array.isArray(units)) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const u of units) {
    if (!u || typeof u !== 'object' || u.serial == null || u.unit_state === 'RETIRED') continue;
    const serial = fold(u.serial);
    const asset = fold(u.asset_item);
    let rank = -1;
    if (serial === q) rank = 0;
    else if (serial.startsWith(q) || (asset && asset.startsWith(q))) rank = 1;
    else {
      const hay = fold(`${u.brand || ''} ${u.model || ''} ${u.asset_item || ''} ${u.serial}`);
      if (words.every((w) => hay.includes(w))) rank = 2;
    }
    if (rank >= 0) scored.push([rank, String(u.serial), u]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return scored.slice(0, limit).map((x) => x[2]);
}

/** A recent row's kind: D128 unit rows say so; a D115 row (no kind) is a customer. */
export const recentKind = (r) => (r && r.kind === 'unit' ? 'unit' : 'customer');
const recentKey = (r) => (recentKind(r) === 'unit' ? `u:${r.serial}` : `c:${r.id}`);

/**
 * The recent list, newest first, de-duplicated, capped. `prev` is whatever was stored (tolerates junk).
 * D115 rows `{id, name, city}` are customers; D128 adds `{kind: "unit", serial, label}` beside them (same key, same cap).
 */
export function pushRecent(prev, hit, max = RECENT_MAX) {
  const list = Array.isArray(prev)
    ? prev.filter((r) => r && typeof r === 'object' && (recentKind(r) === 'unit' ? r.serial != null : r.id != null))
    : [];
  let row = null;
  if (hit && hit.kind === 'unit' && hit.serial != null) row = { kind: 'unit', serial: String(hit.serial), label: hit.label || '' };
  else if (hit && hit.kind !== 'unit' && hit.id != null) row = { id: String(hit.id), name: hit.name || '', city: hit.city || null };
  if (!row) return list.slice(0, max);
  const key = recentKey(row);
  return [row, ...list.filter((r) => recentKey(r) !== key)].slice(0, max);
}

/** PAID · OPEN · VOID → the chip's words + tone. */
export function docStatus(d) {
  const s = d && typeof d.status === 'string' ? d.status.toUpperCase() : '';
  if (s === 'VOID') return { label: 'void', tone: 'void' };
  if (s === 'OPEN') return { label: 'open', tone: 'open' };
  if (s === 'PAID') return { label: 'paid', tone: 'paid' };
  return { label: s ? s.toLowerCase() : '', tone: '' };
}

export const DOC_LABEL = { INVOICE: 'INV', 'SALES-RECEIPT': 'RCPT' };

/** "INV 44115" — the doc type short-labelled before its number. Numbers are opaque strings. */
export function docTitle(d) {
  const t = d && typeof d.type === 'string' ? d.type.toUpperCase() : '';
  return `${DOC_LABEL[t] || t || 'DOC'} ${d && d.num != null ? d.num : '—'}`.trim();
}

/** The sales line under the card header. */
export function salesCaption(card) {
  if (!card || !card.sales_count) return 'No invoices in QuickBooks yet.';
  const n = card.sales_count;
  const bits = [`${n} sale${n === 1 ? '' : 's'}`];
  if (card.first_sale) bits.push(`first ${card.first_sale}`);
  if (card.last_sale) bits.push(`last ${card.last_sale}`);
  return bits.join(' · ');
}

const norm = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The Tracker's own records for this customer, matched AS TEXT on the customer field (D59's rule — there is no
 * customer id anywhere in the snapshot). Exact fold-match on the QBO display name or company; never a substring,
 * so "Acme" does not claim "Acme Foods" and "Acme Dental" both.
 */
export function onTracker(snapshot, card) {
  const names = new Set([card && card.name, card && card.company].map(norm).filter(Boolean));
  if (!names.size || !snapshot) return { tickets: [], agreements: [], parts: [], leads: [] };
  const hit = (v) => names.has(norm(v));
  const pick = (list, f) => (Array.isArray(list) ? list.filter((r) => r && hit(f(r))) : []);
  return {
    tickets: pick(snapshot.service_queue, (t) => t.customer).filter((t) => t.status !== 'CLOSED'),
    agreements: pick(snapshot.agreements, (a) => a.customer),
    parts: pick(snapshot.parts_orders, (p) => p.customer).filter((p) => p.status === 'OPEN'),
    leads: pick(snapshot.leads, (l) => l.customer).filter((l) => l.status === 'OPEN' || !l.status),
  };
}

/** D128 — index rows whose name or company fold-matches `name` EXACTLY (D59 as-text; never a substring). */
export function customerMatches(index, name) {
  const want = norm(name);
  const rows = index && Array.isArray(index.customers) ? index.customers : [];
  if (!want) return [];
  return rows.filter((c) => c && c.id != null && (norm(c.name) === want || norm(c.company) === want));
}

/**
 * D128 — the ticket's 📇 Customer history row. Only a CUSTOMER-owned ticket, only an exact match:
 * 0 (or no index yet) → null · 1 → the card · 2+ → the lookup pre-filled with the ticket's customer.
 */
export function ticketCustomerLink(ticket, index) {
  if (!ticket || ticket.machine_owner !== 'CUSTOMER' || !index) return null;
  const hits = customerMatches(index, ticket.customer);
  if (!hits.length) return null;
  if (hits.length === 1) return { href: `#/customer/${encodeURIComponent(hits[0].id)}`, label: '📇 Customer history', count: 1 };
  return { href: `#/customers?q=${encodeURIComponent(ticket.customer)}`, label: `📇 Customer history (${hits.length} matches)`, count: hits.length };
}
