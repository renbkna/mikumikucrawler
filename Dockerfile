ARG BUN_IMAGE=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea

FROM ${BUN_IMAGE} AS dependency-base
WORKDIR /app
COPY package.json bun.lock ./

FROM dependency-base AS build-dependencies
RUN bun install --frozen-lockfile --ignore-scripts

FROM dependency-base AS production-dependencies
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM build-dependencies AS build
ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}
COPY . .
RUN bun run build

FROM ${PLAYWRIGHT_IMAGE} AS runtime
WORKDIR /app

# The browser image owns the exact Chromium artifact and OS dependency set.
# Bun is copied from the separately digest-pinned build image and smoke-checked
# against the final runtime ABI before any application artifacts are installed.
COPY --from=production-dependencies /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version && chmod -R a-w /ms-playwright

COPY --from=production-dependencies --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --chown=pwuser:pwuser package.json ./
COPY --chown=pwuser:pwuser server ./server
COPY --chown=pwuser:pwuser shared ./shared

RUN mkdir -p /app/data && chown pwuser:pwuser /app/data

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=3000
ENV NODE_ENV=production
ENV FRONTEND_URL=http://localhost:3000
ENV DB_PATH=/app/data/crawler.db

VOLUME ["/app/data"]
EXPOSE 3000

USER pwuser
CMD ["bun", "server/server.ts"]
