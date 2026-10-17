import { describe, expect, it } from "vitest";
import { parseObservations } from "../src/agents/observer.js";
import { parseReflections, normalizeSupportingObservationIds } from "../src/agents/reflector.js";
import { parseDropIds, selectDropCandidates } from "../src/agents/dropper.js";
import { extractJsonObject } from "../src/agents/json.js";
import { reflectionCoverageMap, reflectionCoverageTierForCount } from "../src/coverage.js";
import { observationPoolMetrics, maxDropCountForPool } from "../src/pool.js";
import { renderSummaryWithBudget, observationToSummaryLine } from "../src/summary.js";
import { resolveConfig, parseModelRef, formatModelRef } from "../src/config.js";
import { hashId } from "../src/ids.js";
import { entriesFromSessionMessages, sliceEntries, tokensAfter } from "../src/transcript.js";
import type { Observation, Reflection } from "../src/types.js";

const observation = (overrides: Partial<Observation> = {}): Observation => ({
	id: hashId(overrides.content ?? "content"),
	content: "content",
	timestamp: "2026-10-16 12:00",
	relevance: "medium",
	sourceEntryIds: ["m1"],
	tokenCount: 10,
	...overrides,
});

const reflection = (overrides: Partial<Reflection> = {}): Reflection => ({
	id: hashId(overrides.content ?? "reflection"),
	content: "reflection",
	supportingObservationIds: ["abc123abc123"],
	tokenCount: 8,
	...overrides,
});

describe("extractJsonObject", () => {
	it("parses bare JSON", () => {
		expect(extractJsonObject('{"observations":[]}')).toEqual({ observations: [] });
	});
	it("parses fenced JSON", () => {
		expect(extractJsonObject('```json\n{"ids":["a"]}\n```')).toEqual({ ids: ["a"] });
	});
	it("parses JSON surrounded by prose", () => {
		expect(extractJsonObject('Here you go: {"ids":["a"]} — done.')).toEqual({ ids: ["a"] });
	});
	it("throws when there is no object", () => {
		expect(() => extractJsonObject("no json here")).toThrow();
	});
});

describe("observer validation", () => {
	it("accepts a well formed batch and orders it by source entry", () => {
		const result = parseObservations(
			{
				observations: [
					{ timestamp: "2026-10-16 12:05", content: "second", relevance: "high", sourceEntryIds: ["m2"] },
					{ timestamp: "2026-10-16 12:00", content: "first", relevance: "low", sourceEntryIds: ["m1"] },
				],
			},
			["m1", "m2"],
		);
		expect(result.observations.map((observation) => observation.content)).toEqual(["first", "second"]);
	});

	it("rejects observations citing unknown source ids", () => {
		const result = parseObservations(
			{ observations: [{ timestamp: "2026-10-16 12:00", content: "x", relevance: "low", sourceEntryIds: ["ghost"] }] },
			["m1"],
		);
		expect(result.observations).toHaveLength(0);
		expect(result.rejected).toBe(1);
	});

	it("drops duplicate content within a batch and against known ids", () => {
		const first = parseObservations(
			{ observations: [{ timestamp: "2026-10-16 12:00", content: "same", relevance: "low", sourceEntryIds: ["m1"] }] },
			["m1"],
		);
		expect(first.observations).toHaveLength(1);
		const second = parseObservations(
			{
				observations: [
					{ timestamp: "2026-10-16 12:00", content: "same", relevance: "low", sourceEntryIds: ["m1"] },
					{ timestamp: "2026-10-16 12:00", content: "same", relevance: "low", sourceEntryIds: ["m1"] },
				],
			},
			["m1"],
			new Set([first.observations[0].id]),
		);
		expect(second.observations).toHaveLength(0);
		expect(second.duplicates).toBe(2);
	});

	it("falls back to medium relevance and a valid timestamp", () => {
		const result = parseObservations(
			{ observations: [{ content: "no relevance", sourceEntryIds: ["m1"] }] },
			["m1"],
		);
		expect(result.observations[0].relevance).toBe("medium");
		expect(result.observations[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});

	it("ignores a malformed payload instead of inventing records", () => {
		expect(parseObservations({ nope: true }, ["m1"]).observations).toHaveLength(0);
	});
});

describe("reflector validation", () => {
	it("rejects multi-line reflections", () => {
		const result = parseReflections(
			{ reflections: [{ content: "line one\nline two", supportingObservationIds: ["abc123abc123"] }] },
			["abc123abc123"],
		);
		expect(result.reflections).toHaveLength(0);
		expect(result.rejected).toBe(1);
	});

	it("rejects unknown support ids", () => {
		expect(normalizeSupportingObservationIds(["deadbeefdead"], ["abc123abc123"])).toBeUndefined();
	});

	it("accepts a single-line reflection supported by known observations", () => {
		const result = parseReflections(
			{ reflections: [{ content: "User prefers pnpm.", supportingObservationIds: ["abc123abc123"] }] },
			["abc123abc123"],
		);
		expect(result.reflections).toHaveLength(1);
		expect(result.reflections[0].content).toBe("User prefers pnpm.");
	});
});

describe("dropper selection", () => {
	it("keeps model order, dedupes, and respects the cap", () => {
		expect(selectDropCandidates(["b", "a", "b", "c"], ["a", "b", "c"], 2)).toEqual(["b", "a"]);
	});
	it("ignores ids outside the active pool", () => {
		expect(selectDropCandidates(["ghost"], ["a"], 5)).toEqual([]);
	});
	it("returns nothing when no drops are allowed", () => {
		expect(selectDropCandidates(["a"], ["a"], 0)).toEqual([]);
	});
	it("parses the JSON contract", () => {
		expect(parseDropIds({ ids: ["a", "zzz"] }, ["a"], 3)).toEqual({ ids: ["a"], requested: 2 });
	});
	it("sizes the drop budget from pool fullness", () => {
		const observations = [observation({ tokenCount: 100 }), observation({ content: "other", tokenCount: 100 })];
		expect(maxDropCountForPool(observations, 200, 100)).toBeGreaterThan(0);
		expect(observationPoolMetrics(observations, 1000).overTarget).toBe(false);
		expect(observationPoolMetrics(observations, 10).ready).toBe(true);
	});
});

describe("coverage tiers", () => {
	it("maps support counts to tiers", () => {
		expect(reflectionCoverageTierForCount(0)).toBe("none");
		expect(reflectionCoverageTierForCount(1)).toBe("partial");
		expect(reflectionCoverageTierForCount(2)).toBe("strong");
	});
	it("counts a reflection once per observation id", () => {
		const observations = [observation({ id: "aaaaaaaaaaaa" })];
		const reflections = [reflection({ supportingObservationIds: ["aaaaaaaaaaaa", "aaaaaaaaaaaa"] })];
		expect(reflectionCoverageMap(observations, reflections).get("aaaaaaaaaaaa")).toBe("partial");
	});
});

describe("summary budget", () => {
	it("renders newest records and reports omissions", () => {
		const observations = Array.from({ length: 50 }, (_, index) =>
			observation({ id: hashId(`obs-${index}`), content: `observation ${index} ${"x".repeat(200)}` }),
		);
		const rendered = renderSummaryWithBudget([], observations, { maxTokens: 600 });
		expect(rendered.observations.length).toBeGreaterThan(0);
		expect(rendered.observations.length).toBeLessThan(observations.length);
		expect(rendered.omittedObservations).toBeGreaterThan(0);
		expect(rendered.text).toContain("omitted to fit the summary budget");
		expect(rendered.observations.at(-1)?.content).toContain("observation 49");
	});
	it("renders an empty string when there is no memory", () => {
		expect(renderSummaryWithBudget([], [], {}).text).toBe("");
	});
	it("keeps a long newest observation from hiding shorter ones", () => {
		const observations = [
			observation({ id: hashId("small"), content: "small" }),
			observation({ id: hashId("huge"), content: "y".repeat(10_000) }),
		];
		const rendered = renderSummaryWithBudget([], observations, { maxTokens: 500 });
		expect(rendered.observations.map(observationToSummaryLine)).toHaveLength(1);
		expect(rendered.observations[0].content).toBe("small");
	});
});

describe("config", () => {
	it("parses model refs", () => {
		expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
		expect(parseModelRef("opencode/gpt-5.1#high")).toEqual({ provider: "opencode", id: "gpt-5.1", variant: "high" });
		expect(parseModelRef("nope")).toBeUndefined();
		expect(formatModelRef({ provider: "a", id: "b" })).toBe("a/b");
	});
	it("prefers env over plugin options", () => {
		const config = resolveConfig({
			options: { observeAfterTokens: 111 },
			env: { OM_OBSERVE_AFTER_TOKENS: "222" },
		});
		expect(config.observeAfterTokens).toBe(222);
	});
	it("derives the pool target from the pool max when unset", () => {
		const config = resolveConfig({ options: { observationsPoolMaxTokens: 8000 }, env: {} });
		expect(config.observationsPoolTargetTokens).toBe(4000);
	});
	it("never lets the target exceed the max", () => {
		const config = resolveConfig({ options: { observationsPoolMaxTokens: 100, observationsPoolTargetTokens: 900 }, env: {} });
		expect(config.observationsPoolTargetTokens).toBe(100);
	});
	it("defaults to active mode with injection on", () => {
		const config = resolveConfig({ env: {} });
		expect(config.passive).toBe(false);
		expect(config.injectMemory).toBe(true);
	});
});

describe("transcript", () => {
	it("serializes user, assistant and system messages and skips idles", () => {
		const { entries, contextTokens } = entriesFromSessionMessages([
			{ id: "u1", type: "user", time: { created: 1 }, text: "hello" },
			{ id: "a1", type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "hi" }], tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } },
			{ id: "i1", type: "idle", time: { created: 3 }, outcome: "succeeded" },
		]);
		expect(entries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
		expect(contextTokens).toBe(15);
	});
	it("always includes at least one entry when slicing", () => {
		const entries = [
			{ id: "a", role: "user", text: "a".repeat(400), timestampMs: 0, tokens: 100, kind: "user" as const },
			{ id: "b", role: "user", text: "b", timestampMs: 0, tokens: 100, kind: "user" as const },
		];
		const slice = sliceEntries(entries, 0, 1);
		expect(slice.entries).toHaveLength(1);
		expect(slice.lastId).toBe("a");
	});
	it("counts tokens after an index", () => {
		const entries = [
			{ id: "a", role: "user", text: "a", timestampMs: 0, tokens: 10, kind: "user" as const },
			{ id: "b", role: "user", text: "b", timestampMs: 0, tokens: 20, kind: "user" as const },
		];
		expect(tokensAfter(entries, 0)).toBe(20);
		expect(tokensAfter(entries, -1)).toBe(30);
	});
});
