import { URL } from 'url';

export function cleanText(text) {
  if (!text) return '';

  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function extractStructuredData(cheerioInstance) {
  if (typeof cheerioInstance !== 'function') {
    throw new Error('Invalid Cheerio instance passed to extractStructuredData');
  }

  const structured = {
    jsonLd: [],
    microdata: {},
    openGraph: {},
    twitterCards: {},
    schema: {},
  };

  cheerioInstance('script[type="application/ld+json"]').each((_, element) => {
    try {
      const jsonData = JSON.parse(cheerioInstance(element).html());
      structured.jsonLd.push(jsonData);
    } catch (e) {
      // ignore invalid JSON-LD
    }
  });

  cheerioInstance('meta[property^="og:"]').each((_, element) => {
    const property = cheerioInstance(element).attr('property');
    const content = cheerioInstance(element).attr('content');
    if (property && content) {
      structured.openGraph[property.replace('og:', '')] = content;
    }
  });

  cheerioInstance('meta[name^="twitter:"]').each((_, element) => {
    const name = cheerioInstance(element).attr('name');
    const content = cheerioInstance(element).attr('content');
    if (name && content) {
      structured.twitterCards[name.replace('twitter:', '')] = content;
    }
  });

  cheerioInstance('[itemscope]').each((_, element) => {
    const itemType = cheerioInstance(element).attr('itemtype');
    if (!itemType) {
      return;
    }

    const microItem = extractMicrodataItem(cheerioInstance, element);
    if (!structured.microdata[itemType]) {
      structured.microdata[itemType] = [];
    }
    structured.microdata[itemType].push(microItem);
  });

  return structured;
}

export function extractMainContent(cheerioInstance) {
  if (typeof cheerioInstance !== 'function') {
    throw new Error('Invalid Cheerio instance passed to extractMainContent');
  }

  let mainContent = '';
  const contentSelectors = [
    'article',
    '[role="main"]',
    '.content',
    '.post-content',
    '.entry-content',
    '.article-content',
    'main',
    '#content',
    '#main',
    '.main-content',
  ];

  for (const selector of contentSelectors) {
    const element = cheerioInstance(selector).first();
    if (element.length && element.text().trim().length > 100) {
      mainContent = cleanText(element.text());
      break;
    }
  }

  if (!mainContent) {
    const bodyClone = cheerioInstance('body').clone();
    bodyClone
      .find(
        'nav, header, footer, aside, .sidebar, .menu, .navigation, script, style, .ads, .advertisement'
      )
      .remove();

    mainContent = cleanText(bodyClone.text());
  }

  return mainContent;
}

export function extractMediaInfo(cheerioInstance, baseUrl) {
  if (typeof cheerioInstance !== 'function') {
    throw new Error('Invalid Cheerio instance passed to extractMediaInfo');
  }

  const media = [];

  cheerioInstance('img').each((_, element) => {
    const src = cheerioInstance(element).attr('src');
    const alt = cheerioInstance(element).attr('alt') || '';
    const title = cheerioInstance(element).attr('title') || '';

    if (!src) {
      return;
    }

    try {
      const absoluteUrl = new URL(src, baseUrl).href;
      media.push({
        type: 'image',
        url: absoluteUrl,
        alt,
        title,
        width: cheerioInstance(element).attr('width'),
        height: cheerioInstance(element).attr('height'),
      });
    } catch (e) {
      // ignore invalid URLs
    }
  });

  cheerioInstance('video source').each((_, element) => {
    const src = cheerioInstance(element).attr('src');
    if (src) {
      try {
        const absoluteUrl = new URL(src, baseUrl).href;
        media.push({ type: 'video', url: absoluteUrl });
      } catch (e) {
        // ignore invalid URLs
      }
    }
  });

  cheerioInstance('audio source').each((_, element) => {
    const src = cheerioInstance(element).attr('src');
    if (src) {
      try {
        const absoluteUrl = new URL(src, baseUrl).href;
        media.push({ type: 'audio', url: absoluteUrl });
      } catch (e) {
        // ignore invalid URLs
      }
    }
  });

  return media;
}

export function processLinks(cheerioInstance, baseUrl) {
  if (typeof cheerioInstance !== 'function') {
    throw new Error('Invalid Cheerio instance passed to processLinks');
  }

  const links = [];
  const baseHost = new URL(baseUrl).hostname;

  cheerioInstance('a[href]').each((_, element) => {
    const href = cheerioInstance(element).attr('href');
    const text = cheerioInstance(element).text().trim();
    const title = cheerioInstance(element).attr('title') || '';

    if (!href) {
      return;
    }

    try {
      const url = new URL(href, baseUrl);
      const isInternal = url.hostname === baseHost;
      const linkType = classifyLink(url, text);

      links.push({
        url: url.href,
        text,
        title,
        isInternal,
        type: linkType,
        domain: url.hostname,
      });
    } catch (e) {
      // ignore invalid URLs
    }
  });

  return links;
}

export function extractMetadata(cheerioInstance) {
  if (typeof cheerioInstance !== 'function') {
    throw new Error('Invalid Cheerio instance passed to extractMetadata');
  }

  const metadata = {
    title: '',
    description: '',
    author: '',
    publishDate: '',
    modifiedDate: '',
    canonical: '',
    robots: '',
    viewport: '',
    charset: '',
    generator: '',
  };

  metadata.title =
    cheerioInstance('title').text().trim() ||
    cheerioInstance('meta[property="og:title"]').attr('content') ||
    cheerioInstance('h1').first().text().trim();

  metadata.description =
    cheerioInstance('meta[name="description"]').attr('content') ||
    cheerioInstance('meta[property="og:description"]').attr('content') ||
    '';

  metadata.author =
    cheerioInstance('meta[name="author"]').attr('content') ||
    cheerioInstance('meta[property="article:author"]').attr('content') ||
    '';

  metadata.publishDate =
    cheerioInstance('meta[property="article:published_time"]').attr('content') ||
    cheerioInstance('time[datetime]').attr('datetime') ||
    '';

  metadata.modifiedDate =
    cheerioInstance('meta[property="article:modified_time"]').attr('content') ||
    '';

  metadata.canonical =
    cheerioInstance('link[rel="canonical"]').attr('href') ||
    '';

  metadata.robots =
    cheerioInstance('meta[name="robots"]').attr('content') ||
    '';

  metadata.viewport =
    cheerioInstance('meta[name="viewport"]').attr('content') ||
    '';

  metadata.charset =
    cheerioInstance('meta[charset]').attr('charset') ||
    '';

  metadata.generator =
    cheerioInstance('meta[name="generator"]').attr('content') ||
    '';

  return metadata;
}

function extractMicrodataItem(cheerioInstance, element) {
  const item = {};
  const children = cheerioInstance(element)
    .find('[itemprop]')
    .toArray();

  children.forEach((child) => {
    const prop = cheerioInstance(child).attr('itemprop');
    const value = cheerioInstance(child).attr('content') ||
      cheerioInstance(child).text().trim();

    if (!prop) {
      return;
    }

    if (Array.isArray(item[prop])) {
      item[prop].push(value);
    } else if (item[prop]) {
      item[prop] = [item[prop], value];
    } else {
      item[prop] = value;
    }
  });

  return item;
}

function classifyLink(url, text) {
  const href = url.href.toLowerCase();
  const linkText = text.toLowerCase();

  if (
    href.includes('facebook.com') ||
    href.includes('twitter.com') ||
    href.includes('linkedin.com') ||
    href.includes('instagram.com')
  ) {
    return 'social';
  }

  if (href.match(/\.(pdf|doc|docx|xls|xlsx|zip|rar)$/)) {
    return 'download';
  }

  if (href.startsWith('mailto:')) {
    return 'email';
  }

  if (
    linkText.includes('home') ||
    linkText.includes('about') ||
    linkText.includes('contact') ||
    linkText.includes('menu')
  ) {
    return 'navigation';
  }

  return 'content';
}
