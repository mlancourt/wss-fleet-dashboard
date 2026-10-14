/* D83 — the quote email, ONE template for two callers.
 *
 * The Worker renders it to send (worker.js → Resend) and the composer renders
 * it to preview (composer.js). Same function, same inputs, so what Kevin sees
 * on his phone is what the customer gets — that is the whole reason this file
 * is shared rather than written twice.
 *
 * Pure: no DOM, no fetch, no Date parsing of business dates (CLAUDE.md rule 7 —
 * a date-only string is rendered by string surgery, never `new Date("YYYY-MM-DD")`).
 * Money is computed in integer cents and only formatted at the edge.
 */

export const QUOTE_LINE_KINDS = ['machine', 'text', 'freight'];
export const DEFAULT_TAX_RATE = 0.055;     // WI 5.5% — the Worker's WSS_TAX_RATE overrides
export const DEFAULT_VALID_DAYS = 30;      // Q3
export const NUMBER_PLACEHOLDER = 'Q----'; // the number is minted at send

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Dollars (number) → integer cents. Non-numbers are 0 — the Worker refuses them before here. */
export const toCents = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) : 0);

/** 1299540 → "$12,995.40". Always to the cent: a quote is a number someone will check. */
export function fmtCents(c) {
  const neg = c < 0;
  const abs = Math.abs(Math.round(c));
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}
export const fmtUsd = (n) => fmtCents(toCents(n));

/** "2026-10-08" → "October 8, 2026". String surgery only. */
export function longDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/**
 * Totals, server-side truth (spec v1.1 §3 step 1): a machine line's per-unit
 * price is `unit` + Σ option units — options are per machine, so they multiply
 * by qty too; subtotal = Σ qty·line_unit. Tax is the rate on that whole
 * subtotal when on (machine + options + freight are all taxable in WI),
 * rounded to the cent.
 */
export const lineUnitCents = (l) => toCents(l && l.unit) + ((l && l.options) || []).reduce((n, o) => n + toCents(o && o.unit), 0);

export function quoteTotals(lines, taxOn, rate = DEFAULT_TAX_RATE) {
  let sub = 0;
  for (const l of lines || []) {
    const qty = Number.isInteger(l && l.qty) ? l.qty : 1;
    sub += qty * lineUnitCents(l);
  }
  const tax = taxOn ? Math.round(sub * rate) : 0;
  return { subtotal: sub / 100, tax: tax / 100, total: (sub + tax) / 100, tax_rate: rate };
}

/** "$5,433" when whole dollars, "$5,433.50" otherwise — the Machinio wording inside a line. */
export function fmtWhole(c) {
  return Math.round(c) % 100 === 0 ? fmtCents(c).replace(/\.00$/, '') : fmtCents(c);
}

/**
 * One block per line, worded the way WSS has quoted on Machinio for five years
 * (spec v1.1 §3 step 3, Machinio-Quote-Example-300160):
 *
 *   Kodiak K12 Walk-Behind Floor Scrubber (20" Disk)          (title, bold)
 *   #K12-20PA (NEW)
 *   ($5,433 MSRP)
 *   Discount applied: −$543                                   (only when > 0)
 *   Options:
 *   K12-010 115ah AGM (2x) / Onboard Charger (+$135)          ((included) at $0)
 *   Subtotal: $5,025                                          (per unit)
 *   Delivery included.                                        (the line note)
 *
 * → [{ kind, title, detail: [{text, tone}], qty, rate (cents, per unit), amount (cents) }]
 * The email, the PDF and the composer's preview all draw from this, so they cannot disagree.
 */
export function lineBlocks(lines) {
  return (lines || []).map((l) => {
    const qty = Number.isInteger(l && l.qty) ? l.qty : 1;
    const each = lineUnitCents(l);
    const detail = [];
    if (l.kind === 'machine') {
      if (l.model) detail.push({ text: `#${l.model} (NEW)`, tone: 'sub' });
      const list = typeof l.list === 'number' ? toCents(l.list) : null;
      const disc = typeof l.discount === 'number' ? toCents(l.discount) : 0;
      if (list != null) detail.push({ text: `(${fmtWhole(list)} MSRP)`, tone: 'plain' });
      if (disc > 0) detail.push({ text: `Discount applied: −${fmtWhole(disc)}`, tone: 'plain' });
      const opts = l.options || [];
      if (opts.length) {
        detail.push({ text: 'Options:', tone: 'plain' });
        for (const o of opts) {
          const c = toCents(o.unit);
          detail.push({ text: `${o.part ? `${o.part} ` : ''}${o.description || ''} (${c === 0 ? 'included' : `+${fmtWhole(c)}`})`, tone: 'opt' });
        }
      }
      detail.push({ text: `Subtotal: ${fmtWhole(each)}`, tone: 'strong' });
    }
    if (l.note) detail.push({ text: String(l.note), tone: 'note' });
    return { kind: l.kind, title: l.description || '', detail, qty, rate: each, amount: qty * each };
  });
}

export const defaultSubject = (number, title) =>
  `Wisconsin Scrub & Sweep — Quote ${number || NUMBER_PLACEHOLDER}${title ? ` · ${title}` : ''}`;

/**
 * The terms block (spec v1.1 §6) — WSS's own footer text from the Machinio quotes, word for word,
 * plus one validity sentence. The sentences are constants here; the address / phone / email come from
 * the catalog's `business` block (the same _Site-Settings.md values the website renders — never hard-coded).
 * → paragraphs, in order.
 */
export function quoteTerms(business = null) {
  const b = business || {};
  const name = b.name || 'Wisconsin Scrub & Sweep';
  const where = [b.street, b.city_line].filter(Boolean).join(', ');
  return [
    'Thank you for your business! We accept credit cards and ACH payments for most transactions. '
      + `For account customers, checks can be mailed to ${name}${where ? `, ${where}` : ''}, within specified billing terms.`,
    'Thank you for the opportunity to provide you with a quote! If you approve of this estimate, please respond directly to this email, '
      + 'and we will process your order.'
      + (b.phone || b.email ? ` If you have any questions, please give us a call${b.phone ? ` at ${b.phone}` : ''}${b.email ? ` or email us: ${b.email}` : ''}` : ''),
    'Prices are valid through the date shown above and do not include sales tax unless shown.',
    `The ${name} Team`,
  ];
}

/** The PDF + email footer line (spec v1.1 §3 step 3). */
export const FOOTER_LINE = 'A Local, Veteran-Owned Company';
/** Where the email banner lives (spec v1.1 §3 step 4): the Tracker's Pages origin. */
export const BANNER_PATH = 'assets/wss-banner-1200.png';

export const taxLabel = (rate) => `Sales tax (${Math.round(rate * 1000) / 10}%)`;
export const TAX_EXEMPT_LINE = 'Tax not included — exempt certificate on file';

/** The signature block (spec v1.1 §6b): name · title (if any) · Wisconsin Scrub & Sweep · phone · email. */
export function signatureLines(sender, business = null) {
  const s = sender || {};
  return [s.name, s.title, (business && business.name) || 'Wisconsin Scrub & Sweep', s.phone, s.mailbox].filter((x) => typeof x === 'string' && x.trim());
}

/* ---- v1.3 (D91) — the listing block -------------------------------------
 * A catalog machine line with `listing !== false` carries the machine's photo,
 * specs and description — the way Machinio's quotes carried the listing. The
 * full record (`specs[]`, `description`) is read by `key` from the catalog: the
 * Worker passes it at send, the composer passes the one GET /api/catalog/<key>
 * returned, so the preview card is the card that sends.
 */
export const LISTING_SPECS_IN_EMAIL = 6;
export const LISTING_LEAD_MAX = 320;
export const LISTING_PDF_NOTE = 'Full specifications and description are on the quote PDF.';
// The image/link must be ours. Machinio's CDN dies the day Machinio stops serving it (spec §2.3 v1.3).
const FOREIGN_HOST = /machineryhost/i;
export const safeListingUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) && !FOREIGN_HOST.test(u) ? u : null);

/**
 * lines + {key → full catalog machine} → one listing per line that gets one, in line order:
 * { key, title, model, image, url, specs: [{k, v}], description }. A record with nothing to show
 * (no url, no specs, no description — a pre-v1.3 catalog) draws nothing, so the output stays the v1.2 one.
 */
export function quoteListings(lines, listings) {
  if (!listings) return [];
  const out = [];
  for (const l of lines || []) {
    if (!l || l.kind !== 'machine' || !l.key || l.listing === false) continue;
    const m = Object.prototype.hasOwnProperty.call(listings, l.key) ? listings[l.key] : null;
    if (!m || typeof m !== 'object') continue;
    const specs = (Array.isArray(m.specs) ? m.specs : [])
      .filter((x) => x && typeof x.k === 'string' && x.k.trim() && x.v != null && String(x.v).trim())
      .map((x) => ({ k: x.k.trim(), v: String(x.v).trim() }));
    const description = typeof m.description === 'string' ? m.description.trim() : '';
    const url = safeListingUrl(m.url);
    if (!url && !specs.length && !description) continue;
    out.push({ key: l.key, title: m.title || l.description || '', model: l.model || m.model || '', image: safeListingUrl(m.image), url, specs, description });
  }
  return out;
}

/** The description's first paragraph: cut at the first blank line or bullet, ≤ 320 chars + "…". */
export function leadParagraph(description, max = LISTING_LEAD_MAX) {
  const lines = [];
  for (const ln of String(description || '').split(/\r?\n/)) {
    if (!ln.trim()) { if (lines.length) break; continue; }
    if (/^\s*[-•*]\s/.test(ln)) break;
    lines.push(ln.trim());
  }
  const p = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (p.length <= max) return p;
  const cut = p.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

function listingCardHtml(c, red) {
  const specs = c.specs.slice(0, LISTING_SPECS_IN_EMAIL);
  const lead = leadParagraph(c.description);
  const photo = c.image
    ? `<td width="180" valign="top" style="padding:0 14px 0 0;width:180px"><img src="${esc(c.image)}" width="180" alt="${esc(c.title)}" style="display:block;width:180px;max-width:180px;height:auto;border:0"></td>`
    : '';
  return `
  <tr><td style="padding:14px 18px 0 18px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e6e6;border-radius:6px"><tr><td style="padding:12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${photo}
        <td valign="top" style="font-size:13px;line-height:1.45;color:#333">
          <div style="font-size:15px;font-weight:bold;color:#1a1a1a">${esc(c.title)}</div>${c.model ? `
          <div style="color:#666;font-size:12px;margin-top:2px">#${esc(c.model)}</div>` : ''}${specs.length ? `
          <div style="margin-top:8px">${specs.map((s) => `<div><span style="color:#666">${esc(s.k)}:</span> ${esc(s.v)}</div>`).join('')}</div>` : ''}${lead ? `
          <p style="margin:8px 0 0 0">${esc(lead)}</p>` : ''}${c.url ? `
          <div style="margin-top:8px"><a href="${esc(c.url)}" style="color:${red};font-weight:bold;text-decoration:none">Full listing →</a></div>` : ''}
        </td>
      </tr></table>
    </td></tr></table>
  </td></tr>`;
}

/** Plain-text note → paragraphs. Blank lines split; single newlines become <br>. */
function noteHtml(note) {
  return String(note || '').trim().split(/\n\s*\n/).filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px 0;line-height:1.5">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * q = { number, date, expires, valid_days, customer, contact, to, subject,
 *       sender: {name, mailbox, phone}, lines, tax, tax_rate, note,
 *       pdf_url, pixel_url, business, listings? }   (listings: v1.3 — {catalog key → full machine})
 * → { html, text }. Table-based, inline styles only, no external CSS or
 * images except the open pixel — which goes LAST and only when given (the
 * preview passes none, so a preview can never fire an "Opened").
 */
export function renderQuoteEmail(q) {
  const rate = typeof q.tax_rate === 'number' ? q.tax_rate : DEFAULT_TAX_RATE;
  const t = quoteTotals(q.lines, !!q.tax, rate);
  const blocks = lineBlocks(q.lines);
  const number = q.number || NUMBER_PLACEHOLDER;
  const sender = q.sender || {};
  const pdf = q.pdf_url || '#';
  const red = '#B71C1C';
  const cell = 'padding:8px 6px;border-bottom:1px solid #e6e6e6;font-size:14px;vertical-align:top';
  const num = `${cell};text-align:right;white-space:nowrap`;

  const toneCss = { sub: 'color:#666;font-size:12px', plain: 'color:#333;font-size:13px', opt: 'color:#333;font-size:13px;padding-left:10px',
    strong: 'color:#1a1a1a;font-size:13px;font-weight:bold', note: 'color:#555;font-size:13px;font-style:italic' };
  const lineHtml = blocks.map((r) => `
      <tr>
        <td style="${cell}"><strong>${esc(r.title)}</strong>${r.detail.map((d) => `<div style="${toneCss[d.tone]};margin-top:2px">${esc(d.text)}</div>`).join('')}</td>
        <td style="${num}">${r.qty}</td>
        <td style="${num}">${fmtCents(r.rate)}</td>
        <td style="${num}">${fmtCents(r.amount)}</td>
      </tr>`).join('');

  // v1.3: listing cards under the line table — only when there are any, so a quote without them is the v1.2 email byte for byte.
  const cards = quoteListings(q.lines, q.listings);
  const cardsHtml = cards.length
    ? `${cards.map((c) => listingCardHtml(c, red)).join('')}
  <tr><td style="padding:10px 18px 0 18px;font-size:12px;color:#666">${esc(LISTING_PDF_NOTE)}</td></tr>`
    : '';

  const totRow = (label, value, strong) => `
      <tr>
        <td colspan="3" style="padding:6px;text-align:right;font-size:14px${strong ? ';font-weight:bold' : ''}">${esc(label)}</td>
        <td style="padding:6px;text-align:right;white-space:nowrap;font-size:14px${strong ? ';font-weight:bold' : ''}">${esc(value)}</td>
      </tr>`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#1a1a1a">
  <tr><td style="padding:0;background:${red}">${q.banner_url
    ? `<img src="${esc(q.banner_url)}" width="600" alt="${esc((q.business && q.business.name) || 'Wisconsin Scrub & Sweep')}" style="display:block;width:100%;max-width:600px;height:auto;border:0;color:#ffffff;font-size:18px;font-weight:bold">`
    : `<div style="color:#ffffff;padding:14px 18px;font-size:18px;font-weight:bold">${esc((q.business && q.business.name) || 'Wisconsin Scrub & Sweep')}</div>`}</td></tr>
  <tr><td style="padding:18px 18px 4px 18px;font-size:13px;color:#555">
    QUOTE <strong style="color:#1a1a1a">${esc(number)}</strong> · ${esc(longDate(q.date))} · valid through ${esc(longDate(q.expires))}
  </td></tr>
  <tr><td style="padding:12px 18px 0 18px;font-size:15px">${noteHtml(q.note)}</td></tr>
  <tr><td style="padding:4px 12px 0 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr>
        <th align="left" style="padding:6px;font-size:12px;color:#666;border-bottom:2px solid ${red}">Description</th>
        <th align="right" style="padding:6px;font-size:12px;color:#666;border-bottom:2px solid ${red}">Qty</th>
        <th align="right" style="padding:6px;font-size:12px;color:#666;border-bottom:2px solid ${red}">Rate</th>
        <th align="right" style="padding:6px;font-size:12px;color:#666;border-bottom:2px solid ${red}">Amount</th>
      </tr>${lineHtml}
      ${totRow('Subtotal', fmtUsd(t.subtotal))}
      ${q.tax ? totRow(taxLabel(rate), fmtUsd(t.tax)) : totRow(TAX_EXEMPT_LINE, '—')}
      ${totRow('Total', fmtUsd(t.total), true)}
    </table>
  </td></tr>${cardsHtml}
  <tr><td align="center" style="padding:22px 18px">
    <a href="${esc(pdf)}" style="display:inline-block;background:${red};color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 22px;border-radius:6px">View / download quote (PDF)</a>
  </td></tr>
  <tr><td style="padding:0 18px 16px 18px;font-size:15px;line-height:1.5">
    ${signatureLines(sender, q.business).map((x, i) => (i === 0 ? `<strong>${esc(x)}</strong>` : x === sender.mailbox ? `<a href="mailto:${esc(x)}" style="color:${red}">${esc(x)}</a>` : esc(x))).join('<br>')}
  </td></tr>
  <tr><td style="padding:12px 18px 6px 18px;font-size:11px;line-height:1.5;color:#777;border-top:1px solid #e6e6e6">${quoteTerms(q.business).map((p) => `<p style="margin:0 0 8px 0">${esc(p)}</p>`).join('')}</td></tr>
  <tr><td align="center" style="padding:4px 18px 18px 18px;font-size:12px;color:#555">${esc(FOOTER_LINE)}</td></tr>
</table>
</td></tr></table>
${q.pixel_url ? `<img src="${esc(q.pixel_url)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ''}
</body></html>`;

  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const textLines = blocks.map((r) => [r.title, ...r.detail.map((d) => `  ${d.text}`), `  ${r.qty} x ${fmtCents(r.rate)} = ${fmtCents(r.amount)}`].join('\n'));
  const text = [
    `QUOTE ${number} · ${longDate(q.date)} · valid through ${longDate(q.expires)}`,
    '',
    String(q.note || '').trim(),
    '',
    ...textLines,
    '',
    `${pad('Subtotal:', 12)} ${fmtUsd(t.subtotal)}`,
    q.tax ? `${pad('Tax:', 12)} ${fmtUsd(t.tax)} (${Math.round(rate * 1000) / 10}%)` : TAX_EXEMPT_LINE,
    `${pad('Total:', 12)} ${fmtUsd(t.total)}`,
    '',
    ...cards.flatMap((c) => [c.title, ...(c.model ? [`#${c.model}`] : []), ...c.specs.slice(0, LISTING_SPECS_IN_EMAIL).map((x) => `  ${x.k}: ${x.v}`), ...(c.url ? [c.url] : []), '']),
    ...(cards.length ? [LISTING_PDF_NOTE, ''] : []),
    `View / download the quote (PDF): ${pdf}`,
    '',
    signatureLines(sender, q.business).join('\n'),
    '',
    ...quoteTerms(q.business).flatMap((p) => [p, '']),
    FOOTER_LINE,
  ].join('\n');

  return { html, text, totals: t };
}
