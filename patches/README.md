# Dependency patches

- `@elysia/static@2.0.0-beta.1` and `@elysia/openapi@2.0.0-beta.1` replace broken
  bundle-relative imports whose targets are absent from the beta tarballs with public imports;
  the OpenAPI patch also keeps the JSON specification when the frontend is disabled.
- `elysia-rate-limit@5.1.0` admits requests before parsing and removes its obsolete
  `error.code`/status-based 404 recount path, keeping one global rate-limit decision per
  request and using the active request server for identity.

The SPA-static and OpenAPI tests own the first two patches; the API rate-limit and
error-handling tests own the limiter patch. Remove a patch when its installed release
passes its owning tests unchanged.
