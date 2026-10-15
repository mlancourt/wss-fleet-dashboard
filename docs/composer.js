/* D83 — the quote composer: Kevin quotes a machine by email from his phone.
 *
 * Route `#/lead/<L>/quote` (sales + owner). One column, 44 px targets, the
 * running total pinned at the bottom. Compose → Preview → Send, or discard —
 * there is no draft state on the server (v1), only this page's memory.
 *
 * Split in two on purpose:
 *   - PURE helpers (search, deck filter, note template, payload, totals) that
 *     tools/selftest-quotes.mjs drives directly;
 *   - VIEW functions returning HTML strings, which app.js mounts like every
 *     other view. app.js owns the events; it calls back into here.
 *
 * The preview is docs/quote-email.js — the SAME function the Worker sends
 * with. Numbers here are only a preview: the Worker recomputes every total.
 */
import {
  renderQuoteEmail, quoteTotals, fmtUsd, defaultSubject, NUMBER_PLACEHOLDER, esc, BANNER_PATH,
  DEFAULT_VALID_DAYS, TAX_NOTE_LINE, TAX_EXEMPT_LINE, RENTAL_TERMS, TERM_LABEL, TERM_SHORT, SHORT_TERMS,
} from './quote-email.js';

export const BRAND_CHIPS = ['Factory Cat', 'Kodiak', 'Tomcat', 'other', 'Rentals'];   // D100: Rentals narrows to the rental listings
export const RENTAL_CHIP = 'Rentals';
export const DEFAULT_TERM = 'week';          // the site's floor (no day rate advertised); Kevin changes it
export const ADDON_LIMIT = 12;
const NAMED_BRANDS = new Set(['Factory Cat', 'Kodiak', 'Tomcat']);
export const SEARCH_LIMIT = 20;
export const MAX_LINES = 25;
const EMAIL_RE = /^[^\s@<>,;"()[\]]{1,64}@[^\s@<>,;"()[\]]+\.[A-Za-z]{2,}$/;

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

/* ================================================================ pure == */

/** Substring search over title + model + stock — every typed word must hit. Top 20, catalog order. */
export function searchMachines(catalog, query, brand = null) {
  const words = norm(query).split(' ').filter(Boolean);
  const out = [];
  // D100: the rental listings search alongside the machines (Kevin types "XR" either way); each hit says
  // which it is. The Rentals chip narrows to rentals only; a brand chip narrows to that brand's machines.
  const rentals = (brand == null || brand === RENTAL_CHIP) ? ((catalog && catalog.rentals) || []).map((r) => ({ ...r, rental: true })) : [];
  const machines = brand === RENTAL_CHIP ? [] : ((catalog && catalog.machines) || []);
  for (const m of [...rentals, ...machines]) {
    if (!m.rental && brand && (brand === 'other' ? NAMED_BRANDS.has(m.manufacturer) : m.manufacturer !== brand)) continue;
    const hay = norm([m.title, m.model, m.stock, m.rental ? `rental ${m.rate_class || ''}` : ''].join(' '));
    if (words.every((w) => hay.includes(w))) out.push(m);
    if (out.length >= SEARCH_LIMIT) break;
  }
  return out;
}

/** D100: the add-ons (cleaners, pads) — every typed word must hit the title or stock number. */
export function searchAddons(catalog, query) {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const a of (catalog && catalog.addons) || []) {
    const hay = norm([a.description, a.stock, a.group].join(' '));
    if (words.every((w) => hay.includes(w))) out.push(a);
    if (out.length >= ADDON_LIMIT) break;
  }
  return out;
}

/**
 * D100: the delivery zone for a lead's site/city from the matrix's city list — a city name, or a prefix of
 * one when the lead carries an abbreviation ("Ocon" → Oconomowoc → Local). null when nothing matches.
 */
export function zoneForCity(catalog, city) {
  const d = catalog && catalog.delivery;
  if (!d || !d.cities) return null;
  const c = norm(city);
  if (!c) return null;
  if (d.cities[c]) return d.cities[c];
  const first = c.split(/[ ,]/)[0];
  if (first.length < 3) return null;
  const hit = Object.keys(d.cities).find((k) => k.startsWith(first));
  return hit ? d.cities[hit] : null;
}

/** The zone row by name, or null. */
export const zoneRow = (catalog, zone) => ((catalog && catalog.delivery && catalog.delivery.zones) || []).find((z) => z.zone === zone) || null;

/** D100: a rental quote with a day or weekend line pays the short-term delivery / pick-up figures (matrix rule 2). */
export const isShortTerm = (draft) => draft.lines.some((l) => l.kind === 'rental' && SHORT_TERMS.has(l.term));

/** The delivery + pick-up amounts the zone says, for the draft's term mix → {delivery, pickup, short} (numbers) or null. */
export function zoneAmounts(catalog, draft) {
  const z = zoneRow(catalog, draft.zone);
  if (!z) return null;
  const short = isShortTerm(draft);
  return { delivery: short ? z.short_delivery : z.delivery, pickup: short ? z.short_pickup : z.pickup, short };
}

/** Re-fill delivery + pick-up from the zone — only the fields Kevin hasn't typed over. */
export function applyZone(catalog, draft) {
  const a = zoneAmounts(catalog, draft);
  if (!a) return;
  if (!draft.deliveryTouched) draft.delivery = money2(a.delivery);
  if (!draft.pickupTouched) draft.pickup = money2(a.pickup);
}

/**
 * The option groups a machine can take: its series' groups, filtered to its
 * deck (spec §1: deck_min ≤ deck_in ≤ deck_max, or the group names no deck;
 * deck_type equal, or the group names none). Same-named groups merge.
 */
export function groupsFor(catalog, machine) {
  const s = machine && machine.series && catalog && catalog.series ? catalog.series[machine.series] : null;
  if (!s || !Array.isArray(s.groups)) return [];
  const fits = (g) => {
    const ranged = g.deck_min != null || g.deck_max != null;
    if (ranged) {
      if (typeof machine.deck_in !== 'number') return false;
      if (g.deck_min != null && machine.deck_in < g.deck_min) return false;
      if (g.deck_max != null && machine.deck_in > g.deck_max) return false;
    }
    return !g.deck_type || g.deck_type === machine.deck_type;
  };
  const merged = [];
  for (const g of s.groups) {
    if (!fits(g)) continue;
    const have = merged.find((x) => x.name === g.name);
    if (have) have.items.push(...(g.items || []));
    else merged.push({ name: g.name, items: [...(g.items || [])] });
  }
  return merged.filter((g) => g.items.length);
}

/** "Hi Pat,\n\nThanks for reaching out about …" — Kevin edits or wipes it. */
export function noteTemplate(lead, pickedTitle = null, rental = false) {
  const l = lead || {};
  const first = String(l.contact || '').trim().split(/\s+/)[0] || 'there';
  // The picked machine wins once there is one (the lead's free-text `machine` is what they asked about,
  // not necessarily what Kevin is quoting); before a pick, the lead's machine is the best guess.
  const about = pickedTitle || l.machine || 'the machine';
  const what = pickedTitle || l.machine || 'it';
  const ask = typeof l.note === 'string' && l.note.trim() ? ` You asked about: "${l.note.trim().split('\n')[0].slice(0, 160)}".` : '';
  // D100: a rental reads like a rental — no demo line (the delivery IS the walkthrough: operator instructions at delivery).
  if (rental) {
    return `Hi ${first},\n\nThanks for reaching out about renting ${about}. Here's the rental quote for ${l.customer || 'you'} — rate, delivery and pick-up are itemized below.${ask}\n\nLet me know the dates you're thinking and I'll get it on the schedule.`;
  }
  return `Hi ${first},\n\nThanks for reaching out about ${about}. Here's the quote for ${what} for ${l.customer || 'you'}.${ask}\n\nHappy to set up a demo — just reply or call me.`;
}

/**
 * The Discount field (spec v1.1 §1): "543" is dollars, "10%" is a percent of the MSRP. → the AMOUNT
 * (number), null when empty, NaN when it isn't either. A percent needs an MSRP to come off.
 */
export function parseDiscount(v, list) {
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (!s) return null;
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(s);
  if (pct) return typeof list === 'number' && Number(pct[1]) <= 100 ? Math.round(list * Number(pct[1])) / 100 : NaN;
  return parseMoney(s);
}

/** "$5,433" / "5433.00" / "" → number | null (empty) | NaN (garbage). */
export function parseMoney(v) {
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  return Number(s);
}

const money2 = (n) => { if (typeof n !== 'number' || !isFinite(n)) return ''; const r = Math.round(n * 100) / 100; return Number.isInteger(r) ? String(r) : r.toFixed(2); };

export function newDraft(lead) {
  return {
    lead: lead.lead, to: lead.email || '', cc: '', subject: null, query: '', brand: null,
    lines: [], freight: '', tax: true, note: noteTemplate(lead, null, lead.interest === 'RENTAL'), noteTouched: false,
    open: new Set(), view: 'edit', confirm: false, sending: false, error: null, seq: 0,
    // D100: the rental half — zone (auto from the lead's city), delivery / pick-up (auto from the zone, editable), add-on search.
    zone: null, delivery: '', pickup: '', deliveryTouched: false, pickupTouched: false, selfPickup: false, addonQuery: '',
  };
}

/** D100: pick a rental listing → a rental line at the matrix rate for the default term. */
export function addRental(draft, r, lead, catalog = null) {
  if (draft.lines.length >= MAX_LINES) return null;
  const rates = r.rates || {};
  const term = typeof rates[DEFAULT_TERM] === 'number' ? DEFAULT_TERM : (RENTAL_TERMS.find((t) => typeof rates[t] === 'number') || DEFAULT_TERM);
  const line = {
    id: ++draft.seq, kind: 'rental', key: r.key, description: r.title || '', model: r.model || '', stock: r.stock || '',
    rate_class: r.rate_class || null, rates, term, qty: '1', unit: money2(rates[term]), note: '', listing: true,
  };
  draft.lines.push(line);
  if (!draft.zone && catalog) draft.zone = zoneForCity(catalog, lead && lead.site);
  if (catalog) applyZone(catalog, draft);
  retemplate(draft, lead);
  draft.query = '';
  return line;
}

/** D100: change the term on a rental line → the unit follows the matrix (Kevin can still type over it). */
export function setTerm(draft, lineId, term, catalog = null) {
  const l = draft.lines.find((x) => x.id === lineId);
  if (!l || l.kind !== 'rental' || !RENTAL_TERMS.includes(term)) return;
  l.term = term;
  if (typeof (l.rates || {})[term] === 'number') l.unit = money2(l.rates[term]);
  if (catalog) applyZone(catalog, draft);
}

/** D100: an add-on from the supplies list → an addon line at the site's price. */
export function addAddon(draft, a) {
  if (draft.lines.length >= MAX_LINES) return null;
  const line = { id: ++draft.seq, kind: 'addon', stock: a.stock || '', description: a.description || '', qty: '1', unit: money2(a.list), note: '' };
  draft.lines.push(line);
  draft.addonQuery = '';
  return line;
}

/** D100: self-pickup at the shop → no delivery, no pick-up (matrix: waives both). Off again → the zone refills them. */
export function setSelfPickup(draft, on, catalog = null) {
  draft.selfPickup = !!on;
  if (draft.selfPickup) { draft.delivery = ''; draft.pickup = ''; draft.deliveryTouched = false; draft.pickupTouched = false; }
  else if (catalog) applyZone(catalog, draft);
}

/** Pick a catalog machine → a machine line priced at list (Q7: Kevin edits the number). */
export function addMachine(draft, m, lead) {
  if (draft.lines.length >= MAX_LINES) return null;
  const line = {
    id: ++draft.seq, kind: 'machine', key: m.key, description: m.title || '', model: m.model || '', stock: m.stock || '',
    qty: '1', unit: money2(m.list), list: typeof m.list === 'number' ? m.list : null, discount: '', note: '',
    series: m.series || null, deck_in: m.deck_in == null ? null : m.deck_in, deck_type: m.deck_type || null, options: [],
    listing: true,      // v1.3 (D91): the photo + specs + description ride along unless Kevin turns it off
  };
  draft.lines.push(line);
  retemplate(draft, lead);
  draft.query = '';
  return line;
}

export function addText(draft) {
  if (draft.lines.length >= MAX_LINES) return null;
  const line = { id: ++draft.seq, kind: 'text', description: '', qty: '1', unit: '', note: '' };
  draft.lines.push(line);
  return line;
}

export function removeLine(draft, id, lead = null, catalog = null) {
  draft.lines = draft.lines.filter((l) => l.id !== id);
  retemplate(draft, lead);
  if (catalog && !draft.selfPickup) applyZone(catalog, draft);
}

/** Re-write the note for the current first machine — only while Kevin hasn't touched it. */
export function retemplate(draft, lead) {
  if (!draft.noteTouched && lead) draft.note = noteTemplate(lead, firstTitle(draft), hasRentalLine(draft) || (!draft.lines.length && lead.interest === 'RENTAL'));
}

export const hasRentalLine = (draft) => draft.lines.some((l) => l.kind === 'rental');

/**
 * Keep MSRP − discount = unit (v1.1 §1). Editing the discount moves the unit; editing the unit
 * back-computes the discount. → the field that moved and its new text, for app.js to write into
 * the OTHER input without re-rendering the one under the thumb.
 */
export function syncPrice(line, edited) {
  if (!line || line.kind !== 'machine' || typeof line.list !== 'number') return null;
  if (edited === 'discount') {
    const d = parseDiscount(line.discount, line.list);
    if (d == null) { line.unit = money2(line.list); return { field: 'unit', value: line.unit }; }
    if (Number.isNaN(d)) return null;
    line.unit = money2(Math.round((line.list - d) * 100) / 100);
    return { field: 'unit', value: line.unit };
  }
  if (edited === 'unit') {
    const u = parseMoney(line.unit);
    if (u == null || Number.isNaN(u)) return null;
    const d = Math.round((line.list - u) * 100) / 100;
    line.discount = d > 0 ? money2(d) : '';
    return { field: 'discount', value: line.discount };
  }
  return null;
}

/** Tick / untick an option on a machine line. A tick starts at list price. */
export function toggleOption(draft, lineId, item) {
  const l = draft.lines.find((x) => x.id === lineId);
  if (!l || l.kind !== 'machine' || !item) return;
  const at = l.options.findIndex((o) => o.part === item.part);
  if (at >= 0) l.options.splice(at, 1);
  else l.options.push({ part: item.part, description: item.description, list: item.list, unit: money2(item.list == null ? 0 : item.list) });
}

const firstTitle = (draft) => {
  const m = draft.lines.find((l) => l.kind === 'machine' || l.kind === 'rental');
  return m ? m.description : null;
};

export const subjectOf = (draft) => (draft.subject != null ? draft.subject : defaultSubject(null, firstTitle(draft)));
export const ccList = (draft) => String(draft.cc || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

/** The quote_send payload. Throws nothing; draftProblem() says what's wrong first. */
export function draftPayload(draft) {
  const lines = draft.lines.map((l) => {
    const qty = Number.parseInt(l.qty, 10);
    const unit = parseMoney(l.unit);
    if (l.kind === 'machine') {
      const out = {
        kind: 'machine', key: l.key || undefined, description: l.description, model: l.model || undefined,
        qty: Number.isInteger(qty) ? qty : 1, unit,
        options: l.options.map((o) => ({ part: o.part || undefined, description: o.description, unit: parseMoney(o.unit) })),
      };
      // MSRP + discount travel whenever there is an MSRP and the price is at or under it; the discount
      // is derived from the two so list − discount = unit holds to the cent (the Worker refuses otherwise).
      if (typeof l.list === 'number' && typeof unit === 'number' && !Number.isNaN(unit) && unit <= l.list) {
        out.list = l.list;
        out.discount = Math.round((l.list - unit) * 100) / 100;
      }
      const n = String(l.note || '').trim();
      if (n) out.note = n;
      if (l.key) out.listing = l.listing !== false;
      return out;
    }
    if (l.kind === 'rental') {
      const r = { kind: 'rental', key: l.key || undefined, description: l.description, model: l.model || undefined, term: l.term,
        qty: Number.isInteger(qty) ? qty : 1, unit };
      if (typeof (l.rates || {})[l.term] === 'number') r.list = l.rates[l.term];   // the matrix rate — `list`, like a machine's MSRP
      const n = String(l.note || '').trim();
      if (n) r.note = n;
      if (l.key) r.listing = l.listing !== false;
      return r;
    }
    const t = { kind: l.kind === 'addon' ? 'addon' : 'text', description: String(l.description || '').trim(), qty: Number.isInteger(qty) ? qty : 1, unit };
    if (l.kind === 'addon' && l.stock) t.stock = l.stock;
    const n = String(l.note || '').trim();
    if (n) t.note = n;
    return t;
  });
  // D100: delivery + pick-up as two text lines (matrix rule 1 — always separate), the zone named, the surcharge noted.
  if (hasRentalLine(draft) && !draft.selfPickup) {
    const z = draft.zone ? ` (${draft.zone} zone)` : '';
    const short = isShortTerm(draft) ? 'Includes the 20% short-term surcharge.' : null;
    const dl = parseMoney(draft.delivery);
    if (dl != null && !Number.isNaN(dl)) lines.push({ kind: 'text', description: `Delivery${z}`, qty: 1, unit: dl, ...(short ? { note: short } : {}) });
    const pu = parseMoney(draft.pickup);
    if (pu != null && !Number.isNaN(pu)) lines.push({ kind: 'text', description: `Pick-up${z}`, qty: 1, unit: pu, ...(short ? { note: short } : {}) });
  }
  const f = parseMoney(draft.freight);
  if (f != null) lines.push({ kind: 'freight', description: 'Freight', qty: 1, unit: f });
  return {
    lead: draft.lead, to: String(draft.to || '').trim(), cc: ccList(draft), subject: subjectOf(draft),
    lines, tax: !!draft.tax, note: String(draft.note || ''), valid_days: DEFAULT_VALID_DAYS,
  };
}

/** The one thing to fix before Send, in plain words — or null. Mirrors the Worker's refusals. */
export function draftProblem(draft) {
  if (!EMAIL_RE.test(String(draft.to || '').trim())) return 'Put the customer\'s email in To.';
  const bad = ccList(draft).find((c) => !EMAIL_RE.test(c));
  if (bad) return `"${bad}" in Cc isn't an email address.`;
  if (!draft.lines.length) return 'Pick a machine or a rental (or add a line) first.';
  for (const l of draft.lines) {
    const what = l.description || (l.kind === 'text' ? 'the extra line' : l.kind === 'addon' ? 'the add-on' : l.kind === 'rental' ? 'the rental' : 'the machine');
    if ((l.kind === 'text' || l.kind === 'addon') && !String(l.description || '').trim()) return 'Say what the extra line is for.';
    if (l.kind === 'rental' && !RENTAL_TERMS.includes(l.term)) return `Pick a rental term on ${what}.`;
    const u = parseMoney(l.unit);
    if (u == null || Number.isNaN(u)) return `Put a price on ${what}.`;
    if (l.kind === 'machine' && typeof l.list === 'number') {
      const d = parseDiscount(l.discount, l.list);
      if (Number.isNaN(d)) return `Discount on ${what} is a dollar amount or a percent (543 or 10%).`;
      if (d != null && d > l.list) return `The discount on ${what} is more than its MSRP.`;
    }
    if (String(l.note || '').length > 300) return `The note on ${what} is over 300 characters.`;
    const q = Number.parseInt(l.qty, 10);
    if (!(q >= 1 && q <= 99) || String(q) !== String(l.qty).trim()) return `Qty on ${what} is 1–99.`;
    for (const o of l.options || []) {
      const ou = parseMoney(o.unit);
      if (ou == null || Number.isNaN(ou)) return `Put a price on ${o.description} (0 for N/C).`;
    }
  }
  if (Number.isNaN(parseMoney(draft.freight))) return 'Freight is a dollar amount — or leave it empty.';
  if (hasRentalLine(draft) && !draft.selfPickup) {
    if (Number.isNaN(parseMoney(draft.delivery))) return 'Delivery is a dollar amount — or tick self-pickup.';
    if (Number.isNaN(parseMoney(draft.pickup))) return 'Pick-up is a dollar amount — or tick self-pickup.';
  }
  if (String(draft.note || '').length > 4000) return 'The note is over 4,000 characters.';
  return null;
}

/** Preview-side totals — the Worker computes the real ones. Unparseable prices count as 0 here. */
export function draftTotals(draft) {
  const p = draftPayload(draft);
  const clean = p.lines.map((l) => ({
    ...l, unit: typeof l.unit === 'number' && isFinite(l.unit) ? l.unit : 0,
    options: (l.options || []).map((o) => ({ ...o, unit: typeof o.unit === 'number' && isFinite(o.unit) ? o.unit : 0 })),
  }));
  return quoteTotals(clean, p.tax);
}

/** renderQuoteEmail's input for the preview: no number, no PDF link, NO pixel.
 *  `listings` = {key → full machine} from GET /api/catalog/<key> (v1.3) — the card the send draws. */
export function previewInput(draft, lead, catalog, { today, expires, me, listings = null } = {}) {
  const p = draftPayload(draft);
  // D100: the preview's rental lines carry the matrix rates (`matrix`) the Worker will read back from the catalog by
  // key (the "Other terms available" line) — the payload itself never sends them.
  const ratesByKey = new Map(draft.lines.filter((l) => l.kind === 'rental' && l.key).map((l) => [l.key, l.rates || {}]));
  const lines = p.lines.map((l) => ({ ...l, unit: Number.isFinite(l.unit) ? l.unit : 0,
    ...(l.kind === 'rental' && l.key && ratesByKey.has(l.key) ? { matrix: ratesByKey.get(l.key) } : {}),
    options: (l.options || []).map((o) => ({ ...o, unit: Number.isFinite(o.unit) ? o.unit : 0 })) }));
  return {
    number: null, date: today, expires, valid_days: DEFAULT_VALID_DAYS,
    customer: lead.customer, contact: lead.contact, to: p.to,
    sender: (catalog && catalog.sender) || { name: (me && me.name) || '' },
    lines, tax: p.tax, tax_rate: null,
    note: p.note, business: (catalog && catalog.business) || null, pdf_url: null, pixel_url: null, banner_url: BANNER_PATH,
    listings,
  };
}

/* ================================================================ views == */

const attr = (v) => esc(v);
const priceText = (n) => (n == null ? 'no list price' : n === 0 ? 'N/C' : fmtUsd(n));

function lineCard(draft, catalog, l) {
  const head = html => `<div class="qc-line card" data-line="${l.id}">${html}</div>`;
  const rm = `<button type="button" class="qc-x" data-qc="remove" data-line="${l.id}" aria-label="Remove this line">✕</button>`;
  const msrp = l.kind === 'machine' && typeof l.list === 'number';
  const qtyUnit = `
    <div class="qc-2">
      <label>Qty<input data-qc-line="qty" data-line="${l.id}" inputmode="numeric" value="${attr(l.qty)}"></label>
      <label>Unit price<input data-qc-line="unit" data-line="${l.id}" inputmode="decimal" value="${attr(l.unit)}" placeholder="0.00"></label>
    </div>
    ${msrp ? `<label>Discount off ${esc(fmtUsd(l.list))} MSRP<input data-qc-line="discount" data-line="${l.id}" inputmode="decimal" value="${attr(l.discount)}" placeholder="543 or 10%"></label>` : ''}`;
  const noteField = `<label>Line note<input data-qc-line="note" data-line="${l.id}" maxlength="300" value="${attr(l.note || '')}" placeholder="Delivery included · approx. lead time 15 business days"></label>`;
  if (l.kind === 'text') {
    return head(`
      <div class="qc-line-h"><strong>Extra line</strong>${rm}</div>
      <label>What it is<input data-qc-line="description" data-line="${l.id}" maxlength="200" value="${attr(l.description)}" placeholder="Delivery + setup, Mequon"></label>
      ${qtyUnit}
      ${noteField}`);
  }
  if (l.kind === 'addon') {
    return head(`
      <div class="qc-line-h"><strong>${esc(l.description)}</strong>${rm}</div>
      <div class="qc-sub">${[l.stock && `Stock ${esc(l.stock)}`, 'add-on'].filter(Boolean).join(' · ')}</div>
      ${qtyUnit}
      ${noteField}`);
  }
  if (l.kind === 'rental') {
    // D100: term picker (matrix rates shown beside each), qty = periods, the rate editable, listing toggle.
    const rates = l.rates || {};
    const terms = RENTAL_TERMS.map((t) => `<option value="${t}"${l.term === t ? ' selected' : ''}>${esc(TERM_LABEL[t])}${typeof rates[t] === 'number' ? ` — ${esc(fmtUsd(rates[t]))}` : ''}</option>`).join('');
    const listRate = typeof rates[l.term] === 'number' ? rates[l.term] : null;
    const listing = l.key ? `
    <label class="qc-chk qc-listing"><input type="checkbox" data-qc="listing" data-line="${l.id}"${l.listing !== false ? ' checked' : ''}>
      <span>Include listing <span class="qc-part">photo · specs · description</span></span></label>` : '';
    return head(`
      <div class="qc-line-h"><strong>${esc(l.description)}</strong>${rm}</div>
      <div class="qc-sub">${[l.model && `Model ${esc(l.model)}`, l.rate_class && esc(l.rate_class), 'rental'].filter(Boolean).join(' · ')}</div>
      <label>Rental term<select data-qc-line="term" data-line="${l.id}">${terms}</select></label>
      <div class="qc-2">
        <label>How many ${esc(TERM_SHORT[l.term] || 'period')}s<input data-qc-line="qty" data-line="${l.id}" inputmode="numeric" value="${attr(l.qty)}"></label>
        <label>Rate per ${esc(TERM_SHORT[l.term] || 'period')}<input data-qc-line="unit" data-line="${l.id}" inputmode="decimal" value="${attr(l.unit)}" placeholder="0.00"></label>
      </div>
      ${listRate != null ? `<div class="form-note">Matrix rate ${esc(fmtUsd(listRate))} per ${esc(TERM_SHORT[l.term])} — the quote shows it as the list rate if you change it.</div>` : '<div class="form-note">No matrix rate for this term — type one.</div>'}
      ${noteField}${listing}`);
  }
  const groups = groupsFor(catalog, l);
  const ticked = new Set(l.options.map((o) => o.part));
  const grp = groups.map((g) => {
    const key = `${l.id}|${g.name}`;
    const open = draft.open.has(key);
    const n = g.items.filter((i) => ticked.has(i.part)).length;
    const items = open ? g.items.map((i) => {
      const on = ticked.has(i.part);
      const o = on ? l.options.find((x) => x.part === i.part) : null;
      return `
        <div class="qc-opt${on ? ' on' : ''}">
          <label class="qc-chk"><input type="checkbox" data-qc="opt" data-line="${l.id}" data-part="${attr(i.part)}"${on ? ' checked' : ''}>
            <span>${esc(i.description)} <span class="qc-part">${esc(i.part)}</span></span>
            <span class="qc-list">${i.list === 0 ? 'N/C' : esc(priceText(i.list))}</span></label>
          ${on ? `<label class="qc-optp">Price<input data-qc-opt="unit" data-line="${l.id}" data-part="${attr(i.part)}" inputmode="decimal" value="${attr(o.unit)}"></label>` : ''}
        </div>`;
    }).join('') : '';
    return `
      <div class="qc-grp">
        <button type="button" class="qc-grp-h" data-qc="group" data-line="${l.id}" data-group="${attr(g.name)}" aria-expanded="${open ? 'true' : 'false'}">
          <span>${open ? '▾' : '▸'} ${esc(g.name)}</span>${n ? `<span class="chip ok">${n} ticked</span>` : ''}</button>
        ${items}
      </div>`;
  }).join('');
  // v1.3: a catalog machine (it has a key) can carry its listing; a free-text line has nothing to show.
  const listing = l.key ? `
    <label class="qc-chk qc-listing"><input type="checkbox" data-qc="listing" data-line="${l.id}"${l.listing !== false ? ' checked' : ''}>
      <span>Include listing <span class="qc-part">photo · specs · description</span></span></label>` : '';
  return head(`
    <div class="qc-line-h"><strong>${esc(l.description)}</strong>${rm}</div>
    <div class="qc-sub">${[l.model && `Model ${esc(l.model)}`, l.stock && `Stock ${esc(l.stock)}`, l.list != null ? `MSRP ${esc(fmtUsd(l.list))}` : 'no list price — type one'].filter(Boolean).join(' · ')}</div>
    ${qtyUnit}
    ${groups.length ? `<div class="qc-opts-h">Options</div>${grp}` : ''}
    ${noteField}${listing}`);
}

export function resultsHtml(draft, catalog) {
  const q = norm(draft.query);
  if (!q && !draft.brand) return '<div class="form-note">Type a model, a name or a stock number.</div>';
  const hits = searchMachines(catalog, draft.query, draft.brand);
  if (!hits.length) return '<div class="form-note">Nothing matches. Not in the catalog? Add a line below and type it in.</div>';
  return hits.map((m) => (m.rental ? `
    <button type="button" class="qc-hit qc-hit-rental" data-qc="pick-rental" data-key="${attr(m.key)}">
      <span class="qc-hit-t">${esc(m.title)} <span class="chip rent">rental</span></span>
      <span class="qc-hit-s">${esc([m.model, m.rate_class].filter(Boolean).join(' · '))}<span class="qc-hit-p">${esc(rentalPriceText(m))}</span></span>
    </button>` : `
    <button type="button" class="qc-hit" data-qc="pick" data-key="${attr(m.key)}">
      <span class="qc-hit-t">${esc(m.title)}</span>
      <span class="qc-hit-s">${esc([m.model, m.stock].filter(Boolean).join(' · '))}<span class="qc-hit-p">${esc(priceText(m.list))}</span></span>
    </button>`)).join('');
}

const rentalPriceText = (r) => {
  const rates = r.rates || {};
  const t = typeof rates.week === 'number' ? 'week' : RENTAL_TERMS.find((x) => typeof rates[x] === 'number');
  return t ? `${fmtUsd(rates[t])}/${TERM_SHORT[t]}` : 'no matrix rate';
};

/** D100: the add-on search results. */
export function addonResultsHtml(draft, catalog) {
  if (!norm(draft.addonQuery)) return '<div class="form-note">Cleaners, fast packs, pads — type a word.</div>';
  const hits = searchAddons(catalog, draft.addonQuery);
  if (!hits.length) return '<div class="form-note">Nothing matches. Add a line below and type it in.</div>';
  return hits.map((a) => `
    <button type="button" class="qc-hit" data-qc="pick-addon" data-stock="${attr(a.stock || '')}" data-desc="${attr(a.description)}">
      <span class="qc-hit-t">${esc(a.description)}</span>
      <span class="qc-hit-s">${esc([a.stock, a.group].filter(Boolean).join(' · '))}<span class="qc-hit-p">${esc(fmtUsd(a.list))}</span></span>
    </button>`).join('');
}

/** D100: the delivery & pick-up card — only when a rental line is on the quote. */
export function deliveryHtml(draft, catalog) {
  if (!hasRentalLine(draft)) return '';
  const zones = ((catalog && catalog.delivery && catalog.delivery.zones) || []);
  const opts = [`<option value=""${!draft.zone ? ' selected' : ''}>— pick a zone —</option>`,
    ...zones.map((z) => `<option value="${attr(z.zone)}"${draft.zone === z.zone ? ' selected' : ''}>${esc(z.zone)}${z.minutes ? ` · up to ${z.minutes} min from Ixonia` : ''} — ${esc(fmtUsd(z.delivery))} each way</option>`)].join('');
  const short = isShortTerm(draft);
  const self = draft.selfPickup;
  return `
    <h2>Delivery &amp; pick-up</h2>
    <section class="card qc-sec" id="qc-delivery">
      <label>Zone<select data-qc-field="zone"${self ? ' disabled' : ''}>${opts}</select></label>
      <div class="qc-2">
        <label>Delivery<input data-qc-field="delivery" inputmode="decimal" value="${attr(draft.delivery)}" placeholder="0.00"${self ? ' disabled' : ''}></label>
        <label>Pick-up<input data-qc-field="pickup" inputmode="decimal" value="${attr(draft.pickup)}" placeholder="0.00"${self ? ' disabled' : ''}></label>
      </div>
      <label class="qc-chk"><input type="checkbox" data-qc="self-pickup"${self ? ' checked' : ''}><span>Customer picks up at the shop — no delivery or pick-up charge</span></label>
      <div class="form-note">${self ? 'Self-pickup needs a dock-height truck, lift-gate, or approved trailer — the quote says so.'
        : short ? 'Day / weekend rental: the 20% short-term surcharge is in these figures (matrix rule).'
          : zones.length ? 'Zone by one-way drive time from Ixonia; beyond 90 minutes, call it in.' : 'No delivery zones in the catalog — type the amounts.'}</div>
    </section>`;
}

export function totalsHtml(draft, catalog) {
  const t = draftTotals(draft);
  return `
    <div class="qc-sum-row"><span>Subtotal ${fmtUsd(t.subtotal)}</span><span>${draft.tax ? '+ WI sales tax at invoicing' : 'Tax exempt'}</span></div>
    <div class="qc-sum-row qc-total"><span>Total (before tax)</span><span>${fmtUsd(t.total)}</span></div>`;
}

function barHtml(draft, catalog) {
  const problem = draftProblem(draft);
  const to = String(draft.to || '').trim();
  const actions = draft.confirm ? `
      <div class="undo-confirm qc-confirm">
        <div class="undo-q">Send ${NUMBER_PLACEHOLDER} to ${esc(to)}?</div>
        <div class="form-note">It goes out now, from your mailbox, and can't be unsent. The number is assigned as it sends.</div>
        <div class="actions row">
          <button class="btn sm" type="button" data-qc="send-go"${draft.sending ? ' disabled' : ''}>${draft.sending ? 'Sending…' : 'Send it'}</button>
          <button class="btn sm ghost" type="button" data-qc="confirm-no"${draft.sending ? ' disabled' : ''}>Not yet</button>
        </div>
      </div>` : `
      <div class="actions row">
        ${draft.view === 'preview'
          ? '<button class="btn ghost" type="button" data-qc="edit">‹ Edit</button>'
          : `<button class="btn ghost" type="button" data-qc="preview"${problem ? ' disabled' : ''}>Preview</button>`}
        <button class="btn" type="button" data-qc="send"${problem ? ' disabled' : ''}>Send</button>
      </div>
      <div class="form-note qc-why" id="qc-why"${problem ? '' : ' hidden'}>${esc(problem || '')}</div>`;
  return `
    <div class="qc-bar" id="qc-bar">
      <div class="qc-sum" id="qc-sum">${totalsHtml(draft, catalog)}</div>
      ${actions}
    </div>`;
}

/** The email as it will send, minus the number and the pixel. */
export function previewHtml(draft, lead, catalog, opts) {
  const { html } = renderQuoteEmail(previewInput(draft, lead, catalog, opts));
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return `
    <div class="qc-subj"><span>Subject</span> ${esc(subjectOf(draft))}</div>
    <div class="qc-subj"><span>To</span> ${esc(String(draft.to || '').trim())}${ccList(draft).length ? ` · cc ${esc(ccList(draft).join(', '))}` : ''}</div>
    <div class="qc-preview">${body ? body[1] : html}</div>`;
}

/**
 * The whole composer. `cat` = { state: 'loading'|'ready'|'error', data, error }.
 * Everything typed into a field is read back on `input` by app.js (onComposerInput),
 * so a keystroke never re-renders the field under the thumb.
 */
export function composerView(draft, lead, cat, opts = {}) {
  const crumb = `<a class="crumb" href="#/lead/${encodeURIComponent(lead.lead)}">‹ ${esc(lead.lead)} · ${esc(lead.customer || '')}</a>`;
  const head = `
    <div class="detail-head">
      <div class="h">Quote <span class="unit-serial">${NUMBER_PLACEHOLDER}</span></div>
      <div class="s">${esc([lead.customer, lead.contact].filter(Boolean).join(' · '))}</div>
    </div>`;
  if (cat.state !== 'ready') {
    return `${crumb}${head}${cat.state === 'error'
      ? `<div class="alert">⚠️ Couldn't load the machine catalog — ${esc(cat.error || 'try again')}. <button class="btn sm ghost" type="button" data-qc="reload">Retry</button></div>`
      : '<div class="loading">Loading the catalog…</div>'}`;
  }
  const catalog = cat.data;
  const err = draft.error ? `<div class="alert">⚠️ ${esc(draft.error)}</div>` : '';
  if (draft.view === 'preview') {
    return `${crumb}${head}${err}<div class="qc" id="qc">${previewHtml(draft, lead, catalog, opts)}${barHtml(draft, catalog)}</div>`;
  }
  const chips = BRAND_CHIPS.map((b) => `<button type="button" class="chipbtn${draft.brand === b ? ' on' : ''}" data-qc="brand" data-brand="${attr(b)}">${esc(b === 'other' ? 'Other' : b)}</button>`).join('');
  return `${crumb}${head}${err}
  <div class="qc" id="qc">
    <section class="card qc-sec">
      <label>To<input data-qc-field="to" type="email" inputmode="email" autocomplete="off" value="${attr(draft.to)}" placeholder="customer@company.com"></label>
      <label>Cc<input data-qc-field="cc" type="text" inputmode="email" autocomplete="off" value="${attr(draft.cc)}" placeholder="optional — comma between addresses"></label>
      <label>Subject<input data-qc-field="subject" type="text" maxlength="200" value="${attr(subjectOf(draft))}"></label>
    </section>

    <h2>Machine or rental</h2>
    ${draft.lines.map((l) => lineCard(draft, catalog, l)).join('')}
    <section class="card qc-sec">
      <label>${draft.lines.length ? 'Add another machine or rental' : 'Find the machine or rental'}<input data-qc-field="query" type="search" autocomplete="off" value="${attr(draft.query)}" placeholder="K12, MICRO-HD, XR rental, stock #…"></label>
      <div class="qc-brands">${chips}</div>
      <div class="qc-results" id="qc-results">${resultsHtml(draft, catalog)}</div>
      <button type="button" class="btn ghost qc-addtext" data-qc="add-text">+ A line that isn't in the catalog</button>
    </section>
    ${deliveryHtml(draft, catalog)}

    <h2>Add-ons</h2>
    <section class="card qc-sec">
      <label>Cleaning solution, pads, supplies<input data-qc-field="addonQuery" type="search" autocomplete="off" value="${attr(draft.addonQuery)}" placeholder="fast packs, 20&quot; pads, degreaser…"></label>
      <div class="qc-results" id="qc-addons">${addonResultsHtml(draft, catalog)}</div>
    </section>

    <section class="card qc-sec">
      <label>Freight<input data-qc-field="freight" inputmode="decimal" value="${attr(draft.freight)}" placeholder="leave empty to leave it off"></label>
      <label class="qc-chk qc-tax"><input type="checkbox" data-qc="tax"${draft.tax ? ' checked' : ''}>
        <span>Taxable — the invoice adds WI sales tax at the ship-to county's rate</span></label>
      <div class="form-note">The quote will read "${esc(draft.tax ? TAX_NOTE_LINE : TAX_EXEMPT_LINE)}". No tax figure is quoted.</div>
    </section>

    <section class="card qc-sec">
      <label>Note<textarea data-qc-field="note" rows="8" maxlength="4000">${esc(draft.note)}</textarea></label>
      <div class="form-note">Plain words — it's the body of the email. The price table, the PDF button and the terms go under it.</div>
      <button type="button" class="btn ghost sm" data-qc="discard">Discard this quote</button>
    </section>
    ${barHtml(draft, catalog)}
  </div>`;
}
