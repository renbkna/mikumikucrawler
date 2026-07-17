# Dependency patches

`elysia-rate-limit@4.6.2.patch` prevents the limiter from treating arbitrary
`error.status` or `error.statusCode` fields as Elysia missing-route authority.
Only Elysia's `NOT_FOUND` error code may select that accounting path.

`server/__tests__/errorHandling.test.ts` protects the contract. Remove the
patch on upgrade only after the installed limiter passes that proof unchanged.
When removing the final repository patch, also remove `COPY patches ./patches`
from the Docker dependency layer.
