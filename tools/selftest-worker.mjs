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

await check('D132: INSPECT FIX — item + note (≤120) or item + clear: true, every crew role, keyed like every verb but OPEN', async () => {
  for (const role of ['owner', 'sales', 'service']) {
    const f = await ok(role, insp('FIX', { item: 'sq.blades', note: 'new rear blade' }), `${role} FIX`);
    assert.deepEqual(f.payload, { action: 'INSPECT', step: 'FIX', work_order: 'W1001', item: 'sq.blades', note: 'new rear blade' });
    const c = await ok(role, insp('FIX', { item: 'sq.blades', clear: true }), `${role} FIX clear`);
    assert.deepEqual(c.payload, { action: 'INSPECT', step: 'FIX', work_order: 'W1001', item: 'sq.blades', clear: true });
  }
  const bare = await ok('service', insp('FIX', { item: 'sq.blades' }), 'FIX with no note');
  assert.deepEqual(bare.payload, { action: 'INSPECT', step: 'FIX', work_order: 'W1001', item: 'sq.blades', note: null });
  await ok('service', insp('FIX', { item: 'sq.blades', note: 'x'.repeat(120) }), 'note 120');
  const byS = await ok('service', insp('FIX', { item: 'sq.blades', note: 'rotated' }, '153928'), 'FIX by serial');
  assert.equal(byS.serial, '153928'); assert.ok(!('work_order' in byS.payload));
  await refused('service', wo({ action: 'INSPECT', step: 'FIX', work_order: 'W1001', item: 'sq.blades' }, '153928'), 'FIX with both keys', 400, 'not both');
  await refused('service', wo({ action: 'INSPECT', step: 'FIX', item: 'sq.blades' }), 'FIX with neither key', 400, 'needs the work_order');
  await refused('service', insp('FIX', { item: 'sq.blades', note: 'x'.repeat(121) }), 'note 121', 400, 'note');
  await refused('service', insp('FIX', {}), 'no item', 400, 'item');
  await refused('service', insp('FIX', { item: 42 }), 'item not a string', 400, 'item');
  await refused('service', insp('FIX', { item: 'sq blades!' }), 'item not a row id', 400, 'item');
  await refused('service', insp('FIX', { item: 'sq.blades', clear: false }), 'clear false', 400, 'clear');
  await refused('service', insp('FIX', { item: 'sq.blades', clear: 'yes' }), 'clear "yes"', 400, 'clear');
  await refused('service', insp('FIX', { item: 'sq.blades', clear: true, note: 'oops' }), 'clear with a note', 400, 'no note');
  for (const sec of [['items', []], ['readings', { hours_key: 1 }], ['comments', 'x'], ['battery', null], ['machine_class', 'SCRUBBER']]) {
    await refused('service', insp('FIX', { item: 'sq.blades', [sec[0]]: sec[1] }), `FIX with ${sec[0]}`, 400, `FIX carries no sheet sections (got ${sec[0]})`);
  }
  await refused('service', insp('FIX', { item: 'sq.blades', tech: 'Josh' }), 'unknown key on FIX', 400, 'INSPECT FIX does not take tech');
  await refused('service', insp('FIX', { item: 'sq.blades', fixed: { by: 'Josh' } }), 'a fixed key on FIX', 400, 'fixed');
  await refused('service', insp('FIX', { item: 'sq.blades', cost: 40 }), 'money on FIX', 400, 'cost');
  await refused('intake', insp('FIX', { item: 'sq.blades' }), 'intake FIX', 403);
});

await check('D132: a SAVE / DONE / OPEN row carrying its own `fixed` → 400 by name (the stamp is the engine\'s)', async () => {
  const row = { id: 'sq.blades', result: 'REPAIR', note: 'rolled', fixed: { date: '2026-11-11', by: 'Josh', note: null } };
  await refused('service', insp('SAVE', { items: [row] }), 'SAVE row with fixed', 400, 'items[0] does not take fixed');
  await refused('service', insp('DONE', { tech: 'Josh', items: [row] }), 'DONE row with fixed', 400, 'items[0] does not take fixed');
  await refused('service', wo({ action: 'OPEN', inspection: { items: [row] } }, '153928'), 'OPEN row with fixed', 400, 'does not take fixed');
  const { fixed, ...plain } = row;
  const sv = await ok('service', insp('SAVE', { items: [plain] }), 'the same row without it');
  assert.ok(!('fixed' in sv.payload.items[0]));
});

await check('D69: every verb but OPEN — exactly one of work_order or the top-level serial', async () => {
  const verbs = [
    ['INSPECT', { step: 'SAVE', comments: 'x' }], ['INSPECT', { step: 'DONE', tech: 'Zac' }], ['INSPECT', { step: 'SKIP', reason: 'x' }],
    ['INSPECT', { step: 'REOPEN' }], ['INSPECT', { step: 'FIX', item: 'sq.blades' }], ['ADD-PARTS', { parts: [{ manufacturer: 'KODIAK', part_number: '1', qty: 1 }] }],
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

await check('D126: damage (boolean) on ADD-PARTS lines / PART-STATE / LABOR / INSPECT items; PART-STATE damage-only (any crew role); CLOSE bill', async () => {
  const add = await ok('service', wo({ action: 'ADD-PARTS', work_order: 'W1002', parts: [{ ...STOCK, damage: true }, STOCK] }), 'damage line');
  assert.equal(add.payload.parts[0].damage, true);
  assert.equal('damage' in add.payload.parts[1], false, 'absent stays absent');
  await refused('service', wo({ action: 'ADD-PARTS', work_order: 'W1002', parts: [{ ...STOCK, damage: 'yes' }] }), 'damage "yes" on a line', 400, 'parts[0].damage');
  // damage-only flip: no state, any crew role — sales too
  for (const role of ['sales', 'service', 'owner']) {
    const e = await ok(role, wo({ action: 'PART-STATE', work_order: 'W1002', line: 2, damage: true }), `${role} damage-only`);
    assert.deepEqual(e.payload, { action: 'PART-STATE', work_order: 'W1002', line: 2, damage: true, note: null });
  }
  const un = await ok('service', wo({ action: 'PART-STATE', work_order: 'W1002', line: 2, damage: false, note: 'wear after all' }), 'unmark');
  assert.equal(un.payload.damage, false);
  await refused('service', wo({ action: 'PART-STATE', work_order: 'W1002', line: 2, damage: 1 }), 'damage 1', 400, 'damage');
  await refused('service', wo({ action: 'PART-STATE', work_order: 'W1002', line: 2, damage: true, tracking: '1Z' }), 'tracking on a damage-only flip', 400, 'tracking');
  await refused('owner', wo({ action: 'PART-STATE', work_order: 'W1002', line: 2 }), 'neither state nor damage', 400, 'nothing to do');
  // beside a state, the state's own role rule still holds
  const both = await ok('service', wo({ action: 'PART-STATE', work_order: 'W1002', line: 2, state: 'DELIVERED', damage: true }), 'state + damage');
  assert.equal(both.payload.state, 'DELIVERED'); assert.equal(both.payload.damage, true);
  await refused('sales', wo({ action: 'PART-STATE', work_order: 'W1002', line: 2, state: 'DELIVERED', damage: true }), 'sales DELIVERED + damage', 403);
  // LABOR
  const lab = await ok('service', wo({ action: 'LABOR', work_order: 'W1002', who: 'Josh', hours: 6, damage: true }), 'damage labor');
  assert.equal(lab.payload.damage, true);
  const plain = await ok('service', wo({ action: 'LABOR', work_order: 'W1002', who: 'Josh', hours: 1 }), 'plain labor');
  assert.equal('damage' in plain.payload, false);
  await refused('service', wo({ action: 'LABOR', work_order: 'W1002', who: 'Josh', hours: 1, damage: 'no' }), 'damage "no" on LABOR', 400, 'damage');
  // INSPECT items
  const sv = await ok('service', insp('SAVE', { items: [{ id: 'ctl.key_switch', result: 'REPAIR', note: 'bent', damage: true }] }, '900102'), 'flag row damage');
  assert.equal(sv.payload.items[0].damage, true);
  await refused('service', insp('SAVE', { items: [{ id: 'ctl.key_switch', result: 'REPAIR', damage: 'y' }] }, '900102'), 'items damage "y"', 400, 'items[0].damage');
  // CLOSE bill
  const c1 = await ok('owner', wo({ action: 'CLOSE', work_order: 'W1003', bill: false }), 'bill false');
  assert.equal(c1.payload.bill, false);
  const c2 = await ok('owner', wo({ action: 'CLOSE', work_order: 'W1003' }), 'no bill key');
  assert.equal('bill' in c2.payload, false);
  await refused('owner', wo({ action: 'CLOSE', work_order: 'W1003', bill: 'yes' }), 'bill "yes"', 400, 'bill');
  // still no money beside the new keys
  await refused('service', wo({ action: 'LABOR', work_order: 'W1002', who: 'Josh', hours: 1, damage: true, rate: 90 }), 'money beside damage', 400, '"rate"');
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

await check('D115: customers — 503 before the push; the push writes index + cards and drops removed; sales/owner read, intake 403', async () => {
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
  // (D128 opened both routes to service — pinned in its own block below.)
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

await check('D128: customers open to service — 200 on the index and the card; the card byte-identical across owner/sales/service; intake 403 naming the role', async () => {
  const getRaw = async (role, path) => {
    const res = await worker.fetch(new Request(`https://w.example${path}`, { headers: { Authorization: `Bearer ${TOK[role]}` } }), env);
    return { status: res.status, text: await res.text() };
  };
  // the D115 block above left card 12 (with an invoice total) and the index in KV
  const idx = await getRaw('service', '/api/customers');
  assert.equal(idx.status, 200, 'service reads the index');
  const cards = {};
  for (const role of ['owner', 'sales', 'service']) {
    const r = await getRaw(role, '/api/customer/12');
    assert.equal(r.status, 200, `${role} reads the card`);
    cards[role] = r.text;
  }
  assert.equal(cards.service, cards.owner, 'no strip — service gets the owner\'s bytes');
  assert.equal(cards.sales, cards.owner);
  assert.ok(JSON.parse(cards.service).docs[0].total === 314.5, 'the invoice total ships to service (Matt 12:08)');
  for (const path of ['/api/customers', '/api/customer/12']) {
    const r = await getRaw('intake', path);
    assert.equal(r.status, 403, `intake ${path}`);
    assert.ok(JSON.parse(r.text).error.includes('intake'), 'the 403 names the role');
  }
});

/* ----------------------------------------------------------- D127 stock -- */

const SO = (payload, serial) => (serial === undefined ? { action: 'stock_order', payload } : { action: 'stock_order', serial, payload });
const KLINE = { manufacturer: 'FACTORY-CAT', part_number: '264-4086', description: 'Solution filter', qty: 6 };

await check('D127: stock_order is the 21st action — OPEN / ADD-PARTS any crew role, intake 403; shape kept exactly', async () => {
  for (const role of ['owner', 'sales', 'service']) {
    const e = await ok(role, SO({ action: 'OPEN', note: 'filters low', parts: [KLINE, { manufacturer: 'KODIAK', part_number: '21-422S', qty: 4 }] }), `${role} OPEN`);
    assert.deepEqual(e.payload, { action: 'OPEN', note: 'filters low', parts: [KLINE, { manufacturer: 'KODIAK', part_number: '21-422S', description: null, qty: 4 }] });
    assert.equal(e.serial, null);
    await ok(role, SO({ action: 'ADD-PARTS', stock_order: 'K1001', parts: [KLINE] }), `${role} ADD-PARTS`);
  }
  await refused('intake', SO({ action: 'OPEN', parts: [KLINE] }), 'intake OPEN', 403);
  await refused('intake', SO({ action: 'PART-STATE', stock_order: 'K1001', line: 1, state: 'DELIVERED' }), 'intake PART-STATE', 403);
});

await check('D127: cost / rate / price / source → 400 naming the key; unknown keys by name; serial, ids, lines, qty, 21 lines', async () => {
  for (const k of ['cost', 'rate', 'price', 'source']) {
    await refused('owner', SO({ action: 'OPEN', parts: [{ ...KLINE, [k]: k === 'source' ? 'SHOP-STOCK' : 1 }] }), `line ${k}`, 400, k);
    await refused('owner', SO({ action: 'PART-STATE', stock_order: 'K1001', line: 1, state: 'DELIVERED', [k]: 1 }), `top ${k}`, 400, k);
  }
  await refused('owner', SO({ action: 'OPEN', parts: [KLINE], purpose: 'PM' }), 'a W key', 400, 'purpose');
  await refused('owner', SO({ action: 'OPEN', parts: [{ ...KLINE, damage: true }] }), 'a line key', 400, 'damage');
  await refused('owner', SO({ action: 'CLOSE', stock_order: 'K1001' }), 'no Close verb', 400, 'action');
  await refused('owner', SO({ action: 'OPEN', parts: [KLINE] }, '150074'), 'a serial', 400, 'serial');
  await refused('owner', SO({ action: 'ADD-PARTS', stock_order: 'W1001', parts: [KLINE] }), 'a W id', 400, 'K1001');
  await refused('owner', SO({ action: 'OPEN', parts: [] }), 'no lines', 400, 'at least one');
  await refused('owner', SO({ action: 'OPEN', parts: Array(21).fill(KLINE) }), '21 lines', 400, '20');
  await refused('owner', SO({ action: 'OPEN', parts: [{ ...KLINE, qty: 100 }] }), 'qty 100', 400, 'qty');
  await refused('owner', SO({ action: 'OPEN', parts: [{ ...KLINE, manufacturer: 'ACME' }] }), 'manufacturer', 400, 'manufacturer');
  await refused('owner', SO({ action: 'OPEN', note: 'x'.repeat(201), parts: [KLINE] }), 'note 201', 400, 'note');
});

await check('D127: PART-STATE — ORDERED owner-only (403); IN-TRANSIT / DELIVERED service + owner; CANCELLED + CANCEL any crew (the engine referees)', async () => {
  const ps = (state, extra = {}) => SO({ action: 'PART-STATE', stock_order: 'K1001', line: 1, state, ...extra });
  const e = await ok('owner', ps('ORDERED', { date: '2026-11-10', vendor: 'RPS', vendor_ref: 'SO-449002' }), 'owner ORDERED');
  assert.deepEqual(e.payload, { action: 'PART-STATE', stock_order: 'K1001', line: 1, state: 'ORDERED', date: '2026-11-10', vendor: 'RPS', vendor_ref: 'SO-449002', tracking: null, note: null });
  for (const role of ['sales', 'service']) await refused(role, ps('ORDERED'), `${role} ORDERED`, 403);
  for (const st of ['IN-TRANSIT', 'DELIVERED']) {
    await ok('service', ps(st), `service ${st}`); await ok('owner', ps(st), `owner ${st}`);
    await refused('sales', ps(st), `sales ${st}`, 403);
  }
  for (const role of ['owner', 'sales', 'service']) {
    await ok(role, ps('CANCELLED', { note: 'wrong number' }), `${role} CANCELLED`);
    await ok(role, SO({ action: 'CANCEL', stock_order: 'K1001' }), `${role} CANCEL`);
  }
  await refused('owner', ps('REQUESTED'), 'back to REQUESTED', 400, 'state');
  await refused('owner', ps('DELIVERED', { line: 0 }), 'line 0', 400, 'line');
});

await check('D130: /api/data — service KEEPS last_cost / value on stock[] and value_total on stock_summary, like owner/sales', async () => {
  const pub = await worker.fetch(new Request('https://w.example/api/admin/publish', {
    method: 'POST', headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ meta: { schema_version: 7 },
      stock_orders: [{ id: 'K1001', status: 'OPEN', parts: [{ line: 1, part_number: '264-4086', qty: 6, state: 'ORDERED' }], log: [{ ts: 'x', who: 'Matt', text: 'ORDERED from RPS — PO K1001' }] }],
      stock: [{ part_number: '264-4086', on_hand: 5, last_cost: 12.4, value: 62.0, on_order: 6 }, { part_number: '21-422S', on_hand: -1, last_cost: null, value: null, on_order: 0 }],
      stock_summary: { parts_tracked: 2, negative_count: 1, value_total: 62.0, money_fields: ['last_cost', 'value', 'value_total'], value_shipped: true } }) }), env);
  assert.equal(pub.status, 200, JSON.stringify(await pub.json()));
  const read = async (role) => {
    const r = await worker.fetch(new Request('https://w.example/api/data', { headers: { Authorization: `Bearer ${TOK[role]}` } }), env);
    return { text: await r.clone().text(), body: await r.json() };
  };
  const svc = await read('service');
  for (const row of svc.body.snapshot.stock) assert.ok('last_cost' in row && 'value' in row, 'stock row kept whole');
  const sm = svc.body.snapshot.stock_summary;
  assert.ok(sm.value_total === 62 && Array.isArray(sm.money_fields) && sm.parts_tracked === 2 && sm.negative_count === 1, JSON.stringify(sm));
  assert.equal(svc.body.snapshot.stock[0].on_hand, 5, 'counts survive');
  for (const role of ['owner', 'sales', 'service']) {
    const b = (await read(role)).body.snapshot;
    assert.equal(b.stock[0].last_cost, 12.4, `${role} keeps last_cost`);
    assert.equal(b.stock_summary.value_total, 62, `${role} keeps value_total`);
  }
});

await check('D127: publish refuses cost / cost_source_inv / last_cost / value anywhere on a stock order, and a $ figure in its log', async () => {
  const pub = async (doc) => {
    const res = await worker.fetch(new Request('https://w.example/api/admin/publish', {
      method: 'POST', headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
    }), env);
    return { status: res.status, body: await res.json() };
  };
  const snap = (r, line = {}) => ({ meta: { schema_version: 7 }, stock_orders: [{ id: 'K1001', status: 'OPEN', parts: [{ line: 1, part_number: 'x', qty: 1, ...line }], log: [], ...r }] });
  assert.equal((await pub(snap({}))).status, 200);
  for (const k of ['cost', 'cost_source_inv', 'last_cost', 'value']) {
    const r = await pub(snap({}, { [k]: 1 }));
    assert.equal(r.status, 400, k);
    assert.ok(r.body.error.includes(k) && r.body.error.includes('K1001'), r.body.error);
  }
  assert.equal((await pub(snap({ value: 3 }))).status, 400, 'a row-level value');
  const fig = await pub(snap({ log: [{ ts: 'x', who: 'engine', text: 'cost $12.40' }] }));
  assert.equal(fig.status, 400); assert.ok(fig.body.error.includes('log'), fig.body.error);
  assert.equal((await pub(snap({ log: [{ ts: 'x', who: 'engine', text: 'cost [$] each' }] }))).status, 200, 'the engine redaction publishes');
});

await check('D131: unit_listing — owner only, {serial, listed, price?} by shape, price public on this action only', async () => {
  const UL = (payload, serial) => (serial === undefined ? { action: 'unit_listing', payload } : { action: 'unit_listing', serial, payload });
  const e = await ok('owner', UL({ serial: '157229', listed: true, price: 19200 }), 'list');
  assert.deepEqual(e.payload, { serial: '157229', listed: true, price: 19200 });
  assert.equal(e.serial, '157229', 'the event carries the serial at the top too');
  const off = await ok('owner', UL({ serial: '157229', listed: false }), 'unlist, no price');
  assert.deepEqual(off.payload, { serial: '157229', listed: false });
  const top = await ok('owner', UL({ listed: true }, '146620'), 'serial only at the top');
  assert.equal(top.payload.serial, '146620');
  await refused('owner', UL({ serial: '157229', listed: true }, '146620'), 'serials disagree', 400, 'disagree');
  for (const role of ['sales', 'service', 'intake']) await refused(role, UL({ serial: '157229', listed: true, price: 100 }), `${role} listing`, 403);
  await refused('owner', UL({ serial: '157229', listed: 'yes' }), 'listed not boolean', 400, 'listed');
  await refused('owner', UL({ serial: '157229' }), 'listed missing', 400, 'listed');
  for (const bad of [0, -1, 12.5, '19200', 1000000, true]) await refused('owner', UL({ serial: '157229', listed: true, price: bad }), `price ${bad}`, 400, 'price');
  await refused('owner', UL({ serial: 'bad serial!', listed: true, price: 5 }), 'bad serial', 400, 'serial');
  await refused('owner', UL({ serial: '157229', listed: true, price: 5, note: 'x' }), 'unknown key', 400, '"note"');
  await refused('owner', UL({ serial: '157229', listed: true, price: 5, cost: 1 }), 'cost still refused by name', 400, 'cost');
  await refused('owner', UL({ serial: '157229', listed: true, price: 5, x: { price: 1 } }), 'a nested price is still money', 400, 'price');
  await refused('owner', { action: 'readiness', serial: '157229', payload: { readiness: 'READY', price: 5 } }, 'price elsewhere still refused', 400, 'price');
});

await check('D131: U-<serial> is a doc record — PHOTO only, JPEG/PNG only; S/L/P/W unchanged', async () => {
  const up = (record, kind, mime, bytes) => worker.fetch(new Request('https://w.example/api/doc', { method: 'POST',
    headers: { Authorization: `Bearer ${TOK.service}`, 'Content-Type': mime, 'X-Doc-Name': 'unit.jpg', 'X-Doc-Record': record, 'X-Doc-Kind': kind },
    body: bytes }), env);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 3, 1]);
  const r = await up('U-157229', 'PHOTO', 'image/jpeg', jpg);
  assert.ok(r.status === 201 || r.status === 200, `photo on a unit: ${r.status}`);
  const { id } = await r.json();
  const meta = await env.FLEET_KV.get(`docmeta:${id}`, 'json');
  assert.equal(meta.record, 'U-157229'); assert.equal(meta.kind, 'PHOTO');
  assert.equal((await up('u-157229', 'PHOTO', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]))).status, 201, 'lower-case u- normalised, PNG ok');
  assert.equal((await up('U-157229', 'PHOTO', 'application/pdf', new TextEncoder().encode('%PDF-1.4 u'))).status, 415, 'no PDF on a unit');
  assert.equal((await up('U-157229', 'WORKORDER', 'image/jpeg', jpg)).status, 400, 'no WORKORDER on a unit');
  assert.equal((await up('U-', 'PHOTO', 'image/jpeg', jpg)).status, 400, 'U- needs a serial');
  assert.equal((await up('U-bad serial', 'PHOTO', 'image/jpeg', jpg)).status, 400, 'U- serial on SERIAL_RE');
  const a = await ok('service', { action: 'doc_attach', payload: { record: 'U-157229', doc_id: id, kind: 'PHOTO', name: 'unit.jpg' } }, 'attach to unit');
  assert.equal(a.payload.record, 'U-157229');
  await refused('service', { action: 'doc_attach', payload: { record: 'U-157229', doc_id: id, kind: 'OTHER', name: 'unit.jpg' } }, 'attach non-PHOTO to unit', 400, 'PHOTO');
  // a PDF uploaded against a ticket can't then be attached to a unit
  const pdfRes = await worker.fetch(new Request('https://w.example/api/doc', { method: 'POST',
    headers: { Authorization: `Bearer ${TOK.service}`, 'Content-Type': 'application/pdf', 'X-Doc-Name': 'wo.pdf', 'X-Doc-Record': 'S1018', 'X-Doc-Kind': 'PHOTO' },
    body: new TextEncoder().encode('%PDF-1.4 ticket first') }), env);
  const pdfId = (await pdfRes.json()).id;
  await refused('service', { action: 'doc_attach', payload: { record: 'U-157229', doc_id: pdfId, kind: 'PHOTO', name: 'wo.pdf' } }, 'a PDF id onto a unit', 400, 'JPEG or PNG');
  const d = await ok('sales', { action: 'doc_detach', payload: { record: 'U-157229', doc_id: id } }, 'detach off a unit');
  assert.equal(d.payload.record, 'U-157229');
  await refused('service', { action: 'doc_detach', payload: { record: 'X-157229', doc_id: id } }, 'unknown record shape', 400, 'U-150074');
  assert.equal((await ok('service', { action: 'doc_detach', payload: { record: 's1018', doc_id: id } }, 'S still upper-cased')).payload.record, 'S1018');
});

console.log(`${passed} checks passed.`);
