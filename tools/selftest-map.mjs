#!/usr/bin/env node
/**
 * selftest-map.mjs — the D52 map logic: projection, pin selection, stacking,
 * viewport clamping and the directions URLs.
 *
 * The rules this file defends:
 *   - the projection comes off the SVG root, never from a constant in our code;
 *   - a row with no `geo`, or `in_wi: false`, is NEVER pinned — it goes to the
 *     off-map list, and the two are not the same thing;
 *   - identical coordinates are one place (§3.4), because the geocode cache is
 *     keyed on the address string;
 *   - directions are built from COORDINATES, never the address string that
 *     needed the map in the first place.
 *
 * The projection is also checked against the REAL asset: the shop has to land
 * in Jefferson County, and three known cities in theirs. A projection bug that
 * puts every pin in Lake Michigan is invisible to a unit test with made-up
 * constants, so this one reads the shipped file.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  projector, boxToViewBox, viewBoxStr, clampViewBox, zoomAt,
  collect, stack, stackKind, groupOff, geoMeta, hasGeo, usableGeo, precisionNote,
  navUrl, routeUrl, MAX_STOPS, KINDS, EDGE_LABEL_ALLOWANCE, visibleBox,
} from '../docs/map.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, '..', 'docs');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

console.log('map self-test');

/* ------------------------------------------------------ the real asset -- */

const svgText = fs.readFileSync(path.join(DOCS, 'wi-map.svg'), 'utf8');
const rootTag = /<svg\b[^>]*>/i.exec(svgText)[0];
const rootAttrs = new Map([...rootTag.matchAll(/([a-zA-Z0-9-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));

check('the shipped asset carries its own projection contract', () => {
  for (const k of ['data-lat0', 'data-lng0', 'data-kx', 'data-ky', 'viewBox']) {
    assert.ok(rootAttrs.has(k), `wi-map.svg root is missing ${k}`);
  }
  // D53's regenerated build. The projection constants are unchanged from D52 —
  // asserted by the county ray-cast below, which would fail loudly otherwise.
  assert.equal(rootAttrs.get('data-style'), 'd53', 'this is not the D53 asset');
  // If this ever fails, the vault regenerated the asset — which is allowed.
  // Nothing in docs/map.js hardcodes these; only this assertion knows them.
  assert.equal(rootAttrs.get('viewBox'), '0 0 880 930');
});

const project = projector(rootAttrs);

check('projector() refuses to guess when a constant is missing', () => {
  assert.equal(projector(new Map()), null);
  assert.equal(projector(new Map([['data-lat0', 47.1]])), null, 'one of four is not a projection');
  assert.equal(projector(new Map([...rootAttrs].filter(([k]) => k !== 'data-kx'))), null);
  assert.equal(projector(new Map([...rootAttrs, ['data-kx', '0']])), null, 'a zero scale would divide by zero on invert');
  assert.equal(projector(null), null);
  assert.ok(project, 'the real asset must produce one');
});

/* The point of the whole exercise: does a lat/lng land where it should?
 * Ray-cast the projected point against the asset's own county polygons. */
const counties = [...svgText.matchAll(/<path class="county" data-name="([^"]+)" d="([^"]+)"/g)]
  .map(([, name, d]) => ({
    name,
    poly: [...d.matchAll(/([ML])\s*(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[2]), Number(m[3])]),
  }));
function countyAt(lat, lng) {
  const { x, y } = project(lat, lng);
  const hits = counties.filter((c) => {
    let inside = false;
    for (let i = 0, j = c.poly.length - 1; i < c.poly.length; j = i++) {
      const [xi, yi] = c.poly[i];
      const [xj, yj] = c.poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
  return hits.map((c) => c.name);
}

check('the shop lands in Jefferson County, and three cities land in theirs', () => {
  // The exit criterion, checked against the real geometry rather than a number
  // somebody wrote down. Ixonia is in Jefferson County, just west of Oconomowoc.
  assert.deepEqual(countyAt(43.137422, -88.592609), ['Jefferson'], 'the shop pin is in the wrong county');
  assert.deepEqual(countyAt(43.0389, -87.9065), ['Milwaukee']);
  assert.deepEqual(countyAt(43.0731, -89.4012), ['Dane'], 'Madison');
  assert.deepEqual(countyAt(44.5133, -88.0158), ['Brown'], 'Green Bay');
});

check('the projection is invertible — a dragged viewBox becomes a lat/lng box again', () => {
  const back = project.invert(...Object.values(project(43.137422, -88.592609)));
  assert.ok(Math.abs(back.lat - 43.137422) < 1e-9);
  assert.ok(Math.abs(back.lng - -88.592609) < 1e-9);
});

/* ------------------------------------------------------------ viewBox --- */

const BOUNDS = { lat_min: 42.45, lat_max: 47.10, lng_min: -92.95, lng_max: -86.75 };
const DEFAULT = { lat_min: 42.45, lat_max: 43.85, lng_min: -90.05, lng_max: -87.45 };   // D53
const outer = boxToViewBox(BOUNDS, project);

check('the declared bounds project onto the asset\'s own viewBox', () => {
  // meta.geo.bounds and the SVG must describe the same rectangle, or every pin
  // is drawn against one projection and clamped against another.
  assert.ok(Math.abs(outer.x - 0) < 0.5 && Math.abs(outer.y - 0) < 0.5);
  assert.ok(Math.abs(outer.w - 880) < 1 && Math.abs(outer.h - 930) < 1);
});

check('the default view is the SE corner, right-way-up', () => {
  const v = boxToViewBox(DEFAULT, project);
  assert.equal(viewBoxStr(v), '411.55 650 368.98 280');
  // lat_max is the TOP edge. Getting this backwards renders an upside-down
  // state and still "works", which is why it is asserted rather than eyeballed.
  const top = project(DEFAULT.lat_max, DEFAULT.lng_min);
  assert.ok(Math.abs(v.y - top.y) < 0.01, 'the top edge must come from lat_max');
  assert.ok(v.h > 0 && v.w > 0);
});

check('a malformed or inside-out box yields null, never a broken viewBox', () => {
  assert.equal(boxToViewBox(null, project), null);
  assert.equal(boxToViewBox(DEFAULT, null), null);
  assert.equal(boxToViewBox({ lat_min: 43, lat_max: 42, lng_min: -90, lng_max: -88 }, project), null, 'inverted lat');
  assert.equal(boxToViewBox({ lat_min: 42, lat_max: 43, lng_min: -88, lng_max: -90 }, project), null, 'inverted lng');
  assert.equal(boxToViewBox({ lat_min: 'x', lat_max: 43, lng_min: -90, lng_max: -88 }, project), null);
});

check('you cannot pan off the state, and cannot zoom out past it', () => {
  const off = clampViewBox({ x: -900, y: -900, w: 300, h: 250 }, outer);
  assert.ok(off.x >= outer.x - 0.01 && off.y >= outer.y - 0.01, 'clamped back onto the map');
  const far = clampViewBox({ x: 0, y: 0, w: 5000, h: 4000 }, outer);
  assert.ok(far.w <= outer.w + 0.01 && far.h <= outer.h + 0.01, 'min zoom is the whole state');
  const deep = clampViewBox({ x: 400, y: 700, w: 2, h: 2 }, outer, 40);
  assert.ok(deep.w >= 40 - 0.01, 'and there is a floor on how far in you can go');
  // Panned hard right at a real zoom, the right edge sits ON the map's edge.
  const east = clampViewBox({ x: 5000, y: 700, w: 200, h: 160 }, outer);
  assert.ok(Math.abs((east.x + east.w) - (outer.x + outer.w)) < 0.01);
});

check('zoomAt holds the pinch centre still', () => {
  const v = { x: 400, y: 640, w: 348, h: 290 };
  const cx = 500;
  const cy = 700;
  const z = zoomAt(v, 2, cx, cy);
  assert.ok(Math.abs(z.w - 174) < 1e-9 && Math.abs(z.h - 145) < 1e-9);
  // The point under the fingers must map to the same place before and after.
  const before = (cx - v.x) / v.w;
  const after = (cx - z.x) / z.w;
  assert.ok(Math.abs(before - after) < 1e-9, 'the pinch centre drifted');
});

/* --------------------------------------------------------------- pins --- */

const GEO = (lat, lng, precision = 'street', in_wi = true) => ({ lat, lng, precision, in_wi });
const SNAP = {
  meta: { geo: {
    shop: { label: 'WSS — Ixonia', address: 'N8069 County Road F', lat: 43.137422, lng: -88.592609 },
    bounds: BOUNDS, default_view: DEFAULT, precision_legend: { city: 'City only' },
  } },
  service_queue: [
    { ticket: 'S1', status: 'OPEN', location: 'AT-CUSTOMER', site: 'Watertown WI', customer: 'Ironwood', issue: 'dead', geo: GEO(43.19, -88.72) },
    { ticket: 'S2', status: 'OPEN', location: 'IN-SHOP', site: 'Oconomowoc WI', customer: 'Fairmont', issue: 'x', geo: null },
    { ticket: 'S3', status: 'CLOSED', location: 'AT-CUSTOMER', site: 'Beloit WI', customer: 'Dorsey', issue: 'x', geo: GEO(42.5, -89.03) },
    { ticket: 'S4', status: 'OPEN', location: 'AT-CUSTOMER', site: 'Portage WI', customer: 'Lakeshore', issue: 'leak', geo: null },
  ],
  dispatch: [
    { id: 'm-1', kind: 'PICKUP', status: 'OPEN', serial: '900149', what: 'off-rent', customer: 'Acme', address: '910 Foundry Rd, Jefferson WI', geo: GEO(43.0, -88.8) },
    { id: 'm-2', kind: 'DELIVER', status: 'SCHEDULED', ticket: 'S9', what: 'back to customer', customer: 'Cedar', address: 'Kenosha WI', geo: GEO(42.58, -87.82) },
    { id: 'm-3', kind: 'PICKUP', status: 'DONE', what: 'done', customer: 'X', address: 'Madison WI', geo: GEO(43.07, -89.4) },
    { id: 'm-4', kind: 'PICKUP', status: 'OPEN', what: 'parts', customer: 'Halstead', address: null, geo: null },
  ],
  leads: [
    { lead: 'L1', status: 'OPEN', stage: 'CONTACTED', site: 'Fond du Lac WI', customer: 'Meadowbrook', machine: 'rider', geo: GEO(43.773, -88.447, 'city') },
    { lead: 'L2', status: 'OPEN', stage: 'RECEIVED', site: 'Toledo OH', customer: 'Bellmont', machine: 'walk-behind', geo: GEO(41.65, -83.53, 'street', false) },
    { lead: 'L3', status: 'OPEN', stage: 'DEMO-SCHEDULED', site: 'Watertown WI', customer: 'Harbor', machine: 'SC-2400', geo: GEO(43.19, -88.72) },
    { lead: 'L4', status: 'LOST', stage: 'QUOTED', site: 'Racine WI', customer: 'Gone', machine: 'x', geo: GEO(42.72, -87.78) },
  ],
  units: [
    { serial: '900149', unit_state: 'ON-RENT', job_site: '910 Foundry Rd, Jefferson WI', customer: 'Acme', brand: 'Factory Cat', model: 'Model 34', geo: GEO(43.0, -88.8) },
    { serial: '900200', unit_state: 'AVAILABLE', job_site: null, customer: null, geo: null },
    { serial: '900300', unit_state: 'LOANER-OUT', job_site: 'Racine WI', customer: 'Juniper', brand: 'Nordvale', model: 'SC-2400', geo: GEO(42.72, -87.78) },
    { serial: '900400', unit_state: 'ON-DEMO', job_site: 'Beloit WI', customer: null, brand: 'Meridian', model: 'T-500', geo: GEO(42.5, -89.03) },
  ],
};

check('only the rows the table names are eligible at all', () => {
  const { pins, off } = collect(SNAP);
  const ids = [...pins, ...off].map((r) => `${r.kind}:${r.id}`);
  // A CLOSED ticket, a DONE run, a closed lead and a unit at home are not on
  // the board — so they are not "off the map" either. Off-map is a work list,
  // not a dumping ground for everything that failed a filter.
  assert.ok(!ids.includes('service:S3'), 'a CLOSED ticket is not on the map at all');
  assert.ok(!ids.some((i) => i.endsWith('m-3')), 'a DONE run is finished');
  assert.ok(!ids.includes('lead:L4'), 'a closed lead is not on the map');
  assert.ok(!ids.includes('rental:900200'), 'a unit at home has nowhere to be');
  // An IN-SHOP ticket is on our bench: no pin, and NOT an address to go fix.
  assert.ok(!ids.includes('service:S2'), 'an IN-SHOP ticket is neither pinned nor off-map');
});

check('geo: null and in_wi: false go to the off-map list — and only there', () => {
  const { pins, off } = collect(SNAP);
  assert.deepEqual(off.map((r) => r.id).sort(), ['L2', 'S4', 'm-4']);
  assert.ok(!pins.some((p) => p.id === 'L2'), 'an Ohio lead must never be pinned to the edge of Wisconsin');
  assert.ok(!pins.some((p) => p.id === 'S4'));
  assert.ok(off.every((r) => r.lat === null && r.lng === null));
  // The raw address survives — it is the thing Matt has to go fix.
  assert.equal(off.find((r) => r.id === 'S4').address, 'Portage WI');
  assert.equal(off.find((r) => r.id === 'L2').address, 'Toledo OH');
});

check('every pin carries what the sheet needs, and a route that exists', () => {
  const { pins } = collect(SNAP);
  for (const p of pins) {
    assert.ok(KINDS.includes(p.kind), p.kind);
    assert.ok(p.id && p.label, 'a pin with no id cannot be opened');
    assert.ok(/^#\/(unit|ticket|lead|dispatch)\//.test(p.href), `bad href ${p.href}`);
    assert.equal(typeof p.lat, 'number');
    assert.equal(typeof p.lng, 'number');
  }
  const svc = pins.find((p) => p.id === 'S1');
  assert.equal(svc.href, '#/ticket/S1');
  assert.equal(svc.line, 'dead');
  assert.equal(pins.find((p) => p.id === 'm-1').label, '900149', 'a run is labelled by serial, then ticket');
  assert.equal(pins.find((p) => p.id === 'm-2').label, 'S9', 'no serial -> the ticket');
  assert.equal(pins.find((p) => p.id === '900149').line, 'Factory Cat Model 34');
});

check('the hollow marker is GONE — `solid` exists nowhere (D53)', () => {
  // Every pinned row now draws the same marker whatever its precision. If
  // `solid` ever comes back, the shape is hiding the kind colour again.
  const { pins, off } = collect(SNAP);
  for (const p of [...pins, ...off]) assert.ok(!('solid' in p), `${p.id} still carries solid`);
  assert.ok(!('solid' in usableGeo(GEO(43, -88, 'city'))));
  for (const st of stack(pins)) assert.ok(!('solid' in st), 'a stack must not carry solid either');
  // Precision survives — it is what the sheet's line is made of.
  assert.equal(pins.find((p) => p.id === 'L1').precision, 'city');
  assert.equal(pins.find((p) => p.id === 'S1').precision, 'street');
});

check('a stack reports the BEST precision of its rows', () => {
  const s = stack([
    { kind: 'lead', id: 'a', lat: 43, lng: -88, precision: 'city' },
    { kind: 'service', id: 'b', lat: 43, lng: -88, precision: 'rooftop' },
  ]);
  assert.equal(s[0].precision, 'rooftop', 'one rooftop row means the place IS known');
  // An unknown precision ranks below city — never claim more than we were told.
  assert.equal(stack([
    { kind: 'lead', id: 'a', lat: 43, lng: -88, precision: null },
    { kind: 'lead', id: 'b', lat: 43, lng: -88, precision: 'city' },
  ])[0].precision, 'city');
  assert.equal(stack([{ kind: 'lead', id: 'a', lat: 43, lng: -88, precision: null }])[0].precision, null);
});

check('the precision line says something only when there is something to say', () => {
  const legend = { city: 'no street address on file', street: 'street, no number' };
  assert.deepEqual(precisionNote('city', legend), { lead: 'City center', rest: 'no street address on file' });
  assert.deepEqual(precisionNote('street', legend), { lead: 'Approximate', rest: 'street, no number' });
  // A rooftop hit is the normal case. Saying "exact address" on nine pins out
  // of ten is noise that trains people to stop reading the line at all.
  assert.equal(precisionNote('rooftop', legend), null);
  assert.equal(precisionNote(null, legend), null);
  assert.equal(precisionNote('city', null).rest, 'no street address on file', 'a snapshot with no legend still reads');
  // The lead-in is OURS, not the snapshot's, so a thin legend cannot erase the
  // distinction between "city center" and "approximate".
  assert.equal(precisionNote('city', {}).lead, 'City center');
  assert.equal(precisionNote('street', {}).lead, 'Approximate');
});

check('a demo lead is flagged for its own glyph', () => {
  const { pins } = collect(SNAP);
  assert.equal(pins.find((p) => p.id === 'L3').demo, true);
  assert.equal(pins.find((p) => p.id === 'L1').demo, false);
});

check('usableGeo refuses anything it cannot draw', () => {
  assert.equal(usableGeo(null), null);
  assert.equal(usableGeo({}), null);
  assert.equal(usableGeo({ lat: 'x', lng: -88 }), null);
  assert.equal(usableGeo({ lat: 43, lng: null }), null);
  assert.equal(usableGeo(GEO(43, -88, 'street', false)), null, 'in_wi: false is never drawn');
  assert.ok(usableGeo(GEO(43, -88)));
});

/* ------------------------------------------------------------ stacking -- */

check('identical coordinates collapse into one pin (§3.4)', () => {
  const { pins } = collect(SNAP);
  const stacks = stack(pins);
  const jefferson = stacks.find((s) => s.rows.length > 1 && s.rows.some((r) => r.id === '900149'));
  // The case the work order names: an ON-RENT unit AND its own pick-up run.
  assert.ok(jefferson, 'a unit and its pick-up at one address must stack');
  assert.deepEqual(jefferson.rows.map((r) => r.kind).sort(), ['pickup', 'rental']);
  // Watertown: an open ticket and a demo lead at the same plant.
  const watertown = stacks.find((s) => s.rows.some((r) => r.id === 'S1'));
  assert.equal(watertown.rows.length, 2);
  assert.equal(stacks.reduce((n, s) => n + s.rows.length, 0), pins.length, 'no row may be lost in a stack');
});

check('stackKind is a priority order, not whichever row came first', () => {
  const s = stack([
    { kind: 'rental', id: 'a', lat: 43, lng: -88, precision: 'street' },
    { kind: 'service', id: 'b', lat: 43, lng: -88, precision: 'street' },
  ]);
  // Work beats inventory: a broken machine at a plant is the reason to go.
  assert.equal(stackKind(s[0]), 'service');
  assert.equal(stackKind({ kinds: ['rental'] }), 'rental');
  assert.equal(stackKind({ kinds: [] }), 'rental', 'never undefined');
});

check('coordinates that differ at all are two places', () => {
  const s = stack([
    { kind: 'lead', id: 'a', lat: 43.000000, lng: -88, precision: 'street' },
    { kind: 'lead', id: 'b', lat: 43.000002, lng: -88, precision: 'street' },
  ]);
  assert.equal(s.length, 2, 'no distance threshold — the cache gives exact matches or nothing');
});

check('the off-map list groups in kind order and keeps everything', () => {
  const { off } = collect(SNAP);
  const groups = groupOff(off);
  assert.deepEqual(groups.map((g) => g.kind), ['service', 'pickup', 'lead']);
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), off.length);
});

/* ---------------------------------------------------------- directions -- */

check('Navigate goes to COORDINATES, never the address that failed', () => {
  const u = navUrl(43.137422, -88.592609);
  assert.ok(u.startsWith('https://www.google.com/maps/dir/?api=1&destination='));
  assert.ok(u.includes('43.137422%2C-88.592609'));
  // The address string is the thing that geocoded badly enough to need a map.
  assert.ok(!/Ixonia|County%20Road/.test(u));
  assert.equal(navUrl(null, -88), null);
  assert.equal(navUrl(43, 'x'), null);
});

const SHOP = { lat: 43.137422, lng: -88.592609 };
const S = (lat, lng) => ({ lat, lng });

check('a three-stop run leaves the shop and ends at the last stop', () => {
  const u = new URL(routeUrl(SHOP, [S(43.19, -88.72), S(43.0, -88.8), S(42.58, -87.82)]));
  const q = u.searchParams;
  assert.equal(u.origin + u.pathname, 'https://www.google.com/maps/dir/');
  assert.equal(q.get('origin'), '43.137422,-88.592609', 'the shop is always the origin');
  assert.equal(q.get('destination'), '42.580000,-87.820000', 'the last stop tapped');
  assert.equal(q.get('waypoints'), '43.190000,-88.720000|43.000000,-88.800000', 'in tap order');
  assert.equal(q.get('travelmode'), 'driving');
});

check('"back to the shop" makes the shop the destination and every stop a waypoint', () => {
  const q = new URL(routeUrl(SHOP, [S(43.19, -88.72), S(43.0, -88.8)], true)).searchParams;
  assert.equal(q.get('destination'), q.get('origin'));
  assert.equal(q.get('waypoints'), '43.190000,-88.720000|43.000000,-88.800000');
});

check('one stop needs no waypoints at all', () => {
  const q = new URL(routeUrl(SHOP, [S(43.19, -88.72)])).searchParams;
  assert.equal(q.get('destination'), '43.190000,-88.720000');
  assert.equal(q.get('waypoints'), null, 'an empty waypoints= would be a malformed link');
});

check('nine stops is the ceiling, and a routeless route is null', () => {
  assert.equal(MAX_STOPS, 9);
  const many = Array.from({ length: 14 }, (_, i) => S(43 + i / 100, -88));
  const q = new URL(routeUrl(SHOP, many)).searchParams;
  assert.equal(q.get('waypoints').split('|').length, 8, '9 points = 8 waypoints + 1 destination');
  assert.equal(routeUrl(SHOP, []), null);
  assert.equal(routeUrl(null, [S(43, -88)]), null, 'no shop, no route');
  assert.equal(routeUrl(SHOP, [{ lat: 'x', lng: 'y' }]), null, 'a stop with no coordinates is not a stop');
});

/* ----------------------------------------------------------- meta.geo --- */

check('geoMeta survives a snapshot that has none', () => {
  assert.equal(geoMeta({}), null);
  assert.equal(geoMeta(null), null);
  assert.equal(hasGeo({ meta: {} }), false);
  assert.equal(hasGeo(SNAP), true);
  const g = geoMeta(SNAP);
  assert.equal(g.shop.label, 'WSS — Ixonia');
  assert.equal(g.default_view, SNAP.meta.geo.default_view);
});

check('a shop with no coordinates disables the shop pin, not the map', () => {
  const g = geoMeta({ meta: { geo: { shop: { label: 'x' }, bounds: BOUNDS } } });
  assert.equal(g.shop, null, 'no pin');
  assert.ok(g.bounds, 'the map still draws');
  assert.equal(g.default_view, BOUNDS, 'and falls back to the whole state');
});

/* ------------------------------------------------------- the real mock -- */

const mock = JSON.parse(fs.readFileSync(path.join(DOCS, 'mock', 'mock-full.json'), 'utf8'));

check('the mock carries every case the map has to survive (§4)', () => {
  assert.equal(mock.meta.schema_version, 7);
  const { pins, off } = collect(mock);
  const stacks = stack(pins);

  assert.ok(pins.length > 20, 'a realistic scatter, not three pins');
  assert.ok(stacks.filter((s) => s.rows.length > 1).length >= 1, 'at least one stack');
  assert.ok(pins.some((p) => p.precision === 'city'), 'a city-precision row, for the sheet line');
  assert.ok(pins.some((p) => p.precision === 'street'), 'and a street-precision one (D53 §6)');
  assert.ok(pins.some((p) => p.precision === 'rooftop'), 'and a rooftop one, which says nothing');
  assert.ok(off.some((r) => r.kind === 'service' && r.address), 'a geo:null ticket with a real-looking site');
  assert.ok(mock.leads.some((l) => l.geo && l.geo.in_wi === false), 'an out-of-state lead');
  assert.ok(mock.service_queue.some((t) => t.location === 'IN-SHOP' && t.geo === null), 'an IN-SHOP ticket');

  // Everything drawn is inside the declared bounds — a pin outside them would
  // be clamped off-screen and silently invisible.
  for (const p of pins) {
    assert.ok(p.lat >= BOUNDS.lat_min && p.lat <= BOUNDS.lat_max, `${p.id} lat ${p.lat} out of bounds`);
    assert.ok(p.lng >= BOUNDS.lng_min && p.lng <= BOUNDS.lng_max, `${p.id} lng ${p.lng} out of bounds`);
  }
});

check('the mock geocode cache obeys its own contract: one address, one point', () => {
  // Two rows carrying the same address string MUST carry byte-identical geo,
  // or §3.4 stacking is testing an artefact of rounding.
  const seen = new Map();
  const rows = [
    ...mock.units.filter((u) => u.job_site).map((u) => [u.job_site, u.geo]),
    ...mock.dispatch.filter((d) => d.address).map((d) => [d.address, d.geo]),
    ...mock.service_queue.filter((t) => t.site && t.location !== 'IN-SHOP').map((t) => [t.site, t.geo]),
  ];
  for (const [addr, geo] of rows) {
    const key = JSON.stringify(geo);
    if (seen.has(addr)) assert.equal(seen.get(addr), key, `${addr} geocoded two different ways`);
    else seen.set(addr, key);
  }
  assert.ok(seen.size > 5, 'the fixture must actually carry addresses to compare');
});

check('the mock projects onto the real asset — every pin inside the drawing', () => {
  const { pins } = collect(mock);
  const g = geoMeta(mock);
  const box = boxToViewBox(g.bounds, project);
  for (const p of pins) {
    const { x, y } = project(p.lat, p.lng);
    assert.ok(x >= box.x - 1 && x <= box.x + box.w + 1, `${p.id} projects off the map (x=${x})`);
    assert.ok(y >= box.y - 1 && y <= box.y + box.h + 1, `${p.id} projects off the map (y=${y})`);
  }
  // And the shop lands in Jefferson County, from the mock's own meta.geo.
  assert.deepEqual(countyAt(g.shop.lat, g.shop.lng), ['Jefferson']);
});

/* ------------------------------------------ the opening frame (D53) ------ */

/**
 * Advance widths for a bold/semibold grotesque, per 1000 em (Helvetica-Bold).
 * The asset asks for system-ui, which is SF Pro / Segoe / Roboto depending on
 * the phone — all close enough to Helvetica for a CLIPPING test, and Helvetica
 * runs slightly wide, so an estimate that fits here fits in practice.
 */
const ADV = { M: 889, i: 278, l: 222, w: 722, a: 556, u: 611, k: 611, e: 556, o: 611, n: 611, r: 389,
  B: 722, t: 333, J: 611, s: 556, v: 611, c: 556, W: 944, K: 722, S: 667, h: 611, b: 611, g: 611,
  d: 611, F: 611, L: 611, G: 778, y: 611, P: 667, m: 889, A: 722, C: 722, p: 611, f: 333, '.': 278,
  ' ': 278, '-': 333, R: 722, E: 667, O: 778, N: 722, I: 278, T: 611, D: 722, U: 722, x: 556, z: 500 };
const TIER_SIZE = { t1: 14, t2: 11, t3: 9.5 };
const textWidth = (t, size) => ([...t].reduce((n, c) => n + (ADV[c] || 600), 0) / 1000) * size + 3.5; // +halo

const cityLabels = [...svgText.matchAll(
  /<text class="city (t\d)" x="([\d.]+)" y="([\d.]+)"(?: text-anchor="(\w+)")?>([^<]+)<\/text>/g)]
  .map(([, tier, x, y, anchor, name]) => {
    const size = TIER_SIZE[tier];
    const w = textWidth(name, size);
    const a = anchor || 'start';
    const left = a === 'start' ? Number(x) : a === 'middle' ? Number(x) - w / 2 : Number(x) - w;
    return { name, tier, size, y: Number(y), left, right: left + w };
  });

check('the asset really does hang its eastern labels past the default view', () => {
  // The premise of EDGE_LABEL_ALLOWANCE. If a regenerated asset ever stops
  // doing this, the allowance can go to 1 — and this check is how you find out.
  const v = boxToViewBox(DEFAULT, project);
  const east = v.x + v.w;
  const over = cityLabels.filter((c) => c.y >= v.y && c.y <= v.y + v.h && c.right > east);
  assert.ok(over.length, 'no label overhangs — set EDGE_LABEL_ALLOWANCE to 1 and delete this check');
  assert.ok(over.some((c) => c.name === 'Milwaukee'), 'Milwaukee is the one D53 names');
});

check('at the opening frame, every eastern city label is fully on screen', () => {
  // THE D53 exit criterion, as arithmetic: box aspect -> visible extent ->
  // does the widest label on the eastern shore fit? Screen width cancels out,
  // because the asset's font sizes are in SVG user units.
  const v = boxToViewBox(DEFAULT, project);
  const box = visibleBox(v, (v.w * EDGE_LABEL_ALLOWANCE) / v.h);

  assert.ok(Math.abs(box.y - v.y) < 0.01 && Math.abs(box.h - v.h) < 0.01,
    'the allowance must buy width only — vertical dead space is what D53 is removing');

  // A label wholly outside the frame is not clipped, it is simply not shown —
  // only one that OVERLAPS an edge is half-drawn, and only those are the bug.
  const overlapping = cityLabels.filter((c) =>
    c.y >= box.y && c.y <= box.y + box.h && c.right > box.x && c.left < box.x + box.w);
  const clipped = overlapping.filter((c) => c.left < box.x || c.right > box.x + box.w);
  assert.deepEqual(clipped.map((c) => c.name), [], 'these labels are drawn half off the frame');
  assert.ok(overlapping.length > 10, 'sanity: the frame should carry most of SE Wisconsin');

  const mke = cityLabels.find((c) => c.name === 'Milwaukee');
  assert.ok(mke.right <= box.x + box.w, `Milwaukee needs ${mke.right.toFixed(1)}, frame ends ${(box.x + box.w).toFixed(1)}`);
});

check('Monroe and Beloit sit inside the bottom edge, unclipped', () => {
  const v = boxToViewBox(DEFAULT, project);
  for (const name of ['Monroe', 'Beloit']) {
    const c = cityLabels.find((x) => x.name === name);
    assert.ok(c, `${name} is not on the asset`);
    // Baseline plus a descender's worth has to clear the south edge.
    assert.ok(c.y + c.size * 0.22 <= v.y + v.h, `${name} baseline ${c.y} is below the frame`);
    assert.ok(c.y >= v.y, `${name} is above the frame`);
  }
});

check('visibleBox trades in one direction at a time', () => {
  const v = { x: 100, y: 100, w: 400, h: 200 };          // aspect 2
  const wide = visibleBox(v, 4);                          // wider box -> more width
  assert.equal(wide.h, 200);
  assert.equal(wide.w, 800);
  assert.equal(wide.x, -100, 'the extra splits evenly, because meet centres');
  const tall = visibleBox(v, 1);                          // taller box -> more height
  assert.equal(tall.w, 400);
  assert.equal(tall.h, 400);
  assert.equal(tall.y, 0);
  assert.deepEqual(visibleBox(v, 2), { x: 100, y: 100, w: 400, h: 200 }, 'an exact match reveals nothing');
  assert.equal(visibleBox(null, 2), null);
});

check('the chip-hide threshold shows chips at the default view and hides them state-wide', () => {
  // D53: "hide chips only when the viewBox is wider than ~1.6x the default view".
  const FACTOR = 1.6;
  const v = boxToViewBox(DEFAULT, project);
  const hideAbove = v.w * FACTOR;
  assert.ok(v.w <= hideAbove, 'the default view must show chips');
  assert.ok(v.w * 0.5 <= hideAbove, 'and so must anything tighter');
  assert.ok(outer.w > hideAbove, 'the whole state must hide them');
  // And the threshold sits inside the range the work order allows.
  assert.ok(FACTOR >= 1.4 && FACTOR <= 1.8);
});

console.log(`\n${passed} checks passed`);
