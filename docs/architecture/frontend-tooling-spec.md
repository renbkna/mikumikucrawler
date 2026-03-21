# Frontend Tooling Specification

## Purpose

Define one explicit quality toolchain for frontend and shared web code.

The goal is:

- fast formatting
- bug-oriented linting
- explicit typechecking
- predictable git hooks

The goal is not:

- overlapping linters with conflicting authority
- style-only lint churn
- hidden hook behavior

## Contract

The repository uses:

- `Biome` for formatting
- `Oxlint` for linting
- `tsc` for typechecking
- `Lefthook` for local git hook orchestration

## Responsibilities

### Biome

Biome owns:

- formatting
- import organization assist in editors

Biome does not own:

- CI lint enforcement
- hook-time semantic lint gating

### Oxlint

Oxlint owns:

- repository lint checks
- React/promise/import linting
- selected type-aware correctness checks

Oxlint rules must prefer bug-shaped findings over stylistic noise.

### TypeScript

`tsc` remains the type system authority.

Linting does not replace compiler validation.

## Hook Contract

### pre-commit

- format staged frontend/backend source files with Biome
- lint staged source files with Oxlint

### pre-push

- run formatting check
- run Oxlint
- run type-aware Oxlint
- run both TypeScript programs
- run tests
- run production build

## Rule Selection

The active Oxlint configuration should:

- disable outdated React 17 JSX-scope rules
- ignore generated/build output and test directories
- deny warnings in CI and hooks
- enable type-aware rules only when they provide actionable signal

## Forbidden States

- Biome and Oxlint both acting as the primary CI linter
- pre-commit mutating files without restaging them
- pre-push passing while `tsc` fails
- type-aware linting enabled only on paper and never run
