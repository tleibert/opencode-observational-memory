import type { Config, ConfiguredModel } from "./config.js";
import type { PluginContext } from "./host-types.js";
import { describeError, type Logger } from "./log.js";
import { WorkerModelSelector } from "./models.js";
import { extractJsonObject } from "./agents/json.js";
import { WorkerSessions } from "./worker-session.js";
import { estimateStringTokens } from "./tokens.js";

/**
 * Memory worker transport.
 *
 * Pi's version streams through pi-ai with an agent loop plus a
 * `record_observations`-style tool. OpenCode's plugin API exposes a transient
 * one-shot generation (`ctx.generate.text`) with an optional model, so this
 * port drives the same workers with a strict JSON output contract instead of a
 * tool loop: the prompt states the exact JSON shape, and every proposed record
 * is validated, deduplicated and filtered locally before it is trusted.
 *
 * `agentMaxTokens` has no equivalent on the generate API (it is not a
 * parameter); it is kept in the config for parity and used on the observation
 * side to bound chunk sizes so worker output stays small.
 */

export type WorkerRequest = {
	system: string;
	user: string;
	/** Short label used in logs and error messages (e.g. "observer"). */
	label: string;
	/** Session whose model is used when no worker model is configured. */
	sessionID?: string;
	signal?: AbortSignal;
	/**
	 * Cheap check on the raw answer (does it even contain the JSON object we
	 * asked for?). A worker that replies with prose is a bad worker, so the
	 * attempt fails and the next candidate model is tried rather than burning
	 * the whole stage.
	 */
	validate?: (text: string) => void;
};

export type WorkerResponse = {
	text: string;
	model?: ConfiguredModel;
	fallbackUsed: boolean;
};

export type WorkerInvoker = {
	call(request: WorkerRequest): Promise<WorkerResponse>;
	stats(): { inputTokens: number; outputTokens: number; calls: number };
	/** Model this session's memory workers settled on, once one has answered. */
	workerModel(sessionID: string | undefined): ConfiguredModel | undefined;
	lastWorkerError(): { model: string; reason: string; kind: string } | undefined;
	/** True when the id belongs to a worker child session, not a user session. */
	ownsSession(sessionID: string | undefined): boolean;
	/** Delete this session's worker children (on reset). */
	releaseSession(sessionID: string): Promise<void>;
	/** Delete every worker child (on plugin teardown). */
	dispose(): Promise<void>;
};

/** Bound on how many worker models are tried before a stage gives up. */
const MAX_WORKER_ATTEMPTS = 5;

/** A model that answers with nothing at all is not a usable worker. */
export class EmptyWorkerResponseError extends Error {
	constructor(model: string) {
		super(`worker model ${model} returned an empty response`);
		this.name = "EmptyWorkerResponseError";
	}
}

export class WorkerAbortedError extends Error {
	constructor() {
		super("memory worker aborted");
		this.name = "WorkerAbortedError";
	}
}

function toModelRef(model: ConfiguredModel | undefined) {
	if (!model) return undefined;
	return { providerID: model.provider, id: model.id, ...(model.variant ? { variant: model.variant } : {}) };
}

export function createWorkerInvoker(ctx: PluginContext, config: Config, logger: Logger): WorkerInvoker {
	let inputTokens = 0;
	let outputTokens = 0;
	let calls = 0;
	const selector = new WorkerModelSelector(ctx, config, logger);
	const sessions = new WorkerSessions(ctx, logger);
	const chains = new Map<string, Promise<unknown>>();

	const textOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** True when the text contains the JSON object the worker contract demands. */
const isJsonResponse = (text: string): boolean => {
	try {
		extractJsonObject(text);
		return true;
	} catch {
		return false;
	}
};

const count = (text: string, prompt: string) => {
		inputTokens += estimateStringTokens(prompt);
		outputTokens += estimateStringTokens(text);
	};

	/** Native session machinery: a child session carries the worker model. */
	const viaSession = async (
		parentSessionID: string | undefined,
		model: ConfiguredModel | undefined,
		prompt: string,
		signal: AbortSignal | undefined,
	): Promise<string | undefined> => {
		if (config.workerTransport === "generate") return undefined;
		const childID = await sessions.ensure(parentSessionID, model);
		if (!childID) return undefined;
		const response = (await ctx.session.generate(
			{ sessionID: childID, prompt },
			signal ? { signal } : undefined,
		)) as { text?: string } | undefined;
		const text = response?.text ?? "";
		calls++;
		count(text, prompt);
		if (calls <= 5 || text.length < 40) {
			logger.debug("worker response (session)", { bytes: text.length, head: text.slice(0, 160).replace(/\s+/g, " ") });
		}
		return text;
	};

	/** Plugin-issued generation: the only path that can pick an arbitrary model. */
	const viaGenerate = async (model: ConfiguredModel | undefined, prompt: string, signal: AbortSignal | undefined): Promise<string> => {
		const modelRef = toModelRef(model);
		const response = await ctx.generate.text(
			modelRef ? { prompt, model: modelRef as never } : { prompt },
			signal ? { signal } : undefined,
		);
		const text = response?.text ?? "";
		calls++;
		count(text, prompt);
		if (calls <= 5 || text.length < 40) {
			logger.debug("worker response (generate)", { bytes: text.length, head: text.slice(0, 160).replace(/\s+/g, " ") });
		}
		return text;
	};

	/**
	 * Try each viable worker model until one answers. Session machinery is
	 * preferred because the host refuses plugin-issued calls for gated models;
	 * empty output counts as a failure so a model that cannot answer does not
	 * burn the stage.
	 */
	const run = async (request: WorkerRequest): Promise<WorkerResponse> => {
		const attempted: ConfiguredModel[] = [];
		let lastError: unknown;
		for (let index = 0; index < MAX_WORKER_ATTEMPTS; index++) {
			const model = await selector.pick(request.sessionID, attempted);
			if (!model && index > 0) break;
			const label = model ? `${model.provider}/${model.id}` : "host default";
			if (request.signal?.aborted) throw new WorkerAbortedError();
			try {
				const prompt = `${request.system}\n\n${request.user}`;
				let text = config.workerTransport === "generate" ? undefined : await viaSession(request.sessionID, model, prompt, request.signal);
				if (text === undefined) text = await viaGenerate(model, prompt, request.signal);
				if (!text.trim()) throw new EmptyWorkerResponseError(label);
				request.validate?.(text);
				if (index > 0) logger.debug(`${request.label} worker recovered`, { model: label });
				selector.noteSuccess(model, request.sessionID);
				return { text, model, fallbackUsed: index > 0 };
			} catch (error) {
				lastError = error;
				if (error instanceof WorkerAbortedError || request.signal?.aborted) throw new WorkerAbortedError();
				if (model) attempted.push(model);
				const kindLabel =
					error instanceof EmptyWorkerResponseError || !isJsonResponse(textOf(error))
						? "unusable output"
						: describeError(error);
				const { kind } = selector.noteFailure(model, error);
				logger.warn(`${request.label} worker call failed`, { model: label, kind, error: kindLabel });
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	};

	/**
	 * Serialize worker calls per session: a child session runs one generation at
	 * a time, and stage order (observe → reflect → drop) depends on it.
	 */
	const call = async (request: WorkerRequest): Promise<WorkerResponse> => {
		const key = request.sessionID ?? "global";
		const previous = chains.get(key) ?? Promise.resolve();
		const next = previous.then(
			() => run(request),
			() => run(request),
		);
		const tracked = next
			.catch(() => undefined)
			.finally(() => {
				if (chains.get(key) === tracked) chains.delete(key);
			});
		chains.set(key, tracked);
		return next;
	};

	return {
		call,
		stats: () => ({ inputTokens, outputTokens, calls }),
		workerModel: (sessionID: string | undefined) => selector.chosen(sessionID ?? ""),
		lastWorkerError: () => selector.lastError(),
		ownsSession: (sessionID: string | undefined) => sessions.owns(sessionID),
		releaseSession: (sessionID: string) => sessions.removeParent(sessionID),
		dispose: () => sessions.dispose(),
	};
}

export { describeError } from "./log.js";
