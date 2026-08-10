# Audit and repair journal

Original audit scope: whole repository, static analysis only. During that phase,
no builds, tests, benchmarks, or program execution were used; findings were
recorded only after independent evidence checks. The later repair and proof
phases are recorded below.

## Findings

The entries below were promoted only after a second static path (caller, schema,
history, framework source, or projection) reproduced the same failure shape.

### F-01 — pause finalization can commit the wrong lifecycle outcome (P1, high confidence)

- Contract/owner: `CrawlRuntime` must commit exactly the currently requested
  lifecycle outcome; the durable run row and settled event are the authority.
- Evidence: `server/runtime/CrawlRuntime.ts:531-551` evaluates
  `pauseRequested && !forceStopRequested`, then awaits renderer shutdown before
  persisting `paused`. `requestForceStop()` at `:258-277` clears
  `pauseRequested`, sets `forceStopRequested`, aborts work, and awaits the same
  renderer close; `interrupt()` at `:279-288` similarly sets `interrupted`.
  There is no flag re-check after the await. `CrawlManager.stop()` exposes the
  concurrent pause/force requests (`server/runtime/CrawlManager.ts:248-277`),
  and shutdown calls `interrupt()` (`:350-363`).
- Failure: a force stop or shutdown arriving during renderer close can leave a
  crawl durably `paused`, emit `crawl.paused`, and skip the required `stopped`
  or `interrupted` transition.
- Repair radius: centralize/recheck finalization after asynchronous cleanup;
  prove pause-vs-force and pause-vs-shutdown races at the runtime boundary.

### F-02 — strict consent policy uses the requested URL, not the final document URL (P2, high confidence)

- Contract/owner: consent strictness is hostname policy in `consent.ts`; the
  effective browser document URL is already captured by `DynamicRenderer` and
  is the URL used by downstream link policy.
- Evidence: `server/domain/crawl/DynamicRenderer.ts:1067-1071` stores the final
  document response URL in `documentState.url`, but `:1086-1099` calls consent
  handling and `requiresStrictConsentBypass()` with `item.url`. The policy at
  `server/domain/crawl/consent.ts:76-81` is YouTube-hostname-specific.
  `FetchService.ts:271-280,334-406` and `PagePipeline.ts:352-360` independently
  use the validated effective URL, and the redirect test at
  `server/domain/crawl/__tests__/pagePipeline.test.ts:704-752` proves that
  boundary.
- Failure: a non-YouTube URL redirected to YouTube can treat an undismissed
  consent wall as ordinary content; a YouTube URL redirected away can be
  blocked under the wrong strict policy.
- Repair radius: use the final normalized document URL for consent strictness
  and error reporting; add redirected-to/from-YouTube proof.

### F-03 — terminal SSE streams remain open and consume bounded capacity (P2, high confidence)

- Contract/owner: settled crawl events are terminal for a crawl subscription;
  the SSE plugin owns wire closure and `EventStream` owns subscriber capacity.
- Evidence: settled types are explicit in `shared/contracts/events.ts:19-43`.
  `server/plugins/sse.ts:67-81` only enqueues events; its `close()` is reached
  on cancellation, queue overflow, or error (`:27-65,78-80,108-110`), never on
  a settled event. After runtime settlement, `EventStream.scheduleCleanup()`
  keeps rescheduling while subscribers remain (`server/runtime/EventStream.ts:248-266`).
  The same class limits subscribers to 100 total and 10 per crawl
  (`:23-31,224-240`). The README example opens `EventSource` without a terminal close
  handler (`README.md:205-225`), while the React client closes itself
  (`src/hooks/useCrawlController.ts:287-294`), making the leak client-dependent.
- Failure: a generic/documented client that leaves the stream open permanently
  consumes a subscriber slot; enough settled streams exhaust the global cap.
- Repair radius: close after delivering a settled frame (including replay),
  then prove delivery, closure, and capacity release.

### F-04 — resumable-session discovery drops refreshes while loading (P2, high confidence)

- Contract/owner: the durable `/api/crawls/resumable` projection must become
  discoverable after a crawl settles and must expose recovery errors.
- Evidence: `src/hooks/useCrawlController.ts:328-335` returns immediately when
  `isLoading` is true; settled SSE handling at `:291-293` calls the same refresh
  without queueing/coalescing it. The initial refresh starts at `:390-392` and
  failures only dispatch state/toast actions at `:354-372`. `src/App.tsx:175-190`
  renders the only “View & Resume” entry point only when the local list is
  already non-empty. The server projection includes paused/interrupted runs
  (`server/api/crawls.ts:320-337`).
- Failure: if the initial request overlaps settlement, its pre-settle empty
  response wins and the ignored settled refresh never runs; a failed initial
  request has no visible retry/entry point. The session remains recoverable in
  SQLite but inaccessible from the UI until a reload or unrelated refresh.
- Repair radius: coalesce a refresh-after-in-flight and expose a recovery/error
  entry point independent of current item count.

### F-05 — page-content reads have no crawl/owner isolation (P1 if public or multi-user; contract decision required)

- Contract/owner: page content is owned by its `crawl_id`; public reads must be
  crawl-scoped or authenticated, or the deployment must explicitly be a
  single-user boundary.
- Evidence: `pages` stores `crawl_id` (`server/storage/migrations/0001_schema.sql:52-66`),
  but `server/api/pages.ts:8-35` accepts only a global numeric page ID and
  `server/storage/repos/pageRepo.ts:119-125` selects only by `id`. The
  crawl-scoped page route does verify crawl existence
  (`server/api/crawls.ts:163-181`), showing this is an ownership-boundary
  asymmetry. `server/app.ts:86-110` installs CORS/rate limiting but no auth or
  tenant owner; production binds to `0.0.0.0` and the endpoint is documented
  publicly (`README.md:199,349-351`).
- Failure: a caller who learns/enumerates a page ID can read content from any
  crawl. CORS is not authorization.
- Repair radius: obtain the deployment ownership decision; for multi-user use,
  make the route crawl-scoped/authenticated and migrate callers/docs/proofs.

### F-06 — response-schema failures are exposed as client 422 validation errors (P2, high confidence)

- Contract/owner: `handleAppError` is the global error boundary; request input
  validation is 422, response/projection validation is an internal 500.
- Evidence: `server/errorHandling.ts:7-12,20-38` maps every Elysia
  `ValidationError` to 422 and exposes validation details. The handler is
  installed globally in `server/app.ts:112-119`. Elysia constructs response
  validators with `type === "response"` (`node_modules/elysia/dist/compile/handler/jit.mjs:453-460`;
  `node_modules/elysia/dist/error.mjs:182-191`) and its own payload marks that
  case as 500 (`:342-356`).
- Failure: a malformed handler response or corrupt projection is blamed on the
  caller, can expose internal validation details, and avoids 500 logging.
- Repair radius: branch on `error.type === "response"` at the shared handler;
  keep request-side details only for request validation and add one boundary proof.

### F-07 — fractional `from` bounds are rounded down (P2, high confidence)

- Contract/owner: the crawl-list query accepts RFC date-time strings; the
  storage filter owns exact lower/upper-bound semantics.
- Evidence: `server/contracts/crawls.ts:6-10` accepts `format: "date-time"`.
  `server/storage/repos/crawlRunRepo.ts:27-34` truncates parsed values to
  whole seconds, and `:179-182` applies the result with `updated_at >=`.
  Canonical timestamps use SQLite `CURRENT_TIMESTAMP` second precision
  (`server/storage/migrations/0001_schema.sql:17-20`).
- Failure: `from=...00.500Z` becomes `...00`, admitting a row exactly at
  `...00` that is outside the requested lower bound.
- Repair radius: preserve the represented precision, ceil lower bounds to the
  stored precision, or reject fractional bounds; prove the boundary.

### F-08 — canonical-baseline adoption does not migrate the domain-delay key (P2, conditional on accepted pre-baseline data)

- Contract/owner: persisted `crawl_domain_state.delay_key` must use the current
  hostname/domain-budget key consumed by queue scheduling.
- Evidence: baseline adoption validates schema and rewrites only the migration
  ledger (`server/storage/db.ts:168-201`); it performs no row normalization.
  Current resume restores keys verbatim (`server/domain/crawl/CrawlState.ts:104-110`),
  queue scheduling uses `candidate.domain` (`server/domain/crawl/CrawlQueue.ts:134-156`),
  and current robots evaluation emits `identity.domainBudgetKey`
  (`server/domain/crawl/RobotsService.ts:227-259`; current test
  `server/domain/crawl/__tests__/robotsService.test.ts:154-166`). Historical
  `9309f57`/`fcc2b6b` code emitted `identity.originKey` for the same persisted
  delay field. The accepted lineage names `0008-0010`, but those migration
  sources are not present in this repository, so any normalization they might
  have performed cannot be audited.
- Failure: an adopted row such as `https://example.com` is restored but future
  queue entries consult `example.com`; the persisted crawl-delay watermark is
  bypassed unless an unavailable historical migration already normalized it.
- Repair radius: make the supported lineage source auditable and normalize old
  keys transactionally, with deterministic collision handling and resume proof.

### F-09 — old schema ledgers without `checksum` fail before compatibility/adoption (P2, conditional on supported lineage)

- Contract/owner: migration startup must either upgrade a supported existing
  ledger or emit an intentional, documented unsupported-schema boundary.
- Evidence: current `server/storage/db.ts:210-221` uses `CREATE TABLE IF NOT EXISTS`
  and immediately selects `schema_migrations.checksum`; it cannot add a column
  to an existing table. The historical `0001_crawl_runs.sql` creates
  `schema_migrations` without `checksum`, while historical `fcc2b6b` explicitly
  added the column before reading it (`git show fcc2b6b:server/storage/db.ts`).
  Current code still advertises an accepted pre-baseline ledger in
  `PRE_BASELINE_MIGRATION_LINEAGE`.
- Failure: a database created by the older ledger path fails with a missing
  column before the canonical-baseline decision can run.
- Repair radius: retain an explicit ALTER/backfill path or clearly remove that
  lineage from the supported migration contract.

### F-10 — dark Miku color tokens stopped halfway through the Tailwind projection (P2, high confidence)

- Contract/owner: CSS theme variables and generated utility names must have one
  projection path.
- Evidence: `src/index.css:7-14` defines `--miku-teal-dark` and
  `--miku-pink-dark` only in `:root`; `@theme` at `:31-40` registers neither.
  Consumers request generated utilities such as `text-miku-teal-dark` and
  `hover:bg-miku-teal-dark` across `src/App.tsx`, `src/components/*`, and
  `src/hooks` (for example `App.tsx:185,218,233`). Tailwind 4 is the installed
  pipeline (`package.json:55-67`).
- Failure: the named utilities have no registered Tailwind color token and can
  render without a declaration, so dark text/hover styling silently disappears.
- Repair radius: register both `@theme` color tokens or replace every use with
  an explicit variable utility.

### F-11 — recovered stop outcomes still emit an error toast (P2, medium-high confidence)

- Contract/owner: a command reconciliation that proves the requested durable
  outcome is success/info, not a transport failure.
- Evidence: `src/hooks/useCrawlController.ts:582-593` reconciles failed stop
  commands from a durable snapshot, but dispatches `commandFailed` regardless
  at `:170-184`. `src/hooks/crawlControllerState.ts:617-647` applies the
  recovered crawl and always emits an error effect. The stop API legitimately
  returns 409 for a crawl that is no longer active (`server/api/crawls.ts:62-85`).
- Failure: a concurrent/idempotent stop can leave the correct paused/completed
  state while showing a stale failure toast.
- Repair radius: classify proven recovered outcomes as success/info or suppress
  the stale transport error; retain errors when recovery cannot prove the outcome.

### F-12 — OpenAPI runtime patch leaves declaration imports pointed at missing bundles (P2/P3, high confidence)

- Contract/owner: a dependency patch must keep runtime and declaration projections
  coherent.
- Evidence: `patches/@elysia%2Fopenapi@2.0.0-beta.1.patch:1-76` rewrites only
  `dist/*.js`/`*.mjs` imports. Installed declarations still import paths such as
  `./node_modules/typebox/...` (`node_modules/@elysia/openapi/dist/types.d.ts:1-3`),
  and the corresponding nested files are absent. `tsconfig.base.json:26`
  enables `skipLibCheck`, masking the broken declaration surface. The patch
  README claims the bundle-relative imports are replaced, but declarations are
  untouched.
- Failure: type consumers/editor tooling receive unresolved or degraded OpenAPI
  types while local type checking hides the drift.
- Repair radius: patch/regenerate declarations with the same ownership as the
  runtime patch, or remove the patch once the installed release is coherent.

### F-13 — Render memory documentation overrides its own conservative default (P3, high confidence)

- Contract/owner: deployment examples must preserve the environment owner’s
  platform default.
- Evidence: README says Render defaults to 350 MB but its copyable block sets
  `MEMORY_THRESHOLD_MB=600` (`README.md:141-145`); `server/config/env.ts:108-110`
  confirms an explicit value overrides the Render default.
- Failure: copying the documented block on Render silently selects the less
  conservative browser threshold.
- Repair radius: remove the explicit line or set the Render example to 350 MB.

### F-14 — valid-PDF proof accepts the processing-error fallback (P3, proof gap)

- Contract/owner: the “without errors” test must prove successful extraction,
  not only a defined field.
- Evidence: `server/processors/__tests__/ContentProcessor.test.ts:166-197`
  asserts only `mainContent` is defined. `PdfContentHandler.ts:175-184` applies
  `{ mainContent: "" }` after any parse failure, so a failed fixture satisfies
  the assertion.
- Repair radius: assert no errors and a meaningful extracted-content invariant;
  no production defect is claimed from this entry alone.

### F-15 — scheme-like URLs with numeric suffixes are coerced into HTTP (P2, high confidence)

- Contract/owner: `shared/url.ts` owns URL normalization; its explicit
  forbidden-state contract rejects every non-HTTP(S) scheme.
- Evidence: `shared/url.ts:51-56` detects a scheme-like prefix but exempts any
  string matching `^[^/?#]+:\d`. `ftp:123`, `javascript:123`, and
  `mailto:123` therefore become `http://ftp:123`, `http://javascript:123`,
  and `http://mailto:123` at `:59-61`, then pass the HTTP protocol check at
  `:63-68`. Crawl creation routes through `validatePublicHttpUrl`
  (`server/api/crawls.ts:274-284`); extracted links normalize resolved hrefs
  (`server/processors/extractionUtils.ts:179-194`); and redirect locations use
  the same parser through `normalizeOutboundUrl`
  (`server/outbound/HttpClient.ts:257-265,319-325`).
- Failure: unsupported-scheme input is silently reinterpreted as an HTTP host
  and port, violating the shared parser contract and allowing unintended DNS
  and network requests on all three trust boundaries.
- Repair radius: preserve deliberate bare-host:port support with an explicit
  host grammar, then add boundary proof for unsupported scheme forms through
  creation, extraction, and redirect normalization.

### F-16 — durable recovery can hide a resumable crawl (P2, high confidence)

- Contract/owner: durable `crawl_runs.status` is the recovery authority, and
  the resumable-session list is its UI projection; losing an event must not
  remove the only resume entry point.
- Evidence: `synchronizeDurableSnapshot()` updates the active crawl and closes
  its subscription for resumable or terminal status
  (`src/hooks/useCrawlController.ts:223-252`), but never refreshes the
  resumable list. That refresh is normally triggered only by a received
  settled SSE event (`:285-293`), while the only “View & Resume” entry point
  is rendered when the list is already non-empty (`src/App.tsx:175-190`). A
  lost settled frame or sequence-gap recovery therefore takes the durable
  snapshot path without updating the list.
- Failure: a paused/interrupted crawl remains durable and recoverable but is
  absent from the UI until a reload or unrelated refresh, because recovery
  closes the stream before any list projection refresh.
- Repair radius: refresh or reconcile the resumable projection after durable
  synchronization, and make the recovery entry point independent of a
  previously non-empty list; prove lost-settled-event recovery.

### F-17 — PWA theme projections retain the pre-pastel palette (P3, high confidence)

- Contract/owner: the frontend visual theme is the authority; install and
  browser-chrome metadata are projections of that palette.
- Evidence: the current theme defines pastel colors in `src/index.css:7-23`
  and the inline loader in `index.html:63-67`, while
  `public/manifest.json:7-8` still publishes `#0f172a`/`#10b981` and
  `index.html:40-42` still publishes `#39c5bb`. Commit `83d7d46` changed the
  CSS palette without changing either metadata projection. The manifest tests
  check presence/shape only, not color coherence
  (`src/shared/__tests__/manifest.test.ts:30-76`).
- Failure: installed PWA chrome and browser theme-color surfaces retain the
  old dark-green branding after the app has adopted the pastel palette.
- Repair radius: define one theme metadata authority and update the manifest,
  meta tag, and their proof together.

### F-18 — shutdown during normal renderer cleanup can commit non-resumable `stopped` (P2, high confidence)

- Contract/owner: `CrawlRuntime` owns lifecycle precedence; manager shutdown
  must interrupt every runtime it snapshots, preserving resumability for work
  not durably completed (the documented session-resume contract is in
  `README.md:54`, with shutdown proofs at
  `server/runtime/__tests__/crawlManager.test.ts:1114-1163`).
- Evidence: normal terminalization checks `this.interrupted` only before the
  pause branch (`server/runtime/CrawlRuntime.ts:522-529`), clears queues, then
  awaits `dynamicRenderer.close()` and chooses `finishStopped()` solely from
  `state.stopReason && state.isStopRequested` (`:554-560`).
  `CrawlManager.shutdownAll()` can set `interrupted` and the same stop state
  during that await (`server/runtime/CrawlManager.ts:356-366`; runtime
  `interrupt()` at `CrawlRuntime.ts:279-288`). The post-cleanup path never
  rechecks `interrupted`.
- Failure: shutdown racing renderer cleanup publishes `crawl.stopped` and
  clears the durable queue instead of committing `interrupted`; the runtime
  can become non-resumable despite shutdown having requested interruption.
- Repair radius: make normal, pause, force-stop, and interrupt finalization use
  one post-cleanup lifecycle decision, then prove normal-cleanup-vs-shutdown
  precedence and resumability.

### F-19 — successful pause response is rewritten to transitional `pausing` (P2, high confidence)

- Contract/owner: the durable stop response is authoritative for controller
  phase; a successful pause must leave the UI in resumable `paused` state.
- Evidence: `executeStopCommand()` first dispatches the returned crawl summary
  (`src/hooks/useCrawlController.ts:582-592`), and
  `synchronizeCrawlSummary()` maps a durable `paused` status to `runPhase:
  "paused"` (`src/hooks/crawlControllerState.ts:164-192`). The subsequent
  generic `commandSucceeded` reducer unconditionally rewrites a successful
  non-terminal stop to `"pausing"` (`:597-615`), even though the backend waits
  for durable pause completion (`server/runtime/CrawlManager.ts:261-285`;
  `server/runtime/CrawlRuntime.ts:244-256,531-551`).
- Failure: if the settled SSE frame is delayed or lost, command availability
  continues treating the already-paused crawl as active and the UI does not
  expose its normal resumable state.
- Repair radius: preserve the returned durable phase; retain a transitional
  phase only when the response itself is still `pausing`/`stopping`, and prove
  the reducer sequence for a successful pause.

### F-20 — concurrent dynamic routes oversubscribe the per-page byte budget (P2, high confidence)

- Contract/owner: `DynamicRouteBudget.remainingBytes` is the shared
  `MAX_RESPONSE_BYTES_PER_PAGE` cap for one browser page
  (`server/constants.ts:64-70`; `DynamicRenderer.ts:160-171`).
- Evidence: each route computes its read limit from the current remainder and
  only decrements the shared field after awaiting the entire body
  (`server/domain/crawl/DynamicRenderer.ts:636-654`). Non-document handlers are
  admitted four at a time (`:179-207`) but no byte reservation occurs before
  their reads. Four concurrent responses can therefore all observe the same
  20 MiB remainder, buffer up to roughly 80 MiB, and drive the shared budget
  negative. The existing budget test is sequential
  (`server/domain/crawl/__tests__/dynamicRenderer.test.ts:665-688`); the
  concurrency test proves permits, not byte reservation (`:690-710`).
- Failure: the declared per-page response cap does not bound concurrent
  buffering, allowing a single dynamic crawl page to exceed its memory budget.
- Repair radius: reserve/lease bytes before body reads (or serialize budgeted
  reads), release unused reservation if the contract permits, and add one
  concurrent-response proof.

### F-21 — failure logs are classified as generic logs, so the Error filter hides them (P3, high confidence)

- Contract/owner: the crawl log producer and `parseLog()` must share a failure
  vocabulary so the Logs Error filter is a faithful projection.
- Evidence: runtime failures publish `[Crawler] Failure: ...`
  (`server/runtime/CrawlRuntime.ts:336-348`); terminal pipeline paths publish
  `Transient failure terminal failure`, `No usable page content`, and similar
  messages (`server/domain/crawl/PagePipeline.ts:296-352,364-367`). The parser
  recognizes only `error` or `failed` substrings for its error level
  (`src/utils/logParser.tsx:54-70`), so `failure` and `No usable page content`
  become `unknown`. `LogsSection` offers no Unknown filter, only Error/Warn/
  Info/Success (`src/components/LogsSection.tsx:106-132`).
- Failure: terminal and processing failures remain visible only in the mixed
  log stream and cannot be found through the user-facing Error filter.
- Repair radius: carry explicit severity or centralize the failure vocabulary
  at the log boundary, then prove each emitted terminal failure maps to Error.

### F-22 — static and dynamic fetch disagree on successful responses without `Content-Type` (P2, high confidence)

- Contract/owner: `FetchService` owns document classification; static and
  dynamic acquisition must produce the same outcome for the same successful
  response.
- Evidence: static fetch rejects a missing/unsupported content type before
  reading (`server/domain/crawl/FetchService.ts:362-370`). Dynamic routing only
  rejects an unsupported type when the header is non-empty
  (`server/domain/crawl/DynamicRenderer.ts:611-626`), then reads a missing-type
  document using the 1 MiB limit (`:636-644`) and returns a successful result
  whose fallback type is `"text/html"` (`:1144-1152`). A missing-type body over
  1 MiB is therefore classified as dynamic `tooLarge`, which `FetchService`
  maps to blocked HTTP 413 (`:211-216`), while static mode classifies the same
  2xx response as unsupported without buffering.
- Failure: enabling dynamic rendering changes a successful missing-type page
  from an unsupported skip to a size-blocked failure, with different retry,
  counters, and user-visible outcomes.
- Repair radius: centralize content-type admission before either read path (or
  define an explicit missing-type policy), then prove parity for missing and
  oversized responses.

### F-23 — pre-baseline adoption cannot restore historical failure/skip terminals (P2, conditional on accepted pre-baseline data)

- Contract/owner: a resumable crawl's durable terminal rows and counters must
  reconstruct the same terminal outcomes before `CrawlState` resumes it.
- Evidence: historical migration `0004_runtime_persistence.sql` populated
  `crawl_terminal_urls` from `pages` and marked every reconstructed row
  `success` (`git show 9309f57:server/storage/migrations/0004_runtime_persistence.sql:18-20`).
  Historical runtime/state counted failure and skip outcomes as terminal
  (`git show bba6cd8:server/runtime/CrawlRuntime.ts:192-199`;
  `git show 7998a58:server/domain/crawl/CrawlState.ts:173-207`). Current
  baseline adoption only validates schema and rewrites the migration ledger
  (`server/storage/db.ts:168-201`); it does not reconcile those rows. Resume
  now requires terminal-row count to equal durable `pagesScanned`
  (`server/domain/crawl/CrawlState.ts:143-168`, called by
  `server/runtime/CrawlRuntime.ts:222-232`). The supported pre-baseline lineage
  is explicitly listed in `db.ts:92-133`.
- Failure: an accepted paused/interrupted pre-baseline crawl containing any
  historical failure or skip can fail resume with
  `Persisted terminal rows must match the durable terminal counter`, or
  reconstruct all migrated outcomes as successes if the counts happen to
  align.
- Repair radius: make the historical lineage/data policy auditable; reconcile
  terminal outcomes transactionally where possible, or mark irrecoverable old
  runs non-resumable with an explicit user-visible outcome and proof for
  success-only and failure/skip cases.

### F-24 — pre-baseline terminal URLs with DNS trailing dots fail current resume identity (P2/P3, conditional on accepted pre-baseline data)

- Contract/owner: persisted queue and terminal URLs must already satisfy the
  current canonical URL identity before `CrawlQueue`/`CrawlState` restore them.
- Evidence: historical URL normalization lowercased hostnames but retained a
  terminal DNS dot (`git show 9309f57:shared/url.ts:95-96`), while current
  normalization removes it (`shared/url.ts:63-70`). Current queue and terminal
  restoration reject any record whose canonical URL differs from its stored
  value (`server/domain/crawl/CrawlQueue.ts:39-53`; `server/domain/crawl/CrawlState.ts:143-153`).
  Baseline adoption performs no URL projection rewrite (`server/storage/db.ts:168-201`).
- Failure: an accepted paused/interrupted legacy crawl containing
  `https://example.com./` can fail resume with an invalid queued/terminal URL
  even though the resource is a valid DNS alias.
- Repair radius: normalize target/options/queue/terminal/page projections
  transactionally with deterministic collision handling, or explicitly remove
  this lineage from the supported compatibility contract and prove the chosen
  boundary.

## Repair migration ledger

| Findings | Retired authority/failure path | Current authority and migrated surfaces | Status |
| --- | --- | --- | --- |
| F-01, F-18 | Lifecycle choice made before renderer cleanup | `CrawlRuntime.finalizeRequestedLifecycle()` decides force-stop → interrupt → pause → policy stop → completion after cleanup; manager/runtime proofs cover pause/force, pause/shutdown, normal-cleanup/shutdown, and circuit-breaker settlement | Implemented; runtime proofs passed |
| F-02 | Consent strictness derived from requested queue URL | Final routed document URL feeds the consent decision and diagnostics | Implemented; owner proof passed |
| F-03 | Settled SSE subscriptions stayed live | SSE delivery flushes replay/live frames through the settled event and closes; a native `EventSource` reconnect with no unseen terminal frame receives 204, preventing a replacement idle subscription | Implemented; wire and reconnect proofs passed |
| F-04, F-16 | In-flight refreshes were dropped and durable settlement updated only active state | The controller coalesces one follow-up refresh; durable resumable/terminal snapshots request it; loading and failure entries remain reachable without a non-empty list | Implemented; coalescing and reducer proofs passed |
| F-05 | Global page-id content lookup and `/api/pages/:id/content` | Crawl-scoped `/api/crawls/:id/pages/:pageId/content` and `(crawl_id, id)` repository lookup; server, Eden client, UI, OpenAPI, tests, and README migrated; global route deleted | Implemented; API isolation proof passed |
| F-06 | All `ValidationError` instances projected as client input failures | Global error boundary treats response validation as logged, generic 500; request validation remains diagnostic 422 | Implemented; boundary proof passed |
| F-07 | Fractional list bounds were truncated | Crawl-run repository ceils lower bounds and floors upper bounds to stored second precision | Implemented; storage boundary proof passed |
| F-08, F-09, F-23, F-24 | Migration lineage and checksum bookkeeping claimed unsupported upgrade compatibility | `server/storage/schema.sql` is the only schema authority; matching databases persist and incompatible databases are replaced from scratch | Implemented; persistence and reset proofs passed |
| F-10, F-17 | CSS theme facts stopped before Tailwind/PWA projections | CSS tokens remain authority; dark Tailwind tokens, manifest, and HTML projections are synchronized by one static contract test | Implemented; projection proof passed |
| F-11, F-19 | Command completion rewrote durable state and recovered success still emitted failure | Reducer preserves settled durable phases and suppresses an error only when recovery proves the requested stop outcome | Implemented; reducer proofs passed |
| F-12 | Runtime-only OpenAPI patch left unpublished declaration imports | Dependency patch rewrites every nested declaration import to installed public packages and removes the absent Scalar type dependency; reinstall and declaration proof cover the projection | Implemented; install/proof passed |
| F-13 | Render example overrode the owned conservative default | README no longer sets an override, so environment policy owns the 350 MB Render and 600 MB non-Render defaults | Implemented; repository check passed |
| F-14 | PDF success proof admitted the error fallback | Valid-PDF proof now requires no errors and extracted `Hello World` content | Implemented; processor proof passed |
| F-15 | Generic `name:number` text bypassed the scheme guard | Bare ports require an explicit dotted host, `localhost`, or bracketed literal; scheme-like numeric suffixes are rejected | Implemented; shared URL proof passed |
| F-20 | Concurrent readers decremented a shared byte counter after reads | One existing `WorkPermitPool` permit serializes each budget-owned body read and charge | Implemented; concurrent proof passed |
| F-21 | UI inferred failure severity from message spelling | `crawl.log` carries explicit severity from terminal-outcome producers through the shared schema-derived `CrawlLogLevel`, reducer, and filter projection | Implemented; contract/UI proofs passed |
| F-22 | Dynamic success without `Content-Type` bypassed document admission | Dynamic and static paths both reject missing/unsupported document types before body processing | Implemented; dynamic boundary proof passed |

Compatibility decision: the repository provides no database-schema upgrade compatibility.
`server/storage/schema.sql` is the only supported schema. Matching databases retain their data;
incompatible databases are replaced from scratch at startup.

The closure review also removed repeated severity unions, replaced private-field lifecycle-test
reach-through with constructor injection of the runtime's renderer capability, and proved that the
domain-state lookup still uses the retained primary-key index. The final persistence decision keeps
one current schema and no migration ledger or numbered migration files.

## Held or disproven hypotheses

- SPA `decodeURI` configuration is held: the patched dependency and production
  mounts differ, but no integration proof establishes a broken encoded-path
  request.
- Clipboard API availability and `readLimitedResponseBody` reader-lock release
  are environmental/lifecycle candidates without a demonstrated repository
  failure path.
- Search returning an empty result for an unknown crawl, raw-content-only page
  display, and resume status propagation are contract asymmetries; no material
  failure was established.
- Recovery snapshots read the crawl row and page projection separately; a
  same-instant aggregate contract was not established, so the possible
  interleaving remains held rather than promoted.
- Dynamic iframe/popup authorization, queue retry ownership, runtime event
  ordering, stale production bundles, and SSRF redirect validation were traced
  and not promoted.
- The terminal-crawl trigger URL-coverage hypothesis was withdrawn: its
  `UPDATE OF crawl_id` guard covers crawl-status transitions, while the adjacent
  terminal-URL trigger already covers `UPDATE OF crawl_id, url`.

## Ponytail candidates recorded during the read-only audit

These were the pre-repair candidates. All were subsequently resolved; the
implemented end state and retained custom owners are recorded in
`PONYTAIL-2026-08-10.md`.

- `delete`: remove unsupported `animate-in`, `fade-in`, and
  `slide-in-from-*` utility tokens in `src/components/LogsSection.tsx:23,174`
  and `src/components/ToastNotification.tsx:77`; no installed animation plugin
  or owned CSS defines them. Estimated net: a few class tokens removed, no new
  dependency.
- `delete`: remove `CrawlState.canScheduleMore()` and its tests; `rg` finds no
  production caller (`server/domain/crawl/CrawlState.ts:127-129`). Estimated
  net: roughly 20 lines removed.
- `delete`: remove `"global"` from `PUBLIC_IP_RANGES` in `shared/ipPolicy.ts:3`;
  ipaddr.js returns `unicast` as the default range and defines no `global` range,
  so the entry is inert.
- `shrink`: remove the dead `scripts` include from `tsconfig.bun.json:12`; the
  last script was deleted in `5edbb8e` and no `scripts/` directory exists.
- `delete`: remove redundant `idx_crawl_domain_state_crawl_id` with an immutable
  forward migration; the primary key already indexes `(crawl_id, delay_key)`.
  Estimated net: one redundant write path without invalidating the shipped baseline.
- `delete`: remove `credentials: true` from `server/app.ts:89-92`; the browser
  client sends no credentialed requests and the repository has no auth/cookie
  contract (`src/api/client.ts:10-26`).
- `delete`: remove `https://*.vercel.app` from `index.html:18`; no repository
  image source uses that origin, so the CSP allowlist entry has no owned
  consumer.
- `shrink`: remove inert `checkJs: false` from `tsconfig.base.json:15-17`;
  `allowJs: false` already excludes JavaScript.

Original estimate: net -27 lines, -0 dependencies.

The original audit phase above was static. The first repair closure ran the offline frozen
dependency install and full repository check. The follow-up closure passed typechecking, Biome,
and targeted owner-boundary tests after repairing SSE reconnect termination and the immutable
baseline upgrade; the full suite and production build were not repeated under the requested
lightweight-validation constraint.
