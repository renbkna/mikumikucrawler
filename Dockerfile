# Runs the server

# Use Node.js 20 with Debian Bullseye (good for Puppeteer)
FROM node:20-bullseye-slim

# Install system dependencies and Google Chrome for Puppeteer
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libgconf-2-4 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libatk1.0-0 \
    libcairo-gobject2 \
    libgtk-3-0 \
    libgdk-pixbuf2.0-0 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrender1 \
    libxtst6 \
    libgbm1 \
    libnss3 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/* \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for better Docker caching)
COPY package*.json ./

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

# Copy the rest of the application first
COPY . .

# Install dependencies, build frontend, then clean up devDependencies
RUN rm -f package-lock.json && npm install \
    && npm run build \
    && rm -rf node_modules && npm ci --only=production

# Set NODE_ENV after build
ENV NODE_ENV=production

# Create directories and set proper permissions
RUN mkdir -p data logs \
    && chown -R node:node /app \
    && chmod -R 755 /app

# Expose port (Render will set PORT env variable)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => { process.exit(1) })"

# Define a volume for the data directory to ensure persistence
VOLUME ["/app/data"]

# Switch to non-root user for security
USER node

# Start the application
CMD ["npm", "start"]
