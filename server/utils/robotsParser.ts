// --- NativeRobotsParser ---

interface Rule {
	userAgent: string;
	/** Pre-compiled allow patterns for O(1) matching without repeated RegExp construction. */
	allow: CompiledPattern[];
	/** Pre-compiled disallow patterns. */
	disallow: CompiledPattern[];
	crawlDelay?: number;
}

interface CompiledPattern {
	/** Original pattern string — used for length comparison (RFC 9309 longest-match). */
	raw: string;
	/** Compiled RegExp for efficient matching. */
	regex: RegExp;
}

export interface RobotsResult {
	isAllowed(url: string, userAgent?: string): boolean;
	isDisallowed(url: string, userAgent?: string): boolean;
	getCrawlDelay(userAgent?: string): number | undefined;
	getSitemaps(): string[];
}

/**
 * Robots.txt parser that pre-compiles all patterns at parse time.
 *
 * Pre-compilation means each pattern is turned into a RegExp once in
 * the constructor, rather than on every isAllowed() call. For a site with
 * 50 rules checked against 1000 URLs this cuts ~50 000 RegExp constructions
 * down to ~50.
 *
 * Implements RFC 9309 longest-match precedence with Allow > Disallow on ties.
 */
export class NativeRobotsParser implements RobotsResult {
	private rules: Rule[] = [];
	private sitemaps: string[] = [];

	constructor(robotsTxt: string) {
		this.parse(robotsTxt);
	}

	/**
	 * Converts a robots.txt wildcard pattern to a pre-compiled RegExp.
	 * Special characters are escaped first, then `*` → `.*` and trailing `$` is
	 * treated as an end-of-string anchor (per the spec).
	 */
	private static compilePattern(pattern: string): RegExp | null {
		const hasEndAnchor = pattern.endsWith("$");
		const patternBody = hasEndAnchor ? pattern.slice(0, -1) : pattern;
		// Escape all regex meta-characters except the robots wildcard `*`.
		// A terminal `$` is handled separately as the RFC end-of-string anchor.
		const escaped = patternBody.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
		// * → match any sequence of characters (robots.txt wildcard)
		// Prefix with ^ so patterns match from the start of the path (RFC 9309 §2.2.2).
		// Without the anchor, a pattern like `/private` would incorrectly match
		// `/other/private/path` anywhere in the string.
		const regexSource = `^${escaped.replace(/\*/g, ".*")}${hasEndAnchor ? "$" : ""}`;

		try {
			return new RegExp(regexSource);
		} catch {
			return null; // Fallback: caller uses raw startsWith
		}
	}

	private parse(robotsTxt: string): void {
		const lines = robotsTxt.split("\n");
		let currentRule:
			| (Omit<Rule, "userAgent" | "allow" | "disallow"> & {
					userAgents: string[];
					allow: string[];
					disallow: string[];
					hasGroupDirective: boolean;
			  })
			| null = null;

		const pushCurrentRule = () => {
			if (!currentRule) return;
			const { userAgents, allow, disallow, crawlDelay } = currentRule;
			for (const userAgent of userAgents) {
				this.rules.push(
					this.compileRule({ userAgent, allow, disallow, crawlDelay }),
				);
			}
		};

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const colonIndex = trimmed.indexOf(":");
			if (colonIndex === -1) continue;

			const directive = trimmed.slice(0, colonIndex).trim().toLowerCase();
			const value = trimmed.slice(colonIndex + 1).trim();

			switch (directive) {
				case "user-agent":
					if (currentRule?.hasGroupDirective) {
						pushCurrentRule();
						currentRule = null;
					}
					if (currentRule) {
						currentRule.userAgents.push(value.toLowerCase());
					} else {
						currentRule = {
							userAgents: [value.toLowerCase()],
							allow: [],
							disallow: [],
							hasGroupDirective: false,
						};
					}
					break;
				case "allow":
					if (currentRule) {
						currentRule.hasGroupDirective = true;
						if (value) currentRule.allow.push(value);
					}
					break;
				case "disallow":
					if (currentRule) {
						currentRule.hasGroupDirective = true;
						if (value) currentRule.disallow.push(value);
					}
					break;
				case "crawl-delay":
					if (currentRule) {
						currentRule.hasGroupDirective = true;
						const crawlDelay = Number.parseFloat(value);
						if (Number.isFinite(crawlDelay) && crawlDelay >= 0) {
							currentRule.crawlDelay = crawlDelay;
						}
					}
					break;
				case "sitemap":
					this.sitemaps.push(value);
					break;
			}
		}

		pushCurrentRule();
	}

	/** Converts string pattern lists to pre-compiled CompiledPattern arrays. */
	private compileRule(raw: {
		userAgent: string;
		allow: string[];
		disallow: string[];
		crawlDelay?: number;
	}): Rule {
		const compile = (patterns: string[]): CompiledPattern[] =>
			patterns.map((p) => ({
				raw: p,
				regex: NativeRobotsParser.compilePattern(p) ?? /(?!)/,
			}));

		return {
			userAgent: raw.userAgent,
			allow: compile(raw.allow),
			disallow: compile(raw.disallow),
			crawlDelay: raw.crawlDelay,
		};
	}

	private getPathFromUrl(url: string): string {
		try {
			const parsed = new URL(url);
			return `${parsed.pathname}${parsed.search}`;
		} catch {
			return url.startsWith("/") ? url : `/${url}`;
		}
	}

	private findMatchingRules(userAgent?: string): Rule[] {
		if (!userAgent) {
			return this.rules.filter((r) => r.userAgent === "*");
		}

		const ua = userAgent.toLowerCase();
		const exact = this.rules.filter((r) => r.userAgent === ua);
		if (exact.length > 0) return exact;

		const partial = this.rules.filter(
			(r) => r.userAgent !== "*" && ua.includes(r.userAgent),
		);
		if (partial.length > 0) return partial;

		return this.rules.filter((r) => r.userAgent === "*");
	}

	isAllowed(url: string, userAgent?: string): boolean {
		const path = this.getPathFromUrl(url);
		const rules = this.findMatchingRules(userAgent);
		if (rules.length === 0) return true;

		// RFC 9309: longest matching pattern wins; Allow beats Disallow on ties.
		let longestAllow = -1;
		for (const rule of rules) {
			for (const { raw, regex } of rule.allow) {
				if (regex.test(path)) {
					longestAllow = Math.max(longestAllow, raw.length);
				}
			}
		}

		let longestDisallow = -1;
		for (const rule of rules) {
			for (const { raw, regex } of rule.disallow) {
				if (regex.test(path)) {
					longestDisallow = Math.max(longestDisallow, raw.length);
				}
			}
		}

		if (longestAllow === -1 && longestDisallow === -1) return true;
		return longestAllow >= longestDisallow;
	}

	isDisallowed(url: string, userAgent?: string): boolean {
		return !this.isAllowed(url, userAgent);
	}

	getCrawlDelay(userAgent?: string): number | undefined {
		return this.findMatchingRules(userAgent).find(
			(rule) => rule.crawlDelay !== undefined,
		)?.crawlDelay;
	}

	getSitemaps(): string[] {
		return [...this.sitemaps];
	}
}
