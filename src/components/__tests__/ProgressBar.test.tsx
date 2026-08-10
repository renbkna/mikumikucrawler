import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressBar } from "../ProgressBar";

test("paused progress reports its outcome without active animation", () => {
	const markup = renderToStaticMarkup(<ProgressBar progress={42} runPhase="paused" />);

	expect(markup).toContain("Crawl is paused");
	expect(markup).toContain('<progress value="42" max="100" aria-label="Crawl progress"');
	expect(markup).not.toContain("Miku is working hard");
	expect(markup).not.toContain("animate-ping");
});
