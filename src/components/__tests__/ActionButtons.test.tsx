import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionButtons } from "../ActionButtons";

function renderActions(storedPageCount: number): string {
	return renderToStaticMarkup(
		<ActionButtons
			storedPageCount={storedPageCount}
			setOpenExportDialog={() => {}}
			showDetails={false}
			setShowDetails={() => {}}
		/>,
	);
}

describe("ActionButtons", () => {
	test("uses the durable page count for export availability and its badge", () => {
		const populated = renderActions(350);
		expect(populated).toContain(">350</span>");
		expect(populated).not.toContain("disabled");

		const empty = renderActions(0);
		expect(empty).toContain("disabled");
		expect(empty).not.toContain(">0</span>");
	});
});
