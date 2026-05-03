FROM oven/bun:latest

# Install Chrome/Playwright dependencies for headless browser
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files
COPY package.json bun.lock ./
COPY scripts ./scripts

# Install dependencies (includes Playwright browser download)
RUN bun install --frozen-lockfile

COPY . .

# Build frontend
RUN bun run build

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "server/server.ts"]
