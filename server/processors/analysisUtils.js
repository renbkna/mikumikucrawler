export function analyzeContent(text) {
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

  const words = text.split(/\s+/).filter((word) => word.length > 0);
  analysis.wordCount = words.length;
  analysis.readingTime = Math.ceil(words.length / 200);
  analysis.language = detectLanguage(text);
  analysis.keywords = extractKeywords(text);
  analysis.readabilityScore = calculateReadability(text);
  analysis.sentiment = analyzeSentiment(text);

  return analysis;
}

export function assessContentQuality(cheerioInstance, mainContent) {
  if (typeof cheerioInstance !== 'function') {
    throw new Error('Invalid Cheerio instance passed to assessContentQuality');
  }

  const quality = {
    score: 0,
    factors: {},
    issues: [],
  };

  const contentLength = mainContent.length;
  quality.factors.contentLength = contentLength;

  if (contentLength < 300) {
    quality.issues.push('Content too short');
  } else if (contentLength > 1000) {
    quality.score += 20;
  }

  const headings = cheerioInstance('h1, h2, h3, h4, h5, h6').length;
  quality.factors.headingCount = headings;
  if (headings > 0) {
    quality.score += 15;
  } else {
    quality.issues.push('No headings found');
  }

  const images = cheerioInstance('img').length;
  const imagesWithAlt = cheerioInstance('img[alt]').length;
  quality.factors.imageAltRatio = images > 0 ? imagesWithAlt / images : 1;
  if (images > 0 && imagesWithAlt / images < 0.8) {
    quality.issues.push('Many images missing alt text');
  } else if (images > 0) {
    quality.score += 10;
  }

  if (cheerioInstance('meta[name="description"]').attr('content')) {
    quality.score += 10;
  } else {
    quality.issues.push('Missing meta description');
  }

  const title = cheerioInstance('title').text().trim();
  if (title && title.length >= 30 && title.length <= 60) {
    quality.score += 15;
  } else if (!title) {
    quality.issues.push('Missing title tag');
  } else {
    quality.issues.push('Title length not optimal');
  }

  const internalLinks = cheerioInstance('a[href]').filter((_, el) => {
    const href = cheerioInstance(el).attr('href');
    return href && !href.startsWith('http') && !href.startsWith('//');
  }).length;

  quality.factors.internalLinks = internalLinks;
  if (internalLinks > 0) {
    quality.score += 10;
  }

  if (cheerioInstance('script[type="application/ld+json"]').length > 0) {
    quality.score += 20;
  }

  quality.score = Math.min(100, quality.score);
  return quality;
}

export function detectLanguage(text) {
  const commonWords = {
    en: ['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'],
    es: ['el', 'la', 'de', 'que', 'y', 'en', 'un', 'es', 'se', 'no', 'te', 'lo'],
    fr: ['le', 'de', 'et', 'à', 'un', 'il', 'être', 'en', 'avoir', 'que', 'pour'],
    de: ['der', 'die', 'und', 'in', 'den', 'von', 'zu', 'das', 'mit', 'sich', 'des', 'auf'],
  };

  const words = text.toLowerCase().split(/\s+/).slice(0, 100);
  const scores = {};

  for (const [lang, commonLangWords] of Object.entries(commonWords)) {
    scores[lang] = words.filter((word) => commonLangWords.includes(word)).length;
  }

  const bestMatch = Object.keys(scores).reduce((top, lang) =>
    scores[lang] > (scores[top] || 0) ? lang : top,
  '');

  return bestMatch || 'unknown';
}

export function extractKeywords(text) {
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

export function calculateReadability(text) {
  const sentences = text.split(/[.!?]+/).length;
  const words = text.split(/\s+/).length;
  const syllables = text.split(/[aeiouAEIOU]/).length - 1;

  if (sentences === 0 || words === 0) {
    return 0;
  }

  const score = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
  return Math.max(0, Math.min(100, score));
}

export function analyzeSentiment(text) {
  const positiveWords = ['good', 'great', 'excellent', 'amazing', 'wonderful', 'fantastic', 'love', 'best'];
  const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'worst', 'horrible', 'disappointing'];

  const words = text.toLowerCase().split(/\s+/);
  const positive = words.filter((word) => positiveWords.includes(word)).length;
  const negative = words.filter((word) => negativeWords.includes(word)).length;

  if (positive > negative) return 'positive';
  if (negative > positive) return 'negative';
  return 'neutral';
}

export function processJSON(content) {
  try {
    const data = JSON.parse(content);
    return {
      type: 'json',
      data,
      keys: Object.keys(data),
      structure: analyzeJSONStructure(data),
    };
  } catch (e) {
    return {
      type: 'json',
      error: 'Invalid JSON',
      raw: content.substring(0, 500),
    };
  }
}

export function analyzeJSONStructure(obj, depth = 0) {
  if (depth > 3) {
    return 'deep_object';
  }

  if (Array.isArray(obj)) {
    return {
      type: 'array',
      length: obj.length,
      itemType: obj.length > 0 ? analyzeJSONStructure(obj[0], depth + 1) : 'empty',
    };
  }

  if (typeof obj === 'object' && obj !== null) {
    return {
      type: 'object',
      keys: Object.keys(obj),
      properties: Object.keys(obj).reduce((acc, key) => {
        acc[key] = analyzeJSONStructure(obj[key], depth + 1);
        return acc;
      }, {}),
    };
  }

  return typeof obj;
}
