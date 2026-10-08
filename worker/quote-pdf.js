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
import { lineBlocks, signatureLines, quoteTotals, fmtCents, fmtUsd, longDate, quoteTerms, taxLabel, TAX_EXEMPT_LINE, DEFAULT_TAX_RATE, DEFAULT_VALID_DAYS } from '../docs/quote-email.js';
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

/**
 * q = { number, date, expires, valid_days, customer, contact, to, sender:{name, mailbox, phone},
 *       lines, tax, tax_rate, business }  →  Uint8Array (the PDF bytes)
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
  const title = `WSS Quote ${q.number}`;
  doc.setTitle(title);
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
  const rule = (yy, color = RULE, thick = 0.75) => page.drawLine({ start: { x: M, y: yy }, end: { x: M + W, y: yy }, thickness: thick, color });

  // Columns: item | qty | unit | amount (right edges for the numbers).
  const X_QTY = M + W - 190;
  const X_UNIT = M + W - 95;
  const X_AMT = M + W;
  const ITEM_W = X_QTY - 40 - M;

  const tableHead = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W, height: 18, color: RED });
    text('Description', M + 6, y + 1, 9, bold, rgb(1, 1, 1));
    right('Qty', X_QTY, y + 1, 9, bold, rgb(1, 1, 1));
    right('Rate', X_UNIT, y + 1, 9, bold, rgb(1, 1, 1));
    right('Amount', X_AMT - 6, y + 1, 9, bold, rgb(1, 1, 1));
    y -= 22;
  };
  const newPage = (first) => {
    page = doc.addPage(PAGE);
    y = PAGE[1] - M;
    if (!first) {
      text(`QUOTE ${q.number} (continued)`, M, y - 10, 10, bold, GREY);
      y -= 30;
      tableHead();
    }
  };
  const ensure = (h) => { if (y - h < M + 24) newPage(false); };

  newPage(true);
  // ---- header: the mark left, the quote's identity right.
  const lh = 58;
  const lw = (logo.width / logo.height) * lh;
  page.drawImage(logo, { x: M, y: y - lh, width: lw, height: lh });
  right('QUOTE', M + W, y - 18, 22, bold, RED);
  right(q.number, M + W, y - 36, 13, bold);
  right(`Date: ${longDate(q.date)}`, M + W, y - 51, 9.5, font, GREY);
  right(`Valid through: ${longDate(q.expires)}`, M + W, y - 63, 9.5, font, GREY);
  y -= lh + 22;
  rule(y, RED, 1.5);
  y -= 18;

  // ---- To / From.
  const col = (label, rows, x) => {
    let yy = y;
    text(label, x, yy, 8.5, bold, GREY);
    yy -= 13;
    for (const [s, f] of rows) {
      if (!s) continue;
      for (const ln of wrap(s, f, 10, W / 2 - 16)) { text(ln, x, yy, 10, f); yy -= 13; }
    }
    return yy;
  };
  const yTo = col('PREPARED FOR', [[q.customer, bold], [q.contact, font], [q.to, font]], M);
  const yFrom = col('QUOTED BY', [[sender.name, bold], [sender.title, font], [biz.name, font], [sender.phone, font], [sender.mailbox, font],
    [biz.street, font], [biz.city_line, font]], M + W / 2 + 8);
  y = Math.min(yTo, yFrom) - 12;

  // ---- the lines.
  tableHead();
  const TONE = { sub: [font, 8.5, GREY, 0], plain: [font, 9.5, rgb(0.2, 0.2, 0.2), 0], opt: [font, 9.5, rgb(0.2, 0.2, 0.2), 10],
    strong: [bold, 9.5, INK, 0], note: [font, 9, GREY, 0] };
  for (const r of lineBlocks(q.lines)) {
    // The title in bold, then the Machinio-worded detail lines (MSRP, discount, options, per-unit subtotal, note).
    const rows = wrap(r.title, bold, 10, ITEM_W).map((t) => ({ t, f: bold, size: 10, color: INK, indent: 0, lh: 12.5 }));
    for (const d of r.detail) {
      const [f, size, color, indent] = TONE[d.tone];
      for (const t of wrap(d.text, f, size, ITEM_W - indent)) rows.push({ t, f, size, color, indent, lh: 11.5 });
    }
    const h = rows.reduce((n, x) => n + x.lh, 0) + 8;
    ensure(h);
    const top = y;
    let yy = top;
    for (const x of rows) { text(x.t, M + 6 + x.indent, yy, x.size, x.f, x.color); yy -= x.lh; }
    right(String(r.qty), X_QTY, top, 10);
    right(fmtCents(r.rate), X_UNIT, top, 10);
    right(fmtCents(r.amount), X_AMT - 6, top, 10);
    y -= h;
    rule(y + 10);           // between rows: under this one's descenders, over the next one's caps
  }

  // ---- totals.
  ensure(70);
  y -= 8;
  const tot = (label, value, strong) => {
    right(label, X_UNIT, y, strong ? 11 : 10, strong ? bold : font);
    right(value, X_AMT - 6, y, strong ? 11 : 10, strong ? bold : font);
    y -= strong ? 18 : 15;
  };
  tot('Subtotal', fmtUsd(totals.subtotal));
  if (q.tax) tot(taxLabel(rate), fmtUsd(totals.tax));
  else tot(TAX_EXEMPT_LINE, '—');
  page.drawLine({ start: { x: X_QTY, y: y + 12 }, end: { x: X_AMT, y: y + 12 }, thickness: 1, color: INK });
  tot('Total', fmtUsd(totals.total), true);

  // ---- signature + terms.
  const terms = wrap(quoteTerms(q.valid_days || DEFAULT_VALID_DAYS, biz), font, 8, W);
  ensure(60 + terms.length * 10);
  y -= 16;
  text('Thank you for the opportunity.', M, y, 10);
  y -= 26;
  page.drawLine({ start: { x: M, y: y + 10 }, end: { x: M + 200, y: y + 10 }, thickness: 0.75, color: INK });
  text(signatureLines(sender, biz).join('  ·  '), M, y - 2, 9.5);
  y -= 26;
  rule(y + 8);
  for (const ln of terms) { text(ln, M, y - 2, 8, font, GREY); y -= 10; }

  // Page x of n, once we know n.
  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const s = `${q.number} · page ${i + 1} of ${pages.length}`;
      p.drawText(s, { x: PAGE[0] - M - font.widthOfTextAtSize(s, 8), y: M - 20, size: 8, font, color: GREY });
    });
  }
  return doc.save();
}
