# Docker Deployment Guide for Render

This guide explains how to deploy your MikuMiku Crawler application as a Docker container on Render.

## Prerequisites

1. Docker installed on your local machine
2. A GitHub/GitLab repository with your code
3. A Render account

## Files Created

The following files have been created/updated for Docker deployment:

1. `Dockerfile` - Main Docker configuration
2. `.dockerignore` - Excludes unnecessary files from build
3. `server/crawler/CrawlSession.js` - Orchestrates the modular crawler pieces so Docker instances stay in sync
5. `server/crawler/modules/` - Houses `crawlQueue`, `crawlState`, `pagePipeline`, and `linkExtractor` for granular control

## Local Testing

Before deploying to Render, test the Docker container locally:

```bash
# Build the Docker image
docker build -t mikumikucrawler .

# Run the container locally
docker run -p 3000:3000 -e PORT=3000 mikumikucrawler

# Test the health endpoint
curl http://localhost:3000/health
```

## Deploy to Render

### Method 1: GitHub/GitLab Integration (Recommended)

1. **Push your code** to GitHub/GitLab including the new `Dockerfile`

2. **Create a new Web Service** on Render:
   - Go to <https://dashboard.render.com>
   - Click "New +" → "Web Service"
   - Connect your GitHub/GitLab repository
   - Select your repository

3. **Configure the Service**:
   - **Name**: `mikumikucrawler` (or your preferred name)
   - **Environment**: `Docker`
   - **Build Command**: Leave empty (Docker handles this)
   - **Start Command**: Leave empty (Docker handles this)
   - **Auto-Deploy**: Enable (for automatic deployments)

4. **Set Environment Variables** (if needed):
   - `NODE_ENV=production`
   - Add any other environment variables your app needs
   - Note: `PORT` is automatically set by Render

5. **Deploy**: Click "Create Web Service"

### Data Persistence (CRITICAL)

By default, Docker containers are ephemeral, meaning all data is lost when the container restarts. To save your crawled data:

1.  In your Render Service settings, go to the **Disks** tab.
2.  Click **Add Disk**.
3.  **Name**: `crawler-data` (or similar).
4.  **Mount Path**: `/app/data` (This MUST match the internal data path).
5.  **Size**: Start with `1 GB` (or more if you plan to crawl extensively).

**Why is this needed?**
Without this, your SQLite database (`crawler.db`) inside the container will be wiped every time you deploy or the app restarts.

### Method 2: Docker Registry

1. **Build and tag your image**:

   ```bash
   docker build -t your-dockerhub-username/mikumikucrawler:latest .
   ```

2. **Push to Docker Hub**:

   ```bash
   docker push your-dockerhub-username/mikumikucrawler:latest
   ```

3. **Create Web Service on Render**:
   - Choose "Deploy an existing image from a registry"
   - Image URL: `docker.io/your-dockerhub-username/mikumikucrawler:latest`

## Environment Variables

The Docker container is configured to work with these environment variables:

- `PORT` - Set automatically by Render
- `NODE_ENV=production` - Set automatically

## What the Docker Setup Does

1. **Base Image**: Uses Node.js 20 slim with Chrome dependencies
2. **System Dependencies**: Installs all required libraries for Puppeteer
3. **Browser Installation**: Puppeteer auto-downloads Chromium during `bun install`
4. **Dependencies**: Installs packages via Bun
5. **Build**: Runs `bun run build` to build frontend assets
6. **Configuration**: Sets up proper environment for Puppeteer
7. **Health Check**: Includes a health check endpoint at `/health`
8. **Optimization**: Uses Docker layer caching for faster builds

## Troubleshooting

### If Puppeteer fails to find browsers

1. Check the deployment logs on Render
2. Puppeteer will log if browser binaries are missing
3. Ensure the container built successfully

### If the build fails

1. Check that all files are committed to Git
2. Verify the `Dockerfile` syntax
3. Make sure `package.json` scripts are correct

### If the app doesn't start

1. Check that your server listens on `process.env.PORT`
2. Verify the health endpoint works locally
3. Check Render logs for detailed error messages

## Features Included

- ✅ Puppeteer with Chromium support
- ✅ Health check endpoint at `/health`
- ✅ Production optimizations
- ✅ Docker layer caching
- ✅ Security configurations for Puppeteer
- ✅ Frontend build process
- ✅ Automatic dependency installation via Bun

## Performance Notes

- First deployment may take 5-10 minutes (installing Chrome, building)
- Subsequent deployments will be faster due to Docker layer caching
- Browser binaries are large but necessary for Puppeteer
- Container includes health checks for Render's monitoring

Your application should now be successfully running on Render with full Puppeteer support!
