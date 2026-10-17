import { describe, expect, it } from "vitest";
import { handleCompaction } from "../src/hooks/compaction.js";
import { resolveConfig, type Config } from "../src/config.js";
import type { Logger } from "../src/log.js";
import type { MemoryRuntime } from "../src/memory.js";
import { emptyMemoryState, type MemoryState, type Observation } from "../src/types.js";
import type { SourceEntry } from "../src/transcript.js";

/**
 * The compaction handler carries the fixed behaviour this port exists to keep:
 * never discard unobserved context, and never hand OpenCode an empty summary.
 */

const entry = (id: string, tokens = 100): SourceEntry => ({
	id,
	role: "user",
	text: "x".repeat(tokens * 4),
	timestampMs: 0,
	tokens,
	kind: "user",
});

function logger(): Logger & { lines: string[] } {
	const lines: string[] = [];
	const push = (message: string) => {
		lines.push(message);
	};
	return { debug: push, warn: push, error: push, recent: () => lines, lines };
}

type FakeOptions = {
	state?: Partial<MemoryState>;
	entries?: SourceEntry[];
	/** Observation runs hand the runtime this many newly covered tokens. */
	observeCovers?: number;
	observeThrows?: boolean;
};

function fakeRuntime(options: FakeOptions = {}) {
	const state: MemoryState = { ...emptyMemoryState("ses_test"), ...options.state };
	let entries = options.entries ?? [];
	const observed: unknown[] = [];
	let compactionRecorded = false;
	let lastObservedThrough: string | null = state.observedThrough ?? null;

	const runtime = {
		async load() {
			return state;
		},
		async resolveContextWindow() {
			return 200_000;
		},
		async unobservedTokenCount() {
			const index = lastObservedThrough ? entries.findIndex((candidate) => candidate.id === lastObservedThrough) : -1;
			return entries.slice(index + 1).reduce((sum, candidate) => sum + candidate.tokens, 0);
		},
		async observe(_sessionID: string, observeOptions: { maxChunks?: number }) {
			observed.push(observeOptions);
			if (options.observeThrows) throw new Error("worker exploded");
			const target = options.observeCovers ?? 0;
			if (target > 0) {
				const last = entries[entries.length - 1];
				if (last) lastObservedThrough = last.id;
			}
			return { ran: true, added: 1 };
		},
		hasMemory(candidate: MemoryState) {
			return candidate.observations.length > 0 || candidate.reflections.length > 0;
		},
		renderCompactionSummary(candidate: MemoryState) {
			return `SUMMARY(${candidate.observations.length})`;
		},
		async recordCompaction() {
			compactionRecorded = true;
		},
	};
	return {
		runtime: runtime as unknown as MemoryRuntime,
		state,
		observed,
		get compactionRecorded() {
			return compactionRecorded;
		},
		setEntries(next: SourceEntry[]) {
			entries = next;
		},
	};
}

const observation = (content: string): Observation => ({
	id: content.padEnd(12, "0").slice(0, 12),
	content,
	timestamp: "2026-10-16 12:00",
	relevance: "high",
	sourceEntryIds: ["m1"],
	tokenCount: 12,
});

function config(overrides: Record<string, unknown> = {}): Config {
	return { ...resolveConfig({ env: {} }), ...overrides };
}

describe("compaction handler", () => {
	it("supplies a summary from memory when coverage reaches the end", async () => {
		// Coverage marker m1 leaves m2 uncovered, and the catch-up covers it.
		const audit = fakeRuntime({
			state: { observations: [observation("observed fact")], observedThrough: "m1" },
			entries: [entry("m1"), entry("m2")],
			observeCovers: 1,
		});
		let result: { summary: string } | undefined;
		const outcome = await handleCompaction(
			{ runtime: audit.runtime, config: config(), logger: logger() },
			{ sessionID: "ses_test", setResult: (value) => { result = value; } },
		);
		expect(outcome).toBe("supplied");
		expect(result?.summary).toBe("SUMMARY(1)");
		expect(audit.compactionRecorded).toBe(true);
	});

	it("declines when the unobserved gap exceeds the retained budget", async () => {
		const fake = fakeRuntime({
			state: { observations: [observation("observed fact")], observedThrough: "m1" },
			entries: [entry("m1"), entry("m2", 5_000), entry("m3", 5_000)],
		});
		let result: { summary: string } | undefined;
		const outcome = await handleCompaction(
			{ runtime: fake.runtime, config: config({ compactionMaxRetainedTokens: 1_000 }), logger: logger() },
			{ sessionID: "ses_test", setResult: (value) => { result = value; } },
		);
		expect(outcome).toBe("declined_gap");
		expect(result).toBeUndefined();
		expect(fake.compactionRecorded).toBe(false);
	});

	it("declines when there is no memory yet", async () => {
		const fake = fakeRuntime({ entries: [entry("m1")] });
		let result: { summary: string } | undefined;
		const outcome = await handleCompaction(
			{ runtime: fake.runtime, config: config(), logger: logger() },
			{ sessionID: "ses_test", setResult: (value) => { result = value; } },
		);
		expect(outcome).toBe("declined_empty");
		expect(result).toBeUndefined();
	});

	it("never breaks compaction when a stage throws", async () => {
		const fake = fakeRuntime({
			state: { observations: [observation("observed fact")], observedThrough: "m1" },
			entries: [entry("m1"), entry("m2")],
			observeThrows: true,
		});
		let result: { summary: string } | undefined;
		const outcome = await handleCompaction(
			{ runtime: fake.runtime, config: config(), logger: logger() },
			{ sessionID: "ses_test", setResult: (value) => { result = value; } },
		);
		expect(outcome).toBe("failed");
		expect(result).toBeUndefined();
	});

	it("does nothing in passive mode", async () => {
		const fake = fakeRuntime({ state: { observations: [observation("observed fact")] } });
		const outcome = await handleCompaction(
			{ runtime: fake.runtime, config: config({ passive: true }), logger: logger() },
			{ sessionID: "ses_test", setResult: () => undefined },
		);
		expect(outcome).toBe("passive");
		expect(fake.observed).toHaveLength(0);
	});
});
