import { URL } from "url";

export function extractLinks($, baseUrl, options) {
  const baseHost = new URL(baseUrl).hostname;
  const seen = new Set();
  const result = [];

  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) {
      return;
    }

    try {
      const url = new URL(href, baseUrl);
      let normalizedUrl = url.href.split('#')[0];
      if (normalizedUrl.endsWith('/')) {
        normalizedUrl = normalizedUrl.slice(0, -1);
      }

      if (seen.has(normalizedUrl)) {
        return;
      }
      seen.add(normalizedUrl);

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return;
      }

      if (options.crawlMethod !== 'full' && url.hostname !== baseHost) {
        return;
      }

      if (url.pathname.match(/\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i)) {
        return;
      }

      result.push({
        url: url.href,
        text: $(el).text().trim(),
      });
    } catch {
      // Ignore invalid URLs
    }
  });

  if (options.crawlMethod === 'media' || options.crawlMethod === 'full') {
    $('img, video, audio, source').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) {
        return;
      }

      try {
        const url = new URL(src, baseUrl);
        const normalizedUrl = url.href.split('#')[0];

        if (seen.has(normalizedUrl)) {
          return;
        }
        seen.add(normalizedUrl);

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return;
        }

        result.push({
          url: url.href,
          text: $(el).attr('alt') || '',
        });
      } catch {
        // Ignore invalid URLs
      }
    });
  }

  return result.slice(0, 200);
}
