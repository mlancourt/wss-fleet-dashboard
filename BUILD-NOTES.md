# BUILD-NOTES — v1.6 / schema 3 (Service module + Dispatch board)

Built Sep 3, 2026 from `Service-Dispatch-Site-Spec.md` (everything below its cut
line) against `CLAUDE.md` v1.6. **On mock data only.** Nothing was deployed, no
DNS/tokens/secrets touched, nothing pushed.

---

## What shipped

**Nav** is now Fleet · Rentals · Holds · **Dispatch** · Service.

- **Billing is gone.** `snapshot.billing` is no longer read anywhere in the app;
  it still arrives for the engine's own consumers. `#/billing` redirects to
  `#/dispatch` so old bookmarks and home-screen icons still land somewhere.
- **The D21 recurring-revenue block leads Rentals** — same math, same copy
  ("Recurring revenue — per 28-day cycle" / "≈ $X / month"), above the
  agreements list.
- **Service** — the D20 status board keeps the top, then `+ New ticket` (any
  role), All/Customer/Fleet filter chips, then an eight-stage kanban that swipes
  sideways on a phone (scroll-snap, sticky column headers) and opens to all
  eight columns side by side above 1040px. Cards carry customer, equipment (or
  serial + model for a fleet machine), a one-line issue, age, the assignee's
  initial, a 🚚 when the ticket has a live truck run, and a maroon left edge on
  HIGH. Closed tickets show greyed in COMPLETE only.
- **Ticket detail** — the whole record, then a stage picker (WAITING-ON-CUSTOMER and
  READY-TO-INVOICE hidden when `machine_owner: WSS`; COMPLETE on a customer
  ticket disabled for techs with the caption "Matt closes after invoicing."),
  note / assign / schedule, the ticket's dispatch rows, and an offer to book a
  move the ticket says it lacks.
- **Dispatch** — Open → Scheduled (grouped by day) → Done this week (collapsed).
  Claim takes driver / rig / day and warns inline when that rig already has that
  day; it never blocks. Done on a `RENTAL-RETURN` row says it ends the agreement.
  Add a run reaches from the board, from a unit page ("Schedule delivery",
  pre-filled from the placement) and from a hold row. Cancel is owner-only on
  MANUAL rows. Addresses are tap-to-copy — **no map links**. Nav badge = OPEN +
  SCHEDULED.
- **Unit page** — wrench chip + link when `service_ticket` is set, "Schedule
  delivery", and a NEEDS-PICKUP line pointing at the run's row on the board.
- **Worker** — the six new actions, validated for shape and enum membership
  only. `serial` optional on those six (normalised to `null`), still required
  for reserve / release / readiness.
- **Mock** — `make-mock-data.js` emits schema 3 with every case §9 names, plus
  `mock-legacy.json` (the schema-2 downgrade) for the cutover.

## Tests

`npm test` — six suites, ~85 checks, green under `TZ=Pacific/Pago_Pago` too.
The new one, `selftest-render.mjs`, boots the **real** `app.js` in a stub DOM
and renders every route × all three mock variants × all three roles, failing on
a thrown view, a leaked `undefined`, or a `Date`-parsed date-only string.

`npm run m1` against `wrangler dev` — **62 passed, 0 failed**, including all
nine write actions and their refusals.

The §10 exit walkthrough was run end to end against the local Worker: Josh
opens a customer ticket with "we pick it up" → Kevin claims it with
TRAILER-6000 → Josh marks it done → Josh walks the stages to READY-TO-INVOICE →
Matt completes it → Kevin adds a manual run → Matt cancels it. All six new
actions exercised; every event landed as an `evt:` key and drained cleanly.

Also checked in headless Chrome at 390×844: the conditional New-ticket form,
the rig-clash warning, the rental-return Done copy, role gating on Cancel, and
zero console errors (the only 404 is the browser's own `/favicon.ico`, which
predates this work).

---

## Decisions I made

Where the spec left it to me, or left a gap:

1. **No separate Pick-ups block on Dispatch.** §1 says the block "moves into
   Dispatch" and "is now just the `RENTAL-RETURN` rows of `dispatch[]`", while
   §4 defines exactly three sections. I read those together as: RENTAL-RETURN
   rows live in the normal Open/Scheduled sections, marked with the 📦 source
   glyph and a "billed through" line. There is no fourth block. Category cards
   keep their `· N to pick up` sub-line from `pickups[]`, unchanged.

2. **Added a "Released, not on the board" guard.** A `pickups[]` entry whose
   serial has no live RENTAL-RETURN row would otherwise be invisible now that
   the pick-ups list is gone. It renders as a small loud block above Scheduled
   with an "Add the run" button. Normally empty — it exists so a machine on a
   customer's dock can't go quiet because a row is missing. It is also what
   makes the schema-2 snapshot still show released units during the cutover.

3. **`intake_move` when the machine is already in our shop.** §3.1 hides the
   question when `location: IN-SHOP` but doesn't say what to send. The form
   sends `NONE` — there is no truck move to arrange for something already here.
   The picker's three options only appear for AT-CUSTOMER, as specified.

4. **The kanban column count comes from `service_summary.open_by_stage` only
   when no filter is applied.** Under a Customer/Fleet filter that number would
   be a lie, so the column counts what it draws. The filter chips themselves
   show `open_customer` / `open_wss` from the summary.

5. **A pending `ticket_open` does not inflate the RECEIVED column count.** It
   renders as the synthetic ⏳ NEW card §3.1 asks for, but the header count
   stays the engine's number — the count is applied truth, the card is the
   proposal.

6. **Assign offers the four names as a segmented control, submitted like any
   other sheet** (rather than a tap posting immediately). One mis-tap should
   not become a proposal.

7. **Stage picker: tapping a stage opens a sheet with an optional note**, per
   §3.3, rather than posting on tap. Same reasoning.

8. **`mock-legacy.json` is a third mock variant** (`?mock=legacy`), added to
   `MOCK_VARIANTS` in `docs/api.js`. §9 said to keep the schema-2 variant for
   one release; rather than freeze a stale file, it is generated as a downgrade
   of the schema-3 snapshot, so it stays coherent. **Delete it after the
   cutover** — the README says where.

9. **`#/billing` redirects rather than 404s.** Not in the spec; the crew has
   home-screen icons and bookmarks.

10. **A test seam in `app.js`** (`__render`, `__refresh`, `__state` exports) so
    `selftest-render.mjs` can drive the real views. Three lines, nothing in the
    page reads them, and it is what catches a view that throws before a phone
    in a warehouse does.

---

## Things worth flagging

**None of these blocked the build.**

- **The Worker cannot enforce "only Matt closes a customer ticket."** Deciding
  that needs `machine_owner` for ticket `S1001`, which means reading the
  snapshot — business state, explicitly not the Worker's job (§7: "never
  business state"). So the Worker accepts `{stage: COMPLETE}` from a tech; the
  **UI hides the button** and the **engine refuses it**. That matches §6's
  "client-side convenience only — the engine enforces", but it is worth the
  Architect knowing the server is not a backstop for this one rule. The Worker
  *does* enforce the two rules it can see from the event alone: a
  `ticket_update` carrying `stage` needs service/owner, and `dispatch_cancel`
  is owner-only. (§7 says "no other Worker changes"; enforcing these two is
  stricter than the letter of §7 but matches the rules stated in both §6 and
  CLAUDE.md. Say the word and they come out.)

- **`driverChoices` falls back to all four names for an unrecognised user.**
  §4 says non-owners "see only themselves", keyed on the person's name. In mock
  mode `me.name` is "Mock User", which is not one of the four, so the picker
  shows all four rather than nothing. With a real token (name "Josh") a tech
  sees only Josh. If a fifth person is ever added to the token map without being
  added to `DRIVERS`, they will see all four rather than an empty picker — a
  deliberate choice, since an empty picker is unusable.

- **`ticket_update` cannot clear a field.** The Worker drops empty values so
  "only the keys being changed" travel (§6). There is therefore no way to
  un-assign a ticket or clear a scheduled date from the UI. The spec doesn't ask
  for one; noting it in case the crew asks.

- **`age_days` and `stage_since` are rendered verbatim from the snapshot** — no
  client-side date arithmetic, per rule 7. If the engine ships a stale
  `age_days` the board shows a stale number rather than quietly recomputing it.

- **One `?mock=` value was added** (`legacy`). `selftest-api.mjs` still proves
  the whole mock gate is inert on a real host with the Worker wired.

---

## For the real-snapshot smoke test

When the Architect says schema 3 is live, in this order:

1. **`GET /api/health`** — confirm `published_at` moved and the run is fresh.
2. **Open the tokened URL on a phone.** Header reads "data as of …" with no ⚠️.
3. **Service tab** — the D20 board still sums to the fleet; the eight columns
   carry real tickets; column counts match `service_summary.open_by_stage`.
   Check a `machine_owner: WSS` ticket hides WAITING-ON-CUSTOMER and READY-TO-INVOICE.
4. **A fleet unit with an open ticket** shows the 🔧 chip and the chip links to
   a ticket that exists. If a unit's `service_ticket` names a ticket that isn't
   in `service_queue`, the detail page says "Ticket not found" — **report it,
   don't patch it.**
5. **Dispatch tab** — the badge equals OPEN + SCHEDULED. Every RENTAL-RETURN row
   shows a `billed_through` date. **If "Released, not on the board" is
   non-empty on real data, that is a finding for the Architect**, not a bug
   here: it means `pickups[]` and `dispatch[]` disagree.
6. **Dates.** Spot-check one `scheduled`, one `date`, one `billed_through`,
   one `opened` against the vault. An off-by-one day is the disqualifying bug.
7. **Money.** The Rentals headline against the vault's own recurring total.
8. **Real ids.** Mock uses `S1001` and `m-pu-<serial>`; the engine's real
   `ticket` and `dispatch.id` shapes are treated as opaque strings, but the
   Worker's `REF_ID_RE` allows `[A-Za-z0-9_.-]{1,64}` — if real ids carry any
   other character, claims and updates will 400. Worth one look at a real id
   before the crew starts tapping.
9. **One live write per role**, ideally the §10 walkthrough on real data: Josh
   opens a ticket, Kevin claims a run, Matt cancels a manual one. Confirm each
   lands in `GET /api/admin/events` and badges ⏳ on the board.
10. **`dispatch_warnings`** — if the engine ever sends one, confirm the claim
    sheet surfaces it and still lets the claim through.

Then delete `mock-legacy.json` and its wiring (README says where), and set the
v1.6 row in the README status table to live.

---

# D43 — Service Pipeline widget + filter-driven Service tab (2026-09-04)

Built from `Service-Pipeline-Widget-Site-Spec.md` (below its cut line) against
`CLAUDE.md` v1.7. **Site-only, as the order says** — no snapshot, Worker or
event changes, and no `wrangler deploy`. Everything is computed on the client
from `service_queue[]` and `service_summary`, the way the Fleet Status board is
computed from `units[]`.

## What shipped

**Service tab, top to bottom:** `+ New ticket` · filter chips · widget zone ·
kanban.

- **Chips reordered to `All · Fleet · Customer`**, All default, counts as
  before. The choice is remembered per device (`localStorage`, try/catch,
  falling back to All on anything unexpected) so a tech who lives in Fleet
  lands there. Verified across a full page reload in a real browser.
- **Widget zone by chip** — All: Fleet Status then Service Pipeline, with the
  muted caption "Customer machines · fleet repairs are on the board above";
  Fleet: the board alone; Customer: the pipeline alone.
- **Kanban** — under Fleet it drops WAITING-ON-CUSTOMER and READY-TO-INVOICE
  (six columns); All and Customer show all eight.
- **Service Pipeline widget** — a sibling of the fleet board: same card, same
  row anatomy, same typography. Seven rows in stage order over **open CUSTOMER
  tickets**, one shared 100% scale, zero rows still drawn. Header pill `N open`
  plus a muted `N closed this week` that hides at zero. COMPLETE is the pill,
  never a row. Rows are buttons: tapping one scrolls the kanban to that column
  and never changes the chip.
- **`docs/service.js`** gained `pipeline(queue)` and `columnsFor(filter)`, both
  pure. `BUILD` stamp and SW cache bumped (v11 → v12).

## Tests

`npm test` — 80 checks green, also under `TZ=Pacific/Pago_Pago`. Seven new
assertions in `selftest-service.mjs` (row order, counts and pct on a mixed
queue, fleet tickets excluded, closed-this-week from `status`, `columnsFor`
dropping exactly the two stages, empty queue → seven zero rows) and six in
`selftest-render.mjs` (chip order, each chip's widgets and column count, only
the right tickets drawn under each, seven tappable rows with a live pill, chip
persistence across a re-boot, and the card never hiding on an empty snapshot).

Browser-verified at 390×844: chip order, widgets per chip, six-vs-eight
columns, persistence across a full reload, row tap scrolling without
re-filtering, and zero console exceptions.

## Decisions I made

1. **`columnsFor('WSS')` is `stagesFor('WSS')`.** The kanban's six columns and
   the ticket-detail stage picker are the same rule; deriving one from the
   other means they cannot drift if the hidden set ever changes.

2. **A hidden column still appears if a ticket is actually in it.** Under Fleet,
   if the engine ever parks a WSS ticket in WAITING-ON-CUSTOMER, that column is
   appended rather than the ticket vanishing. Hiding a column is a display
   choice; dropping a ticket is data loss, and `columnize` already promised
   never to do it.

3. **The widgets survive an empty queue; only the kanban is replaced.** The old
   code returned early on an empty `service_queue` and drew nothing but the
   empty state. The spec says the pipeline card must never hide, so the empty
   state now replaces the kanban alone and the shop's shape still reads.

4. **The pipeline's label column is wider than the fleet board's.** At 390px,
   "Waiting on customer" ran into the count. The bar gives up those pixels
   rather than the label being truncated — the seven bars share one scale, so
   they're read against each other, not measured. Row heights stay uniform
   (40px), which is what "stable layout" is protecting.

5. **The `closed this week` pill hides at zero** rather than reading "0 closed
   this week" — the order left this to me.

6. **Row tap never changes the chip**, under any chip. The spec only requires
   this for All and Fleet; making it unconditional means the widget is a way to
   read the board and never a second, hidden filter.

7. **Chip persistence is separate from the token/API storage keys**
   (`wss_fleet_service_filter`), and every read and write is wrapped — a device
   with storage blocked simply gets All every time, no error path.

## Things worth flagging

**None blocking.**

- **`columnize`'s "unknown stage" behaviour narrowed slightly.** It used to scan
  the whole queue for stages it didn't recognise; it now scans the tickets the
  current filter actually renders. Same guarantee (no ticket is ever dropped),
  but a stage occupied only by tickets the filter hides no longer produces an
  empty column — which is the point of the Fleet six-column view.

- **The `N open` chip counts and the pipeline's `N open` come from different
  places** — the chips prefer `service_summary.open_customer`, the widget counts
  the rows it draws. They agreed on mock. If they ever disagree on real data
  that is a `service_summary` bug worth reporting to the Architect, not
  something to paper over on the client.

- **No test covers the scroll itself**, only that the handler targets the right
  column id and leaves the chip alone; `scrollIntoView` is browser behaviour.
  It was exercised by hand in Chrome (scrollLeft moved 0 → 1461).

---

# D44 — Fleet utilization by dollars (2026-09-04)

Built from `Dollar-Utilization-Site-Spec.md` (below its cut line) against
`CLAUDE.md` v1.8. **Site-only, as the order says** — no snapshot, Worker or
event changes, and no `wrangler deploy`. `units[].acquisition_cost` was already
in the contract.

## What shipped

- **The landing utilization bar is now a two-bar card**, one header
  (`FLEET UTILIZATION`), one width.
  - **Units** — the D19 bar, untouched in math, bands, colors and label, now
    captioned so the two read as a pair.
  - **Dollars** — ON-RENT `acquisition_cost` ÷ rentable `acquisition_cost` over
    exactly D19's population (`status == "RENTAL"`, not RETIRED). Same bands,
    same words. Sub-line `$309,300 on rent of $563,700` — whole dollars,
    separators, tabular numerals, no cents and no "≈".
  - Units with no cost are skipped on **both** sides and footnoted
    `N unit(s) without a cost excluded`.
- **`metrics.js`** — `utilization(units)` returns
  `{ units: {onRent, total, pct, band, label, color},
     dollars: {…, excluded} }`.
- **Mock** — `mock-full` gains one rentable unit with `acquisition_cost: null`
  so the footnote path is exercised; `mock-empty` keeps every cost so the
  no-footnote path is too. The `fleet_totals` reducer is null-safe.
- `BUILD` stamp and SW cache bumped (v12 → v13).

## Tests

`npm test` — 102 checks green, also under `TZ=Pacific/Pago_Pago`. Eleven new:
dollar % on a mixed set, demo/loaner capital counted as not-on-rent, a missing
cost excluded from both sides and counted, every cost missing → `null` rather
than NaN, both bars sharing one band vocabulary across all eight edges, and the
order's live example (18/35 units = 51 %; $251,624 / $421,578 = 60 % Building).
Two render assertions cover the landing: two captioned bars in one card, the
sub-line's format, the band class sitting on the bar, and the footnote showing
on `full` and hiding on `empty`.

Browser-verified at 390×844: one card, one header, two equal-length bars
(434px each), captions left-aligned, percent + word right-aligned, no overflow,
no console exceptions.

## Decisions I made

1. **`utilization()` was reshaped rather than duplicated.** The order specifies
   `utilization(units)` returning `{units, dollars}`, but a function of that
   name already held the D19 math in a flat shape. Reshaping it keeps one
   entry point for "how utilized is the fleet"; the existing D19 assertions
   moved to `.units` with their intent unchanged, and `band()` is untouched.
   The alternative — a second function beside the first — would have left two
   near-identical population filters to drift apart.

2. **The band class moved from the card to each bar.** It used to sit on
   `.util` and tint the whole block. Two bars can legitimately land in
   different bands on one fleet, which is the entire point of the second bar,
   so each carries its own colour.

3. **Each side keeps `label` and `color`, not just `band`.** The order's stated
   shape lists `band`; the renderer needs the word and the colour too, and
   spreading `band()` into each side is how the existing code already did it.

4. **`total` replaces `denom`** in the returned shape, per the order's naming.

5. **The footnote counts units, not dollars** — "1 unit without a cost
   excluded". How much money is missing is unknowable, which is why the unit is
   excluded in the first place; claiming a dollar figure there would be a
   fiction.

6. **A non-finite cost (`NaN`, `Infinity`) is treated as missing, not as zero** —
   same reasoning as `null`. Asserted.

7. **One costless unit was added to `mock-full` only.** The exit criteria ask
   for the footnote to appear "on the variant that has a null cost", which
   implies one variant has none. Setting a property consumes no RNG, so the
   other mock values did not churn.

## Things worth flagging

**None blocking.**

- **On mock the two bars nearly agree (54 % vs 55 %)**, because
  `make-mock-data.js` draws every acquisition cost from one random range with
  no relation to category. A real fleet's riders cost several times a
  walk-behind, so on real data the bars should diverge much more — which is the
  feature's whole point. This is a property of the fixture, not of the maths;
  the assertions pin a deliberately skewed case (60 % dollars vs 51 % units) so
  the divergence is proven regardless. Making the mock's costs scale with
  category would demo better and would be more realistic, but it churns every
  mock money value and was outside this order — worth doing next time the mock
  is touched.

- **`acquisition_cost: null` is now present in a mock snapshot.** The contract
  in `CLAUDE.md` shows the field as `0` in its example, and the order tells the
  client to tolerate `null`/missing — so the two are consistent in spirit. If
  the engine can in fact never emit a null cost, the footnote is dead code that
  costs nothing; if it can, it is now handled. No contract change was made or
  is being asked for.

---

# D45 — Cost + book leave the site; utilization comes pre-computed (2026-09-04)

Built from `Cost-Privacy-Site-Spec.md` (below its cut line). **Site-only** — no
Worker, DNS, token or secret changes, and no `wrangler deploy`. The contract
change (schema 4) is the Architect's; this repo consumes it and keeps rendering
schema 3 until the engine switches over.

## What shipped

- **`units[]` no longer carries `acquisition_cost` or `book`**, and neither is
  read anywhere on the site. `ask` stays. The unit page's Money card is now Ask
  plus the rate card; nothing else on it moved.
- **`meta.fleet_totals`** is `{ units: N }`. **`meta.utilization`** carries the
  two percentages and an exclusion count — and no amounts.
- **`metrics.js` gained `utilizationFrom(snapshot)`**: the engine's numbers when
  `meta.utilization` is present, the existing `utilization(units)` computation
  when it isn't.
- **The `$X on rent of $Y` sub-line is gone.** The landing page now matches no
  `$…` figure at all. The units bar keeps its machine-count sub-line, and the
  `N unit(s) without a cost excluded` footnote is sourced from the engine.
- **Mock emits schema 4.** `mock-legacy.json` is rebuilt as an authentic
  schema-2 file (see decision 3).
- `BUILD` stamp and SW cache bumped (v13 → v14). README updated.

## Tests

`npm test` — 115 checks green, also under `TZ=Pacific/Pago_Pago`. Eleven new:
schema-4 values taken from `meta.utilization` untouched with no amount
appearing, the engine winning over stale unit costs, the schema-3 fallback
matching `utilization(units)` exactly, malformed/absent metadata degrading to
`—` rather than NaN, no dollar amount anywhere on the landing, Ask present and
Cost/Book absent across eight unit pages, a unit stripped of every money field
rendering clean, and the schema-2 fixture rendering through the fallback with
its costs still off the screen.

Browser-verified at 390×844 on both the schema-4 and schema-2 fixtures: two
bars, no dollar amount anywhere on the landing, the unit Money card reading
`Ask` plus rates, no console exceptions.

## Decisions I made

1. **The engine's `meta.utilization` wins even when `units[]` still carries
   costs.** A transitional snapshot could plausibly have both. Recomputing
   would let this page show a different number than the vault computed, for the
   same fleet, with no way to tell which is right. Asserted explicitly.

2. **The dollar bar has no sub-line at all, on either schema.** The order says
   to delete it because schema 4 has no amounts *and* because we don't want
   them shown on schema 3. So the deletion is unconditional rather than
   conditional on the schema — the bar is a percentage and nothing else. This
   leaves the card slightly asymmetric (the units bar keeps its count
   sub-line); at 390px the footnote sits where the second sub-line was and the
   card still balances.

3. **`mock-legacy.json` was rebuilt as a genuine schema-2 file rather than
   inheriting the strip.** It is generated by downgrading the full snapshot, so
   removing cost and book upstream silently removed them from it too — and an
   authentic pre-schema-4 snapshot has both. The downgrade now puts them back
   from the generator's ledger. That keeps the file honest (its stated job
   since D42) and makes it do double duty: it has no `meta.utilization`, so
   rendering it exercises the fallback end to end, and it still carries cost
   and book, so it proves the page *ignores* those fields rather than merely
   not being sent them. A stripped fixture could not have proved that.

4. **Costs live in a ledger returned beside the snapshot, never inside it.** The
   generator still needs costs to compute `meta.utilization` the way the engine
   does. `build()` now returns `{ snapshot, ledger }` rather than attaching the
   ledger to the object it serialises — there is no code path by which a cost
   can reach a published mock file, even by mistake. Verified: neither
   `acquisition_cost` nor `book` appears anywhere in `mock-full.json` or
   `mock-empty.json`.

5. **`fromMeta()` returns no `total` or `onRent` on the dollars side** — not
   even `null`. Schema 4 carries no dollar amounts, and a key that looks like
   an amount is an invitation for a future renderer to print one. A test
   asserts both are `undefined`.

6. **A malformed `meta.utilization` degrades to "—" rather than falling back to
   client computation.** If the engine sent something the page can't read, the
   honest answer is "no number", not a second number computed from data the
   snapshot may no longer carry.

7. **`utilization(units)` keeps its name and shape** as the schema-3 fallback,
   per the order. Its doc comment now says out loud that it only has costs to
   add up on a schema-3 snapshot.

## Things worth flagging

**None blocking.**

- **The repo's `CLAUDE.md` is still v1.8, not v1.9.** The order said to read
  v1.9 and the spec says the schema-4 change is "mirrored into `CLAUDE.md` by
  the Architect", but the copy in this repo (HEAD `7ed75e8`, "synced from the
  vault master") still documents schema 3, `fleet_totals` with cost/book/ask,
  and `units[].acquisition_cost` / `book`. I built to the spec's §1, which
  states the change explicitly, and did not edit `CLAUDE.md` — it is the
  Architect's file and syncing it is not mine to do. **`CLAUDE.md` lines 120,
  127 and 128 now describe fields this site no longer receives or reads**, and
  should be synced before the next order is written against it.

- **D12 is now partly obsolete.** `CLAUDE.md` still says everyone "reads
  everything including cost/book/ask". After this order nobody reads cost or
  book, because they no longer exist in the snapshot. This is a *privacy by
  contract* change rather than a role change: there is still no per-role
  hiding on this site, and this order did not add any. Worth stating in v1.9 so
  a future session doesn't reintroduce a cost display on D12's authority.

- **The two bars still nearly agree on mock (54 % vs 55 %)** for the reason
  given in the D44 notes — the generator draws every cost from one flat random
  range. Unchanged by this order, and now less visible since the amounts are
  gone. The skewed case stays pinned in `selftest-metrics.mjs`.

- **`mock-legacy.json` deletion is now more load-bearing than it was.** The
  README already says to delete it after the cutover; note that doing so also
  removes the only fixture exercising the schema-3 utilization fallback. Delete
  the fallback and its unit tests at the same time, or keep the fixture until
  both go.
