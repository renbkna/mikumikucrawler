# Crawlee Engine Specification

## Purpose

This document defines the contract for the Crawlee + Playwright crawl engine
that powers the runtime.

It is subordinate to [crawl-runtime-spec.md](./crawl-runtime-spec.md).
If the two documents disagree, the runtime spec wins for product-visible
behavior.

## Scope

The engine owns:

- browser-backed page acquisition
- session and cookie persistence within a crawl runtime
- page readiness heuristics for JS-heavy sites
- controlled request enqueueing into the runtime queue
- dynamic render failure classification

The engine does not own:

- crawl identity
- public API status transitions
- SSE transport
- database schema
- product counters

## Engine Boundary

Inputs:

- `crawlId`
- validated `CrawlOptions`
- runtime-owned queue item (`url`, `domain`, `depth`, `retries`, `parentUrl`)
- injectable logger
- injectable resolver / HTTP security policy

Outputs:

- typed fetch result for the requested URL
- discovered links eligible for runtime admission
- classified failure reason when rendering or navigation is blocked

## Invariants

- The engine must never change crawl ownership semantics. `crawlId` remains the
  only runtime owner.
- The engine must not bypass hostname safety checks. Every navigated hostname
  must be validated through the runtime security seam before admission.
- A queue item may produce at most one terminal fetch outcome.
- Browser disconnect or SSE disconnect must not terminate the crawl.
- Session state is scoped to one crawl runtime and must not leak across runs.

## Readiness Contract

The engine must not treat “one selector missing” as proof of total render
failure.

Readiness should be decided from multiple signals:

- DOM settled enough to read content
- page title/body content present
- site-profile selectors when available
- final URL stability

Failure to satisfy one preferred selector may downgrade confidence, but must
not automatically force static fallback if meaningful content is already
readable.

## Enqueue Contract

The engine may discover candidate links, but the runtime remains the final
admission authority.

Required rules:

- normalize URLs before enqueue
- preserve `parentUrl`
- preserve `depth + 1`
- never enqueue already-visited or already-pending URLs
- apply runtime/domain policy before persistence

## Session Contract

- Use Crawlee-managed browser/session primitives.
- Cookies may persist within one crawl runtime to improve continuity.
- Sessions must be discarded when the engine classifies a request as blocked.
- Resume may restore runtime queue state, but does not require restoring an
  identical browser process.

## Failure Taxonomy

The engine must distinguish at least:

- `success`
- `unchanged`
- `rateLimited`
- `blocked`
- `permanentFailure`

Blocked reasons may include:

- consent wall not bypassed
- bot or access block
- authentication wall

## Forbidden States

- Falling back to static crawl after the engine already proved a strict
  consent/access wall for a protected domain.
- Reporting success when no readable content or persisted page exists.
- Enqueueing shell/legal/footer links from a known blocked or consent-wall page
  as if they were content discoveries.

## Verification Requirements

Changes to the engine require contract tests that prove:

- blocked dynamic outcomes do not silently degrade to junk static crawling
- blocked reasons reach the runtime log surface
- queue/persistence semantics stay resumable
- SSE-visible runtime behavior remains unchanged at the API boundary
