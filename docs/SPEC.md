# MikuMikuCrawler Specification

> Legacy note: the active backend rewrite contract now lives in
> `docs/architecture/crawl-runtime-spec.md`. This file describes the pre-refactor
> socket-owned runtime and remains only as historical context until the old
> architecture is fully removed.

## Crawl Lifecycle Contract

### Overview
This document defines the contracts, invariants, and edge cases for the web crawler's core operations.

---

## 1. CrawlSession Lifecycle

### States
```
CREATED -> INITIALIZING -> RUNNING -> STOPPING -> COMPLETED
   |           |            |          |
   |           |            |          +-> INTERRUPTED
   |           |            |
   +-----------+------------+-> ERROR (terminal)
```

### State Transitions

| From | To | Trigger | Invariants |
|------|-----|---------|-----------|
| CREATED | INITIALIZING | `start()` called | Socket must be connected, DB must be available |
| INITIALIZING | RUNNING | Dynamic renderer ready, robots.txt checked | Queue must be empty, stats reset |
| RUNNING | STOPPING | `stop()` called OR page limit reached | Active items must complete |
| RUNNING | INTERRUPTED | `interrupt()` called | Immediate termination, no new work |
| STOPPING | COMPLETED | All items processed, cleanup done | Final stats emitted, session marked complete |
| ANY | ERROR | Unhandled exception | Resources cleaned up, error logged |

### Invariants
1. **Session ID uniqueness**: Each session has a cryptographically random UUID (v4)
2. **Socket association**: One session maps to exactly one socket ID (resumed sessions update socket_id)
3. **Database persistence**: Session state persisted within 100ms of state change
4. **Resource cleanup**: Dynamic renderer closed within 5000ms of session end

---

## 2. CrawlQueue Contract

### Purpose
Manages URL queue with domain-specific rate limiting and concurrency control.

### Inputs
- `QueueItem`: `{ url: string, domain: string, depth: number, retries: number, parentUrl?: string }`
- `maxConcurrentRequests`: positive integer (1-50)
- `crawlDelay`: milliseconds between requests to same domain

### Outputs
- Items processed via `processItem` callback
- Stats snapshots via WebSocket
- Persistence via session DB (when sessionId provided)

### Invariants

#### Deduplication (Must Never Fail)
```
∀ url ∈ processed: url ∉ queue ∧ url ∉ activeItems
```
- URLs are tracked in three sets: `visited` (CrawlState), `activeItems`, `queuedUrls`
- A URL can only transition: `queued` -> `active` -> `visited`

#### Concurrency Bound
```
|activeItems| ≤ maxConcurrentRequests
```
- Enforced at enqueue time (line 189-192 in crawlQueue.ts)
- Checked before starting new work

#### Domain Rate Limiting
```
∀ domain: timeSinceLastRequest(domain) ≥ getDomainDelay(domain)
```
- Implemented via `domainProcessing` Map (domain -> nextAllowedTime)
- Items deferred if rate limit would be violated

### Edge Cases

| Scenario | Expected Behavior |
|----------|------------------|
| Duplicate URL enqueued | Silently ignored if in visited/active/queue |
| URL with invalid hostname | Rejected at enqueue (try-catch), error logged |
| Queue head grows beyond threshold | Array spliced, head reset to 0 (memory management) |
| Stuck items (>30s) | Warning logged, force-cleared after 60s |
| Session stopped mid-processing | Active items complete, no new items start |

### Forbidden States
- `activeItems` contains URL not being processed
- `queuedUrls` contains URL not in `queue` array
- Processing more than `maxConcurrentRequests` simultaneously
- Negative queue length

---

## 3. PagePipeline Contract

### Purpose
Processes a single URL through fetch, content analysis, storage, and link extraction.

### Phase Diagram
```
INPUT: QueueItem
  |
  v
[PRE-CHECKS] ──► Can process more? Visited? Domain budget?
  |
  v
[FETCH] ──► HTTP request OR dynamic render
  |
  v
[RESPONSE HANDLING] ──► 304? Rate limited? Error?
  |
  v
[CONTENT PROCESSING] ──► Sanitize, analyze, extract
  |
  v
[ROBOTS CHECK] ──► noindex? nofollow?
  |
  v
[QUALITY GATE] ──► Soft 404? Skip storage
  |
  v
[STORAGE] ──► SQLite transaction
  |
  v
[EMISSION] ──► WebSocket emit
  |
  v
[LINK ENQUEUE] ──► Filter, robots check, queue
```

### Phase Contracts

#### Phase 1: Pre-checks
**Inputs**: QueueItem, CrawlState
**Outputs**: void (early return if checks fail)
**Invariants**:
- `canProcessMore()` must be checked before any work
- `hasVisited()` prevents double-processing
- Domain budget checked before network request

#### Phase 2: Fetch
**Inputs**: URL, isDynamic flag, DynamicRenderer
**Outputs**: FetchResult
**Invariants**:
- HTTP timeout: 30s maximum
- Retry logic: exponential backoff (base * 2^retry)
- Max retry delay: 60s

#### Phase 3: Response Handling
**Edge Cases**:
| Status | Action |
|--------|--------|
| 304 Not Modified | Mark visited, update timestamp, use cached links |
| 429/503 Rate Limited | Adapt domain delay, schedule retry with Retry-After |
| 403 Forbidden | Mark blocked, increase domain delay, record failure |
| 404/410/501 | Permanent failure, do not retry |
| 5xx | Retry if retries < limit |

#### Phase 4: Content Processing
**Inputs**: Raw content, contentType
**Outputs**: ProcessedContent
**Invariants**:
- HTML sanitized with sanitize-html (allowed tags defined)
- PDF processing timeout: 30s
- PDF max size: 50MB
- PDF max pages: 100

#### Phase 5: Robots Directives
**Sources**: Meta robots tag + X-Robots-Tag header
**Logic**: `noindex` (skip storage) OR `nofollow` (skip link enqueue)

#### Phase 6: Quality Gate
**Soft 404 Detection**:
- Content < 100 bytes AND title matches error keywords
- Title keywords: "404", "not found", "error", "page not found"
- Content keywords (if < 1KB): same set

#### Phase 7: Storage
**Transaction**: Single SQLite transaction per page
**Tables**: `pages` (UPSERT), `links` (INSERT OR IGNORE)
**Invariants**:
- `url` is UNIQUE constraint
- `crawled_at` auto-updated on conflict
- Link foreign key (source_id) references pages.id

#### Phase 8: Emission
**Throttling**: Max 1 emit per 250ms per session
**Payload**: Stats + lastProcessed metadata

#### Phase 9: Link Enqueue
**Batching**: Links processed in parallel batches (concurrency: 5)
**Robots Check**: Per-domain robots.txt fetched if external
**Filter Rules**:
- Must start with http(s)
- Skip file extensions: css, js, json, xml, txt, md, csv, svg, ico
- Respect nofollow

### Error Handling

| Phase | Error Type | Recovery |
|-------|-----------|----------|
| Fetch | Network error | Retry with backoff |
| Fetch | Timeout | Retry once, then failure |
| Content | Parse error | Fallback processed content |
| Content | PDF too large | Skip, log warning |
| Storage | Transaction fail | Log error, continue (data loss) |
| Link | URL parse error | Skip link, log debug |

---

## 4. CrawlState Contract

### Purpose
Tracks crawl progress and enforces limits.

### Invariants

#### Circuit Breaker
```
consecutiveFailures ≥ CIRCUIT_BREAKER_THRESHOLD (20) → session.stop()
```
- Threshold based on empirical data (systematic failure detection)
- Reset to 0 on any success

#### Memory Boundaries
```
|visited| ≤ 50,000 (LRU eviction)
|domainDelays| ≤ number of unique domains seen
|domainPageCounts| ≤ number of unique domains seen
```

#### Stats Accuracy
```
pagesScanned = successCount + failureCount + skippedCount
```
- Must hold at all times
- Used for success rate calculation

### Thread Safety
- All methods are synchronous (no async/await)
- Called from single-threaded event loop
- No locking required

---

## 5. Resume Functionality

### Contract
A session can be resumed if and only if:
1. Session ID exists in `crawl_sessions` table
2. Current status is "interrupted"
3. Options are valid (deserializable)

### State Restoration
1. Load session record from DB
2. Mark all previously crawled URLs as visited
3. Load pending queue items from `crawl_queue` table
4. Update socket_id to new connection
5. Set status to "running"

### Invariants
- Resumed session processes same options as original
- Already-visited URLs not re-processed
- Pending queue items preserved across restarts

---

## 6. WebSocket Event Contract

### Client → Server
| Event | Payload | Response |
|-------|---------|----------|
| `startAttack` | CrawlOptions | `stats` (initial), then `pageContent` stream |
| `stopAttack` | null | `attackEnd` with final stats |
| `exportData` | 'json' \| 'csv' | File download |

### Server → Client
| Event | Payload | Guarantee |
|-------|---------|-----------|
| `stats` | Stats + log | Throttled to 250ms, always eventual |
| `pageContent` | PageRecord | Once per URL, in crawl order (best effort) |
| `attackEnd` | FinalStats | Exactly once per session |
| `queueStats` | QueueStats | While active, every loop iteration |

---

## 7. Error Message Contract

### Standardization
All error messages must:
1. Include context (URL, phase, operation)
2. Use `getErrorMessage()` for extraction
3. Be loggable (no circular references)
4. Be actionable where possible

### Template
```
[Component] Error description: message | Context: {url, phase, retryCount}
```

### Examples
```
[Crawler] Error fetching https://example.com: Connection timeout
[Pipeline] ContentProcessor failed for https://example.com: Cheerio parse error
[Queue] Transaction failed for https://example.com: UNIQUE constraint violation
```

---

## 8. Testing Requirements

### Unit Tests Required
- **CrawlState**: Circuit breaker trips after threshold
- **CrawlState**: Stats always sum correctly
- **CrawlQueue**: Deduplication (visited, active, queued)
- **CrawlQueue**: Domain rate limiting respected
- **CrawlQueue**: Stuck detection triggers
- **PagePipeline**: Each phase can be tested independently
- **Resume**: Full state restoration

### Integration Tests Required
- Full crawl lifecycle: start → pages → stop
- Resume after interruption
- Concurrent sessions isolation
- Memory pressure handling (50k+ URLs)

### Property Tests
- `∀ url: hasVisited(url) → !canProcessMore(url)`
- `∀ session: finalStats.pagesScanned ≥ initialStats.pagesScanned`
- `∀ domain: actualDelay ≥ configuredDelay`

---

## References

- `server/crawler/CrawlSession.ts` - Session lifecycle
- `server/crawler/modules/crawlState.ts` - State management
- `server/crawler/modules/crawlQueue.ts` - Queue management
- `server/crawler/modules/pagePipeline.ts` - Processing pipeline
