import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CrawlerForm } from "../CrawlerForm";

test("uses native form submission for the primary crawl action", () => {
	const markup = renderToStaticMarkup(
		<CrawlerForm
			target="https://example.com/"
			setTarget={() => undefined}
			crawlOptions={{
				target: "https://example.com/",
				crawlMethod: "links",
				crawlDepth: 1,
				crawlDelay: 0,
				maxPages: 1,
				maxPagesPerDomain: 0,
				maxConcurrentRequests: 1,
				retryLimit: 0,
				dynamic: false,
				respectRobots: true,
				contentOnly: false,
				saveMedia: false,
			}}
			isAttacking={false}
			canStart={true}
			canForceStop={false}
			canPause={false}
			startAttack={() => undefined}
			pauseAttack={() => undefined}
			forceStopAttack={() => undefined}
			setOpenedConfig={() => undefined}
			connectionState="connected"
		/>,
	);

	expect(markup).toStartWith("<form");
	expect(markup).toContain('type="submit"');
	expect(markup).toContain('aria-label="Start Miku Beam Crawl"');
});
