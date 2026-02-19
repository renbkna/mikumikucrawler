import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import type { CrawlSession } from "../../crawler/CrawlSession.js";
import type { LoggerLike } from "../../types.js";
import { createApiRoutes } from "../apiRoutes.js";

const createMockLogger = (): LoggerLike => ({
	debug: mock(() => {}),
	warn: mock(() => {}),
	info: mock(() => {}),
	error: mock(() => {}),
});

interface MockDb {
	query: ReturnType<typeof mock>;
}

const createMockDb = (overrides: Partial<MockDb> = {}): MockDb => ({
	query: mock(() => ({
		get: mock(() => null),
		all: mock(() => []),
		run: mock(() => {}),
	})),
	...overrides,
});

describe("API Routes", () => {
	let mockLogger: LoggerLike;
	let mockDb: MockDb;
	let activeCrawls: Map<string, CrawlSession>;

	beforeEach(() => {
		mockLogger = createMockLogger();
		mockDb = createMockDb();
		activeCrawls = new Map();
	});

	describe("GET /api/stats", () => {
		test("returns aggregated statistics", async () => {
			const mockStats = {
				totalPages: 100,
				totalDataSize: 50000,
				uniqueDomains: 10,
				lastCrawled: "2024-01-15T10:30:00Z",
				avgWordCount: 500,
				avgQualityScore: 75,
				avgReadingTime: 2,
				totalMedia: 20,
				totalInternalLinks: 200,
				totalExternalLinks: 50,
			};

			mockDb.query = mock(() => ({
				get: mock(() => mockStats),
				all: mock(() => []),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/stats"),
			);
			const data = await response.json();

			expect(data.status).toBe("ok");
			expect(data.stats.totalPages).toBe(100);
			expect(data.stats.activeCrawls).toBe(0);
		});

		test("returns null values when no pages crawled", async () => {
			const emptyStats = {
				totalPages: null,
				totalDataSize: null,
				uniqueDomains: null,
				lastCrawled: null,
				avgWordCount: null,
				avgQualityScore: null,
				avgReadingTime: null,
				totalMedia: null,
				totalInternalLinks: null,
				totalExternalLinks: null,
			};

			mockDb.query = mock(() => ({
				get: mock(() => emptyStats),
				all: mock(() => []),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/stats"),
			);
			const data = await response.json();

			expect(data.status).toBe("ok");
			expect(data.stats.totalPages).toBe(null);
		});

		test("tracks active crawls count", async () => {
			mockDb.query = mock(() => ({
				get: mock(() => ({ totalPages: 5 })),
				all: mock(() => []),
			}));

			activeCrawls.set("session-1", {} as CrawlSession);

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/stats"),
			);
			const data = await response.json();

			expect(data.stats.activeCrawls).toBe(1);
		});

		test("handles database errors gracefully", async () => {
			mockDb.query = mock(() => {
				throw new Error("Database connection failed");
			});

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/stats"),
			);

			expect(response.status).toBe(500);
		});

		test("returns language statistics", async () => {
			const mockLanguages = [
				{ language: "en", count: 80 },
				{ language: "es", count: 15 },
				{ language: "fr", count: 5 },
			];

			let callCount = 0;
			mockDb.query = mock(() => {
				callCount++;
				if (callCount === 1) {
					return { get: mock(() => ({ totalPages: 100 })) };
				}
				if (callCount === 2) {
					return { all: mock(() => mockLanguages) };
				}
				return { all: mock(() => []) };
			});

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/stats"),
			);
			const data = await response.json();

			expect(data.status).toBe("ok");
		});
	});

	describe("GET /api/sessions", () => {
		test("returns list of interrupted sessions", async () => {
			const mockSessions = [
				{
					id: "session-1",
					target: "https://example.com",
					status: "interrupted",
					stats: '{"pagesScanned": 50}',
					created_at: "2024-01-15T10:00:00Z",
					updated_at: "2024-01-15T11:00:00Z",
				},
			];

			mockDb.query = mock(() => ({
				all: mock(() => mockSessions),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/sessions"),
			);
			const data = await response.json();

			expect(data.sessions).toHaveLength(1);
			expect(data.sessions[0].id).toBe("session-1");
			expect(data.sessions[0].pagesScanned).toBe(50);
		});

		test("handles malformed stats JSON", async () => {
			const mockSessions = [
				{
					id: "session-1",
					target: "https://example.com",
					status: "interrupted",
					stats: "{invalid json}",
					created_at: "2024-01-15T10:00:00Z",
					updated_at: "2024-01-15T11:00:00Z",
				},
			];

			mockDb.query = mock(() => ({
				all: mock(() => mockSessions),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/sessions"),
			);
			const data = await response.json();

			expect(data.sessions[0].pagesScanned).toBe(0);
		});

		test("returns empty array when no interrupted sessions", async () => {
			mockDb.query = mock(() => ({
				all: mock(() => []),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/sessions"),
			);
			const data = await response.json();

			expect(data.sessions).toEqual([]);
		});
	});

	describe("DELETE /api/sessions/:id", () => {
		test("deletes a session", async () => {
			const runMock = mock(() => {});
			mockDb.query = mock(() => ({
				run: runMock,
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/sessions/session-1", {
					method: "DELETE",
				}),
			);
			const data = await response.json();

			expect(data.status).toBe("ok");
			expect(runMock).toHaveBeenCalled();
		});

		test("handles database errors", async () => {
			mockDb.query = mock(() => {
				throw new Error("Delete failed");
			});

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/sessions/session-1", {
					method: "DELETE",
				}),
			);

			expect(response.status).toBe(500);
		});
	});

	describe("GET /api/search", () => {
		test("requires query parameter", async () => {
			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/search"),
			);

			expect(response.status).toBe(400);
		});

		test("searches with valid query", async () => {
			const mockResults = [
				{
					id: 1,
					url: "https://example.com/page",
					title: "Test Page",
					description: "A test page",
					domain: "example.com",
					crawled_at: "2024-01-15T10:00:00Z",
					word_count: 500,
					quality_score: 80,
					title_hl: "Test Page",
					snippet: "This is a <mark>test</mark> snippet",
				},
			];

			mockDb.query = mock(() => ({
				all: mock(() => mockResults),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/search?q=test"),
			);
			const data = await response.json();

			expect(data.query).toBe("test");
			expect(data.count).toBe(1);
			expect(data.results).toHaveLength(1);
		});

		test("escapes special characters in query", async () => {
			const allMock = mock(() => []);
			mockDb.query = mock(() => ({
				all: allMock,
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			await app.handle(
				new Request('http://localhost/api/search?q=test"quoted'),
			);

			const callArgs = allMock.mock.calls[0];
			expect(callArgs).toBeDefined();
		});

		test("respects limit parameter", async () => {
			const allMock = mock(() => []);
			mockDb.query = mock(() => ({
				all: allMock,
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			await app.handle(
				new Request("http://localhost/api/search?q=test&limit=50"),
			);

			expect(allMock).toHaveBeenCalled();
		});

		test("caps limit at 100", async () => {
			const allMock = mock(() => []);
			mockDb.query = mock(() => ({
				all: allMock,
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			await app.handle(
				new Request("http://localhost/api/search?q=test&limit=500"),
			);

			expect(allMock).toHaveBeenCalled();
		});

		test("trims whitespace from query", async () => {
			const allMock = mock(() => []);
			mockDb.query = mock(() => ({
				all: allMock,
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/search?q=  test  "),
			);
			const data = await response.json();

			expect(data.query).toBe("test");
		});
	});

	describe("GET /api/pages/:id/content", () => {
		test("returns page content", async () => {
			mockDb.query = mock(() => ({
				get: mock(() => ({ content: "<html>Test content</html>" })),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/pages/1/content"),
			);
			const data = await response.json();

			expect(data.status).toBe("ok");
			expect(data.content).toBe("<html>Test content</html>");
		});

		test("returns empty string for null content", async () => {
			mockDb.query = mock(() => ({
				get: mock(() => ({ content: null })),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/pages/1/content"),
			);
			const data = await response.json();

			expect(data.content).toBe("");
		});

		test("returns 404 for non-existent page", async () => {
			mockDb.query = mock(() => ({
				get: mock(() => undefined),
			}));

			const app = new Elysia().use(
				createApiRoutes(mockDb, mockLogger, activeCrawls),
			);

			const response = await app.handle(
				new Request("http://localhost/api/pages/999/content"),
			);

			expect(response.status).toBe(404);
		});
	});
});
