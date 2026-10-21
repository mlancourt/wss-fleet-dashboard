#!/usr/bin/env node
/**
 * selftest-worker.mjs — drives the REAL worker/worker.js against an in-memory
 * KV, so the Worker's shape rules run under `npm test` and not only in the curl
 * loop (tools/m1-loop.sh, which needs `wrangler dev`). All data here is FAKE.
 *
 * Scope: the D69 work order — INSPECT {step} (the D67 sheet, moved onto the
 * work order), the serial-or-W-number key on every verb but OPEN, OPEN's
 * `inspection` object, CLOSE {ready}, the retired `inspection` action — plus
 * D68 stock and the money refusal. The curl loop keeps the end-to-end proof;
 * this keeps the rules honest per commit.
 */
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

/** A KV namespace with just the surface worker.js uses. */
function fakeKV() {
  const m = new Map();
  const meta = new Map();
  return {
    _m: m,
    _meta: meta,
    async get(key, opt) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      const type = typeof opt === 'string' ? opt : opt && opt.type;
      if (type === 'arrayBuffer') return v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : new TextEncoder().encode(v).buffer;
      if (v instanceof Uint8Array) return v;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, v, opts) {
      if (v instanceof ArrayBuffer) v = new Uint8Array(v);
      m.set(key, typeof v === 'string' || v instanceof Uint8Array ? v : String(v));
      if (opts && opts.metadata) meta.set(key, structuredClone(opts.metadata)); else meta.delete(key);
    },
    async delete(key) { m.delete(key); meta.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name })), list_complete: true, cursor: null };
    },
  };
}

const TOK = { owner: 'selftestowner0000000000000000001', sales: 'selftestsales0000000000000000001', service: 'selftestservice00000000000000001', intake: 'selftestintake000000000000000001' };
const env = { FLEET_KV: fakeKV(), ADMIN_SECRET: 'selftest-admin-secret' };
await env.FLEET_KV.put('tokens', JSON.stringify({
  [TOK.owner]: { name: 'Matt', role: 'owner' },
  [TOK.sales]: { name: 'Kevin', role: 'sales' },
  [TOK.service]: { name: 'Josh', role: 'service' },
  [TOK.intake]: { name: 'Website-Chat', role: 'intake' },
}));

async function post(role, body) {
  const res = await worker.fetch(new Request('https://w.example/api/event', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOK[role]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json() };
}
async function ok(role, body, what) {
  const r = await post(role, body);
  assert.equal(r.status, 201, `${what}: wanted 201, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function refused(role, body, what, status = 400, hint) {
  const r = await post(role, body);
  assert.equal(r.status, status, `${what}: wanted ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  if (hint) assert.ok(String(r.body.error).includes(hint), `${what}: error should mention ${hint} — got ${r.body.error}`);
}
const wo = (payload, serial) => (serial === undefined ? { action: 'work_order', payload } : { action: 'work_order', serial, payload });
const insp = (step, extra = {}, serial) => wo({ action: 'INSPECT', step, ...(serial === undefined ? { work_order: 'W1001' } : {}), ...extra }, serial);

console.log('worker self-test (D69 work order + sheet · D68 stock)');

const FULL_SAVE = {
  machine_class: 'SCRUBBER', body_style: 'WALK-BEHIND',
  battery: { type: 'WET', voltage: 24, pack: '4x6V' },
  readings: { hours_key: 412.5, hours_traction: null, brush1_pct: 60, brush2_pct: 0, brushes_rotated: true },
  cells: [{ battery: 1, cell: 'A', sg: 1.265, clarity: 'CLEAR', level: 'FULL' }, { battery: 1, cell: 'B', sg: null, clarity: null, level: null }],
  items: [{ id: 'ctl.key_switch', result: 'IN-SPEC', note: null }, { id: 'deck.curtains', result: 'REPLACE', note: 'torn' }],
  comments: 'rear squeegee chewed',
};

await check('D69: INSPECT — all four steps, any role at the Worker (REOPEN is the engine’s to referee)', async () => {
  for (const role of ['owner', 'sales', 'service']) {
    const save = await ok(role, insp('SAVE', FULL_SAVE), `${role} SAVE`);
    assert.deepEqual(save.payload, { action: 'INSPECT', step: 'SAVE', work_order: 'W1001', ...FULL_SAVE });
    const done = await ok(role, insp('DONE', { tech: 'Zac' }), `${role} DONE`);
    assert.deepEqual(done.payload, { action: 'INSPECT', step: 'DONE', work_order: 'W1001', tech: 'Zac' });
    const skip = await ok(role, insp('SKIP', { reason: 'gasket only — inspected last week' }), `${role} SKIP`);
    assert.deepEqual(skip.payload, { action: 'INSPECT', step: 'SKIP', work_order: 'W1001', reason: 'gasket only — inspected last week' });
    const re = await ok(role, insp('REOPEN', { note: 'missed the recovery tank' }), `${role} REOPEN`);
    assert.deepEqual(re.payload, { action: 'INSPECT', step: 'REOPEN', work_order: 'W1001', note: 'missed the recovery tank' });
  }
  const last = await ok('service', insp('DONE', { tech: 'Josh', readings: { hours_key: 41 } }), 'DONE carrying the last section');
  assert.deepEqual(last.payload.readings, { hours_key: 41 });
  const one = await ok('service', insp('SAVE', { readings: { hours_key: 7 } }), 'one section');
  assert.deepEqual(Object.keys(one.payload).sort(), ['action', 'readings', 'step', 'work_order']);
  const clear = await ok('service', insp('SAVE', { comments: null }), 'comments cleared');
  assert.equal(clear.payload.comments, null);
});

await check('D69: INSPECT refusals — a 5th step, no step, SKIP with a section / without a reason, a stray key', async () => {
  await refused('owner', insp('SIGN'), 'a 5th step', 400, 'step');
  await refused('owner', insp(undefined), 'no step', 400, 'step');
  await refused('owner', insp('SAVE'), 'SAVE with no section', 400, 'at least one section');
  await refused('service', insp('SKIP', { reason: 'x', items: [] }), 'SKIP with items', 400, 'SKIP carries no sheet sections');
  await refused('service', insp('SKIP', { reason: 'x', readings: { hours_key: 1 } }), 'SKIP with readings', 400, 'readings');
  await refused('service', insp('SKIP'), 'SKIP without a reason', 400, 'reason');
  await refused('service', insp('SKIP', { reason: '   ' }), 'SKIP with a blank reason', 400, 'reason');
  await refused('service', insp('SKIP', { reason: 'x'.repeat(121) }), 'reason 121', 400, 'reason');
  await ok('service', insp('SKIP', { reason: 'x'.repeat(120) }), 'reason 120');
  await refused('owner', insp('DONE', { tech: 'Bob' }), 'tech outside the crew', 400, 'tech');
  await refused('owner', insp('REOPEN', { note: 'x'.repeat(201) }), 'REOPEN note 201', 400, 'note');
  await refused('owner', insp('REOPEN', { comments: 'x' }), 'REOPEN with a section', 400, 'comments');
  await refused('owner', insp('SAVE', { comments: 'x', signature: 'Matt' }), 'unknown top-level key', 400, 'signature');
  await refused('owner', insp('SAVE', { comments: 'x', inspection: 'I1001' }), 'the old I-number key', 400, 'inspection');
  await refused('owner', insp('SAVE', { items: [{ id: 'ctl.key_switch', result: 'FINE' }] }), 'result outside both scales', 400, 'result');
  // A scale MISMATCH (WEAR word on a FUNCTION row) passes here — the row's scale is the library's, and the library is the vault's.
  await ok('owner', insp('SAVE', { items: [{ id: 'ctl.key_switch', result: 'WORN' }] }), 'scale mismatch is the engine’s call');
});

await check('D69: every verb but OPEN — exactly one of work_order or the top-level serial', async () => {
  const verbs = [
    ['INSPECT', { step: 'SAVE', comments: 'x' }], ['INSPECT', { step: 'DONE', tech: 'Zac' }], ['INSPECT', { step: 'SKIP', reason: 'x' }],
    ['INSPECT', { step: 'REOPEN' }], ['ADD-PARTS', { parts: [{ manufacturer: 'KODIAK', part_number: '1', qty: 1 }] }],
    ['PART-STATE', { line: 1, state: 'DELIVERED' }], ['PART-STATE', { line: 1, source: 'SHOP-STOCK' }],
    ['LABOR', { who: 'Zac', hours: 1.5 }], ['SCHEDULE', { date: '2026-10-21' }], ['SCHEDULE', { clear: true }], ['CLOSE', { ready: true }], ['CANCEL', {}],
  ];
  for (const [verb, extra] of verbs) {
    const what = `${verb}${extra.step ? ` ${extra.step}` : ''}`;
    const byW = await ok('owner', wo({ action: verb, work_order: 'W1003', ...extra }), `${what} by W-number`);
    assert.equal(byW.payload.work_order, 'W1003');
    assert.equal(byW.serial, null);
    const byS = await ok('owner', wo({ action: verb, ...extra }, '153928'), `${what} by serial`);
    assert.ok(!('work_order' in byS.payload), `${what}: no invented work_order key`);
    assert.equal(byS.serial, '153928');
    await refused('owner', wo({ action: verb, work_order: 'W1003', ...extra }, '153928'), `${what} with both`, 400, 'not both');
    await refused('owner', wo({ action: verb, ...extra }), `${what} with neither`, 400, 'needs the work_order');
  }
  await refused('owner', wo({ action: 'CLOSE', work_order: 'I1001' }), 'an I-number as the work order', 400, 'W1001');
  await refused('owner', wo({ action: 'OPEN', purpose: 'PM' }), 'OPEN without a serial', 400, 'serial');
});

await check('D69: OPEN — purpose is the five (+ RENT-READY, mapped by the engine), inspection is an OBJECT', async () => {
  for (const p of ['CHECKOUT', 'RETURN', 'PM', 'REPAIR', 'OTHER', 'RENT-READY']) {
    assert.equal((await ok('service', wo({ action: 'OPEN', purpose: p }, '153928'), `purpose ${p}`)).payload.purpose, p);
  }
  assert.equal((await ok('service', wo({ action: 'OPEN' }, '153928'), 'purpose left off')).payload.purpose, null, 'the engine picks the default');
  await refused('service', wo({ action: 'OPEN', purpose: 'BOGUS' }, '153928'), 'purpose BOGUS', 400, 'purpose');
  const first = await ok('service', wo({ action: 'OPEN', purpose: 'RETURN', inspection: { readings: { hours_key: 41 }, body_style: 'STAND-ON' } }, '153928'), 'OPEN + first save');
  assert.deepEqual(first.payload.inspection, { body_style: 'STAND-ON', readings: { hours_key: 41 } });
  const plain = await ok('service', wo({ action: 'OPEN', purpose: 'PM', parts: [] }, '153928'), 'OPEN without');
  assert.ok(!('inspection' in plain.payload), 'absent stays absent');
  await refused('service', wo({ action: 'OPEN', purpose: 'REPAIR', inspection: 'I1001' }, '153928'), 'the retired string back-link', 400, 'retired');
  await refused('service', wo({ action: 'OPEN', purpose: 'REPAIR', inspection: [] }, '153928'), 'a list', 400, 'object');
  await refused('service', wo({ action: 'OPEN', inspection: { kind: 'PM' } }, '153928'), 'an unknown section', 400, 'kind');
  await refused('service', wo({ action: 'OPEN', inspection: { cells: [{ battery: 1, cell: 'A', sg: 2 }] } }, '153928'), 'a bad section inside', 400, 'sg');
});

await check('D69: CLOSE takes ready (a real boolean, owner only); absent stays absent', async () => {
  assert.equal((await ok('owner', wo({ action: 'CLOSE', work_order: 'W1003', ready: true }), 'ready true')).payload.ready, true);
  assert.equal((await ok('owner', wo({ action: 'CLOSE', work_order: 'W1003', ready: false }), 'ready false')).payload.ready, false);
  assert.ok(!('ready' in (await ok('owner', wo({ action: 'CLOSE', work_order: 'W1003' }), 'ready left off')).payload));
  await refused('owner', wo({ action: 'CLOSE', work_order: 'W1003', ready: 'yes' }), 'ready "yes"', 400, 'ready');
  await refused('owner', wo({ action: 'CLOSE', work_order: 'W1003', ready: 1 }), 'ready 1', 400, 'ready');
  await refused('service', wo({ action: 'CLOSE', work_order: 'W1003', ready: true }), 'service close', 403);
  await refused('owner', wo({ action: 'CANCEL', work_order: 'W1003', ready: true }), 'ready on CANCEL', 400, 'ready');
});

await check('D69: the `inspection` action is retired — every verb 400s', async () => {
  for (const verb of ['OPEN', 'SAVE', 'DONE', 'REOPEN', 'VOID']) {
    await refused('owner', { action: 'inspection', serial: '153928', payload: { action: verb, kind: 'PM' } }, `inspection ${verb}`, 400, 'unknown action');
  }
});

await check('cells ≤ 18, sg 1.000–1.400, items ≤ 120 — the D67 shape rules, now under INSPECT', async () => {
  const cells = [];
  for (let b = 1; b <= 6; b++) for (const c of ['A', 'B', 'C', 'D']) cells.push({ battery: b, cell: c, sg: 1.2 });
  await refused('owner', insp('SAVE', { cells: cells.slice(0, 19) }), '19 cells', 400, '18');
  await ok('owner', insp('SAVE', { cells: cells.slice(0, 18) }), '18 cells');
  await refused('owner', insp('SAVE', { cells: [{ battery: 1, cell: 'A', sg: 2.0 }] }), 'sg 2.0', 400, 'sg');
  await refused('owner', insp('SAVE', { cells: [{ battery: 1, cell: 'A', sg: 0.99 }] }), 'sg 0.99');
  await ok('owner', insp('SAVE', { cells: [{ battery: 1, cell: 'A', sg: 1.0 }, { battery: 1, cell: 'B', sg: 1.4 }] }), 'sg at both edges');
});

await check('lengths, enums and shapes inside the sections', async () => {
  const bad = (payload, what, hint) => refused('owner', insp('SAVE', payload), what, 400, hint);
  const items = Array.from({ length: 121 }, (_, i) => ({ id: `ctl.r${i}`, result: 'N/A' }));
  await bad({ items }, '121 items', '120');
  await ok('owner', insp('SAVE', { items: items.slice(0, 120) }), '120 items');
  await bad({ items: [{ id: 'ctl.a', result: 'GOOD' }, { id: 'ctl.a', result: 'WORN' }] }, 'a row answered twice', 'twice');
  await bad({ items: [{ id: 'ctl.a', result: 'GOOD', note: 'x'.repeat(121) }] }, 'item note 121', 'note');
  await bad({ items: [{ id: 'ctl.a', result: 'GOOD', photo: 'x' }] }, 'unknown item key', 'photo');
  await bad({ comments: 'x'.repeat(1001) }, 'comments 1001', 'comments');
  await bad({ machine_class: 'VACUUM' }, 'class enum');
  await bad({ body_style: 'RIDE-ON' }, 'body_style enum');
  await bad({ controls: 'RIDER' }, 'the retired controls key', 'controls');
  await bad({ readings: { recharge_count: 88 } }, 'no recharge counter any more', 'recharge_count');
  await bad({ readings: { brush1_length: 1.5 } }, 'lengths are gone', 'brush1_length');
  await bad({ battery: { type: 'GEL', voltage: 24 } }, 'battery type enum');
  await bad({ battery: { type: 'WET', voltage: 48 } }, 'voltage 48', 'voltage');
  await bad({ battery: { type: 'WET', voltage: 24, pack: '3x12V' } }, 'pack vs voltage', 'pack');
  await bad({ battery: { type: 'AGM', voltage: 24, pack: '4x6V' } }, 'a pack on AGM', 'WET');
  await ok('owner', insp('SAVE', { battery: { type: 'LITHIUM', voltage: 36, pack: null } }), 'lithium, no pack');
  await bad({ readings: { hours_key: '412' } }, 'hours as a string', 'number');
  await bad({ readings: { hours_key: -1 } }, 'negative hours');
  await bad({ readings: { hours_key: 100000 } }, 'hours > 99999');
  await bad({ readings: { brush1_pct: 101 } }, 'a brush at 101%', 'brush1_pct');
  await bad({ readings: { main_broom_pct: -1 } }, 'a broom at -1%');
  await bad({ readings: { brush2_pct: 55.5 } }, 'a fractional percent', 'whole-number');
  await ok('owner', insp('SAVE', { readings: { main_broom_pct: 0, brush1_pct: 100, brush2_pct: null } }), 'percent edges + null');
  await bad({ readings: { brushes_rotated: 'Y' } }, 'rotated as a string', 'true or false');
  // D74: vac meter + scrub head + the pad needs.
  await ok('owner', insp('SAVE', { readings: { hours_vac: 812.5, head_type: 'PAD', pad_drivers_needed: true, pads_needed: true, pad_diameter: 17, pad_color: 'red' } }), 'a PAD head with pads');
  await ok('owner', insp('SAVE', { readings: { head_type: 'BRUSH', brush1_pct: 40, brushes_rotated: false } }), 'a BRUSH head');
  await bad({ readings: { head_type: 'DISC' } }, 'an unknown head type', 'BRUSH or PAD');
  await bad({ readings: { pads_needed: 'yes' } }, 'a pad need as a string', 'true or false');
  await bad({ readings: { pad_diameter: 61 } }, 'a 61-inch pad', 'pad_diameter');
  await bad({ readings: { pad_color: 'x'.repeat(21) } }, 'a 21-char color', '20 characters');
  await bad({ readings: { pad_color: 7 } }, 'a numeric color', 'text');
  await bad({ readings: { hours_vac: 100000 } }, 'vac hours over the meter', 'hours_vac');
  await bad({ readings: { odometer: 5 } }, 'unknown reading', 'odometer');
  await bad({ cells: [{ battery: 7, cell: 'A' }] }, 'battery 7');
  await bad({ cells: [{ battery: 1, cell: 'G' }] }, 'cell G');
  await bad({ cells: [{ battery: 1, cell: 'A' }, { battery: 1, cell: 'A' }] }, 'a cell twice', 'twice');
  await bad({ cells: [{ battery: 1, cell: 'A', clarity: 'MILKY' }] }, 'clarity enum');
  await bad({ cells: [{ battery: 1, cell: 'A', level: 'HALF' }] }, 'level enum');
});

await check('no money travels on a sheet either — refused by name (D65), at any depth', async () => {
  await refused('owner', insp('SAVE', { items: [{ id: 'ctl.a', result: 'REPAIR', cost: 40 }] }), 'cost in an item', 400, '"cost"');
  await refused('owner', insp('SAVE', { comments: 'x', price: 1 }), 'price at the top', 400, '"price"');
  await refused('owner', wo({ action: 'OPEN', purpose: 'PM', inspection: { readings: { hours_key: 1 }, rate: 95 } }, '153928'), 'rate inside OPEN’s sheet', 400, '"rate"');
  await refused('owner', insp('SKIP', { reason: 'x', cost: 0 }), 'cost on a SKIP', 400, '"cost"');
});

await check('a whole sheet fits the 32 KB cap', async () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `sect.row_${i}`, result: 'REPAIR', note: 'n'.repeat(120) }));
  const cells = [];
  for (let b = 1; b <= 6; b++) for (const c of ['A', 'B', 'C']) cells.push({ battery: b, cell: c, sg: 1.265, clarity: 'CLOUDY', level: 'OVERFILLED' });
  await ok('service', insp('SAVE', { ...FULL_SAVE, items, cells, comments: 'c'.repeat(1000) }), 'max sheet');
});

const STOCK = { manufacturer: 'FACTORY-CAT', part_number: '264-4086', description: 'filter', qty: 1 };

await check('D68: parts[].source (VENDOR | SHOP-STOCK | WARRANTY) on OPEN and ADD-PARTS, any role; absent stays absent', async () => {
  for (const role of ['owner', 'sales', 'service']) {
    const o = await ok(role, wo({ action: 'OPEN', purpose: 'REPAIR', parts: [{ ...STOCK, source: 'SHOP-STOCK' }, { ...STOCK, part_number: '1', source: 'WARRANTY' }, { ...STOCK, part_number: '2' }] }, '900100'), `${role} OPEN`);
    assert.deepEqual(o.payload.parts.map((p) => p.source), ['SHOP-STOCK', 'WARRANTY', undefined]);
    const a = await ok(role, wo({ action: 'ADD-PARTS', work_order: 'W1002', parts: [{ ...STOCK, source: 'VENDOR' }] }), `${role} ADD-PARTS`);
    assert.equal(a.payload.parts[0].source, 'VENDOR');
  }
  await refused('owner', wo({ action: 'ADD-PARTS', work_order: 'W1002', parts: [{ ...STOCK, source: 'SHELF' }] }), 'source enum', 400, 'source');
});

await check('D68: PART-STATE {source: SHOP-STOCK} — service + owner 201 (state optional, lands DELIVERED), sales 403', async () => {
  for (const role of ['owner', 'service']) {
    const e = await ok(role, wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, source: 'SHOP-STOCK', note: 'on the shelf' }), `${role} stock pull`);
    assert.deepEqual(e.payload, { action: 'PART-STATE', work_order: 'W1002', line: 1, state: 'DELIVERED', source: 'SHOP-STOCK', date: null, note: 'on the shelf' });
    await ok(role, wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, state: 'DELIVERED', source: 'SHOP-STOCK' }), `${role} with state DELIVERED`);
  }
  await refused('sales', wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, source: 'SHOP-STOCK' }), 'sales stock pull', 403);
  await refused('owner', wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, source: 'WARRANTY' }), 'WARRANTY on PART-STATE', 400, 'SHOP-STOCK');
  await refused('owner', wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, source: 'VENDOR' }), 'VENDOR on PART-STATE', 400, 'SHOP-STOCK');
  await refused('owner', wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, source: 'SHOP-STOCK', state: 'ORDERED' }), 'source + ORDERED', 400, 'ORDERED');
  await refused('service', wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, source: 'SHOP-STOCK', state: 'IN-TRANSIT' }), 'source + IN-TRANSIT', 400);
  await refused('owner', wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, source: 'SHOP-STOCK', vendor: 'RPS' }), 'a vendor on a stock pull', 400, 'vendor');
  await refused('owner', wo({ action: 'PART-STATE', work_order: 'W1002', line: 1 }), 'no state and no source', 400, 'state');
  await refused('service', wo({ action: 'PART-STATE', work_order: 'W1002', line: 1, source: 'SHOP-STOCK', cost: 12 }), 'money on a stock pull', 400, '"cost"');
  await refused('owner', wo({ action: 'OPEN', purpose: 'REPAIR', parts: [{ ...STOCK, source: 'SHOP-STOCK', price: 9 }] }, '900100'), 'money on a stock line', 400, '"price"');
});

await check('the undo valve (D46) covers a work-order tap — your own, still pending', async () => {
  const e = await ok('service', insp('SAVE', { comments: 'x' }, '900102'), 'serial-keyed SAVE');
  const del = (role) => worker.fetch(new Request(`https://w.example/api/event/${encodeURIComponent(e.id)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${TOK[role]}` } }), env);
  assert.equal((await del('owner')).status, 403, 'not Matt’s to undo');
  assert.equal((await del('service')).status, 200);
  assert.equal((await del('service')).status, 404, 'gone');
});

await check('D71: LABOR takes kind (LABOR | TRAVEL, case-insensitive); absent stays absent; money still refused', async () => {
  const L = (extra) => wo({ action: 'LABOR', work_order: 'W1003', date: '2026-09-25', who: 'Josh', hours: 0.5, ...extra });
  assert.equal((await ok('service', L({ kind: 'TRAVEL' }), 'TRAVEL')).payload.kind, 'TRAVEL');
  assert.equal((await ok('service', L({ kind: 'LABOR' }), 'LABOR')).payload.kind, 'LABOR');
  assert.equal((await ok('sales', L({ kind: 'travel' }), 'lowercase travel')).payload.kind, 'TRAVEL');
  assert.ok(!('kind' in (await ok('owner', L({}), 'kind left off')).payload), 'the engine defaults it');
  assert.ok(!('kind' in (await ok('owner', L({ kind: null }), 'kind null')).payload));
  await refused('owner', L({ kind: 'DRIVE' }), 'kind DRIVE', 400, 'kind');
  await refused('owner', L({ kind: 'TRAVEL', rate: 75 }), 'a rate beside kind', 400, '"rate"');
  await refused('owner', L({ kind: 'LABOR', cost: 75 }), 'a cost beside kind', 400, '"cost"');
  await refused('owner', wo({ action: 'CLOSE', work_order: 'W1003', kind: 'TRAVEL' }), 'kind on CLOSE', 400, 'kind');
});

await check('D92: SCHEDULE — any role; date (+ tech from the crew) or clear: true, never both; shape refused; money refused', async () => {
  const S = (extra) => wo({ action: 'SCHEDULE', work_order: 'W1003', ...extra });
  assert.deepEqual((await ok('service', S({ date: '2026-10-21', tech: 'Zac', note: 'PM on site' }), 'date + tech')).payload,
    { action: 'SCHEDULE', work_order: 'W1003', note: 'PM on site', date: '2026-10-21', tech: 'Zac' });
  assert.ok(!('tech' in (await ok('owner', S({ date: '2026-10-21' }), 'date only')).payload));
  assert.deepEqual((await ok('sales', S({ clear: true }), 'clear')).payload, { action: 'SCHEDULE', work_order: 'W1003', note: null, clear: true });
  await refused('owner', S({}), 'neither', 400, 'needs a date');
  await refused('owner', S({ date: 'next tuesday' }), 'a bad date', 400, 'date');
  await refused('owner', S({ date: '2026-10-21', clear: true }), 'date and clear', 400, 'clear takes no');
  await refused('owner', S({ clear: false }), 'clear false', 400, 'clear must be true');
  await refused('owner', S({ date: '2026-10-21', tech: 'Bob' }), 'a stranger', 400, 'tech');
  await refused('owner', S({ date: '2026-10-21', who: 'Zac' }), 'who instead of tech', 400, 'who');
  await refused('owner', S({ date: '2026-10-21', price: 5 }), 'money', 400, '"price"');
});

await check('D77: doc_detach — any role, {record, doc_id} only, no store check; shape refused; unknown action still 400', async () => {
  const D = (payload, serial) => (serial === undefined ? { action: 'doc_detach', payload } : { action: 'doc_detach', serial, payload });
  for (const role of ['owner', 'sales', 'service']) {
    // No docmeta for this id in the fake KV — the vault is the authority, the Worker does not look.
    const e = await ok(role, D({ record: 's1034', doc_id: '4f2a91c07be3d518', kind: 'WORKORDER', name: 'x.pdf' }), `${role} detach`);
    assert.deepEqual(e.payload, { record: 'S1034', doc_id: '4f2a91c07be3d518' }, 'record upper-cased; kind + name dropped');
    assert.equal(e.serial, null);
  }
  assert.equal((await ok('sales', D({ record: 'L1005', doc_id: 'aaaabbbbccccdddd' }, null), 'lead, serial null')).payload.record, 'L1005');
  await refused('service', D({ record: 'S1034', doc_id: 'NOTHEX0000000000' }), 'bad doc_id', 400, 'doc_id');
  await refused('service', D({ record: 'S1034', doc_id: '../snapshot' }), 'path doc_id', 400, 'doc_id');
  await refused('service', D({ record: 'S1034' }), 'no doc_id', 400, 'doc_id');
  assert.equal((await ok('service', D({ record: 'W1001', doc_id: '4f2a91c07be3d518' }), 'D116: a fleet work order is a record')).payload.record, 'W1001');
  await refused('service', D({ record: 'R4050', doc_id: '4f2a91c07be3d518' }), 'an agreement is not a record', 400, 'record');
  await refused('service', D({ doc_id: '4f2a91c07be3d518' }), 'no record', 400, 'record');
  await refused('owner', D({ record: 'S1034', doc_id: '4f2a91c07be3d518', price: 5 }), 'money on a detach', 400, '"price"');
  await refused('owner', { action: 'doc_delete', payload: { record: 'S1034', doc_id: '4f2a91c07be3d518' } }, 'unknown action', 400, 'unknown action');
});

await check('D79: ticket_update order keys — vendor normalised, ref/note trimmed, bad values 400 by name, wrong stage refused', async () => {
  const T = (payload) => ({ action: 'ticket_update', payload: { ticket: 'S1030', ...payload } });
  const born = await ok('service', T({ stage: 'WAITING-ON-PARTS', vendor: 'ipc eagle', vendor_ref: '  SO0001234 ', order_note: ' 2 squeegees ' }), 'birth');
  assert.deepEqual(born.payload, { ticket: 'S1030', stage: 'WAITING-ON-PARTS', vendor: 'IPC-EAGLE', vendor_ref: 'SO0001234', order_note: '2 squeegees' });
  assert.equal((await ok('owner', T({ vendor: 'rps' }), 'edit, no stage')).payload.vendor, 'RPS');
  assert.equal((await ok('sales', T({ vendor_ref: 'X1' }), 'edit by sales — ticket_update is any role')).payload.vendor_ref, 'X1');
  const bare = await ok('service', T({ stage: 'WAITING-ON-PARTS' }), 'stage alone');
  assert.ok(!('vendor' in bare.payload) && !('order_note' in bare.payload), 'absent stays absent');
  await refused('service', T({ vendor: 'GRAINGER' }), 'unknown vendor', 400, 'vendor');
  await refused('service', T({ vendor: 7 }), 'numeric vendor', 400, 'vendor');
  await refused('service', T({ vendor_ref: 'x'.repeat(41) }), 'ref 41', 400, 'vendor_ref');
  await refused('service', T({ vendor_ref: 12345 }), 'numeric ref', 400, 'vendor_ref');
  await refused('service', T({ order_note: 'x'.repeat(141) }), 'note 141', 400, 'order_note');
  await refused('service', T({ order_note: ['a'] }), 'array note', 400, 'order_note');
  await refused('service', T({ stage: 'SCHEDULED', vendor: 'RPS' }), 'vendor with another stage', 400, 'WAITING-ON-PARTS');
  await refused('owner', T({ vendor: 'RPS', cost_total: 412 }), 'cost on the order', 400, 'cost_total');
});

await check('D79: publish refuses order cost on service_queue by name; a figure in a quote log still publishes', async () => {
  const pub = async (doc) => {
    const res = await worker.fetch(new Request('https://w.example/api/admin/publish', {
      method: 'POST', headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
    }), env);
    return { status: res.status, body: await res.json() };
  };
  const snap = (t) => ({ meta: { schema_version: 7 }, service_queue: [{ ticket: 'S1030', status: 'OPEN', log: [], ...t }] });
  const order = { state: 'ORDERED', vendor: 'RPS', vendor_ref: 'SO1', ordered: '2026-09-30', tracking: null, carrier: null, delivered: null, note: null };
  assert.equal((await pub(snap({ order }))).status, 200);
  assert.equal((await pub(snap({ order: null }))).status, 200);
  assert.equal((await pub({ meta: { schema_version: 7 } })).status, 200, 'pre-D79: no service_queue at all');
  for (const k of ['cost_total', 'cost_source_inv', 'COST_TOTAL']) {
    const r = await pub(snap({ order: { ...order, [k]: 1 } }));
    assert.equal(r.status, 400, k);
    assert.ok(r.body.error.includes(k) && r.body.error.includes('S1030'), r.body.error);
  }
  const top = await pub(snap({ cost_total: 5 }));
  assert.equal(top.status, 400, 'the key anywhere on the row');
  const fig = await pub(snap({ order: { ...order, note: 'came to $412' } }));
  assert.equal(fig.status, 400);
  assert.ok(fig.body.error.includes('dollar figure'), fig.body.error);
  const quoteLog = await pub(snap({ order, log: [{ ts: 'x', who: 'Matt', text: 'quote sent $2,480' }] }));
  assert.equal(quoteLog.status, 200, 'ticket logs carry quote amounts by design (money-gate.mjs) — not refused');
});

await check('D82 intake: opens a lead (WEB-CHAT) and a ticket, nothing else, reads nothing', async () => {
  const lead = await ok('intake', { action: 'lead_open', payload: { customer: 'Acme', contact: 'Pat', email: 'pat@example.com', source: 'WEB-CHAT', interest: 'PARTS', priority: 'MEDIUM', assigned: 'Kevin', note: '[visitor text — untrusted] hi', force: true } }, 'intake lead_open');
  assert.equal(lead.actor, 'Website-Chat'); assert.equal(lead.role, 'intake');
  assert.equal(lead.payload.force, false, 'force is owner-only');
  await ok('intake', { action: 'ticket_open', payload: { machine_owner: 'CUSTOMER', customer: 'Acme', issue: 'PARTS REQUEST: squeegee', priority: 'LOW', location: 'AT-CUSTOMER', intake_move: 'NONE', return_move: 'NONE' } }, 'intake ticket_open');
  await refused('intake', { action: 'ticket_update', payload: { ticket: 'S1001', note: 'x' } }, 'intake ticket_update', 403);
  await refused('intake', { action: 'lead_update', payload: { lead: 'L1001', note: 'x' } }, 'intake lead_update', 403);
  await refused('intake', { action: 'lead_close', payload: { lead: 'L1001', outcome: 'DEAD' } }, 'intake lead_close', 403);
  // D84: SPAM is a legal outcome for sales/owner, no reason; intake still can't close anything
  await refused('intake', { action: 'lead_close', payload: { lead: 'L1001', outcome: 'SPAM' } }, 'intake lead_close SPAM', 403);
  const spam = await ok('sales', { action: 'lead_close', payload: { lead: 'L1001', outcome: 'SPAM', reason: null, note: null } }, 'sales lead_close SPAM');
  assert.equal(spam.payload.outcome, 'SPAM');
  assert.equal(spam.payload.reason, null, 'no reason rides with SPAM');
  await refused('sales', { action: 'lead_close', payload: { lead: 'L1001', outcome: 'JUNK' } }, 'unknown outcome', 400);
  await refused('intake', { action: 'doc_attach', payload: {} }, 'intake doc_attach', 403);
  const call = (method, path) => worker.fetch(new Request('https://w.example' + path, { method, headers: { Authorization: `Bearer ${TOK.intake}` } }), env);
  for (const [m, p] of [['GET', '/api/data'], ['GET', '/api/health'], ['POST', '/api/doc'], ['GET', '/api/doc/abc'], ['DELETE', '/api/event/x']]) {
    assert.equal((await call(m, p)).status, 403, `${m} ${p}`);
  }
  assert.equal((await post('sales', { action: 'lead_open', payload: { customer: 'B', source: 'WEB-CHAT', interest: 'RENTAL', priority: 'LOW' } })).status, 201, 'WEB-CHAT is a legal source for everyone');
});

/* ------------------------------------------------------------ D88 parts -- */

const PO = (payload) => ({ action: 'parts_open', payload });
const PU = (payload) => ({ action: 'parts_update', payload: { order: 'P1001', ...payload } });
const PC = (payload) => ({ action: 'parts_close', payload: { order: 'P1001', ...payload } });

await check('D88: parts_open — any crew role (not intake), customer + parts required, enums upper-cased, unknown key 400 by name', async () => {
  for (const role of ['owner', 'sales', 'service']) {
    const e = await ok(role, PO({ customer: ' Acme Foods ', parts: '2x squeegee blade', terms: 'cash', supply: 'VENDOR', ship_to: 'customer',
      ship_address: '1 Example Way', source: 'PHONE', assigned: 'Matt', value: 312.5, related_ticket: 's1030', related_lead: 'L1037' }), `${role} parts_open`);
    assert.equal(e.payload.customer, 'Acme Foods');
    assert.equal(e.payload.terms, 'CASH'); assert.equal(e.payload.ship_to, 'CUSTOMER');
    assert.equal(e.payload.related_ticket, 'S1030'); assert.equal(e.payload.value, 312.5);
    assert.equal(e.payload.machine, null, 'absent keys normalised to null');
    assert.equal(e.serial, null);
  }
  { // D99: intake (the site chat) may OPEN a parts order (source WEB-CHAT), never update or close one
    const e = await ok('intake', PO({ customer: 'A', parts: 'x', source: 'WEB-CHAT' }), 'D99: intake opens parts orders');
    assert.equal(e.payload.source, 'WEB-CHAT');
  }
  await refused('intake', { action: 'parts_update', payload: { order: 'P1001', note: 'x' } }, 'intake update', 403);
  await refused('intake', { action: 'parts_close', payload: { order: 'P1001', reason: 'OTHER' } }, 'intake close', 403);
  await refused('owner', PO({ parts: 'x' }), 'no customer', 400, 'customer');
  await refused('owner', PO({ customer: 'A' }), 'no parts', 400, 'parts');
  await refused('owner', PO({ customer: 'A', parts: 'x'.repeat(2001) }), 'parts 2001', 400, 'parts');
  await refused('owner', PO({ customer: 'A', parts: 'x', ship_address: 'x'.repeat(201) }), 'address 201', 400, 'ship_address');
  await refused('owner', PO({ customer: 'A', parts: 'x', note: 'x'.repeat(1001) }), 'note 1001', 400, 'note');
  await refused('owner', PO({ customer: 'A', parts: 'x', terms: 'NET30' }), 'bad terms', 400, 'terms');
  await refused('owner', PO({ customer: 'A', parts: 'x', source: 'FAX' }), 'bad source', 400, 'source');
  await refused('owner', PO({ customer: 'A', parts: 'x', value: '312' }), 'string value', 400, 'value');
  await refused('owner', PO({ customer: 'A', parts: 'x', value: -1 }), 'negative value', 400, 'value');
  await refused('owner', PO({ customer: 'A', parts: 'x', priority: 'HIGH' }), 'unknown key', 400, '"priority"');
  await refused('owner', PO({ customer: 'A', parts: 'x', related_ticket: 'L1001' }), 'a lead is not a ticket', 400, 'related_ticket');
  await refused('owner', PO({ customer: 'A', parts: 'x', cost_total: 5 }), 'cost on a phone', 400, 'cost_total');
});

await check('D88: parts_update — only the keys being changed; service = note only (403); ORDERED owner-only; gate fields ride with the stage', async () => {
  const e = await ok('owner', PU({ stage: 'ordered', vendor: 'ipc eagle', vendor_ref: ' SO1 ', paid: '2026-10-13', invoice: '4310' }), 'owner ORDERED + gate');
  assert.deepEqual(e.payload, { order: 'P1001', stage: 'ORDERED', vendor: 'IPC-EAGLE', vendor_ref: 'SO1', paid: '2026-10-13', invoice: '4310' });
  assert.deepEqual((await ok('sales', PU({ stage: 'QUOTED', quote: '44040', value: 312.5 }), 'sales QUOTED')).payload,
    { order: 'P1001', stage: 'QUOTED', quote: '44040', value: 312.5 });
  assert.deepEqual((await ok('sales', PU({ customer_po: 'PO-77' }), 'a field alone')).payload, { order: 'P1001', customer_po: 'PO-77' });
  assert.deepEqual((await ok('service', PU({ note: 'they called back' }), 'service note')).payload, { order: 'P1001', note: 'they called back' });
  await refused('service', PU({ stage: 'APPROVED' }), 'service stage', 403, 'note');
  await refused('service', PU({ note: 'x', value: 5 }), 'service value', 403, 'note');
  await refused('sales', PU({ stage: 'ORDERED', vendor: 'RPS', customer_po: 'X' }), 'sales ORDERED', 403, 'owner');
  await refused('owner', PU({}), 'nothing to change', 400, 'at least one');
  await refused('owner', { action: 'parts_update', payload: { note: 'x' } }, 'no order', 400, 'order');
  await refused('owner', PU({ order: 'W1001', note: 'x' }), 'a W is not a P', 400, 'order');
  await refused('owner', PU({ stage: 'SHIPPED' }), 'bad stage', 400, 'stage');
  await refused('owner', PU({ vendor: 'GRAINGER' }), 'bad vendor', 400, 'vendor');
  await refused('owner', PU({ paid: '10/13/2026' }), 'bad paid date', 400, 'paid');
  await refused('owner', PU({ outcome: 'LOST' }), 'unknown key', 400, '"outcome"');
  await refused('owner', PU({ cost_source_inv: 'X' }), 'cost on a phone', 400, 'cost_source_inv');
});

await check('D98: parts_update ship_from + ship_lines — only with tracking; SHOP|VENDOR upper-cased; lines <= 300; service still note-only', async () => {
  for (const role of ['owner', 'sales']) {
    const e = await ok(role, PU({ tracking: '1Z999AA10123456784', ship_from: 'shop', ship_lines: ' 2x fast packs ' }), `${role} ship from shop`);
    assert.deepEqual(e.payload, { order: 'P1001', tracking: '1Z999AA10123456784', ship_from: 'SHOP', ship_lines: '2x fast packs' });
  }
  assert.deepEqual((await ok('owner', PU({ stage: 'IN-TRANSIT', tracking: '1Z1', ship_from: 'VENDOR' }), 'vendor shipped')).payload,
    { order: 'P1001', stage: 'IN-TRANSIT', tracking: '1Z1', ship_from: 'VENDOR' });
  assert.equal((await ok('owner', PU({ tracking: '1Z1', ship_lines: 'x'.repeat(300) }), '300 chars')).payload.ship_lines.length, 300);
  await refused('owner', PU({ ship_from: 'SHOP' }), 'ship_from without tracking', 400, 'ship_from');
  await refused('owner', PU({ ship_lines: 'fast packs' }), 'ship_lines without tracking', 400, 'ship_lines');
  await refused('owner', PU({ note: 'x', ship_from: 'SHOP' }), 'ship_from beside a note only', 400, 'ship_from');
  await refused('owner', PU({ tracking: '1Z1', ship_from: 'UPS' }), 'bad enum', 400, 'ship_from');
  await refused('owner', PU({ tracking: '1Z1', ship_lines: 'x'.repeat(301) }), 'lines 301', 400, 'ship_lines');
  await refused('service', PU({ tracking: '1Z1', ship_from: 'SHOP' }), 'service ships', 403, 'note');
});

await check('D88: parts_close — sales/owner; COMPLETE owner-only; reason only on LOST; service 403', async () => {
  const c = await ok('owner', PC({ outcome: 'COMPLETE', invoice: '4310', reason: 'PRICE' }), 'owner COMPLETE');
  assert.deepEqual(c.payload, { order: 'P1001', outcome: 'COMPLETE', reason: null, invoice: '4310', note: null });
  const l = await ok('sales', PC({ outcome: 'LOST', reason: 'sourced-elsewhere', note: 'Amazon' }), 'sales LOST');
  assert.equal(l.payload.reason, 'SOURCED-ELSEWHERE');
  assert.equal((await ok('sales', PC({ outcome: 'DEAD' }), 'sales DEAD')).payload.reason, null);
  await refused('sales', PC({ outcome: 'COMPLETE', invoice: '1' }), 'sales COMPLETE', 403, 'owner');
  await refused('service', PC({ outcome: 'DEAD' }), 'service close', 403);
  await refused('owner', PC({ outcome: 'WON' }), 'bad outcome', 400, 'outcome');
  await refused('owner', PC({ outcome: 'LOST', reason: 'COMPETITOR' }), 'a lead reason', 400, 'reason');
  await refused('owner', PC({ outcome: 'DEAD', stage: 'DELIVERED' }), 'unknown key', 400, '"stage"');
});

await check('D88: a parts order is a doc record — doc_detach and POST /api/doc take P1001', async () => {
  const e = await ok('service', { action: 'doc_detach', payload: { record: 'p1001', doc_id: '4f2a91c07be3d518' } }, 'detach off P');
  assert.equal(e.payload.record, 'P1001');
  const res = await worker.fetch(new Request('https://w.example/api/doc', { method: 'POST',
    headers: { Authorization: `Bearer ${TOK.sales}`, 'Content-Type': 'application/pdf', 'X-Doc-Name': 'po.pdf', 'X-Doc-Record': 'P1001', 'X-Doc-Kind': 'OTHER' },
    body: new TextEncoder().encode('%PDF-1.4 fake') }), env);
  assert.ok(res.status === 201 || res.status === 200, `upload against P1001: ${res.status}`);
});

await check('D88: /api/data — service loses parts value (+ money_fields) and the pending value; owner/sales keep it', async () => {
  const pub = await worker.fetch(new Request('https://w.example/api/admin/publish', {
    method: 'POST', headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ meta: { schema_version: 7 },
      parts_orders: [{ order: 'P1001', status: 'OPEN', stage: 'QUOTED', value: 312.5, parts: '2x blade', log: [{ ts: 'x', who: 'Matt', text: 'quote 44040 sent' }] }],
      parts_summary: { money_fields: ['value'], value_shipped: true, stats: { windows: { '30d': { opened: 8 } }, money: { '30d': { avg_value: 530.9, won_value: 1808.65 } } } } }) }), env);
  assert.equal(pub.status, 200);
  await ok('sales', PU({ value: 400 }), 'a pending value');
  const read = async (role) => {
    const r = await worker.fetch(new Request('https://w.example/api/data', { headers: { Authorization: `Bearer ${TOK[role]}` } }), env);
    return { text: await r.clone().text(), body: await r.json() };
  };
  const svc = await read('service');
  const row = svc.body.snapshot.parts_orders[0];
  assert.ok(!('value' in row), 'value stripped off the row');
  assert.ok(!('money_fields' in svc.body.snapshot.parts_summary), 'money_fields stripped');
  assert.ok(!('money' in svc.body.snapshot.parts_summary.stats) && svc.body.snapshot.parts_summary.stats.windows['30d'].opened === 8, 'D103: stats.money stripped, stats.windows kept');
  assert.ok(!/530\.9|1808\.65/.test(svc.text), 'D103: no strip figure in the raw bytes');
  assert.equal(row.log.length, 1, 'the log survives');
  assert.ok(svc.body.pending.filter((e) => e.action === 'parts_update').every((e) => !('value' in e.payload)), 'pending value stripped');
  assert.ok(!/312\.5|"value":400/.test(svc.text), 'no figure in the raw bytes');
  for (const role of ['owner', 'sales']) {
    const b = (await read(role)).body;
    assert.equal(b.snapshot.parts_orders[0].value, 312.5, `${role} keeps the value`);
    assert.equal(b.snapshot.parts_summary.stats.money['30d'].avg_value, 530.9, `${role} keeps stats.money (D103)`);
  }
});

await check('D88: publish refuses cost_total / cost_source_inv anywhere on a parts order; D111: a typed price in its log or `parts` publishes', async () => {
  const pub = async (doc) => {
    const res = await worker.fetch(new Request('https://w.example/api/admin/publish', {
      method: 'POST', headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
    }), env);
    return { status: res.status, body: await res.json() };
  };
  const snap = (r) => ({ meta: { schema_version: 7 }, parts_orders: [{ order: 'P1001', status: 'OPEN', parts: 'x', log: [], ...r }] });
  assert.equal((await pub(snap({}))).status, 200);
  assert.equal((await pub(snap({ parts: '2x blade @ $45 each' }))).status, 200, 'a price typed into `parts` is honest data');
  for (const [k, where] of [['cost_total', {}], ['cost_source_inv', {}], ['COST_TOTAL', {}]]) {
    const r = await pub(snap({ [k]: 1, ...where }));
    assert.equal(r.status, 400, k);
    assert.ok(r.body.error.includes(k) && r.body.error.includes('P1001'), r.body.error);
  }
  const deep = await pub(snap({ invoice_doc: { status: 'CREATED', extra: { cost_total: 9 } } }));
  assert.equal(deep.status, 400, 'at any depth');
  const fig = await pub(snap({ log: [{ ts: 'x', who: 'Matt', text: '1 case liquid cleaner - $129' }] }));
  assert.equal(fig.status, 200, 'D111: a price Matt typed into a parts note is honest data — it publishes');
});

await check('D115: customers — 503 before the push; the push writes index + cards and drops removed; sales/owner read, service/intake 403', async () => {
  const get = async (role, path) => {
    const res = await worker.fetch(new Request(`https://w.example${path}`, { headers: { Authorization: `Bearer ${TOK[role]}` } }), env);
    return { status: res.status, body: await res.json() };
  };
  const push = async (doc) => {
    const res = await worker.fetch(new Request('https://w.example/api/admin/customers', {
      method: 'POST', headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
    }), env);
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await get('sales', '/api/customers')).status, 503, 'index before any push');
  assert.equal((await get('sales', '/api/customer/12')).status, 503, 'card before any push');
  const card = (id, name) => ({ id, name, company: null, contact: null, email: null, phone: null, city: 'Ixonia', state: 'WI', active: true, balance: 0,
    first_sale: '2026-01-05', last_sale: '2026-10-01', sales_count: 2,
    docs: [{ type: 'INVOICE', num: '44001', date: '2026-10-01', total: 314.5, balance: 0, status: 'PAID', po: null, ordered_by: null, lines: [{ desc: 'Pads 20" red', qty: 5, amount: 60 }] }] });
  const ok = await push({ built: '2026-10-20T18:00:00Z', index: { built: '2026-10-20T18:00:00Z', count: 2, customers: [{ id: '12', name: 'Acme Foods', city: 'Ixonia', last: '2026-10-01' }, { id: '13', name: 'Beta Cleaning', city: null, last: null }] },
    cards: { 12: card('12', 'Acme Foods'), 13: card('13', 'Beta Cleaning') }, removed: ['99'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.index, ok.body.cards, ok.body.removed], [2, 2, 1]);
  const idx = await get('sales', '/api/customers');
  assert.equal(idx.status, 200); assert.equal(idx.body.customers.length, 2);
  const one = await get('owner', '/api/customer/12');
  assert.equal(one.status, 200); assert.equal(one.body.docs[0].num, '44001');
  assert.equal((await get('sales', '/api/customer/404')).status, 404, 'unknown id once published');
  assert.equal((await get('sales', '/api/customer/abc')).status, 400, 'malformed id');
  assert.equal((await get('service', '/api/customers')).status, 403, 'service: no index');
  assert.equal((await get('service', '/api/customer/12')).status, 403, 'service: no card');
  assert.equal((await get('intake', '/api/customers')).status, 403, 'intake: nothing');
  // an incremental push: cards only, no index → the index stays; removed drops a card
  const inc = await push({ cards: { 14: card('14', 'Gamma Corp') }, removed: ['13'] });
  assert.equal(inc.status, 200); assert.equal(inc.body.index, null);
  assert.equal((await get('sales', '/api/customer/14')).status, 200);
  assert.equal((await get('sales', '/api/customer/13')).status, 404, 'removed');
  assert.equal((await get('sales', '/api/customers')).body.customers.length, 2, 'index untouched by a cards-only push');
  // refusals: our cost never leaves the vault; a bad id; a malformed index
  const bad = await push({ cards: { 15: { ...card('15', 'X'), docs: [{ cost: 1 }] } } });
  assert.equal(bad.status, 400); assert.ok(bad.body.error.includes('cards.15.docs[0].cost'), bad.body.error);
  assert.equal((await push({ cards: { 'x1': card('x1', 'X') } })).status, 400, 'bad id');
  assert.equal((await push({ index: { customers: 'nope' } })).status, 400, 'index shape');
  assert.equal((await push({ removed: ['14'] })).status, 200, 'removed alone is fine');
  assert.equal((await get('sales', '/api/customer/14')).status, 404);
});

console.log(`${passed} checks passed.`);
