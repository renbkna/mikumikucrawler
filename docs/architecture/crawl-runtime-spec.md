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
pending -> starting -> running -> stopping -> completed
                           |         |
                           |         -> stopped
                           -> failed
                           -> interrupted
```

### Status rules

- `completed`, `failed`, and `stopped` are terminal.
- `interrupted` is resumable and non-terminal at the product level.
- `pending`, `starting`, `running`, and `stopping` are active statuses.
- Browser disconnect must not change crawl ownership or status.

### Allowed transitions

| From | To | Trigger |
| --- | --- | --- |
| `pending` | `starting` | `POST /api/crawls` accepted |
| `starting` | `running` | runtime initialization succeeds |
| `starting` | `failed` | runtime initialization fails |
| `running` | `stopping` | stop requested |
| `running` | `completed` | queue drains without stop request |
| `running` | `failed` | unrecoverable runtime error |
| `running` | `interrupted` | process shutdown or runtime crash during active crawl |
| `stopping` | `stopped` | in-flight work drains after stop request |
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

- none

Output:

- current run snapshot after stop was requested

Rules:

- stopping a terminal crawl is idempotent
- stopping a missing crawl returns `404`

### `POST /api/crawls/:id/resume`

Input:

- none

Output:

- resumed run snapshot

Rules:

- only `interrupted` crawls are resumable
- resume restores only data scoped to the same `crawlId`
- resume never depends on a browser connection identifier

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

### Event rules

- `sequence` starts at `1` for each crawl.
- `sequence` strictly increases by `1`.
- `crawl.page` is emitted only after page persistence succeeds.
- `crawl.completed`, `crawl.failed`, and `crawl.stopped` are terminal and mutually exclusive.
- `crawl.progress` may repeat snapshots, but sequence ordering must still hold.

## Resume Contract

### A crawl is resumable if and only if

- `crawl_runs.id` exists
- `crawl_runs.status = "interrupted"`
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

Rules:

- lifecycle data lives in typed columns
- counters live in typed columns
- `options_json` is validated before write

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

Rules:

- unique key on `(crawl_id, url)`
- queue restoration is always scoped by `crawl_id`
- resume restores pending and retryable work from `crawl_queue WHERE crawl_id = ?`

### `pages`

Required columns:

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
- processed analysis fields

Rules:

- page history is run-scoped
- `pages` stores crawl results and HTTP validators; it is not the source of truth for resume dedupe
- resume restores terminal URL outcomes from `crawl_terminal_urls WHERE crawl_id = ?`

### `page_links`

Required columns:

- `id`
- `page_id`
- `target_url`
- `text`

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
- robots checks
- content processing
- link extraction
- storage of successful pages

### Forbidden boundary violations

- domain code depending on Elysia request context
- domain code writing directly to SSE subscribers
- runtime ownership keyed by browser socket identifier

## Verification Requirements

The implementation is only complete when tests prove:

- endpoint contracts
- lifecycle transitions
- ordered SSE delivery
- resumable restoration scoped by `crawlId`
- typed counter invariants
- deterministic resolver and HTTP client behavior without live DNS
