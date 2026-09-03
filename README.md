# WSS Fleet Dashboard — ops runbook

Employee-facing operations board for **Wisconsin Scrub & Sweep**: rental fleet,
active agreements, the service queue, and a Dispatch board of truck moves.
Phone-first, four users (Matt, Kevin, Josh, Zac).

**v1.6 (schema 3)** — the Billing tab is retired: its recurring-revenue block
moved to the top of Rentals and its nav slot became **Dispatch**. The Service
tab is real (eight-stage kanban, ticket detail, `+ New ticket`). Six new write
actions bring the total to nine. `snapshot.billing` still arrives and is
deliberately never rendered.

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
| `http://localhost:8787/?mock=full` | schema 3 — full service queue + dispatch board |
| `http://localhost:8787/?mock=empty` | schema 3 — `service_queue: []`, `dispatch: []` (empty states) |
| `http://localhost:8787/?mock=legacy` | schema 2 — the pre-Dispatch snapshot, to rehearse the cutover |
| `http://localhost:8787/` | the no-token gate ("ask Matt for your link") |

`mock-legacy.json` exists for **one release**. Once the engine is publishing
schema 3 for real and Matt has signed off, delete it, drop `'legacy'` from
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

Six suites, ~85 checks. `selftest-render.mjs` boots the **real** `app.js` in a
stub DOM and renders every route against all three mock variants as all three
roles, failing on a thrown view, a leaked `undefined`, or a date-only string
that got `Date`-parsed. `selftest-service.mjs` pins the schema-3 rules: stage
gating, kanban columns, dispatch ordering, the same-rig-same-day warning.
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
  app.js                routing, views, write forms, the nine write actions
  api.js                data source: Worker or mock (pure; covered by npm test)
  dates.js              date + money formatting (pure; covered by npm test)
  holds.js              hold-list logic (pure)
  metrics.js            utilization, status board, recurring revenue (pure)
  service.js            service + dispatch logic, schema 3 (pure)
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
  make-mock-data.js     fake snapshot generator (schema 3 + a schema-2 downgrade)
  make-icons.js         icon generator
  serve.js              dev static server (sends Cache-Control: no-store)
  m1-loop.sh            the Worker loop, curl-scripted (npm run m1)
  m3-check.sh           DNS / Pages / HTTPS readiness for the custom domain (npm run m3)
  selftest-api.mjs      mock-gate + api-layer test
  selftest-dates.mjs    the date-rule test
  selftest-holds.mjs    Reservations v2 logic
  selftest-metrics.mjs  utilization / status board / recurring revenue
  selftest-service.mjs  schema-3 service + dispatch logic
  selftest-render.mjs   every view, every mock variant, every role
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
  back; new events land mid-run.
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
| `GET /api/health` | token | `{published_at, generated_at, run_id, pending_count}` |
| `POST /api/admin/publish` | secret | body = snapshot JSON; needs `meta.schema_version` |
| `GET /api/admin/events` | secret | `{count, events:[{id, key, event}]}` oldest first |
| `POST /api/admin/events/ack` | secret | `{ids:[…]}` → deletes only those; `{deleted:n}` |
| `POST /api/admin/tokens` | secret | replaces the map; echoes names + roles only |

#### The nine write actions

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

Enums the Worker checks membership of, and nothing more:
`machine_owner` CUSTOMER·WSS · `stage` RECEIVED·CONTACTED·WAITING-ON-CUSTOMER·WAITING-ON-PARTS·IN-PROGRESS·READY-TO-INVOICE·COMPLETE ·
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
