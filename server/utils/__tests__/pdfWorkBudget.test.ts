import { describe, expect, test } from "bun:test";
import { WorkPermitPool } from "../WorkPermitPool.js";

describe("PdfWorkBudget", () => {
	test("admits one PDF until its acquisition and parsing lease is released", async () => {
		const budget = new WorkPermitPool(1);
		const releaseFirst = await budget.acquire();
		let secondAdmitted = false;
		const second = budget.acquire().then((release) => {
			secondAdmitted = true;
			return release;
		});

		await Promise.resolve();
		expect(secondAdmitted).toBe(false);
		releaseFirst();
		const releaseSecond = await second;
		expect(secondAdmitted).toBe(true);
		releaseSecond();
	});
});
