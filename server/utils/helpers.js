import axios from 'axios';
import robotsParser from 'robots-parser';
import path from 'path';
import { existsSync } from 'fs';

// Configure Puppeteer - Fix for rendering environments like Render.com
const isProd = process.env.NODE_ENV === 'production';

// Robots.txt cache
const robotsCache = new Map();

// Helper function to get robots.txt rules
export async function getRobotsRules(domain, dbPromise, logger) {
  if (robotsCache.has(domain)) {
    return robotsCache.get(domain);
  }

  try {
    const db = await dbPromise;
    const domainSettings = await db.get(
      'SELECT robots_txt FROM domain_settings WHERE domain = ?',
      domain
    );

    if (domainSettings && domainSettings.robots_txt) {
      const robots = robotsParser(
        `http://${domain}/robots.txt`,
        domainSettings.robots_txt
      );
      robotsCache.set(domain, robots);
      return robots;
    }

    const response = await axios.get(`http://${domain}/robots.txt`, {
      timeout: 5000,
      maxRedirects: 3,
    });

    const robotsTxt = response.data;
    const robots = robotsParser(`http://${domain}/robots.txt`, robotsTxt);

    await db.run(
      'INSERT OR REPLACE INTO domain_settings (domain, robots_txt) VALUES (?, ?)',
      domain,
      robotsTxt
    );

    robotsCache.set(domain, robots);
    return robots;
  } catch (err) {
    logger.warn(`Failed to get robots.txt for ${domain}: ${err.message}`);
    // Create an empty robots parser as fallback
    const robots = robotsParser(`http://${domain}/robots.txt`, '');
    robotsCache.set(domain, robots);
    return robots;
  }
}

// Helper function to extract metadata from HTML
export function extractMetadata($) {
  const title = $('title').text().trim() || '';

  // Extract description from meta tags
  let description = '';
  $('meta[name="description"]').each((_, el) => {
    description = $(el).attr('content') || '';
  });
  if (!description) {
    $('meta[property="og:description"]').each((_, el) => {
      description = $(el).attr('content') || '';
    });
  }

  return { title, description };
}

// Enhanced Chrome path detection for different environments
export const getChromePaths = () => {
  const basePaths = [];

  if (isProd) {
    // Production paths (cloud hosting and Docker)
    basePaths.push(
      // Custom environment variable (highest priority)
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROME_BIN,
      // Docker containers (Google Chrome Stable)
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      // Render.com, Railway, Heroku
      '/tmp/puppeteer/chrome/linux-133.0.6943.126/chrome-linux64/chrome',
      '/tmp/.cache/puppeteer/chrome/linux-133.0.6943.126/chrome-linux64/chrome',
      '/app/.cache/puppeteer/chrome/linux-133.0.6943.126/chrome-linux64/chrome',
      // Additional Docker paths
      '/opt/google/chrome/chrome',
      '/opt/google/chrome/google-chrome'
    );
  } else {
    // Development paths
    basePaths.push(
      // Local Puppeteer installation
      path.join(
        process.cwd(),
        '.cache/puppeteer/chrome/win64-132.0.6834.110/chrome-win64/chrome.exe'
      ), // Windows
      path.join(
        process.cwd(),
        '.cache/puppeteer/chrome/linux-133.0.6943.126/chrome-linux64/chrome'
      ), // Linux
      path.join(
        process.cwd(),
        '.cache/puppeteer/chrome/mac-133.0.6943.126/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      ), // macOS
      // System Chrome installations
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // Windows
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', // Windows 32-bit
      '/usr/bin/google-chrome', // Linux
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
      // Custom environment variable
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROME_BIN
    );
  }

  return basePaths.filter(Boolean); // Remove undefined/null paths
};
