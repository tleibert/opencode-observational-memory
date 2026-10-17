import { MEMORY_NOTICE_PREFIX } from "../src/memory.js";
import { describe, expect, it } from "vitest";
import { classifyWorkerError, isFreeModel, orderModelCandidates, WorkerModelSelector } from "../src/models.js";
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

describe("worker model selection", () => {
	it("classifies gated failures as permanent", () => {
		const gated = classifyWorkerError(new Error("Generate.UnavailableError: OpenCode's free tier can only be used from within OpenCode."));
		expect(gated.kind).toBe("gated");
		expect(classifyWorkerError(new Error("Upstream request failed: [model_coming_soon] This model is coming soon")).kind).toBe("gated");
		expect(classifyWorkerError(new Error("Generate.UnavailableError: Timed out waiting for response headers")).kind).toBe("transient");
		expect(classifyWorkerError(new Error("boom")).kind).toBe("unknown");
	});

	it("treats only all-zero priced models as free", () => {
		expect(isFreeModel([{ input: 0, output: 0 }])).toBe(true);
		expect(isFreeModel([{ input: 0.3, output: 1.2 }])).toBe(false);
		expect(isFreeModel([])).toBe(false);
		expect(isFreeModel(undefined)).toBe(false);
		// A tiered model with a free tier is still paid overall.
		expect(isFreeModel([{ input: 0, output: 0 }, { input: 1, output: 2 }])).toBe(false);
	});

	it("orders candidates: session provider first, free before paid, gated ids excluded", () => {
		const listing = [
			{ providerID: "zen", id: "gated-free", cost: [{ input: 0, output: 0 }], limit: { context: 1_000_000 } },
			{ providerID: "zen", id: "paid", cost: [{ input: 1, output: 2 }] },
			{ providerID: "opencode-go", id: "free-same-provider", modelID: "free-same-provider", cost: [{ input: 0, output: 0 }] },
			{ providerID: "opencode-go", id: "paid-same-provider", cost: [{ input: 0.3, output: 1.2 }] },
			{ providerID: "other", id: "disabled-free", cost: [{ input: 0, output: 0 }], enabled: false },
			{ providerID: "other", id: "deprecated-free", cost: [{ input: 0, output: 0 }], status: "deprecated" },
		];
		const free = orderModelCandidates(listing, { sessionProvider: "opencode-go", allowPaid: false });
		expect(free.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"opencode-go/free-same-provider",
			"zen/gated-free",
		]);
		const withPaid = orderModelCandidates(listing, {
			sessionProvider: "opencode-go",
			allowPaid: true,
			exclude: ["zen/gated-free"],
		});
		expect(withPaid.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"opencode-go/free-same-provider",
			"opencode-go/paid-same-provider",
			"zen/paid",
		]);
	});
});

/** Silent logger: the selector only logs diagnostics. */
function logger(): never {
	const noop = () => undefined;
	return { debug: noop, warn: noop, error: noop, recent: () => [], path: undefined } as never;
}

describe("worker model selector", () => {
	const listing = {
		data: [
			{ providerID: "zen", id: "free-a", cost: [{ input: 0, output: 0 }] },
			{ providerID: "zen", id: "free-b", cost: [{ input: 0, output: 0 }] },
			{ providerID: "go", id: "free-c", cost: [{ input: 0, output: 0 }] },
			{ providerID: "go", id: "paid-d", cost: [{ input: 0.3, output: 1.2 }] },
		],
	};

	function ctx(sessionModel: { providerID: string; id: string } | undefined) {
		return {
			session: { get: async () => ({ model: sessionModel }) },
			model: { list: async () => listing },
		} as never;
	}

	it("walks from the session model to a working free model, skipping the gated provider", async () => {
		const config = { ...resolveConfig({ env: {} }) };
		const selector = new WorkerModelSelector(ctx({ providerID: "zen", id: "free-a" }), config as never, logger());
		const first = await selector.pick("ses_1", []);
		expect(first && `${first.provider}/${first.id}`).toBe("zen/free-a");

		// The host refuses the whole zen free tier for plugin calls.
		selector.noteFailure(first, new Error("Generate.UnavailableError: OpenCode's free tier can only be used from within OpenCode."));

		const second = await selector.pick("ses_1", [first as never]);
		expect(second && `${second.provider}/${second.id}`).toBe("go/free-c");

		// A working model is remembered for the session.
		selector.noteSuccess(second, "ses_1");
		expect(selector.chosen("ses_1")).toEqual(second);
		expect(selector.freeGatedProviders()).toEqual(["zen"]);
	});

	it("never proposes a paid model unless explicitly allowed", async () => {
		const passive = new WorkerModelSelector(
			ctx({ providerID: "zen", id: "free-a" }),
			resolveConfig({ env: {} }) as never,
			logger(),
		);
		const seen = await passive.candidates("ses_2");
		expect(seen.some((model) => model.id === "paid-d")).toBe(false);

		const paid = new WorkerModelSelector(
			ctx({ providerID: "zen", id: "free-a" }),
			resolveConfig({ options: { allowPaidWorkerModel: true }, env: {} }) as never,
			logger(),
		);
		const withPaid = await paid.candidates("ses_2");
		expect(withPaid.at(-1)?.id).toBe("paid-d");
	});

	it("always honours an explicit configured model first", async () => {
		const selector = new WorkerModelSelector(
			ctx({ providerID: "zen", id: "free-a" }),
			resolveConfig({ options: { model: "go/paid-d" }, env: {} }) as never,
			logger(),
		);
		const first = await selector.pick("ses_3", []);
		expect(first && `${first.provider}/${first.id}`).toBe("go/paid-d");
	});
});


describe("memory notices", () => {
	it("marks notices with a prefix so memory never observes its own activity", () => {
		expect(MEMORY_NOTICE_PREFIX).toBe("🧠 memory: ");
	});

	it("drops notice messages from the transcript while keeping real system messages", async () => {
		const { entriesFromSessionMessages } = await import("../src/transcript.js");
		const messages = [
			{ id: "msg_notice", type: "synthetic", time: { created: 1_700_000_000_000 }, text: `${MEMORY_NOTICE_PREFIX}+3 observations` },
			{ id: "msg_sys", type: "synthetic", time: { created: 1_700_000_001_000 }, text: "Keep going, 3 steps remain." },
			{ id: "msg_user", type: "user", time: { created: 1_700_000_002_000 }, text: "hello" },
		];
		const { entries } = entriesFromSessionMessages(messages as never);
		expect(entries.map((entry) => entry.id)).toEqual(["msg_sys", "msg_user"]);
	});
});
