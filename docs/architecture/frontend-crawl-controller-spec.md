# Frontend Crawl Controller Specification

## Purpose

This document is the contract for the frontend crawl controller.

The goal is a single explicit UI model for crawl state, command execution, and
SSE telemetry. The controller must be robust against missing events, stale
events, and partial command failures without over-modularizing the frontend.

## Scope

The controller owns:

- current crawl UI state
- typed command execution for create/stop/resume/export
- SSE subscription lifecycle
- ordered event application
- terminal state handling
- user-visible logs and progress snapshots

The controller does not own:

- presentation styling
- modal open/close UI state unrelated to crawl semantics
- backend transport implementation details

## Core Model

The crawl UI state is reducer-owned.

The reducer state must contain:

- `target`
- `crawlOptions`
- `activeCrawlId`
- `connectionState`
- `runPhase`
- `stats`
- `queueStats`
- `crawledPages`
- `logs`
- `interruptedSessions`
- `lastSequenceByCrawlId`
- `lastCommand`

## Command Contract

Commands:

- `start`
- `stop`
- `resume`
- `export`
- `refreshInterruptedSessions`
- `deleteInterruptedSession`

Rules:

- Every command resolves to a typed success/error result.
- The controller must not infer success from lack of thrown errors.
- Failed commands must update `lastCommand` with explicit failure state.
- Terminal command results must be representable without parsing human text.

## Event Contract

Input events come from the backend SSE contract.

Rules:

- Event handling must be exhaustive over all known event types.
- Unknown event types must be ignored only after explicit validation failure.
- Per-crawl sequence numbers must be monotonic.
- Events with sequence less than or equal to the last applied sequence for the
  active crawl must be ignored as stale.

## State Transitions

### Connection

- `connected` -> `connecting` when opening SSE
- `connecting` -> `connected` on stream open
- `connected` -> `disconnected` on stream error
- closing SSE after terminal event must not leave the controller in a fake
  loading state

### Run phase

- `idle` -> `starting` after accepted create/resume command
- `starting` -> `running` on `crawl.started`
- `running` -> `completed | failed | stopped` on terminal event
- `running` -> `stopping` after accepted stop command

### Terminal guarantees

When `crawl.completed`, `crawl.failed`, or `crawl.stopped` is applied:

- SSE connection is closed
- controller records a terminal run phase
- progress becomes `100`
- command status is not left in loading state

## Derived UI Guarantees

- `Captured Data` reflects only persisted `crawl.page` events.
- Missing `crawl.page` events must not be misreported as frontend failure.
- System logs must show backend-visible blocked reasons when provided.
- Progress uses reducer state only, not ad hoc refs that can drift.

## Forbidden States

- Active crawl id with no reducer-owned run phase.
- Out-of-order progress regressing due to stale events.
- Terminal event applied while the controller still thinks the run is active.
- Silent command failure that leaves the UI in a loading/active state.
- Multiple sources of truth for crawl pages, stats, or log ordering.

## Verification Requirements

Tests must prove:

- stale SSE events are ignored
- terminal events close active state cleanly
- command failures are represented explicitly
- blocked/failure reasons reach UI state without text parsing hacks
