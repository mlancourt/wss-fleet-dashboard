# WSS Fleet Dashboard — ops runbook

Employee-facing operations board for **Wisconsin Scrub & Sweep**: rental fleet,
active agreements, the service queue, and a Dispatch board of truck moves.
Phone-first, four users (Matt, Kevin, Josh, Zac).

**v2.8 (schema 6 / S2)** — **upload from the phone.** 📷 Photo and 📎 File on
ticket and lead detail, any role: the file goes to `POST /api/doc` (bytes only,
no id — the Worker hashes them), then a `doc_attach` event carries the id. Photos
are resized client-side to 1600 px at JPEG q0.7 with EXIF applied; **PDFs pass
through untouched**. A failed send is one tap from a retry off the blob still in
memory — **no queue, no background sync, nothing persisted**, and the copy says
so. The record binding rides in `docmeta`, so a lost event is never a lost
document.

**v2.7 (schema 6)** — **document attachments, read path.** `service_queue[]`,
`leads[]` and `agreements[]` each gain `docs[]` (`{id, name, kind, bytes,
added}`); ticket and lead detail render a **Documents** group above the Notes
timeline and a tap opens the file in a new tab straight from the Worker. Five
new Worker endpoints back it — see "Documents" below. **A doc id IS the content:
the first 16 hex of `sha256(bytes)`**, verified on every write. Docs are never
stripped and never role-gated. Uploading from a phone is S2 and is not built.

**v2.4 / v2.5** — `service_queue[].log[]` and `leads[].log[]` (the ticket/lead
body as `{ts, who, text}`, last 30, oldest first) render as a **Notes** timeline
in ticket and lead detail, this session's unapplied notes closing it. `ts` is a
display string the engine already formatted for Central — rendered verbatim,
never `Date`-parsed. Lead logs are **money-free by contract** (v2.5): the engine
writes `value set` / `value updated` and its builder refuses to publish a row
carrying a figure, so nothing is stripped and a tech keeps their own lead notes.
`npm run money-gate` holds that promise to account.

**v2.2 (schema 5)** — a **Leads** tab: pipeline board, sales scoreboard and
90-day insights, plus `lead_open` / `lead_update` / `lead_close`. Lead money is
stripped **at the Worker** for a `service` token — see "The money gate" below;
it is not a CSS rule and must never become one.

**D47** — ninth service stage **`NEEDS-QUOTE`**, between CONTACTED and
WAITING-ON-CUSTOMER: the tech has diagnosed it and Matt owes the customer a
number. WSS-owned tickets never take it (nobody quotes us to us), so the Fleet
chip still shows six columns while Customer and All show nine.

**v1.9 (schema 4, D45)** — `acquisition_cost` and `book` no longer ship in the
snapshot and are shown nowhere on the site; `ask` stays. `meta.fleet_totals` is
a unit count only, and the engine publishes `meta.utilization` (percentages and
an exclusion count — **never amounts**). The utilization card reads those when
present and falls back to computing them from `units[]` on a schema-3 snapshot.

**v1.6 (schema 3)** — the Billing tab is retired: its recurring-revenue block
moved to the top of Rentals and its nav slot became **Dispatch**. The Service
tab is real (a nine-stage kanban since D47, ticket detail, `+ New ticket`). Six
new write actions brought the total to nine, and schema 5 took it to twelve.
`snapshot.billing` still arrives and is deliberately never rendered.

**This repo is the presentation + transport layer only.** The vault + run engine
(owned elsewhere) is the source of truth. It publishes a snapshot to the Worker
and drains pending write-events from it. See `CLAUDE.md` for the full brief and
the hard rules — read it before changing anything here.

> **No real data in this repo, ever.** It is public. No customer names, prices,
> costs, serials, tokens, or real `dashboard-data.json`. Every byte of test data
> comes from `tools/make-mock-data.js`, which invents all of it.

---

## Status

| Milestone | State | Exit criteria |
|---|---|---|
| **M0 — shell on mock** | ✅ done | every view renders both mock variants, zero console errors |
| **M1 — Worker** | ✅ done | full publish → read → event → ack loop green locally, curl-scripted below |
| **M2 — deploy real** | ✅ done | Matt opens his tokened URL on his phone and sees the real fleet |
| **M3 — domain + PWA** | ✅ live (Sep 2, 2026) | `fleet.wisconsinscrubandsweep.com` installs as an app |
| **v1.6 — Service + Dispatch** | ✅ built on mock (Sep 3, 2026) | all nine actions round-trip locally; see `BUILD-NOTES.md` |
| **v2.2 — Leads (schema 5)** | ✅ built (Sep 4, 2026) | three lead actions round-trip; the §6 money gate proven by curl; see `BUILD-NOTES.md` |
| **D47 — NEEDS-QUOTE stage** | ✅ built (Sep 4, 2026) | a customer ticket moves to NEEDS-QUOTE end to end; Fleet still six columns |
| **v2.4 — Notes timeline** | ✅ built (Sep 4, 2026) | real `log[]` rows render on ticket + lead detail |
| **v2.5 — lead logs money-free** | ✅ built (Sep 4, 2026) | service strip reversed; `npm run money-gate` green on the real snapshot |
| **v2.7 — documents S1 (schema 6)** | ✅ built (Sep 8, 2026) | a real PDF round-trips through `npm run m1`; the hash check refuses a mismatched id |
| **v2.8 — documents S2 (upload)** | ✅ built (Sep 8, 2026) | a phone-shaped upload + `doc_attach` round-trips through `npm run m1`; the resize is asserted in `npm test` |
| M4 — write spike | ⬜ | Kevin reserves a unit from his phone, end to end |

Do them in order. **Do not start M2 before M1's curl loop is in this README.**

---

## Quickstart

```bash
npm start
```

Then open:

| URL | What you get |
|---|---|
| `http://localhost:8787/?mock=full` | schema 4 — full service queue + dispatch board |
| `http://localhost:8787/?mock=empty` | schema 4 — `service_queue: []`, `dispatch: []` (empty states) |
| `http://localhost:8787/?mock=legacy` | schema 2 — the pre-Dispatch snapshot; carries `acquisition_cost`/`book` and no `meta.utilization`, so it also exercises the client-side utilization fallback |
| `http://localhost:8787/` | the no-token gate ("ask Matt for your link") |

`mock-legacy.json` exists for **one release**. Once the engine is publishing
schema 4 for real and Matt has signed off, delete it, drop `'legacy'` from
`MOCK_VARIANTS` in `docs/api.js`, and drop the legacy case from
`selftest-render.mjs`.

There is **no build step**. Vanilla HTML/CSS/JS, ES modules. `node` is used only
for the generators and tests; nothing compiles the page.

### Mock-only URL knobs

These work in `?mock=` mode only, so states the snapshot can't express are still
reviewable. **Mock mode itself only exists on localhost or in a build with no
`API_BASE`** — on a real host with the Worker wired, `?mock=`, `&role=`,
`&pending=` and `&age=` are inert and identity comes solely from the server's
`me.role`. `tools/selftest-api.mjs` asserts this.

| Param | Effect |
|---|---|
| `&pending=1` | loads sample unapplied events → ⏳ pending badges |
| `&age=48` | backdates `generated_at` 48h → the >36h ⚠️ stale warning |
| `&role=sales` | pretend to be sales / service / owner → which write buttons appear |

Example: `http://localhost:8787/?mock=full&pending=1&age=48&role=sales`

### Regenerate the fakes

```bash
npm run mock
```

`docs/mock/*.json` are committed so the page works with no toolchain. Regenerate
after changing the generator. Dates are relative to today, so the files change
whenever you re-run — that's expected.

### Tests

```bash
npm test
```

Eight suites, ~155 checks. `selftest-render.mjs` boots the **real** `app.js` in
a stub DOM and renders every route against all three mock variants as all three
roles, failing on a thrown view, a leaked `undefined`, or a date-only string
that got `Date`-parsed. `selftest-service.mjs` pins the schema-3 rules: stage
gating, kanban columns, dispatch ordering, the same-rig-same-day warning.
`selftest-leads.mjs` pins the schema-5 ones, and above all the rule that lead
money is **absent, not zero** for a `service` token — see the money gate below.
`selftest-holds.mjs` covers Reservations v2 and `selftest-metrics.mjs` the D19
/ D20 / D21 math. `selftest-api.mjs` proves the mock knobs are inert in production
(role from the server only, no mock file fetched, snapshot untouched, token in
the header not the URL). `selftest-dates.mjs` guards the one bug class
`CLAUDE.md` calls disqualifying: business dates are
date-only Central strings, and `new Date("YYYY-MM-DD")` parses as UTC midnight,
showing Central users **yesterday**. All date handling lives in `docs/dates.js`
(pure, no DOM) so it can be asserted directly. Run it under a hostile timezone
too:

```bash
TZ=Pacific/Pago_Pago npm test
```

### Smoke a real snapshot

```bash
node tools/smoke-real.mjs ~/.wss-runs/real-snapshot-schema5.json
```

Renders every view against a **real** published snapshot without copying one
into this repo — the file is read from the path you give and served to the app
from memory. Use it after any schema bump: the mock generator only produces
what we thought to write, and this is what catches the rest. It does not test
the money gate; that is Worker behaviour, proven by the curl check in
`npm run m1`.

### The money gate (schema 5, spec §6) — not optional

`GET /api/data` strips lead money **at the edge** for a `service` token, before
the bytes leave the Worker: `value` and `potential_commission` off every
`leads[]` row, plus `leads_summary.commission_rates`, `leads_summary.money_fields`
and `scoreboard.money`. `insights` is untouched — `won_value` there is deal
size, not anybody's pay — and so are **ticket** logs.

**Lead logs are not stripped, and must not be.** v2.4 did strip them, because
the engine was writing `value → $X` into that free text and shipping the
sentence would have defeated the gate one field over. v2.5 fixed it upstream
instead: a lead log row reads `value set`, and the builder refuses to publish
one carrying a figure. That is a better fix — a tech keeps the lead notes they
are allowed to write, and the guarantee lives in the data rather than in a
regex over free text. If a figure ever reappears in a lead log, **fix the
engine**; do not re-add a strip or a redaction here.

What the gate does **not** promise: that no dollar sign appears anywhere under
`leads[]`. `machine` and `close_note` are free text a person types, and they
legitimately carry a customer's stated budget or a competitor's price. Those are
not our deal value and not anybody's commission.

Privacy by contract, not by CSS. A number the page merely declines to draw is
still sitting in the response for anyone who opens a network tab; that was the
D45 lesson and this is the same rule applied to commission. The page's own
guards exist so the layout is right, **not** as the control.

The check runs inside `npm run m1`, and is worth running by hand after any
Worker deploy:

```bash
curl -s "$WORKER/api/data" -H "Authorization: Bearer $SERVICE_TOKEN" \
  | grep -c potential_commission      # must print 0
```

If that ever prints anything but `0`, stop and fix the Worker — do not "fix" it
in the page.

For the whole gate against a **real** snapshot, end to end through a running
Worker:

```bash
npm run dev:worker                                   # in another terminal
ADMIN_SECRET=… npm run money-gate -- ~/.wss-runs/real-snapshot-schema5.json
```

It publishes the file you name, checks all three roles — including that no
lead-log row matches `/\$\s?\d/` — and restores the mock snapshot afterwards
so no real data is left in the KV it touched. Nothing is written to disk, and
the tool carries no data of its own.

### Documents (schema 6)

The vault is the archive. **The Worker's doc store is a cache** — the engine may
wipe and rebuild it at any time, and nothing here is a system of record. Two KV
keys per document, meta written last and deleted first, so a half-write is
invisible:

| Key | Value |
|---|---|
| `doc:<id>` | the raw bytes (`put(key, arrayBuffer)` / `get(key, "arrayBuffer")` — **never base64**) |
| `docmeta:<id>` | `{id, name, mime, bytes, added_utc, source, actor}` |

**The id is the document.** It is the first 16 hex chars of `sha256(bytes)`, so
the Worker recomputes the hash on every write and refuses a mismatch with `409` —
the id in the URL is a claim and is never trusted. That is what makes a doc
immutable (the same id can only ever mean the same bytes), what makes a second
PUT a no-op, and what makes the whole store safe to throw away and rebuild.

Push one down (what the engine does):

```bash
W=http://localhost:8788
S=dev-admin-secret-not-for-production
F=test/fixtures/sample-quote.pdf
ID=$(node -e "const c=require('node:crypto'),f=require('node:fs');\
console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex').slice(0,16))" "$F")

curl -s -X PUT "$W/api/admin/doc/$ID" -H "X-Admin-Secret: $S" \
  -H 'Content-Type: application/pdf' -H 'X-Doc-Name: 2026-09-07-Quote.pdf' \
  --data-binary "@$F"                       # -> 201 {"id":"…","bytes":24557}

curl -s "$W/api/admin/docs" -H "X-Admin-Secret: $S"
curl -s "$W/api/doc/$ID?t=<crew token>" -o /tmp/back.pdf
```

Then put `{"id":"<ID>","name":"…","kind":"QUOTE","bytes":24557,"added":"2026-09-07"}`
into that ticket's / lead's / agreement's `docs[]` in the next snapshot.
`kind` ∈ `QUOTE · WORKORDER · PARTS-LIST · PM-REPORT · SERVICE-TICKET · PO ·
PHOTO · OTHER`; MIME ∈ `application/pdf · image/jpeg · image/png`; cap 10 MB.

Three rules that are easy to break later:

- **Docs are never stripped and never role-gated.** The §6 money gate does not
  touch `docs[]`. A QUOTE on a lead carries a customer-facing price, which the
  customer already has; a tech who cannot open the work order for the machine on
  his bench has no board.
- **No client ever sees a storage key** — only `/api/doc/<id>`.
- **`/api/doc/` is never cached by the service worker**, precached or otherwise.
  It is named explicitly in `docs/sw.js` so a future edit to the `/api/` rule
  cannot start caching it. A tech on one bar of LTE pays for exactly the file he
  tapped, once; the browser's own HTTP cache handles the second read, because
  the Worker sends `immutable`.

#### Uploading from a phone (S2)

Two calls, never one, and the binary is only ever in the first:

```bash
# 1. the bytes. No id is sent — the Worker hashes the body and that IS the id.
curl -s -X POST "$W/api/doc" -H "Authorization: Bearer <crew token>" \
  -H 'Content-Type: application/pdf' -H 'X-Doc-Name: IMG_4821.pdf' \
  -H 'X-Doc-Record: S1018' -H 'X-Doc-Kind: WORKORDER' \
  --data-binary "@test/fixtures/sample-quote.pdf"      # -> 201 {"id":"…","bytes":24557,"existed":false}

# 2. the event that points at it.
curl -s -X POST "$W/api/event" -H "Authorization: Bearer <crew token>" \
  -H 'Content-Type: application/json' \
  -d '{"action":"doc_attach","payload":{"record":"S1018","doc_id":"<id>","kind":"WORKORDER","name":"IMG_4821.pdf"}}'
```

`X-Doc-Kind` from a phone is `WORKORDER · PARTS-LIST · PHOTO · OTHER` only —
QUOTE, PO, PM-REPORT and SERVICE-TICKET are the vault's to issue. `X-Doc-Record`
is a ticket or lead id (`^[SL]\d{4}$`) and is **not** checked for existence: the
vault owns state, same as every other write.

Four things here that are easy to undo by accident:

- **The record binding is stored in `docmeta`, not only in the event.** If the
  event never gets sent — the tab closed, the network died between the two
  calls — the bytes are still in the store *labelled with the ticket they belong
  to*, and the engine sweeps unfiled `source: "crew"` docs on its next run. A
  lost event must never be a lost document.
- **`doc_attach` is the one action the Worker checks state for**, returning 400
  when `docmeta:<doc_id>` is absent. That is not the vault's business leaking
  in: it is our own KV, and an attach with nothing behind it is a dangling
  pointer the engine could never apply.
- **The same bytes twice are one document** (`existed: true`), because the id is
  the hash. That is the double-tap protection, and it costs nothing.
- **Nothing about an upload is persisted client-side.** No `localStorage` blob
  queue, no IndexedDB, no service-worker background sync. A failed send stays
  one tap from a retry while the tech is looking at it and is gone if he leaves
  — which is exactly what the copy on the row says. A queue that outlives the
  page is a promise to deliver, and this app cannot keep it from a warehouse on
  one bar.

On the site: 📷 Photo uses `capture="environment"` (straight to the back camera,
no picker) and 📎 File opens the Files app, where scan-to-PDF output lives.
Single file each, **no `multiple`** — a two-page work order is two taps. Images
are decoded with `createImageBitmap(file, {imageOrientation:'from-image'})` so
EXIF rotation is applied (without it *every* portrait photo lands on its side),
resized to a 1600 px long edge and re-encoded as JPEG at q0.7; PDFs never touch
the canvas and nothing is ever converted *to* PDF.

### Icons

```bash
npm run icons
```

Regenerates `docs/icons/*.png` from `tools/make-icons.js` (raw PNG encoder, no
dependencies, no CDN). The PNGs are committed; you only need this if the mark
changes.

---

## Repo layout

```
CLAUDE.md               the build brief — architecture, contracts, hard rules
README.md               this file
package.json            scripts; wrangler is the sole dev dependency

docs/                   GitHub Pages root — the app shell
  index.html            markup + header/tab chrome
  app.js                routing, views, write forms, the twelve write actions
  api.js                data source + writes + doc upload (pure; covered by npm test)
  dates.js              date + money formatting (pure; covered by npm test)
  holds.js              hold-list logic (pure)
  metrics.js            utilization, status board, recurring revenue (pure)
  service.js            service + dispatch logic, schema 3 (pure)
  leads.js              leads board, scoreboard + insights logic, schema 5 (pure)
  notes.js              log[] timeline rows, shared by tickets + leads (pure)
  attachments.js        docs[] rows + upload logic (kinds, names, pending rows) — schema 6 (pure)
  style.css             WSS maroon, phone-first at 390x844
  manifest.webmanifest  PWA manifest — start_url "./" (see the token trap below)
  sw.js                 shell cache only; data is never cached
  icons/                generated PNGs
  mock/                 generated FAKE snapshots — never real data
  CNAME                 fleet.wisconsinscrubandsweep.com

worker/                 the Cloudflare Worker
  worker.js             entire Worker, single file (dashboard paste-deploy stays possible)
  wrangler.toml         binding FLEET_KV; namespace id filled in at M2
  .dev.vars             local ADMIN_SECRET + ALLOW_LOCALHOST=1 (gitignored)

tools/
  make-mock-data.js     fake snapshot generator (schema 6 + a schema-2 downgrade)
  make-icons.js         icon generator
  serve.js              dev static server (sends Cache-Control: no-store)
  m1-loop.sh            the Worker loop, curl-scripted (npm run m1)
  m3-check.sh           DNS / Pages / HTTPS readiness for the custom domain (npm run m3)
  selftest-api.mjs      mock-gate + api-layer test
  selftest-dates.mjs    the date-rule test
  selftest-holds.mjs    Reservations v2 logic
  selftest-metrics.mjs  utilization / status board / recurring revenue
  selftest-service.mjs  schema-3 service + dispatch logic
  selftest-leads.mjs    schema-5 leads logic, incl. money-absent-not-zero
  selftest-notes.mjs    log[] rows — order kept, ts never Date-parsed
  selftest-attachments.mjs  docs[] rows + upload logic — id shape, kinds, names, sizes
  selftest-render.mjs   every view, every mock variant, every role

test/fixtures/
  sample-quote.pdf      a 24 KB SYNTHETIC PDF the m1 loop uploads and reads back
  sample-photo.png      a 94-byte synthetic PNG — the image branch of the upload
  smoke-real.mjs        render a REAL snapshot by path — never copies it here
  money-gate.mjs        the §6 gate end to end on a real snapshot (npm run money-gate)
```

---

## Architecture, in one breath

```
crew phones ──tokenized URL──► fleet.wisconsinscrubandsweep.com   (GitHub Pages,
                                 │                                 zero data in repo)
                                 ▼  cross-origin
                          *.workers.dev Worker  ── KV: snapshot + evt:* inbox
                                 ▲
        run engine (elsewhere) ──┘  drains events, publishes the next snapshot
```

The page is on Pages and the Worker stays on `workers.dev` **on purpose**: a
Worker custom domain needs the DNS zone on Cloudflare, and WSS's DNS is run by a
third party who will add exactly one CNAME. Pages accepts a custom domain over a
plain CNAME from any host. Do not "simplify" this.

---

## Things that will bite you

- **Date-only strings.** Never `new Date("YYYY-MM-DD")`. Use `docs/dates.js`.
- **KV is eventually consistent (~60s across edges).** A write may not be visible
  from another PoP immediately. This is fine here — the engine applies events on
  its own schedule anyway. Do not "fix" phantom lag.
- **One KV key per event (`evt:<utc-iso>:<rand6>`), never a single events array.**
  KV has no atomic append; a shared array key silently loses concurrent writes
  when two techs toggle readiness at once.
- **Never bulk-delete events.** `admin/events/ack` deletes only the ids handed
  back; new events land mid-run. `DELETE /api/event/<id>` likewise removes one
  key, and only if the caller's token name matches the event's `actor` — it is
  a "wrong button" valve, not moderation, so **owner has no override** (D46).
- **Writes are proposals.** A submitted event renders as ⏳ pending and the board
  keeps showing current truth until the engine applies it.
- **A pending `ticket_open` has no ticket number.** The engine assigns it. The
  Service tab draws it as a synthetic RECEIVED card badged "⏳ NEW"; never invent
  an id client-side, not even a placeholder.
- **The Worker cannot enforce "only Matt closes a customer ticket."** Knowing
  whose machine `S1001` is means reading the snapshot, which is business state
  and explicitly not the Worker's job. The UI hides the button and the engine
  refuses the event. Same shape for the rig warning: the board warns, and never
  blocks — two runs on one trailer in a day is often the plan.
- **`billing` is in the snapshot and must not be rendered** (D39). It stays for
  the engine's own consumers. `selftest-render.mjs` asserts we don't draw it.
- **No dollar AMOUNT belongs on the landing page** (D45). The utilization card
  shows percentages and a band word; the money it is computed from never ships
  at schema 4 and is deliberately not printed even when an older snapshot still
  carries it. `selftest-render.mjs` asserts the landing matches no `$…` at all.
- **`acquisition_cost` and `book` are gone from the contract** at schema 4 and
  are read nowhere but the schema-3 fallback in `metrics.js`. Do not reintroduce
  a read of either; `ask` is the only per-unit figure the crew sees.
- **`start_url` cannot carry a token.** One static manifest serves everyone, so
  it is `"./"`; the home-screen app boots tokenless, and the page restores the
  token from `localStorage` into the URL (D24). If iOS has purged that storage,
  the app shows the gate — re-tap the tokened link once.
- **Relative paths everywhere.** Pages serves at the domain root in production
  but under `/<repo>/` while testing pre-DNS. A leading slash breaks one of them.
- **The service worker caches the shell only**, and does not register on
  localhost — a cached `app.js` means debugging yesterday's code. `tools/serve.js`
  sends `no-store` for the same reason.
- **Loaners have no billing row.** A unit with `unit_state: LOANER-OUT` and an
  `agreement` number but no matching `agreements` entry is correct, not missing.
- **Invoice numbers are opaque strings.** `R4130-10`, `R4204-1.1`, bare `519665`.
  Never parse them.

---

## Deploy

### M1 — Worker locally

The Worker is one file, [`worker/worker.js`](worker/worker.js). `wrangler` is the
only dev dependency (`npm install` once). Local dev uses Miniflare with a local
KV — nothing touches Cloudflare.

```bash
npm run dev:worker
```

That reads `worker/.dev.vars` (gitignored — create it if missing):

```
ADMIN_SECRET=dev-admin-secret-not-for-production
ALLOW_LOCALHOST=1
```

Then, in another terminal, the full loop:

```bash
npm run m1
```

[`tools/m1-loop.sh`](tools/m1-loop.sh) is the M1 exit criterion as a script —
62 checks: load a throwaway token map → publish the mock snapshot →
`GET /api/data` as sales / service (role comes back from the server) →
`GET /api/health` → every write refusal (wrong role, unknown action, bad
serial, missing customer, bad date, bad readiness) → two real events →
both visible to crew and admin, oldest first → ack one by id, one by full key
→ the other survives → back to baseline. Then the six schema-3 actions and
their refusals — wrong role for a stage change or a cancel, a bad rig, an
unknown driver, a claim with no date, a `ticket_update` that changes nothing.
Then the undo endpoint (D46): no token → 401, someone else's event → 403,
**owner gets no override** → 403, the event surviving every refusal, your own →
200, the inbox losing exactly that key, a second undo → 404, an unknown id →
404, a malformed id → 400, `snapshot` untouched, and a GET on the id path → 405.
Plus 404 / 405 / CORS preflight.

The same loop runs against the deployed Worker:

```bash
WORKER=https://wss-fleet-worker.<account>.workers.dev ADMIN_SECRET='…' npm run m1
```

(it replaces the token map with throwaway test tokens — re-post the real map
afterwards, see **Tokens**).

**Page → Worker locally.** The page is at `localhost:8787` and the Worker at
`localhost:8788`, so on localhost only, `?api=` points the page at it:

```
http://localhost:8787/?api=http://localhost:8788&t=m1testsales00000000000000000001
```

The override is stored like the token and ignored off-localhost
(`selftest-api.mjs` proves it). `?api=` with an empty value clears it.

By hand, the pieces:

```bash
W=http://localhost:8788; S=dev-admin-secret-not-for-production
T=m1testsales00000000000000000001

# tokens (names/roles echoed back, token values never are)
curl -s -X POST $W/api/admin/tokens -H "X-Admin-Secret: $S" -H 'Content-Type: application/json' \
  -d "{\"$T\":{\"name\":\"Test Kevin\",\"role\":\"sales\"}}"

# publish
curl -s -X POST $W/api/admin/publish -H "X-Admin-Secret: $S" --data-binary @docs/mock/mock-full.json

# read
curl -s $W/api/data   -H "Authorization: Bearer $T" | head -c 300; echo
curl -s $W/api/health -H "Authorization: Bearer $T"; echo

# write (a proposal — lands as evt:<utc-iso>:<rand6>)
curl -s -X POST $W/api/event -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Acme Foods","purpose":"quote hold","until":"2026-09-08"}}'

# drain + ack (what the run engine does)
curl -s $W/api/admin/events -H "X-Admin-Secret: $S"
curl -s -X POST $W/api/admin/events/ack -H "X-Admin-Secret: $S" -H 'Content-Type: application/json' \
  -d '{"ids":["<id from the list>"]}'
```

#### Worker API

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /api/data` | token | `{me:{name,role}, snapshot, pending:[events]}` |
| `POST /api/event` | token | `201` the stored event `{id, ts, actor, role, action, serial, payload}` |
| `DELETE /api/event/<id>` | token | `200 {ok, id}` — undo your OWN still-pending event. Someone else's → `403` (owner has no override); already drained or unknown → `404`; malformed id → `400`. Deletes exactly one `evt:` key and never touches `snapshot`. |
| `GET /api/health` | token | `{published_at, generated_at, run_id, pending_count}` |
| `POST /api/admin/publish` | secret | body = snapshot JSON; needs `meta.schema_version` |
| `GET /api/admin/events` | secret | `{count, events:[{id, key, event}]}` oldest first |
| `POST /api/admin/events/ack` | secret | `{ids:[…]}` → deletes only those; `{deleted:n}` |
| `POST /api/admin/tokens` | secret | replaces the map; echoes names + roles only |
| `POST /api/doc` | token (any role) | **S2 — a phone uploads.** Body = raw bytes; headers `Content-Type`, `X-Doc-Name`, `X-Doc-Record` (`^[SL]\d{4}$`), `X-Doc-Kind` (`WORKORDER · PARTS-LIST · PHOTO · OTHER` only). No id is sent — the Worker hashes the body. `201 {id, bytes, existed:false}` / `200 {id, existed:true}` / `415` / `413` / `400` |
| `GET /api/doc/<id>` | token (`?t=` **or** Bearer) | the bytes, `Content-Type` from the stored meta, `Content-Disposition: inline`, `Cache-Control: private, max-age=31536000, immutable`, `nosniff`. `404` unknown, `400` malformed id. `?t=` must work — a new tab cannot send a header. |
| `PUT /api/admin/doc/<id>` | secret | body = raw bytes. `201 {id, bytes}`; `200 {id, existed:true}` if already cached; `409 {error:"hash mismatch", expected}` if `sha256(body)[0:16] != id` (**nothing is stored**); `415` bad type; `413` over 10 MB; `400` bad/missing `X-Doc-Name` |
| `GET /api/admin/doc/<id>` | secret | same bytes as the token GET (the engine's down-leg) |
| `DELETE /api/admin/doc/<id>` | secret | `200 {id, deleted:true}`, `404` if unknown. Drops both keys. |
| `GET /api/admin/docs` | secret | `{count, docs:[…docmeta…]}` oldest first |

#### The write actions

| Action | Roles | `serial` | Payload |
|---|---|---|---|
| `reserve` | owner, sales | required | `customer`, `purpose`, `start`, `end` |
| `release` | owner, sales | required | `hold_id` |
| `readiness` | owner, service | required | `readiness`, `note` |
| `ticket_open` | any | optional | `machine_owner`, `serial`, `equipment`, `customer`, `issue`, `priority`, `site`, `location`, `intake_move`, `return_move` |
| `ticket_update` | any — **`stage` needs service/owner** | optional | `ticket` + only the keys being changed |
| `dispatch_add` | any | optional | `kind`, `serial`, `ticket`, `what`, `customer`, `address`, `date`, `note` |
| `dispatch_claim` | any | optional | `dispatch_id`, `rig`, `date`, `driver` |
| `dispatch_done` | any | optional | `dispatch_id`, `note` |
| `dispatch_cancel` | **owner** | optional | `dispatch_id` |
| `doc_attach` | any | not used | `record`, `doc_id`, `kind`, `name` — **schema 6 / S2.** The one action the Worker checks state for: 400 if `docmeta:<doc_id>` is not in the store, because an attach with no bytes behind it is a dangling pointer into *our* KV. |

Enums the Worker checks membership of, and nothing more:
`machine_owner` CUSTOMER·WSS · `stage` RECEIVED·CONTACTED·NEEDS-QUOTE·WAITING-ON-CUSTOMER·WAITING-ON-PARTS·READY-TO-SCHEDULE·SCHEDULED·IN-PROGRESS·READY-TO-INVOICE·COMPLETE ·
`priority` HIGH·MEDIUM·LOW · `location` AT-CUSTOMER·IN-SHOP ·
`intake_move` NONE·PICKUP·CUSTOMER-DROP · `return_move` NONE·DELIVER·CUSTOMER-PICKUP ·
`kind` PICKUP·DELIVER · `rig` KEVIN-LIFTGATE·JOSH-LIFTGATE·TRAILER-6000·TRAILER-3000 ·
`driver` Matt·Kevin·Josh·Zac.

Token: `Authorization: Bearer <t>` (preferred) or `?t=`. Secret: `X-Admin-Secret`.
Unknown → `401 {"error":"unauthorized"}`. Wrong role for an action → `403`.
Bad shape → `400` with a plain-English `error`. The Worker validates shape and
role only — never business state; the vault wins.

### M2 — Worker + Pages live

Live since Sep 1, 2026:

| Thing | Where |
|---|---|
| Worker | `https://wss-fleet-worker.mlancourt.workers.dev` |
| KV namespace | `fleet-dashboard` — id in `worker/wrangler.toml` |
| Page (pre-DNS) | `https://mlancourt.github.io/wss-fleet-dashboard/` — Pages from `/docs` on `main`, HTTPS enforced |
| `API_BASE` | set in `docs/api.js` |

How it was done, for the next time (all from this repo, `wrangler login` first):

```bash
npx wrangler kv namespace create fleet-dashboard --config worker/wrangler.toml   # paste id into wrangler.toml
openssl rand -hex 24 | tr -d '\n' | npx wrangler secret put ADMIN_SECRET --config worker/wrangler.toml
npm run deploy:worker
gh api -X POST repos/mlancourt/wss-fleet-dashboard/pages -f 'source[branch]=main' -f 'source[path]=/docs'
```

Redeploying the Worker after a code change is just `npm run deploy:worker`;
the page redeploys itself on every push to `main` (Pages build takes ~1 min).
The Worker's own secret and the crew tokens live only in Cloudflare and with
Matt — never in this repo, never in a chat log that gets pasted anywhere.

Until the engine publishes, `/api/data` answers `503 no snapshot published yet`
and the page shows "Nothing published yet" — that is the expected state right
after a fresh deploy, not a fault.

### M3 — custom domain + PWA

**Status (Sep 2, 2026):** DNS is live (GoDaddy-hosted; `CNAME fleet → mlancourt.github.io`),
`docs/CNAME` is merged, the Pages custom domain is set, HTTPS enforced once GitHub
issued the cert. Crew links are on `https://fleet.wisconsinscrubandsweep.com/?t=…`.
The github.io URL now redirects there. The notes below are the record of how it
was sequenced, for the next domain move.

**Why `docs/CNAME` sat on a branch until DNS resolved.** The moment GitHub Pages has
a custom domain, every `mlancourt.github.io/wss-fleet-dashboard/` URL redirects
to it. Until Machinio's record exists that domain resolves to nothing, so
merging the CNAME early takes the crew's links down for as long as Machinio
takes. Order matters:

1. **Matt → Machinio**, one line: add `CNAME` record, host **`fleet`**, target
   **`mlancourt.github.io`** (no trailing path, no `www`).
2. Poll until step 1 shows ✓:
   ```bash
   npm run m3
   ```
3. Merge the CNAME (Pages picks up the domain within a minute, cert follows):
   ```bash
   git merge --no-ff m3-cname && git push origin main
   ```
4. Once `npm run m3` shows HTTPS 200, enforce it:
   ```bash
   gh api -X PUT repos/mlancourt/wss-fleet-dashboard/pages -F https_enforced=true
   ```
5. Re-issue the crew links on the new origin — same tokens, new host:
   `https://fleet.wisconsinscrubandsweep.com/?t=…`. **They must open the new
   link once**: the token is kept per origin, so the github.io copy doesn't
   carry over. Worker CORS already allows the fleet origin.

#### Install check (do this on the final domain, not github.io)

**Add the icon from a page whose address bar shows `?t=…`.** The manifest has
no `start_url` on purpose: a home-screen web app on iOS has storage separate
from Safari, so the token can only reach it through the launch URL, and iOS
uses the URL the icon was added from. An icon added before Sep 2, 2026 launches
tokenless — delete it and re-add.

**iPhone — Safari only** (Chrome/in-app browsers can't add PWAs on iOS):
1. Open the tokened link in Safari. Confirm the header shows *data as of …*.
2. Share button → **Add to Home Screen** → Add.
3. Open it from the icon: no Safari bars (standalone), data loads, ⏳ badge
   and tabs work.
4. Swipe it away, open again — still loads without the link (token persisted).
5. Turn on Airplane Mode and open it: the shell should appear with a
   *Can't load the board* card, never yesterday's fleet.

**Android — Chrome:**
1. Open the tokened link. ⋮ menu → **Install app** (or *Add to Home screen*).
2. Same checks 3–5 as above.

If step 4 fails on either, the token wasn't stored on that origin — open the
tokened link once more and retry.

### Tokens

Identity is an opaque per-person token in the URL — no accounts, no passwords.

```bash
openssl rand -hex 16
```

Issue/rotate by replacing the whole `tokens` map via `POST /api/admin/tokens`.
Tokens live in KV and **never** in this repo. The page keeps `?t=` in the
address bar (the URL is the durable carrier — bookmarks must keep working) and
mirrors it into `localStorage` as a backup; if a URL arrives without `?t=` but
storage has one, the page puts it back into the URL (D24). API calls send the
token as `Authorization: Bearer`.

To revoke someone: remove them from the map and re-post it.

---

## Ask Matt before you

change money display formats · change category names or order · add any write
action beyond the nine now defined · add any map or navigation integration ·
add push/notifications (out of scope — the run cadence is the refresh) · need a
new DNS record or a paid plan · change repo visibility.

If the snapshot contract looks wrong or insufficient, **stop and say so** — that
contract is owned on Matt's side and changes there first.
