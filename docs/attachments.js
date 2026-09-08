/* Document attachments — `docs[]` on a ticket, a lead or an agreement (schema 6).
 *
 * Shared by tickets and leads because the row shape is identical:
 *   { id, name, kind, bytes, added }
 * Pure — no DOM, no network — so tools/selftest-attachments.mjs can assert it.
 *
 * S2 adds the UPLOAD half — but only its pure parts: which kind a choice
 * resolves to, what the file gets called, and how a pending attach becomes a
 * row. The canvas resize and the fetches live in app.js and api.js, because
 * they need a DOM and a network and this file has neither.
 *
 * What this file is NOT: a viewer, a Documents tab, a search, a thumbnail.
 * A doc row is a link to the OS viewer and nothing else (S1 read path).
 *
 * THREE THINGS TO KEEP STRAIGHT:
 *
 * 1. The id IS the document. It is the first 16 hex chars of sha256(bytes), so
 *    it is the only part of a row we hand to a URL — and a row whose id does
 *    not match that shape is dropped rather than linked, because there is no
 *    such document and the tap could only ever 404.
 *
 * 2. Order is the engine's. Same rule as the notes timeline: we never re-sort.
 *
 * 3. `added` is a date-only Central business date. Nothing here parses it and
 *    nothing here renders it — the row shows the size, not the date. If it ever
 *    is rendered, it is rendered verbatim (CLAUDE.md, rule 7).
 */

/** Sixteen lowercase hex. Never loosen this — it is what goes into the URL. */
export const DOC_ID_RE = /^[0-9a-f]{16}$/;

// 📝 is "somebody wrote this to be worked from", 📄 is "a document", 🖼 a photo.
// Anything the enum grows later falls back to 📄, which is never wrong.
const KIND_ICON = {
  QUOTE: '📄', PO: '📄', 'PM-REPORT': '📄', 'SERVICE-TICKET': '📄', OTHER: '📄',
  WORKORDER: '📝', 'PARTS-LIST': '📝',
  PHOTO: '🖼',
};

// Title-case with the hyphen kept ("PARTS-LIST" -> "Parts-List"), except for
// the parts that are initialisms: PM is preventive maintenance and PO is a
// purchase order, and "Pm-Report" / "Po" would read as typos on the shop floor.
const INITIALISMS = new Set(['PM', 'PO']);

export const docIcon = (kind) => KIND_ICON[kind] || '📄';

export function kindLabel(kind) {
  const raw = typeof kind === 'string' && kind.trim() ? kind.trim() : 'OTHER';
  return raw.split('-').map((part) => {
    const up = part.toUpperCase();
    if (INITIALISMS.has(up)) return up;
    return up.charAt(0) + up.slice(1).toLowerCase();
  }).join('-');
}

/**
 * A byte count a person can read at a glance. Decimal units, because that is
 * what the file's own "Get Info" says on the phone that will open it: 25602
 * bytes is "26 KB", not "25 KB". One decimal below 10, none above — "1.4 MB"
 * is worth knowing before you tap it on LTE, "1 MB" isn't.
 */
export function humanBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} B`;
  const [unit, div] = n < 1e6 ? ['KB', 1e3] : ['MB', 1e6];
  const v = n / div;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unit}`;
}

/**
 * The document rows of a ticket, a lead or an agreement, ready to render.
 *
 * Missing `docs` is `[]` — a schema-5 snapshot still on KV has no `docs` key
 * anywhere and must render exactly as it did before (forward/backward
 * compatibility, CLAUDE.md snapshot contract).
 *
 * -> [{ id, name, kind, label, icon, bytes, size }]
 */
export function docRows(entity) {
  const raw = entity && Array.isArray(entity.docs) ? entity.docs : [];
  const out = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    if (!DOC_ID_RE.test(id)) continue;              // no id, no document
    const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'document';
    const kind = typeof d.kind === 'string' && d.kind.trim() ? d.kind.trim() : 'OTHER';
    const bytes = typeof d.bytes === 'number' && isFinite(d.bytes) && d.bytes >= 0 ? d.bytes : null;
    out.push({ id, name, kind, label: kindLabel(kind), icon: docIcon(kind), bytes, size: humanBytes(bytes) });
  }
  return out;
}

export const hasDocs = (entity) => docRows(entity).length > 0;

/**
 * Where a doc opens. `?t=` and not a Bearer header, deliberately: this URL is
 * handed to `window.open`, and a new tab cannot carry a header. Returns null
 * when there is nothing to open against (no Worker wired, or no token), so the
 * caller can say so instead of opening a broken tab.
 */
export function docUrl(apiBase, id, token) {
  if (!apiBase || !token || !DOC_ID_RE.test(String(id || ''))) return null;
  return `${String(apiBase).replace(/\/+$/, '')}/api/doc/${id}?t=${encodeURIComponent(token)}`;
}


/* ===================================================== upload (S2) ======== */

/** A ticket ("S1018") or a lead ("L1005") — what a doc can be attached to. */
export const DOC_RECORD_RE = /^[SL]\d{4}$/;

/**
 * The three buttons on the kind sheet, in order. PHOTO is deliberately NOT a
 * button: nobody taps "photo" when they have just taken one, and the app can
 * tell. It is resolved from the file itself — see resolveKind.
 */
export const KIND_CHOICES = [
  { kind: 'WORKORDER', label: 'Work order' },
  { kind: 'PARTS-LIST', label: 'Parts list' },
  { kind: 'OTHER', label: 'Other' },
];

/** What a phone is allowed to mint. QUOTE / PO / PM-REPORT / SERVICE-TICKET are the vault's. */
export const CREW_KINDS = new Set(['WORKORDER', 'PARTS-LIST', 'PHOTO', 'OTHER']);

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
export const isImageMime = (mime) => IMAGE_MIMES.has(String(mime || '').split(';')[0].trim().toLowerCase());

/**
 * What the tech's tap actually means.
 *
 * "Work order" and "Parts list" mean themselves. "Other" is the interesting
 * one: an image filed as OTHER would draw the 📄 icon on a row that is plainly
 * a photograph, so an image + "Other" resolves to PHOTO and a PDF + "Other"
 * stays OTHER. A camera capture is always an image, so the work order's rule
 * ("📷 + Other -> PHOTO") falls out of this without a source check — and a
 * photo picked out of the Files app instead of shot on the spot gets the same
 * honest icon, which the source check alone would have missed.
 */
export function resolveKind(choice, mime) {
  const c = String(choice || '').toUpperCase();
  if (!CREW_KINDS.has(c)) return 'OTHER';
  if (c === 'OTHER' && isImageMime(mime)) return 'PHOTO';
  return c;
}

/**
 * A filename the Worker will accept and a person can read.
 *
 * No path separators, no quotes, nothing outside printable ASCII (it travels in
 * an `X-Doc-Name` header, and a header value that is not Latin-1 makes fetch()
 * throw before the request leaves), and never longer than the Worker's 120.
 */
export function sanitizeName(name, fallback = 'document') {
  const t = String(name == null ? '' : name)
    .replace(/[\\/]+/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[^\u0020-\u007E]/g, '_')
    .replace(/["]/g, "'")
    .trim();
  return (t || fallback).slice(0, 120);
}

/** Swap the extension when the bytes changed type — a PNG resized to JPEG is not a .png. */
export function retypeName(name, mime) {
  if (!isImageMime(mime)) return name;
  const ext = mime === 'image/png' ? '.png' : '.jpg';
  return `${String(name).replace(/\.[A-Za-z0-9]{1,8}$/, '')}${ext}`;
}

/**
 * `WO-S1018-20260908-1432.jpg` for a camera capture.
 *
 * The camera hands us "image.jpg" — the same four useless characters for every
 * photo every tech takes — so we name it ourselves, after the record it is
 * being attached to and the minute it was taken.
 *
 * The stamp is LOCAL time, deliberately, and this is not the UTC rule (CLAUDE.md
 * rule 7) being broken: that rule governs timestamps in the data, and this is a
 * label a person in Ixonia reads. A photo shot at 2pm named "…-1900" would look
 * wrong to the only people who will ever see the name.
 */
export function cameraName(record, mime, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return retypeName(`WO-${record}-${stamp}`, mime);
}

/**
 * The pending `doc_attach` events sitting against one record.
 *
 * They are proposals like every other pending write: the bytes ARE in the
 * Worker's store (the upload happened first, or there would be no event), but
 * the engine has not filed them into the vault, so they are not in `docs[]`
 * yet and must never render as if they were.
 *
 * Order is submission order — oldest first, newest last — which is how
 * `pending` arrives and how the app appends to it. Same rule as the notes
 * timeline: the thing you just did belongs at the end, where your eye is.
 *
 * -> [{ id, docId, name, kind, label, icon, who }]
 */
export function pendingDocRows(events, recordId) {
  const out = [];
  if (!recordId) return out;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.action !== 'doc_attach') continue;
    const p = e.payload || {};
    if (p.record !== recordId) continue;
    const docId = typeof p.doc_id === 'string' ? p.doc_id.trim() : '';
    if (!DOC_ID_RE.test(docId)) continue;
    const kind = typeof p.kind === 'string' && p.kind.trim() ? p.kind.trim() : 'OTHER';
    out.push({
      id: e.id || null,
      docId,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'document',
      kind,
      label: kindLabel(kind),
      icon: docIcon(kind),
      who: typeof e.actor === 'string' && e.actor.trim() ? e.actor.trim() : null,
    });
  }
  return out;
}
