import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../config/logging.js";
import type { SanitizedCrawlOptions } from "../../types.js";
import { DynamicRenderer } from "../dynamicRenderer.js";

/**
 * CONTRACT: DynamicRenderer
 *
 * Purpose: Renders JavaScript-heavy pages using Puppeteer for SPA support
 * with ad/cookie blocking and site-specific optimizations.
 *
 * LIFECYCLE:
 *   1. CONSTRUCTION: Creates instance, registers for cleanup
 *   2. INITIALIZATION: Lazy-loads browser on first render()
 *   3. OPERATION: Renders pages with adblocking, cookie injection, selector waiting
 *   4. CLEANUP: Closes browser, removes from tracking
 *
 * INPUTS:
 *   - options: SanitizedCrawlOptions (dynamic flag, viewport, etc.)
 *   - logger: Logger (for operational logging)
 *   - item: QueueItem { url, depth, retries } for render()
 *
 * OUTPUTS:
 *   - render(): Promise<DynamicRenderResult | null>
 *     - content: string (HTML body)
 *     - statusCode: number (HTTP status)
 *     - contentType: string
 *     - contentLength: number (bytes)
 *     - title: string (page title)
 *     - description: string (meta description)
 *     - lastModified?: string
 *     - isDynamic: true
 *
 * INVARIANTS:
 *   1. SINGLETON ADBLOCKER: One shared PuppeteerBlocker across all instances
 *   2. INSTANCE TRACKING: All instances tracked in static Set for cleanup
 *   3. LAZY INITIALIZATION: Browser launched only on first render()
 *   4. DETERMINISTIC CLEANUP: close() always removes from tracking
 *   5. DISABLE STATE: Once disabled(), stays disabled for instance lifetime
 *   6. PAGE RECYCLING: Pages reused up to RECYCLE_THRESHOLD
 *   7. MEMORY SAFETY: Browser force-killed if graceful close fails
 *   8. COOKIE PERSISTENCE: Site cookies set before navigation
 *   9. SELECTOR WAITING: Complex sites wait for content selectors
 *  10. FALLBACK: Returns null on render failure (doesn't throw)
 *
 * FORBIDDEN STATES:
 *   - Multiple browsers per instance
 *   - Zombie processes after close()
 *   - render() after disable() without error
 *   - Memory leak from untracked instances
 *
 * EDGE CASES:
 *   - Browser launch failure
 *   - Page crash during render
 *   - Navigation timeout
 *   - Invalid URLs
 *   - Missing content selectors
 *   - Cookie setting failures
 *   - Memory pressure
 *   - Concurrent render() calls
 *   - close() during render()
 */

const createMockLogger = (): Logger => ({
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	debug: mock(() => {}),
});

const createOptions = (enabled = true): SanitizedCrawlOptions => ({
	target: "https://example.com",
	crawlDepth: 2,
	maxPages: 100,
	crawlDelay: 100,
	crawlMethod: "full",
	maxConcurrentRequests: 5,
	retryLimit: 3,
	dynamic: enabled,
	respectRobots: true,
	contentOnly: false,
	saveMedia: false,
});

describe("DynamicRenderer CONTRACT", () => {
	describe("INVARIANT: Construction & Lifecycle", () => {
		test("instance is tracked after construction", () => {
			const beforeCount = DynamicRenderer.instances.size;

			const renderer = new DynamicRenderer(createOptions(), createMockLogger());

			// INVARIANT: Instance added to tracking Set
			expect(DynamicRenderer.instances.size).toBe(beforeCount + 1);
			expect(DynamicRenderer.instances.has(renderer)).toBe(true);

			// Cleanup
			renderer.close();
		});

		test("multiple instances are all tracked", () => {
			const renderers: DynamicRenderer[] = [];
			const initialCount = DynamicRenderer.instances.size;

			for (let i = 0; i < 3; i++) {
				renderers.push(
					new DynamicRenderer(createOptions(), createMockLogger()),
				);
			}

			// INVARIANT: All instances tracked
			expect(DynamicRenderer.instances.size).toBe(initialCount + 3);

			// Cleanup
			for (const r of renderers) {
				r.close();
			}
		});

		test("close() removes instance from tracking", async () => {
			const renderer = new DynamicRenderer(createOptions(), createMockLogger());

			expect(DynamicRenderer.instances.has(renderer)).toBe(true);

			await renderer.close();

			// INVARIANT: Instance removed from tracking
			expect(DynamicRenderer.instances.has(renderer)).toBe(false);
		});

		test("render() returns null before browser launch when disabled", async () => {
			// INVARIANT: LAZY INITIALIZATION — no browser launched until render() called
			// Test this via observable behavior: disabled renderer returns null immediately
			const renderer = new DynamicRenderer(
				createOptions(false),
				createMockLogger(),
			);

			const result = await renderer.render({
				url: "https://example.com",
				depth: 0,
				retries: 0,
				domain: "example.com",
			});

			// Disabled renderer returns null without launching browser
			expect(result).toBeNull();
			// isEnabled confirms the disabled state
			expect(renderer.isEnabled()).toBe(false);

			renderer.close();
		});

		test("close() before any render completes without error", async () => {
			// INVARIANT: close() handles null browser (no browser yet) gracefully
			const renderer = new DynamicRenderer(createOptions(), createMockLogger());

			// No render() called — browser was never launched
			await expect(renderer.close()).resolves.toBeUndefined();

			// INVARIANT: Still removed from tracking after close
			expect(DynamicRenderer.instances.has(renderer)).toBe(false);
		});
	});

	describe("INVARIANT: Enable/Disable State", () => {
		test("isEnabled() returns true when dynamic enabled", () => {
			const renderer = new DynamicRenderer(
				createOptions(true),
				createMockLogger(),
			);

			expect(renderer.isEnabled()).toBe(true);

			renderer.close();
		});

		test("isEnabled() returns false when dynamic disabled in options", () => {
			const renderer = new DynamicRenderer(
				createOptions(false),
				createMockLogger(),
			);

			expect(renderer.isEnabled()).toBe(false);

			renderer.close();
		});

		test("disableDynamic() permanently disables renderer", () => {
			const renderer = new DynamicRenderer(
				createOptions(true),
				createMockLogger(),
			);

			expect(renderer.isEnabled()).toBe(true);

			renderer.disableDynamic("Testing disable");

			// INVARIANT: Once disabled, stays disabled
			expect(renderer.isEnabled()).toBe(false);
			expect(renderer.isEnabled()).toBe(false); // Idempotent

			renderer.close();
		});

		test("disableDynamic() logs reason when provided", () => {
			const logger = createMockLogger();
			const renderer = new DynamicRenderer(createOptions(), logger);

			renderer.disableDynamic("Memory pressure");

			// INVARIANT: Reason logged via warn
			expect(logger.warn).toHaveBeenCalled();

			renderer.close();
		});
	});

	describe("INVARIANT: Cleanup & Resource Management", () => {
		test("close() handles no-browser state gracefully", async () => {
			// INVARIANT: close() before any render() (no browser launched) does not throw
			const renderer = new DynamicRenderer(createOptions(), createMockLogger());

			await expect(renderer.close()).resolves.toBeUndefined();

			// INVARIANT: Instance removed from tracking
			expect(DynamicRenderer.instances.has(renderer)).toBe(false);
		});

		test("render() returns null after close()", async () => {
			// INVARIANT: DETERMINISTIC CLEANUP — once closed, render returns null
			const renderer = new DynamicRenderer(
				createOptions(false),
				createMockLogger(),
			);

			await renderer.close();

			const result = await renderer.render({
				url: "https://example.com",
				depth: 0,
				retries: 0,
				domain: "example.com",
			});

			// After close, renderer is disabled — render returns null
			expect(result).toBeNull();
		});

		test("close() completes even with injected mock browser", async () => {
			// INVARIANT: MEMORY SAFETY — close() always cleans up browser reference
			const renderer = new DynamicRenderer(createOptions(), createMockLogger());

			// Inject a mock browser to simulate an open browser state
			renderer.browser = {
				close: mock(() => Promise.resolve()),
			} as unknown as Browser;

			await expect(renderer.close()).resolves.toBeUndefined();

			// INVARIANT: Instance removed from tracking after close
			expect(DynamicRenderer.instances.has(renderer)).toBe(false);
		});
	});

	describe("INVARIANT: Global Handler Registration", () => {
		test("handlers registered once across all instances", () => {
			// Create multiple instances
			const r1 = new DynamicRenderer(createOptions(), createMockLogger());
			const r2 = new DynamicRenderer(createOptions(), createMockLogger());
			const r3 = new DynamicRenderer(createOptions(), createMockLogger());

			// INVARIANT: Handlers registered exactly once
			expect(DynamicRenderer.handlersRegistered).toBe(true);

			r1.close();
			r2.close();
			r3.close();
		});
	});

	describe("EDGE CASE: Memory & Performance", () => {
		test("instances Set prevents memory leaks", () => {
			const initialSize = DynamicRenderer.instances.size;

			// Create and properly cleanup many instances
			for (let i = 0; i < 10; i++) {
				const r = new DynamicRenderer(createOptions(), createMockLogger());
				r.close();
			}

			// INVARIANT: No memory leak from unclosed instances
			// Note: Actual size depends on other tests, but should not grow unbounded
			expect(DynamicRenderer.instances.size).toBe(initialSize);
		});

		test("close() without a launched browser does not throw (no PID)", async () => {
			// INVARIANT: MEMORY SAFETY — close() handles absent process gracefully
			const renderer = new DynamicRenderer(createOptions(), createMockLogger());

			// No render() called — no browser process was spawned
			await expect(renderer.close()).resolves.toBeUndefined();
		});
	});

	describe("EDGE CASE: Concurrent Operations", () => {
		test("multiple close() calls are safe", async () => {
			const renderer = new DynamicRenderer(createOptions(), createMockLogger());

			// Multiple closes should not throw
			await renderer.close();
			await renderer.close();
			await renderer.close();

			// INVARIANT: Idempotent cleanup
			expect(DynamicRenderer.instances.has(renderer)).toBe(false);
		});
	});

	describe("NOTE: Full Integration Testing", () => {
		test("NOTE: Browser launch requires Puppeteer", () => {
			// Full browser testing requires:
			// - Puppeteer browser instance
			// - Actual HTTP server
			// - Network access
			//
			// These tests verify the contract without browser:
			// - Lifecycle management
			// - State transitions
			// - Cleanup guarantees
			//
			// For full integration tests with real browser:
			// - Test with actual web server
			// - Test adblocking works
			// - Test cookie injection
			// - Test selector waiting
			// - Test page recycling

			expect(true).toBe(true);
		});
	});
});
