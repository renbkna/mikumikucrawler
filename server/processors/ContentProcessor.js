import * as cheerio from 'cheerio';
import {
  extractStructuredData,
  extractMainContent,
  extractMediaInfo,
  processLinks,
  extractMetadata,
} from './extractionUtils.js';
import {
  analyzeContent,
  assessContentQuality,
  processJSON,
} from './analysisUtils.js';

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
          result.extractedData = extractStructuredData(cheerioInstance);
        } catch (err) {
          this.logger.warn(`Failed to extract structured data: ${err.message}`);
          result.extractedData = {};
        }

        // Extract and clean main content
        try {
          result.extractedData.mainContent =
            extractMainContent(cheerioInstance);
        } catch (err) {
          this.logger.warn(`Failed to extract main content: ${err.message}`);
          result.extractedData.mainContent = '';
        }

        // Analyze content
        result.analysis = analyzeContent(
          result.extractedData.mainContent || ''
        );

        // Process media
        try {
          result.media = extractMediaInfo(cheerioInstance, url);
        } catch (err) {
          this.logger.warn(`Failed to extract media info: ${err.message}`);
          result.media = [];
        }

        // Process links
        try {
          result.links = processLinks(cheerioInstance, url);
        } catch (err) {
          this.logger.warn(`Failed to process links: ${err.message}`);
          result.links = [];
        }

        // Extract metadata
        try {
          result.metadata = extractMetadata(cheerioInstance);
        } catch (err) {
          this.logger.warn(`Failed to extract metadata: ${err.message}`);
          result.metadata = {};
        }

        // Content quality assessment
        try {
          result.analysis.quality = assessContentQuality(
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
        result.extractedData = processJSON(content);
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

  async processPDF(content) {
    // PDF processing would require additional libraries like pdf-parse
    // This is a placeholder for PDF text extraction
    return {
      type: 'pdf',
      text: 'PDF processing not implemented',
      pages: 0,
    };
  }


}
