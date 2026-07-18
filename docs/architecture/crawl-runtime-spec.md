# Crawl Runtime Specification

## Purpose

This document is the normative contract for the 2026 backend runtime.
Implementation, API behavior, persistence, and tests must agree with this file.

## Scope

The runtime owns:

- crawl creation
- crawl execution
- crawl stop and interruption semantics
- resumable state restoration
- typed counters
- ordered crawl event delivery over SSE
- run-scoped page persistence

The runtime does not own browser connections. Browser clients are subscribers.

## Public Lifecycle

### Crawl statuses

```text
pending -> starting -> running -> pausing -> paused
              |            |             |
              |            |             -> starting
              |            -> stopping -> stopped
              |            -> completed
              |            -> failed
              |            -> interrupted
              -> pausing
              -> stopping
              -> failed
              -> interrupted
```

### Status rules

- `completed`, `failed`, and `stopped` are terminal.
- `paused` and `interrupted` are resumable and non-terminal at the product level.
- `pending`, `starting`, `running`, `pausing`, and `stopping` are active statuses.
- Browser disconnect must not change crawl ownership or status.

### Allowed transitions

| From | To | Trigger |
| --- | --- | --- |
| `pending` | `starting` | `POST /api/crawls` accepted |
| `starting` | `running` | runtime initialization succeeds without a stop request |
| `starting` | `pausing` | graceful pause requested during initialization |
| `starting` | `stopping` | force stop requested during initialization |
| `starting` | `failed` | runtime initialization fails |
| `starting` | `interrupted` | process shutdown or runtime crash during initialization |
| `running` | `pausing` | graceful pause requested |
| `running` | `stopping` | force stop requested |
| `running` | `completed` | queue drains without stop request |
| `running` | `failed` | unrecoverable runtime error |
| `running` | `interrupted` | process shutdown or runtime crash during active crawl |
| `pausing` | `paused` | in-flight work drains after pause request |
| `stopping` | `stopped` | in-flight work is aborted or drains after force stop request |
| `paused` | `starting` | resume accepted |
| `interrupted` | `starting` | resume accepted |

### Forbidden lifecycle states

- A terminal crawl returning to `running` without going through `resume`.
- `completed` with unfinished queue items.
- `running` without `started_at`.
- `completed`, `failed`, or `stopped` without `completed_at`.
- Any status change caused by SSE subscriber connect or disconnect.

## Public HTTP Contract

### `POST /api/crawls`

Input:

- `target`
- validated crawl options

Output:

- `crawlId`
- `status`
- `target`
- `options`
- timestamps known at creation time

Validation:

- DTO validation checks shape and bounds only.
- Network safety validation happens in the security/fetch layer before crawl work begins.

### `POST /api/crawls/:id/stop`

Input:

- optional `mode: "pause" | "force"` body

Output:

- current run snapshot after stop was requested

Rules:

- stopping a terminal crawl is idempotent
- graceful stop defaults to pause for any active crawl, including `starting`
- force stop moves any active crawl, including `starting`, toward `stopping`
- stopping a missing crawl returns `404`

### `POST /api/crawls/:id/resume`

Input:

- none

Output:

- resumed run snapshot

Rules:

- only `paused` and `interrupted` crawls are resumable
- resume restores only data scoped to the same `crawlId`
- resume never depends on a browser connection identifier
- create and resume admission close before process shutdown snapshots active runtimes;
  requests arriving after that point return `503 SERVICE_CLOSING`

### `GET /api/crawls/:id`

Output:

- identity
- lifecycle status
- typed counters
- timestamps
- `stopReason`
- `resumable`
- latest known runtime snapshot

### `GET /api/crawls`

Output:

- recent crawl runs sorted by `updated_at DESC`
- optional filtering by status and date range

### `GET /api/crawls/:id/events`

Output:

- ordered `text/event-stream`
- monotonically increasing per-crawl sequence
- typed event payloads

Rules:

- subscriber disconnect does not stop the crawl
- events are ordered per crawl
- terminal lifecycle emits exactly one terminal event
- process startup acquires the exclusive listener, then synchronously marks
  orphaned active crawls interrupted before yielding to request admission

### Existing product endpoints kept

- `GET /api/pages/:id/content`
- `GET /api/search`
- `GET /health`

## DTO Contract

### Crawl options

Inputs:

- `target: string`
- `crawlMethod: "links" | "media" | "full"`
- `crawlDepth: integer`
- `crawlDelay: integer`
- `maxPages: integer`
- `maxPagesPerDomain: integer`
- `maxConcurrentRequests: integer`
- `retryLimit: integer`
- `dynamic: boolean`
- `respectRobots: boolean`
- `contentOnly: boolean`
- `saveMedia: boolean`

Bounds:

- `crawlDepth`: `1..5`
- `crawlDelay`: `200..10000`
- `maxPages`: `1..200`
- `maxPagesPerDomain`: `0..1000`
- `maxConcurrentRequests`: `1..10`
- `retryLimit`: `0..5`

### Crawl summary DTO

- `id`
- `target`
- `status`
- `options`
- `createdAt`
- `startedAt`
- `updatedAt`
- `completedAt`
- `stopReason`
- `resumable`
- `counters`

### Counter DTO

- `pagesScanned`
- `successCount`
- `failureCount`
- `skippedCount`
- `linksFound`
- `mediaFiles`
- `totalDataKb`

## Counter Semantics

### Core invariant

```text
pagesScanned = successCount + failureCount + skippedCount
```

### Rules

- A URL contributes to at most one terminal counter outcome.
- `successCount` increments once when a page is fetched and accepted into the success path.
- `failureCount` increments once when a URL reaches terminal failure.
- `skippedCount` increments once when a URL is intentionally not processed after admission.
- `pagesScanned` increments exactly once with the terminal outcome.
- `linksFound`, `mediaFiles`, and `totalDataKb` are additive only on successful pages.

### Forbidden counter states

- Double-counting a URL as both success and failure.
- Incrementing `pagesScanned` before terminal classification.
- Negative counters.
- Reading counters for public API by reparsing JSON blobs.

## SSE Contract

### Event envelope

Every event includes:

- `type`
- `crawlId`
- `sequence`
- `timestamp`
- `payload`

### Event union

- `crawl.started`
- `crawl.progress`
- `crawl.page`
- `crawl.log`
- `crawl.completed`
- `crawl.failed`
- `crawl.stopped`
- `crawl.paused`

### Event rules

- `sequence` starts at `1` for each crawl.
- `sequence` strictly increases by `1`.
- `crawl.page` is emitted only after page persistence succeeds and carries the
  positive persisted page `id` and positive exact post-commit `pageCount` from
  that same transaction.
- `crawl.completed`, `crawl.failed`, and `crawl.stopped` are terminal and mutually exclusive.
- `crawl.paused` is resumable and non-terminal.
- `crawl.progress` may repeat snapshots, but sequence ordering must still hold.
- SSE replay is bounded live transport, not durable event storage.
- `Last-Event-ID` replays only events still present in the in-memory stream
  history.
- After process restart, stream cleanup, or history eviction, clients must
  recover from persisted crawl summary and page state, then continue from new
  live events.

## Document Processing Limits

- Decoded HTML and JSON documents are capped at 1 MiB before synchronous parsing.
- PDF documents retain a separate 50 MiB limit plus page-count and processing-time limits.
- Static acquisition, browser document routing, and rendered DOM snapshots enforce
  the same text-document ceiling before content enters the processor.

## Resume Contract

### A crawl is resumable if and only if

- `crawl_runs.id` exists
- `crawl_runs.status = "paused"` or `crawl_runs.status = "interrupted"`
- `options_json` validates against the current crawl options contract

### Resume restoration

The runtime must restore:

- visited URLs for that `crawlId`
- pending queue items for that `crawlId`
- latest persisted counters for that `crawlId`

The runtime must not restore:

- pages from a different `crawlId`
- queue items from a different `crawlId`
- subscriber state

### Resume invariants

- resuming an interrupted crawl preserves `crawlId`
- resumed execution appends new events with higher sequence numbers
- resuming a terminal crawl is rejected
- persisted `eventSequence` is a resume checkpoint and may lag live in-memory SSE
  sequence between checkpoints
- persisted `eventSequence` is not a promise that old event envelopes can be
  replayed after restart; durable resume state lives in typed crawl, queue,
  terminal URL, and page tables

## Persistence Contract

### `crawl_runs`

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
- `event_sequence`

Rules:

- lifecycle data lives in typed columns
- counters live in typed columns
- `options_json` is validated before write
- `event_sequence` is checkpointed with lifecycle/progress persistence writes, not
  by a dedicated write on every emitted event
- event envelopes are not persisted; use existing typed tables for durable
  recovery instead of reconstructing crawler truth from SSE

### `crawl_queue_items`

Required columns:

- `id`
- `crawl_id`
- `url`
- `depth`
- `retries`
- `parent_url`
- `domain`
- `created_at`
- `available_at`

Rules:

- unique key on `(crawl_id, url)`
- queue restoration is always scoped by `crawl_id`
- `available_at` is the durable retry/delay scheduling time and must survive resume
- resume restores pending and retryable work from
  `crawl_queue_items WHERE crawl_id = ?` in `available_at`, creation, and identity order

### `pages`

Required columns:

- `id`
- `crawl_id`
- `url`
- `domain`
- `crawled_at`
- `last_modified`
- `etag`
- `status_code`
- `content_type`
- `data_length`
- `title`
- `description`
- `content`
- `is_dynamic`
- `main_content`
- `word_count`
- `reading_time`
- `language`
- `keywords`
- `quality_score`
- `structured_data`
- `media_count`
- `internal_links_count`
- `external_links_count`
- `discovered_links_count`

Rules:

- page history is run-scoped
- the crawl-item completion transaction is the only application page-write path;
  it owns the page row, terminal outcome, queue removal, counters, and event sequence
- item completion requires and consumes exactly one pending queue row; it cannot
  manufacture terminal or page state for work that was never queued
- queue admission persists the pending row before exposing in-memory queue or
  budget state; a failed enqueue consumes no crawl or domain admission
- retries update an existing pending row and fail if it is missing; only the
  completion transaction removes one pending item, so rescheduling cannot recreate work
- item completion is single-assignment per crawl URL; duplicate completion fails
  transactionally instead of rewriting a page or advancing projections
- terminal URLs and pending queue items are mutually exclusive; migration `0007`
  removes historical overlaps and database triggers reject their recreation
- the runtime rejects any terminal URL that nevertheless reaches page processing;
  it does not silently treat duplicate work as a no-op
- the page repository exposes read projections only
- the consumed queue row owns stored page URL/domain identity and parent/depth lineage;
  completion page data cannot restate its domain
- the validated effective document URL owns document-base resolution and
  internal-versus-external classification for discovered links after redirects
- `pages` stores crawl results and reported HTTP metadata; it is not cache authority
  or the source of truth for resume dedupe
- fetch acquisition never reads prior pages or sends same-run conditional requests;
  an unsolicited `304` is rejected instead of creating a second success path
- pre-`0005` pages have no recoverable exact discovered total; their zero placeholder
  is an inert migration projection contained by terminal status and the
  terminal/queue exclusion
- resume restores terminal URL outcomes from `crawl_terminal_urls WHERE crawl_id = ?`
- terminal restoration validates the complete batch for unique canonical URL
  identity before mutating counters, admission, or domain-budget state
- pending rows reserve domain capacity; fetched terminal outcomes retain that
  reservation, while pre-fetch terminal skips release it and persist as uncharged
- historical pending rows that already exceed the restored global or domain
  budget are bounded migration containment: the pipeline logs and terminally
  skips them without fetching or charging domain capacity; current admission
  cannot create new excess rows

### `page_links`

Required columns:

- `id`
- `page_id`
- `target_url`
- `text`
- `nofollow`

### `crawl_terminal_urls`

Required columns:

- `terminal_sequence`
- `crawl_id`
- `url`
- `outcome`
- `domain_budget_charged`
- `recorded_at`

Rules:

- `outcome` is exactly `success`, `failure`, or `skip`
- each `(crawl_id, url)` has at most one terminal outcome
- restoration follows `terminal_sequence` so consecutive-outcome policy is deterministic

### `crawl_domain_state`

Required columns:

- `crawl_id`
- `delay_key`
- `delay_ms`
- `next_allowed_at`
- `updated_at`

Rules:

- `(crawl_id, delay_key)` is the durable identity
- resume restores domain-delay scheduling only for the same `crawl_id`

## Runtime / Domain Boundary

### Runtime responsibilities

- lifecycle transitions
- event sequencing and emission
- persistence checkpoints
- graceful stop
- interruption handling

### Domain responsibilities

- queueing
- fetch/render
- robots checks through one manager-owned process service, with origin-keyed cache and in-flight loads
- content processing
- link extraction
- storage of successful pages

### Forbidden boundary violations

- domain code depending on Elysia request context
- domain code writing directly to SSE subscribers
- runtime ownership keyed by browser socket identifier
- shared robots requests surviving manager shutdown

## Verification Requirements

The implementation is only complete when tests prove:

- endpoint contracts
- lifecycle transitions
- ordered SSE delivery
- resumable restoration scoped by `crawlId`
- typed counter invariants
- deterministic resolver and HTTP client behavior without live DNS
