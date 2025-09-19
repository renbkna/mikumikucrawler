import net from 'net';
import dns from 'dns';
import ipaddr from 'ipaddr.js';
import { AdvancedCrawlSession } from '../crawler/CrawlSession.js';


const ALLOWED_CRAWL_METHODS = new Set(['links', 'content', 'media', 'full']);
const ALLOWED_IP_RANGES = new Set(['unicast', 'global']);

function isInvalidIpAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return true;
  }

  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }

  const range = parsed.range();
  return !ALLOWED_IP_RANGES.has(range);
}

async function assertPublicHostname(hostname) {
  if (!hostname) {
    throw new Error('Target host is not allowed');
  }

  const normalizedHost =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

  const lower = normalizedHost.toLowerCase();
  if (lower === 'localhost') {
    throw new Error('Target host is not allowed');
  }

  const ipType = net.isIP(normalizedHost);
  if (ipType) {
    if (isInvalidIpAddress(normalizedHost)) {
      throw new Error('Target host is not allowed');
    }
    return;
  }

  let records;
  try {
    records = await dns.promises.lookup(normalizedHost, { all: true, verbatim: false });
  } catch {
    throw new Error('Unable to resolve target hostname');
  }

  if (!records?.length) {
    throw new Error('Unable to resolve target hostname');
  }

  const hasInvalidRecord = records.some(({ address }) => isInvalidIpAddress(address));
  if (hasInvalidRecord) {
    throw new Error('Target host is not allowed');
  }
}

function clampNumber(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export async function sanitizeOptions(rawOptions = {}) {
  const targetInput = typeof rawOptions.target === 'string' ? rawOptions.target.trim() : '';
  if (!targetInput) {
    throw new Error('Target URL is required');
  }

  let normalizedTarget = targetInput;
  if (!/^https?:\/\//i.test(normalizedTarget)) {
    normalizedTarget = `http://${normalizedTarget}`;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedTarget);
  } catch {
    throw new Error('Target must be a valid URL');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only HTTP and HTTPS targets are supported');
  }

  await assertPublicHostname(parsedUrl.hostname);

  const crawlDepth = clampNumber(rawOptions.crawlDepth, { min: 1, max: 5, fallback: 2 });
  const maxPages = clampNumber(rawOptions.maxPages, { min: 1, max: 200, fallback: 50 });
  const crawlDelay = clampNumber(rawOptions.crawlDelay, { min: 200, max: 10000, fallback: 1000 });
  const maxConcurrentRequests = clampNumber(rawOptions.maxConcurrentRequests, { min: 1, max: 10, fallback: 5 });
  const retryLimit = clampNumber(rawOptions.retryLimit, { min: 0, max: 5, fallback: 3 });

  const method = typeof rawOptions.crawlMethod === 'string' ? rawOptions.crawlMethod.toLowerCase() : 'links';
  const crawlMethod = ALLOWED_CRAWL_METHODS.has(method) ? method : 'links';

  return {
    target: parsedUrl.toString(),
    crawlDepth,
    maxPages,
    crawlDelay,
    crawlMethod,
    maxConcurrentRequests,
    retryLimit,
    dynamic: rawOptions.dynamic !== false,
    respectRobots: rawOptions.respectRobots !== false,
    contentOnly: Boolean(rawOptions.contentOnly),
  };
}

export function setupSocketHandlers(io, dbPromise, logger) {
  const activeCrawls = new Map();

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    let crawlSession = null;

    socket.on('startAttack', async (options) => {
      if (crawlSession) {
        crawlSession.stop();
      }


      let validatedOptions;
      try {
        validatedOptions = await sanitizeOptions(options);
      } catch (validationError) {
        logger.warn('Invalid crawl options from ' + socket.id + ': ' + validationError.message);
        socket.emit('crawlError', { message: validationError.message });
        return;
      }

      logger.info('Starting new crawl session for ' + socket.id + ' with target: ' + validatedOptions.target);

      crawlSession = new AdvancedCrawlSession(
        socket,
        validatedOptions,
        dbPromise,
        logger
      );
      activeCrawls.set(socket.id, crawlSession);
      crawlSession.start();
    });

    socket.on('stopAttack', () => {
      logger.info(`Stopping crawl session for ${socket.id}`);
      if (crawlSession) {
        crawlSession.stop();
        activeCrawls.delete(socket.id);
        crawlSession = null;
      }
    });

    socket.on('getPageDetails', async (url) => {
      try {
        if (!url) return;

        const db = await dbPromise;
        const page = await db.get(`SELECT * FROM pages WHERE url = ?`, url);

        if (page) {
          const links = await db.all(
            `SELECT * FROM links WHERE source_id = ?`,
            page.id
          );

          socket.emit('pageDetails', { ...page, links });
        } else {
          socket.emit('pageDetails', null);
        }
      } catch (err) {
        logger.error(`Error getting page details: ${err.message}`);
        socket.emit('crawlError', { message: 'Failed to get page details' });
      }
    });

    socket.on('exportData', async (format) => {
      try {
        const db = await dbPromise;
        const pages =
          await db.all(`SELECT id, url, domain, crawled_at, status_code,
                                   data_length, title, description FROM pages`);

        let result;
        if (format === 'json') {
          result = JSON.stringify(pages, null, 2);
        } else if (format === 'csv') {
          const headers = Object.keys(pages[0] || {});
          const escapeCell = (value) => {
            if (value === null || value === undefined) return '""';
            let stringValue = String(value);
            if (/^[=+\-@]/.test(stringValue)) {
              stringValue = '\'' + stringValue;
            }
            stringValue = stringValue.replace(/"/g, '""');
            return '"' + stringValue + '"';
          };

          const rows = pages.map((page) =>
            headers.map((header) => escapeCell(page[header])).join(',')
          );

          const headerLine = headers.join(',');
          result = [headerLine, ...rows].join('\n');
        } else {
          throw new Error('Unsupported export format');
        }

        socket.emit('exportResult', { data: result, format });
      } catch (err) {
        logger.error(`Error exporting data: ${err.message}`);
        socket.emit('crawlError', { message: 'Failed to export data' });
      }
    });

    socket.on('disconnect', () => {
      if (crawlSession) {
        crawlSession.stop();
        activeCrawls.delete(socket.id);
      }
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  return activeCrawls;
}
