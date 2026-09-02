/* Reservations v2 — hold list helpers. Pure: no DOM, no Date parsing of
 * date-only strings (they compare correctly as YYYY-MM-DD strings).
 *
 * The engine owns the state rules. In particular: a unit with holds is NOT
 * necessarily RESERVED — only a hold that is current right now makes it so.
 * Nothing here infers unit_state from the hold list. */
import { isDateStr } from './dates.js';

export const STATUSES = ['current', 'future', 'expired', 'malformed'];

/** A unit's holds, always an array, in start order. Tolerates v1 snapshots (no list). */
export function holdsOf(u) {
  const list = u && Array.isArray(u.reservations) ? u.reservations.slice() : [];
  return list.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
}

/** Engine-computed status, with a fallback for a missing field so nothing renders blank. */
export function holdStatus(h, today) {
  if (h && STATUSES.includes(h.status)) return h.status;
  if (!h || !isDateStr(h.start) || !isDateStr(h.end) || h.end < h.start) return 'malformed';
  if (!today) return 'future';
  if (h.end < today) return 'expired';
  if (h.start > today) return 'future';
  return 'current';
}

export const currentHold = (u, today) => holdsOf(u).find((h) => holdStatus(h, today) === 'current') || null;
export const futureHolds = (u, today) => holdsOf(u).filter((h) => holdStatus(h, today) === 'future');

/** Holds whose window touches [start, end] (inclusive). Malformed holds can't be compared and are skipped. */
export function findOverlaps(holds, start, end) {
  if (!isDateStr(start) || !isDateStr(end)) return [];
  return (holds || []).filter((h) =>
    isDateStr(h.start) && isDateStr(h.end) && h.end >= h.start && !(end < h.start || start > h.end));
}

/** Minimal client-side check (the engine is the referee): a message, or null when fine. */
export function validateWindow(start, end, today) {
  if (!isDateStr(start)) return 'Pick a start date.';
  if (!isDateStr(end)) return 'Pick an end date.';
  if (end < start) return 'End date is before the start date.';
  if (today && end < today) return 'That window is already in the past.';
  return null;
}

/** Group a rollup list by its start date, in date order: [{ date, items }]. */
export function groupByDate(list) {
  const map = new Map();
  for (const h of (list || []).slice().sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')))) {
    const k = isDateStr(h.start) ? h.start : '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(h);
  }
  return [...map.entries()].map(([date, items]) => ({ date, items }));
}
