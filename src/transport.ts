import type { Config, ConfiguredModel } from "./config.js";
import type { PluginContext } from "./host-types.js";
import { describeError, type Logger } from "./log.js";
import { WorkerModelSelector } from "./models.js";
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
};

/** Bound on how many worker models are tried before a stage gives up. */
const MAX_WORKER_ATTEMPTS = 5;

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

	const runOnce = async (
		system: string,
		user: string,
		model: ConfiguredModel | undefined,
		signal: AbortSignal | undefined,
	): Promise<string> => {
		if (signal?.aborted) throw new WorkerAbortedError();
		const prompt = `${system}\n\n${user}`;
		inputTokens += estimateStringTokens(prompt);
		const modelRef = toModelRef(model);
		const response = await ctx.generate.text(
			modelRef ? { prompt, model: modelRef as never } : { prompt },
			signal ? { signal } : undefined,
		);
		outputTokens += estimateStringTokens(response.text ?? "");
		calls++;
		if (calls <= 5 || response.text.length < 40) {
			logger.debug("worker response", { bytes: response.text.length, head: response.text.slice(0, 160).replace(/\s+/g, " ") });
		}
		return response.text ?? "";
	};

	/**
	 * Try each viable worker model in order. A gated model (Zen free tier,
	 * not-launched model, unreadable id) is remembered for the process, a
	 * transient failure gets a cooldown, and the first model that answers wins
	 * for the rest of the session — so the search cost is paid once.
	 */
	const call = async (request: WorkerRequest): Promise<WorkerResponse> => {
		// Candidates are picked one at a time so a gate learned from the previous
		// failure is respected immediately (free-tier refusal is provider-wide).
		const attempted: ConfiguredModel[] = [];
		const maxAttempts = MAX_WORKER_ATTEMPTS;
		let lastError: unknown;
		for (let index = 0; index < maxAttempts; index++) {
			const model = await selector.pick(request.sessionID, attempted);
			if (!model && index > 0) break;
			const label = model ? `${model.provider}/${model.id}` : "host default";
			try {
				const text = await runOnce(request.system, request.user, model, request.signal);
				if (index > 0) logger.debug(`${request.label} worker recovered on fallback model`, { model: label });
				selector.noteSuccess(model, request.sessionID);
				return { text, model, fallbackUsed: index > 0 };
			} catch (error) {
				lastError = error;
				if (error instanceof WorkerAbortedError || request.signal?.aborted) throw new WorkerAbortedError();
				if (model) attempted.push(model);
				const { kind } = selector.noteFailure(model, error);
				logger.warn(`${request.label} worker call failed`, { model: label, kind, error: describeError(error) });
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	};

	return {
		call,
		stats: () => ({ inputTokens, outputTokens, calls }),
		workerModel: (sessionID: string | undefined) => selector.chosen(sessionID ?? ""),
		lastWorkerError: () => selector.lastError(),
	};
}

export { describeError } from "./log.js";
