/**
 * WSS Fleet Worker — the entire API in one file, so a Cloudflare-dashboard
 * paste-deploy stays possible as a fallback to `wrangler deploy`.
 *
 * Bindings (wrangler.toml):
 *   FLEET_KV        KV namespace: `snapshot`, `tokens`, `evt:<utc-iso>:<rand6>`
 * Secrets / vars:
 *   ADMIN_SECRET    `wrangler secret put ADMIN_SECRET` (local dev: worker/.dev.vars)
 *   ALLOW_LOCALHOST "1" to accept http://localhost:* origins (dev only, via .dev.vars)
 *
 * Rules this file enforces (see CLAUDE.md):
 *   - Crew auth = opaque token (Bearer header or ?t=) looked up in the KV `tokens` map.
 *   - Admin auth = X-Admin-Secret, constant-time compared. No secret set → nothing admin works.
 *   - Events are proposals: shape + role are validated here, business state is NOT
 *     (that's the vault's job). One KV key per event, never a shared array.
 *   - ack deletes only the ids it is handed. There is no "delete all".
 *   - a crew member may DELETE their OWN pending event and nobody else's; owner
 *     has no override (D46). Deleting is the only way an event leaves KV other
 *     than the engine acking it.
 *   - Token values are never logged and never echoed back.
 */

const ROLES = new Set(['owner', 'sales', 'service']);
const ALL_ROLES = new Set(['owner', 'sales', 'service']);
const ACTION_ROLES = {
  reserve: new Set(['owner', 'sales']),
  release: new Set(['owner', 'sales']),
  readiness: new Set(['owner', 'service']),
  // schema 3. Anyone may open a ticket, note/assign/schedule it, or work the
  // dispatch board. Stage changes are narrowed inside cleanPayload (a
  // ticket_update carrying `stage` needs service/owner); cancel is Matt's.
  ticket_open: ALL_ROLES,
  ticket_update: ALL_ROLES,
  dispatch_add: ALL_ROLES,
  dispatch_claim: ALL_ROLES,
  dispatch_done: ALL_ROLES,
  dispatch_cancel: new Set(['owner']),
  // schema 5 (Leads spec §5). Anyone may write a lead down — a tech who takes
  // the call is the person who has the customer on the line. Working it is
  // Kevin's and Matt's: a `lead_update` from `service` may carry a note and
  // nothing else (narrowed inside cleanPayload), and closing is theirs alone.
  lead_open: ALL_ROLES,
  lead_update: ALL_ROLES,
  lead_close: new Set(['owner', 'sales']),
};
// `serial` is required for the three v1/v2 actions and optional for the six
// schema-3 ones — a customer's own machine and a parts run have no unit.
const SERIAL_REQUIRED = new Set(['reserve', 'release', 'readiness']);

const READINESS = new Set(['READY', 'NEEDS-PREP', 'DOWN', 'NEEDS-PICKUP']);   // NEEDS-PICKUP: D32

// Fixed lists from CLAUDE.md / the Service-Dispatch spec. Shape and membership
// only — whether the value makes sense for the ticket's current state is the
// vault's call, never this file's.
const MACHINE_OWNERS = new Set(['CUSTOMER', 'WSS']);
// D47 adds NEEDS-QUOTE between CONTACTED and WAITING-ON-CUSTOMER. Membership
// only, as ever: a NEEDS-QUOTE on a WSS-owned ticket passes this file and is
// refused by the vault ("nobody quotes us to us"), which is where that call lives.
const STAGES = new Set(['RECEIVED', 'CONTACTED', 'NEEDS-QUOTE', 'WAITING-ON-CUSTOMER', 'WAITING-ON-PARTS', 'SCHEDULED', 'IN-PROGRESS', 'READY-TO-INVOICE', 'COMPLETE']);
const PRIORITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);
const LOCATIONS = new Set(['AT-CUSTOMER', 'IN-SHOP']);
const INTAKE_MOVES = new Set(['NONE', 'PICKUP', 'CUSTOMER-DROP']);
const RETURN_MOVES = new Set(['NONE', 'DELIVER', 'CUSTOMER-PICKUP']);
const KINDS = new Set(['PICKUP', 'DELIVER']);
const RIGS = new Set(['KEVIN-LIFTGATE', 'JOSH-LIFTGATE', 'TRAILER-6000', 'TRAILER-3000']);
const DRIVERS = new Set(['Matt', 'Kevin', 'Josh', 'Zac']);

// schema 5 — leads. Same rule as every list above: membership only. Whether a
// lead may legally move to this stage today is the vault's call, never ours.
const LEAD_STAGES = new Set(['RECEIVED', 'CONTACTED', 'QUOTED', 'DEMO-SCHEDULED', 'INVOICED']);
const LEAD_SOURCES = new Set(['WEB-FORM', 'PAID-SEARCH', 'PHONE', 'EMAIL', 'WALK-IN', 'REFERRAL', 'OUTBOUND', 'SERVICE-UPSELL', 'MACHINIO']);
const LEAD_INTERESTS = new Set(['SALE-NEW', 'SALE-USED', 'RENTAL', 'SERVICE', 'PARTS']);
const LOST_REASONS = new Set(['PRICE', 'COMPETITOR', 'NO-BUDGET', 'TIMING', 'OTHER']);
const LEAD_OUTCOMES = new Set(['LOST', 'DEAD']);        // WON is reached by moving to INVOICED, not by closing
const ASSIGNEES = new Set(['Kevin', 'Matt']);
// The one key a `service` token may put in a lead_update (§5).
const SERVICE_LEAD_KEYS = new Set(['lead', 'note']);
const MAX_LEAD_VALUE = 10000000;                        // a typed-in figure, not a computed one — catch a fat finger

const SERIAL_RE = /^[A-Za-z0-9-]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;      // openssl rand -hex 16 -> 32 chars
const EVENT_KEY_RE = /^evt:\S{1,128}$/;
const HOLD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;         // per-hold id from the snapshot (v2)
const REF_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;         // ticket ("S1001") / dispatch_id ("m-pu-150137")
// Event ids are "<utc-iso>:<rand6>" — digits, colons, dots, dashes. No slashes:
// KV keys are flat strings so a "../" id was never a traversal, but a malformed
// id deserves a 400 rather than a lookup that can only ever miss.
const EVENT_ID_PATH_RE = /^\/api\/event\/(.+)$/;
const EVENT_ID_RE = /^[A-Za-z0-9:._-]{1,128}$/;

const MAX_EVENT_BYTES = 8 * 1024;
const MAX_ACK_IDS = 1000;
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;    // KV value limit is 25 MiB

const STATIC_ORIGINS = new Set([
  'https://fleet.wisconsinscrubandsweep.com',
  'https://mlancourt.github.io',              // pre-DNS testing
]);
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/* ---------------------------------------------------------------- routing */

const ROUTES = [
  ['GET',  '/api/data',             'crew',  crewData],
  ['POST', '/api/event',            'crew',  crewEvent],
  ['GET',  '/api/health',           'crew',  crewHealth],
  ['POST', '/api/admin/publish',    'admin', adminPublish],
  ['GET',  '/api/admin/events',     'admin', adminEvents],
  ['POST', '/api/admin/events/ack', 'admin', adminAck],
  ['POST', '/api/admin/tokens',     'admin', adminTokens],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('Origin'), env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    let res;
    try {
      res = await route(request, env, url);
    } catch (err) {
      if (err && err.status) {
        res = json({ error: err.message }, err.status);
      } else {
        // Message only. Never log headers or bodies — they carry tokens.
        console.error('worker error:', err && err.message);
        res = json({ error: 'internal error' }, 500);
      }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/') return json({ ok: true, service: 'wss-fleet-worker' });

  // /api/event/<id> — the only path with a variable segment, so it is matched
  // before the exact-path table rather than complicating every row of it.
  const withId = EVENT_ID_PATH_RE.exec(path);
  if (withId) {
    if (method !== 'DELETE') {
      const res = json({ error: 'method not allowed' }, 405);
      res.headers.set('Allow', 'DELETE');
      return res;
    }
    const me = await crewAuth(request, url, env);
    if (!me) return json({ error: 'unauthorized' }, 401);
    return crewUndoEvent({ env, me, rawId: withId[1] });
  }

  const samePath = ROUTES.filter((r) => r[1] === path);
  if (!samePath.length) return json({ error: 'not found' }, 404);

  const hit = samePath.find((r) => r[0] === method);
  if (!hit) {
    const res = json({ error: 'method not allowed' }, 405);
    res.headers.set('Allow', samePath.map((r) => r[0]).join(', '));
    return res;
  }

  const [, , kind, handler] = hit;
  const ctx = { request, env, url, me: null };

  if (kind === 'admin') {
    if (!adminAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  } else {
    ctx.me = await crewAuth(request, url, env);
    if (!ctx.me) return json({ error: 'unauthorized' }, 401);
  }
  return handler(ctx);
}

/* ------------------------------------------------------------------- auth */

async function crewAuth(request, url, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('t');
  if (!token || !TOKEN_RE.test(token)) return null;

  const map = await env.FLEET_KV.get('tokens', { type: 'json', cacheTtl: 60 });
  if (!map || typeof map !== 'object') return null;
  const who = Object.prototype.hasOwnProperty.call(map, token) ? map[token] : null;
  if (!who || typeof who.name !== 'string' || !ROLES.has(who.role)) return null;
  return { name: who.name, role: who.role };
}

function adminAuth(request, env) {
  const secret = env.ADMIN_SECRET;
  if (!secret) return false;                              // fail closed
  return safeEqual(request.headers.get('X-Admin-Secret') || '', secret);
}

/** Constant-time string compare — no early exit on length or first mismatch. */
function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

/* ------------------------------------------------------------------- crew */

async function crewData({ me, env }) {
  const [snapshot, events] = await Promise.all([env.FLEET_KV.get('snapshot'), listEvents(env)]);
  if (!snapshot) return json({ error: 'no snapshot published yet' }, 503);

  // The snapshot was validated as JSON at publish time, so splice the raw text
  // in rather than parse + re-stringify a large document on every read. A
  // `service` token is the one case that has to pay for a parse: its copy has
  // the lead money removed here, at the edge, before the bytes leave.
  const doc = me.role === 'service' ? stripLeadMoney(snapshot) : snapshot;
  const pending = JSON.stringify(events.map((e) => e.event));
  const body = `{"me":${JSON.stringify(me)},"snapshot":${doc},"pending":${pending}}`;
  return new Response(body, { status: 200, headers: jsonHeaders() });
}

/**
 * The money gate (Leads spec §6, L4) — NOT optional, and deliberately not a
 * client concern. Privacy by contract, not by CSS: this is the D45 lesson, that
 * a figure the page merely declines to draw is still a figure sitting in the
 * response for anyone who opens the network tab.
 *
 * For a `service` token, remove from the snapshot:
 *   - every key named in `leads_summary.money_fields` from each `leads[]` row
 *     (today `value` + `potential_commission`), UNIONED with our own copy of
 *     that list so a missing or malformed `money_fields` cannot open the gate;
 *   - `leads_summary.commission_rates` — the rates reconstruct the commission;
 *   - `leads_summary.money_fields` itself, which otherwise leaves the literal
 *     string "potential_commission" in a response that must not contain it
 *     (the deploy-loop curl check greps for exactly that);
 *   - `scoreboard.money`.
 * `insights` is untouched: `won_value` there is deal size, not anybody's pay.
 *
 * Fails CLOSED. If the stored snapshot somehow won't parse we refuse rather
 * than fall back to shipping the raw text — the raw text is the thing we are
 * trying not to send.
 */
function stripLeadMoney(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw httpError(500, 'snapshot unreadable'); }
  if (!doc || typeof doc !== 'object') throw httpError(500, 'snapshot unreadable');

  const summary = doc.leads_summary && typeof doc.leads_summary === 'object' ? doc.leads_summary : null;
  const declared = summary && Array.isArray(summary.money_fields) ? summary.money_fields : [];
  const fields = new Set(['value', 'potential_commission']);
  for (const f of declared) if (typeof f === 'string') fields.add(f);

  if (Array.isArray(doc.leads)) {
    for (const lead of doc.leads) {
      if (!lead || typeof lead !== 'object') continue;
      for (const f of fields) delete lead[f];
      // v2.4 `log[]` is FREE TEXT the engine writes, and it writes money into
      // it: real rows read "<name> value → $<amount>". Deleting `value` while
      // shipping a sentence that spells it out would defeat this gate in the
      // same response. Not listed in §6 — §6 predates the field — so this is a
      // deliberate over-strip, pending the Architect's call: a redacted lead
      // log would be strictly better, since a tech loses their own lead notes
      // here. TICKET logs are untouched; they carry no lead money and they are
      // where the shop's actual work is written down.
      delete lead.log;
    }
  }
  if (summary) {
    delete summary.commission_rates;
    delete summary.money_fields;
  }
  if (doc.scoreboard && typeof doc.scoreboard === 'object') delete doc.scoreboard.money;

  return JSON.stringify(doc);
}

async function crewEvent({ request, me, env }) {
  const body = await readJson(request, MAX_EVENT_BYTES);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'body must be an object');

  const { action } = body;
  if (!Object.prototype.hasOwnProperty.call(ACTION_ROLES, action)) throw httpError(400, 'unknown action');
  if (!ACTION_ROLES[action].has(me.role)) throw httpError(403, `role ${me.role} cannot ${action}`);

  // Optional for the six schema-3 actions, and then normalised to null so the
  // engine sees one shape rather than "missing" vs "" vs null.
  let serial = body.serial;
  if (serial == null || serial === '') {
    if (SERIAL_REQUIRED.has(action)) throw httpError(400, 'bad serial');
    serial = null;
  } else if (typeof serial !== 'string' || !SERIAL_RE.test(serial)) {
    throw httpError(400, 'bad serial');
  }

  const payload = cleanPayload(action, body.payload, me.role);

  // Server stamps everything the client must not be trusted with.
  const ts = new Date().toISOString();
  const id = `${ts}:${rand6()}`;
  const event = { id, ts, actor: me.name, role: me.role, action, serial, payload };

  await env.FLEET_KV.put(`evt:${id}`, JSON.stringify(event));
  return json(event, 201);
}

function cleanPayload(action, p, role) {
  const obj = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  const str = (v, max, field, required) => {
    if (v == null || v === '') {
      if (required) throw httpError(400, `${field} is required`);
      return '';
    }
    if (typeof v !== 'string') throw httpError(400, `${field} must be a string`);
    const t = v.trim();
    if (t.length > max) throw httpError(400, `${field} is too long (max ${max})`);
    return t;
  };
  // An enum field that must be present.
  const oneOf = (v, set, field) => {
    if (!set.has(v)) throw httpError(400, `${field} must be one of ${[...set].join(', ')}`);
    return v;
  };
  // An enum field that may be absent — absent means "not being changed".
  const optOneOf = (v, set, field) => (v == null || v === '' ? null : oneOf(v, set, field));
  const optDate = (v, field) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !DATE_RE.test(v)) throw httpError(400, `${field} must be YYYY-MM-DD`);
    return v;
  };
  const optSerial = (v, field) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !SERIAL_RE.test(v)) throw httpError(400, `bad ${field}`);
    return v;
  };
  const refId = (v, field) => {
    const t = str(v, 64, field, true);
    if (!REF_ID_RE.test(t)) throw httpError(400, `bad ${field}`);
    return t;
  };
  const optStr = (v, max, field) => (v == null || v === '' ? null : str(v, max, field, true));

  if (action === 'reserve') {
    // v2: an inclusive [start, end] window. Legacy `until` is accepted as `end`
    // for any in-flight v1 client; new code never sends it. Shape only — whether
    // the window collides with another hold is the engine's call.
    const start = str(obj.start, 10, 'start', true);
    if (!DATE_RE.test(start)) throw httpError(400, 'start must be YYYY-MM-DD');
    const end = str(obj.end != null && obj.end !== '' ? obj.end : obj.until, 10, 'end', true);
    if (!DATE_RE.test(end)) throw httpError(400, 'end must be YYYY-MM-DD');
    return {
      customer: str(obj.customer, 120, 'customer', true),
      purpose: str(obj.purpose, 200, 'purpose', false),
      start,
      end,
    };
  }
  if (action === 'release') {
    // hold_id names which hold to release. Optional in shape (a single-hold unit
    // needs none); the engine rejects an ambiguous release without it.
    const hold_id = str(obj.hold_id, 64, 'hold_id', false);
    if (hold_id && !HOLD_ID_RE.test(hold_id)) throw httpError(400, 'bad hold_id');
    return hold_id ? { hold_id } : {};
  }
  if (action === 'readiness') {
    if (!READINESS.has(obj.readiness)) throw httpError(400, 'readiness must be READY, NEEDS-PREP, DOWN or NEEDS-PICKUP');
    return { readiness: obj.readiness, note: str(obj.note, 500, 'note', false) };
  }

  /* ------------------------------------------------------------- schema 3 -- */

  if (action === 'ticket_open') {
    // No ticket id: the engine assigns it. Nothing here checks that the serial
    // exists or that the customer is real — that is the vault's job.
    return {
      machine_owner: oneOf(obj.machine_owner, MACHINE_OWNERS, 'machine_owner'),
      serial: optSerial(obj.serial, 'serial'),
      equipment: optStr(obj.equipment, 200, 'equipment'),
      customer: str(obj.customer, 120, 'customer', true),
      issue: str(obj.issue, 1000, 'issue', true),
      priority: oneOf(obj.priority, PRIORITIES, 'priority'),
      site: optStr(obj.site, 200, 'site'),
      location: oneOf(obj.location, LOCATIONS, 'location'),
      intake_move: oneOf(obj.intake_move, INTAKE_MOVES, 'intake_move'),
      return_move: oneOf(obj.return_move, RETURN_MOVES, 'return_move'),
    };
  }

  if (action === 'ticket_update') {
    // Only the keys being changed travel. A stage move is the one part of this
    // action that isn't open to everyone.
    const out = { ticket: refId(obj.ticket, 'ticket') };
    const stage = optOneOf(obj.stage, STAGES, 'stage');
    if (stage) {
      if (role !== 'service' && role !== 'owner') throw httpError(403, `role ${role} cannot change a ticket stage`);
      out.stage = stage;
    }
    const note = optStr(obj.note, 1000, 'note');
    if (note) out.note = note;
    const assigned = optOneOf(obj.assigned, DRIVERS, 'assigned');
    if (assigned) out.assigned = assigned;
    const scheduled = optDate(obj.scheduled, 'scheduled');
    if (scheduled) out.scheduled = scheduled;
    const intake = optOneOf(obj.intake_move, INTAKE_MOVES, 'intake_move');
    if (intake) out.intake_move = intake;
    const ret = optOneOf(obj.return_move, RETURN_MOVES, 'return_move');
    if (ret) out.return_move = ret;
    if (Object.keys(out).length < 2) throw httpError(400, 'ticket_update needs at least one field to change');
    return out;
  }

  if (action === 'dispatch_add') {
    return {
      kind: oneOf(obj.kind, KINDS, 'kind'),
      serial: optSerial(obj.serial, 'serial'),
      ticket: obj.ticket == null || obj.ticket === '' ? null : refId(obj.ticket, 'ticket'),
      what: str(obj.what, 200, 'what', true),
      customer: optStr(obj.customer, 120, 'customer'),
      address: optStr(obj.address, 300, 'address'),
      date: optDate(obj.date, 'date'),
      note: optStr(obj.note, 500, 'note'),
    };
  }

  if (action === 'dispatch_claim') {
    return {
      dispatch_id: refId(obj.dispatch_id, 'dispatch_id'),
      rig: oneOf(obj.rig, RIGS, 'rig'),
      date: (() => {
        const v = optDate(obj.date, 'date');
        if (!v) throw httpError(400, 'date is required');
        return v;
      })(),
      driver: oneOf(obj.driver, DRIVERS, 'driver'),
    };
  }

  if (action === 'dispatch_done') {
    return { dispatch_id: refId(obj.dispatch_id, 'dispatch_id'), note: optStr(obj.note, 500, 'note') };
  }

  if (action === 'dispatch_cancel') {
    return { dispatch_id: refId(obj.dispatch_id, 'dispatch_id') };
  }

  /* ------------------------------------------------------------- schema 5 -- */

  // A typed-in dollar figure. Not money we computed and not money we display —
  // the engine recomputes the commission from it. Rejects a string so "14,250"
  // fails here rather than arriving in the vault as NaN.
  const optValue = (v, field) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'number' || !isFinite(v)) throw httpError(400, `${field} must be a number`);
    if (v < 0 || v > MAX_LEAD_VALUE) throw httpError(400, `${field} is out of range`);
    return Math.round(v * 100) / 100;
  };

  if (action === 'lead_open') {
    // No lead id: the engine assigns it, exactly as it does a ticket number.
    // `force` overrides the engine's duplicate check, so it is Matt's alone —
    // for anyone else it is dropped rather than refused, because the safe
    // reading of an unexpected force is "leave the de-dup switched on".
    return {
      customer: str(obj.customer, 120, 'customer', true),
      contact: optStr(obj.contact, 120, 'contact'),
      phone: optStr(obj.phone, 40, 'phone'),
      email: optStr(obj.email, 200, 'email'),
      site: optStr(obj.site, 200, 'site'),
      source: oneOf(obj.source, LEAD_SOURCES, 'source'),
      interest: oneOf(obj.interest, LEAD_INTERESTS, 'interest'),
      machine: optStr(obj.machine, 200, 'machine'),
      serial: optSerial(obj.serial, 'serial'),
      value: optValue(obj.value, 'value'),
      priority: oneOf(obj.priority, PRIORITIES, 'priority'),
      assigned: optOneOf(obj.assigned, ASSIGNEES, 'assigned'),
      next_action: optStr(obj.next_action, 300, 'next_action'),
      note: optStr(obj.note, 1000, 'note'),
      related_ticket: obj.related_ticket == null || obj.related_ticket === '' ? null : refId(obj.related_ticket, 'related_ticket'),
      machinio_ref: optStr(obj.machinio_ref, 64, 'machinio_ref'),
      force: role === 'owner' && obj.force === true,
    };
  }

  if (action === 'lead_update') {
    // Only the keys being changed travel. `service` gets the note and nothing
    // else — a tech relaying "they called back" is useful; a tech re-pricing
    // the deal is not, and a silently-dropped key would be worse than a 403.
    if (role === 'service') {
      for (const k of Object.keys(obj)) {
        if (!SERVICE_LEAD_KEYS.has(k)) throw httpError(403, `role service may only add a note to a lead (got ${k})`);
      }
    }
    const out = { lead: refId(obj.lead, 'lead') };
    const stage = optOneOf(obj.stage, LEAD_STAGES, 'stage');
    if (stage) out.stage = stage;
    const note = optStr(obj.note, 1000, 'note');
    if (note) out.note = note;
    const next = optStr(obj.next_action, 300, 'next_action');
    if (next) out.next_action = next;
    const value = optValue(obj.value, 'value');
    if (value != null) out.value = value;
    const assigned = optOneOf(obj.assigned, ASSIGNEES, 'assigned');
    if (assigned) out.assigned = assigned;
    const priority = optOneOf(obj.priority, PRIORITIES, 'priority');
    if (priority) out.priority = priority;
    const demoDate = optDate(obj.demo_date, 'demo_date');
    if (demoDate) out.demo_date = demoDate;
    const demoSerial = optSerial(obj.demo_serial, 'demo_serial');
    if (demoSerial) out.demo_serial = demoSerial;
    const invoice = optStr(obj.invoice, 64, 'invoice');
    if (invoice) out.invoice = invoice;
    const quote = optStr(obj.quote, 64, 'quote');
    if (quote) out.quote = quote;
    const machine = optStr(obj.machine, 200, 'machine');
    if (machine) out.machine = machine;
    const serial = optSerial(obj.serial, 'serial');
    if (serial) out.serial = serial;
    for (const [k, max] of [['contact', 120], ['phone', 40], ['email', 200], ['site', 200]]) {
      const v = optStr(obj[k], max, k);
      if (v) out[k] = v;
    }
    if (Object.keys(out).length < 2) throw httpError(400, 'lead_update needs at least one field to change');
    return out;
  }

  if (action === 'lead_close') {
    // WON is not an outcome here: a win is reached by moving the stage to
    // INVOICED, which names the invoice. Closing is for the ones that didn't.
    return {
      lead: refId(obj.lead, 'lead'),
      outcome: oneOf(obj.outcome, LEAD_OUTCOMES, 'outcome'),
      reason: optOneOf(obj.reason, LOST_REASONS, 'reason'),
      note: optStr(obj.note, 1000, 'note'),
    };
  }

  return {}; // every action in ACTION_ROLES is handled above
}

/**
 * DELETE /api/event/<id> — undo your own unapplied tap (D46).
 *
 * A "wrong button" valve, not moderation: you may delete an event you created,
 * and only while it is still pending. `owner` gets NO override — Matt undoing
 * Josh's tap would be a silent edit of someone else's proposal, and the way to
 * change a colleague's pending write is to talk to them or make your own.
 *
 * Deletes exactly one key. Never touches `snapshot`, never bulk-deletes, and
 * never logs the id alongside anything that identifies the token.
 */
async function crewUndoEvent({ env, me, rawId }) {
  let id;
  try { id = decodeURIComponent(rawId); } catch { throw httpError(400, 'bad event id'); }

  const bare = id.startsWith('evt:') ? id.slice(4) : id;
  if (!EVENT_ID_RE.test(bare)) throw httpError(400, 'bad event id');
  const key = `evt:${bare}`;

  const stored = await env.FLEET_KV.get(key, 'json');
  // Already drained by the engine, or never existed. The client turns this into
  // "already applied — change it with a new tap", which is the honest reading:
  // by the time you tapped undo it was gone.
  if (!stored) return json({ error: 'event not found' }, 404);

  if (stored.actor !== me.name) throw httpError(403, 'you can only undo your own events');

  await env.FLEET_KV.delete(key);
  return json({ ok: true, id: bare });
}

async function crewHealth({ env }) {
  const [meta, pending_count] = await Promise.all([snapshotMeta(env), countEvents(env)]);
  return json({
    published_at: meta ? meta.published_at : null,
    generated_at: meta ? meta.generated_at : null,
    run_id: meta ? meta.run_id : null,
    pending_count,
  });
}

/* ------------------------------------------------------------------ admin */

async function adminPublish({ request, env }) {
  const text = await request.text();
  if (text.length > MAX_SNAPSHOT_BYTES) throw httpError(413, 'snapshot too large');

  let doc;
  try { doc = JSON.parse(text); } catch { throw httpError(400, 'snapshot is not valid JSON'); }
  if (!doc || typeof doc !== 'object' || !doc.meta || !Number.isInteger(doc.meta.schema_version)) {
    throw httpError(400, 'snapshot needs meta.schema_version');
  }

  const metadata = {
    published_at: new Date().toISOString(),
    generated_at: typeof doc.meta.generated_at === 'string' ? doc.meta.generated_at : null,
    run_id: typeof doc.meta.run_id === 'string' ? doc.meta.run_id.slice(0, 80) : null,
    schema_version: doc.meta.schema_version,
  };
  // Replaced atomically: KV writes are whole-value.
  await env.FLEET_KV.put('snapshot', text, { metadata });

  return json({
    ok: true,
    ...metadata,
    bytes: text.length,
    units: Array.isArray(doc.units) ? doc.units.length : null,
    agreements: Array.isArray(doc.agreements) ? doc.agreements.length : null,
  });
}

async function adminEvents({ env }) {
  const events = await listEvents(env);
  return json({ count: events.length, events });
}

async function adminAck({ request, env }) {
  const body = await readJson(request, 256 * 1024);
  const ids = body && Array.isArray(body.ids) ? body.ids : null;
  if (!ids || !ids.length) throw httpError(400, 'ids must be a non-empty array');
  if (ids.length > MAX_ACK_IDS) throw httpError(400, `max ${MAX_ACK_IDS} ids per ack`);

  // Only the keys we were handed, only under evt:. New events can land while a
  // run is in progress and must survive it.
  const keys = [];
  for (const id of ids) {
    if (typeof id !== 'string') throw httpError(400, 'ids must be strings');
    const key = id.startsWith('evt:') ? id : `evt:${id}`;
    if (!EVENT_KEY_RE.test(key)) throw httpError(400, `bad id: ${id.slice(0, 40)}`);
    keys.push(key);
  }
  await Promise.all(keys.map((k) => env.FLEET_KV.delete(k)));
  return json({ ok: true, deleted: keys.length });
}

async function adminTokens({ request, env }) {
  const map = await readJson(request, 64 * 1024);
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw httpError(400, 'body must be an object');

  const people = [];
  for (const [token, who] of Object.entries(map)) {
    if (!TOKEN_RE.test(token)) throw httpError(400, 'a token has the wrong shape (16-128 chars, [A-Za-z0-9_-])');
    if (!who || typeof who.name !== 'string' || !who.name.trim() || who.name.length > 60) {
      throw httpError(400, 'each entry needs a name');
    }
    if (!ROLES.has(who.role)) throw httpError(400, `role must be owner, sales or service (${who.name})`);
    people.push({ name: who.name.trim(), role: who.role });
  }
  if (!people.length) throw httpError(400, 'refusing to store an empty token map');

  const clean = Object.fromEntries(Object.entries(map).map(([t, w]) => [t, { name: w.name.trim(), role: w.role }]));
  await env.FLEET_KV.put('tokens', JSON.stringify(clean));
  // Names and roles only — token values never go back out.
  return json({ ok: true, count: people.length, people });
}

/* --------------------------------------------------------------- KV utils */

/** Every pending event, oldest first. Keys embed the UTC timestamp, so key order is time order. */
async function listEvents(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.FLEET_KV.list({ prefix: 'evt:', cursor });
    const values = await Promise.all(page.keys.map((k) => env.FLEET_KV.get(k.name, 'json')));
    page.keys.forEach((k, i) => {
      if (values[i]) out.push({ id: k.name.slice(4), key: k.name, event: values[i] });
    });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

async function countEvents(env) {
  let n = 0;
  let cursor;
  do {
    const page = await env.FLEET_KV.list({ prefix: 'evt:', cursor });
    n += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}

/** Snapshot metadata without reading the (large) value. */
async function snapshotMeta(env) {
  const page = await env.FLEET_KV.list({ prefix: 'snapshot', limit: 10 });
  const k = page.keys.find((x) => x.name === 'snapshot');
  return k && k.metadata ? k.metadata : null;
}

/* ---------------------------------------------------------------- helpers */

function corsHeaders(origin, env) {
  const h = { Vary: 'Origin' };
  const ok = origin && (STATIC_ORIGINS.has(origin) ||
    (env.ALLOW_LOCALHOST === '1' && LOCAL_ORIGIN_RE.test(origin)));
  if (ok) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Admin-Secret';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: jsonHeaders() });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function readJson(request, maxBytes) {
  const text = await request.text();
  if (text.length > maxBytes) throw httpError(413, 'body too large');
  try { return JSON.parse(text); } catch { throw httpError(400, 'body is not valid JSON'); }
}

function rand6() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}
