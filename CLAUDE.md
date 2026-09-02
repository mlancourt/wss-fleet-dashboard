
# WSS Fleet Dashboard — CLAUDE.md

You are building the employee-facing operations website for **Wisconsin Scrub & Sweep (WSS)** — an industrial floor-scrubber dealer in Ixonia, WI. Four users: **Matt** (owner), **Kevin** (sales), **Josh + Zac** (service techs). It shows the rental fleet (39 machines), active rental agreements (19), a service queue, and upcoming billing — one pane of glass, phone-first, replacing a $900/yr SaaS (IntegraRental).

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
| `POST /api/event` | token | Validate role + shape (below), stamp `{id, ts, actor, role}` server-side, write `evt:` key. Return the stored event. Reject unknown `action`/`serial` shape; **do not** validate against business state (vault's job). |
| `GET /api/health` | token | `{published_at, pending_count}` |
| `POST /api/admin/publish` | secret | body = full snapshot JSON → validate it parses + has `meta.schema_version`, write `snapshot` |
| `GET /api/admin/events` | secret | list + return all `evt:*` (id, key, event) |
| `POST /api/admin/events/ack` | secret | `{ids:[...]}` → delete those keys only. **Never bulk-delete all events** — new events can land mid-run. |
| `POST /api/admin/tokens` | secret | replace the `tokens` map (how Matt issues/rotates) |

CORS: allow origins `https://fleet.wisconsinscrubandsweep.com` and `https://mlancourt.github.io` (pre-DNS testing), plus `http://localhost:*` in dev. Handle preflight.

## Write model (v1 scope — exactly this, nothing more)

Roles: `owner` (Matt — all writes) · `sales` (Kevin — reserve/release) · `service` (Josh, Zac — readiness). Everyone **reads everything** including cost/book/ask (decision D12 — deliberate; don't "protect" fields).

Event shapes (client sends `action`, `serial`, `payload`; server stamps the rest):

```json
{"action":"reserve",  "serial":"150074", "payload":{"customer":"...", "purpose":"...", "start":"YYYY-MM-DD", "end":"YYYY-MM-DD"}}
{"action":"release",  "serial":"150074", "payload":{"hold_id":"h2812b2"}}
{"action":"readiness","serial":"150074", "payload":{"readiness":"READY|NEEDS-PREP|DOWN", "note":"..."}}
```

Reservations v2: `start`/`end` are an inclusive window (a one-day hold has `start == end`); the legacy `until` is still accepted by the engine as `end` but new code never sends it. `release` always sends the row's `hold_id` — the engine rejects an ambiguous release on a multi-hold unit. Worker validates shape only, never business state (overlaps are the engine's call, reported in the run report).

UI rules: Reserve offered on **any non-RETIRED unit in any state** (labelled "Reserve for later" on an out unit); `start` defaults to today, `end` to **start + 5 business days** (skip Sat/Sun), with a "1 day" quick-set; client validates only `end ≥ start` and `end ≥ today`, and shows a **non-blocking** overlap hint against holds already in the snapshot. Readiness toggle available on any unit for `service`/`owner`. After a POST, badge from the `pending` array: a `reserve` badges the unit "⏳ hold pending — applies at the next run"; a `release` badges that hold row (never removes it). Nothing a crew member types is truth until the engine says so.

## Snapshot contract — `dashboard-data.json` (schema_version 2)

The engine emits this; you consume it and also generate FAKE versions of it in `make-mock-data.js`. Never require fields beyond this contract; tolerate unknown extra fields silently (forward compatibility).

```jsonc
{
  "meta": { "schema_version": 2, "generated_at": "<UTC ISO>", "run_id": "…",
            "fleet_totals": { "units": 39, "cost": 0, "book": 0, "ask": 0 } },   // no floor (D16)
  "categories": ["…9 rental-rate-matrix band names, display order…"],
  "units": [ {
    "serial": "150074", "asset_item": "…", "brand": "…", "model": "…", "description": "…",
    "category": "…", "status": "RENTAL|LOANER",
    "unit_state": "AVAILABLE|RESERVED|ON-RENT|ON-DEMO|LOANER-OUT|IN-SHOP|RETIRED",
    "readiness": "READY|NEEDS-PREP|DOWN", "readiness_note": null, "hours": null,
    "in_service": "YYYY-MM-DD", "acquisition_cost": 0,
    "book": 0, "ask": 0,                        // engine-computed fresh each run — display only; no floor (D16)
    "rate_card": { "full_day": null, "weekend": null, "weekly": null, "monthly": null },   // D17; any may be null
    "job_site": null, "agreement": 4130,         // null when not out
    "reservations": [                            // v2 — THE TRUTH. Sorted by start; [] when unheld.
      { "id": "h2812b2", "held_by": "Kevin", "customer": "…", "purpose": "…",
        "start": "YYYY-MM-DD", "end": "YYYY-MM-DD",   // inclusive; one-day hold has start == end
        "created": "YYYY-MM-DD", "status": "current|future|expired|malformed" } ],   // engine-computed
    "reservation": { "held_by": null, "purpose": null, "customer": null, "until": null },  // DEPRECATED mirror; never read it; gone at schema 3
    "service_ticket": null
  } ],
  "reservations": {                              // v2 rollup for the Holds view
    "upcoming": [ { "serial": "…", "model": "…", "category": "…", "id": "…", "held_by": "…", "customer": "…",
                    "purpose": "…", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "status": "current|future" } ],
    "expired":  [ { "…same, minus status": "" } ]
  },
  "agreements": [ {
    "agreement": 4130,            // null = unbilled-rental alert (render with a loud ⚠️)
    "customer": "…", "serial": "150074", "cycle": "28D|ONE-SHOT",
    "cycle_rate": 0, "cycles_billed": 10, "cycles_max": null,
    "last_invoiced_period_start": "YYYY-MM-DD", "last_invoiced_period_end": "YYYY-MM-DD",
    "last_invoice": "R4130-10", "next_due": "YYYY-MM-DD",   // engine-computed; null = not billable
    "job_site": "…", "customer_po": null, "alerts": ["…"]
  } ],
  "service_queue": [ { "ticket_id": "…", "customer": "…", "serial": null, "unit_desc": "…",
    "stage": "INTAKE|DIAGNOSED|AWAITING-PARTS|IN-PROGRESS|READY-TO-INVOICE|DONE",
    "assigned": "…", "opened": "YYYY-MM-DD", "quote": null, "machinio_ref": null } ],
  "billing": { "due_next_7_days": [ { "agreement": 4130, "customer": "…", "serial": "…",
                 "amount": 0, "due": "YYYY-MM-DD" } ],
               "created_last_run": [ { "invoice": "R4130-11", "agreement": 4130, "customer": "…",
                 "amount": 0, "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD" } ] }
}
```

Hold state rules (engine-owned — never reimplement): `unit_state: RESERVED` means a hold is **current right now** on an otherwise-available unit; a unit with only future holds stays **AVAILABLE** (lights and counts must say so). Holds are legal on any non-RETIRED unit in any state — an ON-RENT machine can carry future holds; out-states win the chip, the hold list is the calendar. **`reservations.length > 0` never implies RESERVED.** Overlaps are impossible by construction (engine rejects, run report says so). An expired hold still holds the unit until a human releases or extends it — render expired holds loud.

Notes you must honor: invoice numbers look like `R<agmt>-<cycle>` and occasionally `R4204-1.1` (split cycles) or a bare QBO number like `519665` — treat as opaque strings, never parse. Loaner placements appear as units with `unit_state: LOANER-OUT`, `agreement: <n>` and **no matching entry in `agreements`** — that's correct, render the unit's placement without a billing row. `service_queue` may be `[]` for a while (that module seeds later) — the tab still renders, empty-state included.

## UI spec (decisions D11/D12 — locked)

Brand: WSS maroon `#B71C1C`, white, near-black. Clean, big tap targets, gloves-on friendly. Responsive; design at 390×844 first, desktop is a bonus.

1. **Landing = fleet-utilization bar + 9 category cards.** Utilization (D19, client-computed): ON-RENT ÷ (units with `status: RENTAL` and `unit_state != RETIRED`) — demos and loaner-outs are not in the numerator. One thin bar, whole-% and a mandatory word label, fill by band on the rounded %: <30 red "Low" · 30–60 yellow "Building" · 61–80 green "Healthy" · >80 red "Over-extended". Then the cards (from `categories`, that order). Each card: category name, an **availability light — 🟢 if (AVAILABLE ∧ READY) count ≥ 2, 🟡 if exactly 1, 🔴 if 0** — and a sub-line `N ready · N in prep · N down · N reserved · N on rent` (reserved = `unit_state: RESERVED`, its own chip, never counted available; on rent = `unit_state: ON-RENT`, rendered in the ON-RENT chip blue — D25; light math unchanged). Kevin reads the color; techs read the sub-line. Compute counts client-side from `units` — **on-hand math only: ready/prep/down count AVAILABLE, RESERVED, IN-SHOP (D18)**. **Category cards only — no fleet-totals block on the landing page (D15).**
2. **Category → unit list** (top line = make & model, e.g. "Factory Cat Model 34"; sub-line = serial · asset # · location; chips for state + readiness — **readiness chip only for on-hand states AVAILABLE/RESERVED/IN-SHOP; out states ON-RENT/ON-DEMO/LOANER-OUT show the state chip alone, everywhere (D18)**; plus a small **📅 N** chip when the unit has N future holds — "available, but spoken for Tuesday") **→ unit detail** (everything: specs, cost/book/ask — **no floor price (D16)**, agreement + rate + last-invoiced period, a **Holds** section listing every entry in `reservations` with a status pill — solid maroon HELD NOW · outline start-date for future · red EXPIRED — release or extend · grey ⚠ bad dates — and a per-row Release button for sales/owner; "No holds." when empty; readiness note, hours). Two levels, never more.
3. **Holds view** (tab next to Rentals): from the top-level `reservations` rollup — an **Expired holds — release or extend** block first (red, only when non-empty), then upcoming grouped by start date, each row = window · unit (serial + model, tap → unit detail) · customer · purpose · held by. Empty: "Nothing on hold."
3b. **Rentals view:** the `agreements` array — customer, unit, rate, `next_due`, cycles billed/max; `agreement: null` and any `alerts` rendered loud. **Billing view** (titled "Cycle (Periodic) Invoicing"): recurring-revenue card on top (D21: Σ `cycle_rate` over `cycle == "28D"` rows still running — `cycles_max` null or `cycles_billed < cycles_max`; headline "Recurring revenue — per 28-day cycle", never "monthly"; "across N agreements"; "≈ $X / month" = total × 365 ÷ 28 ÷ 12, whole dollars), then `billing.due_next_7_days` + `billing.created_last_run` ("created last night — awaiting Matt").
4. **Service view:** fleet status board on top (D20) — six mutually exclusive bar gauges over the non-retired fleet, summing to 100%: ON-RENT (blue) · ON-DEMO (lighter blue) · LOANER-OUT (slate) · READY / NEEDS-PREP / DOWN (green / yellow / red; on-hand states AVAILABLE/RESERVED/IN-SHOP by readiness). Each row: label · count · thin % bar; zero rows still render, greyed. Then kanban columns by `stage`.
5. **Persistent header:** `published_at` as "data as of …" + pending-events count (from `/api/health`), so nobody trusts a stale board unknowingly. If the snapshot is > 36h old, show a subtle ⚠️.

## Token + PWA plumbing (traps — read twice)

- Boot (D24): read `?t=` → save to `localStorage` — **do not strip it from the address bar; the URL is the durable carrier, storage is the backup.** If the URL lacks `?t=` but storage holds a token, `history.replaceState` the token back into the URL. All API calls send the token as a Bearer header. No token anywhere → friendly "ask Matt for your link" screen, no data fetched. (Stripping broke bookmarks of the stripped URL, and iOS purges a regular site's storage.)
- **`manifest.webmanifest` has NO `start_url` — deliberately.** A static `start_url: "./"` launches the home-screen app tokenless, and on iOS a home-screen web app has its **own storage, separate from Safari's**, so the token saved in Safari is never there to restore (this was the live bug behind D24). With `start_url` omitted, iOS launches the exact URL the icon was added from — which carries `?t=` (D24). Users must add to home screen from a page whose address bar shows `?t=`. Android Chrome then offers "Add to Home screen" (a shortcut to the tokened URL) rather than a full "Install app"; acceptable. Test the full install flow on iOS Safari specifically — that's what the crew carries.
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

**Ask Matt:** anything touching money display formats, category names/order, adding any write action beyond the three, anything requiring a new DNS record or a paid plan, repo visibility. **Decide yourself:** all layout/CSS details within the brand, code structure, icon design, copy tone (plain, terse, shop-floor). When the snapshot contract seems wrong or insufficient — **stop and say so**; the contract is owned by "the Architect" on Matt's side and changes there first.
