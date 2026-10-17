import type { Config } from "./config.js";

/**
 * Budget resolution. Constants mirror pi-observational-memory's config module so
 * memory sizing behaves the same at the same settings; the context window is
 * reported by OpenCode's model list when available.
 */

export const COMPACTION_RETAINED_FALLBACK_MAX_TOKENS = 60_000;
export const COMPACTION_RETAINED_CONTEXT_RATIO = 0.5;

export const COMPACTION_SUMMARY_FALLBACK_MAX_TOKENS = 8_000;
export const COMPACTION_SUMMARY_CONTEXT_RATIO = 0.125;

export const WORKER_MEMORY_FALLBACK_MAX_TOKENS = 16_000;
export const WORKER_MEMORY_CONTEXT_RATIO = 0.25;

export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;
export const OBSERVER_CHUNK_MIN_TOKENS = 256;
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

function ratio(value: number, contextWindow: number | undefined, fallback: number): number {
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * value));
	}
	return fallback;
}

/**
 * Source tokens after the last compaction boundary before the proactive
 * compaction request fires.
 */
export function resolveCompactAfterTokens(config: Config, contextWindow: number | undefined): number {
	if (config.compactAfterTokensMode === "calibrated" && typeof contextWindow === "number" && contextWindow > 0) {
		return Math.max(config.compactAfterTokens, Math.floor(contextWindow * config.compactAfterTokensRatio));
	}
	return config.compactAfterTokens;
}

export function resolveCompactionMaxRetainedTokens(config: Config, contextWindow: number | undefined): number {
	if (config.compactionMaxRetainedTokens !== undefined && config.compactionMaxRetainedTokens > 0) return config.compactionMaxRetainedTokens;
	return ratio(COMPACTION_RETAINED_CONTEXT_RATIO, contextWindow, COMPACTION_RETAINED_FALLBACK_MAX_TOKENS);
}

export function resolveCompactionSummaryMaxTokens(config: Config, contextWindow: number | undefined): number | undefined {
	if (config.compactionSummaryMaxTokens !== undefined && config.compactionSummaryMaxTokens > 0) return config.compactionSummaryMaxTokens;
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return ratio(COMPACTION_SUMMARY_CONTEXT_RATIO, contextWindow, COMPACTION_SUMMARY_FALLBACK_MAX_TOKENS);
	}
	return undefined;
}

export function resolveWorkerMemoryMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.workerMemoryMaxTokens !== undefined && config.workerMemoryMaxTokens > 0) return config.workerMemoryMaxTokens;
	return ratio(WORKER_MEMORY_CONTEXT_RATIO, contextWindow, WORKER_MEMORY_FALLBACK_MAX_TOKENS);
}

export function resolveObserverChunkMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, ratio(OBSERVER_CHUNK_CONTEXT_RATIO, contextWindow, OBSERVER_CHUNK_FALLBACK_MAX_TOKENS));
	}
	return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}
