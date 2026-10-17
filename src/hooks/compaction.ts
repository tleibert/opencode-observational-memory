import { resolveCompactionMaxRetainedTokens } from "../budgets.js";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { MemoryRuntime } from "../memory.js";
import { describeError } from "../transport.js";

/**
 * Compaction handler.
 *
 * Pi's `session_before_compact` hook could move the retention boundary
 * (`firstKeptEntryId`) back to keep unobserved entries. OpenCode does not expose
 * a retention boundary to plugins, so this port keeps the same guarantee a
 * different way:
 *
 *  1. Observe the uncovered gap synchronously (bounded by
 *     `compactionCatchUpMaxChunks`), starting at the global coverage frontier.
 *  2. If unobserved source still exceeds the retained budget, DECLINE ownership
 *     so OpenCode's native summarizer runs over the raw transcript. Nothing is
 *     lost that memory cannot represent.
 *  3. Otherwise supply the summary ourselves from the memory ledger, which
 *     skips the summarizer model call entirely.
 *
 * That mirrors pi-observational-memory's "retain, catch up, or delegate" rule.
 */

export type CompactionEvent = {
	sessionID: string;
	/** Assign the summary OpenCode should persist instead of summarizing again. */
	setResult: (result: { summary: string }) => void;
};

export type CompactionOutcome = "supplied" | "declined_gap" | "declined_empty" | "passive" | "failed";

export type CompactionDeps = {
	runtime: MemoryRuntime;
	config: Config;
	logger: Logger;
};

export async function handleCompaction(deps: CompactionDeps, event: CompactionEvent): Promise<CompactionOutcome> {
	const { runtime, config, logger } = deps;
	const sessionID = event.sessionID;
	try {
		if (config.passive) return "passive";
		const state = await runtime.load(sessionID);
		const contextWindow = await runtime.resolveContextWindow(sessionID);

		const gapBefore = await runtime.unobservedTokenCount(sessionID, state);
		if (gapBefore > 0) {
			const outcome = await runtime.observe(sessionID, {
				force: true,
				maxChunks: config.compactionCatchUpMaxChunks,
				allowCompactionRequest: false,
				reason: "compaction",
			});
			logger.debug("compaction catch-up", { sessionID, gapBefore, outcome });
		}

		const remaining = await runtime.unobservedTokenCount(sessionID, state);
		const retainedBudget = resolveCompactionMaxRetainedTokens(config, contextWindow);
		if (remaining > retainedBudget) {
			logger.debug("declined compaction summary: unobserved gap too large", { sessionID, remaining, retainedBudget });
			return "declined_gap";
		}
		if (!runtime.hasMemory(state)) {
			logger.debug("declined compaction summary: no memory yet", { sessionID });
			return "declined_empty";
		}

		const summary = runtime.renderCompactionSummary(state, contextWindow);
		if (!summary.trim()) {
			logger.debug("declined compaction summary: rendered summary empty", { sessionID });
			return "declined_empty";
		}
		event.setResult({ summary });
		await runtime.recordCompaction(sessionID, state);
		logger.debug("supplied compaction summary", {
			sessionID,
			observations: state.observations.length,
			reflections: state.reflections.length,
			summaryTokens: Math.ceil(summary.length / 4),
		});
		return "supplied";
	} catch (error) {
		// Never break compaction: fall back to OpenCode's own summary.
		logger.warn("compaction hook failed", describeError(error));
		return "failed";
	}
}
