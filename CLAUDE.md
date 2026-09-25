
# WSS Fleet Dashboard — CLAUDE.md

You are building the employee-facing operations website for **Wisconsin Scrub & Sweep (WSS)** — an industrial floor-scrubber dealer in Ixonia, WI. Four users: **Matt** (owner), **Kevin** (sales), **Josh + Zac** (service techs). It shows the rental fleet, active rental agreements, the service queue (customer-owned repairs **and** fleet repairs), and a Dispatch board of truck moves — one pane of glass, phone-first, replacing a $900/yr SaaS (IntegraRental) and, later, Machinio's service module.

**v2.5 (2026-09-04, 11:45):** lead logs are money-free by contract — the engine never writes a dollar figure into a lead log row (`value set` / `value updated` only) and the builder refuses to publish one that has it. The 11:34 fail-closed strip of `leads[].log` for service tokens is **reversed**: service sees lead logs again (Josh's own notes come back). Keep a Worker test that a service payload's lead-log text never matches `/\$\s?\d/`. Pending notes render **below** the log (newest last), not above.

**v2.4 (2026-09-04, 11:20):** `service_queue[].log[]` and `leads[].log[]` — the ticket/lead body as `{ts, who, text}` rows (last 30, oldest first). Additive. Render it as a **Notes** timeline in ticket detail and lead detail; Matt needs the tech's diagnosis on his phone to quote. `who` is a best-effort parse — display `text` as primary, `who` as a chip only when present.

**v3.7 (2026-09-25, D67) — schema stays 7, additive; ONE new action (sixteen):** **the fleet inspection sheet — check-out / return / PM.** Matt's four paper PM sheets (walk-behind sweeper · rider sweeper · scrubber 24V · scrubber 36V) became **one row library in the vault** that the engine ships verbatim as **`inspection_checklist`** `{version, sections[]}` — `sections[] {id, title, instruction?, shows_for?, rows[] {id, label, scale: FUNCTION|WEAR, shows_for?, retired?}}`. **The phone renders the sheet from this key**; a row is a vault edit, never a deploy. `shows_for` filters by `{class: [SWEEPER|SCRUBBER], controls: [WALK-BEHIND|RIDER|STAND-ON], battery: [WET|AGM|LITHIUM]}` (absent key = everyone); a `retired` row is hidden on new sheets, still rendered on sheets that carry it. Scales: FUNCTION → `IN-SPEC|REPAIR|PROBLEM|N/A`, WEAR → `GOOD|WORN|REPLACE|N/A`; `REPAIR|PROBLEM|REPLACE` are **flags**. New top-level **`inspections[]`**: every `DRAFT` plus `DONE` ≤ 90 days (VOID never ships). Row: `id` (`"I1001"`), `serial`, `asset_item`, `kind` (`CHECKOUT|RETURN|PM`), `status` (`DRAFT|DONE`), `opened`, `opened_by`, `done`, `tech`, `ticket`, `work_order` (back-link, D65), `machine_class`, `controls`, **`battery`** `{type, voltage, pack}` (`24 → 4x6V|2x12V`, `36 → 3x12V|6x6V`, pack null unless WET), **`readings`** `{hours_key, hours_traction, hours_scrub, recharge_count, main_broom_length, brush1_length, brush2_length, brushes_rotated}`, **`cells[]`** `{battery, cell, sg, clarity, level}` (WET only; 12 @24V, 18 @36V — 6V battery = 3 cells A–C, 12V = 6 cells A–F, grouped per the pack), **`items[]`** `{id, result, note}`, `comments`, `flags`, `age_days` (DRAFT only, engine-computed), `log[]`. **`inspection_summary`** `{drafts, done_7d, done_30d, flagged_open, done_window_days}`. `units[]` gains **`inspection_draft`** (the DRAFT I-number or `null` — one per serial), **`last_inspection`** `{id, kind, done, flags} | null`, and **`hours` / `hours_as_of`** now carry values (DONE writes the meter back). `work_orders[]` gains **`inspection`** (the sheet it was opened from, or `null`). New action **`inspection`** `{serial?, payload: {action: OPEN|SAVE|DONE|REOPEN|VOID, …}}` — OPEN / SAVE / DONE any role; REOPEN owner (or the tech ≤ 24 h — engine-refereed); VOID owner or the opener while DRAFT. **SAVE is a merge by section**: a key present (`machine_class`, `controls`, `battery`, `readings`, `cells`, `items`, `comments`) replaces that section, absent = untouched — autosave one section on blur, never resend the sheet. Worker checks shape + enums + lengths only (`cells` ≤ 18, `items` ≤ 120, `sg` 1.000–1.400, unknown top-level keys → 400); **row-id validity is the engine's** (vault wins). `work_order OPEN` may carry `inspection: "I1001"` (back-link; engine refuses a sheet on another serial). Site: (a) **`Inspect`** button on unit detail beside `Work order` — `Resume I1001 · CHECKOUT · 3 ⚑` when a DRAFT exists, else a *Check-out · Return · PM* picker; an **Inspections** list (last 5) under it; `412 h · as of 9/26` in the unit header when `hours` is set; (b) new route **`#/inspection/<I>`** — phone-first single scroll: header + kind · machine dropdowns (re-filter, keep answers) · readings · battery dropdowns + cell grid (WET only) · library sections filtered by `shows_for` with a segmented control per row + note field · comments · footer **Done** (disabled until an hours field has a value — mirror the engine's one rule) / **Void**; DONE = read-only + **Reopen** (role-gated) + **Open work order from this inspection** when `flags > 0` and `work_order` is null (opens the D65 OPEN sheet with `purpose` REPAIR (PM) or RENT-READY (CHECKOUT), note `from I1001: <flagged labels>`, `inspection` in the payload); (c) a collapsed **`📋 Inspections ▸ N drafts · M done this week`** strip under the Parts strip (amber when a DRAFT is ≥ `INSPECT_AMBER` (2) days), Drafts then Done (7d). **No readiness automation** — *Mark READY* stays on the unit page. Pending: OPEN has no id until the engine runs → the sheet opens client-side as ⏳ NEW and SAVEs queue against `serial` until the id lands (holds already queue by serial — same pattern). Ticket detail gains a read-only `📋 I1001 · 2 ⚑` chip. The engine is already publishing these keys hourly — a pre-D67 app must tolerate them (verify first). Spec: [[Inspection-Site-Spec]] · library: [[_Inspection-Checklist]].

**v3.6 (2026-09-24, D65) — schema stays 7, additive; ONE new action (fifteen):** **internal work orders — parts + labor on fleet units.** New top-level **`work_orders[]`**: every `OPEN` work order plus `CLOSED` ≤ 30 days (CANCELLED never ships). Row: `id` (`"W1001"` — **this is the vendor PO number**: Matt reads "PO W1001" to the vendor, it prints on the packing slip, the techs match the box to the job by it), `serial`, `asset_item`, `ticket` (linked S-number or `null`), `status` (`OPEN|CLOSED`), `purpose` (`RENT-READY|REPAIR|PM|OTHER`), `opened`, `opened_by`, `closed`, **`age_days`** (engine-computed calendar, `null` when CLOSED — never client-side), `note`, **`parts[]`** `{line, manufacturer, part_number, description, qty, state, ordered, vendor, vendor_ref, tracking, carrier, delivered, source}` with `state ∈ REQUESTED|ORDERED|IN-TRANSIT|DELIVERED|CANCELLED` (forward-only, engine-refereed) and `carrier ∈ UPS|FEDEX|USPS|null` (engine-detected from the tracking number — draw a carrier link only when non-null), **`labor[]`** `{date, who, hours, note}`, `parts_open` (lines not DELIVERED/CANCELLED), `hours_total`, `log[]`. **`work_order_summary`** `{open, parts_requested, parts_ordered, parts_in_transit, delivered_30d, closed_window_days}`. `units[]` gains **`work_order`** (the OPEN W-number or `null` — one per serial) and **`wo_parts_open`**. **NO MONEY, for any role:** `work_orders[]` carries no `cost`, `rate`, or `price` key, ever — the engine never emits them (cost is backfilled in the vault from the vendor invoice, D66) and the Worker must **refuse by name (400)** any payload carrying one; extend the money-gate test so no role's `work_orders` text matches `/\$\s?\d/`. New action **`work_order`** `{serial?, payload: {action: OPEN|ADD-PARTS|PART-STATE|LABOR|CLOSE|CANCEL, …}}` — `OPEN` / `ADD-PARTS` / `LABOR` any role; `PART-STATE → ORDERED` and `CLOSE` **owner only**; `IN-TRANSIT` / `DELIVERED` `service`/`owner`. Site: (a) a collapsed **`🔩 Parts ▸ N open`** strip directly under the utilization card (above the category cards — a work list, not a totals block; D15 intact) listing *part lines* grouped Ordered · In transit · Requested (+ Delivered 30d inside), each row asset chip · **W-number labelled PO** · part # · qty · ordered · vendor · tracking · age; (b) a **`Work order`** button on unit detail beside the readiness picker (`Open work order` / `W1001 · 2 parts open · 3.5 h` chip); (c) a new route **`#/wo/<W>`** with the same anatomy as ticket detail — parts table with per-line state buttons, labor rows with `+ Log hours`, `Close work order` (owner; enabled only when no line is open). Ticket detail gains a read-only `🔩 W1001` chip when its unit carries one. Pending: OPEN has no id until the engine runs → synthetic ⏳ card keyed on `serial`; the other verbs badge on `payload.work_order`. The engine is already publishing these keys hourly — a pre-D65 app must tolerate them (verify first). Worker: whitelist the action + shape + the money refusal. Spec: [[Parts-Request-Site-Spec]].

**v3.5 (2026-09-24, D64) — schema stays 7, additive; ONE new action (fourteen):** the **rental lifecycle**. `agreements[]` ships every `PENDING` / `ACTIVE` / `OFF-RENT` agreement (ENDED excluded, as before) and every row gains `status` (`"PENDING"|"ACTIVE"|"OFF-RENT"`), `lead`, `out_date`/`out_move` (`DELIVER|CUSTOMER-PICKUP`), `in_date`/`in_move` (`PICKUP|CUSTOMER-RETURN`), `on_rent_since`, **`days_on_rent`** (engine-computed calendar days, `null` while PENDING — never compute it client-side), `off_rent`, `delivery` (the claim `{id,driver,rig,date,status}|null`); `next_due` is `null` while PENDING. `dispatch[]` gains source **`RENTAL-DELIVER`** rows `m-dl-<agreement>` (`kind: DELIVER`, one per PENDING+DELIVER agreement; claim/done through the existing actions; never cancellable) and **every** dispatch row carries `agreement` (opaque per D59; `null` off the rental legs). `units[]` gains `pending_agreement`; a PENDING agreement also appears in that unit's `reservations[]` as an implied hold `{id:"agmt:<R>", held_by:"agreement", purpose:"RENTAL"}` that the site must not offer to release. New action **`rental_update`** `{agreement, action: OUT|OFF-RENT|IN, date?, note?}` for `sales`/`owner` — the Rentals tile's **Off-rent** button (stops the clock; D7 caps `cycles_max` engine-side; `in_move: PICKUP` → the `m-pu-<serial>` row appears), **Went out** (CUSTOMER-PICKUP tiles) and **Back in shop** (CUSTOMER-RETURN tiles; owner override on PICKUP tiles). Delivery **Done** on `m-dl-*` is the OUT: the engine flips the agreement ACTIVE, the unit ON-RENT, and the linked lead to INVOICED / WON with the R-number — the site does nothing extra. **Off-rent is never automatic**: the tile draws `in_date` loud (amber ≤ tomorrow, red past), a human taps. D21 revenue sum: `status ∈ {ACTIVE, OFF-RENT}` only. The engine is already publishing these keys hourly — a pre-D64 app must tolerate them (verify first). Worker: whitelist the action + shape. Spec: [[Rental-Lifecycle-Site-Spec]].

**v3.4 (2026-09-24, D62) — schema stays 7, additive:** CLOSED tickets ship in `service_queue[]` for **90 days** (was 7; dispatch DONE rows keep 7, leads keep 14). Every ticket row gains **`closed_age_days`** (`int | null` — calendar days since `closed`, engine-computed; `null` while OPEN — **use it, never diff `closed` against the phone's clock**). `service_summary` gains **`closed_window_days`** (90) and **`closed_in_window`**. **`open_by_stage.COMPLETE` still means closed ≤ 7 days.** Site: the COMPLETE column draws only `closed_age_days <= 7`; older closed tickets live in a collapsed, searchable **Completed** strip under the kanban (the Leads Closed-strip pattern); `closedThisWeek` counts ≤ 7 only. A pre-D62 snapshot (keys missing) must render as before — missing `closed_age_days` reads as 0, missing `closed_window_days` as 7. Worker untouched: tickets were never role-gated (D12) and stay that way. Spec: [[Completed-History-Site-Spec]].

**v3.3 (2026-09-23, D59) — schema stays 7:** (1) **`agreement` is `int | string | null`** everywhere it appears (`agreements[]`, `units[]`, `pickups[]`, `billing.*`). WSS-paper rentals are numbered on our own paper — `"R092526A"` — while legacy Integra agreements stay ints (`4130`). It is an **opaque id**: render it verbatim, never parse it, never do arithmetic on it, never prefix-format it assuming digits (the WSS-paper form already carries its own `R`), and **never let a sort mix-compare an int against a string**. Invoice numbers hang off it the same way — `"R092526A-1"` — and stay opaque strings like every other invoice number. (2) New docs kind **`CONTRACT`** (the rental agreement PDF) on `agreements[].docs[]` and `leads[].docs[]` — **vault-minted only**, renders through the 📄 fallback exactly like `WRITEUP`. A phone may not mint `WRITEUP` or `CONTRACT`.

**v3.2 (2026-09-14, D57) — schema stays 7, NO code change in this repo:** `IN-SHOP` is now **derived from `readiness`, never hand-set**. On a home unit the engine keeps the pair consistent: `NEEDS-PREP` or `DOWN` → `unit_state: IN-SHOP`; `READY` → `AVAILABLE` (or `RESERVED` on a current hold). So the combination **`AVAILABLE` + `NEEDS-PREP`/`DOWN` can no longer appear in a snapshot** — if you ever see one, the engine is broken: report it, don't paper over it. Matt's ruling: *"if the scrubber needs prep it isn't technically available."* Consequences for this repo, all already true by construction: every category count was already readiness-driven and `ready` already required `AVAILABLE` ∧ `READY`, so **no count moves**; a held machine that needs prep reads `IN-SHOP` and drops out of the `N reserved` count while keeping its 📅 chip; out states (`ON-RENT`/`ON-DEMO`/`LOANER-OUT`) and `NEEDS-PICKUP` are untouched — Dispatch still owns that clock. **Do NOT "fix" a contradictory pair client-side.** Deriving the chip in `app.js` would put the page and the snapshot on different stories and silently desync every count built off `unit_state`; the invariant belongs to the engine and is enforced there (`apply_events.sweep_unit()`).

**v3.1 (2026-09-14, D56) — schema stays 7:** the **Shop List** + readiness aging. Two additive fields on `units[]`: `readiness_since` (date-only, the day `readiness` last **changed** — the engine stamps it through one helper, `apply_events.set_readiness()`; a note-only rewrite must NOT move it) and `readiness_age_days` (**calendar** days, engine-computed, ≥ 0). Both emitted for **every** unit, out states included, and both `null` on a unit that has never been stamped — **never compute the age client-side**, same reasoning as every other age in the snapshot. New landing section **"In the shop"** *under* the category cards (**D15 amended, not repealed** — the cards still own the top of the page): on-hand units (D18) with `readiness` NEEDS-PREP (first) then DOWN, oldest first inside each group, nulls last. `NEEDS-PICKUP` is excluded — it's an out state and Dispatch owns its clock (D32/D38). Age renders as a chip right after the readiness chip, by construction everywhere `unitChips()` draws (Shop List · category rows · unit detail): `today` at 0, else `Nd`; neutral < 7, amber 7–13, red ≥ 14 (`AGE_AMBER` / `AGE_RED` at the top of `app.js` — Matt retunes the two numbers, nothing else). READY units never show an age. Unit detail gains a `Readiness since` row for those two values only. D54 holds: the list surfaces **machines, never people**. No new action, no new enum, **no Worker change**. Spec: [[Shop-List-Site-Spec]].

**v3.0 (2026-09-10, D55) — schema stays 7:** new lead stage **`PO-RECEIVED`** between `DEMO-DONE` and `INVOICED`. Lead stages are now `RECEIVED · CONTACTED · QUOTED · DEMO-SCHEDULED · DEMO-DONE · PO-RECEIVED · INVOICED` (any direction, demo stages skippable; `QUOTED → PO-RECEIVED` is the normal path). Meaning: the customer's PO is in hand and the new-build order is with the factory — WSS is waiting on a serial before it can invoice. Ball in the factory's court, so its stale flag is **yellow only, never red** (`stale_po_bdays: 20`). It **requires `po`** (the customer PO #, ≤64 chars): the site asks for it on the stage-move form and the engine refuses the move without it. Additive `po` on `leads[]` rows; `scoreboard.money` gains `committed_value` / `committed_commission` / `committed_count` — a subset of `on_table_*`, which still includes them. Six open board columns + WON. **`RECEIVED` displays as "New Lead"** — the KEY is unchanged everywhere (stage_history, the sweep, the streak/stale logic, the Worker enum and the service ticket stage all share the word); `STAGE_LABEL` is the only place the caption and the key diverge. Spec: [[PO-Received-Site-Spec]]. Ride-along: `wss_geo.unresolved()` now reports only **this run's** lookup misses, not every `precision:"none"` cache row — a dead address no longer nags forever (`stale_cache()` keeps the old list for an audit).

**v2.9 (2026-09-09, D53 — amends D52):** map facelift. Asset regenerated (`data-style="d53"`: blue water + inland lakes, cased white roads, tiered city labels, minor towns); `style.css` must NOT override `--map-*` with the old beige. Pin palette avoids brand red — service purple · pickup orange · delivery blue · lead green · rental teal · shop red house. Teardrop markers with an always-visible ID chip at the default zoom (hidden only near whole-state). **Hollow-pin rule RETIRED** — precision is a line of text in the tap sheet. Container sized to the default view (no dead band). `meta.geo.default_view` is now 42.45–43.85 / −90.05…−87.22. Spec: [[Map-Facelift-Site-Spec]]. **v2.8 (2026-09-09, D52) — schema 7:** `geo: {lat,lng,precision,in_wi} | null` on `units[]` (job_site, out states only), `service_queue[]` (site), `leads[]` (site), `dispatch[]` (address) + `meta.geo` (shop pin, projected bounds, default SE viewport). Engine geocodes once and caches in the vault; the page never geocodes and never loads tiles — it draws pins on the vendored `docs/wi-map.svg` (counties + interstates + city labels; projection constants on the SVG root as `data-lat0/lng0/kx/ky`). Map lives on the **Dispatch** tab as a List | Map segmented control; pins by kind (Service/Pickup/Delivery/Lead/Rental), solid = street precision, hollow = city, off-map list for `geo:null`/`in_wi:false`; Navigate + Plan-a-run open Google Maps directions URLs (links, not assets). Spec: [[Map-View-Site-Spec]]. **v2.7 (2026-09-08, D48):** `READY-TO-SCHEDULE` service stage between WAITING-ON-PARTS and SCHEDULED — ten stages; *both* machine owners take it (the WSS skip set is unchanged at three), so Fleet draws seven columns and the pipeline nine rows. Meaning: approval + parts in hand, WSS owes the customer a date — our court, maroon. The engine auto-moves READY-TO-SCHEDULE → SCHEDULED when a `scheduled` date lands. Spec: [[Ready-To-Schedule-Site-Spec]]. **v2.3 (2026-09-04, D47):** `NEEDS-QUOTE` service stage — nine stages, three-value WSS skip set; kanban/picker/pipeline derive from `stagesFor()`. Shipped Worker 8b690e5a · Pages 5cd6fda. *(v1.7/v1.8 lines below still say eight stages / seven pipeline rows — 🕰️ historical, accurate for their date.)*

**v2.1 (2026-09-03, D46):** `DELETE /api/event/:id` (undo your own pending tap), Dispatch lists DELIVER before PICKUP in Open/Scheduled, "Fleet value on rent" caption under the dollar bar. Spec: [[Undo-Pending-Site-Spec]]. **v2.0 (2026-09-03, D45) — schema 4:** `acquisition_cost` + `book` are GONE from `units[]` (only `ask` survives), `meta.fleet_totals` = `{units}` only, new `meta.utilization` carries the D19/D44 bars as engine-computed percentages — no dollar amount ships, ever (same reasoning as D16's floor). Spec: [[Cost-Privacy-Site-Spec]]. **v1.9 (2026-09-03, D44):** landing utilization card carries a second bar by dollars (acquisition cost). Spec: [[Dollar-Utilization-Site-Spec]]. **v1.8 (2026-09-03, D43):** Service tab is chip-driven — All · Fleet · Customer choose the widget zone; new **Service Pipeline** widget (seven stage rows over open customer tickets, `N open` + `N closed this week` pills), client-computed, no contract change. Spec: [[Service-Pipeline-Widget-Site-Spec]]. **v1.7 (2026-09-03, D42):** service stages are now RECEIVED · CONTACTED · WAITING-ON-CUSTOMER · WAITING-ON-PARTS · SCHEDULED · IN-PROGRESS · READY-TO-INVOICE · COMPLETE (whose-court model); WSS-owned tickets skip WAITING-ON-CUSTOMER + READY-TO-INVOICE. **v1.6 (2026-09-03) — schema 3:** Billing tab retired → **Dispatch**; Service tab real; six new write actions. Work order: [[Service-Dispatch-Site-Spec]]. Sections below are updated in place; where a v1.5 rule survives it's unchanged.

**This repo is the presentation + transport layer ONLY.** A separate system (Matt's vault + a Python "run engine," owned elsewhere) is the source of truth. It publishes a JSON snapshot to your Worker and drains pending write-events from it. You never see that system; you build to the contracts in this file.

## Division of labor — hard boundary

| Yours (this repo) | NOT yours |
|---|---|
| Cloudflare Worker (API + KV) | The run engine, billing logic, QuickBooks anything |
| Static web app (GitHub Pages) | Generating real `dashboard-data.json` (engine does) |
| PWA shell, tokens plumbing, deploy config | The vault, agreement/unit data files |
| Mock/sample data generator (fake data) | Applying events to the source of truth |

If real data ever looks wrong, **report it — never "fix" data**. The vault wins all conflicts.

## Architecture (locked — do not redesign)

```
 Crew phones/desktops ──tokenized URL──► fleet.wisconsinscrubandsweep.com
                                          │  (GitHub Pages: static app shell,
                                          │   ZERO data in the repo/HTML)
                                          ▼
                        GET /api/data ────────────► Cloudflare Worker (workers.dev)
                        POST /api/event ──────────►   • token auth (KV map)
                                                      • KV: snapshot + event inbox
 Run engine (elsewhere) ◄─ GET /api/admin/events ──   • admin endpoints (secret)
                        ── POST /api/admin/publish ►
```

**Why this exact split (do not "simplify" it):** a Worker custom domain requires the DNS zone to be on Cloudflare, and WSS's DNS is managed by a third party (Machinio) who will only add **one CNAME record**. GitHub Pages accepts a custom domain via plain CNAME from any DNS host. So: **page on GitHub Pages at the custom domain, Worker stays on `*.workers.dev`, page calls it cross-origin.** This is the same proven pattern as Matt's existing Newsstand system (`mlancourt.github.io/newsstand` + `newsstand-worker.mlancourt.workers.dev`).

**Hosting accounts:** GitHub `mlancourt` (Pages from this repo's `/docs` folder on `main`) · Matt's existing Cloudflare account (he has deployed Workers + KV before; he's comfortable with dashboard paste-deploys — prefer `wrangler`, but keep the Worker a single self-contained `worker.js` so dashboard-paste stays possible as fallback).

## Hard rules

1. **No real data in this repo, ever.** The repo is public. No customer names, prices, costs, serials, tokens, secrets, or real `dashboard-data.json` — not in code, not in commits, not in test fixtures. All test data comes from the fake-data generator (below). `.gitignore` anything `*.local.*`, `.dev.vars`, `real-*`.
2. **No accounts, no passwords, no auth frameworks.** Identity = opaque per-person token in the URL (decision D4). Do not add login pages, OAuth, or user management.
3. **No build step, no frameworks.** Vanilla HTML/CSS/JS, ES modules fine. No React/Vite/npm-for-the-page. (Worker is plain JS too; `wrangler` is the only dev dependency.) This must stay maintainable by future Claude sessions with zero toolchain archaeology.
4. **No external CDNs, fonts, analytics, or trackers** on the page. Self-contained assets. It must load fast in a warehouse on one bar of LTE.
5. **Writes are proposals, not truth.** Every write is a *pending event* until the engine applies it (nightly-ish). The UI must say so — never render a submitted write as if it already happened, except clearly badged "pending."
6. **Money never moves from here.** No invoice creation, no billing actions in the UI. Billing data is display-only.
7. **All timestamps you generate are UTC ISO-8601.** All business dates in the snapshot are date-only strings (`YYYY-MM-DD`) in Central time — **render them verbatim as text. NEVER `new Date("YYYY-MM-DD")`** — JS parses date-only strings as UTC midnight and Central-time users see yesterday. This bug is disqualifying.

## Repo layout

```
/CLAUDE.md              ← this file
/docs/                  ← GitHub Pages root (the app shell)
  index.html
  app.js  style.css
  manifest.webmanifest  sw.js  icons/
  wi-map.svg            ← D52: vendored Wisconsin map (vault-generated; never hand-edit — projection constants on its root)
  CNAME                 ← "fleet.wisconsinscrubandsweep.com" (add at M3, not before)
/worker/
  worker.js             ← entire Worker, single file
  wrangler.toml
/tools/
  make-mock-data.js     ← fake snapshot generator (node, no deps)
/README.md              ← ops runbook (deploy, secrets, token issue/rotate)
```

## KV design (namespace binding: `FLEET_KV`)

| Key | Value | Notes |
|---|---|---|
| `snapshot` | the full dashboard-data JSON string | replaced atomically on publish |
| `tokens` | JSON: `{"<token>": {"name":"Kevin","role":"sales"}, ...}` | loaded/managed by Matt via admin endpoint or dashboard; **never in repo** |
| `evt:<utc-iso>:<rand6>` | one event JSON | **one key per event — NEVER a single events-array key.** KV has no atomic append; a shared array key loses concurrent writes (two techs toggling readiness at once). List by prefix `evt:`, delete only ACKed ids. |
| `doc:<id>` | one document's raw bytes | schema 6. `put(key, arrayBuffer)` / `get(key, "arrayBuffer")` — **never base64.** `<id>` = `sha256(bytes)[:16]`, so the key IS the content and a doc is immutable. |
| `docmeta:<id>` | JSON `{id, name, mime, bytes, added_utc, source, actor}` (+ `record`, `kind` when `source: "crew"`) | Written **last** and deleted **first**, so a half-write is invisible: every reader and the listing go through this key. The doc store is a **cache** — the vault is the archive and may wipe and rebuild it. |

KV is eventually consistent (~60s cross-edge) — acceptable here; note it in README so nobody "fixes" phantom lag.

## Worker API

Auth: crew endpoints take the token (`?t=` or `Authorization: Bearer`); admin endpoints take `X-Admin-Secret` (Worker secret `ADMIN_SECRET`, set via `wrangler secret put`, local dev via `.dev.vars`). Unknown token/secret → 401 JSON. Never log token values.

| Endpoint | Auth | Behavior |
|---|---|---|
| `GET /api/data` | token | `{me:{name,role}, snapshot:<the JSON>, pending:[events]}` — pending included so the UI can badge unapplied writes |
| `POST /api/event` | token | Validate role + shape (below), stamp `{id, ts, actor, role}` server-side, write `evt:` key. Return the stored event. Reject unknown `action` / malformed `serial` (`serial` is required for reserve/release/readiness, optional for the six schema-3 actions, absent on `rental_update` — it carries `payload.agreement`) and any enum value outside the fixed lists in this file; **do not** validate against business state (vault's job). |
| `DELETE /api/event/:id` | token | **D46:** delete ONE still-pending `evt:` key, and only if the stored `actor` equals the caller's token name (else 403); 404 once drained. The "wrong button" valve — never bulk, never touches `snapshot`, `owner` gets no override. |
| `GET /api/health` | token | `{published_at, pending_count}` |
| `POST /api/admin/publish` | secret | body = full snapshot JSON → validate it parses + has `meta.schema_version`, write `snapshot` |
| `GET /api/admin/events` | secret | list + return all `evt:*` (id, key, event) |
| `POST /api/admin/events/ack` | secret | `{ids:[...]}` → delete those keys only. **Never bulk-delete all events** — new events can land mid-run. |
| `POST /api/admin/tokens` | secret | replace the `tokens` map (how Matt issues/rotates) |
| `GET /api/doc/:id` | token (`?t=` **or** Bearer) | schema 6: stream the bytes. `Content-Type` from the stored meta, `Content-Disposition: inline`, `Cache-Control: private, max-age=31536000, immutable`, `nosniff`. A doc id is 16 lowercase hex — `sha256(bytes)[:16]` — so `?t=` must work: this opens in a new tab, which cannot send a header. |
| `POST /api/doc` | token | schema 6 / S2: a phone uploads. Body = raw bytes; headers `Content-Type`, `X-Doc-Name`, `X-Doc-Record`, `X-Doc-Kind`. The client sends **no id** — the Worker hashes the body. `201 {id, bytes, existed:false}` / `200 {id, existed:true}`. |
| `PUT /api/admin/doc/:id` | secret | the engine's up-leg. **Recompute `sha256(body)[:16]`; on a mismatch, 409 and store NOTHING** — the id in the URL is a claim, never trusted. 10 MB cap. |
| `GET`/`DELETE` `/api/admin/doc/:id` · `GET /api/admin/docs` | secret | read back / drop / list `docmeta:` |

CORS: allow origins `https://fleet.wisconsinscrubandsweep.com` and `https://mlancourt.github.io` (pre-DNS testing), plus `http://localhost:*` in dev. Handle preflight.

## Write model (sixteen actions — nine through schema 3, three lead actions at schema 5, `doc_attach` at schema 6, `rental_update` at D64, `work_order` at D65, `inspection` at D67 — exactly these, nothing more)

Roles (visibility, D12 as amended by D16 + D45: everyone sees everything the snapshot carries — and the snapshot no longer carries floor, cost, or book): `owner` (Matt — all writes) · `sales` (Kevin — reserve/release, **`rental_update` since D64**) · `service` (Josh, Zac — readiness, ticket stages). **Schema 3 adds:** `ticket_open`, notes/assign/schedule via `ticket_update`, and `dispatch_add` / `dispatch_claim` / `dispatch_done` for **any role**; ticket *stage* changes for `service`/`owner`; `dispatch_cancel` for `owner`. `serial` is optional on the six new actions. **Schema 6 adds** `doc_attach` (the tenth of the core set, approved 2026-09-08) for **any role** — see the documents block below. Everyone **reads everything** the snapshot carries (D12); floor (D16) and cost + book (D45) no longer exist in the snapshot at all — only `ask` remains as a money figure on a unit.

Event shapes (client sends `action`, `serial`, `payload`; server stamps the rest):

```json
{"action":"reserve",  "serial":"150074", "payload":{"customer":"...", "purpose":"...", "start":"YYYY-MM-DD", "end":"YYYY-MM-DD"}}
{"action":"release",  "serial":"150074", "payload":{"hold_id":"h2812b2"}}
{"action":"readiness","serial":"150074", "payload":{"readiness":"READY|NEEDS-PREP|DOWN|NEEDS-PICKUP", "note":"..."}}

// schema 3 (full shapes + role gating in [[Service-Dispatch-Site-Spec]] §6):
{"action":"ticket_open",     "payload":{"machine_owner":"CUSTOMER|WSS","serial":null,"equipment":"…","customer":"…","issue":"…","priority":"HIGH|MEDIUM|LOW","site":null,"location":"AT-CUSTOMER|IN-SHOP","intake_move":"NONE|PICKUP|CUSTOMER-DROP","return_move":"NONE|DELIVER|CUSTOMER-PICKUP"}}
{"action":"ticket_update",   "payload":{"ticket":"S1001","stage":"…","note":"…","assigned":"…","scheduled":"YYYY-MM-DD","intake_move":"…","return_move":"…"}}   // only the keys being changed
{"action":"dispatch_add",    "payload":{"kind":"PICKUP|DELIVER","serial":null,"ticket":null,"what":"…","customer":"…","address":"…","date":null,"note":null}}
{"action":"dispatch_claim",  "payload":{"dispatch_id":"m-…","rig":"KEVIN-LIFTGATE|JOSH-LIFTGATE|TRAILER-6000|TRAILER-3000","date":"YYYY-MM-DD","driver":"Matt|Kevin|Josh|Zac"}}
{"action":"dispatch_done",   "payload":{"dispatch_id":"m-…","note":null}}
{"action":"dispatch_cancel", "payload":{"dispatch_id":"m-…"}}

// D64 (2026-09-24) — the rental lifecycle: sales + owner. OUT = PENDING→ACTIVE (CUSTOMER-PICKUP tiles; DELIVER goes through dispatch_done on m-dl-<R>),
// OFF-RENT = ACTIVE→OFF-RENT (stops the clock; PICKUP → m-pu-<serial> appears), IN = →ENDED (CUSTOMER-RETURN tiles / owner override).
// date optional (today), never in the future; the engine referees state, the Worker checks shape only.
{"action":"rental_update",   "payload":{"agreement":"R092526A","action":"OUT|OFF-RENT|IN","date":"YYYY-MM-DD","note":null}}

// D65 (2026-09-24) — internal work order (parts + labor) on a FLEET unit. The W-number is the vendor PO. `serial` only on OPEN.
// OPEN / ADD-PARTS / LABOR: any role. PART-STATE ORDERED + CLOSE: owner only. IN-TRANSIT / DELIVERED: service + owner.
// parts[] 1–10 per event, part_number ≤40, description ≤80, qty 1–99; hours 0.25–12 in 0.25 steps; note ≤200.
// NO cost / rate / price key anywhere in the payload — refuse by name with a 400. The engine referees state (forward-only,
// one OPEN per serial, close guard); the Worker checks shape + enums only.
{"action":"work_order","serial":"150074","payload":{"action":"OPEN","purpose":"RENT-READY|REPAIR|PM|OTHER","note":null,"parts":[{"manufacturer":"FACTORY-CAT|KODIAK|TENNANT|IPC-EAGLE|NILFISK|MINUTEMAN|OTHER","part_number":"150-4500","description":"Solution valve 24V","qty":1}]}}
{"action":"work_order","payload":{"action":"ADD-PARTS","work_order":"W1001","parts":[{"manufacturer":"KODIAK","part_number":"21-422S","description":"Squeegee blade rear","qty":2}]}}
{"action":"work_order","payload":{"action":"PART-STATE","work_order":"W1001","line":1,"state":"ORDERED|IN-TRANSIT|DELIVERED|CANCELLED","date":"YYYY-MM-DD","vendor":"RPS|IPC-EAGLE|NILFISK|MINUTEMAN|TENNANT|OTHER","vendor_ref":null,"tracking":null,"note":null}}
{"action":"work_order","payload":{"action":"LABOR","work_order":"W1001","date":"YYYY-MM-DD","who":"Matt|Kevin|Josh|Zac","hours":1.5,"note":null}}
{"action":"work_order","payload":{"action":"CLOSE","work_order":"W1001","note":null}}
{"action":"work_order","payload":{"action":"CANCEL","work_order":"W1001","note":null}}

// D67 (2026-09-25) — fleet inspection sheet (check-out / return / PM) on a FLEET unit. `serial` only on OPEN.
// OPEN / SAVE / DONE: any role. REOPEN: owner (engine also allows the tech ≤24 h). VOID: owner, or the opener while DRAFT.
// SAVE merges BY SECTION — send only the sections that changed. items[].id validity is the ENGINE's (the library lives in the vault).
// cells ≤18, items ≤120, sg 1.000–1.400, comments ≤1000, item note ≤120, verb note ≤200; unknown top-level keys → 400.
{"action":"inspection","serial":"150074","payload":{"action":"OPEN","kind":"CHECKOUT|RETURN|PM"}}
{"action":"inspection","payload":{"action":"SAVE","inspection":"I1001","machine_class":"SWEEPER|SCRUBBER","controls":"WALK-BEHIND|RIDER|STAND-ON","battery":{"type":"WET|AGM|LITHIUM","voltage":24,"pack":"4x6V|2x12V|3x12V|6x6V|null"},"readings":{"hours_key":412.5,"hours_traction":null,"hours_scrub":null,"recharge_count":88,"main_broom_length":null,"brush1_length":1.5,"brush2_length":1.5,"brushes_rotated":true},"cells":[{"battery":1,"cell":"A","sg":1.265,"clarity":"CLEAR|CLOUDY|PARTICULATE|DARK","level":"OVERFILLED|FULL|LOW|DRY"}],"items":[{"id":"ctl.key_switch","result":"IN-SPEC|REPAIR|PROBLEM|N/A","note":null},{"id":"deck.curtains","result":"GOOD|WORN|REPLACE|N/A","note":null}],"comments":null}}
{"action":"inspection","payload":{"action":"DONE","inspection":"I1001","tech":"Matt|Kevin|Josh|Zac"}}
{"action":"inspection","payload":{"action":"REOPEN","inspection":"I1001","note":null}}
{"action":"inspection","payload":{"action":"VOID","inspection":"I1001","note":null}}
// D67 — work_order OPEN may carry the sheet it came from:
{"action":"work_order","serial":"150074","payload":{"action":"OPEN","purpose":"REPAIR","inspection":"I1001","note":"from I1001: Check and rotate blades","parts":[]}}

// schema 6 / S2 — the bytes NEVER ride in the event. The phone POSTs the file to
// /api/doc first; this carries only the id the Worker computed from it.
{"action":"doc_attach",      "payload":{"record":"S1018|L1005","doc_id":"ab0b83a1b88c21ff","kind":"WORKORDER|PARTS-LIST|PHOTO|OTHER","name":"IMG_4821.jpg"}}
```

UI rules: **Reserve is offered on any non-RETIRED unit** (D28 — a machine out on rent today can carry future holds; label it "Reserve for later" when it's out). `start` defaults to today, `end` to **start + 5 business days** (skip Sat/Sun). `release` **must carry the `hold_id`** of the row being released — the engine rejects an ambiguous release on a multi-hold unit. Readiness toggle available on any unit for `service`/`owner`; the picker offers all four values, with `NEEDS-PICKUP` labeled "Needs pick-up" (D32 — see [[Needs-Pickup-Site-Spec]]). After a POST, badge the unit "⏳ pending" from the `pending` array and show "applies at the next run" once. Full v2 reservation UI spec: **[[Reservations-v2-Site-Spec]]** (the work order Matt pastes for this rebuild).

### Documents (schema 6) — `POST /api/doc` + `doc_attach`

**The binary never rides in an event.** Two calls, in this order, and the order is the design:

1. **`POST /api/doc`** (token, any role) — body = raw bytes; headers `Content-Type` (`application/pdf` · `image/jpeg` · `image/png`), `X-Doc-Name`, `X-Doc-Record` (`^[SL]\d{4}$` — the ticket or lead), `X-Doc-Kind` (`WORKORDER · PARTS-LIST · PHOTO · OTHER` — a phone may **not** mint QUOTE / PO / PM-REPORT / SERVICE-TICKET / WRITEUP / CONTRACT; those are the vault's). The client sends **no id**: the Worker hashes the bytes and `sha256[:16]` *is* the id, which is also why the same file twice is one document (`existed: true`). 10 MB cap. `docmeta` gains `record` + `kind`, `source: "crew"`, `actor` = token name.
2. **`doc_attach`** — the event above, carrying only the id. The Worker refuses it with 400 if `docmeta:<doc_id>` does not exist; that is **the one business-state check in the Worker**, and it is checking our own store, not the vault's.

**The record binding lives in `docmeta`, not only in the event.** So a lost event is not a lost document — the engine sweeps unfiled `source: "crew"` docs every run. That is the whole reason the binding is a header on the upload.

Site: 📷 Photo (`capture="environment"`) and 📎 File on ticket + lead detail, any role. One file per tap, **no `multiple`**. Images resize on a canvas to a 1600 px long edge at JPEG q0.7 with EXIF orientation applied; **PDFs pass through untouched** and nothing is ever converted *to* PDF. A failed send shows "Didn't send — tap to retry" against the blob still in memory: **no persistent queue, no background sync, no `localStorage` of blobs** — and the copy says so ("leaving this page discards it"). A pending `doc_attach` renders as a pending row in that record's Documents group and is not openable until the engine files it.

## Snapshot contract — `dashboard-data.json` (schema_version 4 → 5 → 6 → **7 as of 2026-09-09**)

> **Schema 6 (LIVE, additive):** `service_queue[]`, `leads[]` and `agreements[]` each gain `docs[]` — `{id, name, kind, bytes, added}`, always present, may be `[]`. `id` is 16 lowercase hex (the content hash); `kind` ∈ `QUOTE · WORKORDER · PARTS-LIST · PM-REPORT · SERVICE-TICKET · PO · PHOTO · WRITEUP · CONTRACT · OTHER` (WRITEUP = the vault's post-invoice service write-up, added 2026-09-15; CONTRACT = the rental agreement PDF, added 2026-09-23 / D59 — both vault-minted only, both render via the 📄 fallback, neither needs a site change). Read at `GET /api/doc/<id>` (token, `?t=` or Bearer). **Docs are never stripped and never role-gated** — the §6 money gate does not touch them. A schema-5 snapshot (no `docs` key) must render unchanged. Upload: the documents block above.

> **Schema 5 (LIVE, additive):** `leads[]`, `leads_summary`, `scoreboard`, `insights` + three actions `lead_open` / `lead_update` / `lead_close`. Lead stage enum as of D55: `RECEIVED · CONTACTED · QUOTED · DEMO-SCHEDULED · DEMO-DONE · PO-RECEIVED · INVOICED`, and a lead row carries `po` (required to enter `PO-RECEIVED`). **`RECEIVED` renders as "New Lead"; the key never changes.** Full shapes, role gating and the **mandatory Worker money-strip for `service` tokens** are in [[Leads-Site-Spec]] — build from that file; everything below is unchanged.

The engine emits this; you consume it and also generate FAKE versions of it in `make-mock-data.js`. Never require fields beyond this contract; tolerate unknown extra fields silently (forward compatibility).

```jsonc
{
  "meta": { "schema_version": 4, "generated_at": "<UTC ISO>", "run_id": "…",
            "fleet_totals": { "units": 36 },                       // D45: units only — no cost/book/ask totals ship
            "utilization": { "units": { "on_rent": 18, "total": 35, "pct": 51 },
                             "dollars": { "pct": 60, "excluded": 0 } },     // D45: the D19 + D44 bars, engine-computed; dollars carries NO amounts
            "geo": { "shop": { "label": "WSS — Ixonia", "address": "…", "lat": 43.137422, "lng": -88.592609 },   // D52
                     "bounds": { "lat_min": 42.45, "lat_max": 47.10, "lng_min": -92.95, "lng_max": -86.75 },
                     "default_view": { "lat_min": 42.45, "lat_max": 43.90, "lng_min": -90.15, "lng_max": -87.70 },
                     "precision_legend": { "rooftop": "…", "street": "…", "city": "…", "none": "…" } } },
  "categories": ["…9 rental-rate-matrix band names, display order…"],
  "units": [ {
    "serial": "150074", "asset_item": "…", "brand": "…", "model": "…", "description": "…",
    "category": "…", "status": "RENTAL|LOANER",
    "unit_state": "AVAILABLE|RESERVED|ON-RENT|ON-DEMO|LOANER-OUT|IN-SHOP",   // RETIRED units are NOT emitted (D34) — keep the enum value tolerated, never expect it
    "readiness": "READY|NEEDS-PREP|DOWN|NEEDS-PICKUP", "readiness_note": null, "hours": null,   // NEEDS-PICKUP (D32): customer released an OUT unit — techs fetch it
    // D56 (schema 7, additive): the readiness clock. `readiness_since` = the day the readiness VALUE last
    // changed (a new note on the same value does NOT move it — that is the age's whole meaning);
    // `readiness_age_days` = CALENDAR days, engine-computed, >= 0. Emitted on EVERY unit, out states
    // included; both null when never stamped (render no age — a blank reads "unknown", a 0 reads "just
    // happened"). NEVER compute the age client-side: one clock, the engine's, Central.
    "readiness_since": "YYYY-MM-DD", "readiness_age_days": 0,
    "in_service": "YYYY-MM-DD",
    "ask": 0,                                    // engine-computed fresh each run — display only. NO floor (D16), NO acquisition_cost, NO book (D45): all engine-internal, never in the snapshot.
    "rate_card": { "monthly": null, "full_day": null, "weekend": null, "weekly": null,
                   "long_term_6mo": null, "long_term_12mo": null },
                  // D23: all rates are the category's published matrix rates, verbatim — category-uniform, populated
                  // in practice; render "—" only as a guard. D31: long_term_* = per-28-day-cycle rate under a signed
                  // 6-/12-month commitment (≈25%/50% off monthly, rounded to $5 in the vault — NEVER compute client-side).
                  // Unit-page rate card only, under a "Long-term (signed commitment)" sub-block, no caveat text —
                  // see [[Long-Term-Rates-Site-Spec]].
    "job_site": null, "agreement": 4130,         // null when not out. D59: int | string | null — "R092526A" on WSS paper. Opaque.
    "pending_agreement": null,                   // D64: the R-number of a PENDING agreement naming this unit (reserved for rental); null otherwise
    "customer": "…",                             // D33: who has it — agreement customer (ON-RENT) or loaner placement (LOANER-OUT); null when home or on demo
    // D26 — the hold LIST is the truth; [] when unheld; sorted by start; inclusive dates.
    // status is engine-computed: current | future | expired | malformed.
    // RESERVED ⇔ a CURRENT hold on an otherwise-AVAILABLE unit (D28) — a unit with only
    // future holds stays AVAILABLE, and an ON-RENT unit can carry holds. Never infer state
    // from list length.
    "reservations": [ { "id": "h2812b2", "held_by": "Kevin", "customer": "…", "purpose": "…",
                        "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "created": "YYYY-MM-DD",
                        "status": "current" },
                      // D64: a PENDING agreement rides here as an IMPLIED hold — id "agmt:<R>", held_by "agreement",
                      // purpose "RENTAL", window out_date→in_date. NO Release button (the engine refuses it); it clears on delivery.
                      { "id": "agmt:R092526A", "held_by": "agreement", "customer": "…", "purpose": "RENTAL",
                        "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "created": null, "status": "future" } ],
    "service_ticket": null,                      // schema 3: "S1001" when the unit has an OPEN ticket (D35), else null. (The singular `reservation` object is GONE at schema 3.)
  // D52 (schema 7) — on units[] (out states only), service_queue[], leads[], dispatch[]; null when no usable address.
  // Engine-geocoded + vault-cached; the page NEVER geocodes. Pin math: x=(lng−lng0)·kx, y=(lat0−lat)·ky with the
  // constants read off wi-map.svg's root. precision is TEXT in the tap sheet (D53 retired the hollow pin) · in_wi:false → off-map list.
  "geo": { "lat": 43.074846, "lng": -88.478582, "precision": "rooftop|street|city", "in_wi": true },
  } ],
  "reservations": { "upcoming": [ { "serial","model","category","id","held_by","customer",
                                    "purpose","start","end","status" } ],
                    "expired":  [ { …same shape… } ] },   // D29: expiries are never silent
  "pickups": [ { "serial","model","category","unit_state","job_site","agreement","customer",
                 "billed_through","note" } ],             // D32: out units the customer released — [] when none
  "agreements": [ {
    "agreement": 4130,            // null = unbilled-rental alert (render with a loud ⚠️).
                                  // D59: int | string | null. Legacy Integra is an int (4130); WSS paper is a
                                  // string ("R092526A"). OPAQUE: render verbatim, never parse, never coerce,
                                  // never "R"-prefix it yourself, never sort int against string.
    "customer": "…", "serial": "150074", "cycle": "28D|ONE-SHOT",
    "cycle_rate": 0, "cycles_billed": 10, "cycles_max": null,
    "last_invoiced_period_start": "YYYY-MM-DD", "last_invoiced_period_end": "YYYY-MM-DD",
    "last_invoice": "R4130-10", "next_due": "YYYY-MM-DD",   // engine-computed; null = not billable
    "job_site": "…", "customer_po": null, "alerts": ["…"],
    "docs": [ { …same shape… } ],             // schema 6. D64: the Rentals tile + #/agreement/<id> render them.
    // D64 (2026-09-24, additive) — the lifecycle. agreements[] ships PENDING / ACTIVE / OFF-RENT (ENDED excluded).
    // Legacy rows may lack every key below → treat as ACTIVE / DELIVER / PICKUP. next_due is null while PENDING.
    "status": "PENDING|ACTIVE|OFF-RENT", "lead": "L1008",
    "out_date": "YYYY-MM-DD", "out_move": "DELIVER|CUSTOMER-PICKUP",
    "in_date": "YYYY-MM-DD", "in_move": "PICKUP|CUSTOMER-RETURN",     // in_date = informational due-back; draw it LOUD, never auto-end
    "on_rent_since": "YYYY-MM-DD", "days_on_rent": 0,                 // engine-computed calendar days (frozen at off_rent); null while PENDING
    "off_rent": null,
    "delivery": { "id": "m-dl-R092526A", "driver": "Kevin", "rig": "TRAILER-6000", "date": "YYYY-MM-DD", "status": "SCHEDULED" }   // the claim on the derived delivery row; null when unclaimed / not PENDING
  } ],
  // schema 3 (D35–D38) — full field list + semantics in [[Service-Dispatch-Site-Spec]] §2
  "service_queue": [ { "ticket": "S1001", "status": "OPEN|CLOSED",
    "stage": "RECEIVED|CONTACTED|NEEDS-QUOTE|WAITING-ON-CUSTOMER|WAITING-ON-PARTS|READY-TO-SCHEDULE|SCHEDULED|IN-PROGRESS|READY-TO-INVOICE|COMPLETE",
    "machine_owner": "CUSTOMER|WSS", "customer": "…", "serial": null, "equipment": "…", "issue": "…",   // machine_owner ≠ the `owner` ROLE
    "priority": "HIGH|MEDIUM|LOW", "site": null, "location": "AT-CUSTOMER|IN-SHOP",
    "intake_move": "NONE|PICKUP|CUSTOMER-DROP", "return_move": "NONE|DELIVER|CUSTOMER-PICKUP",
    "assigned": null, "scheduled": null, "opened": "YYYY-MM-DD", "opened_by": "…",
    "stage_since": "YYYY-MM-DD", "age_days": 0, "age_in_stage_days": 0, "quote": null, "parts": null, "machinio_ref": null, "closed": null,
    "closed_age_days": null,   // D62: int once CLOSED (calendar days since `closed`); CLOSED rows ship for 90 days
    "docs": [ { "id": "ab0b83a1b88c21ff", "name": "2026-09-07-I39Supply-Service.pdf", "kind": "QUOTE", "bytes": 25602, "added": "2026-09-07" } ] } ],   // schema 6 — always present, may be []
  "service_summary": { "open_by_stage": { "RECEIVED": 0, "…all nine stages…": 0, "COMPLETE": 0 }, "open_customer": 0, "open_wss": 0, "closed_window_days": 90, "closed_in_window": 0 },   // COMPLETE = closed in the last 7 days; the two D62 keys size the Completed strip
  "dispatch": [ { "id": "m-…", "kind": "PICKUP|DELIVER", "source": "RENTAL-DELIVER|RENTAL-RETURN|SERVICE-IN|SERVICE-OUT|MANUAL",
    "serial": null, "ticket": null, "what": "…", "customer": "…", "address": "…", "date": null, "billed_through": null,
    "driver": null, "rig": null, "status": "OPEN|SCHEDULED|DONE", "note": null, "done": null,
    "agreement": null } ],   // D64: the R-number on RENTAL-DELIVER (id m-dl-<R>) and RENTAL-RETURN (m-pu-<serial>) rows; null elsewhere. Opaque (D59). Neither rental source is cancellable.
  "dispatch_warnings": [ { "rig": "…", "date": "YYYY-MM-DD", "ids": ["m-…"] } ],   // same rig + date, >1 SCHEDULED row — warn, never block
  // `billing` is NOT rendered as of v1.6 (D39) — it stays in the snapshot for the engine's own consumers. Ignore it.
  "billing": { "due_next_7_days": [ { "agreement": 4130, "customer": "…", "serial": "…",
                 "amount": 0, "due": "YYYY-MM-DD" } ],
               "created_last_run": [ { "invoice": "R4130-11", "agreement": 4130, "customer": "…",
                 "amount": 0, "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD" } ] }
}
```

Notes you must honor: invoice numbers look like `R<agmt>-<cycle>` and occasionally `R4204-1.1` (split cycles), `R092526A-1` (D59, off a WSS-paper agreement — the id already carries its own `R`) or a bare QBO number like `519665` — treat as opaque strings, never parse. Loaner placements appear as units with `unit_state: LOANER-OUT`, `agreement: <n>` and **no matching entry in `agreements`** — that's correct, render the unit's placement without a billing row. `service_queue` may be `[]` (empty-state must render). CLOSED tickets linger **90 days** (D62) and DONE dispatch rows 7 days in the snapshot — "done this week" is the COMPLETE column / Done section; the rest of the 90 days is the Completed strip.

## UI spec (decisions D11/D12 — locked)

Brand: WSS maroon `#B71C1C`, white, near-black. Clean, big tap targets, gloves-on friendly. Responsive; design at 390×844 first, desktop is a bonus.

0. **Landing top: fleet-utilization card — TWO bars (D19 units + D44 dollars), read from `meta.utilization` (D45).** `Units` and `Dollars` percentages come pre-computed from the engine; same bands + words on both; band colour lives on each bar, not the card; **no dollar amount is rendered anywhere** (the D44 `$X on rent of $Y` sub-line was removed by D45). Footnote `N unit(s) without a cost excluded` from `utilization.dollars.excluded`. Client-side fallback computation only for a schema-3 snapshot. D19 as originally written: One thin horizontal bar, client-computed: ON-RENT units ÷ units with `status: "RENTAL"` and `unit_state != "RETIRED"`. Shows the % + a word label; fill color by band: 0–29 red "Low" · 30–60 yellow "Building" · 61–80 green "Healthy" · 81–100 red "Over-extended". Must read well at phone width and desktop.
   - **Directly under the utilization card (v3.6, D65): the Parts strip.** One collapsed row `🔩 Parts ▸ N open` (pill = `work_order_summary.parts_requested + parts_ordered + parts_in_transit`; amber if any REQUESTED line's work order has `age_days ≥ PARTS_AMBER` (3), red at `PARTS_RED` (7) — constants beside `AGE_AMBER`). Collapsed by default so the category lights still read first (D15 intact — this is a work list, the D56 carve-out). Expanded: part lines from `work_orders[]` grouped **Ordered · In transit · Requested**, then **Delivered (30d)** collapsed inside; row = asset chip (→ unit) · **W-number labelled "PO"** · part # · qty · `ordered` · `vendor` · `tracking` (carrier link only when `carrier` non-null) · age · 🔧 ticket chip. Tap → `#/wo/<W>`. No money anywhere. Spec [[Parts-Request-Site-Spec]] §3.
   - **Under the Parts strip (v3.7, D67): the Inspections strip.** One collapsed row `📋 Inspections ▸ N drafts · M done this week` (`inspection_summary.drafts` / `done_7d`; amber if any DRAFT `age_days ≥ INSPECT_AMBER` (2) — constant beside `PARTS_AMBER`). Expanded: **Drafts** (asset chip · kind · opened_by · age · *Resume*) then **Done (7d)** (asset chip · kind · tech · hours · ⚑ flags · 🔩 WO chip). Tap → `#/inspection/<I>`. It exists so a half-done sheet is never lost — not a report. Spec [[Inspection-Site-Spec]] §5.
1. **Landing = 9 category cards** (from `categories`, that order). Each card: category name, an **availability light — 🟢 if (AVAILABLE ∧ READY) count ≥ 2, 🟡 if exactly 1, 🔴 if 0** — and a sub-line `N ready · N in prep · N down · N reserved · N on rent` **· `N to pick up` when non-zero (D32, from `pickups[]`)** (D25 — reserved = `unit_state: RESERVED`, never counted available; on-rent count rendered in the blue of its chip). Kevin reads the color; techs read the sub-line. Compute counts client-side from `units`. **D28: `RESERVED` means held TODAY** — future holds don't move these counts or the light; they surface as a 📅 chip on unit rows and in the Holds view.
   - **Under the cards: the Shop List (D56).** Heading **"In the shop"**. Every on-hand unit (D18 states only) whose `readiness` is NEEDS-PREP or DOWN, prep group first, oldest first inside each group by `readiness_age_days` (nulls last, serial as tiebreak). No group headers — the readiness chip is the group marker; an empty group is simply absent. Row = `unitName` · `unitIds · category` · `unitChips()` (state · readiness · **age** · 🔧 ticket · ⏳ pending) · the `readiness_note` on one ellipsed line. Tap → unit detail. Both groups empty → one quiet line, `Nothing in prep, nothing down.`, not a card. No cap. **D15 is amended, not repealed:** this is a work list, not a totals block, and it sits below the cards so the lights read first. **D54 holds — machines, never people.**
2. **Category → unit list** (chips: state always; readiness ONLY for on-hand states AVAILABLE/RESERVED/IN-SHOP — out states ON-RENT/ON-DEMO/LOANER-OUT show the blue state chip alone, D18 — **except `NEEDS-PICKUP`, which renders as an orange chip on any state (D32)**; serial, location) — **out units show `customer` before the job site on the row (D33)** **→ unit detail** (everything: specs, **ask only — no cost, no book (D45)**, the rate card incl. the D31 long-term sub-block, agreement + rate + last-invoiced period, **the hold list with a Release button per hold (**except `agmt:` holds — D64 — no Release; caption "clears itself on delivery"**)**, readiness note, hours — **no floor price, D16**). Two levels, never more. A **Holds view** (chronological; expired block first, loud) hangs off the nav — see [[Reservations-v2-Site-Spec]]. **No fleet-totals block on the landing page (D15)** — category cards only.
3. **Rentals view:** **top of the page (D21, moved here from the retired Billing view — D39):** recurring-revenue total — sum `cycle_rate` over agreements with `cycle == "28D"` and not at `cycles_max`; headline "Recurring revenue — per 28-day cycle", sub-line "≈ $X / month" (× 365⁄28 ÷ 12, rounded to the dollar). Client-computed. **v3.5 (D64): sum only `status ∈ {ACTIVE, OFF-RENT}`.** Below it, the `agreements` array in **three groups — Pending · On rent · Off-rent** (by `status`; legacy rows without `status` read as ACTIVE) — customer, unit, R-number, rate, `next_due`, cycles billed/max, `days_on_rent`, **due back = `in_date` drawn loud**, lead chip, docs; `agreement: null` and any `alerts` rendered loud. Tile actions per [[Rental-Lifecycle-Site-Spec]] §3: **Off-rent** (ACTIVE), **Went out** (PENDING + CUSTOMER-PICKUP), **Back in shop** (OFF-RENT + CUSTOMER-RETURN; owner override on PICKUP). (No Billing view exists as of v1.6.)
3b. **Dispatch view (D38 — replaces Billing in the nav):** `dispatch[]` in three sections — Open → Scheduled (by date, driver + rig) → Done this week (collapsed). Claim (driver / rig / date) · Done · Add a run · Cancel (owner, MANUAL only). Same-rig-same-day = inline warning, never a block. The NEEDS-PICKUP block lives here now; nav badge = OPEN + SCHEDULED count. Full spec: [[Service-Dispatch-Site-Spec]] §4.
4. **Service view:** top = the fleet status board (D20): six bar gauges, mutually exclusive, summing to 100% of non-retired units — ON-RENT (blue) · ON-DEMO (light blue) · LOANER-OUT (slate) · on-hand (AVAILABLE/RESERVED/IN-SHOP) split by readiness: READY (green) · NEEDS-PREP (yellow) · DOWN (red). Each row: label · count · % bar; zero rows still render (stable layout). Below it: **+ New ticket** (any role), then the kanban — nine columns by `stage` (six under the Fleet chip — NEEDS-QUOTE + WAITING-ON-CUSTOMER + READY-TO-INVOICE never apply to our own machines; D47); chips **All · Fleet · Customer** select the widget zone (D43): All = Fleet Status board + Service Pipeline widget, Fleet = board only, Customer = pipeline only; ticket detail with the stage picker (NEEDS-QUOTE + WAITING-ON-CUSTOMER + READY-TO-INVOICE hidden for `machine_owner: WSS`; COMPLETE on a `machine_owner: CUSTOMER` ticket is `owner`-ROLE only), notes, assign, schedule, and the ticket's dispatch rows. Full spec: [[Service-Dispatch-Site-Spec]] §3.
5. **Persistent header:** `published_at` as "data as of …" + pending-events count (from `/api/health`), so nobody trusts a stale board unknowingly. If the snapshot is > 36h old, show a subtle ⚠️.

## Token + PWA plumbing (traps — read twice)

- Boot (D24 — supersedes the original strip design): read `?t=` → save to `localStorage`. **Do NOT strip it from the address bar.** If the URL has no `?t=` but localStorage has a token, `history.replaceState` the token INTO the URL — bookmarks made at any moment must capture it (iOS purges regular-site storage; the URL is the durable carrier, storage is the backup). No token anywhere → friendly "ask Matt for your link" screen, no data fetched.
- **`manifest.webmanifest` `start_url` cannot contain per-user tokens** (one static manifest for everyone). `start_url: "./"` + the localStorage token makes add-to-home-screen work after first tokened visit. Test the full install flow on iOS Safari specifically — that's what the crew carries.
- **Service worker: cache the shell only, network-first for `/api/*`.** An over-eager SW serving stale fleet data is worse than no SW. Version the cache; on activate, purge old versions.
- GitHub Pages + custom domain serves at the domain **root**; while testing pre-DNS at `mlancourt.github.io/<repo>/` you're on a subpath — use **relative paths everywhere** (no leading-slash asset URLs) so both work.

## Build order — milestones with exit criteria

- **M0 — shell on mock.** `make-mock-data.js` emits a fake-but-shaped snapshot (fake customers like "Acme Foods", fake serials, all 9 categories, every unit_state + readiness represented, an `agreement: null` orphan, a `.1` invoice, a LOANER-OUT with no agreement row, empty + non-empty service queue variants). Page renders all views from a local file. *Exit: every view renders both mock variants; zero console errors.*
- **M1 — Worker.** `wrangler dev` locally: publish mock via `/api/admin/publish`, page reads `/api/data` with a test token, event POST → `evt:` key → `admin/events` → `ack` round-trip proven. *Exit: full loop green locally, curl-scripted in README.*
- **M2 — deploy real.** Worker to Cloudflare (Matt: `wrangler login`, create KV `fleet-dashboard`, `wrangler secret put ADMIN_SECRET`), Pages on `/docs`, Matt issues 4 real tokens (README: `openssl rand -hex 16`) and loads them via `/api/admin/tokens`. Engine (not you) publishes the real snapshot. *Exit: Matt opens his tokened URL on his phone and sees the real fleet.*
- **M3 — domain + PWA.** Add `docs/CNAME`, Matt sends Machinio the one-liner (`CNAME fleet → mlancourt.github.io`), enforce HTTPS in Pages settings, update Worker CORS, verify add-to-home-screen on iPhone + Android. *Exit: `fleet.wisconsinscrubandsweep.com` installs as an app.*
- **M4 — the write spike (Phase 1 exit).** Reserve button live for Kevin's token. Kevin reserves a unit from his phone; event lands in KV; the engine drains + applies it (their side); next publish shows it applied. *Exit: one write, end-to-end, from Kevin's phone.*

Do them in order. Do not start M2 before M1's curl loop is in the README.

## Ask Matt vs. decide yourself

**Ask Matt:** anything touching money display formats, category names/order, adding any write action beyond the fifteen, anything requiring a new DNS record or a paid plan, repo visibility. **Decide yourself:** all layout/CSS details within the brand, code structure, icon design, copy tone (plain, terse, shop-floor). When the snapshot contract seems wrong or insufficient — **stop and say so**; the contract is owned by "the Architect" on Matt's side and changes there first.
