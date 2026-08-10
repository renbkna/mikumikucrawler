import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [css, index, manifestSource] = await Promise.all([
	readFile(new URL("../index.css", import.meta.url), "utf8"),
	readFile(new URL("../../index.html", import.meta.url), "utf8"),
	readFile(new URL("../../public/manifest.json", import.meta.url), "utf8"),
]);

function cssToken(name: string): string {
	const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
	if (!value) throw new Error(`Missing CSS theme authority --${name}`);
	return value;
}

test("PWA and Tailwind projections match the CSS theme authority", () => {
	const manifest = JSON.parse(manifestSource) as {
		background_color: string;
		theme_color: string;
	};
	const teal = cssToken("miku-teal");
	const background = cssToken("kawaii-bg");

	expect(css).toContain("--color-miku-teal-dark: var(--miku-teal-dark)");
	expect(css).toContain("--color-miku-pink-dark: var(--miku-pink-dark)");
	expect(manifest).toMatchObject({ background_color: background, theme_color: teal });
	expect(index).toContain(`<meta name="theme-color" content="${teal}" />`);
	expect(index).toContain(`--miku-teal: ${teal}`);
	expect(index).toContain(`--miku-bg: ${background}`);
});
