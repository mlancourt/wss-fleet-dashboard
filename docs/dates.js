/* Date + money formatting for WSS Fleet.
 *
 * Split out of app.js on purpose: this is the one bug class CLAUDE.md calls
 * disqualifying, so it lives in a pure module with no DOM and no network, and
 * tools/selftest-dates.mjs asserts every rule below on each run.
 *
 * THE RULE: business dates in the snapshot are date-only strings (YYYY-MM-DD)
 * already expressed in Central time. NEVER new Date("YYYY-MM-DD") — JS parses
 * that as UTC midnight, and a Central-time user sees the previous day.
 * Everything here is either string surgery or built from numeric parts.
 */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-09-14" -> "Sep 14". Unknown shapes pass through verbatim. */
export function fmtDate(s) {
  if (!s) return '';
  const m = DATE_RE.exec(s);
  return m ? `${MON[+m[2] - 1]} ${+m[3]}` : String(s);
}

/** "2026-09-14" -> "Sep 14, 2026". Unknown shapes pass through verbatim. */
export function fmtDateFull(s) {
  if (!s) return '';
  const m = DATE_RE.exec(s);
  return m ? `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(s);
}

/** Today in Central as a date-only string. Intl, never string parsing. */
export function todayCentral(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * Add N business days (Sat/Sun skipped) to a date-only string.
 * The Date is built from NUMERIC PARTS via Date.UTC — never from the string —
 * so no timezone can shift it. Landing on a weekend is impossible for n >= 1.
 */
export function addBusinessDays(dateStr, n) {
  const m = DATE_RE.exec(dateStr);
  if (!m) return dateStr;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  let left = n;
  while (left > 0) {
    t += 86400000;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** meta.generated_at IS a full UTC instant — parsing this one is correct. */
export function fmtInstantCentral(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso || 'unknown');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(t));
}

export function hoursSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : (now - t) / 3600000;
}

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

/** Whole dollars. Non-numbers render as an em dash, never as "$NaN". */
export function fmtMoney(n) {
  return typeof n === 'number' && isFinite(n) ? usd0.format(n) : '—';
}

/** Inclusive window: "Sep 8" when start == end, else "Sep 8 – Sep 11" (year on the end if it differs). */
export function fmtRange(start, end) {
  if (!start && !end) return '';
  if (!start || !end || start === end) return fmtDate(start || end);
  const sameYear = DATE_RE.test(start) && DATE_RE.test(end) && start.slice(0, 4) === end.slice(0, 4);
  return `${fmtDate(start)} – ${sameYear ? fmtDate(end) : fmtDateFull(end)}`;
}

/** Date-only strings compare correctly as strings. Guarded so junk never "sorts". */
export const isDateStr = (s) => typeof s === 'string' && DATE_RE.test(s);
