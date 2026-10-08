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
 * Totals, server-side truth (spec §3 step 1): subtotal = Σ qty·unit + Σ option
 * units (an option rides once on its machine line, not per qty); tax is the
 * rate on that whole subtotal when on (machine + options + freight are all
 * taxable in WI), rounded to the cent.
 */
export function quoteTotals(lines, taxOn, rate = DEFAULT_TAX_RATE) {
  let sub = 0;
  for (const l of lines || []) {
    const qty = Number.isInteger(l && l.qty) ? l.qty : 1;
    sub += qty * toCents(l && l.unit);
    for (const o of (l && l.options) || []) sub += toCents(o && o.unit);
  }
  const tax = taxOn ? Math.round(sub * rate) : 0;
  return { subtotal: sub / 100, tax: tax / 100, total: (sub + tax) / 100, tax_rate: rate };
}

/**
 * The display rows, in order: each machine line with its options indented
 * beneath it, then text and freight lines. A $0 option reads "N/C" — it's
 * included, not free-floating.
 */
export function lineRows(lines) {
  const out = [];
  for (const l of lines || []) {
    const qty = Number.isInteger(l && l.qty) ? l.qty : 1;
    const unitC = toCents(l.unit);
    out.push({
      level: 0, kind: l.kind, description: l.description || '', model: l.kind === 'machine' ? (l.model || '') : '',
      qty, unit: unitC, amount: qty * unitC,
    });
    for (const o of l.options || []) {
      const c = toCents(o.unit);
      out.push({ level: 1, kind: 'option', description: o.description || '', part: o.part || '', qty: 1, unit: c, amount: c, nc: c === 0 });
    }
  }
  return out;
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
  const rows = lineRows(q.lines);
  const number = q.number || NUMBER_PLACEHOLDER;
  const sender = q.sender || {};
  const pdf = q.pdf_url || '#';
  const red = '#B71C1C';
  const cell = 'padding:8px 6px;border-bottom:1px solid #e6e6e6;font-size:14px;vertical-align:top';
  const num = `${cell};text-align:right;white-space:nowrap`;

  const lineHtml = rows.map((r) => (r.level === 0 ? `
      <tr>
        <td style="${cell}"><strong>${esc(r.description)}</strong>${r.model ? `<br><span style="color:#666;font-size:12px">Model ${esc(r.model)}</span>` : ''}</td>
        <td style="${num}">${r.qty}</td>
        <td style="${num}">${fmtCents(r.unit)}</td>
        <td style="${num}">${fmtCents(r.amount)}</td>
      </tr>` : `
      <tr>
        <td style="${cell};padding-left:22px;color:#333">${esc(r.description)}${r.part ? ` <span style="color:#888;font-size:12px">(${esc(r.part)})</span>` : ''}</td>
        <td style="${num}"></td>
        <td style="${num}"></td>
        <td style="${num}">${r.nc ? 'N/C' : fmtCents(r.amount)}</td>
      </tr>`)).join('');

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
        <th align="left" style="padding:6px;font-size:12px;color:#666;border-bottom:2px solid ${red}">Item</th>
        <th align="right" style="padding:6px;font-size:12px;color:#666;border-bottom:2px solid ${red}">Qty</th>
        <th align="right" style="padding:6px;font-size:12px;color:#666;border-bottom:2px solid ${red}">Unit</th>
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
    ${esc(sender.name || '')}<br>
    ${sender.phone ? `${esc(sender.phone)}<br>` : ''}${sender.mailbox ? `<a href="mailto:${esc(sender.mailbox)}" style="color:${red}">${esc(sender.mailbox)}</a>` : ''}
  </td></tr>
  <tr><td style="padding:12px 18px 18px 18px;font-size:11px;line-height:1.5;color:#777;border-top:1px solid #e6e6e6">${esc(quoteTerms(q.valid_days || DEFAULT_VALID_DAYS, q.business))}</td></tr>
</table>
</td></tr></table>
${q.pixel_url ? `<img src="${esc(q.pixel_url)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ''}
</body></html>`;

  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const textLines = rows.map((r) => (r.level === 0
    ? `${r.description}${r.model ? ` (Model ${r.model})` : ''}\n  ${r.qty} x ${fmtCents(r.unit)} = ${fmtCents(r.amount)}`
    : `  + ${r.description}${r.part ? ` (${r.part})` : ''}: ${r.nc ? 'N/C' : fmtCents(r.amount)}`));
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
    [sender.name, sender.phone, sender.mailbox].filter(Boolean).join('\n'),
    '',
    quoteTerms(q.valid_days || DEFAULT_VALID_DAYS, q.business),
  ].join('\n');

  return { html, text, totals: t };
}
