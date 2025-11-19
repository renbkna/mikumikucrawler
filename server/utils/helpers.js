import axios from 'axios';
import path from 'path';
import robotsParser from 'robots-parser';

// Configure Puppeteer - Fix for rendering environments like Render.com
const isProd = process.env.NODE_ENV === 'production';

// Robots.txt cache
const robotsCache = new Map();

// Helper function to get robots.txt rules
export async function getRobotsRules(domain, dbPromise, logger, { allowOnFailure = true } = {}) {
  if (robotsCache.has(domain)) {
    return robotsCache.get(domain);
  }

  try {
    const db = await dbPromise;
    const domainSettings = db.prepare(
      'SELECT robots_txt FROM domain_settings WHERE domain = ?'
    ).get(domain);

    if (domainSettings && domainSettings.robots_txt) {
      const robots = robotsParser(
        `http://${domain}/robots.txt`,
        domainSettings.robots_txt
      );
      robotsCache.set(domain, robots);
      return robots;
    }

    const protocols = ['https', 'http'];
    let robotsTxt = null;
    let successfulProtocol = null;
    let lastError = null;

    for (const protocol of protocols) {
      try {
        const response = await axios.get(`${protocol}://${domain}/robots.txt`, {
          timeout: 5000,
          maxRedirects: 3,
        });
        robotsTxt = response.data;
        successfulProtocol = protocol;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!robotsTxt) {
      logger.warn(`Failed to download robots.txt for ${domain}: ${lastError?.message || 'unknown error'}`);
      if (!allowOnFailure) {
        return null;
      }
      const fallback = robotsParser(`http://${domain}/robots.txt`, '');
      robotsCache.set(domain, fallback);
      return fallback;
    }

    const robotsUrl = `${successfulProtocol || 'http'}://${domain}/robots.txt`;
    const robots = robotsParser(robotsUrl, robotsTxt);

    db.prepare(
      'INSERT OR REPLACE INTO domain_settings (domain, robots_txt) VALUES (?, ?)'
    ).run(domain, robotsTxt);

    robotsCache.set(domain, robots);
    return robots;
  } catch (err) {
    logger.warn(`Failed to get robots.txt for ${domain}: ${err.message}`);
    if (!allowOnFailure) {
      return null;
    }
    const fallback = robotsParser(`http://${domain}/robots.txt`, '');
    robotsCache.set(domain, fallback);
    return fallback;
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
