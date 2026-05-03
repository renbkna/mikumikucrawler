import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

interface WebManifest {
	icons?: Array<{
		src?: string;
		sizes?: string;
		type?: string;
		purpose?: string;
	}>;
	screenshots?: Array<{
		src?: string;
		sizes?: string;
		type?: string;
	}>;
}

async function readPublicAsset(src: string): Promise<Uint8Array> {
	return readFile(new URL(`../../../public${src}`, import.meta.url));
}

function readPngSize(bytes: Uint8Array): string {
	const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	expect([...bytes.slice(0, pngSignature.length)]).toEqual(pngSignature);

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

describe("web manifest", () => {
	async function readManifest(): Promise<WebManifest> {
		return JSON.parse(
			await readFile(
				new URL("../../../public/manifest.json", import.meta.url),
				"utf8",
			),
		) as WebManifest;
	}

	test("installable icon metadata matches checked-in PNG assets", async () => {
		const manifest = await readManifest();

		for (const expected of [
			{
				src: "/icons/miku-192.png",
				sizes: "192x192",
				purpose: "any",
			},
			{
				src: "/icons/miku-512.png",
				sizes: "512x512",
				purpose: "any",
			},
			{
				src: "/icons/miku-maskable-512.png",
				sizes: "512x512",
				purpose: "maskable",
			},
		]) {
			const icon = manifest.icons?.find((entry) => entry.src === expected.src);

			expect(icon?.type).toBe("image/png");
			expect(icon?.purpose).toBe(expected.purpose);
			expect(icon?.sizes).toBe(expected.sizes);
			expect(readPngSize(await readPublicAsset(expected.src))).toBe(
				expected.sizes,
			);
		}
	});

	test("screenshot metadata matches the checked-in PNG asset", async () => {
		const manifest = await readManifest();
		const screenshot = manifest.screenshots?.find(
			(entry) => entry.src === "/mikumikucrawler.png",
		);

		expect(screenshot?.type).toBe("image/png");
		expect(screenshot?.sizes).toBe(
			readPngSize(await readPublicAsset("/mikumikucrawler.png")),
		);
	});
});
