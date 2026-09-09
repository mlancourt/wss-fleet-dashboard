/* Map view — projection, pins, stacking, viewport and directions URLs (D52).
 *
 * Pure: no DOM, no network, no SVG. tools/selftest-map.mjs drives every rule in
 * here against fixtures, which is the only way a projection bug gets caught
 * before it puts a pin in Lake Michigan.
 *
 * FIVE THINGS TO KEEP STRAIGHT:
 *
 * 1. WE NEVER GEOCODE. The engine geocodes once, caches in the vault, and ships
 *    `geo` already resolved. This file reads `geo` and nothing else — it never
 *    parses an address, never guesses a coordinate, and never falls back to one.
 *    A row without `geo` is not on the map; it is on the off-map list, which is
 *    how Matt finds the addresses to fix at the source.
 *
 * 2. THE PROJECTION CONSTANTS COME OFF THE SVG. `data-lat0/lng0/kx/ky` on the
 *    asset's root are the contract; the vault may regenerate the file with
 *    different ones. Nothing here hardcodes a number — `projector()` takes them
 *    as an argument, and a caller that cannot read them gets null rather than a
 *    map drawn against stale constants.
 *
 * 3. IDENTICAL COORDINATES MEAN ONE PLACE. The geocode cache is keyed on the
 *    address string, so an ON-RENT unit and the NEEDS-PICKUP dispatch row for
 *    the same plant carry byte-identical `geo`. That is what `stack()` keys on
 *    — an exact match, not a distance threshold. Two genuinely different
 *    addresses that geocode to the same rooftop are the same rooftop.
 *
 * 4. `in_wi: false` IS NOT AN ERROR. An Ohio lead is a real lead; it just has
 *    no place on a map of Wisconsin. It joins the off-map list with everything
 *    else that cannot be drawn, and is never pinned off the edge of the state.
 *
 * 5. NOTHING HERE WRITES. The route builder produces a URL for the driver's
 *    phone and that is all — no event, no state, nothing in the snapshot. (An
 *    "assign this run to a rig" would be a dispatch event; it is not in D52.)
 */

/**
 * A finite number, or null.
 *
 * NOT `isFinite(Number(v))`: `Number(null)` is 0 and `Number(true)` is 1, so
 * that test turns a missing longitude into the prime meridian and pins a
 * Wisconsin customer off the coast of Africa. A coordinate is a number or it is
 * absent; there is no third thing.
 */
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

/* ========================================================= projection ===== */

/**
 * Read the four projection constants off the SVG root and hand back a
 * `project(lat, lng) -> {x, y}` in SVG user units.
 *
 * `attrs` is anything with a `get(name)` — an SVGElement works directly, and so
 * does a Map in a test. Returns null when any constant is missing or unusable:
 * a map that cannot place a pin correctly must not draw one at all.
 */
export function projector(attrs) {
  const read = (k) => num(attrs && typeof attrs.get === 'function' ? attrs.get(k)
    : attrs && typeof attrs.getAttribute === 'function' ? attrs.getAttribute(k) : null);
  const lat0 = read('data-lat0');
  const lng0 = read('data-lng0');
  const kx = read('data-kx');
  const ky = read('data-ky');
  if (lat0 == null || lng0 == null || kx == null || ky == null || !kx || !ky) return null;

  const project = (lat, lng) => ({ x: (lng - lng0) * kx, y: (lat0 - lat) * ky });
  project.constants = { lat0, lng0, kx, ky };
  // The inverse is what turns a dragged/zoomed viewBox back into a lat/lng box.
  project.invert = (x, y) => ({ lat: lat0 - y / ky, lng: lng0 + x / kx });
  return project;
}

/** A lat/lng box -> an SVG viewBox {x, y, w, h}. Null in, null out. */
export function boxToViewBox(box, project) {
  if (!box || !project) return null;
  const [latMin, latMax, lngMin, lngMax] = [num(box.lat_min), num(box.lat_max), num(box.lng_min), num(box.lng_max)];
  if (latMin == null || latMax == null || lngMin == null || lngMax == null) return null;
  // y grows southward, so lat_max is the TOP edge. Getting this backwards
  // renders an upside-down state, which is the kind of bug that survives review.
  const tl = project(latMax, lngMin);
  const br = project(latMin, lngMax);
  const w = br.x - tl.x;
  const h = br.y - tl.y;
  if (!(w > 0) || !(h > 0)) return null;
  return { x: tl.x, y: tl.y, w, h };
}

export const viewBoxStr = (v) => (v ? `${round(v.x)} ${round(v.y)} ${round(v.w)} ${round(v.h)}` : '');

/**
 * How much wider than the opening view the map BOX is drawn (D53).
 *
 * SVG's default `meet` fit scales the viewBox to fit and fills the leftover
 * room with whatever is next to it — content outside the viewBox is clipped at
 * the viewport, not at the viewBox. So a box shaped a little wider than the
 * view reveals a sliver of extra map to the left and right, and nothing extra
 * above or below.
 *
 * That sliver is not decoration. The asset anchors its eastern city labels to
 * the RIGHT of their dots, and at `default_view`'s east edge "Milwaukee",
 * "Kenosha" and "Sheboygan" all run past it — the biggest label on the board
 * would lose its tail. 1.20 buys back ~37 user units on each side, which clears
 * all three, and it costs only box height: the dead band D53 is fixing was
 * VERTICAL, so trading a little height for readable labels is the right way
 * round.
 *
 * If a future snapshot widens `default_view` past the labels on its own (about
 * lng_max −87.22), set this to 1 and the box becomes the plain view ratio.
 */
export const EDGE_LABEL_ALLOWANCE = 1.20;

/** The lat/lng actually on screen, given the box's aspect. -> {x,y,w,h} in SVG units. */
export function visibleBox(view, boxAspect) {
  if (!view || !(view.h > 0) || !(boxAspect > 0)) return view || null;
  const viewAspect = view.w / view.h;
  // Wider box than view -> height-limited -> extra width. Taller box -> extra height.
  if (boxAspect > viewAspect) {
    const w = view.h * boxAspect;
    return { x: view.x - (w - view.w) / 2, y: view.y, w, h: view.h };
  }
  const h = view.w / boxAspect;
  return { x: view.x, y: view.y - (h - view.h) / 2, w: view.w, h };
}
const round = (n) => Math.round(n * 100) / 100;

/**
 * Keep a viewBox inside the map and no smaller than a usable window.
 *
 * Two rules, and the order matters: size first (a box wider than the map is
 * clamped to the map, which also fixes its position), then position. Zoomed all
 * the way out you get the whole state and cannot pan off it — that is what
 * makes "min zoom = whole state" true rather than aspirational.
 */
export function clampViewBox(v, outer, minSpan = 12) {
  if (!v || !outer) return v;
  const w = Math.min(Math.max(v.w, minSpan), outer.w);
  const h = Math.min(Math.max(v.h, minSpan * (outer.h / outer.w)), outer.h);
  const x = Math.min(Math.max(v.x, outer.x), outer.x + outer.w - w);
  const y = Math.min(Math.max(v.y, outer.y), outer.y + outer.h - h);
  return { x, y, w, h };
}

/** Scale a viewBox about a point in SVG units (a pinch centre / wheel cursor). */
export function zoomAt(v, factor, cx, cy) {
  const w = v.w / factor;
  const h = v.h / factor;
  return { x: cx - ((cx - v.x) * w) / v.w, y: cy - ((cy - v.y) * h) / v.h, w, h };
}

/* ============================================================== pins ====== */

export const KINDS = ['service', 'pickup', 'delivery', 'lead', 'rental'];

export const KIND_LABEL = {
  service: 'Service', pickup: 'Pickups', delivery: 'Deliveries',
  lead: 'Leads', rental: 'Rentals',
};

/** The out states — a unit only has a job site when it is somewhere else. */
const OUT_STATES = new Set(['ON-RENT', 'ON-DEMO', 'LOANER-OUT']);

/** A `geo` we are willing to draw: real numbers, inside Wisconsin. */
export function usableGeo(geo) {
  if (!geo || typeof geo !== 'object') return null;
  const lat = num(geo.lat);
  const lng = num(geo.lng);
  if (lat == null || lng == null) return null;
  // `in_wi: false` is not a failure — it is a real row somewhere else, and the
  // one thing we must not do is pin it to the edge of a map it is not on.
  if (geo.in_wi === false) return null;
  // D53: no `solid`. The hollow marker is retired — precision is a sentence in
  // the tap sheet, not a shape. A 2px ring and a filled dot are not reliably
  // different at arm's length on a phone, and the ring was hiding the one thing
  // the marker exists to say, which is what KIND of work is at this address.
  return { lat, lng, precision: typeof geo.precision === 'string' ? geo.precision : null };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Every row that belongs on the map, and every row that wanted to be.
 *
 * One pass over the four arrays, applying the §3.3 table exactly: which rows
 * qualify at all (an OPEN ticket, a dispatch row that is not DONE, an OPEN
 * lead, a unit that is actually out) is decided FIRST, and only then does `geo`
 * decide whether it pins or falls to the off-map list. A CLOSED ticket with a
 * bad address is not "off the map" — it is not on the board at all.
 *
 * -> { pins: [row], off: [row] }  each row { kind, id, label, line, href,
 *      customer, address, lat, lng, precision, solid, demo }
 */
export function collect(snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const pins = [];
  const off = [];
  const take = (row, geo) => {
    const g = usableGeo(geo);
    if (g) pins.push({ ...row, ...g, geo });
    else off.push({ ...row, lat: null, lng: null, precision: (geo && geo.precision) || null });
  };

  for (const t of arr(snap.service_queue)) {
    if (!t || t.status !== 'OPEN') continue;
    // A machine already on our bench has nowhere to send a truck. The engine
    // ships geo: null for these; skipping them here means an IN-SHOP ticket
    // never turns up on the off-map list as an address to go fix.
    if (t.location === 'IN-SHOP') continue;
    take({
      kind: 'service', id: t.ticket, label: t.ticket,
      line: str(t.issue) || str(t.equipment) || '—',
      href: `#/ticket/${encodeURIComponent(t.ticket)}`,
      customer: str(t.customer), address: str(t.site),
    }, t.geo);
  }

  for (const d of arr(snap.dispatch)) {
    if (!d || d.status === 'DONE') continue;
    const kind = d.kind === 'DELIVER' ? 'delivery' : d.kind === 'PICKUP' ? 'pickup' : null;
    if (!kind) continue;
    take({
      kind, id: d.id, label: str(d.serial) || str(d.ticket) || (kind === 'pickup' ? 'Pick-up' : 'Delivery'),
      line: str(d.what) || '—',
      href: `#/dispatch/${encodeURIComponent(d.id)}`,
      customer: str(d.customer), address: str(d.address),
    }, d.geo);
  }

  for (const l of arr(snap.leads)) {
    if (!l || l.status !== 'OPEN') continue;
    take({
      kind: 'lead', id: l.lead, label: l.lead,
      line: str(l.machine) || str(l.interest) || str(l.stage) || '—',
      href: `#/lead/${encodeURIComponent(l.lead)}`,
      customer: str(l.customer), address: str(l.site),
      // A demo has a truck and a date attached to it — worth its own glyph.
      demo: l.stage === 'DEMO-SCHEDULED',
    }, l.geo);
  }

  for (const u of arr(snap.units)) {
    if (!u || !OUT_STATES.has(u.unit_state)) continue;
    take({
      kind: 'rental', id: String(u.serial), label: String(u.serial),
      line: [u.brand, u.model].filter(Boolean).join(' ') || str(u.asset_item) || '—',
      href: `#/unit/${encodeURIComponent(u.serial)}`,
      customer: str(u.customer), address: str(u.job_site),
    }, u.geo);
  }

  return { pins, off };
}

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Collapse rows that share a coordinate into one pin.
 *
 * Keyed on the coordinate STRING at 6 decimals, because the geocode cache is
 * keyed on the address and hands back byte-identical numbers for the same
 * address — so an exact match is the honest test, and a distance threshold
 * would invent clusters the data does not claim.
 *
 * A stack takes the BEST precision of its rows: if one of them is known to the
 * rooftop then the place is, and reporting the vaguest row's precision would
 * understate what we actually have.
 *
 * -> [{ key, lat, lng, precision, rows, kinds }]  in first-seen order
 */
export function stack(pins) {
  const by = new Map();
  for (const p of arr(pins)) {
    const key = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    let s = by.get(key);
    if (!s) {
      s = { key, lat: p.lat, lng: p.lng, precision: null, rows: [], kinds: [] };
      by.set(key, s);
    }
    s.rows.push(p);
    if (rank(p.precision) > rank(s.precision)) s.precision = p.precision;
    if (!s.kinds.includes(p.kind)) s.kinds.push(p.kind);
  }
  return [...by.values()];
}

// Best to worst. An unknown or absent precision ranks 0 — below `city` — so we
// never claim more than the engine told us. The `|| 0` matters: comparing
// against `undefined` is always false, which would silently keep the FIRST
// row's precision instead of the best one.
const PRECISION_RANK = { rooftop: 3, street: 2, city: 1 };
const rank = (p) => PRECISION_RANK[p] || 0;

/**
 * What the tap sheet says about an address, or '' when there is nothing to say.
 *
 * Only two cases earn a line. A rooftop hit is the normal case and needs no
 * apology; anything vaguer is something a driver has to know BEFORE he sets
 * off, because "the pin is 400 m from the gate" is a different day than "the
 * pin is the gate". Rendered as a lead-in and a plain-English half so it reads
 * as information rather than an error.
 *
 * -> { lead, rest } | null
 */
export function precisionNote(precision, legend) {
  const l = legend && typeof legend === 'object' ? legend : {};
  if (precision === 'city') {
    return { lead: 'City center', rest: str(l.city) || 'no street address on file' };
  }
  if (precision === 'street') {
    return { lead: 'Approximate', rest: str(l.street) || 'street, no number' };
  }
  return null;
}

/** The kind a stack draws as: the first of KINDS present, so the order is the priority. */
export const stackKind = (s) => KINDS.find((k) => s.kinds.includes(k)) || 'rental';

/** Filter rows to the kinds currently switched on. */
export const byKinds = (rows, on) => arr(rows).filter((r) => on instanceof Set ? on.has(r.kind) : true);

/** Off-map rows grouped for the list, in KINDS order. -> [{kind, label, rows}] */
export function groupOff(rows) {
  const out = [];
  for (const kind of KINDS) {
    const hits = arr(rows).filter((r) => r.kind === kind);
    if (hits.length) out.push({ kind, label: KIND_LABEL[kind], rows: hits });
  }
  return out;
}

/* ====================================================== directions ======== */

const coord = (lat, lng) => `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;

/**
 * Directions to one place — by COORDINATES, never the address string.
 *
 * The string is the thing that geocoded badly enough to need this map; handing
 * it back to Google would reproduce whatever it did the first time. The
 * coordinate is what the engine actually resolved.
 */
export function navUrl(lat, lng) {
  if (num(lat) == null || num(lng) == null) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(coord(lat, lng))}`;
}

/** Google takes 10 points after the origin; the shop is the origin either way. */
export const MAX_STOPS = 9;

/**
 * A multi-stop route from the shop, in tap order.
 *
 * `backToShop` makes the shop the destination and pushes every stop into the
 * waypoints — which is the shape of a real run: leave the shop, work the list,
 * come home. Without it the last stop is the destination and the driver is
 * finished wherever he ends up.
 */
export function routeUrl(shop, stops, backToShop = false) {
  const list = arr(stops).filter((s) => s && num(s.lat) != null && num(s.lng) != null).slice(0, MAX_STOPS);
  if (!shop || num(shop.lat) == null || num(shop.lng) == null || !list.length) return null;

  const origin = coord(shop.lat, shop.lng);
  const points = list.map((s) => coord(s.lat, s.lng));
  const destination = backToShop ? origin : points[points.length - 1];
  const waypoints = backToShop ? points : points.slice(0, -1);

  const q = [
    'api=1',
    `origin=${encodeURIComponent(origin)}`,
    `destination=${encodeURIComponent(destination)}`,
    waypoints.length ? `waypoints=${encodeURIComponent(waypoints.join('|'))}` : '',
    'travelmode=driving',
  ].filter(Boolean);
  return `https://www.google.com/maps/dir/?${q.join('&')}`;
}

/** meta.geo, defensively. Missing pieces disable the parts that need them. */
export function geoMeta(snapshot) {
  const g = snapshot && snapshot.meta && snapshot.meta.geo;
  if (!g || typeof g !== 'object') return null;
  const shop = g.shop && num(g.shop.lat) != null && num(g.shop.lng) != null
    ? { label: str(g.shop.label) || 'WSS', address: str(g.shop.address), lat: num(g.shop.lat), lng: num(g.shop.lng) }
    : null;
  return {
    shop,
    bounds: g.bounds || null,
    default_view: g.default_view || g.bounds || null,
    precision_legend: g.precision_legend && typeof g.precision_legend === 'object' ? g.precision_legend : {},
  };
}

/** Has the engine sent us anything to draw a map from? */
export const hasGeo = (snapshot) => !!geoMeta(snapshot);
