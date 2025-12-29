# Use Node.js base image with Chrome dependencies
FROM node:20-slim

# Install Chrome dependencies and curl (required for Bun install)
RUN apt-get update && apt-get install -y \
    curl \
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

# Install Bun
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /app

# Copy dependency files
COPY package.json bun.lock ./

# Install dependencies via Bun (this will also download Puppeteer's Chromium)
RUN bun install

COPY . .

# Build frontend
RUN bun run build

ENV PORT=3000
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

CMD ["bun", "server/server.ts"]
