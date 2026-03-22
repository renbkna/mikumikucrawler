# Backend Refactor Plan

## Purpose

This document is the execution plan for the backend rewrite of MikuMikuCrawler.
It is intentionally self-contained and assumes a clean-break refactor is allowed
inside the implementation branch. Temporary breakage during the refactor is
acceptable. The goal is a lean 2026-style Bun + Elysia backend with fewer
boundaries, stronger contracts, cleaner persistence, and a runtime model that
matches the product.

This plan addresses:

- the current socket-owned crawl lifecycle
- incomplete resume architecture
- transport drift between WebSocket, raw fetch, and Eden
- JSON-heavy session persistence
- weakly testable DNS/fetch seams
- doc and contract drift
- dead compatibility surfaces

## Final Decision

Do not wipe the whole project. Replace the backend architecture in place.

Keep:

- Bun runtime
- Elysia app framework
- SQLite datastore
- the useful crawler domain concepts: queueing, renderer fallback, content
  processing, robots handling, extraction, quality gates

Remove or replace:

- WebSocket as the primary control plane
- socket-owned crawl identity
- route-level JSON reparsing of runtime state
- compatibility re-export shims
- mixed frontend access paths
- deprecated Swagger plugin usage

## Why This Is The Optimal End State

This is the most modern, lean, and sterile architecture for the product as it
exists today.

Reasons:

- Crawl telemetry is one-way. HTTP + SSE is a better fit than a bidirectional
  WebSocket command protocol.
- Elysia is strong at typed app boundaries, plugin composition, OpenAPI, Eden,
  and observability. It should own the application edge, not the crawl core.
- SQLite is still the right datastore for a single-node crawler.
- Adding a worker bus, ORM, Redis, or distributed execution would add failure
  modes and abstraction before there is product pressure to justify them.
- The real architectural problems are identity, lifecycle, persistence shape,
  and boundary cleanliness, not framework choice.

## Architecture Principles

### Core rules

1. A crawl is owned by `crawlId`, never by a browser connection.
2. Browser connections are subscribers, never runtime owners.
3. Elysia owns transport and contracts. Crawl logic stays framework-agnostic.
4. The database schema must represent real product concepts directly.
5. A route handler must not parse opaque JSON blobs to answer basic API queries.
6. Network-facing security and fetch logic must be injectable and testable.
7. Delete dead surfaces instead of preserving compatibility theater.

### Optimization rules

1. Optimize architecture first, micro-performance second.
2. Use Bun-native capabilities where they simplify the system.
3. Prefer thin explicit repositories over heavy abstraction layers.
4. Prefer SSE over WebSocket unless the product truly needs bidirectional
   low-latency control.
5. Prefer one typed frontend client path.

## Target End State

### Backend stack

- Bun
- Elysia
- `bun:sqlite`
- Eden Treaty
- Elysia OpenAPI plugin
- Elysia OpenTelemetry and Server Timing integration
- native `EventSource` for realtime telemetry

### Runtime model

- `POST /api/crawls` creates a crawl run and returns `crawlId`
- `POST /api/crawls/:id/stop` requests graceful stop
- `POST /api/crawls/:id/resume` resumes an interrupted crawl
- `GET /api/crawls/:id` returns current state and counters
- `GET /api/crawls` lists recent/resumable runs
- `GET /api/crawls/:id/events` streams ordered SSE events

### Data model

- `crawl_runs`
- `crawl_queue_items`
- `pages`
- `page_links`
- `schema_migrations`

`crawl_runs` must have typed lifecycle/counter columns. Keep one validated
`options_json` column instead of over-normalizing every option.

### Application layers

- `contracts`
- `plugins`
- `api`
- `runtime`
- `domain`
- `storage`

## Target Directory Layout

```text
server/
  app.ts
  plugins/
    db.ts
    logger.ts
    openapi.ts
    telemetry.ts
    security.ts
  contracts/
    crawl.ts
    page.ts
    search.ts
    events.ts
    errors.ts
  api/
    crawls.ts
    pages.ts
    search.ts
    health.ts
    sse.ts
  runtime/
    CrawlManager.ts
    CrawlRuntime.ts
    EventStream.ts
    RuntimeRegistry.ts
  domain/
    crawl/
      CrawlQueue.ts
      CrawlState.ts
      PagePipeline.ts
      FetchService.ts
      DynamicRenderer.ts
      RobotsService.ts
      UrlPolicy.ts
    processing/
      ContentProcessor.ts
      analysisUtils.ts
      extractionUtils.ts
      sentimentAnalyzer.ts
  storage/
    db.ts
    migrations/
      0001_*.sql
      0002_*.sql
    repos/
      crawlRunRepo.ts
      crawlQueueRepo.ts
      pageRepo.ts
      searchRepo.ts
      statsRepo.ts
```

## Public Contract

## Crawl statuses

```text
pending -> starting -> running -> stopping -> completed
                           |         |
                           |         -> stopped
                           -> failed
                           -> interrupted
```

Rules:

- `completed`, `failed`, and `stopped` are terminal
- `interrupted` is resumable
- disconnecting the browser must not change crawl status

## HTTP endpoints

### `POST /api/crawls`

Input:

- target
- crawl options

Output:

- `crawlId`
- initial status

### `POST /api/crawls/:id/stop`

Input:

- none

Output:

- accepted status
- current crawl state

### `POST /api/crawls/:id/resume`

Input:

- none

Output:

- resumed status

### `GET /api/crawls/:id`

Output:

- identity
- lifecycle status
- typed counters
- timestamps
- stop reason if present
- resumable flag

### `GET /api/crawls`

Output:

- recent runs
- resumable runs
- optional filters by status and date

### `GET /api/crawls/:id/events`

Output:

- ordered SSE event stream

## SSE event union

- `crawl.started`
- `crawl.progress`
- `crawl.page`
- `crawl.log`
- `crawl.completed`
- `crawl.failed`
- `crawl.stopped`

Each event must include:

- `crawlId`
- `sequence`
- `timestamp`
- typed payload

## Storage Design

## `crawl_runs`

Required columns:

- `id`
- `target`
- `status`
- `stop_reason`
- `options_json`
- `created_at`
- `started_at`
- `updated_at`
- `completed_at`
- `pages_scanned`
- `success_count`
- `failure_count`
- `skipped_count`
- `links_found`
- `media_files`
- `total_data_kb`

Rules:

- counters are typed columns
- lifecycle timestamps are typed columns
- `options_json` is validated before persistence
- API must read typed counters directly

## `crawl_queue_items`

Required columns:

- `id`
- `crawl_id`
- `url`
- `depth`
- `retries`
- `parent_url`
- `domain`
- `created_at`

Rules:

- unique on `(crawl_id, url)`
- all queue restoration is scoped to one crawl run

## `pages`

The current architecture uses globally stored pages but resume behavior assumes
run-scoped history. That mismatch must be removed.

Implementation rule:

- add `crawl_id` to page storage, or add a run-page join table

Recommendation:

- add `crawl_id` directly unless a shared-content cache becomes an explicit
  product feature later

Required columns stay mostly similar:

- `id`
- `crawl_id`
- `url`
- `domain`
- `crawled_at`
- `status_code`
- `content_type`
- `data_length`
- `title`
- `description`
- `content`
- processed-analysis fields

## `page_links`

- `id`
- `page_id`
- `target_url`
- `text`

## Migration strategy

- create `schema_migrations`
- move all schema changes into ordered migration files
- remove import-time `ALTER TABLE` logic entirely

## Runtime Design

## `CrawlManager`

Responsibilities:

- create crawl runtimes
- stop runtimes
- resume interrupted runs
- expose runtime snapshots
- own registry of active runtimes keyed by `crawlId`

Must not:

- contain Elysia route logic
- contain SQL strings

## `CrawlRuntime`

Responsibilities:

- lifecycle state transitions
- queue execution
- event emission
- periodic persistence of typed counters
- graceful stop
- interruption handling

Rules:

- runtime emits domain events to an event sink
- runtime never talks to browser sockets directly
- runtime never owns subscriber connections

## Domain Refactor Rules

Keep the ideas, not the current boundary violations.

### `CrawlQueue`

Keep:

- concurrency limit
- domain delay handling
- deduplication
- retry scheduling

Change:

- remove direct socket emission
- remove persistence assumptions from queue internals where possible
- make persistence an injected collaborator

### `CrawlState`

Keep:

- typed counters
- circuit-breaker logic
- visited tracking
- domain page budgets

Change:

- fix counter semantics so one URL contributes exactly one terminal outcome
- remove transport-specific emit helpers

### `PagePipeline`

Keep:

- fetch -> process -> robots -> quality -> store -> enqueue phases

Change:

- emit events through a runtime sink, not transport primitives
- fix stats invariant
- make success/skip/failure mutually exclusive terminal accounting
- remove route/framework assumptions

### `DynamicRenderer`

Keep:

- lazy browser init
- static fallback behavior
- lifecycle cleanup

Change:

- inject configuration through runtime/domain setup
- keep isolated from Elysia

## Security and Fetch Plan

The current SSRF design goal is correct. The seam is not.

### Introduce `Resolver`

Responsibilities:

- resolve hostnames
- validate that all resolved addresses are public
- cache validated resolutions

### Introduce `HttpClient`

Responsibilities:

- perform IP-pinned fetch
- preserve host header and TLS server name
- accept abort signals and redirect mode

### Validation split

- request DTO validation only checks shape and value ranges
- DNS resolution must not happen inside simple route input parsing
- network resolution belongs to fetch/security services

Result:

- deterministic tests
- no module-bound DNS mocking problems
- clear responsibility split

## Frontend Plan

The frontend must end with one data path.

### Replace

- raw WebSocket lifecycle
- raw `fetch` session handling
- mixed Eden/raw API access

### With

- Eden Treaty for commands and queries
- `EventSource` for crawl telemetry
- one `useCrawlController` hook/store

### `useCrawlController` owns

- active `crawlId`
- EventSource connection state
- stats accumulation
- page accumulation
- log accumulation
- start/stop/resume/list/export actions

## Observability Plan

Use Elysia for app-boundary observability.

Add:

- OpenAPI plugin
- OpenTelemetry integration
- Server Timing for request diagnostics

Do not:

- mix observability concerns into crawl-domain logic

## Step-By-Step Execution Plan

## Phase 0: Lock the direction

Goal:

- prevent more work on the old architecture while the rewrite starts

Steps:

1. Freeze WebSocket-control feature work.
2. Mark current socket transport as deprecated in internal docs.
3. Create implementation branch for backend rewrite.
4. Treat this plan as the source of truth for sequencing.

Done when:

- no new work is being added on top of the old socket lifecycle

## Phase 1: Write the new spec

Goal:

- define the new contract before touching implementation

Steps:

1. Create `docs/architecture/crawl-runtime-spec.md`.
2. Define all public DTOs, statuses, SSE events, lifecycle transitions, and
   forbidden states.
3. Define resume semantics explicitly.
4. Define typed counter semantics explicitly.
5. Define run-scoped page persistence semantics explicitly.

Done when:

- the new runtime contract can be implemented without guessing

## Phase 2: Create contracts and app boundary skeleton

Goal:

- build the new Elysia-first boundary before moving domain logic

Steps:

1. Add `server/app.ts` as the new composition root.
2. Add Elysia plugins for db, logger, OpenAPI, telemetry, and security.
3. Add `server/contracts/*` schemas and DTO types.
4. Replace deprecated Swagger usage with Elysia OpenAPI.
5. Add route groups for `crawls`, `pages`, `search`, `health`.

Done when:

- new routes compile with typed contracts even if handlers are still stubbed

## Phase 3: Rebuild storage cleanly

Goal:

- replace bootstrap-time schema mutation with explicit migrations and repos

Steps:

1. Create `server/storage/migrations`.
2. Add `schema_migrations`.
3. Create migration for `crawl_runs`.
4. Create migration for `crawl_queue_items`.
5. Add `crawl_id` to page storage or create a run-page join table.
6. Implement typed repos.
7. Delete import-time migration logic once parity is reached.

Done when:

- the app boots without ad hoc `ALTER TABLE` logic
- core API reads typed columns instead of reparsing JSON

## Phase 4: Implement new runtime core

Goal:

- separate lifecycle/runtime from Elysia and transport

Steps:

1. Implement `RuntimeRegistry`.
2. Implement `EventStream`.
3. Implement `CrawlManager`.
4. Implement `CrawlRuntime`.
5. Move current lifecycle logic out of socket handlers.
6. Replace socket-oriented ownership with `crawlId` ownership.

Done when:

- a crawl can exist and progress without any connected browser

## Phase 5: Refactor domain modules behind runtime interfaces

Goal:

- preserve useful crawler behavior while removing transport coupling

Steps:

1. Rename and relocate queue/state/pipeline modules into `server/domain/crawl`.
2. Remove direct socket emission.
3. Introduce an event sink interface.
4. Fix stats accounting.
5. Scope visited-page restoration to one crawl run.
6. Keep retry/backoff/domain-delay behavior but make persistence injected.

Done when:

- crawl-domain modules no longer depend on WebSocket or Elysia types

## Phase 6: Refactor security and fetch seams

Goal:

- make SSRF/fetch behavior deterministic and contract-testable

Steps:

1. Introduce `Resolver` interface.
2. Introduce `HttpClient` interface.
3. Move DNS validation out of route parsing.
4. Keep IP-pinned fetch behavior.
5. Replace module-bound DNS dependency with injected resolver/client setup.

Done when:

- all SSRF/fetch tests run without real DNS dependency

## Phase 7: Implement HTTP + SSE endpoints fully

Goal:

- complete the new API surface

Steps:

1. Implement `POST /api/crawls`.
2. Implement `POST /api/crawls/:id/stop`.
3. Implement `POST /api/crawls/:id/resume`.
4. Implement `GET /api/crawls/:id`.
5. Implement `GET /api/crawls`.
6. Implement `GET /api/crawls/:id/events`.
7. Keep `GET /api/pages/:id/content` and `GET /api/search`.
8. Rebuild export as HTTP download or HTTP streaming endpoint.

Done when:

- the entire product can operate without the old WebSocket route

## Phase 8: Migrate the frontend

Goal:

- converge on one client architecture

Steps:

1. Remove `useSocket`.
2. Add `useCrawlController`.
3. Move commands/queries to Eden.
4. Move live crawl telemetry to `EventSource`.
5. Rewire resume/start/stop/export/session-list flows.
6. Delete socket event types and handlers.

Done when:

- frontend no longer opens a control WebSocket

## Phase 9: Delete dead architecture

Goal:

- remove the old system completely instead of carrying dual paths

Steps:

1. Remove `/ws` route.
2. Delete socket handler module and socket types.
3. Delete compatibility re-export files.
4. Delete `pageDetails` transport path.
5. Delete orphaned resume contract members.
6. Delete deprecated docs and dead README sections.

Done when:

- there is only one runtime control path and one client data path

## Phase 10: Verification and hardening

Goal:

- prove the architecture matches the contract

Steps:

1. Run endpoint contract tests.
2. Run SSE event ordering tests.
3. Run lifecycle tests.
4. Run migration tests.
5. Run deterministic resolver/http client tests.
6. Run frontend integration flows against the new API.
7. Update docs to match the final system exactly.

Done when:

- docs, tests, and implementation agree

## Required Test Matrix

## API contract tests

- create crawl
- stop crawl
- resume interrupted crawl
- reject resume of terminal crawl
- get crawl state
- list crawl runs
- page-content fetch
- search

## SSE tests

- ordered event delivery
- sequence monotonicity
- subscriber disconnect does not stop crawl
- terminal event emission

## Runtime lifecycle tests

- create -> run -> complete
- create -> stop -> stopped
- interruption -> resume
- browser disconnect while crawl continues

## Storage tests

- migrations apply cleanly
- queue items restore by `crawlId`
- run-scoped page restoration works
- typed counters read without JSON reparsing

## Security tests

- public host allowed
- private/reserved targets blocked
- mixed DNS answers with any private IP blocked
- deterministic resolver/client tests with no live DNS dependency

## Deletion Checklist

Delete only after new path parity:

- `server/handlers/socketHandlers.ts`
- socket route in `server/server.ts`
- `src/hooks/useSocket.ts`
- `src/types/socket.ts`
- `server/utils/sessionPersistence.ts`
- deprecated Swagger plugin usage
- dead protocol members such as `pageDetails`

## Risks And Guardrails

## Risk: preserving too much of the old runtime shape

Guardrail:

- do not let `socket.id` survive anywhere in runtime ownership logic

## Risk: over-Elysia-ing the crawl core

Guardrail:

- Elysia stops at the application boundary

## Risk: over-normalizing persistence

Guardrail:

- keep typed columns for lifecycle/counters and one validated `options_json`

## Risk: months of dual-path maintenance

Guardrail:

- build the new path quickly and delete the old one aggressively

## Risk: performance theater early

Guardrail:

- optimize after architectural convergence and tracing

## Acceptance Criteria

The refactor is complete only if all are true:

1. Active crawls are keyed by `crawlId`, not by connection identity.
2. UI disconnect does not terminate an active crawl.
3. Resume works through HTTP/SSE architecture only.
4. No route handler reparses stats JSON to answer normal API queries.
5. No crawl-domain module imports Elysia or socket transport types.
6. No tests require real DNS resolution.
7. Frontend uses one typed command/query client path.
8. WebSocket control plane is deleted.
9. README and docs describe the real system.

## Short Execution Summary

Build the new app boundary first, storage second, runtime third, domain seams
fourth, frontend fifth, then delete the old architecture immediately after
parity. Do not preserve the socket model. Do not switch frameworks. Make the
backend more Elysia-based at the edge and less framework-coupled in the crawl
core.
