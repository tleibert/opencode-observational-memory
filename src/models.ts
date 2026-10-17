import type { Config, ConfiguredModel } from "./config.js";
import type { PluginContext } from "./host-types.js";
import { describeError, type Logger } from "./log.js";

/**
 * Worker model selection.
 *
 * The session's own model is the natural worker model, but OpenCode refuses some
 * models for plugin-issued generation: gated Zen free-tier models answer
 * "OpenCode's free tier can only be used from within OpenCode", models that are
 * not launched yet answer `model_coming_soon`, and a depleted plan answers with
 * a usage-limit error. None of those are recoverable by retrying the same model.
 *
 * So the selector keeps a process-wide verdict per model and walks an ordered
 * candidate list until one works:
 *
 *   1. `model` from config (explicit user choice wins)
 *   2. `fallbackModel` from config
 *   3. the session's own model
 *   4. free models the host knows about (they cost nothing, so trying them is safe)
 *   5. cheapest paid models — only when `allowPaidWorkerModel` is set, because
 *      silently spending money on background work would be a surprise
 *
 * Gated models are remembered for the process (and gate their whole provider's
 * free tier), transient failures get a cooldown, and the first working model is
 * remembered per session so later stages skip the search.
 */

export type ModelRef = { providerID: string; id: string; variant?: string };

export type WorkerErrorKind = "gated" | "transient" | "unknown";

export type WorkerVerdict =
	| { state: "ok" }
	| { state: "gated"; reason: string }
	| { state: "cooldown"; reason: string; until: number };

const COOLDOWN_MS = 60_000;
const FREE_CANDIDATE_LIMIT = 6;
const PAID_CANDIDATE_LIMIT = 2;

export function modelKey(model: ConfiguredModel | ModelRef | undefined): string {
	if (!model) return "host-default";
	const provider = "provider" in model ? model.provider : model.providerID;
	const variant = model.variant ? `#${model.variant}` : "";
	return `${provider}/${model.id}${variant}`;
}

/**
 * Classify a worker failure. Only "gated" is permanent: the model cannot serve
 * plugin-issued calls at all until the host or the plan changes.
 */
export function classifyWorkerError(error: unknown): { kind: WorkerErrorKind; reason: string } {
	const reason = describeError(error);
	const text = reason.toLowerCase();
	if (text.includes("free tier") || text.includes("free usage") || text.includes("freeusage")) {
		return { kind: "gated", reason };
	}
	if (text.includes("coming soon") || text.includes("invalid_request") || text.includes("not found") || text.includes("unknown model")) {
		return { kind: "gated", reason };
	}
	if (text.includes("unavailable") || text.includes("unauthorized") || text.includes("payment") || text.includes("balance")) {
		return { kind: "transient", reason };
	}
	return { kind: "unknown", reason };
}

/** True when every published price tier of a model is zero. */
export function isFreeModel(cost: ReadonlyArray<{ input?: number; output?: number }> | undefined): boolean {
	if (!Array.isArray(cost) || cost.length === 0) return false;
	return cost.every((tier) => (tier?.input ?? 0) <= 0 && (tier?.output ?? 0) <= 0);
}

export function priceOf(cost: ReadonlyArray<{ input?: number; output?: number }> | undefined): number {
	if (!Array.isArray(cost) || cost.length === 0) return Number.POSITIVE_INFINITY;
	return cost.reduce((sum, tier) => sum + (tier?.input ?? 0) + (tier?.output ?? 0), 0);
}

export type ModelListing = {
	providerID: string;
	id: string;
	modelID?: string;
	cost?: ReadonlyArray<{ input?: number; output?: number }>;
	limit?: { context?: number };
	status?: string;
	enabled?: boolean;
};

/**
 * Order the models a worker may try. Free models come first because they cannot
 * cost anything; models from the session's provider are preferred so a hosted
 * deployment keeps its traffic in one place.
 */
export function orderModelCandidates(
	listing: readonly ModelListing[],
	options: {
		sessionProvider?: string;
		allowPaid: boolean;
		exclude?: readonly string[];
		/** Providers whose free tier is refused for plugin calls. */
		freeGatedProviders?: readonly string[];
	} = { allowPaid: false },
): ConfiguredModel[] {
	const excluded = new Set(options.exclude ?? []);
	const freeGated = new Set(options.freeGatedProviders ?? []);
	const seen = new Set<string>();
	const free: ModelListing[] = [];
	const paid: ModelListing[] = [];
	for (const model of listing) {
		if (model.enabled === false) continue;
		if (model.status === "deprecated") continue;
		const id = model.modelID ?? model.id;
		if (!id) continue;
		const key = `${model.providerID}/${id}`;
		if (excluded.has(key) || seen.has(key)) continue;
		seen.add(key);
		if (isFreeModel(model.cost)) {
			// A gated free tier refuses every free model of that provider, so
			// trying its siblings only burns time.
			if (freeGated.has(model.providerID)) continue;
			free.push(model);
			continue;
		}
		if (Number.isFinite(priceOf(model.cost))) paid.push(model);
	}
	const rank = (model: ModelListing) => (model.providerID === options.sessionProvider ? 0 : 1);
	const contextSize = (model: ModelListing) => -(model.limit?.context ?? 0);
	const sort = (models: ModelListing[]) =>
		models.sort((a, b) => rank(a) - rank(b) || contextSize(a) - contextSize(b) || a.providerID.localeCompare(b.providerID));
	const picked = sort(free).slice(0, FREE_CANDIDATE_LIMIT).map(toConfigured);
	if (options.allowPaid) {
		picked.push(...sort(paid).slice(0, PAID_CANDIDATE_LIMIT).map(toConfigured));
	}
	return picked;
}

function toConfigured(model: ModelListing): ConfiguredModel {
	return { provider: model.providerID, id: model.modelID ?? model.id };
}

export class WorkerModelSelector {
	private verdicts = new Map<string, WorkerVerdict>();
	/** Providers whose *free* tier is refused for plugin calls (host policy). */
	private freeGate = new Map<string, string>();
	private sessionChoice = new Map<string, ConfiguredModel>();
	private listing: ModelListing[] | undefined;
	private lastFailure: { model: string; reason: string; kind: WorkerErrorKind } | undefined;

	constructor(
		private readonly ctx: PluginContext,
		private readonly config: Config,
		private readonly logger: Logger,
	) {}

	/** Model the session is running, if the host reports one. */
	async sessionModel(sessionID: string | undefined): Promise<ConfiguredModel | undefined> {
		if (!sessionID) return undefined;
		const cached = this.sessionChoice.get(sessionID);
		if (cached) return cached;
		try {
			const session = (await this.ctx.session.get({ sessionID })) as {
				model?: { providerID?: string; id?: string; variant?: string };
			};
			const model = session?.model;
			if (model?.providerID && model.id) {
				return { provider: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) };
			}
		} catch (error) {
			this.logger.debug("session model lookup failed", describeError(error));
		}
		return undefined;
	}

	/**
	 * Next model to try, given the models already attempted in this stage.
	 * Candidates are rebuilt on every call so a gate learned from the failure
	 * that just happened (free-tier refusals are provider-wide) immediately
	 * removes that provider's other free models from consideration.
	 */
	async pick(sessionID: string | undefined, attempted: readonly ConfiguredModel[] = []): Promise<ConfiguredModel | undefined> {
		const tried = new Set(attempted.map(modelKey));
		const ordered: ConfiguredModel[] = [];
		let sessionModel: ConfiguredModel | undefined;
		const push = (model: ConfiguredModel | undefined) => {
			if (!model) return;
			const key = modelKey(model);
			if (tried.has(key)) return;
			if (ordered.some((candidate) => modelKey(candidate) === key)) return;
			if (!this.usable(model)) return;
			ordered.push(model);
		};

		push(this.config.model);
		push(this.config.fallbackModel);
		sessionModel = await this.sessionModel(sessionID);
		push(sessionModel);

		const listing = await this.modelListing();
		for (const candidate of orderModelCandidates(listing, {
			sessionProvider: sessionModel?.provider,
			allowPaid: this.config.allowPaidWorkerModel,
			exclude: [...tried, ...ordered.map(modelKey)],
			freeGatedProviders: [...this.freeGate.keys()],
		})) {
			push(candidate);
		}
		return ordered[0];
	}

	/** Candidate list for a stage (used by tests and diagnostics). */
	async candidates(sessionID: string | undefined): Promise<ConfiguredModel[]> {
		const ordered: ConfiguredModel[] = [];
		for (;;) {
			const next = await this.pick(sessionID, ordered);
			if (!next) return ordered;
			ordered.push(next);
			if (ordered.length >= 12) return ordered;
		}
	}

	noteSuccess(model: ConfiguredModel | undefined, sessionID: string | undefined): void {
		if (model) {
			this.verdicts.set(modelKey(model), { state: "ok" });
			if (sessionID) this.sessionChoice.set(sessionID, model);
		}
		this.lastFailure = undefined;
	}

	noteFailure(model: ConfiguredModel | undefined, error: unknown): { kind: WorkerErrorKind; reason: string } {
		const { kind, reason } = classifyWorkerError(error);
		const key = modelKey(model);
		if (kind === "gated") {
			this.verdicts.set(key, { state: "gated", reason });
			// The host refuses plugin calls for gated free models provider-wide.
			if (model && "provider" in model && /free/i.test(model.id)) {
				this.freeGate.set(model.provider, reason);
			}
		} else {
			this.verdicts.set(key, { state: "cooldown", reason, until: Date.now() + COOLDOWN_MS });
		}
		this.lastFailure = { model: key, reason, kind };
		return { kind, reason };
	}

	lastError(): { model: string; reason: string; kind: WorkerErrorKind } | undefined {
		return this.lastFailure;
	}

	/** False once a model is known gated (or cooling down after a failure). */
	isUsable(model: ConfiguredModel | undefined): boolean {
		return !model || this.usable(model);
	}

	/** Providers whose free tier the host refuses for plugin calls. */
	freeGatedProviders(): string[] {
		return [...this.freeGate.keys()];
	}

	/** The model this session settled on, for status output. */
	chosen(sessionID: string): ConfiguredModel | undefined {
		return this.sessionChoice.get(sessionID);
	}

	private usable(model: ConfiguredModel): boolean {
		if (this.freeGate.has(model.provider) && /free/i.test(model.id)) return false;
		const verdict = this.verdicts.get(modelKey(model));
		if (!verdict) return true;
		if (verdict.state === "ok") return true;
		if (verdict.state === "gated") return false;
		if (Date.now() >= verdict.until) {
			this.verdicts.delete(modelKey(model));
			return true;
		}
		return false;
	}

	private async modelListing(): Promise<ModelListing[]> {
		if (this.listing) return this.listing;
		let listing: ModelListing[] = [];
		try {
			const output = (await this.ctx.model.list()) as unknown as { data?: ModelListing[] } | ModelListing[];
			listing = Array.isArray(output) ? output : (output?.data ?? []);
		} catch (error) {
			this.logger.debug("model listing failed", describeError(error));
		}
		this.listing = listing.filter((model) => {
			const gate = this.freeGate.get(model.providerID);
			if (!gate) return true;
			return !isFreeModel(model.cost);
		});
		return this.listing;
	}
}
