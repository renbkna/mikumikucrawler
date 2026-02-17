/**
 * Oxlint Configuration
 *
 * Oxlint focuses on correctness rules and catches bugs that biome might miss.
 * Run: npx oxlint
 *
 * Biome handles:
 * - Code formatting
 * - Import organization
 * - General linting
 *
 * Oxlint handles:
 * - JavaScript/TypeScript correctness
 * - React/JSX specific issues
 * - Performance anti-patterns
 */

export default {
	// Files to lint
	files: ["server/**/*.{ts,js}", "src/**/*.{ts,tsx,js,jsx}"],

	// Ignore patterns (same as .gitignore + build artifacts)
	ignore: [
		"**/node_modules/**",
		"**/dist/**",
		"**/*.d.ts",
		"**/coverage/**",
		"**/__tests__/**",
	],

	// Rules configuration
	rules: {
		// Enable all recommended correctness rules
		correctness: "error",

		// React/JSX specific rules
		react: "error",

		// Performance rules
		performance: "warn",

		// Suspicious patterns
		suspicious: "error",

		// Pedantic rules (disabled by default)
		pedantic: "off",

		// Style rules (let biome handle these)
		style: "off",
		restriction: "off",
	},

	// Environment
	env: {
		browser: true,
		node: true,
		es2024: true,
	},

	// Parser options
	parserOptions: {
		ecmaVersion: "latest",
		sourceType: "module",
	},
};
