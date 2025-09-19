import puppeteer from 'puppeteer';
import { existsSync } from 'fs';
import { getChromePaths } from '../utils/helpers.js';
import { MemoryMonitor } from '../utils/memoryMonitor.js';

const COMPLEX_JS_SITES = [
  'youtube.com',
  'google.com',
  'facebook.com',
  'meta.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'linkedin.com',
  'discord.com',
  'reddit.com',
  'pinterest.com',
  'tiktok.com',
  'netflix.com',
  'amazon.com',
  'airbnb.com',
  'uber.com',
  'spotify.com',
  'github.com',
  'stackoverflow.com',
  'medium.com',
  'twitch.tv',
  'salesforce.com',
  'slack.com',
  'notion.so',
  'figma.com',
  'canva.com',
  'trello.com',
  'asana.com',
  'dropbox.com',
  'zoom.us',
];

const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-translate',
  '--mute-audio',
  '--no-first-run',
  '--metrics-recording-only',
  '--disable-background-mode',
  '--disable-popup-blocking',
  '--window-size=1280,720',
];

export class DynamicRenderer {
  constructor(options, logger) {
    this.options = options;
    this.logger = logger;
    this.browser = null;
    this.pageCount = 0;
    this.enabled = options.dynamic !== false;
  }

  isEnabled() {
    return Boolean(this.enabled && this.options.dynamic !== false);
  }

  disableDynamic(reason) {
    this.enabled = false;
    this.options.dynamic = false;
    if (reason) {
      this.logger.warn(reason);
    }
  }

  async initialize() {
    if (!this.isEnabled()) {
      return { dynamicEnabled: false };
    }

    const memoryStatus = MemoryMonitor.logMemoryStatus(this.logger);
    const constrainedEnvironment =
      memoryStatus.isLowMemory || (process.env.RENDER && memoryStatus.heapUsed > 50);

    if (constrainedEnvironment) {
      this.disableDynamic('Skipping Puppeteer due to constrained memory');
      return {
        dynamicEnabled: false,
        fallbackLog:
          'Falling back to static crawling: environment lacks sufficient memory for dynamic rendering',
      };
    }

    try {
      await this.launchBrowser();
      return { dynamicEnabled: this.isEnabled() };
    } catch (err) {
      this.disableDynamic(`Failed to launch Puppeteer: ${err.message}`);
      return {
        dynamicEnabled: false,
        fallbackLog:
          'Falling back to static crawling: dynamic renderer failed to start (requires ~1GB RAM)',
      };
    }
  }

  async launchBrowser() {
    if (!this.isEnabled()) {
      return;
    }

    const chromePaths = getChromePaths();
    let executablePath = null;
    for (const chromePath of chromePaths) {
      if (chromePath && existsSync(chromePath)) {
        executablePath = chromePath;
        this.logger.info(`Found Chrome executable at: ${chromePath}`);
        break;
      }
    }

    const launchOptions = {
      headless: 'new',
      args: DEFAULT_LAUNCH_ARGS,
      timeout: 45000,
      protocolTimeout: 45000,
      slowMo: 100,
    };

    if (executablePath) {
      launchOptions.executablePath = executablePath;
    }

    this.logger.info(
      `Launching Puppeteer with config: ${JSON.stringify({
        executablePath: launchOptions.executablePath,
        args: launchOptions.args,
      })}`
    );

    this.browser = await puppeteer.launch(launchOptions);
    this.pageCount = 0;
    this.enabled = true;
    this.options.dynamic = true;
  }

  async recycleIfNeeded() {
    if (!this.browser) return;

    const recycleThreshold = process.env.RENDER ? 10 : 20;
    if (this.pageCount <= recycleThreshold) {
      return;
    }

    this.logger.info('Recycling browser to prevent memory leaks');
    try {
      await this.browser.close();
    } catch (err) {
      this.logger.warn(`Error closing old browser: ${err.message}`);
    }

    this.browser = null;
    await this.launchBrowser();
  }

  async render(item) {
    if (!this.isEnabled()) {
      return null;
    }

    if (!this.browser) {
      try {
        await this.launchBrowser();
      } catch (err) {
        this.disableDynamic(`Failed to relaunch Puppeteer: ${err.message}`);
        return null;
      }
    }

    await this.recycleIfNeeded();

    if (!this.browser) {
      return null;
    }

    const page = await this.browser.newPage();
    this.pageCount++;

    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      await page.setViewport({ width: 1280, height: 720 });
      page.on('dialog', async (dialog) => {
        await dialog.dismiss();
      });
      await page.setExtraHTTPHeaders({
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        DNT: '1',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      });

      const isComplex = COMPLEX_JS_SITES.some((site) => item.url.includes(site));
      const waitUntil = isComplex ? 'networkidle0' : 'domcontentloaded';
      const navigationTimeout = isComplex ? 60000 : 30000;

      const response = await page.goto(item.url, {
        waitUntil,
        timeout: navigationTimeout,
      });

      const statusCode = response?.status() ?? 0;
      const headers = response?.headers?.() ?? {};
      const contentType = headers['content-type'] || '';
      const contentLength = parseInt(headers['content-length'] || '0', 10);
      const lastModified = headers['last-modified'];

      await this.setCookiesForPage(page, item.url);

      if (isComplex) {
        await this.waitForComplexContent(page, item.url);
      }

      const content = await page.content();
      const title = await page.title();
      const description = await page
        .$eval('meta[name="description"]', (el) => el.content)
        .catch(() => '');

      if (this.options.screenshots) {
        try {
          await page.screenshot({
            path: `./data/screenshots/${new URL(item.url).hostname}_${Date.now()}.png`,
            fullPage: false,
            type: 'jpeg',
            quality: 70,
          });
        } catch (screenshotErr) {
          this.logger.debug(
            `Screenshot capture failed for ${item.url}: ${screenshotErr.message}`
          );
        }
      }

      await page.close();

      return {
        isDynamic: true,
        content,
        statusCode,
        contentType,
        contentLength,
        title,
        description,
        lastModified,
      };
    } catch (err) {
      await this.closePageSafely(page);

      if (
        err.message.includes('Protocol error') ||
        err.message.includes('Connection closed') ||
        err.message.includes('Navigating frame was detached') ||
        err.message.includes('Target closed') ||
        err.message.includes('Session closed')
      ) {
        this.logger.warn(
          `Browser session error detected, falling back to static crawling for ${item.url}`
        );
        return null;
      }

      if (err.message.includes('TimeoutError')) {
        this.logger.warn(
          `Navigation timeout for ${item.url}, falling back to static crawling`
        );
        return null;
      }

      throw err;
    }
  }

  async waitForComplexContent(page, url) {
    try {
      let selectorToWait = null;
      let additionalWaitTime = 2000;

      if (url.includes('youtube.com/watch')) {
        selectorToWait = 'h1.ytd-video-primary-info-renderer';
      } else if (url.includes('twitter.com') || url.includes('x.com')) {
        selectorToWait = '[data-testid="tweet"]';
      } else if (url.includes('linkedin.com')) {
        selectorToWait = '.feed-container-theme';
      } else if (url.includes('instagram.com')) {
        selectorToWait = '[role="main"]';
      } else if (url.includes('reddit.com')) {
        selectorToWait = '[data-testid="post-container"]';
      } else if (url.includes('facebook.com') || url.includes('meta.com')) {
        selectorToWait = '[role="main"]';
      } else if (url.includes('github.com')) {
        selectorToWait = '.js-repo-root, .repository-content';
      } else if (url.includes('medium.com')) {
        selectorToWait = 'article';
      } else if (url.includes('stackoverflow.com')) {
        selectorToWait = '.question, .answer';
      }

      if (selectorToWait) {
        await page.waitForSelector(selectorToWait, { timeout: 15000 });
        this.logger.debug(`Waited for selector: ${selectorToWait} on ${url}`);
      }

      await new Promise((resolve) => setTimeout(resolve, additionalWaitTime));
    } catch (waitErr) {
      this.logger.warn(`Complex site selector wait failed for ${url}: ${waitErr.message}`);
    }
  }

  async setCookiesForPage(page, url) {
    try {
      const urlDomain = new URL(url).hostname;
      const cookiesToSet = [];

      if (url.includes('youtube.com')) {
        cookiesToSet.push(
          { name: 'CONSENT', value: 'YES+' },
          { name: 'PREF', value: 'tz=UTC' }
        );
      } else if (url.includes('reddit.com')) {
        cookiesToSet.push({ name: 'over18', value: '1' });
      }

      for (const cookie of cookiesToSet) {
        await page.setCookie({
          name: cookie.name,
          value: cookie.value,
          domain: urlDomain,
        });
      }
    } catch (cookieErr) {
      this.logger.debug(`Cookie setting failed: ${cookieErr.message}`);
    }
  }

  async closePageSafely(page) {
    try {
      await page.close();
    } catch (closeErr) {
      this.logger.error(`Error closing page: ${closeErr.message}`);
    }
  }

  async close() {
    if (!this.browser) return;
    try {
      await this.browser.close();
      this.logger.info('Puppeteer closed.');
    } catch (err) {
      this.logger.error(`Error closing browser: ${err.message}`);
    } finally {
      this.browser = null;
      this.pageCount = 0;
    }
  }
}
