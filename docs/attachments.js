/* Document attachments — `docs[]` on a ticket, a lead or an agreement (schema 6).
 *
 * Shared by tickets and leads because the row shape is identical:
 *   { id, name, kind, bytes, added }
 * Pure — no DOM, no network — so tools/selftest-attachments.mjs can assert it.
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
