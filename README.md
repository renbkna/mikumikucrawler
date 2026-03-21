# MikuMikuCrawler

MikuMikuCrawler is a Bun + Elysia web crawler with a React frontend. The current
backend architecture is HTTP for commands and queries, SQLite for persistence,
and Server-Sent Events (SSE) for live crawl telemetry.

## Architecture

- `POST /api/crawls` creates a crawl and returns a stable `crawlId`
- `POST /api/crawls/:id/stop` requests graceful stop
- `POST /api/crawls/:id/resume` resumes an interrupted crawl
- `GET /api/crawls` lists recent or resumable runs
- `GET /api/crawls/:id` returns typed lifecycle state and counters
- `GET /api/crawls/:id/events` streams ordered SSE events
- `GET /api/crawls/:id/export` downloads stored crawl pages as JSON or CSV
- `GET /api/pages/:id/content` returns stored page content
- `GET /api/search` queries the crawl index

The server composition root is [server/app.ts](/home/ren/Projects/Website/mikumikucrawler/server/app.ts).
The runtime contract lives in [docs/architecture/crawl-runtime-spec.md](/home/ren/Projects/Website/mikumikucrawler/docs/architecture/crawl-runtime-spec.md).

## Stack

- Bun
- Elysia
- `bun:sqlite`
- Eden Treaty
- EventSource / SSE
- React 19
- Vite
- Biome formatter
- Oxlint
- Lefthook

## Development

```bash
bun install
bun run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:3000`

OpenAPI: `http://localhost:3000/openapi`

## Environment

Copy `.env.example` to `.env` and adjust as needed.

```env
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
VITE_BACKEND_URL=http://localhost:3000
DB_PATH=./data/crawler.db
LOG_LEVEL=info
RENDER=false
```

## API Flow

Create a crawl:

```bash
curl -X POST http://localhost:3000/api/crawls \
  -H 'content-type: application/json' \
  -d '{
    "target": "https://example.com",
    "crawlMethod": "links",
    "crawlDepth": 2,
    "crawlDelay": 1000,
    "maxPages": 50,
    "maxPagesPerDomain": 50,
    "maxConcurrentRequests": 5,
    "retryLimit": 3,
    "dynamic": true,
    "respectRobots": true,
    "contentOnly": false,
    "saveMedia": false
  }'
```

Subscribe to live events:

```js
const source = new EventSource(
  "http://localhost:3000/api/crawls/<crawl-id>/events",
);

source.addEventListener("crawl.progress", (event) => {
  const payload = JSON.parse(event.data);
  console.log(payload.sequence, payload.payload.counters);
});
```

## Verification

The backend refactor is considered complete only when the runtime contract,
repository docs, and verification suite agree. The main validation commands are:

```bash
bun run format:check
bun run lint
bun run lint:type-aware
bun run typecheck
bun test
bun run build
```
