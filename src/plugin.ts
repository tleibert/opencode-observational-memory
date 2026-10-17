import { Plugin } from "@opencode/plugin";
import { resolveConfig } from "./config.js";
import { handleCompaction } from "./hooks/compaction.js";
import { createLogger, type Logger } from "./log.js";
import { MemoryRuntime } from "./memory.js";
import { createWorkerInvoker, describeError } from "./transport.js";
import type { PluginContext } from "./host-types.js";
import { PLUGIN_VERSION } from "./version.js";

/**
 * OpenCode host wiring.
 *
 * Pi hooks (session_before_compact / agent_start / turn_end / agent_settled)
 * map onto OpenCode session hooks and the public event stream:
 *
 *  - `prompt`       → memory workers yield to the session (abort in-flight work)
 *  - `context`      → inject the rendered memory block into the system prompt
 *  - `compaction`   → observe the uncovered gap, then write the summary from
 *                     memory and skip the summarizer model call (or decline
 *                     ownership when the gap cannot be covered)
 *  - `session.idle` → background consolidation (observe → reflect → drop)
 */

const PLUGIN_ID = "observational-memory";

/**
 * OpenCode evaluates a plugin module more than once while resolving and
 * loading it, so two instances can call `setup()` in the same process. Only the
 * newest instance stays active: it claims a process-wide token, and the
 * previous instance's cleanup runs (also the hot-reload path).
 */
const GLOBAL_KEY = Symbol.for("opencode-observational-memory.active");

function claimInstance(token: symbol, cleanup: () => Promise<void> | void): void {
	const holder = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as
		| { token?: symbol; cleanup?: () => Promise<void> | void }
		| undefined;
	const previous = holder?.cleanup;
	if (previous) void Promise.resolve(previous()).catch(() => undefined);
	(globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = { token, cleanup };
}

function isCurrentInstance(token: symbol): boolean {
	const holder = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as { token?: symbol } | undefined;
	return holder?.token === token;
}

function extractSessionID(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as Record<string, unknown>;
	const candidates = [
		record.sessionID,
		(record.data as Record<string, unknown> | undefined)?.sessionID,
		(record.properties as Record<string, unknown> | undefined)?.sessionID,
		((record.data as Record<string, unknown> | undefined)?.session as Record<string, unknown> | undefined)?.id,
		(record.session as Record<string, unknown> | undefined)?.id,
	];
	for (const candidate of candidates) if (typeof candidate === "string") return candidate;
	return undefined;
}

function eventType(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const type = (event as Record<string, unknown>).type;
	return typeof type === "string" ? type : undefined;
}

export function createPlugin() {
/** Run a command body and always show something: silence looks like a broken command. */
async function reportCommand(
	ctx: PluginContext,
	logger: Logger,
	sessionID: string,
	body: () => Promise<string>,
): Promise<void> {
	try {
		const text = await body();
		await ctx.session.synthetic({ sessionID, text } as never);
	} catch (error) {
		logger.warn("command failed", { sessionID, error: describeError(error) });
		try {
			await ctx.session.synthetic({ sessionID, text: `observational memory: command failed - ${describeError(error)}` } as never);
		} catch {
			// nothing else we can do
		}
	}
}

	return Plugin.define({
		id: PLUGIN_ID,
		async setup(ctx: PluginContext) {
			const config = resolveConfig({ options: ctx.options as Record<string, unknown> });
			const logger = createLogger(config);
			const instanceToken = Symbol(PLUGIN_ID);
			const observedEventTypes = new Set<string>();
			const invoker = createWorkerInvoker(ctx, config, logger);
			const runtime = new MemoryRuntime(ctx, config, logger, invoker);

			logger.debug("plugin loaded", {
				version: PLUGIN_VERSION,
				directory: ctx.location?.directory,
				passive: config.passive,
				injectMemory: config.injectMemory,
				consolidateWhenIdle: config.consolidateWhenIdle,
				model: config.model,
			});

			// Memory work yields to the session: a new prompt cancels in-flight workers.
			const promptRegistration = await ctx.session.hook("prompt", (event) => {
				try {
					runtime.abort(event.sessionID);
				} catch (error) {
					logger.debug("prompt hook failed", describeError(error));
				}
			});

			// Inject rendered memory into every agent-loop request.
			const contextRegistration = await ctx.session.hook("context", async (event) => {
				try {
					logger.debug("context hook", {
						sessionID: event.sessionID,
						system: event.system?.length ?? -1,
						messages: event.messages?.length ?? -1,
						observeBeforeRequest: config.observeBeforeRequest,
					});
					if (config.passive) return;
					if (runtime.isWorkerCallInFlight()) return;
					if (config.observeBeforeRequest) {
						// Deterministic mode: cover the backlog before the request so the
						// injected memory already includes this turn's predecessors.
						await runtime.observe(event.sessionID, {
							force: true,
							maxChunks: config.compactionCatchUpMaxChunks,
							allowCompactionRequest: false,
							reason: "request",
						});
						await postNotices(event.sessionID);
					}
					if (!config.injectMemory) return;
					const state = await runtime.load(event.sessionID);
					if (!runtime.hasMemory(state)) return;
					const contextWindow = await runtime.resolveContextWindow(event.sessionID);
					const block = runtime.renderMemoryBlock(state, contextWindow);
					if (!block) return;
					logger.debug("injected memory block", {
						sessionID: event.sessionID,
						observations: state.observations.length,
						reflections: state.reflections.length,
						tokens: Math.ceil(block.length / 4),
					});
					event.system.push({ type: "text", text: block } as never);
				} catch (error) {
					logger.warn("memory injection failed", describeError(error));
				}
			});

			// Compaction: cover the gap synchronously, then supply the summary ourselves
			// (or decline ownership so OpenCode's native summarizer covers raw source).
			const compactionRegistration = await ctx.session.hook("compaction", async (event) => {
				const outcome = await handleCompaction(
					{ runtime, config, logger },
					{ sessionID: event.sessionID, setResult: (result) => { event.result = result; } },
				);
				logger.debug("compaction hook outcome", { sessionID: event.sessionID, outcome });
			});

			// Surface what the workers did, so the ledger is visible in the session.
			const postNotices = async (sessionID: string) => {
				try {
					const text = runtime.drainNotices(sessionID);
					if (!text) return;
					await ctx.session.synthetic({ sessionID, text } as never);
					logger.debug("memory notice posted", { sessionID, text });
				} catch (error) {
					logger.debug("memory notice failed", describeError(error));
				}
			};

			// Background consolidation when the session goes idle.
			const eventController = new AbortController();
			const running = new Set<string>();
			void (async () => {
				try {
					for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
						if (!isCurrentInstance(instanceToken)) break;
						const type = eventType(event);
						if (!type) continue;
						if (config.debugLog && observedEventTypes.size < 40 && !observedEventTypes.has(type)) {
							observedEventTypes.add(type);
							logger.debug("event observed", { type, sessionID: extractSessionID(event) });
						}
						if (type !== "session.idle" && type !== "session.execution.succeeded" && type !== "session.execution.interrupted") continue;
						const sessionID = extractSessionID(event);
						if (!sessionID || running.has(sessionID)) continue;
						if (!config.consolidateWhenIdle) continue;
						if (runtime.shouldSkipBackground(sessionID)) {
							logger.debug("background consolidation skipped (recent worker failure)", { sessionID });
							continue;
						}
						running.add(sessionID);
						void runtime
							.consolidate(sessionID, { allowCompactionRequest: true, reason: "idle" })
							.then(() => postNotices(sessionID))
							.catch((error) => logger.warn("idle consolidation failed", describeError(error)))
							.finally(() => running.delete(sessionID));
					}
				} catch (error) {
					if (!eventController.signal.aborted) logger.debug("event stream ended", describeError(error));
				}
			})();

			// Memory recall tool.
			const toolRegistration = await ctx.tool.transform((editor) => {
				editor.add({
					name: "om_recall",
					// Without this the host keeps the tool inside the code-mode sandbox
					// (callable only as tools.om_recall(...) from `execute`), so it never
					// reaches the model's own tool list.
					options: { codemode: false },
					description:
						"Search this session's observational memory. Use it when a memory id needs exact source context, or to check whether something was already decided, completed, or rejected before redoing work.",
					input: {
						type: "object",
						properties: {
							query: { type: "string", description: "Keywords to search active observations and reflections." },
							id: { type: "string", description: "An exact memory id (12 hex characters) to fetch." },
							limit: { type: "number", description: "Maximum matches to return (default 10)." },
						},
						required: [],
						additionalProperties: false,
					},
					execute: async (input: unknown, context: { sessionID: string }) => {
						const args = input as { query?: string; id?: string; limit?: number };
						const state = await runtime.load(context.sessionID);
						return { content: runtime.recall(state, { id: args.id, text: args.query, limit: args.limit }) };
					},
				} as never);
			});

			// Commands surface memory state without spending a model turn.
			const commandRegistration = await ctx.command.transform((editor) => {
				editor.add({
					name: "om:status",
					description: "Show observational memory status for this session",
					execute: async ({ sessionID }) => {
						await reportCommand(ctx, logger, sessionID, async () => {
							const state = await runtime.load(sessionID);
							const { entries } = await runtime.readTranscript(sessionID);
							return runtime.renderStatus(state, { sessionID, entries });
						});
					},
				});
				editor.add({
					name: "om:view",
					description: "Show active observations and reflections for this session",
					execute: async ({ sessionID }) => {
						await reportCommand(ctx, logger, sessionID, async () => {
							const state = await runtime.load(sessionID);
							return runtime.renderView(state, { full: true });
						});
					},
				});
				editor.add({
					name: "om:reset",
					description: "Delete observational memory for this session",
					execute: async ({ sessionID }) => {
						await reportCommand(ctx, logger, sessionID, async () => {
							await runtime.abort(sessionID);
							await runtime.releaseWorkerSessions(sessionID);
							await runtime.reset(sessionID);
							return "Observational memory cleared for this session.";
						});
					},
				});
			});

			const instanceCleanup = async () => {
				eventController.abort();
				runtime.abortAll();
				await invoker.dispose();
				for (const registration of [promptRegistration, contextRegistration, compactionRegistration, toolRegistration, commandRegistration]) {
					try {
						await registration?.dispose?.();
					} catch (error) {
						logger.debug("dispose failed", describeError(error));
					}
				}
			};
			claimInstance(instanceToken, instanceCleanup);

			return instanceCleanup;
		},
	});
}
