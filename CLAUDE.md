# WSS Fleet Dashboard — CLAUDE.md

You are building the employee-facing operations website for **Wisconsin Scrub & Sweep (WSS)** — an industrial floor-scrubber dealer in Ixonia, WI. Four users: **Matt** (owner), **Kevin** (sales), **Josh + Zac** (service techs). It shows the rental fleet, active rental agreements, the service queue (customer-owned repairs **and** fleet repairs), and a Dispatch board of truck moves — one pane of glass, phone-first, replacing a $900/yr SaaS (IntegraRental) and, later, Machinio's service module.

**v1.6 (2026-09-03) — schema 3:** Billing tab retired → **Dispatch**; Service tab real; six new write actions. Work order: [[Service-Dispatch-Site-Spec]]. Sections below are updated in place; where a v1.5 rule survives it's unchanged.

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

KV is eventually consistent (~60s cross-edge) — acceptable here; note it in README so nobody "fixes" phantom lag.

## Worker API

Auth: crew endpoints take the token (`?t=` or `Authorization: Bearer`); admin endpoints take `X-Admin-Secret` (Worker secret `ADMIN_SECRET`, set via `wrangler secret put`, local dev via `.dev.vars`). Unknown token/secret → 401 JSON. Never log token values.

| Endpoint | Auth | Behavior |
|---|---|---|
| `GET /api/data` | token | `{me:{name,role}, snapshot:<the JSON>, pending:[events]}` — pending included so the UI can badge unapplied writes |
| `POST /api/event` | token | Validate role + shape (below), stamp `{id, ts, actor, role}` server-side, write `evt:` key. Return the stored event. Reject unknown `action` / malformed `serial` (`serial` is required for reserve/release/readiness, optional for the six schema-3 actions) and any enum value outside the fixed lists in this file; **do not** validate against business state (vault's job). |
| `GET /api/health` | token | `{published_at, pending_count}` |
| `POST /api/admin/publish` | secret | body = full snapshot JSON → validate it parses + has `meta.schema_version`, write `snapshot` |
| `GET /api/admin/events` | secret | list + return all `evt:*` (id, key, event) |
| `POST /api/admin/events/ack` | secret | `{ids:[...]}` → delete those keys only. **Never bulk-delete all events** — new events can land mid-run. |
| `POST /api/admin/tokens` | secret | replace the `tokens` map (how Matt issues/rotates) |

CORS: allow origins `https://fleet.wisconsinscrubandsweep.com` and `https://mlancourt.github.io` (pre-DNS testing), plus `http://localhost:*` in dev. Handle preflight.

## Write model (nine actions as of schema 3 — exactly these, nothing more)

Roles: `owner` (Matt — all writes) · `sales` (Kevin — reserve/release) · `service` (Josh, Zac — readiness, ticket stages). **Schema 3 adds:** `ticket_open`, notes/assign/schedule via `ticket_update`, and `dispatch_add` / `dispatch_claim` / `dispatch_done` for **any role**; ticket *stage* changes for `service`/`owner`; `dispatch_cancel` for `owner`. `serial` is optional on the six new actions. Everyone **reads everything** including cost/book/ask (D12, as amended by D16: floor price no longer exists in the snapshot at all).

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
```

UI rules: **Reserve is offered on any non-RETIRED unit** (D28 — a machine out on rent today can carry future holds; label it "Reserve for later" when it's out). `start` defaults to today, `end` to **start + 5 business days** (skip Sat/Sun). `release` **must carry the `hold_id`** of the row being released — the engine rejects an ambiguous release on a multi-hold unit. Readiness toggle available on any unit for `service`/`owner`; the picker offers all four values, with `NEEDS-PICKUP` labeled "Needs pick-up" (D32 — see [[Needs-Pickup-Site-Spec]]). After a POST, badge the unit "⏳ pending" from the `pending` array and show "applies at the next run" once. Full v2 reservation UI spec: **[[Reservations-v2-Site-Spec]]** (the work order Matt pastes for this rebuild).

## Snapshot contract — `dashboard-data.json` (schema_version 3)

The engine emits this; you consume it and also generate FAKE versions of it in `make-mock-data.js`. Never require fields beyond this contract; tolerate unknown extra fields silently (forward compatibility).

```jsonc
{
  "meta": { "schema_version": 3, "generated_at": "<UTC ISO>", "run_id": "…",
            "fleet_totals": { "units": 39, "cost": 0, "book": 0, "ask": 0 } },   // meta only — NOT rendered on the landing page (D15); no floor anywhere (D16)
  "categories": ["…9 rental-rate-matrix band names, display order…"],
  "units": [ {
    "serial": "150074", "asset_item": "…", "brand": "…", "model": "…", "description": "…",
    "category": "…", "status": "RENTAL|LOANER",
    "unit_state": "AVAILABLE|RESERVED|ON-RENT|ON-DEMO|LOANER-OUT|IN-SHOP",   // RETIRED units are NOT emitted (D34) — keep the enum value tolerated, never expect it
    "readiness": "READY|NEEDS-PREP|DOWN|NEEDS-PICKUP", "readiness_note": null, "hours": null,   // NEEDS-PICKUP (D32): customer released an OUT unit — techs fetch it
    "in_service": "YYYY-MM-DD", "acquisition_cost": 0,
    "book": 0, "ask": 0,                         // engine-computed fresh each run — display only. NO floor field (D16): floor is engine-internal and never ships in the snapshot.
    "rate_card": { "monthly": null, "full_day": null, "weekend": null, "weekly": null,
                   "long_term_6mo": null, "long_term_12mo": null },
                  // D23: all rates are the category's published matrix rates, verbatim — category-uniform, populated
                  // in practice; render "—" only as a guard. D31: long_term_* = per-28-day-cycle rate under a signed
                  // 6-/12-month commitment (≈25%/50% off monthly, rounded to $5 in the vault — NEVER compute client-side).
                  // Unit-page rate card only, under a "Long-term (signed commitment)" sub-block, no caveat text —
                  // see [[Long-Term-Rates-Site-Spec]].
    "job_site": null, "agreement": 4130,         // null when not out
    "customer": "…",                             // D33: who has it — agreement customer (ON-RENT) or loaner placement (LOANER-OUT); null when home or on demo
    // D26 — the hold LIST is the truth; [] when unheld; sorted by start; inclusive dates.
    // status is engine-computed: current | future | expired | malformed.
    // RESERVED ⇔ a CURRENT hold on an otherwise-AVAILABLE unit (D28) — a unit with only
    // future holds stays AVAILABLE, and an ON-RENT unit can carry holds. Never infer state
    // from list length.
    "reservations": [ { "id": "h2812b2", "held_by": "Kevin", "customer": "…", "purpose": "…",
                        "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "created": "YYYY-MM-DD",
                        "status": "current" } ],
    "service_ticket": null                       // schema 3: "S1001" when the unit has an OPEN ticket (D35), else null. (The singular `reservation` object is GONE at schema 3.)
  } ],
  "reservations": { "upcoming": [ { "serial","model","category","id","held_by","customer",
                                    "purpose","start","end","status" } ],
                    "expired":  [ { …same shape… } ] },   // D29: expiries are never silent
  "pickups": [ { "serial","model","category","unit_state","job_site","agreement","customer",
                 "billed_through","note" } ],             // D32: out units the customer released — [] when none
  "agreements": [ {
    "agreement": 4130,            // null = unbilled-rental alert (render with a loud ⚠️)
    "customer": "…", "serial": "150074", "cycle": "28D|ONE-SHOT",
    "cycle_rate": 0, "cycles_billed": 10, "cycles_max": null,
    "last_invoiced_period_start": "YYYY-MM-DD", "last_invoiced_period_end": "YYYY-MM-DD",
    "last_invoice": "R4130-10", "next_due": "YYYY-MM-DD",   // engine-computed; null = not billable
    "job_site": "…", "customer_po": null, "alerts": ["…"]
  } ],
  // schema 3 (D35–D38) — full field list + semantics in [[Service-Dispatch-Site-Spec]] §2
  "service_queue": [ { "ticket": "S1001", "status": "OPEN|CLOSED",
    "stage": "RECEIVED|CONTACTED|WAITING-ON-CUSTOMER|WAITING-ON-PARTS|SCHEDULED|IN-PROGRESS|READY-TO-INVOICE|COMPLETE",
    "machine_owner": "CUSTOMER|WSS", "customer": "…", "serial": null, "equipment": "…", "issue": "…",   // machine_owner ≠ the `owner` ROLE
    "priority": "HIGH|MEDIUM|LOW", "site": null, "location": "AT-CUSTOMER|IN-SHOP",
    "intake_move": "NONE|PICKUP|CUSTOMER-DROP", "return_move": "NONE|DELIVER|CUSTOMER-PICKUP",
    "assigned": null, "scheduled": null, "opened": "YYYY-MM-DD", "opened_by": "…",
    "stage_since": "YYYY-MM-DD", "age_days": 0, "quote": null, "parts": null, "machinio_ref": null, "closed": null } ],
  "service_summary": { "open_by_stage": { "RECEIVED": 0, "…all seven stages…": 0, "COMPLETE": 0 }, "open_customer": 0, "open_wss": 0 },   // COMPLETE = closed in the last 7 days
  "dispatch": [ { "id": "m-…", "kind": "PICKUP|DELIVER", "source": "RENTAL-RETURN|SERVICE-IN|SERVICE-OUT|MANUAL",
    "serial": null, "ticket": null, "what": "…", "customer": "…", "address": "…", "date": null, "billed_through": null,
    "driver": null, "rig": null, "status": "OPEN|SCHEDULED|DONE", "note": null, "done": null } ],
  "dispatch_warnings": [ { "rig": "…", "date": "YYYY-MM-DD", "ids": ["m-…"] } ],   // same rig + date, >1 SCHEDULED row — warn, never block
  // `billing` is NOT rendered as of v1.6 (D39) — it stays in the snapshot for the engine's own consumers. Ignore it.
  "billing": { "due_next_7_days": [ { "agreement": 4130, "customer": "…", "serial": "…",
                 "amount": 0, "due": "YYYY-MM-DD" } ],
               "created_last_run": [ { "invoice": "R4130-11", "agreement": 4130, "customer": "…",
                 "amount": 0, "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD" } ] }
}
```

Notes you must honor: invoice numbers look like `R<agmt>-<cycle>` and occasionally `R4204-1.1` (split cycles) or a bare QBO number like `519665` — treat as opaque strings, never parse. Loaner placements appear as units with `unit_state: LOANER-OUT`, `agreement: <n>` and **no matching entry in `agreements`** — that's correct, render the unit's placement without a billing row. `service_queue` may be `[]` (empty-state must render). CLOSED tickets and DONE dispatch rows linger 7 days in the snapshot so "done this week" is visible.

## UI spec (decisions D11/D12 — locked)

Brand: WSS maroon `#B71C1C`, white, near-black. Clean, big tap targets, gloves-on friendly. Responsive; design at 390×844 first, desktop is a bonus.

0. **Landing top: fleet-utilization bar (D19).** One thin horizontal bar, client-computed: ON-RENT units ÷ units with `status: "RENTAL"` and `unit_state != "RETIRED"`. Shows the % + a word label; fill color by band: 0–29 red "Low" · 30–60 yellow "Building" · 61–80 green "Healthy" · 81–100 red "Over-extended". Must read well at phone width and desktop.
1. **Landing = 9 category cards** (from `categories`, that order). Each card: category name, an **availability light — 🟢 if (AVAILABLE ∧ READY) count ≥ 2, 🟡 if exactly 1, 🔴 if 0** — and a sub-line `N ready · N in prep · N down · N reserved · N on rent` **· `N to pick up` when non-zero (D32, from `pickups[]`)** (D25 — reserved = `unit_state: RESERVED`, never counted available; on-rent count rendered in the blue of its chip). Kevin reads the color; techs read the sub-line. Compute counts client-side from `units`. **D28: `RESERVED` means held TODAY** — future holds don't move these counts or the light; they surface as a 📅 chip on unit rows and in the Holds view.
2. **Category → unit list** (chips: state always; readiness ONLY for on-hand states AVAILABLE/RESERVED/IN-SHOP — out states ON-RENT/ON-DEMO/LOANER-OUT show the blue state chip alone, D18 — **except `NEEDS-PICKUP`, which renders as an orange chip on any state (D32)**; serial, location) — **out units show `customer` before the job site on the row (D33)** **→ unit detail** (everything: specs, cost/book/ask, the rate card incl. the D31 long-term sub-block, agreement + rate + last-invoiced period, **the hold list with a Release button per hold**, readiness note, hours — **no floor price, D16**). Two levels, never more. A **Holds view** (chronological; expired block first, loud) hangs off the nav — see [[Reservations-v2-Site-Spec]]. **No fleet-totals block on the landing page (D15)** — category cards only.
3. **Rentals view:** **top of the page (D21, moved here from the retired Billing view — D39):** recurring-revenue total — sum `cycle_rate` over agreements with `cycle == "28D"` and not at `cycles_max`; headline "Recurring revenue — per 28-day cycle", sub-line "≈ $X / month" (× 365⁄28 ÷ 12, rounded to the dollar). Client-computed. Below it, the `agreements` array — customer, unit, rate, `next_due`, cycles billed/max; `agreement: null` and any `alerts` rendered loud. (No Billing view exists as of v1.6.)
3b. **Dispatch view (D38 — replaces Billing in the nav):** `dispatch[]` in three sections — Open → Scheduled (by date, driver + rig) → Done this week (collapsed). Claim (driver / rig / date) · Done · Add a run · Cancel (owner, MANUAL only). Same-rig-same-day = inline warning, never a block. The NEEDS-PICKUP block lives here now; nav badge = OPEN + SCHEDULED count. Full spec: [[Service-Dispatch-Site-Spec]] §4.
4. **Service view:** top = the fleet status board (D20): six bar gauges, mutually exclusive, summing to 100% of non-retired units — ON-RENT (blue) · ON-DEMO (light blue) · LOANER-OUT (slate) · on-hand (AVAILABLE/RESERVED/IN-SHOP) split by readiness: READY (green) · NEEDS-PREP (yellow) · DOWN (red). Each row: label · count · % bar; zero rows still render (stable layout). Below it: **+ New ticket** (any role), then the kanban — seven columns by `stage`, filter All / Customer / Fleet; ticket detail with the stage picker (WAITING-ON-CUSTOMER + READY-TO-INVOICE hidden for `machine_owner: WSS`; COMPLETE on a `machine_owner: CUSTOMER` ticket is `owner`-ROLE only), notes, assign, schedule, and the ticket's dispatch rows. Full spec: [[Service-Dispatch-Site-Spec]] §3.
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

**Ask Matt:** anything touching money display formats, category names/order, adding any write action beyond the nine, anything requiring a new DNS record or a paid plan, repo visibility. **Decide yourself:** all layout/CSS details within the brand, code structure, icon design, copy tone (plain, terse, shop-floor). When the snapshot contract seems wrong or insufficient — **stop and say so**; the contract is owned by "the Architect" on Matt's side and changes there first.
