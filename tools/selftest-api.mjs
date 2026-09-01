#!/usr/bin/env node
/**
 * selftest-api.mjs — proves the mock knobs are inert in production.
 *
 * Mock mode (?mock=, ?role=, ?pending=, ?age=) is a dev tool. On a real host
 * with the API wired, identity must come ONLY from the server's me.role and
 * the snapshot must arrive untouched. This drives docs/api.js against a fake
 * Worker and checks exactly that.
 *
 * Run: npm test        (no dependencies, no network)
 */
import assert from 'node:assert/strict';
import { loadData, postEvent, mockVariant, resolveApiBase, API_BASE } from '../docs/api.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

const PROD = 'https://fleet.wisconsinscrubandsweep.com/';
const PAGES = 'https://mlancourt.github.io/wss-fleet-dashboard/';
const LOCAL = 'http://localhost:8787/';
const API = 'https://example-worker.workers.dev';
const KNOBS = 'mock=full&role=owner&pending=1&age=48';

const SERVER = {
  me: { name: 'Josh', role: 'service' },
  snapshot: { meta: { schema_version: 1, generated_at: '2026-09-01T09:00:00Z' }, units: [] },
  pending: [{ id: 'evt-1', serial: '1', action: 'readiness' }],
};

/** Fake fetch: records every call, answers as the Worker or as the mock files. */
function fakeFetch(opts = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith(API)) {
      if (opts.status) return { ok: false, status: opts.status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => structuredClone(SERVER) };
    }
    if (url.startsWith('mock/')) {
      return { ok: true, status: 200, json: async () => (url.includes('pending')
        ? [{ id: 'mock-evt' }]
        : { meta: { generated_at: '2026-09-01T09:00:00Z' }, units: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls;
  return f;
}

console.log('api / mock-gate self-test');

await check('production URL with every knob set: all inert', async () => {
  const fetch = fakeFetch();
  const d = await loadData({ url: `${PROD}?${KNOBS}`, token: 'tok', apiBase: API, fetch });
  assert.equal(d.source, 'api');
  assert.equal(d.me.role, 'service', 'role must come from the server, not ?role=');
  assert.equal(d.me.name, 'Josh');
  assert.deepEqual(d.pending, SERVER.pending, 'pending must come from the server, not ?pending=');
  assert.equal(d.snapshot.meta.generated_at, SERVER.snapshot.meta.generated_at, '?age= must not touch the snapshot');
  assert.equal(fetch.calls.length, 1, 'exactly one request, to the Worker');
  assert.equal(fetch.calls[0].url, `${API}/api/data`);
  assert.ok(!fetch.calls.some((c) => c.url.startsWith('mock/')), 'no mock file may be fetched in production');
});

await check('pre-DNS github.io host is also production', async () => {
  const fetch = fakeFetch();
  const d = await loadData({ url: `${PAGES}?${KNOBS}`, token: 'tok', apiBase: API, fetch });
  assert.equal(d.source, 'api');
  assert.equal(d.me.role, 'service');
  assert.equal(mockVariant(`${PAGES}?mock=full`, API), null);
});

await check('token travels in the Authorization header, never the URL', async () => {
  const fetch = fakeFetch();
  await loadData({ url: PROD, token: 'sekrit', apiBase: API, fetch });
  const [c] = fetch.calls;
  assert.equal(c.init.headers.Authorization, 'Bearer sekrit');
  assert.ok(!c.url.includes('sekrit'));
});

await check('no token in production: no request at all', async () => {
  const fetch = fakeFetch();
  await assert.rejects(loadData({ url: `${PROD}?${KNOBS}`, token: null, apiBase: API, fetch }),
    (e) => e.code === 'no-token');
  assert.equal(fetch.calls.length, 0, 'the gate screen must not fetch anything');
});

await check('503 -> no-snapshot (Worker up, nothing published)', async () => {
  await assert.rejects(loadData({ url: PROD, token: 'tok', apiBase: API, fetch: fakeFetch({ status: 503 }) }),
    (e) => e.code === 'no-snapshot');
});

await check('401 -> bad-token', async () => {
  await assert.rejects(loadData({ url: PROD, token: 'old', apiBase: API, fetch: fakeFetch({ status: 401 }) }),
    (e) => e.code === 'bad-token');
});

await check('unwired build (no API_BASE) with a token -> no-api', async () => {
  const fetch = fakeFetch();
  await assert.rejects(loadData({ url: PROD, token: 'tok', apiBase: '', fetch }), (e) => e.code === 'no-api');
  assert.equal(fetch.calls.length, 0);
});

await check('mock mode works on localhost, knobs apply', async () => {
  const fetch = fakeFetch();
  const d = await loadData({ url: `${LOCAL}?mock=full&role=sales&pending=1&age=48`, token: null, apiBase: API, fetch });
  assert.equal(d.source, 'mock:full');
  assert.equal(d.me.role, 'sales');
  assert.equal(d.pending.length, 1);
  assert.ok(Date.now() - Date.parse(d.snapshot.meta.generated_at) > 47 * 3600000, 'age knob backdates');
  assert.ok(!fetch.calls.some((c) => c.url.startsWith(API)), 'mock mode never touches the Worker');
});

await check('mock mode works on an unwired build anywhere (M0 preview on Pages)', async () => {
  const d = await loadData({ url: `${PAGES}?mock=empty`, token: null, apiBase: '', fetch: fakeFetch() });
  assert.equal(d.source, 'mock:empty');
  assert.equal(d.me.role, 'owner', 'default mock role');
});

await check('mock mode defaults: no knobs -> owner, no pending, fresh snapshot', async () => {
  const d = await loadData({ url: `${LOCAL}?mock=full`, token: null, apiBase: '', fetch: fakeFetch() });
  assert.equal(d.me.role, 'owner');
  assert.deepEqual(d.pending, []);
  assert.equal(d.snapshot.meta.generated_at, '2026-09-01T09:00:00Z');
});

await check('postEvent: refused in mock mode, posts JSON with Bearer in production', async () => {
  await assert.rejects(postEvent({ url: `${LOCAL}?mock=full`, token: 't', apiBase: '', fetch: fakeFetch() },
    'reserve', '1', {}), (e) => e.code === 'mock');
  const fetch = fakeFetch();
  await postEvent({ url: `${PROD}?mock=full`, token: 'tok', apiBase: API, fetch }, 'reserve', '150074', { customer: 'X' });
  const [c] = fetch.calls;
  assert.equal(c.url, `${API}/api/event`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(c.init.body), { action: 'reserve', serial: '150074', payload: { customer: 'X' } });
});

await check('?api= override only honoured on localhost', async () => {
  assert.equal(resolveApiBase(`${LOCAL}?x=1`, 'http://localhost:8788/'), 'http://localhost:8788');
  assert.equal(resolveApiBase(PROD, 'http://evil.example'), API_BASE, 'production ignores the override');
  assert.equal(resolveApiBase(PAGES, 'https://evil.example'), API_BASE);
  assert.equal(resolveApiBase(LOCAL, 'javascript:alert(1)'), API_BASE, 'non-http override ignored');
  assert.equal(resolveApiBase(LOCAL, null), API_BASE);
});

console.log(`\n${passed} checks passed`);
