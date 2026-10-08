/* D83 — a sent quote's status, shared by the Worker (the live overlay on
 * GET /api/data) and the page (chips). Pure.
 *
 * The rank is the spec's: VIEWED outranks DELIVERED, EXPIRED outranks both.
 * BOUNCED sits under VIEWED — a customer who opened the PDF got the email,
 * whatever a stray bounce on the Bcc says.
 */

export const QUOTE_STATUSES = ['SENT', 'DELIVERED', 'BOUNCED', 'VIEWED', 'EXPIRED'];
const RANK = { SENT: 0, DELIVERED: 1, BOUNCED: 2, VIEWED: 3, EXPIRED: 4 };
export const statusRank = (s) => (Object.prototype.hasOwnProperty.call(RANK, s) ? RANK[s] : -1);
const higher = (a, b) => (statusRank(b) > statusRank(a) ? b : a);

/** The 32-hex token out of a quote's `pdf` path ("/q/<token>.pdf"), or null. */
export function tokenOf(q) {
  const m = /\/q\/([0-9a-f]{32})\.pdf$/.exec(String((q && q.pdf) || ''));
  return m ? m[1] : null;
}

const earliest = (a, b) => (!a ? b || null : !b ? a : (String(a) <= String(b) ? a : b));

/**
 * Merge the Worker's live stamps over a snapshot quote. Never moves a status
 * DOWN (the snapshot's EXPIRED stands), never invents money, never mutates.
 */
export function overlayQuote(q, st) {
  if (!q || typeof q !== 'object' || !st || typeof st !== 'object') return q;
  const out = { ...q };
  out.delivered_at = earliest(q.delivered_at, st.delivered_at);
  out.bounced_at = earliest(q.bounced_at, st.bounced_at);
  if (!q.bounce_reason && st.bounce_reason) out.bounce_reason = st.bounce_reason;
  out.opened_at = earliest(q.opened_at, st.opened_at);
  out.viewed_at = earliest(q.viewed_at, st.viewed_at);
  const n = Math.max(Number(q.viewed_count) || 0, Number(st.viewed_count) || 0);
  out.viewed_count = n;
  let s = QUOTE_STATUSES.includes(q.status) ? q.status : 'SENT';
  if (out.delivered_at) s = higher(s, 'DELIVERED');
  if (out.bounced_at) s = higher(s, 'BOUNCED');
  if (out.viewed_at || n > 0) s = higher(s, 'VIEWED');
  out.status = s;
  return out;
}

/** Apply a {token: stamps} map to every lead's `quote` and `quotes[]` in place. → leads touched. */
export function overlayLeads(leads, stamps) {
  if (!Array.isArray(leads) || !stamps) return 0;
  let n = 0;
  for (const l of leads) {
    if (!l || typeof l !== 'object') continue;
    const one = (q) => {
      const t = tokenOf(q);
      return t && stamps[t] ? overlayQuote(q, stamps[t]) : q;
    };
    const before = JSON.stringify([l.quote, l.quotes]);
    if (l.quote && typeof l.quote === 'object') l.quote = one(l.quote);
    if (Array.isArray(l.quotes)) l.quotes = l.quotes.map(one);
    if (JSON.stringify([l.quote, l.quotes]) !== before) n++;
  }
  return n;
}

const MD_CT = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric' }) : null;

/** An instant ("2026-10-09T08:14:00-05:00" / Z) → "10/9" in Central; a date-only string by surgery. */
export function mdOf(v) {
  const s = String(v || '');
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return `${Number(d[2])}/${Number(d[3])}`;
  const t = Date.parse(s);
  if (!s || !isFinite(t) || !MD_CT) return '';
  return MD_CT.format(new Date(t));
}

const MON_DAY_CT = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }) : null;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 9" — an instant in Central, a date-only string by surgery. */
export function monDayOf(v) {
  const s = String(v || '');
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return `${MON[Number(d[2]) - 1]} ${Number(d[3])}`;
  const t = Date.parse(s);
  if (!s || !isFinite(t) || !MON_DAY_CT) return '';
  return MON_DAY_CT.format(new Date(t));
}

/** The Quotes-section state words, longer form: "Viewed Oct 9 (2×)", "Bounced (mailbox full)". */
export function quoteStateLong(q) {
  if (!isTracked(q)) return '';
  if (q.status === 'EXPIRED') return 'Expired';
  if (q.status === 'VIEWED' || q.viewed_at) {
    const n = Number(q.viewed_count) || 0;
    return `Viewed ${monDayOf(q.viewed_at)}${n > 1 ? ` (${n}×)` : ''}`.replace(/\s+\(/, ' (').trim();
  }
  if (q.status === 'BOUNCED') return `Bounced${q.bounce_reason ? ` (${q.bounce_reason})` : ''}`;
  if (q.opened_at) return `Opened ${monDayOf(q.opened_at)}`;
  if (q.status === 'DELIVERED') return 'Delivered';
  return 'not viewed';
}

/**
 * The chip's second half, and how loud: `not viewed` → `Delivered` (muted) /
 * `Opened 10/9` (muted) / `Viewed 10/9` (bold) / `Bounced` (red) / `Expired`.
 * → { text, tone } with tone ∈ quiet | muted | strong | bad | expired.
 */
export const isTracked = (q) => !!q && (QUOTE_STATUSES.includes(q.status) || !!tokenOf(q));

export function quoteState(q) {
  // A pre-D83 quote (Mission Control's {number, file, sent}) was never tracked — say nothing rather than "not viewed".
  if (!isTracked(q)) return { text: '', tone: 'quiet' };
  const s = q.status;
  if (s === 'EXPIRED') return { text: 'Expired', tone: 'expired' };
  if (s === 'VIEWED' || q.viewed_at) return { text: `Viewed ${mdOf(q.viewed_at)}`.trim(), tone: 'strong' };
  if (s === 'BOUNCED') return { text: 'Bounced', tone: 'bad' };
  if (q.opened_at) return { text: `Opened ${mdOf(q.opened_at)}`.trim(), tone: 'muted' };
  if (s === 'DELIVERED') return { text: 'Delivered', tone: 'muted' };
  return { text: 'not viewed', tone: 'quiet' };
}

/** "Q2001 · sent 10/8 · not viewed" */
export function quoteChipText(q) {
  if (!q || !q.number) return '';
  const st = quoteState(q);
  return [q.number, q.sent ? `sent ${mdOf(q.sent)}` : '', st.text].filter(Boolean).join(' · ');
}
