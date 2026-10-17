/**
 * Configuration.
 *
 * Defaults and setting names mirror pi-observational-memory's config surface so
 * the two ports stay recognisable to each other. Pi reads settings from Pi's
 * config files; here the same values come from the plugin `options` object in
 * `opencode.json(c)` and/or `OM_*` environment variables (environment wins).
 */

export type ConfiguredModel = {
	provider: string;
	id: string;
	variant?: string;
};

export type CompactAfterTokensMode = "calibrated" | "fixed";

export type Config = {
	/**
	 * Estimated source tokens since the observer coverage marker before a new
	 * observation run is due.
	 */
	observeAfterTokens: number;
	/** Estimated observed tokens since the reflector marker before reflection is due. */
	reflectAfterTokens: number;
	/** Source tokens after the last compaction boundary before compaction is requested. */
	compactAfterTokens: number;
	/**
	 * `calibrated` scales {@link compactAfterTokens} by the model's context
	 * growth ratio; `fixed` uses the raw value.
	 */
	compactAfterTokensMode: CompactAfterTokensMode;
	compactAfterTokensRatio: number;
	/** Hard cap for the active observation pool; pruning starts above it. */
	observationsPoolMaxTokens: number;
	/** Soft target the dropper prunes toward. */
	observationsPoolTargetTokens: number;
	/** Token budget for one rendered memory summary (compaction payload). */
	compactionSummaryMaxTokens?: number;
	/** Max source tokens retained past the compaction cut when coverage lags. */
	compactionMaxRetainedTokens?: number;
	/** Max synchronous catch-up observation chunks inside a compaction. */
	compactionCatchUpMaxChunks: number;
	/** Max tokens of memory injected into the system prompt on each request. */
	workerMemoryMaxTokens?: number;
	/** Worker output budget hint (JSON-mode workers rely on the prompt contract). */
	agentMaxTokens: number;
	/** Memory worker model. When omitted OpenCode's default model is used. */
	model?: ConfiguredModel;
	/** Second memory worker used when the primary model fails or is unavailable. */
	fallbackModel?: ConfiguredModel;
	/**
	 * Allow memory workers to fall back to a *paid* model when the session model
	 * and every free model the host offers are unusable for plugin calls.
	 * Off by default: background work should never spend money unasked.
	 */
	allowPaidWorkerModel: boolean;
	/** Run consolidation (observe/reflect) when an assistant turn settles. */
	consolidateWhenIdle: boolean;
	/**
	 * Observe uncovered transcript synchronously before an agent-loop request.
	 * Off by default: background consolidation keeps memory work off the critical
	 * path, and the compaction hook already awaits a bounded catch-up. Enable it
	 * for scripted/headless runs where background work may be cut short.
	 */
	observeBeforeRequest: boolean;
	/** Observe only; never write compaction summaries or inject memory. */
	passive: boolean;
	/** Append the assembled memory block to the system prompt of every request. */
	injectMemory: boolean;
	/** Write a debug log to the OpenCode data directory. */
	debugLog: boolean;
	/** Absolute path for the debug log. */
	debugLogPath?: string;
};

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
	compactAfterTokensMode: "calibrated",
	compactAfterTokensRatio: 0.68,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	compactionCatchUpMaxChunks: 2,
	agentMaxTokens: 32_000,
	allowPaidWorkerModel: false,
	consolidateWhenIdle: true,
	observeBeforeRequest: false,
	passive: false,
	injectMemory: true,
	debugLog: false,
};

function readNumber(value: unknown, fallback: number): number {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
		if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
	}
	return fallback;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Parse `provider/id` (and optional `#variant`) into a model reference. */
export function parseModelRef(value: unknown): ConfiguredModel | undefined {
	const raw = readString(value);
	if (!raw) return undefined;
	const [ref, variant] = raw.split("#");
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) };
}

export function formatModelRef(model: ConfiguredModel | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.max(0, Math.floor(maxTokens / 2));
}

export type ResolveConfigInput = {
	options?: Record<string, unknown>;
	env?: Record<string, string | undefined>;
};

export function resolveConfig(input: ResolveConfigInput = {}): Config {
	const options = input.options ?? {};
	const env = input.env ?? process.env;
	const pick = (key: string, envKey: string): unknown => env[envKey] ?? options[key];

	const observationsPoolMaxTokens = readNumber(pick("observationsPoolMaxTokens", "OM_OBSERVATIONS_POOL_MAX_TOKENS"), DEFAULTS.observationsPoolMaxTokens);
	const configuredTarget = pick("observationsPoolTargetTokens", "OM_OBSERVATIONS_POOL_TARGET_TOKENS");
	const observationsPoolTargetTokens =
		configuredTarget === undefined
			? derivedObservationPoolTarget(observationsPoolMaxTokens)
			: Math.min(readNumber(configuredTarget, derivedObservationPoolTarget(observationsPoolMaxTokens)), observationsPoolMaxTokens);

	const mode = readString(pick("compactAfterTokensMode", "OM_COMPACT_AFTER_TOKENS_MODE"));

	return {
		observeAfterTokens: readNumber(pick("observeAfterTokens", "OM_OBSERVE_AFTER_TOKENS"), DEFAULTS.observeAfterTokens),
		reflectAfterTokens: readNumber(pick("reflectAfterTokens", "OM_REFLECT_AFTER_TOKENS"), DEFAULTS.reflectAfterTokens),
		compactAfterTokens: readNumber(pick("compactAfterTokens", "OM_COMPACT_AFTER_TOKENS"), DEFAULTS.compactAfterTokens),
		compactAfterTokensMode: mode === "fixed" || mode === "calibrated" ? mode : DEFAULTS.compactAfterTokensMode,
		compactAfterTokensRatio: readNumber(pick("compactAfterTokensRatio", "OM_COMPACT_AFTER_TOKENS_RATIO"), DEFAULTS.compactAfterTokensRatio),
		observationsPoolMaxTokens,
		observationsPoolTargetTokens,
		compactionSummaryMaxTokens: optionalNumber(pick("compactionSummaryMaxTokens", "OM_COMPACTION_SUMMARY_MAX_TOKENS")),
		compactionMaxRetainedTokens: optionalNumber(pick("compactionMaxRetainedTokens", "OM_COMPACTION_MAX_RETAINED_TOKENS")),
		compactionCatchUpMaxChunks: readNumber(pick("compactionCatchUpMaxChunks", "OM_COMPACTION_CATCH_UP_MAX_CHUNKS"), DEFAULTS.compactionCatchUpMaxChunks),
		workerMemoryMaxTokens: optionalNumber(pick("workerMemoryMaxTokens", "OM_WORKER_MEMORY_MAX_TOKENS")),
		agentMaxTokens: readNumber(pick("agentMaxTokens", "OM_AGENT_MAX_TOKENS"), DEFAULTS.agentMaxTokens),
		model: parseModelRef(pick("model", "OM_MODEL")) ?? DEFAULTS.model,
		fallbackModel: parseModelRef(pick("fallbackModel", "OM_FALLBACK_MODEL")) ?? DEFAULTS.fallbackModel,
		allowPaidWorkerModel: readBoolean(pick("allowPaidWorkerModel", "OM_ALLOW_PAID_WORKER_MODEL"), DEFAULTS.allowPaidWorkerModel),
		consolidateWhenIdle: readBoolean(pick("consolidateWhenIdle", "OM_CONSOLIDATE_WHEN_IDLE"), DEFAULTS.consolidateWhenIdle),
		observeBeforeRequest: readBoolean(pick("observeBeforeRequest", "OM_OBSERVE_BEFORE_REQUEST"), DEFAULTS.observeBeforeRequest),
		passive: readBoolean(pick("passive", "OM_PASSIVE"), DEFAULTS.passive),
		injectMemory: readBoolean(pick("injectMemory", "OM_INJECT_MEMORY"), DEFAULTS.injectMemory),
		debugLog: readBoolean(pick("debugLog", "OM_DEBUG_LOG"), DEFAULTS.debugLog),
		debugLogPath: readString(pick("debugLogPath", "OM_DEBUG_LOG_PATH")),
	};
}

function optionalNumber(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}
