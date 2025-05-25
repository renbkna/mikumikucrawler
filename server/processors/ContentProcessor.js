import * as cheerio from 'cheerio';
import { URL } from 'url';

export class ContentProcessor {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Main processing function - extracts all meaningful data from content
   */
  async processContent(content, url, contentType) {
    const result = {
      url,
      contentType,
      extractedData: {},
      metadata: {},
      analysis: {},
      media: [],
      links: [],
      errors: [],
    };

    try {
      if (contentType.includes('text/html')) {
        // Ensure content is a string
        const htmlContent =
          typeof content === 'string' ? content : String(content);

        // Debug logging
        this.logger.debug(
          `Processing HTML content for ${url}, length: ${
            htmlContent.length
          }, type: ${typeof htmlContent}`
        );

        // Load content with Cheerio
        const cheerioInstance = cheerio.load(htmlContent);

        // Validate that cheerio instance is properly loaded
        if (typeof cheerioInstance !== 'function') {
          throw new Error('Cheerio failed to load content');
        }

        this.logger.debug(
          `Cheerio loaded successfully for ${url}, type: ${typeof cheerioInstance}`
        );

        // Extract structured data
        try {
          this.logger.debug(`Calling extractStructuredData for ${url}`);
          result.extractedData = this.extractStructuredData(cheerioInstance);
        } catch (err) {
          this.logger.warn(`Failed to extract structured data: ${err.message}`);
          result.extractedData = {};
        }

        // Extract and clean main content
        try {
          result.extractedData.mainContent =
            this.extractMainContent(cheerioInstance);
        } catch (err) {
          this.logger.warn(`Failed to extract main content: ${err.message}`);
          result.extractedData.mainContent = '';
        }

        // Analyze content
        result.analysis = this.analyzeContent(
          result.extractedData.mainContent || ''
        );

        // Process media
        try {
          result.media = this.extractMediaInfo(cheerioInstance, url);
        } catch (err) {
          this.logger.warn(`Failed to extract media info: ${err.message}`);
          result.media = [];
        }

        // Process links
        try {
          result.links = this.processLinks(cheerioInstance, url);
        } catch (err) {
          this.logger.warn(`Failed to process links: ${err.message}`);
          result.links = [];
        }

        // Extract metadata
        try {
          result.metadata = this.extractMetadata(cheerioInstance);
        } catch (err) {
          this.logger.warn(`Failed to extract metadata: ${err.message}`);
          result.metadata = {};
        }

        // Content quality assessment
        try {
          result.analysis.quality = this.assessContentQuality(
            cheerioInstance,
            result.extractedData.mainContent || ''
          );
        } catch (err) {
          this.logger.warn(`Failed to assess content quality: ${err.message}`);
          result.analysis.quality = {
            score: 0,
            factors: {},
            issues: ['Quality assessment failed'],
          };
        }
      } else if (contentType.includes('application/pdf')) {
        // PDF processing would go here
        result.extractedData = await this.processPDF(content);
      } else if (contentType.includes('application/json')) {
        // JSON processing
        result.extractedData = this.processJSON(content);
      }
    } catch (error) {
      this.logger.error(
        `Content processing error for ${url}: ${error.message}`
      );
      result.errors.push({
        type: 'processing_error',
        message: error.message,
        timestamp: new Date().toISOString(),
      });

      // Provide fallback data to prevent crashes
      result.extractedData = { mainContent: '' };
      result.analysis = {
        wordCount: 0,
        readingTime: 0,
        language: 'unknown',
        keywords: [],
        sentiment: 'neutral',
        readabilityScore: 0,
        quality: { score: 0, factors: {}, issues: ['Processing failed'] },
      };
      result.metadata = {};
      result.media = [];
      result.links = [];
    }

    return result;
  }

  /**
   * Extract structured data (JSON-LD, microdata, etc.)
   */
  extractStructuredData(cheerioInstance) {
    // Validate that cheerioInstance is a function
    if (typeof cheerioInstance !== 'function') {
      throw new Error(
        'Invalid Cheerio instance passed to extractStructuredData'
      );
    }

    const structured = {
      jsonLd: [],
      microdata: {},
      openGraph: {},
      twitterCards: {},
      schema: {},
    };

    // JSON-LD extraction
    cheerioInstance('script[type="application/ld+json"]').each((_, element) => {
      try {
        const jsonData = JSON.parse(cheerioInstance(element).html());
        structured.jsonLd.push(jsonData);
      } catch (e) {
        // Invalid JSON-LD, skip
      }
    });

    // Open Graph tags
    cheerioInstance('meta[property^="og:"]').each((_, element) => {
      const property = cheerioInstance(element).attr('property');
      const content = cheerioInstance(element).attr('content');
      if (property && content) {
        structured.openGraph[property.replace('og:', '')] = content;
      }
    });

    // Twitter Cards
    cheerioInstance('meta[name^="twitter:"]').each((_, element) => {
      const name = cheerioInstance(element).attr('name');
      const content = cheerioInstance(element).attr('content');
      if (name && content) {
        structured.twitterCards[name.replace('twitter:', '')] = content;
      }
    });

    // Microdata (basic implementation)
    cheerioInstance('[itemscope]').each((_, element) => {
      const itemType = cheerioInstance(element).attr('itemtype');
      if (itemType) {
        const microItem = this.extractMicrodataItem(cheerioInstance, element);
        if (!structured.microdata[itemType]) {
          structured.microdata[itemType] = [];
        }
        structured.microdata[itemType].push(microItem);
      }
    });

    return structured;
  }

  /**
   * Extract main content using various heuristics
   */
  extractMainContent(cheerioInstance) {
    // Validate that cheerioInstance is a function
    if (typeof cheerioInstance !== 'function') {
      throw new Error('Invalid Cheerio instance passed to extractMainContent');
    }

    let mainContent = '';

    // Try common content selectors in order of preference
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
        mainContent = this.cleanText(element.text());
        break;
      }
    }

    // Fallback: extract from body, removing common noise
    if (!mainContent) {
      const bodyClone = cheerioInstance('body').clone();

      // Remove noise elements
      bodyClone
        .find(
          'nav, header, footer, aside, .sidebar, .menu, .navigation, script, style, .ads, .advertisement'
        )
        .remove();

      mainContent = this.cleanText(bodyClone.text());
    }

    return mainContent;
  }

  /**
   * Analyze content for insights
   */
  analyzeContent(text) {
    const analysis = {
      wordCount: 0,
      readingTime: 0,
      language: 'unknown',
      keywords: [],
      topics: [],
      sentiment: 'neutral',
      readabilityScore: 0,
    };

    if (!text) return analysis;

    // Word count and reading time
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    analysis.wordCount = words.length;
    analysis.readingTime = Math.ceil(words.length / 200); // Assuming 200 WPM

    // Simple language detection (basic implementation)
    analysis.language = this.detectLanguage(text);

    // Extract keywords (simple frequency-based)
    analysis.keywords = this.extractKeywords(text);

    // Basic readability (Flesch-like score)
    analysis.readabilityScore = this.calculateReadability(text);

    // Simple sentiment analysis
    analysis.sentiment = this.analyzeSentiment(text);

    return analysis;
  }

  /**
   * Extract media information
   */
  extractMediaInfo(cheerioInstance, baseUrl) {
    // Validate that cheerioInstance is a function
    if (typeof cheerioInstance !== 'function') {
      throw new Error('Invalid Cheerio instance passed to extractMediaInfo');
    }

    const media = [];

    // Images
    cheerioInstance('img').each((_, element) => {
      const src = cheerioInstance(element).attr('src');
      const alt = cheerioInstance(element).attr('alt') || '';
      const title = cheerioInstance(element).attr('title') || '';

      if (src) {
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
          // Invalid URL
        }
      }
    });

    // Videos
    cheerioInstance('video, iframe[src*="youtube"], iframe[src*="vimeo"]').each(
      (_, element) => {
        const src =
          cheerioInstance(element).attr('src') ||
          cheerioInstance(element).find('source').first().attr('src');
        if (src) {
          try {
            const absoluteUrl = new URL(src, baseUrl).href;
            media.push({
              type: 'video',
              url: absoluteUrl,
              title: cheerioInstance(element).attr('title') || '',
              poster: cheerioInstance(element).attr('poster'),
            });
          } catch (e) {
            // Invalid URL
          }
        }
      }
    );

    // Audio
    cheerioInstance('audio').each((_, element) => {
      const src =
        cheerioInstance(element).attr('src') ||
        cheerioInstance(element).find('source').first().attr('src');
      if (src) {
        try {
          const absoluteUrl = new URL(src, baseUrl).href;
          media.push({
            type: 'audio',
            url: absoluteUrl,
            title: cheerioInstance(element).attr('title') || '',
          });
        } catch (e) {
          // Invalid URL
        }
      }
    });

    return media;
  }

  /**
   * Process and classify links
   */
  processLinks(cheerioInstance, baseUrl) {
    // Validate that cheerioInstance is a function
    if (typeof cheerioInstance !== 'function') {
      throw new Error('Invalid Cheerio instance passed to processLinks');
    }

    const links = [];
    const baseHost = new URL(baseUrl).hostname;

    cheerioInstance('a[href]').each((_, element) => {
      const href = cheerioInstance(element).attr('href');
      const text = cheerioInstance(element).text().trim();
      const title = cheerioInstance(element).attr('title') || '';

      if (href) {
        try {
          const url = new URL(href, baseUrl);
          const isInternal = url.hostname === baseHost;
          const linkType = this.classifyLink(url, text);

          links.push({
            url: url.href,
            text,
            title,
            isInternal,
            type: linkType,
            domain: url.hostname,
          });
        } catch (e) {
          // Invalid URL
        }
      }
    });

    return links;
  }

  /**
   * Extract comprehensive metadata
   */
  extractMetadata(cheerioInstance) {
    // Validate that cheerioInstance is a function
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

    // Title
    metadata.title =
      cheerioInstance('title').text().trim() ||
      cheerioInstance('meta[property="og:title"]').attr('content') ||
      cheerioInstance('h1').first().text().trim();

    // Description
    metadata.description =
      cheerioInstance('meta[name="description"]').attr('content') ||
      cheerioInstance('meta[property="og:description"]').attr('content');

    // Author
    metadata.author =
      cheerioInstance('meta[name="author"]').attr('content') ||
      cheerioInstance('meta[property="article:author"]').attr('content');

    // Dates
    metadata.publishDate =
      cheerioInstance('meta[property="article:published_time"]').attr(
        'content'
      ) || cheerioInstance('meta[name="date"]').attr('content');

    metadata.modifiedDate =
      cheerioInstance('meta[property="article:modified_time"]').attr(
        'content'
      ) || cheerioInstance('meta[name="last-modified"]').attr('content');

    // Technical metadata
    metadata.canonical = cheerioInstance('link[rel="canonical"]').attr('href');
    metadata.robots = cheerioInstance('meta[name="robots"]').attr('content');
    metadata.viewport = cheerioInstance('meta[name="viewport"]').attr(
      'content'
    );
    metadata.charset = cheerioInstance('meta[charset]').attr('charset');
    metadata.generator = cheerioInstance('meta[name="generator"]').attr(
      'content'
    );

    return metadata;
  }

  /**
   * Assess content quality
   */
  assessContentQuality(cheerioInstance, mainContent) {
    // Validate that cheerioInstance is a function
    if (typeof cheerioInstance !== 'function') {
      throw new Error(
        'Invalid Cheerio instance passed to assessContentQuality'
      );
    }

    const quality = {
      score: 0,
      factors: {},
      issues: [],
    };

    // Content length
    const contentLength = mainContent.length;
    quality.factors.contentLength = contentLength;

    if (contentLength < 300) {
      quality.issues.push('Content too short');
    } else if (contentLength > 1000) {
      quality.score += 20;
    }

    // Heading structure
    const headings = cheerioInstance('h1, h2, h3, h4, h5, h6').length;
    quality.factors.headingCount = headings;

    if (headings > 0) {
      quality.score += 15;
    } else {
      quality.issues.push('No headings found');
    }

    // Image alt text
    const images = cheerioInstance('img').length;
    const imagesWithAlt = cheerioInstance('img[alt]').length;
    quality.factors.imageAltRatio = images > 0 ? imagesWithAlt / images : 1;

    if (images > 0 && imagesWithAlt / images < 0.8) {
      quality.issues.push('Many images missing alt text');
    } else if (images > 0) {
      quality.score += 10;
    }

    // Meta description
    if (cheerioInstance('meta[name="description"]').attr('content')) {
      quality.score += 10;
    } else {
      quality.issues.push('Missing meta description');
    }

    // Title tag
    const title = cheerioInstance('title').text().trim();
    if (title && title.length >= 30 && title.length <= 60) {
      quality.score += 15;
    } else if (!title) {
      quality.issues.push('Missing title tag');
    } else {
      quality.issues.push('Title length not optimal');
    }

    // Internal links
    const internalLinks = cheerioInstance('a[href]').filter((_, el) => {
      const href = cheerioInstance(el).attr('href');
      return href && !href.startsWith('http') && !href.startsWith('//');
    }).length;

    quality.factors.internalLinks = internalLinks;
    if (internalLinks > 0) {
      quality.score += 10;
    }

    // Structured data
    if (cheerioInstance('script[type="application/ld+json"]').length > 0) {
      quality.score += 20;
    }

    quality.score = Math.min(100, quality.score);
    return quality;
  }

  // Helper methods
  extractMicrodataItem(cheerioInstance, element) {
    const item = {};
    const $element = cheerioInstance(element);
    $element.find('[itemprop]').each((_, prop) => {
      const propName = cheerioInstance(prop).attr('itemprop');
      const propValue =
        cheerioInstance(prop).attr('content') ||
        cheerioInstance(prop).text().trim();
      item[propName] = propValue;
    });
    return item;
  }

  cleanText(text) {
    return text.replace(/\s+/g, ' ').replace(/\n+/g, '\n').trim();
  }

  detectLanguage(text) {
    // Simple language detection based on common words
    const commonWords = {
      en: [
        'the',
        'and',
        'or',
        'but',
        'in',
        'on',
        'at',
        'to',
        'for',
        'of',
        'with',
        'by',
      ],
      es: [
        'el',
        'la',
        'de',
        'que',
        'y',
        'en',
        'un',
        'es',
        'se',
        'no',
        'te',
        'lo',
      ],
      fr: [
        'le',
        'de',
        'et',
        'à',
        'un',
        'il',
        'être',
        'et',
        'en',
        'avoir',
        'que',
        'pour',
      ],
      de: [
        'der',
        'die',
        'und',
        'in',
        'den',
        'von',
        'zu',
        'das',
        'mit',
        'sich',
        'des',
        'auf',
      ],
    };

    const words = text.toLowerCase().split(/\s+/).slice(0, 100);
    const scores = {};

    for (const [lang, commonLangWords] of Object.entries(commonWords)) {
      scores[lang] = words.filter((word) =>
        commonLangWords.includes(word)
      ).length;
    }

    return (
      Object.keys(scores).reduce((a, b) => (scores[a] > scores[b] ? a : b)) ||
      'unknown'
    );
  }

  extractKeywords(text) {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((word) => word.length > 3);

    const frequency = {};
    words.forEach((word) => {
      frequency[word] = (frequency[word] || 0) + 1;
    });

    return Object.entries(frequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([word, count]) => ({ word, count }));
  }

  calculateReadability(text) {
    const sentences = text.split(/[.!?]+/).length;
    const words = text.split(/\s+/).length;
    const syllables = text.split(/[aeiouAEIOU]/).length - 1;

    if (sentences === 0 || words === 0) return 0;

    // Simplified Flesch Reading Ease
    const score =
      206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
    return Math.max(0, Math.min(100, score));
  }

  analyzeSentiment(text) {
    const positiveWords = [
      'good',
      'great',
      'excellent',
      'amazing',
      'wonderful',
      'fantastic',
      'love',
      'best',
    ];
    const negativeWords = [
      'bad',
      'terrible',
      'awful',
      'hate',
      'worst',
      'horrible',
      'disappointing',
    ];

    const words = text.toLowerCase().split(/\s+/);
    const positive = words.filter((word) =>
      positiveWords.includes(word)
    ).length;
    const negative = words.filter((word) =>
      negativeWords.includes(word)
    ).length;

    if (positive > negative) return 'positive';
    if (negative > positive) return 'negative';
    return 'neutral';
  }

  classifyLink(url, text) {
    const href = url.href.toLowerCase();
    const linkText = text.toLowerCase();

    // Social media
    if (
      href.includes('facebook.com') ||
      href.includes('twitter.com') ||
      href.includes('linkedin.com') ||
      href.includes('instagram.com')
    ) {
      return 'social';
    }

    // Downloads
    if (href.match(/\.(pdf|doc|docx|xls|xlsx|zip|rar)$/)) {
      return 'download';
    }

    // Email
    if (href.startsWith('mailto:')) {
      return 'email';
    }

    // Navigation
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

  async processPDF(content) {
    // PDF processing would require additional libraries like pdf-parse
    // This is a placeholder for PDF text extraction
    return {
      type: 'pdf',
      text: 'PDF processing not implemented',
      pages: 0,
    };
  }

  processJSON(content) {
    try {
      const data = JSON.parse(content);
      return {
        type: 'json',
        data,
        keys: Object.keys(data),
        structure: this.analyzeJSONStructure(data),
      };
    } catch (e) {
      return {
        type: 'json',
        error: 'Invalid JSON',
        raw: content.substring(0, 500),
      };
    }
  }

  analyzeJSONStructure(obj, depth = 0) {
    if (depth > 3) return 'deep_object';

    if (Array.isArray(obj)) {
      return {
        type: 'array',
        length: obj.length,
        itemType:
          obj.length > 0
            ? this.analyzeJSONStructure(obj[0], depth + 1)
            : 'empty',
      };
    }

    if (typeof obj === 'object' && obj !== null) {
      return {
        type: 'object',
        keys: Object.keys(obj),
        properties: Object.keys(obj).reduce((acc, key) => {
          acc[key] = this.analyzeJSONStructure(obj[key], depth + 1);
          return acc;
        }, {}),
      };
    }

    return typeof obj;
  }
}
