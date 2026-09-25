#!/usr/bin/env node
/**
 * selftest-worker.mjs — drives the REAL worker/worker.js against an in-memory
 * KV, so the Worker's shape rules run under `npm test` and not only in the curl
 * loop (tools/m1-loop.sh, which needs `wrangler dev`). All data here is FAKE.
 *
 * Scope: the D67 `inspection` action (five verbs) and the D65 `work_order`
 * OPEN back-link, plus the money refusal still firing on the new action. The
 * curl loop keeps the end-to-end proof; this keeps the rules honest per commit.
 */
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

/** A KV namespace with just the surface worker.js uses. */
function fakeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(key, opt) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      const type = typeof opt === 'string' ? opt : opt && opt.type;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, v) { m.set(key, typeof v === 'string' ? v : String(v)); },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true, cursor: null };
    },
  };
}

const TOK = { owner: 'selftestowner0000000000000000001', sales: 'selftestsales0000000000000000001', service: 'selftestservice00000000000000001' };
const env = { FLEET_KV: fakeKV(), ADMIN_SECRET: 'selftest-admin-secret' };
await env.FLEET_KV.put('tokens', JSON.stringify({
  [TOK.owner]: { name: 'Matt', role: 'owner' },
  [TOK.sales]: { name: 'Kevin', role: 'sales' },
  [TOK.service]: { name: 'Josh', role: 'service' },
}));

async function post(role, body) {
  const res = await worker.fetch(new Request('https://w.example/api/event', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOK[role]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json() };
}
const insp = (payload, serial) => (serial === undefined ? { action: 'inspection', payload } : { action: 'inspection', serial, payload });
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

console.log('worker self-test (D67 inspection · D65 back-link · D68 stock)');

const FULL_SAVE = {
  action: 'SAVE', inspection: 'I1001', machine_class: 'SCRUBBER', body_style: 'WALK-BEHIND',
  battery: { type: 'WET', voltage: 24, pack: '4x6V' },
  readings: { hours_key: 412.5, hours_traction: null, brush1_pct: 60, brush2_pct: 0, brushes_rotated: true },
  cells: [{ battery: 1, cell: 'A', sg: 1.265, clarity: 'CLEAR', level: 'FULL' }, { battery: 1, cell: 'B', sg: null, clarity: null, level: null }],
  items: [{ id: 'ctl.key_switch', result: 'IN-SPEC', note: null }, { id: 'deck.curtains', result: 'REPLACE', note: 'torn' }, { id: 'sqg.blades', result: null }],
  comments: 'ready after blade',
};

await check('all five verbs are accepted, by any role, and the event is stamped server-side', async () => {
  const open = await ok('service', insp({ action: 'OPEN', kind: 'CHECKOUT' }, '900100'), 'OPEN');
  assert.equal(open.actor, 'Josh');
  assert.equal(open.serial, '900100');
  assert.deepEqual(open.payload, { action: 'OPEN', kind: 'CHECKOUT' });
  const save = await ok('sales', insp(FULL_SAVE), 'SAVE');
  assert.equal(save.payload.inspection, 'I1001');
  assert.deepEqual(save.payload.battery, { type: 'WET', voltage: 24, pack: '4x6V' });
  assert.equal(save.payload.items.length, 3);
  assert.equal(save.payload.items[2].result, null, 'an unanswered row stays unanswered');
  const done = await ok('service', insp({ action: 'DONE', inspection: 'I1001', tech: 'Zac' }), 'DONE');
  assert.equal(done.payload.tech, 'Zac');
  // REOPEN / VOID hinge on who and when — business state, the engine's call.
  for (const role of ['owner', 'sales', 'service']) {
    await ok(role, insp({ action: 'REOPEN', inspection: 'I1001', note: 'missed the recovery tank' }), `REOPEN as ${role}`);
    await ok(role, insp({ action: 'VOID', inspection: 'I1001', note: 'wrong unit' }), `VOID as ${role}`);
  }
});

await check('SAVE is a merge: only the sections present travel, and a present null is kept (it clears)', async () => {
  const one = await ok('service', insp({ action: 'SAVE', inspection: 'I1002', readings: { hours_key: 7 } }), 'readings only');
  assert.deepEqual(Object.keys(one.payload).sort(), ['action', 'inspection', 'readings']);
  const clear = await ok('service', insp({ action: 'SAVE', inspection: 'I1002', comments: null }), 'comments cleared');
  assert.ok('comments' in clear.payload && clear.payload.comments === null, 'a null section is an instruction, not an absence');
  await refused('service', insp({ action: 'SAVE', inspection: 'I1002' }), 'SAVE with no section', 400, 'at least one section');
});

await check('before the I-number exists: OPEN may carry the first sections; SAVE may key on the serial, never both', async () => {
  const o = await ok('service', insp({ action: 'OPEN', kind: 'RETURN', readings: { hours_key: 12 }, items: [{ id: 'ctl.horn', result: 'REPAIR', note: 'weak' }] }, '900101'), 'OPEN + sections');
  assert.equal(o.payload.readings.hours_key, 12);
  assert.equal(o.payload.items[0].result, 'REPAIR');
  const s = await ok('service', insp({ action: 'SAVE', comments: 'x' }, '900101'), 'SAVE by serial');
  assert.equal(s.serial, '900101');
  assert.ok(!('inspection' in s.payload));
  await refused('service', insp({ action: 'SAVE', inspection: 'I1003', comments: 'x' }, '900101'), 'SAVE with both', 400, 'not both');
  await refused('service', insp({ action: 'SAVE', comments: 'x' }), 'SAVE with neither');
  await refused('service', insp({ action: 'OPEN', kind: 'PM' }), 'OPEN without a serial', 400, 'serial');
  await refused('service', insp({ action: 'DONE', inspection: 'I1003' }, '900101'), 'DONE with both', 400, 'not both');
});

await check('DONE and VOID key on the serial before the I-number exists; exactly one of the two; REOPEN never does', async () => {
  const d = await ok('service', insp({ action: 'DONE', tech: 'Josh' }, '150074'), 'DONE by serial');
  assert.equal(d.serial, '150074');
  assert.deepEqual(d.payload, { action: 'DONE', tech: 'Josh' }, 'no invented inspection key');
  const v = await ok('service', insp({ action: 'VOID', note: 'wrong unit' }, '150074'), 'VOID by serial');
  assert.deepEqual(v.payload, { action: 'VOID', note: 'wrong unit' });
  await ok('service', insp({ action: 'DONE', inspection: 'I1003', tech: 'Zac' }), 'DONE by number still fine');
  await ok('service', insp({ action: 'VOID', inspection: 'I1003' }), 'VOID by number still fine');
  for (const verb of ['SAVE', 'DONE', 'VOID']) {
    const extra = verb === 'SAVE' ? { comments: 'x' } : {};
    await refused('service', insp({ action: verb, inspection: 'I1003', ...extra }, '150074'), `${verb} with both`, 400, 'not both');
    await refused('service', insp({ action: verb, ...extra }), `${verb} with neither`, 400, 'needs the inspection');
  }
  await refused('owner', insp({ action: 'REOPEN', note: 'x' }, '150074'), 'REOPEN by serial', 400, 'keyed on inspection');
  await refused('owner', insp({ action: 'REOPEN', inspection: 'I1003' }, '150074'), 'REOPEN with both', 400, 'keyed on inspection');
  await refused('owner', insp({ action: 'REOPEN' }), 'REOPEN with neither', 400, 'inspection is required');
});

await check('refused: a 6th verb, inspection "W1001", 19 cells, sg 2.0, an unknown top-level key, a result outside both scales', async () => {
  await refused('owner', insp({ action: 'SIGN', inspection: 'I1001' }), '6th verb');
  await refused('owner', insp({ action: 'DONE', inspection: 'W1001' }), 'a W-number', 400, 'I1001');
  const cells = [];
  for (let b = 1; b <= 4; b++) for (const c of 'ABCDE') cells.push({ battery: b, cell: c, sg: 1.2 });
  await refused('owner', insp({ action: 'SAVE', inspection: 'I1001', cells: cells.slice(0, 19) }), '19 cells', 400, '18');
  await ok('owner', insp({ action: 'SAVE', inspection: 'I1001', cells: cells.slice(0, 18) }), '18 cells');
  await refused('owner', insp({ action: 'SAVE', inspection: 'I1001', cells: [{ battery: 1, cell: 'A', sg: 2.0 }] }), 'sg 2.0', 400, 'sg');
  await refused('owner', insp({ action: 'SAVE', inspection: 'I1001', cells: [{ battery: 1, cell: 'A', sg: 0.99 }] }), 'sg 0.99');
  await ok('owner', insp({ action: 'SAVE', inspection: 'I1001', cells: [{ battery: 1, cell: 'A', sg: 1.0 }, { battery: 1, cell: 'B', sg: 1.4 }] }), 'sg at both edges');
  await refused('owner', insp({ action: 'SAVE', inspection: 'I1001', comments: 'x', signature: 'Matt' }), 'unknown top-level key', 400, 'signature');
  await refused('owner', insp({ action: 'SAVE', inspection: 'I1001', items: [{ id: 'ctl.key_switch', result: 'FINE' }] }), 'result outside both scales', 400, 'result');
  // A scale MISMATCH (WEAR word on a FUNCTION row) passes here — the row's scale is the library's, and the library is the vault's.
  await ok('owner', insp({ action: 'SAVE', inspection: 'I1001', items: [{ id: 'ctl.key_switch', result: 'WORN' }] }), 'scale mismatch is the engine’s call');
});

await check('lengths, enums and shapes inside the sections', async () => {
  const bad = (payload, what, hint) => refused('owner', insp({ action: 'SAVE', inspection: 'I1001', ...payload }), what, 400, hint);
  const items = Array.from({ length: 121 }, (_, i) => ({ id: `ctl.r${i}`, result: 'N/A' }));
  await bad({ items }, '121 items', '120');
  await ok('owner', insp({ action: 'SAVE', inspection: 'I1001', items: items.slice(0, 120) }), '120 items');
  await bad({ items: [{ id: 'ctl.a', result: 'GOOD' }, { id: 'ctl.a', result: 'WORN' }] }, 'a row answered twice', 'twice');
  await bad({ items: [{ id: 'ctl.a', result: 'GOOD', note: 'x'.repeat(121) }] }, 'item note 121', 'note');
  await bad({ items: [{ id: 'ctl.a', result: 'GOOD', photo: 'x' }] }, 'unknown item key', 'photo');
  await bad({ comments: 'x'.repeat(1001) }, 'comments 1001', 'comments');
  await bad({ machine_class: 'VACUUM' }, 'class enum');
  await bad({ body_style: 'RIDE-ON' }, 'body_style enum');
  // v1.2 (red-pen #1): the old names are gone from the shape, and the Worker says which.
  await bad({ controls: 'RIDER' }, 'the retired controls key', 'controls');
  await bad({ readings: { recharge_count: 88 } }, 'no recharge counter any more', 'recharge_count');
  await bad({ readings: { brush1_length: 1.5 } }, 'lengths are gone', 'brush1_length');
  await bad({ battery: { type: 'GEL', voltage: 24 } }, 'battery type enum');
  await bad({ battery: { type: 'WET', voltage: 48 } }, 'voltage 48', 'voltage');
  await bad({ battery: { type: 'WET', voltage: 24, pack: '3x12V' } }, 'pack vs voltage', 'pack');
  await bad({ battery: { type: 'AGM', voltage: 24, pack: '4x6V' } }, 'a pack on AGM', 'WET');
  await ok('owner', insp({ action: 'SAVE', inspection: 'I1001', battery: { type: 'LITHIUM', voltage: 36, pack: null } }), 'lithium, no pack');
  await bad({ readings: { hours_key: '412' } }, 'hours as a string', 'number');
  await bad({ readings: { hours_key: -1 } }, 'negative hours');
  await bad({ readings: { hours_key: 100000 } }, 'hours > 99999');
  await bad({ readings: { brush1_pct: 101 } }, 'a brush at 101%', 'brush1_pct');
  await bad({ readings: { main_broom_pct: -1 } }, 'a broom at -1%');
  await bad({ readings: { brush2_pct: 55.5 } }, 'a fractional percent', 'whole-number');
  await ok('owner', insp({ action: 'SAVE', inspection: 'I1001', readings: { main_broom_pct: 0, brush1_pct: 100, brush2_pct: null } }), 'percent edges + null');
  await bad({ readings: { brushes_rotated: 'Y' } }, 'rotated as a string', 'true or false');
  await bad({ readings: { odometer: 5 } }, 'unknown reading', 'odometer');
  await bad({ cells: [{ battery: 7, cell: 'A' }] }, 'battery 7');
  await bad({ cells: [{ battery: 1, cell: 'G' }] }, 'cell G');
  await bad({ cells: [{ battery: 1, cell: 'A' }, { battery: 1, cell: 'A' }] }, 'a cell twice', 'twice');
  await bad({ cells: [{ battery: 1, cell: 'A', clarity: 'MILKY' }] }, 'clarity enum');
  await bad({ cells: [{ battery: 1, cell: 'A', level: 'HALF' }] }, 'level enum');
  await refused('owner', insp({ action: 'OPEN', kind: 'WASH' }, '900100'), 'kind enum');
  await refused('owner', insp({ action: 'DONE', inspection: 'I1001', tech: 'Bob' }), 'tech outside the crew');
  await refused('owner', insp({ action: 'VOID', inspection: 'I1001', note: 'x'.repeat(201) }), 'verb note 201', 400, 'note');
  await refused('owner', insp({ action: 'DONE', inspection: 'I1001', comments: 'late' }), 'DONE carries no sections', 400, 'comments');
});

await check('no money travels on an inspection either — refused by name (D65)', async () => {
  await refused('owner', insp({ action: 'SAVE', inspection: 'I1001', items: [{ id: 'ctl.a', result: 'REPAIR', cost: 40 }] }), 'cost in an item', 400, '"cost"');
  await refused('owner', insp({ action: 'SAVE', inspection: 'I1001', price: 1 }), 'price at the top', 400, '"price"');
});

await check('work_order OPEN takes an optional inspection back-link (^I\\d{4}$); nothing else does', async () => {
  const wo = await ok('service', { action: 'work_order', serial: '900100',
    payload: { action: 'OPEN', purpose: 'REPAIR', inspection: 'I1001', note: 'from I1001: Check and rotate blades', parts: [] } }, 'OPEN with the sheet');
  assert.equal(wo.payload.inspection, 'I1001');
  const plain = await ok('service', { action: 'work_order', serial: '900100', payload: { action: 'OPEN', purpose: 'PM', parts: [] } }, 'OPEN without');
  assert.ok(!('inspection' in plain.payload), 'absent stays absent');
  await refused('service', { action: 'work_order', serial: '900100', payload: { action: 'OPEN', purpose: 'REPAIR', inspection: 'W1001' } }, 'a W-number as the sheet', 400, 'I1001');
  await refused('service', { action: 'work_order', payload: { action: 'CLOSE', work_order: 'W1001', inspection: 'I1001' } }, 'on another verb', 400, 'inspection');
});

const wo = (payload, serial) => (serial === undefined ? { action: 'work_order', payload } : { action: 'work_order', serial, payload });
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

await check('the undo valve (D46) covers an inspection tap — your own, still pending', async () => {
  const e = await ok('service', insp({ action: 'OPEN', kind: 'PM' }, '900102'), 'OPEN');
  const del = (role) => worker.fetch(new Request(`https://w.example/api/event/${encodeURIComponent(e.id)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${TOK[role]}` } }), env);
  assert.equal((await del('owner')).status, 403, 'not Matt’s to undo');
  assert.equal((await del('service')).status, 200);
  assert.equal((await del('service')).status, 404, 'gone');
});

console.log(`${passed} checks passed.`);
