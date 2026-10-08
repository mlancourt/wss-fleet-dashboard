/**
 * D83 — the quote PDF, rendered in the Worker with pdf-lib (pure JS: no
 * browser rendering, no paid add-on). Letter, one page typical, more when the
 * line list runs long. The numbers come from docs/quote-email.js — the same
 * lineBlocks / quoteTotals the email uses, so the PDF and the email agree to the
 * cent by construction (acceptance B).
 *
 * Standard Helvetica only (WinAnsi): anything outside that set — an emoji a
 * phone keyboard slipped into a description — becomes "?" rather than
 * throwing mid-send.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { lineBlocks, quoteTotals, fmtCents, fmtUsd, quoteTerms, TAX_EXEMPT_LINE, DEFAULT_TAX_RATE, FOOTER_LINE } from '../docs/quote-email.js';
import { LOGO_JPEG_B64 } from './quote-logo.js';

const RED = rgb(0xB7 / 255, 0x1C / 255, 0x1C / 255);
const INK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.85, 0.85, 0.85);
const PAGE = [612, 792];             // US Letter, points
const M = 48;                        // margin

const WIN_EXTRA = new Set(Array.from('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'));
// U+2212 (the "Discount applied: −$543" minus) isn't in WinAnsi; an en dash reads the same on paper.
export const winAnsi = (s) => Array.from(String(s == null ? '' : s).replace(/\u2212/g, '\u2013')).map((ch) => {
  const c = ch.codePointAt(0);
  if (ch === '\t') return ' ';
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_EXTRA.has(ch) ? ch : '?';
}).join('');

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Greedy word wrap to `width` points; a word longer than the line is cut. */
function wrap(text, font, size, width) {
  const out = [];
  for (const para of winAnsi(text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width) { out.push(line); line = w; } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** "2026-10-08" → "10/08/2026" — the Machinio quotes' header date. String surgery. */
const numDate = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(ymd || '');
};
const TINT = rgb(0xF6 / 255, 0xD9 / 255, 0xD9 / 255);   // the red-tinted header band

/**
 * q = { number, date, expires, valid_days, customer, contact, to, sender:{name, title, mailbox, phone},
 *       lines, tax, tax_rate, business }  →  Uint8Array (the PDF bytes)
 *
 * Laid out like the Machinio quotes WSS has sent for five years (spec v1.1 §3 step 3,
 * Reference/Machinio-Quote-Example-300160.pdf): company block top-left, the mark top-right,
 * a red "Quote", QUOTE # / DATE / VALID THROUGH, ADDRESS + QUOTED BY, the tinted
 * DESCRIPTION · QTY · RATE · AMOUNT band, the lines, terms bottom-left beside the totals,
 * Accepted By / Accepted Date, and the veteran-owned footer.
 */
export async function renderQuotePdf(q) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedJpg(b64ToBytes(LOGO_JPEG_B64));
  const biz = q.business || {};
  const sender = q.sender || {};
  const rate = typeof q.tax_rate === 'number' ? q.tax_rate : DEFAULT_TAX_RATE;
  const totals = quoteTotals(q.lines, !!q.tax, rate);
  doc.setTitle(`WSS Quote ${q.number}`);
  doc.setAuthor(winAnsi(biz.name || 'Wisconsin Scrub & Sweep'));
  doc.setSubject(winAnsi(`Quote ${q.number} for ${q.customer || ''}`));
  doc.setCreator('WSS Fleet');
  doc.setProducer('WSS Fleet (pdf-lib)');

  let page;
  let y;
  const W = PAGE[0] - 2 * M;
  const text = (s, x, yy, size = 10, f = font, color = INK) => page.drawText(winAnsi(s), { x, y: yy, size, font: f, color });
  const right = (s, xr, yy, size = 10, f = font, color = INK) => {
    const t = winAnsi(s);
    page.drawText(t, { x: xr - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color });
  };
  const center = (s, yy, size = 10, f = font, color = INK) => {
    const t = winAnsi(s);
    page.drawText(t, { x: (PAGE[0] - f.widthOfTextAtSize(t, size)) / 2, y: yy, size, font: f, color });
  };
  const dotted = (yy) => page.drawLine({ start: { x: M, y: yy }, end: { x: M + W, y: yy }, thickness: 0.6, color: RULE, dashArray: [1.5, 2] });

  // Columns: description | qty | rate | amount (right edges for the numbers).
  const X_QTY = M + W - 190;
  const X_UNIT = M + W - 95;
  const X_AMT = M + W;
  const ITEM_W = X_QTY - 40 - M;

  const tableHead = () => {
    page.drawRectangle({ x: M - 6, y: y - 5, width: W + 12, height: 18, color: TINT });
    text('DESCRIPTION', M, y + 1, 8.5, font, RED);
    right('QTY', X_QTY, y + 1, 8.5, font, RED);
    right('RATE', X_UNIT, y + 1, 8.5, font, RED);
    right('AMOUNT', X_AMT, y + 1, 8.5, font, RED);
    y -= 24;
  };
  const FOOT = M + 4;                          // the footer line's baseline
  const newPage = (first) => {
    page = doc.addPage(PAGE);
    center(FOOTER_LINE, FOOT, 9.5);
    y = PAGE[1] - M;
    if (!first) {
      text(`QUOTE # ${q.number} (continued)`, M, y - 10, 10, bold, GREY);
      y -= 30;
      tableHead();
    }
  };
  const ensure = (h) => { if (y - h < FOOT + 30) newPage(false); };

  newPage(true);

  // ---- top: company block left, the mark right.
  const company = [[biz.name || 'Wisconsin Scrub & Sweep', bold], [biz.street, font], [biz.city_line, font],
    [biz.phone, font], [biz.email, font], [biz.url, font]].filter(([s]) => s);
  let yy = y - 8;
  for (const [s, f] of company) { text(s, M, yy, f === bold ? 9.5 : 9, f); yy -= 12.5; }
  const lh = 34;
  const lw = (logo.width / logo.height) * lh;
  page.drawImage(logo, { x: M + W - lw, y: y - lh - 2, width: lw, height: lh });

  // ---- "Quote" + QUOTE # / DATE / VALID THROUGH.
  y = yy - 22;
  text('Quote', M, y, 26, font, RED);
  const meta = [['QUOTE #', q.number], ['DATE', numDate(q.date)], ['VALID THROUGH', numDate(q.expires)]];
  let my = y + 22;
  for (const [k, v] of meta) {
    right(k, M + W - 82, my, 9, bold);
    text(v, M + W - 76, my, 9);
    my -= 12.5;
  }
  y = Math.min(y, my) - 22;

  // ---- ADDRESS + QUOTED BY.
  const col = (label, rows, x) => {
    let cy = y;
    text(label, x, cy, 9, bold);
    cy -= 13;
    for (const s of rows) {
      if (!s) continue;
      for (const ln of wrap(s, font, 9.5, W / 2 - 40)) { text(ln, x, cy, 9.5); cy -= 12.5; }
    }
    return cy;
  };
  const yA = col('ADDRESS', [q.customer, q.contact, q.street, q.to], M + 30);
  const yB = col('QUOTED BY', [sender.name, sender.title, sender.phone, sender.mailbox], M + W / 2 + 10);
  y = Math.min(yA, yB) - 14;
  dotted(y);
  y -= 26;

  // ---- the lines.
  tableHead();
  const TONE = { sub: [font, 9.5, INK, 0], plain: [font, 9.5, INK, 0], opt: [font, 9.5, INK, 0],
    strong: [font, 9.5, INK, 0], note: [font, 9.5, INK, 0] };
  for (const r of lineBlocks(q.lines)) {
    // The title in bold, then the Machinio-worded detail lines (MSRP, discount, options, per-unit subtotal, note).
    const rows = wrap(r.title, bold, 10, ITEM_W).map((t) => ({ t, f: bold, size: 10, color: INK, indent: 0, lh: 12.5, gap: 0 }));
    for (const d of r.detail) {
      const [f, size, color, indent] = TONE[d.tone];
      // Machinio's rhythm (300160): a blank line before the discount, the Options block and the per-unit subtotal.
      const gap = /^(Discount applied|Options:|Subtotal:)/.test(d.text) ? 8 : 0;
      wrap(d.text, f, size, ITEM_W - indent).forEach((t, i) => rows.push({ t, f, size, color, indent, lh: 11.5, gap: i ? 0 : gap }));
    }
    const h = rows.reduce((n, x) => n + x.lh + x.gap, 0) + 10;
    ensure(h);
    const top = y;
    let ry = top;
    for (const x of rows) { ry -= x.gap; text(x.t, M + x.indent, ry, x.size, x.f, x.color); ry -= x.lh; }
    right(String(r.qty), X_QTY, top, 10);
    right(fmtCents(r.rate).replace('$', ''), X_UNIT, top, 10);
    right(fmtCents(r.amount).replace('$', ''), X_AMT, top, 10);
    y -= h;
  }

  // ---- terms bottom-left, totals right (the Machinio footer block).
  const TERMS_W = W / 2 + 20;
  const terms = quoteTerms(biz).flatMap((p, i, all) => [...wrap(p, font, 7.5, TERMS_W), ...(i === all.length - 2 ? [''] : [])]);
  const block = Math.max(terms.length * 9.5, 60);
  ensure(block + 70);
  dotted(y + 4);
  y -= 14;
  const top = y;
  for (const ln of terms) { if (ln) text(ln, M, y, 7.5); y -= 9.5; }
  let ty = top;
  const TX = M + TERMS_W + 30;
  const tot = (label, value) => { text(label, TX, ty, 10); right(value, X_AMT, ty, 10); ty -= 13; };
  tot('SUBTOTAL', fmtCents(toC(totals.subtotal)).replace('$', ''));
  if (q.tax) tot('TAX', fmtCents(toC(totals.tax)).replace('$', ''));
  else { text(TAX_EXEMPT_LINE, TX, ty, 7.5, font, GREY); ty -= 13; }
  text('TOTAL', TX, ty, 10);
  right(fmtUsd(totals.total), X_AMT, ty - 4, 16, bold);
  y = Math.min(y, ty - 20) - 30;

  // ---- Accepted By / Accepted Date (customers sign these and send them back as a PO).
  ensure(40);
  text('Accepted By', M, y, 10);
  page.drawLine({ start: { x: M + 62, y: y - 2 }, end: { x: M + W / 2 - 20, y: y - 2 }, thickness: 0.6, color: GREY });
  text('Accepted Date', M + W / 2 + 10, y, 10);
  page.drawLine({ start: { x: M + W / 2 + 82, y: y - 2 }, end: { x: M + W, y: y - 2 }, thickness: 0.6, color: GREY });

  // Page x of n, once we know n.
  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const s = `${q.number} · page ${i + 1} of ${pages.length}`;
      p.drawText(s, { x: PAGE[0] - M - font.widthOfTextAtSize(s, 8), y: FOOT, size: 8, font, color: GREY });
    });
  }
  return doc.save();
}

const toC = (n) => Math.round(n * 100);
