# WSS Fleet Dashboard — ops runbook

Employee-facing operations board for **Wisconsin Scrub & Sweep**: rental fleet,
active agreements, service queue, upcoming billing. Phone-first, four users
(Matt, Kevin, Josh, Zac).

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
| M1 — Worker | ⬜ next | full publish → read → event → ack loop green locally, curl-scripted below |
| M2 — deploy real | ⬜ | Matt opens his tokened URL on his phone and sees the real fleet |
| M3 — domain + PWA | ⬜ | `fleet.wisconsinscrubandsweep.com` installs as an app |
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
| `http://localhost:8787/?mock=full` | fake fleet, non-empty service queue |
| `http://localhost:8787/?mock=empty` | same fleet, `service_queue: []` |
| `http://localhost:8787/` | the no-token gate ("ask Matt for your link") |

There is **no build step**. Vanilla HTML/CSS/JS, ES modules. `node` is used only
for the generators and tests; nothing compiles the page.

### Mock-only URL knobs

These work in `?mock=` mode only, so states the snapshot can't express are still
reviewable:

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

Guards the one bug class `CLAUDE.md` calls disqualifying: business dates are
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
package.json            scripts only; wrangler is the sole dev dependency (M1)

docs/                   GitHub Pages root — the app shell
  index.html            markup + header/tab chrome
  app.js                routing, views, API layer, write forms
  dates.js              date + money formatting (pure; covered by npm test)
  style.css             WSS maroon, phone-first at 390x844
  manifest.webmanifest  PWA manifest — start_url "./" (see the token trap below)
  sw.js                 shell cache only; data is never cached
  icons/                generated PNGs
  mock/                 generated FAKE snapshots — never real data
  CNAME                 added at M3, not before

worker/                 the Cloudflare Worker (M1)
  worker.js             entire Worker, single file (dashboard paste-deploy stays possible)
  wrangler.toml

tools/
  make-mock-data.js     fake snapshot generator
  make-icons.js         icon generator
  serve.js              dev static server (sends Cache-Control: no-store)
  selftest-dates.mjs    the date-rule test
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
- **`start_url` cannot carry a token.** One static manifest serves everyone, so
  it is `"./"`; identity comes from the token in `localStorage` after the first
  tokened visit. Add-to-home-screen only works after that first visit.
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

_To be filled in when the Worker lands. Must include the full curl loop:
`admin/publish` → `GET /api/data` with a test token → `POST /api/event` →
`GET /admin/events` → `POST /admin/events/ack`._

### M2 — Worker + Pages live

_To be filled in: `wrangler login`, create KV namespace `fleet-dashboard`,
`wrangler secret put ADMIN_SECRET`, deploy, enable Pages from `/docs` on `main`,
set `API_BASE` in `docs/app.js`._

### M3 — custom domain + PWA

_To be filled in: add `docs/CNAME`, the one-line request to Machinio
(`CNAME fleet → mlancourt.github.io`), enforce HTTPS in Pages settings, update
Worker CORS, verify add-to-home-screen on iOS Safari and Android Chrome._

### Tokens

Identity is an opaque per-person token in the URL — no accounts, no passwords.

```bash
openssl rand -hex 16
```

Issue/rotate by replacing the whole `tokens` map via `POST /api/admin/tokens`.
Tokens live in KV and **never** in this repo. The page strips `?t=` from the
address bar on first load and keeps the token in `localStorage`; API calls send
it as `Authorization: Bearer`, never as a URL parameter.

To revoke someone: remove them from the map and re-post it.

---

## Ask Matt before you

change money display formats · change category names or order · add any write
action beyond reserve / release / readiness · need a new DNS record or a paid
plan · change repo visibility.

If the snapshot contract looks wrong or insufficient, **stop and say so** — that
contract is owned on Matt's side and changes there first.
