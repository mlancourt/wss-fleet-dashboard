/* Notes timeline — `service_queue[].log[]` and `leads[].log[]` (CLAUDE.md v2.4).
 *
 * Shared by tickets and leads because the row shape is identical: `{ts, who,
 * text}`, last 30, oldest first. Pure — no DOM, no network.
 *
 * THE TRAP IN THIS FILE: `ts` is NOT a UTC instant and NOT a date-only business
 * date. The engine ships it already formatted for a Central-time reader, in
 * whatever shape the source row had:
 *
 *     "2026-09-04 11:09 CT"      a stamped entry
 *     "2026-09-03"               an imported one that only knew the day
 *
 * So it is neither `fmtInstantCentral` (which would need a parseable instant)
 * nor `fmtDate` (which would mangle the first shape). It is rendered VERBATIM,
 * and nothing here or downstream may hand it to `new Date()` — that is the bug
 * CLAUDE.md calls disqualifying, and this field walks straight into it.
 *
 * Ordering is the engine's: oldest first, so the newest sits at the bottom of
 * the timeline. We never re-sort. Sorting these strings would mix
 * "2026-09-03 10:55 CT" against a bare "2026-09-03" and quietly reorder a
 * tech's diagnosis relative to the import note it answers.
 */

/** The engine caps at 30; we cap too, so a runaway log can't blow up a phone. */
export const MAX_LOG_ROWS = 30;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The log rows of a ticket or a lead, in the order the engine sent them.
 *
 * A row with no `text` is dropped — it has nothing to say and would render as
 * an empty bubble with a timestamp. A row with no `who` is kept: about a third
 * of the real ones are imports with no author, and losing them would put holes
 * in the history. `who` is a best-effort parse upstream, so it is a chip when
 * present and simply absent when not — never "unknown".
 *
 * -> [{ ts, who, text }]  ts and who may be '' / null; text is always non-empty
 */
export function logRows(entity) {
  const raw = entity && Array.isArray(entity.log) ? entity.log : [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const text = str(row.text);
    if (!text) continue;
    out.push({ ts: str(row.ts), who: str(row.who) || null, text });
  }
  // Keep the LAST 30: the engine already trims, and if a longer log ever
  // arrives the recent end is the half worth having.
  return out.length > MAX_LOG_ROWS ? out.slice(-MAX_LOG_ROWS) : out;
}

export const hasLog = (entity) => logRows(entity).length > 0;

/**
 * The notes a person typed this session that have not been applied yet.
 *
 * These are pending EVENTS, not log rows: they carry no `ts` the engine has
 * stamped for display and no place in the record. `actor` stands in for `who`,
 * which is the honest reading — it is who proposed it, not who wrote a line in
 * the file, and the two only become the same thing at the next run.
 *
 * -> [{ id, who, text }]  in the order they were submitted
 */
export function pendingNotes(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const text = str(e && e.payload && e.payload.note);
    if (!text) continue;
    out.push({ id: e.id || null, who: str(e.actor) || null, text });
  }
  return out;
}
