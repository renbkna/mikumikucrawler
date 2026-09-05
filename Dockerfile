ARG BUN_IMAGE=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48

FROM ${BUN_IMAGE} AS dependency-base
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches

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
