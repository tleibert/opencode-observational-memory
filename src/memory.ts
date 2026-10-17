import { renderDropperLines, runDropper } from "./agents/dropper.js";
import { observationLineForReflector, runReflector } from "./agents/reflector.js";
import { runObserver } from "./agents/observer.js";
import {
	resolveCompactAfterTokens,
	resolveCompactionSummaryMaxTokens,
	resolveObserverChunkMaxTokens,
	resolveWorkerMemoryMaxTokens,
} from "./budgets.js";
import type { Config } from "./config.js";
import { reflectionCoverageMap } from "./coverage.js";
import type { PluginContext } from "./host-types.js";
import type { Logger } from "./log.js";
import { observationPoolMetrics } from "./pool.js";
import { renderSummaryWithBudget } from "./summary.js";
import {
	entriesFromSessionMessages,
	indexOfEntry,
	renderChunk,
	sliceEntries,
	tokensBetween,
	tokensAfter,
	type SourceEntry,
} from "./transcript.js";
import { WorkerAbortedError } from "./transport.js";
import type { WorkerInvoker } from "./transport.js";
import { describeError } from "./transport.js";
import { emptyMemoryState, isMemoryState, type MemoryState, type Observation } from "./types.js";

/**
 * Memory orchestration.
 *
 * Pi keeps the ledger inside the session as custom entries; OpenCode has no
 * equivalent write path for a plugin, so the ledger lives in plugin storage
 * keyed by session id. Coverage markers therefore name OpenCode message ids,
 * which is also what workers cite as `sourceEntryIds`.
 */

export type StageOutcome = {
	ran: boolean;
	reason?: string;
	added?: number;
	rejected?: number;
	duplicates?: number;
	error?: string;
	stoppedBecause?: "max_chunks" | "empty" | "error" | "aborted";
};

export type ConsolidateReport = {
	observed: StageOutcome;
	reflected: StageOutcome;
	dropped: StageOutcome;
};

export type ConsolidateOptions = {
	/** Force worker runs regardless of thresholds (used by the compaction hook). */
	force?: boolean;
	maxChunks?: number;
	signal?: AbortSignal;
	allowCompactionRequest?: boolean;
	reason?: string;
};

const STORAGE_PREFIX = "memory/";

export class MemoryRuntime {
	private readonly states = new Map<string, MemoryState>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly notices = new Map<string, string[]>();
	private workerCalls = 0;

	constructor(
		private readonly ctx: PluginContext,
		private readonly config: Config,
		private readonly logger: Logger,
		private readonly invoker: WorkerInvoker,
	) {}

	// ---------------------------------------------------------------- storage

	async load(sessionID: string): Promise<MemoryState> {
		const cached = this.states.get(sessionID);
		if (cached) return cached;
		let state: MemoryState | undefined;
		try {
			const stored = await this.ctx.storage.get(`${STORAGE_PREFIX}${sessionID}`);
			if (isMemoryState(stored)) state = stored;
		} catch (error) {
			this.logger.warn("failed to read memory state", describeError(error));
		}
		const resolved = state ?? emptyMemoryState(sessionID);
		this.states.set(sessionID, resolved);
		return resolved;
	}

	async save(state: MemoryState): Promise<void> {
		state.updatedAt = Date.now();
		this.states.set(state.sessionID, state);
		try {
			await this.ctx.storage.set(`${STORAGE_PREFIX}${state.sessionID}`, state as never);
		} catch (error) {
			this.logger.warn("failed to persist memory state", describeError(error));
		}
	}

	async reset(sessionID: string): Promise<void> {
		this.states.delete(sessionID);
		try {
			await this.ctx.storage.remove(`${STORAGE_PREFIX}${sessionID}`);
		} catch (error) {
			this.logger.warn("failed to remove memory state", describeError(error));
		}
	}

	/** True while a memory worker call is in flight (used to keep injected memory out of worker prompts). */
	isWorkerCallInFlight(): boolean {
		return this.workerCalls > 0;
	}

	// ------------------------------------------------------------- transcript

	async readTranscript(sessionID: string): Promise<{ entries: SourceEntry[]; contextTokens?: number }> {
		const messages = await this.ctx.session.context({ sessionID });
		return entriesFromSessionMessages(messages as readonly unknown[]);
	}

	async resolveContextWindow(sessionID: string): Promise<number | undefined> {
		try {
			const session = await this.ctx.session.get({ sessionID });
			const model = (session as { model?: { providerID?: string; id?: string } }).model;
			const listed = (await this.ctx.model.list()) as { data?: readonly Record<string, unknown>[] } | readonly Record<string, unknown>[];
			const models: readonly Record<string, unknown>[] = Array.isArray(listed) ? listed : ((listed as { data?: readonly Record<string, unknown>[] }).data ?? []);
			for (const candidate of models) {
				const providerID = (candidate.providerID ?? candidate.provider) as string | undefined;
				const id = (candidate.modelID ?? candidate.id) as string | undefined;
				if (model && (providerID !== model.providerID || id !== model.id)) continue;
				const limit = candidate.limit as { context?: unknown } | undefined;
				const window = limit?.context ?? candidate.contextWindow ?? candidate.context;
				if (typeof window === "number" && window > 0) return window;
			}
		} catch (error) {
			this.logger.debug("context window lookup failed", describeError(error));
		}
		return undefined;
	}

	// --------------------------------------------------------------- triggers

	/** Raw source tokens the observer has not covered yet. */
	unobservedTokens(entries: readonly SourceEntry[], state: MemoryState): number {
		return tokensAfter(entries, indexOfEntry(entries, state.observedThrough));
	}

	/** Source tokens observed since the reflector's coverage marker. */
	unreflectedTokens(entries: readonly SourceEntry[], state: MemoryState): number {
		return tokensBetween(entries, indexOfEntry(entries, state.reflectedThrough), indexOfEntry(entries, state.observedThrough));
	}

	/** Source tokens the observer covered since the last compaction snapshot. */
	observedTokensSinceCompaction(entries: readonly SourceEntry[], state: MemoryState): number {
		return tokensBetween(entries, indexOfEntry(entries, state.compactedThroughId ?? null), indexOfEntry(entries, state.observedThrough));
	}

	/**
	 * Uncovered source tokens for a session, read from the current transcript.
	 * Used by the compaction hook to decide whether memory can own the summary.
	 */
	async unobservedTokenCount(sessionID: string, state: MemoryState): Promise<number> {
		const { entries } = await this.readTranscript(sessionID);
		return this.unobservedTokens(entries, state);
	}

	/**
	 * Record that memory owned a compaction, and where source stood at that
	 * moment. Stands in for Pi's persisted `firstKeptEntryId` retention boundary.
	 */
	async recordCompaction(sessionID: string, state: MemoryState): Promise<void> {
		const { entries } = await this.readTranscript(sessionID);
		const newest = entries[entries.length - 1]?.id ?? state.observedThrough;
		state.compactedThroughId = newest ?? null;
		state.compactions.push({
			id: newest ?? null,
			at: Date.now(),
			observations: state.observations.length,
			reflections: state.reflections.length,
			fullFold: true,
		});
		await this.save(state);
	}

	observationDue(entries: readonly SourceEntry[], state: MemoryState): boolean {
		return this.unobservedTokens(entries, state) >= this.config.observeAfterTokens;
	}

	reflectionDue(entries: readonly SourceEntry[], state: MemoryState): boolean {
		return this.unreflectedTokens(entries, state) >= this.config.reflectAfterTokens;
	}

	dropDue(state: MemoryState): boolean {
		return observationPoolMetrics(state.observations, this.config.observationsPoolTargetTokens).ready;
	}

	async compactionDue(sessionID: string, state: MemoryState, entries: readonly SourceEntry[]): Promise<boolean> {
		const contextWindow = await this.resolveContextWindow(sessionID);
		const threshold = resolveCompactAfterTokens(this.config, contextWindow);
		return this.observedTokensSinceCompaction(entries, state) >= threshold;
	}

	// ----------------------------------------------------------------- stages

	/**
	 * Observe uncovered transcript, one chunk at a time. Mirrors
	 * pi-observational-memory's catch-up rule: the walk always starts at the
	 * global coverage frontier (the marker claims everything before it, so
	 * starting later would silently mark unread source as observed), and a
	 * chunk that fails or records nothing stops the walk without advancing.
	 */
	async observe(sessionID: string, options: ConsolidateOptions = {}): Promise<StageOutcome> {
		if (this.config.passive) return { ran: false, reason: "passive" };
		const state = await this.load(sessionID);
		const { entries, contextTokens } = await this.readTranscript(sessionID);
		const contextWindow = await this.resolveContextWindow(sessionID);
		const chunkTokens = resolveObserverChunkMaxTokens(this.config, contextWindow);
		const maxChunks = options.maxChunks ?? Number.POSITIVE_INFINITY;

		const coveredIndex = indexOfEntry(entries, state.observedThrough);
		const backlog = tokensAfter(entries, coveredIndex);
		if (!options.force && backlog < this.config.observeAfterTokens) {
			return { ran: false, reason: "below_threshold", added: 0 };
		}
		if (backlog <= 0) return { ran: false, reason: "covered", added: 0 };

		this.logger.debug("observer run", { sessionID, backlog, contextTokens, chunkTokens, maxChunks });
		let added = 0;
		let rejected = 0;
		let duplicates = 0;
		let chunks = 0;
		let cursor = coveredIndex + 1;

		while (chunks < maxChunks && cursor < entries.length) {
			const slice = sliceEntries(entries, cursor, chunkTokens);
			if (slice.entries.length === 0) break;
			const signal = options.signal ?? this.controllerFor(sessionID).signal;
			try {
				const knownIds = new Set<string>([
					...state.observations.map((observation) => observation.id),
					...state.reflections.map((reflection) => reflection.id),
				]);
				const result = await this.callWorker(
					() =>
						runObserver(this.invoker, {
							priorReflections: state.reflections.map((reflection) => `[${reflection.id}] ${reflection.content}`),
							priorObservations: state.observations.map(
								(observation) => `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
							),
							chunk: renderChunk(slice.entries),
							allowedSourceEntryIds: slice.entries.map((entry) => entry.id),
							knownIds,
							signal,
							sessionID,
						}),
					sessionID,
				);
				added += result.observations.length;
				rejected += result.rejected;
				duplicates += result.duplicates;
				if (result.observations.length > 0) {
					state.observations.push(...result.observations);
					this.pushNotice(sessionID, `+${result.observations.length} observations`);
				}
				// Advance coverage even for an empty chunk: the worker read it.
				if (slice.lastId) state.observedThrough = slice.lastId;
				state.stats.observerRuns++;
				await this.save(state);
				this.logger.debug("observer chunk recorded", {
					sessionID,
					chunk: chunks + 1,
					added: result.observations.length,
					rejected: result.rejected,
					duplicates: result.duplicates,
					activeObservations: state.observations.length,
					observedThrough: state.observedThrough,
				});
			} catch (error) {
				state.stats.failures++;
				this.noteFailure(sessionID);
				await this.save(state);
				if (error instanceof WorkerAbortedError) return { ran: chunks > 0, added, rejected, duplicates, stoppedBecause: "aborted" };
				this.logger.warn("observer stage failed", { sessionID, error: describeError(error) });
				return {
					ran: chunks > 0,
					added,
					rejected,
					duplicates,
					error: describeError(error),
					stoppedBecause: "error",
				};
			}
			chunks++;
			cursor = indexOfEntry(entries, state.observedThrough) + 1;
		}

		const remaining = tokensAfter(entries, indexOfEntry(entries, state.observedThrough));
		return {
			ran: true,
			added,
			rejected,
			duplicates,
			stoppedBecause: remaining > 0 && chunks >= maxChunks ? "max_chunks" : chunks === 0 ? "empty" : undefined,
		};
	}

	/** Distill durable reflections from observations the reflector has not reviewed. */
	async reflect(sessionID: string, options: ConsolidateOptions = {}): Promise<StageOutcome> {
		if (this.config.passive) return { ran: false, reason: "passive" };
		const state = await this.load(sessionID);
		const { entries } = await this.readTranscript(sessionID);
		const due = options.force || this.reflectionDue(entries, state);
		if (!due) return { ran: false, reason: "below_threshold" };
		if (state.observations.length === 0) return { ran: false, reason: "no_observations" };

		const coverage = reflectionCoverageMap(state.observations, state.reflections);
		const signal = options.signal ?? this.controllerFor(sessionID).signal;
		try {
			const result = await this.callWorker(
				() =>
					runReflector(this.invoker, {
						reflections: state.reflections.map((reflection) => `[${reflection.id}] ${reflection.content}`),
						observations: state.observations.map((observation) =>
							observationLineForReflector(observation, coverage.get(observation.id) ?? "none"),
						),
						allowedObservationIds: state.observations.map((observation) => observation.id),
						knownIds: new Set(state.reflections.map((reflection) => reflection.id)),
						signal,
						sessionID,
					}),
				sessionID,
			);
			if (result.reflections.length > 0) {
				state.reflections.push(...result.reflections);
				this.pushNotice(sessionID, `+${result.reflections.length} reflections`);
			}
			state.reflectedThrough = state.observedThrough;
			state.stats.reflectorRuns++;
			this.noteSuccess(sessionID);
			await this.save(state);
			return { ran: true, added: result.reflections.length, rejected: result.rejected, duplicates: result.duplicates };
		} catch (error) {
			state.stats.failures++;
			await this.save(state);
			if (error instanceof WorkerAbortedError) return { ran: false, stoppedBecause: "aborted" };
			this.logger.warn("reflector stage failed", { sessionID, error: describeError(error) });
			return { ran: false, error: describeError(error), stoppedBecause: "error" };
		}
	}

	/** Prune the observation pool toward its target, using reflection coverage as evidence. */
	async drop(sessionID: string, options: ConsolidateOptions = {}): Promise<StageOutcome> {
		if (this.config.passive) return { ran: false, reason: "passive" };
		const state = await this.load(sessionID);
		const metrics = observationPoolMetrics(state.observations, this.config.observationsPoolTargetTokens);
		if (!options.force && !metrics.ready) return { ran: false, reason: "below_target" };
		if (!metrics.overTarget || metrics.maxDropsAllowed <= 0) return { ran: false, reason: "within_target" };

		const signal = options.signal ?? this.controllerFor(sessionID).signal;
		try {
			const result = await this.callWorker(
				() =>
					runDropper(this.invoker, {
						reflections: state.reflections.map((reflection) => `[${reflection.id}] ${reflection.content}`),
						observations: renderDropperLines(state.observations, state.reflections),
						allowedObservationIds: state.observations.map((observation) => observation.id),
						maxDrops: metrics.maxDropsAllowed,
						targetTokens: this.config.observationsPoolTargetTokens,
						observationTokens: metrics.observationTokens,
						signal,
						sessionID,
					}),
				sessionID,
			);
			if (result.ids.length > 0) {
				const dropped = new Set(result.ids);
				state.observations = state.observations.filter((observation) => !dropped.has(observation.id));
				state.droppedObservationIds.push(...dropped);
				this.pushNotice(sessionID, `-${result.ids.length} observations`);
			}
			state.droppedThrough = state.observedThrough;
			state.stats.dropperRuns++;
			this.noteSuccess(sessionID);
			await this.save(state);
			return { ran: true, added: result.ids.length, rejected: Math.max(0, result.requested - result.ids.length) };
		} catch (error) {
			state.stats.failures++;
			await this.save(state);
			if (error instanceof WorkerAbortedError) return { ran: false, stoppedBecause: "aborted" };
			this.logger.warn("dropper stage failed", { sessionID, error: describeError(error) });
			return { ran: false, error: describeError(error), stoppedBecause: "error" };
		}
	}

	/** Observe → reflect → drop, in the order memory quality depends on. */
	async consolidate(sessionID: string, options: ConsolidateOptions = {}): Promise<ConsolidateReport> {
		const observed = await this.observe(sessionID, options);
		const reflected = await this.reflect(sessionID, options);
		const dropped = await this.drop(sessionID, options);

		if (options.allowCompactionRequest !== false) {
			try {
				const state = await this.load(sessionID);
				const { entries } = await this.readTranscript(sessionID);
				if (this.observedTokensSinceCompaction(entries, state) > 0 && (await this.compactionDue(sessionID, state, entries))) {
					this.logger.debug("requesting compaction", { sessionID });
					await this.ctx.session.compact({ sessionID });
				}
			} catch (error) {
				this.logger.debug("compaction request failed", describeError(error));
			}
		}

		return { observed, reflected, dropped };
	}

	// ------------------------------------------------------------------ output

	renderMemoryBlock(state: MemoryState, contextWindow: number | undefined): string {
		if (state.observations.length === 0 && state.reflections.length === 0) return "";
		const maxTokens = resolveWorkerMemoryMaxTokens(this.config, contextWindow);
		return renderSummaryWithBudget(state.reflections, state.observations, { maxTokens }).text;
	}

	renderCompactionSummary(state: MemoryState, contextWindow: number | undefined): string {
		const maxTokens = resolveCompactionSummaryMaxTokens(this.config, contextWindow);
		return renderSummaryWithBudget(state.reflections, state.observations, maxTokens ? { maxTokens } : {}).text;
	}

	hasMemory(state: MemoryState): boolean {
		return state.observations.length > 0 || state.reflections.length > 0;
	}

	/** Stop every in-flight memory worker (used when this instance is replaced). */
	abortAll(): void {
		for (const [sessionID, controller] of this.controllers) {
			controller.abort();
			this.controllers.delete(sessionID);
			this.logger.debug("aborted in-flight memory work", { sessionID });
		}
	}

	/** Queue a short line about what the workers just did (shown in the session). */
	pushNotice(sessionID: string, part: string): void {
		if (!this.config.notifyMemoryUpdates || !part) return;
		const list = this.notices.get(sessionID) ?? [];
		if (!list.includes(part)) list.push(part);
		this.notices.set(sessionID, list);
	}

	/** Take (and clear) the lines queued for a session, as one summary. */
	drainNotices(sessionID: string): string {
		const list = this.notices.get(sessionID);
		if (!list || list.length === 0) return "";
		this.notices.delete(sessionID);
		return `${MEMORY_NOTICE_PREFIX}${list.join(", ")}`;
	}

	/** True when an id belongs to a worker child session created by this plugin. */
	ownsSession(sessionID: string | undefined): boolean {
		return this.invoker.ownsSession?.(sessionID) ?? false;
	}

	/** Delete this session's worker children (used by om:reset). */
	async releaseWorkerSessions(sessionID: string): Promise<void> {
		await this.invoker.releaseSession?.(sessionID);
	}

	/** What the memory workers are actually talking to, and why they last failed. */
	describeWorkerModel(sessionID: string): string {
		const resolved = this.invoker.workerModel(sessionID);
		const error = this.invoker.lastWorkerError();
		const base = resolved ? `${resolved.provider}/${resolved.id}` : "not resolved yet";
		if (!error) return base;
		return `${base} (last failure on ${error.model}: ${error.reason})`;
	}

	renderStatus(state: MemoryState, extra: { sessionID: string; entries?: readonly SourceEntry[] }): string {
		const metrics = observationPoolMetrics(state.observations, this.config.observationsPoolTargetTokens);
		const stats = this.invoker.stats();
		const lines = [
			"## Observational memory",
			`- session: ${extra.sessionID}`,
			`- observations: ${state.observations.length} active (${metrics.observationTokens.toLocaleString()} tokens, target ${metrics.targetTokens.toLocaleString()}, max ${this.config.observationsPoolMaxTokens.toLocaleString()})`,
			`- reflections: ${state.reflections.length}`,
			`- dropped observations: ${state.droppedObservationIds.length}`,
			`- coverage: observed ${state.observedThrough ?? "-"}, reflected ${state.reflectedThrough ?? "-"}, dropped ${state.droppedThrough ?? "-"}`,
			`- compactions folded into memory: ${state.compactions.length}`,
			`- worker runs: observer ${state.stats.observerRuns}, reflector ${state.stats.reflectorRuns}, dropper ${state.stats.dropperRuns}, failures ${state.stats.failures}`,
			`- worker tokens this process: in ${stats.inputTokens.toLocaleString()}, out ${stats.outputTokens.toLocaleString()} (${stats.calls} calls)`,
			`- worker model: ${this.describeWorkerModel(extra.sessionID)}`,
			`- mode: ${this.config.passive ? "passive" : "active"}${this.config.injectMemory ? "" : ", injection off"}`,
		];
		if (extra.entries) {
			lines.push(`- unobserved source tokens: ${this.unobservedTokens(extra.entries, state).toLocaleString()}`);
			lines.push(`- unreflected observed tokens: ${this.unreflectedTokens(extra.entries, state).toLocaleString()}`);
			lines.push(`- observed tokens since last compaction: ${this.observedTokensSinceCompaction(extra.entries, state).toLocaleString()}`);
		}
		if (this.logger.path) lines.push(`- debug log: ${this.logger.path}`);
		return lines.join("\n");
	}

	renderView(state: MemoryState, options: { full?: boolean } = {}): string {
		const parts: string[] = [];
		if (state.reflections.length > 0) {
			parts.push("## Reflections");
			parts.push(state.reflections.map((reflection) => `[${reflection.id}] ${reflection.content}`).join("\n"));
		}
		if (state.observations.length > 0) {
			parts.push("## Observations");
			parts.push(state.observations.map((observation) => observationLineForReflector(observation, "-")).join("\n"));
		}
		if (options.full && state.droppedObservationIds.length > 0) {
			parts.push("## Dropped observation ids");
			parts.push(state.droppedObservationIds.join("\n"));
		}
		if (parts.length === 0) return "Observational memory is empty for this session.";
		return parts.join("\n\n");
	}

	/** Search active memory for the `om_recall` tool. */
	recall(state: MemoryState, query: { id?: string; text?: string; limit?: number }): string {
		const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 50) : 10;
		if (query.id) {
			const observation = state.observations.find((candidate) => candidate.id === query.id);
			if (observation) return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
			const reflection = state.reflections.find((candidate) => candidate.id === query.id);
			if (reflection) return `[${reflection.id}] ${reflection.content}`;
			return `No active memory record with id ${query.id}.`;
		}
		const needle = (query.text ?? "").toLowerCase().trim();
		if (!needle) return "Provide a query or an id.";
		const scored: { line: string; score: number }[] = [];
		for (const reflection of state.reflections) {
			const score = scoreText(reflection.content.toLowerCase(), needle);
			if (score > 0) scored.push({ line: `[${reflection.id}] ${reflection.content}`, score: score * 2 });
		}
		for (const observation of state.observations) {
			const score = scoreText(observation.content.toLowerCase(), needle);
			if (score > 0) {
				scored.push({ line: `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`, score });
			}
		}
		scored.sort((a, b) => b.score - a.score);
		if (scored.length === 0) return `No active memory matched "${query.text}".`;
		return scored.slice(0, limit).map((entry) => entry.line).join("\n");
	}

	// --------------------------------------------------------------- internals

	controllerFor(sessionID: string): AbortController {
		let controller = this.controllers.get(sessionID);
		if (!controller) {
			controller = new AbortController();
			this.controllers.set(sessionID, controller);
		}
		return controller;
	}

	/** Abort in-flight memory work so it yields to the session (pi: abort on agent_start). */
	abort(sessionID: string): void {
		const controller = this.controllers.get(sessionID);
		if (!controller || controller.signal.aborted) return;
		controller.abort();
		this.controllers.delete(sessionID);
		this.logger.debug("aborted in-flight memory work", { sessionID });
	}

	/** True when a consolidation run is in flight for this session. */
	inFlight(sessionID: string): boolean {
		const controller = this.controllers.get(sessionID);
		return !!controller && !controller.signal.aborted;
	}

	/**
	 * Background consolidation runs on every settled turn. After a worker
	 * failure, back off so a broken model or missing credential cannot be
	 * hammered once per turn; the compaction hook still does its own bounded
	 * catch-up attempt.
	 */
	private backgroundBackoffMs = 60_000;
	private readonly lastFailureAt = new Map<string, number>();

	shouldSkipBackground(sessionID: string): boolean {
		const at = this.lastFailureAt.get(sessionID);
		return at !== undefined && Date.now() - at < this.backgroundBackoffMs;
	}

	private noteFailure(sessionID: string): void {
		this.lastFailureAt.set(sessionID, Date.now());
	}

	private noteSuccess(sessionID: string): void {
		this.lastFailureAt.delete(sessionID);
	}

	private async callWorker<T>(fn: () => Promise<T>, sessionID: string): Promise<T> {
		this.workerCalls++;
		try {
			return await fn();
		} finally {
			this.workerCalls--;
			const controller = this.controllers.get(sessionID);
			if (controller?.signal.aborted) this.controllers.delete(sessionID);
		}
	}
}

function scoreText(haystack: string, needle: string): number {
	if (!needle) return 0;
	if (haystack.includes(needle)) return 2 + needle.length / haystack.length;
	const terms = needle.split(/\s+/).filter((term) => term.length > 2);
	if (terms.length === 0) return 0;
	let hits = 0;
	for (const term of terms) if (haystack.includes(term)) hits++;
	return hits === terms.length ? 1 + terms.length / 10 : 0;
}

/** Prefix that marks a plugin notice, so memory never observes its own notices. */
export const MEMORY_NOTICE_PREFIX = "🧠 memory: ";

export type { MemoryState, Observation };

