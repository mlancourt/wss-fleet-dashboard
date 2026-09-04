/* Leads module — schema 5 logic.
 *
 * Pure on purpose: no DOM, no network, no Date parsing of date-only strings.
 * tools/selftest-leads.mjs asserts every rule below.
 *
 * Two things this file exists to keep straight:
 *
 *   1. MONEY IS ABSENT, NOT ZERO. The Worker deletes `value` and
 *      `potential_commission` from every lead, `leads_summary.commission_rates`
 *      and `scoreboard.money` before the response leaves the edge for a
 *      `service` token (spec §6). So a missing money field means "you are not
 *      shown this", never "$0" — nothing here may invent a number, and nothing
 *      may render a placeholder where money would be.
 *   2. The engine owns the truth. Ages, staleness, medians and percentages all
 *      arrive computed; we sort and lay out. The only client-side arithmetic in
 *      this file is a comparison against a baseline the engine also sent.
 */

/* ------------------------------------------------------------------ enums --
 * Fixed lists from the Leads spec §2. `leads_summary` carries the same lists at
 * runtime — prefer those (optionsFrom below) so an engine that adds a source
 * doesn't need a site deploy; these are the fallback and the Worker's copy. */

export const LEAD_STAGES = ['RECEIVED', 'CONTACTED', 'QUOTED', 'DEMO-SCHEDULED', 'INVOICED'];
export const LEAD_STATUSES = ['OPEN', 'WON', 'LOST', 'DEAD'];
export const LEAD_SOURCES = ['WEB-FORM', 'PAID-SEARCH', 'PHONE', 'EMAIL', 'WALK-IN', 'REFERRAL', 'OUTBOUND', 'SERVICE-UPSELL', 'MACHINIO'];
export const LEAD_INTERESTS = ['SALE-NEW', 'SALE-USED', 'RENTAL', 'SERVICE', 'PARTS'];
export const LOST_REASONS = ['PRICE', 'COMPETITOR', 'NO-BUDGET', 'TIMING', 'OTHER'];
export const LEAD_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
export const ASSIGNEES = ['Kevin', 'Matt'];

/** What the Worker strips for a `service` token when the snapshot doesn't say. */
export const LEAD_MONEY_FIELDS = ['value', 'potential_commission'];

/** The four stages an OPEN lead lives in on the board. INVOICED is a stage a
 *  won deal passes through, not a column — a lead that reaches it is WON. */
export const BOARD_STAGES = ['RECEIVED', 'CONTACTED', 'QUOTED', 'DEMO-SCHEDULED'];

/** The phrase for a null rate/median (§2). Never a dash, never a zero: a zero
 *  would read as "we convert nobody", which is a different and untrue claim. */
export const NO_DATA = 'not enough data';

export const STAGE_LABEL = {
  RECEIVED: 'Received', CONTACTED: 'Contacted', QUOTED: 'Quoted',
  'DEMO-SCHEDULED': 'Demo booked', INVOICED: 'Invoiced',
};
export const STATUS_LABEL = { OPEN: 'Open', WON: 'Won', LOST: 'Lost', DEAD: 'Dead' };
/** Card-sized source tags — lower case on purpose, they sit under the customer. */
export const SOURCE_LABEL = {
  'WEB-FORM': 'web form', 'PAID-SEARCH': 'paid search', PHONE: 'phone', EMAIL: 'email',
  'WALK-IN': 'walk-in', REFERRAL: 'referral', OUTBOUND: 'outbound',
  'SERVICE-UPSELL': 'service upsell', MACHINIO: 'Machinio',
};
export const INTEREST_LABEL = {
  'SALE-NEW': 'New sale', 'SALE-USED': 'Used sale', RENTAL: 'Rental', SERVICE: 'Service', PARTS: 'Parts',
};
export const REASON_LABEL = {
  PRICE: 'Price', COMPETITOR: 'Competitor', 'NO-BUDGET': 'No budget',
  TIMING: 'Timing', OTHER: 'Other', SILENT: 'Went silent', WON: 'Won',
};

/* --------------------------------------------------------- runtime options --
 * The engine ships its own enum lists in `leads_summary`. Use them when they're
 * there so a new source or lost-reason needs no deploy; fall back to ours. */

const listOr = (v, fallback) => (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') ? v.slice() : fallback.slice());

export function optionsFrom(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  return {
    stages: listOr(s.stages, LEAD_STAGES),
    sources: listOr(s.sources, LEAD_SOURCES),
    interests: listOr(s.interests, LEAD_INTERESTS),
    lostReasons: listOr(s.lost_reasons, LOST_REASONS),
    assignees: listOr(s.assignees, ASSIGNEES),
  };
}

/** The keys the Worker strips for `service` (§6) — snapshot-declared, else ours. */
export const moneyFields = (summary) =>
  listOr(summary && summary.money_fields, LEAD_MONEY_FIELDS);

/* --------------------------------------------------------------- predicates */

export const isOpen = (l) => !!l && l.status === 'OPEN';
export const isStale = (l) => !!l && (l.stale === 'red' || l.stale === 'yellow');

/**
 * Is this viewer shown money at all? Keyed on `scoreboard.money`, which the
 * Worker removes wholesale for a service token — one signal for the whole page,
 * so the scoreboard and the cards can never disagree about what's visible.
 */
export function hasMoney(snapshot) {
  const sb = snapshot && snapshot.scoreboard;
  return !!(sb && sb.money && typeof sb.money === 'object');
}

/** A number we may print. Absent (stripped, or never set) is NOT zero. */
export const amount = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/* ------------------------------------------------------------------ sorting */

const PRI_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const STALE_RANK = { red: 0, yellow: 1 };

/**
 * Inside a column: the ones about to rot first (red, then yellow), then by
 * priority, then longest-in-stage. The engine already sorts `leads[]` globally;
 * this re-applies the same intent per column so a filtered board still reads
 * worst-first.
 */
export function sortLeads(list) {
  return (list || []).slice().sort((a, b) =>
    (STALE_RANK[a.stale] ?? 2) - (STALE_RANK[b.stale] ?? 2)
    || (PRI_RANK[a.priority] ?? 3) - (PRI_RANK[b.priority] ?? 3)
    || (Number(b.age_in_stage_days) || 0) - (Number(a.age_in_stage_days) || 0)
    || String(a.lead || '').localeCompare(String(b.lead || '')));
}

/* ----------------------------------------------------------------- filtering */

/**
 * The three chips (§3.4).
 *   all    everything the snapshot carries
 *   mine   assigned to the person holding the token — by name, since that is
 *          what `assigned` holds. An unassigned lead is nobody's, not mine.
 *   stale  red or yellow, whoever owns it — the chip the scoreboard's stale row
 *          taps through to.
 */
export function filterLeads(leads, filter, meName) {
  const list = (leads || []).filter(Boolean);
  if (filter === 'mine') return list.filter((l) => !!meName && l.assigned === meName);
  if (filter === 'stale') return list.filter(isStale);
  return list;
}

/** Chip counts, always over the WHOLE list — a chip that counted its own
 *  filtered view would always read the same number as the board below it. */
export function chipCounts(leads, meName) {
  const list = (leads || []).filter(Boolean);
  const open = list.filter(isOpen);
  return {
    all: open.length,
    mine: open.filter((l) => !!meName && l.assigned === meName).length,
    stale: list.filter(isStale).length,
  };
}

/* -------------------------------------------------------------------- board */

/**
 * The five columns (§3.4): the four OPEN stages, then WON.
 *
 * WON is a STATUS column, not a stage: a deal that closed is out of the
 * pipeline, and `leads[]` carries it for 14 days so the week's wins are visible
 * next to the work. LOST and DEAD are not columns — they live in the collapsed
 * strip under the board (closedLeads below).
 *
 * An OPEN lead whose stage isn't one of the four (INVOICED, or a stage the
 * engine invents later) still gets a column, inserted before WON. Hiding a
 * column is a display choice; dropping a lead is data loss.
 */
export function boardColumns(leads, { filter = 'all', me = null, summary = null } = {}) {
  const meName = (me && me.name) || null;
  const visible = filterLeads(leads, filter, meName);
  const open = visible.filter(isOpen);

  const extra = [...new Set(open.map((l) => l.stage).filter((s) => s && !BOARD_STAGES.includes(s)))];
  const byStage = BOARD_STAGES.concat(extra);
  const fromSummary = filter === 'all' && summary && summary.open_by_stage;

  const cols = byStage.map((stage) => {
    const rows = sortLeads(open.filter((l) => l.stage === stage));
    const counted = fromSummary && typeof fromSummary[stage] === 'number' ? fromSummary[stage] : rows.length;
    return { key: stage, stage, label: STAGE_LABEL[stage] || stage, leads: rows, count: counted };
  });

  const won = sortLeads(visible.filter((l) => l.status === 'WON'));
  cols.push({ key: 'WON', stage: null, label: 'Won', leads: won, count: won.length });
  return cols;
}

/** The collapsed strip under the board: LOST + DEAD, most recently closed first. */
export function closedLeads(leads, filter = 'all', meName = null) {
  return filterLeads(leads, filter, meName)
    .filter((l) => l.status === 'LOST' || l.status === 'DEAD')
    .sort((a, b) => String(b.closed || '').localeCompare(String(a.closed || ''))
      || String(a.lead || '').localeCompare(String(b.lead || '')));
}

export const leadById = (leads, id) => (leads || []).find((l) => l && l.lead === id) || null;

/* ------------------------------------------------------------ stage picker --
 * Who may move a lead: `sales` and `owner` (§5 role gating — `service` may add
 * a note and nothing else). INVOICED is Matt's: it names a real invoice. */

export const canEditLead = (role) => role === 'sales' || role === 'owner';
export const canCloseLead = (role) => role === 'sales' || role === 'owner';

export function stageOptions(lead, role, summary = null) {
  const stages = optionsFrom(summary).stages;
  return stages
    .filter((s) => s !== 'INVOICED' || role === 'owner')
    .map((stage) => ({
      stage,
      label: STAGE_LABEL[stage] || stage,
      current: !!lead && lead.stage === stage,
      enabled: canEditLead(role),
    }));
}

/**
 * What moving to this stage has to ask for before it can be proposed (§3.5):
 *   DEMO-SCHEDULED  a date, and which unit is going
 *   INVOICED        the invoice number
 *   QUOTED          the deal value, but only if we don't have one yet
 * Anything else takes an optional note and nothing more.
 */
export function stageNeeds(lead, stage) {
  if (stage === 'DEMO-SCHEDULED') return 'demo';
  if (stage === 'INVOICED') return 'invoice';
  if (stage === 'QUOTED' && amount(lead && lead.value) == null) return 'value';
  return null;
}

/* --------------------------------------------------------------- scoreboard */

/**
 * This month against the last three (§3.1 row 2). Direction only — the size of
 * the gap is already on screen as two numbers, and a percentage-of-a-percentage
 * on a three-deal month is noise dressed as insight.
 *
 * -> { dir: 'up'|'down'|'flat'|'none', avg }  ('none' = no baseline, render nothing)
 */
export function delta(actual, avg) {
  const a = amount(actual);
  const b = amount(avg);
  if (a == null || b == null) return { dir: 'none', avg: b };
  if (a > b) return { dir: 'up', avg: b };
  if (a < b) return { dir: 'down', avg: b };
  return { dir: 'flat', avg: b };
}

/** A percentage the engine may have sent as null — "not enough data", never 0%. */
export const pctOr = (v) => (typeof v === 'number' && isFinite(v) ? `${Math.round(v)}%` : NO_DATA);

/** A median in hours/days, same rule. `unit` is appended only to a real number. */
export function statOr(v, unit = '') {
  if (typeof v !== 'number' || !isFinite(v)) return NO_DATA;
  const n = Math.round(v * 10) / 10;
  return unit ? `${n}${unit}` : String(n);
}

/* --------------------------------------------------------- unit page tie-in */

/**
 * §4: a DEMO hold on a unit points back at the lead that booked it, when the
 * engine has linked the two by hold id. Matched on `demo.hold_id` only — never
 * guessed from customer + date, which would put the wrong lead on a unit page.
 */
export function leadForHold(leads, holdId) {
  if (!holdId) return null;
  return (leads || []).find((l) => l && l.demo && l.demo.hold_id === holdId) || null;
}

/** Is this hold a demo? Purpose is free text from the engine; match loosely. */
export const isDemoHold = (h) => !!h && /^\s*demo\b/i.test(String(h.purpose || ''));
