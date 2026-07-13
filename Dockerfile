FROM oven/bun:1.3.14

WORKDIR /app

# Copy dependency files
COPY package.json bun.lock ./
COPY scripts ./scripts

# Install the locked application dependencies.
RUN bun install --frozen-lockfile

# Keep the locked Playwright browser in a path shared by build and runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bun node_modules/playwright/cli.js install --with-deps chromium

# Fail the image build if the installed browser cannot launch.
RUN bun -e 'import { chromium } from "playwright"; const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); await browser.close();'

COPY . .

# Build frontend
RUN bun run build

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "server/server.ts"]
