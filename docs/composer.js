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
  renderQuoteEmail, quoteTotals, fmtUsd, defaultSubject, NUMBER_PLACEHOLDER, esc,
  DEFAULT_TAX_RATE, DEFAULT_VALID_DAYS, taxLabel, TAX_EXEMPT_LINE,
} from './quote-email.js';

export const BRAND_CHIPS = ['Factory Cat', 'Kodiak', 'Tomcat', 'other'];
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
  for (const m of (catalog && catalog.machines) || []) {
    if (brand && (brand === 'other' ? NAMED_BRANDS.has(m.manufacturer) : m.manufacturer !== brand)) continue;
    const hay = norm([m.title, m.model, m.stock].join(' '));
    if (words.every((w) => hay.includes(w))) out.push(m);
    if (out.length >= SEARCH_LIMIT) break;
  }
  return out;
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
export function noteTemplate(lead, pickedTitle = null) {
  const l = lead || {};
  const first = String(l.contact || '').trim().split(/\s+/)[0] || 'there';
  const about = l.machine || pickedTitle || 'the machine';
  const what = l.machine || pickedTitle || 'it';
  const ask = typeof l.note === 'string' && l.note.trim() ? ` You asked about: "${l.note.trim().split('\n')[0].slice(0, 160)}".` : '';
  return `Hi ${first},\n\nThanks for reaching out about ${about}. Here's the quote for ${what} for ${l.customer || 'you'}.${ask}\n\nHappy to set up a demo — just reply or call me.`;
}

/** "$5,433" / "5433.00" / "" → number | null (empty) | NaN (garbage). */
export function parseMoney(v) {
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  return Number(s);
}

const money2 = (n) => (typeof n === 'number' && isFinite(n) ? String(Math.round(n * 100) / 100) : '');

export function newDraft(lead) {
  return {
    lead: lead.lead, to: lead.email || '', cc: '', subject: null, query: '', brand: null,
    lines: [], freight: '', tax: true, note: noteTemplate(lead), noteTouched: false,
    open: new Set(), view: 'edit', confirm: false, sending: false, error: null, seq: 0,
  };
}

/** Pick a catalog machine → a machine line priced at list (Q7: Kevin edits the number). */
export function addMachine(draft, m, lead) {
  if (draft.lines.length >= MAX_LINES) return null;
  const line = {
    id: ++draft.seq, kind: 'machine', key: m.key, description: m.title || '', model: m.model || '', stock: m.stock || '',
    qty: '1', unit: money2(m.list), list: typeof m.list === 'number' ? m.list : null,
    series: m.series || null, deck_in: m.deck_in == null ? null : m.deck_in, deck_type: m.deck_type || null, options: [],
  };
  draft.lines.push(line);
  if (!draft.noteTouched && lead) draft.note = noteTemplate(lead, firstTitle(draft));
  draft.query = '';
  return line;
}

export function addText(draft) {
  if (draft.lines.length >= MAX_LINES) return null;
  const line = { id: ++draft.seq, kind: 'text', description: '', qty: '1', unit: '' };
  draft.lines.push(line);
  return line;
}

export function removeLine(draft, id) {
  draft.lines = draft.lines.filter((l) => l.id !== id);
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
  const m = draft.lines.find((l) => l.kind === 'machine');
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
      return {
        kind: 'machine', key: l.key || undefined, description: l.description, model: l.model || undefined,
        qty: Number.isInteger(qty) ? qty : 1, unit,
        options: l.options.map((o) => ({ part: o.part || undefined, description: o.description, unit: parseMoney(o.unit) })),
      };
    }
    return { kind: 'text', description: String(l.description || '').trim(), qty: Number.isInteger(qty) ? qty : 1, unit };
  });
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
  if (!draft.lines.length) return 'Pick a machine (or add a line) first.';
  for (const l of draft.lines) {
    const what = l.description || (l.kind === 'text' ? 'the extra line' : 'the machine');
    if (l.kind === 'text' && !String(l.description || '').trim()) return 'Say what the extra line is for.';
    const u = parseMoney(l.unit);
    if (u == null || Number.isNaN(u)) return `Put a price on ${what}.`;
    const q = Number.parseInt(l.qty, 10);
    if (!(q >= 1 && q <= 99) || String(q) !== String(l.qty).trim()) return `Qty on ${what} is 1–99.`;
    for (const o of l.options || []) {
      const ou = parseMoney(o.unit);
      if (ou == null || Number.isNaN(ou)) return `Put a price on ${o.description} (0 for N/C).`;
    }
  }
  if (Number.isNaN(parseMoney(draft.freight))) return 'Freight is a dollar amount — or leave it empty.';
  if (String(draft.note || '').length > 4000) return 'The note is over 4,000 characters.';
  return null;
}

/** Preview-side totals — the Worker computes the real ones. Unparseable prices count as 0 here. */
export function draftTotals(draft, rate = DEFAULT_TAX_RATE) {
  const p = draftPayload(draft);
  const clean = p.lines.map((l) => ({
    ...l, unit: typeof l.unit === 'number' && isFinite(l.unit) ? l.unit : 0,
    options: (l.options || []).map((o) => ({ ...o, unit: typeof o.unit === 'number' && isFinite(o.unit) ? o.unit : 0 })),
  }));
  return quoteTotals(clean, p.tax, rate);
}

/** renderQuoteEmail's input for the preview: no number, no PDF link, NO pixel. */
export function previewInput(draft, lead, catalog, { today, expires, me } = {}) {
  const p = draftPayload(draft);
  const lines = p.lines.map((l) => ({ ...l, unit: Number.isFinite(l.unit) ? l.unit : 0,
    options: (l.options || []).map((o) => ({ ...o, unit: Number.isFinite(o.unit) ? o.unit : 0 })) }));
  return {
    number: null, date: today, expires, valid_days: DEFAULT_VALID_DAYS,
    customer: lead.customer, contact: lead.contact, to: p.to,
    sender: (catalog && catalog.sender) || { name: (me && me.name) || '' },
    lines, tax: p.tax, tax_rate: (catalog && catalog.tax_rate) || DEFAULT_TAX_RATE,
    note: p.note, business: (catalog && catalog.business) || null, pdf_url: null, pixel_url: null,
  };
}

/* ================================================================ views == */

const attr = (v) => esc(v);
const priceText = (n) => (n == null ? 'no list price' : n === 0 ? 'N/C' : fmtUsd(n));

function lineCard(draft, catalog, l) {
  const head = html => `<div class="qc-line card" data-line="${l.id}">${html}</div>`;
  const rm = `<button type="button" class="qc-x" data-qc="remove" data-line="${l.id}" aria-label="Remove this line">✕</button>`;
  const qtyUnit = `
    <div class="qc-2">
      <label>Qty<input data-qc-line="qty" data-line="${l.id}" inputmode="numeric" value="${attr(l.qty)}"></label>
      <label>Unit price<input data-qc-line="unit" data-line="${l.id}" inputmode="decimal" value="${attr(l.unit)}" placeholder="0.00"></label>
    </div>`;
  if (l.kind === 'text') {
    return head(`
      <div class="qc-line-h"><strong>Extra line</strong>${rm}</div>
      <label>What it is<input data-qc-line="description" data-line="${l.id}" maxlength="200" value="${attr(l.description)}" placeholder="Delivery + setup, Mequon"></label>
      ${qtyUnit}`);
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
  return head(`
    <div class="qc-line-h"><strong>${esc(l.description)}</strong>${rm}</div>
    <div class="qc-sub">${[l.model && `Model ${esc(l.model)}`, l.stock && `Stock ${esc(l.stock)}`, l.list != null ? `list ${esc(fmtUsd(l.list))}` : 'no list price — type one'].filter(Boolean).join(' · ')}</div>
    ${qtyUnit}
    ${groups.length ? `<div class="qc-opts-h">Options</div>${grp}` : ''}`);
}

export function resultsHtml(draft, catalog) {
  const q = norm(draft.query);
  if (!q && !draft.brand) return '<div class="form-note">Type a model, a name or a stock number.</div>';
  const hits = searchMachines(catalog, draft.query, draft.brand);
  if (!hits.length) return '<div class="form-note">Nothing matches. Not in the catalog? Add a line below and type it in.</div>';
  return hits.map((m) => `
    <button type="button" class="qc-hit" data-qc="pick" data-key="${attr(m.key)}">
      <span class="qc-hit-t">${esc(m.title)}</span>
      <span class="qc-hit-s">${esc([m.model, m.stock].filter(Boolean).join(' · '))}<span class="qc-hit-p">${esc(priceText(m.list))}</span></span>
    </button>`).join('');
}

export function totalsHtml(draft, catalog) {
  const rate = (catalog && catalog.tax_rate) || DEFAULT_TAX_RATE;
  const t = draftTotals(draft, rate);
  return `
    <div class="qc-sum-row"><span>Subtotal ${fmtUsd(t.subtotal)}</span><span>${draft.tax ? `${esc(taxLabel(rate))} ${fmtUsd(t.tax)}` : 'No tax'}</span></div>
    <div class="qc-sum-row qc-total"><span>Total</span><span>${fmtUsd(t.total)}</span></div>`;
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
  const rate = (catalog && catalog.tax_rate) || DEFAULT_TAX_RATE;
  const chips = BRAND_CHIPS.map((b) => `<button type="button" class="chipbtn${draft.brand === b ? ' on' : ''}" data-qc="brand" data-brand="${attr(b)}">${esc(b === 'other' ? 'Other' : b)}</button>`).join('');
  return `${crumb}${head}${err}
  <div class="qc" id="qc">
    <section class="card qc-sec">
      <label>To<input data-qc-field="to" type="email" inputmode="email" autocomplete="off" value="${attr(draft.to)}" placeholder="customer@company.com"></label>
      <label>Cc<input data-qc-field="cc" type="text" inputmode="email" autocomplete="off" value="${attr(draft.cc)}" placeholder="optional — comma between addresses"></label>
      <label>Subject<input data-qc-field="subject" type="text" maxlength="200" value="${attr(subjectOf(draft))}"></label>
    </section>

    <h2>Machine</h2>
    ${draft.lines.map((l) => lineCard(draft, catalog, l)).join('')}
    <section class="card qc-sec">
      <label>${draft.lines.length ? 'Add another machine' : 'Find the machine'}<input data-qc-field="query" type="search" autocomplete="off" value="${attr(draft.query)}" placeholder="K12, MICRO-HD, stock #…"></label>
      <div class="qc-brands">${chips}</div>
      <div class="qc-results" id="qc-results">${resultsHtml(draft, catalog)}</div>
      <button type="button" class="btn ghost qc-addtext" data-qc="add-text">+ A line that isn't in the catalog</button>
    </section>

    <section class="card qc-sec">
      <label>Freight<input data-qc-field="freight" inputmode="decimal" value="${attr(draft.freight)}" placeholder="leave empty to leave it off"></label>
      <label class="qc-chk qc-tax"><input type="checkbox" data-qc="tax"${draft.tax ? ' checked' : ''}>
        <span>${esc(taxLabel(rate))} on machine, options and freight</span></label>
      ${draft.tax ? '' : `<div class="form-note">The quote will read "${esc(TAX_EXEMPT_LINE)}".</div>`}
    </section>

    <section class="card qc-sec">
      <label>Note<textarea data-qc-field="note" rows="8" maxlength="4000">${esc(draft.note)}</textarea></label>
      <div class="form-note">Plain words — it's the body of the email. The price table, the PDF button and the terms go under it.</div>
      <button type="button" class="btn ghost sm" data-qc="discard">Discard this quote</button>
    </section>
    ${barHtml(draft, catalog)}
  </div>`;
}
