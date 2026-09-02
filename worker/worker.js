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
 *   - Token values are never logged and never echoed back.
 */

const ROLES = new Set(['owner', 'sales', 'service']);
const ACTION_ROLES = {
  reserve: new Set(['owner', 'sales']),
  release: new Set(['owner', 'sales']),
  readiness: new Set(['owner', 'service']),
};
const READINESS = new Set(['READY', 'NEEDS-PREP', 'DOWN']);

const SERIAL_RE = /^[A-Za-z0-9-]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;      // openssl rand -hex 16 -> 32 chars
const EVENT_KEY_RE = /^evt:\S{1,128}$/;
const HOLD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;         // per-hold id from the snapshot (v2)

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
  // in rather than parse + re-stringify a large document on every read.
  const pending = JSON.stringify(events.map((e) => e.event));
  const body = `{"me":${JSON.stringify(me)},"snapshot":${snapshot},"pending":${pending}}`;
  return new Response(body, { status: 200, headers: jsonHeaders() });
}

async function crewEvent({ request, me, env }) {
  const body = await readJson(request, MAX_EVENT_BYTES);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'body must be an object');

  const { action, serial } = body;
  if (!Object.prototype.hasOwnProperty.call(ACTION_ROLES, action)) throw httpError(400, 'unknown action');
  if (typeof serial !== 'string' || !SERIAL_RE.test(serial)) throw httpError(400, 'bad serial');
  if (!ACTION_ROLES[action].has(me.role)) throw httpError(403, `role ${me.role} cannot ${action}`);

  const payload = cleanPayload(action, body.payload);

  // Server stamps everything the client must not be trusted with.
  const ts = new Date().toISOString();
  const id = `${ts}:${rand6()}`;
  const event = { id, ts, actor: me.name, role: me.role, action, serial, payload };

  await env.FLEET_KV.put(`evt:${id}`, JSON.stringify(event));
  return json(event, 201);
}

function cleanPayload(action, p) {
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
    if (!READINESS.has(obj.readiness)) throw httpError(400, 'readiness must be READY, NEEDS-PREP or DOWN');
    return { readiness: obj.readiness, note: str(obj.note, 500, 'note', false) };
  }
  return {}; // readiness handled above; nothing else reaches here
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
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
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
