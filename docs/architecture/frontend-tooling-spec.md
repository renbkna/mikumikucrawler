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

- `Biome` for formatting and linting
- `tsgo` for typechecking
- `Lefthook` for local git hook orchestration

## Responsibilities

### Biome

Biome owns:

- formatting
- repository lint checks
- import organization assist in editors

### TypeScript

`tsgo` runs the repository's TypeScript project references and remains the type
system authority.

Linting does not replace compiler validation.

## Hook Contract

### pre-commit

- run one Biome `check --write` pass over staged TypeScript, JavaScript, JSON,
  JSONC, and CSS files
- apply formatting, import organization, and safe lint fixes under the shared
  Biome configuration
- restage files changed by the check

### pre-push

- run `bun run check`
- typecheck the TypeScript project references with `tsgo`
- check repository formatting and lint rules with `biome ci`
- run tests
- run production build

## Rule Selection

The active Biome configuration should:

- keep formatting and lint policy in one configuration
- ignore generated/build output
- fail the full repository gate on formatting or lint violations
- prefer bug-shaped findings over stylistic noise

## Forbidden States

- more than one primary repository lint authority
- pre-commit mutating files without restaging them
- pre-push passing while `tsgo` fails
- documentation claiming a quality phase that `bun run check` does not execute
