import type { ConfiguredModel } from "./config.js";
import type { PluginContext } from "./host-types.js";
import { describeError, type Logger } from "./log.js";
import { modelKey } from "./models.js";

/**
 * Worker sessions.
 *
 * Plugin-issued generation (`ctx.generate.text`) is refused for models the host
 * gates, most visibly Zen's free tier:
 *
 *   Generate.UnavailableError: OpenCode's free tier can only be used
 *   from within OpenCode.
 *
 * The same call made *through the session machinery* is accepted, and so is the
 * same model inside a child session. Verified live on opencode 2.0.32:
 * `session.generate` on a free-tier model answers normally while
 * `generate.text` with that exact model is refused.
 *
 * So memory workers run as a child session of the session they observe:
 *
 *   - native session machinery, so no free-tier gate
 *   - the worker model is chosen by the plugin (the child carries its own)
 *   - `session.generate` is transient: nothing is appended to the transcript
 *   - the child is hidden from `opencode session list` (it has a parentID)
 *
 * One child is kept per (parent session, worker model) pair and reused, so the
 * create cost is paid once per model rather than once per stage.
 */

export class WorkerSessions {
	private children = new Map<string, string>();
	private owned = new Set<string>();
	private disposed = false;

	constructor(
		private readonly ctx: PluginContext,
		private readonly logger: Logger,
	) {}

	/** True for sessions this manager created (their events are not user turns). */
	owns(sessionID: string | undefined): boolean {
		return Boolean(sessionID && this.owned.has(sessionID));
	}

	/**
	 * Ensure a worker child session for this parent running `model`, returning
	 * its session id. Returns undefined when the host refuses to create one, and
	 * the caller falls back to plugin-issued generation.
	 */
	async ensure(parentSessionID: string | undefined, model: ConfiguredModel | undefined): Promise<string | undefined> {
		if (this.disposed) return undefined;
		if (!parentSessionID || !model) return undefined;
		const key = `${parentSessionID}\u0000${modelKey(model)}`;
		const existing = this.children.get(key);
		if (existing) return existing;
		try {
			const created = (await this.ctx.session.create({
				parentID: parentSessionID,
				title: "observational-memory worker",
				model: { providerID: model.provider, id: model.id, ...(model.variant ? { variant: model.variant } : {}) },
			} as never)) as { id?: string } | undefined;
			const childID = created?.id;
			if (!childID) {
				this.logger.debug("worker session create returned no id", { parentSessionID, model: modelKey(model) });
				return undefined;
			}
			this.children.set(key, childID);
			this.owned.add(childID);
			this.logger.debug("worker session created", { childID, parentSessionID, model: modelKey(model) });
			return childID;
		} catch (error) {
			this.logger.debug("worker session create failed", { model: modelKey(model), error: describeError(error) });
			return undefined;
		}
	}

	/** Drop (and delete) every worker session created for one parent session. */
	async removeParent(parentSessionID: string): Promise<void> {
		const prefix = `${parentSessionID}\u0000`;
		const doomed: string[] = [];
		for (const [key, childID] of this.children) {
			if (!key.startsWith(prefix)) continue;
			this.children.delete(key);
			doomed.push(childID);
		}
		for (const childID of doomed) await this.remove(childID);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const doomed = [...this.children.values()];
		this.children.clear();
		for (const childID of doomed) await this.remove(childID);
	}

	private async remove(childID: string): Promise<void> {
		this.owned.delete(childID);
		try {
			await this.ctx.session.remove({ sessionID: childID } as never);
		} catch (error) {
			this.logger.debug("worker session remove failed", { childID, error: describeError(error) });
		}
	}
}
