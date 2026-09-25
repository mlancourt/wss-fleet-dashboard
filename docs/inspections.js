/* The fleet inspection sheet (D67) — check-out / return / PM, pure.
 *
 * Four paper sheets became ONE row library in the vault, shipped verbatim as
 * `inspection_checklist`. This file never names a row: every row, label, scale
 * and `shows_for` comes from the snapshot, so a new row is a vault edit and
 * never a deploy. What lives here is the machinery around the library — which
 * rows a machine sees, how a battery pack lays out its cells, what one SAVE
 * carries, and which buttons a role is OFFERED. The Worker checks shape, the
 * engine referees everything (row ids, scales, windows, who may reopen).
 *
 * Same rules as workorders.js: no DOM, no network, no Date parsing of a
 * date-only string. Every age (`age_days`) and every count on a DONE sheet
 * (`flags`, the summary) is the engine's. The one clock this file reads is the
 * DONE log row's "YYYY-MM-DD HH:MM CT" stamp, compared against Central
 * wall-clock NOW built from Intl parts — the same comparison the engine makes
 * for the 24-hour Reopen window.
 *
 * NO MONEY. Nothing on a sheet is money-shaped, and nothing here derives one.
 */

export const KINDS = ['CHECKOUT', 'RETURN', 'PM'];
export const KIND_LABEL = { CHECKOUT: 'Check-out', RETURN: 'Return', PM: 'PM' };
export const CLASSES = ['SCRUBBER', 'SWEEPER'];
export const CLASS_LABEL = { SCRUBBER: 'Scrubber', SWEEPER: 'Sweeper' };
// D67 v1.2 (Matt's red-pen): "body style" — the word the guys use. Was `controls`.
export const BODY_STYLES = ['WALK-BEHIND', 'RIDER', 'STAND-ON'];
export const BODY_STYLE_LABEL = { 'WALK-BEHIND': 'Walk-behind', RIDER: 'Rider', 'STAND-ON': 'Stand-on' };
export const BATTERY_TYPES = ['WET', 'AGM', 'LITHIUM'];
export const BATTERY_LABEL = { WET: 'Wet', AGM: 'AGM', LITHIUM: 'Lithium' };
export const VOLTAGES = [24, 36];
export const PACKS_BY_VOLTAGE = { 24: ['4x6V', '2x12V'], 36: ['3x12V', '6x6V'] };
export const PACK_LABEL = { '4x6V': '4 × 6V', '2x12V': '2 × 12V', '3x12V': '3 × 12V', '6x6V': '6 × 6V' };
export const CLARITY = ['CLEAR', 'CLOUDY', 'PARTICULATE', 'DARK'];
export const CLARITY_LABEL = { CLEAR: 'Clear', CLOUDY: 'Cloudy', PARTICULATE: 'Particles', DARK: 'Dark' };
export const LEVEL = ['OVERFILLED', 'FULL', 'LOW', 'DRY'];
export const LEVEL_LABEL = { OVERFILLED: 'Over', FULL: 'Full', LOW: 'Low', DRY: 'Dry' };
export const SCALES = { FUNCTION: ['IN-SPEC', 'REPAIR', 'PROBLEM', 'N/A'], WEAR: ['GOOD', 'WORN', 'REPLACE', 'N/A'] };
export const RESULT_LABEL = {
  'IN-SPEC': 'In spec', REPAIR: 'Repair', PROBLEM: 'Problem', GOOD: 'Good', WORN: 'Worn', REPLACE: 'Replace', 'N/A': 'N/A',
};
export const FLAG_RESULTS = new Set(['REPAIR', 'PROBLEM', 'REPLACE']);
export const HOURS_KEYS = ['hours_key', 'hours_traction', 'hours_scrub'];
/**
 * The typed readings, hours first (§4.3). `class` limits a reading to one
 * machine class. v1.2: broom / brush wear is "% life remaining", a whole
 * number 0–100 (`pct`) — no recharge counter.
 */
export const READINGS = [
  { key: 'hours_key', label: 'Key hours', max: 99999, hours: true },
  { key: 'hours_traction', label: 'Traction hours', max: 99999, hours: true },
  { key: 'hours_scrub', label: 'Scrub hours', max: 99999, hours: true },
  { key: 'main_broom_pct', label: 'Main broom life left', max: 100, pct: true, class: 'SWEEPER' },
  { key: 'brush1_pct', label: 'Brush 1 life left', max: 100, pct: true, class: 'SCRUBBER' },
  { key: 'brush2_pct', label: 'Brush 2 life left', max: 100, pct: true, class: 'SCRUBBER' },
];
export const READING_KEYS = [...READINGS.map((r) => r.key), 'brushes_rotated'];
export const PCT_KEYS = new Set(READINGS.filter((r) => r.pct).map((r) => r.key));
export const SECTION_KEYS = ['machine_class', 'body_style', 'battery', 'readings', 'cells', 'items', 'comments'];
export const INSP_ID_RE = /^I\d{4}$/;
export const MAX_COMMENTS = 1000;
export const MAX_ITEM_NOTE = 120;
export const MAX_NOTE = 200;
export const REOPEN_TECH_HOURS = 24;
export const SG_MIN = 1;
export const SG_MAX = 1.4;

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);

/* ------------------------------------------------------------ the snapshot */

/** `inspections[]`, or [] on a pre-D67 snapshot (the key is simply absent). */
export const inspectionsOf = (snap) => arr(snap && snap.inspections);
export const inspById = (list, id) => arr(list).find((i) => i.id === id) || null;
/** The library's sections, or null when none shipped (absent key, or the engine's "no sheet" `sections: []`). */
export function checklistOf(snap) {
  const c = snap && snap.inspection_checklist;
  const secs = c && Array.isArray(c.sections) ? c.sections.filter((s) => s && s.id && Array.isArray(s.rows)) : [];
  return secs.length ? secs : null;
}
/** Every row in the library by id — including retired ones, which old sheets still carry. */
export function rowIndex(sections) {
  const m = new Map();
  for (const s of arr(sections)) for (const r of arr(s.rows)) if (r.id) m.set(r.id, r);
  return m;
}

/** A serial's sheets, newest first: DRAFTs by opened, DONE by done; the I-number breaks ties. */
export function forSerial(list, serial) {
  const when = (i) => (i.status === 'DONE' ? i.done : i.opened) || '';
  return arr(list).filter((i) => serial != null && String(i.serial) === String(serial))
    .sort((a, b) => when(b).localeCompare(when(a)) || String(b.id).localeCompare(String(a.id)));
}

/* ------------------------------------------------------------ the machine */

/** rental category → {machine_class, body_style}: the engine's derivation, as a default the tech may flip. */
export function deriveProfile(category) {
  const c = String(category || '').toLowerCase();
  const machine_class = c.includes('sweeper') ? 'SWEEPER' : 'SCRUBBER';
  const body_style = c.includes('stand-on') || c.includes('chariot') ? 'STAND-ON'
    : c.includes('rider') || c.includes('ride-on') ? 'RIDER' : 'WALK-BEHIND';
  return { machine_class, body_style };
}

/** The picker's default (§2): coming back off rent → RETURN; in prep → CHECKOUT; else PM. */
export function defaultKind(unit) {
  if (unit && unit.unit_state === 'ON-RENT') return 'RETURN';
  if (unit && unit.readiness === 'NEEDS-PREP') return 'CHECKOUT';
  return 'PM';
}

const fits = (sf, p) => {
  if (!sf || typeof sf !== 'object') return true;
  if (Array.isArray(sf.class) && !sf.class.includes(p.machine_class)) return false;
  if (Array.isArray(sf.body_style) && !sf.body_style.includes(p.body_style)) return false;
  if (Array.isArray(sf.battery) && !sf.battery.includes(p.battery_type)) return false;
  return true;
};
/**
 * Does this row belong on this machine's sheet? `shows_for` on the section AND
 * the row, against class / body_style / battery type (absent key = everyone). A
 * retired row is hidden on new sheets and still drawn on a sheet that carries
 * an answer for it — `carried` is the set of row ids the sheet has answered.
 */
export function rowShows(section, row, profile, carried) {
  if (!fits(section && section.shows_for, profile) || !fits(row && row.shows_for, profile)) return false;
  if (row && row.retired) return !!carried && carried.has(row.id);
  return true;
}
/** The library in library order, filtered for this machine. Sections with no rows left are dropped. */
export function visibleSections(sections, profile, carried) {
  return arr(sections)
    .map((section) => ({ section, rows: arr(section.rows).filter((r) => r.id && rowShows(section, r, profile, carried)) }))
    .filter((s) => s.rows.length);
}
export const profileOf = (sheet) => ({
  machine_class: sheet && sheet.machine_class, body_style: sheet && sheet.body_style,
  battery_type: sheet && sheet.battery ? sheet.battery.type : null,
});

/**
 * The cell grid for a battery (§4.4) — WET only, and only once the pack is
 * known, because the pack decides the grouping: a 6V battery has 3 cells
 * (A–C), a 12V one has 6 (A–F). 24V is always 12 cells, 36V always 18.
 *   4x6V → 4 × A–C · 2x12V → 2 × A–F · 3x12V → 3 × A–F · 6x6V → 6 × A–C
 * null = no grid (AGM, lithium, or the pack not picked yet).
 */
export function cellLayout(battery) {
  if (!battery || battery.type !== 'WET') return null;
  const packs = PACKS_BY_VOLTAGE[battery.voltage];
  if (!packs || !packs.includes(battery.pack)) return null;
  const [n, v] = battery.pack.split('x');
  const cells = v === '6V' ? ['A', 'B', 'C'] : ['A', 'B', 'C', 'D', 'E', 'F'];
  return Array.from({ length: Number(n) }, (_, i) => ({ battery: i + 1, cells }));
}
export const cellKey = (battery, cell) => `${battery}${cell}`;

/** A hydrometer reading as typed. "1.265" and "1265" (gloves) both read 1.265; null when blank; NaN when not a reading. */
export function parseSg(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  let v = Number(t);
  if (!isFinite(v)) return NaN;
  if (v >= 1000 && v <= 1400) v /= 1000;
  v = Math.round(v * 1000) / 1000;
  return v >= SG_MIN && v <= SG_MAX ? v : NaN;
}

/* -------------------------------------------------------------- the sheet */

const blankReadings = () => Object.fromEntries(READING_KEYS.map((k) => [k, null]));
const itemMap = (items) => new Map(arr(items).filter((i) => i.id).map((i) => [i.id, { result: i.result || null, note: i.note || null }]));
const cellMap = (cells) => new Map(arr(cells).map((c) => [cellKey(c.battery, c.cell), { sg: num(c.sg), clarity: c.clarity || null, level: c.level || null }]));

/**
 * A sheet as the page works with it: `items` and `cells` are Maps (row id →
 * answer, "1A" → cell), everything else as the snapshot ships it.
 */
export function sheetFrom(row) {
  const r = row || {};
  return {
    id: r.id || null, serial: r.serial == null ? null : String(r.serial), asset_item: r.asset_item || null,
    kind: r.kind || null, status: r.status || 'DRAFT', opened: r.opened || null, opened_by: r.opened_by || null,
    done: r.done || null, tech: r.tech || null, ticket: r.ticket || null, work_order: r.work_order || null,
    machine_class: r.machine_class || null, body_style: r.body_style || null,
    battery: { type: null, voltage: null, pack: null, ...(r.battery || {}) },
    readings: { ...blankReadings(), ...(r.readings || {}) },
    cells: cellMap(r.cells), items: itemMap(r.items), comments: r.comments == null ? null : r.comments,
    flags: num(r.flags), age_days: num(r.age_days), log: arr(r.log),
  };
}

/**
 * Lay a SAVE-shaped payload over a sheet — the engine's merge, by section: a
 * key present REPLACES that section, a key absent leaves it alone. Used for the
 * still-pending taps (in the order they were made) so a sheet reopened before
 * the run shows what was typed, badged pending — never as if it had applied.
 */
export function overlay(sheet, payload) {
  const p = payload || {};
  const s = { ...sheet };
  if ('kind' in p && p.kind) s.kind = p.kind;
  if ('machine_class' in p) s.machine_class = p.machine_class;
  if ('body_style' in p) s.body_style = p.body_style;
  if ('battery' in p) {
    s.battery = { type: null, voltage: null, pack: null, ...(p.battery || {}) };
    if (s.battery.type !== 'WET') s.cells = new Map();
  }
  if ('readings' in p) s.readings = { ...blankReadings(), ...(p.readings || {}) };
  if ('cells' in p) s.cells = cellMap(p.cells);
  if ('items' in p) s.items = itemMap(p.items);
  if ('comments' in p) s.comments = p.comments == null ? null : p.comments;
  return s;
}

/** The first hours reading typed — key, else traction, else scrub. The engine's write-back order. */
export function firstHours(readings) {
  for (const k of HOURS_KEYS) {
    const v = num(readings && readings[k]);
    if (v != null) return v;
  }
  return null;
}
/** Done is offered only when an hours field has a value — the engine's one rule, mirrored. */
export const doneReady = (sheet) => firstHours(sheet && sheet.readings) != null;

export const isFlag = (result) => FLAG_RESULTS.has(result);
/** Flags among the rows this machine SEES — a flag on a row that isn't on the sheet isn't a flag. */
export function flagCount(sheet, visible) {
  let n = 0;
  for (const { rows } of arr(visible)) for (const r of rows) {
    const a = sheet.items.get(r.id);
    if (a && isFlag(a.result)) n++;
  }
  return n;
}
export const answeredIn = (sheet, rows) => arr(rows).filter((r) => { const a = sheet.items.get(r.id); return !!(a && a.result); }).length;
/** The flagged rows' labels, library order — the work order's note. */
export function flaggedLabels(sheet, sections) {
  const out = [];
  for (const s of arr(sections)) for (const r of arr(s.rows)) {
    const a = sheet.items.get(r.id);
    if (a && isFlag(a.result)) out.push(r.label || r.id);
  }
  return out;
}

/**
 * One section as it goes on the wire (§2 — SAVE replaces the whole section).
 *   items     every answered row the machine SEES (a retired row the sheet
 *             already carries counts as seen). Answers on rows the current
 *             class / body style hide stay in the page, not in the vault.
 *   cells     only the cells the current pack lays out, and only ones with a
 *             value; nothing at all off a WET pack (the engine clears them).
 *   battery   pack only on WET, and only when it matches the voltage.
 */
export function sectionValue(sheet, key, sections) {
  if (key === 'machine_class' || key === 'body_style') return sheet[key];
  if (key === 'comments') {
    const c = sheet.comments == null ? '' : String(sheet.comments).trim();
    return c ? c.slice(0, MAX_COMMENTS) : null;
  }
  if (key === 'battery') {
    const b = sheet.battery || {};
    const type = BATTERY_TYPES.includes(b.type) ? b.type : null;
    const voltage = VOLTAGES.includes(b.voltage) ? b.voltage : null;
    const pack = type === 'WET' && voltage && PACKS_BY_VOLTAGE[voltage].includes(b.pack) ? b.pack : null;
    return { type, voltage, pack };
  }
  if (key === 'readings') {
    const out = {};
    for (const k of READING_KEYS) {
      const v = sheet.readings[k];
      const n = num(v);
      out[k] = k === 'brushes_rotated' ? (typeof v === 'boolean' ? v : null)
        : PCT_KEYS.has(k) && n != null ? Math.round(n) : n;
    }
    return out;
  }
  if (key === 'cells') {
    const layout = cellLayout(sheet.battery);
    if (!layout) return [];
    const out = [];
    for (const g of layout) for (const c of g.cells) {
      const v = sheet.cells.get(cellKey(g.battery, c));
      if (!v) continue;
      const sg = num(v.sg);
      if (sg == null && !v.clarity && !v.level) continue;
      out.push({ battery: g.battery, cell: c, sg, clarity: v.clarity || null, level: v.level || null });
    }
    return out;
  }
  if (key === 'items') {
    const carried = new Set(sheet.items.keys());
    const out = [];
    for (const { rows } of visibleSections(sections, profileOf(sheet), carried)) for (const r of rows) {
      const a = sheet.items.get(r.id);
      if (!a || (!a.result && !a.note)) continue;
      const note = a.note ? String(a.note).trim().slice(0, MAX_ITEM_NOTE) : null;
      out.push({ id: r.id, result: a.result || null, note: note || null });
    }
    return out;
  }
  return undefined;
}

/* ------------------------------------------------------------------ roles */

/** Central wall-clock now as "YYYY-MM-DD HH:MM", from Intl parts — no string is ever parsed as a Date. */
export function ctNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/;
/** Minutes between two Central wall-clock stamps, from numeric parts. null if either isn't a stamp. */
export function minutesBetween(a, b) {
  const m1 = STAMP_RE.exec(String(a || ''));
  const m2 = STAMP_RE.exec(String(b || ''));
  if (!m1 || !m2) return null;
  const t = (m) => Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return (t(m2) - t(m1)) / 60000;
}
/** When the sheet went DONE, from the engine's log ("DONE by Josh — …"). The latest one; null if the log doesn't say. */
export function doneStamp(insp) {
  const rows = arr(insp && insp.log);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^DONE\b/.test(String(rows[i].text || '')) && STAMP_RE.test(String(rows[i].ts || ''))) return rows[i].ts;
  }
  return null;
}
/**
 * Reopen (§2): owner any time; the TECH who signed it within 24 h of DONE (the
 * fat-finger window). Mirrors the engine so nobody is offered a button it will
 * refuse — the engine still decides. No DONE stamp in the log → owner only.
 */
export function reopenShown(insp, role, meName, now = ctNow()) {
  if (!insp || insp.status !== 'DONE') return false;
  if (role === 'owner') return true;
  if (!meName || insp.tech !== meName) return false;
  const mins = minutesBetween(doneStamp(insp), now);
  return mins != null && mins >= 0 && mins <= REOPEN_TECH_HOURS * 60;
}
/** Void: owner, or whoever opened it while it is still a DRAFT. */
export function voidShown(insp, role, meName) {
  if (!insp || insp.status === 'VOID') return false;
  if (role === 'owner') return true;
  return insp.status === 'DRAFT' && !!meName && insp.opened_by === meName;
}

/**
 * "Open work order from this inspection" (§4.7): a PM or a return found a
 * repair; a check-out found what stands between the machine and rent-ready.
 * The note leads with the sheet's number (the engine prefixes it too) and is
 * cut to the Worker's 200 characters.
 */
export function woPrefill(insp, labels) {
  const purpose = insp && insp.kind === 'CHECKOUT' ? 'RENT-READY' : 'REPAIR';
  let note = `from ${insp.id}: ${arr(labels).join('; ')}`;
  if (note.length > MAX_NOTE) note = `${note.slice(0, MAX_NOTE - 1)}…`;
  return { purpose, note };
}
export const woButtonShown = (insp) => !!insp && insp.status === 'DONE' && (num(insp.flags) || 0) > 0 && !insp.work_order;

/* ----------------------------------------------------------- summaries */

/** "412.5" · "412" — an hour meter, never money. */
export const fmtReading = (v) => {
  const n = num(v);
  return n == null ? '' : String(Math.round(n * 10) / 10);
};
const flagsText = (n) => (n ? ` · ${n} ⚑` : '');
/** "Resume I1001 · CHECKOUT · 3 ⚑" — the unit page's button when a DRAFT exists. */
export const resumeText = (insp, id) => `Resume ${(insp && insp.id) || id}${insp && insp.kind ? ` · ${insp.kind}` : ''}${flagsText(insp && num(insp.flags))}`;
/** "📋 I1001 · 2 ⚑" — the read-only chip on a ticket / work order. */
export const chipText = (insp) => `📋 ${insp.id}${flagsText(num(insp.flags))}`;

/**
 * The strip's two numbers — the engine's summary when it ships one; counted
 * from the rows otherwise (a DONE is "this week" when `done` is within 7 days
 * of `today`, by date-only string compare).
 */
export function stripCounts(summary, list, weekAgo) {
  if (summary && typeof summary === 'object' && num(summary.drafts) != null && num(summary.done_7d) != null) {
    return { drafts: summary.drafts, done7: summary.done_7d };
  }
  const rows = arr(list);
  return {
    drafts: rows.filter((i) => i.status === 'DRAFT').length,
    done7: rows.filter((i) => i.status === 'DONE' && i.done && i.done >= weekAgo).length,
  };
}
/** Drafts, oldest first (the one about to be lost leads), then Done within the week, newest first. */
export function stripGroups(list, weekAgo) {
  const rows = arr(list);
  return {
    drafts: rows.filter((i) => i.status === 'DRAFT')
      .sort((a, b) => (num(b.age_days) ?? -1) - (num(a.age_days) ?? -1) || String(a.id).localeCompare(String(b.id))),
    done: rows.filter((i) => i.status === 'DONE' && i.done && i.done >= weekAgo)
      .sort((a, b) => b.done.localeCompare(a.done) || String(b.id).localeCompare(String(a.id))),
  };
}
/** Amber when any DRAFT has sat `amber` days or more (engine `age_days`). */
export const draftTone = (list, amber) => (arr(list).some((i) => i.status === 'DRAFT' && num(i.age_days) != null && i.age_days >= amber) ? 'amber' : '');

/* --------------------------------------------------------------- pending */

const pl = (e) => (e && e.payload) || {};
const isInsp = (e) => !!e && e.action === 'inspection';
/** OPENs have no I-number yet — keyed on the top-level serial (§2). */
export const pendingOpens = (pending) => arr(pending).filter((e) => isInsp(e) && pl(e).action === 'OPEN');
export const pendingOpensFor = (pending, serial) => (serial == null ? [] : pendingOpens(pending)
  .filter((e) => e.serial != null && String(e.serial) === String(serial)));
/** Every other verb badges its sheet by payload.inspection; a pre-id SAVE by its serial. */
export const pendingForInsp = (pending, id) => (!id ? [] : arr(pending).filter((e) => isInsp(e) && pl(e).action !== 'OPEN' && pl(e).inspection === id));
/** Oldest first — the order the engine will apply them in. */
export const byTs = (a, b) => String(a.ts || a.id || '').localeCompare(String(b.ts || b.id || ''));

/** One line of English for a pending inspection tap. */
export function describeInspEvent(e) {
  const p = pl(e);
  const secs = SECTION_KEYS.filter((k) => k in p);
  const what = secs.length ? secs.map((k) => (k === 'machine_class' ? 'machine' : k)).join(', ') : '';
  switch (p.action) {
    case 'OPEN': return `new ${KIND_LABEL[p.kind] || 'inspection'} sheet${what ? ` — ${what}` : ''}`;
    case 'SAVE': return `saved ${what || 'the sheet'}`;
    case 'DONE': return `done${p.tech ? ` (${p.tech})` : ''}`;
    case 'REOPEN': return 'reopen';
    case 'VOID': return 'void the sheet';
    default: return 'inspection change';
  }
}
