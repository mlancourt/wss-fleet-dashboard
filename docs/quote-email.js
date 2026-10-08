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

/** The terms block, verbatim (spec §6); the contact tail comes from the catalog's `business` block. */
export function quoteTerms(validDays = DEFAULT_VALID_DAYS, business = null) {
  const b = business || {};
  const tail = [b.name || 'Wisconsin Scrub & Sweep', [b.city, b.region].filter(Boolean).join(', ') || 'Ixonia, WI', b.phone, b.email]
    .filter(Boolean).join(' · ');
  return `Prices are valid for ${validDays} days from the quote date and do not include applicable sales tax unless shown. `
    + 'Freight is FOB Ixonia, WI unless quoted. This quote is confidential and intended for the addressee. '
    + tail;
}

export const taxLabel = (rate) => `Sales tax (${Math.round(rate * 1000) / 10}%)`;
export const TAX_EXEMPT_LINE = 'Tax not included — exempt certificate on file';

/** The signature block (spec v1.1 §6b): name · title (if any) · Wisconsin Scrub & Sweep · phone · email. */
export function signatureLines(sender, business = null) {
  const s = sender || {};
  return [s.name, s.title, (business && business.name) || 'Wisconsin Scrub & Sweep', s.phone, s.mailbox].filter((x) => typeof x === 'string' && x.trim());
}

/** Plain-text note → paragraphs. Blank lines split; single newlines become <br>. */
function noteHtml(note) {
  return String(note || '').trim().split(/\n\s*\n/).filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px 0;line-height:1.5">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * q = { number, date, expires, valid_days, customer, contact, to, subject,
 *       sender: {name, mailbox, phone}, lines, tax, tax_rate, note,
 *       pdf_url, pixel_url, business }
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

  const totRow = (label, value, strong) => `
      <tr>
        <td colspan="3" style="padding:6px;text-align:right;font-size:14px${strong ? ';font-weight:bold' : ''}">${esc(label)}</td>
        <td style="padding:6px;text-align:right;white-space:nowrap;font-size:14px${strong ? ';font-weight:bold' : ''}">${esc(value)}</td>
      </tr>`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#1a1a1a">
  <tr><td style="background:${red};color:#ffffff;padding:14px 18px;font-size:18px;font-weight:bold">${esc((q.business && q.business.name) || 'Wisconsin Scrub & Sweep')}</td></tr>
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
  </td></tr>
  <tr><td align="center" style="padding:22px 18px">
    <a href="${esc(pdf)}" style="display:inline-block;background:${red};color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 22px;border-radius:6px">View / download quote (PDF)</a>
  </td></tr>
  <tr><td style="padding:0 18px 16px 18px;font-size:15px;line-height:1.5">
    ${signatureLines(sender, q.business).map((x, i) => (i === 0 ? `<strong>${esc(x)}</strong>` : x === sender.mailbox ? `<a href="mailto:${esc(x)}" style="color:${red}">${esc(x)}</a>` : esc(x))).join('<br>')}
  </td></tr>
  <tr><td style="padding:12px 18px 18px 18px;font-size:11px;line-height:1.5;color:#777;border-top:1px solid #e6e6e6">${esc(quoteTerms(q.valid_days || DEFAULT_VALID_DAYS, q.business))}</td></tr>
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
    `View / download the quote (PDF): ${pdf}`,
    '',
    signatureLines(sender, q.business).join('\n'),
    '',
    quoteTerms(q.valid_days || DEFAULT_VALID_DAYS, q.business),
  ].join('\n');

  return { html, text, totals: t };
}
