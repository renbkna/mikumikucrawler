# Dependency patches

- `@elysia/static@2.0.0-beta.1` replaces its absent bundled URI decoder with a guarded
  platform decoder. `@elysia/openapi@2.0.0-beta.1` replaces absent bundle-relative TypeBox
  imports with public packages, removes an unpublished Scalar declaration dependency, and keeps
  the JSON specification when the frontend is disabled.
- `elysia-rate-limit@5.1.0` admits requests before parsing and removes its obsolete
  `error.code`/status-based 404 recount path, keeping one global rate-limit decision per
  request and using the active request server for identity.

The SPA-static and OpenAPI tests own the first two patches; the API rate-limit and
error-handling tests own the limiter patch. Remove a patch when its installed release
passes its owning tests unchanged.
