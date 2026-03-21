import type { Logger } from "../../config/logging.js";
import type { CrawlOptions } from "../../contracts/crawl.js";
import { DynamicRenderer as LegacyDynamicRenderer } from "../../crawler/dynamicRenderer.js";
import type { SanitizedCrawlOptions } from "../../types.js";

export class DynamicRenderer extends LegacyDynamicRenderer {
	constructor(options: CrawlOptions, logger: Logger) {
		super(options as SanitizedCrawlOptions, logger);
	}
}
