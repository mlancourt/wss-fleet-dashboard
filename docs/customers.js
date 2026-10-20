/* D115 (2026-10-20) — Customers: the pure rules behind #/customers and #/customer/<id>.
 *
 * The engine (the stack's ONE QuickBooks client) pushes an index + one card per customer
 * to the Worker; this module searches the index, keeps the recent list, words a card and
 * finds the Tracker records that belong to the same customer. No DOM, no fetch — so
 * tools/selftest-customers.mjs can drive it.
 *
 * Money here is what the CUSTOMER paid (an invoice total). It reaches sales + owner only —
 * the Worker 403s every other role — and nothing in a card is ever our cost.
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

/** The recent list, newest first, de-duplicated by id, capped. `prev` is whatever was stored (tolerates junk). */
export function pushRecent(prev, hit, max = RECENT_MAX) {
  const list = Array.isArray(prev) ? prev.filter((r) => r && typeof r === 'object' && r.id != null) : [];
  if (!hit || hit.id == null) return list.slice(0, max);
  const id = String(hit.id);
  return [{ id, name: hit.name || '', city: hit.city || null }, ...list.filter((r) => String(r.id) !== id)].slice(0, max);
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
