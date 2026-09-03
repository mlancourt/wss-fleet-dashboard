/* Data-source layer for WSS Fleet.
 *
 * Pure on purpose: takes the page URL, the token, and a fetch — touches no DOM,
 * so tools/selftest-api.mjs can drive it against a fake Worker.
 *
 * Two sources:
 *   api   the Worker. Identity (me.role) comes ONLY from the server's response.
 *   mock  docs/mock/*.json — fake data for development. Exists only where the
 *         API isn't wired or the page is on localhost. On a real host with a
 *         real API, ?mock= / ?role= / ?pending= / ?age= are inert.
 */

// Set at M2 to the deployed Worker origin, e.g.
//   'https://wss-fleet-worker.mlancourt.workers.dev'
// Empty string = not wired yet (mock mode only).
export const API_BASE = 'https://wss-fleet-worker.mlancourt.workers.dev';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);

export function isLocalHost(url) {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

/**
 * Which Worker to talk to. On localhost a stored override (set via ?api=…,
 * see app.js) lets the page hit `wrangler dev`; anywhere else it is API_BASE,
 * full stop — the URL cannot redirect a real user's traffic.
 */
export function resolveApiBase(url, override) {
  if (override && isLocalHost(url) && /^https?:\/\//.test(override)) return override.replace(/\/+$/, '');
  return API_BASE;
}

// The fake snapshots in docs/mock. `legacy` is the schema-2 file, kept for one
// release so the cutover can be rehearsed against the old shape.
const MOCK_VARIANTS = new Set(['full', 'empty', 'legacy']);

/**
 * 'full' | 'empty' | 'legacy' | null. The gate: with an API wired and a
 * non-local host this is always null, so nothing downstream can be steered
 * from the URL.
 */
export function mockVariant(url, apiBase = API_BASE) {
  if (apiBase && !isLocalHost(url)) return null;
  const v = new URL(url).searchParams.get('mock');
  return MOCK_VARIANTS.has(v) ? v : null;
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

const defaultFetch = (...args) => globalThis.fetch(...args);

/**
 * -> { me, snapshot, pending, source }
 * Throws Error with .code: 'no-token' | 'no-api' | 'bad-token' | 'error'
 */
export async function loadData({ url, token, apiBase = API_BASE, fetch = defaultFetch }) {
  const variant = mockVariant(url, apiBase);
  if (variant) return loadMock(url, variant, fetch);

  if (!token) throw fail('no-token');
  if (!apiBase) throw fail('no-api');

  // Token in the Authorization header, never the URL.
  const res = await fetch(`${apiBase}/api/data`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (res.status === 401) throw fail('bad-token');
  if (res.status === 503) throw fail('no-snapshot');   // Worker is up, engine hasn't published yet
  if (!res.ok) throw fail('error', `API ${res.status}`);
  const body = await res.json();

  // `pending` rides along with /api/data, so the header count needs no second
  // round-trip to /api/health — same number, one less request on bad LTE.
  return { me: body.me, snapshot: body.snapshot, pending: body.pending || [], source: 'api' };
}

async function loadMock(url, variant, fetch) {
  const params = new URL(url).searchParams;
  const res = await fetch(`mock/mock-${variant}.json`, { cache: 'no-store' });
  if (!res.ok) throw fail('error', `mock file ${res.status} — run: npm run mock`);
  const snapshot = await res.json();

  // Mock-only knobs, so states the snapshot can't express are still reviewable:
  //   ?pending=1  load sample unapplied events -> pending badges
  //   ?age=48     backdate generated_at N hours -> the >36h stale warning
  //   ?role=sales pretend to be someone else   -> which write buttons appear
  let pending = [];
  if (params.get('pending')) {
    pending = await fetch('mock/mock-pending.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  const age = Number(params.get('age'));
  if (age > 0 && snapshot.meta) {
    snapshot.meta.generated_at = new Date(Date.now() - age * 3600000).toISOString();
  }

  return {
    me: { name: 'Mock User', role: params.get('role') || 'owner' },
    snapshot,
    pending,
    source: `mock:${variant}`,
  };
}

/** POST /api/event. Returns the stored event as the Worker stamped it. */
export async function postEvent({ url, token, apiBase = API_BASE, fetch = defaultFetch }, action, serial, payload) {
  if (mockVariant(url, apiBase)) throw fail('mock', 'Mock mode — writes are disabled.');
  if (!token) throw fail('no-token', 'No token.');
  const res = await fetch(`${apiBase}/api/event`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, serial, payload }),
  });
  if (!res.ok) throw fail('error', `Event rejected (${res.status})`);
  return res.json();
}
