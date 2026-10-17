import { DROPPER_SYSTEM } from "../prompts/dropper.js";
import type { Observation, Reflection } from "../types.js";
import type { WorkerInvoker } from "../transport.js";
import { asArray, asRecord, extractJsonObject } from "./json.js";
import { reflectionCoverageMap } from "../coverage.js";
import { observationToDropperLine } from "../coverage.js";

export type DropperInput = {
	/** Rendered existing reflections. */
	reflections: string[];
	/** Rendered observation lines including coverage tiers. */
	observations: string[];
	allowedObservationIds: string[];
	/** Hard upper bound sized so a full pass could reach the pool target. */
	maxDrops: number;
	targetTokens: number;
	observationTokens: number;
	signal?: AbortSignal;
	label?: string;
	sessionID?: string;
};

export type DropperResult = { ids: string[]; requested: number };

function joinOrEmpty(items: readonly string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function buildDropperPrompt(input: DropperInput): { system: string; user: string } {
	const overTarget = Math.max(0, input.observationTokens - input.targetTokens);
	const user = `CURRENT REFLECTIONS:
${joinOrEmpty(input.reflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(input.observations)}

Active observation pool target: ${input.targetTokens} tokens.
Current active observation pool: ${input.observationTokens} tokens (${overTarget} tokens over target).
Maximum drops allowed this run: ${input.maxDrops}.

Return only the ids of observations that are safe to remove, as JSON.`;
	return { system: DROPPER_SYSTEM, user };
}

/**
 * Order-preserving, deduplicated, capped selection. Mirrors
 * pi-observational-memory's `selectDropCandidates`: the model's ordering is the
 * model's own safety ranking, so it is preserved, and the cap is a hard limit
 * rather than a target.
 */
export function selectDropCandidates(
	proposedIds: readonly string[],
	activeIds: readonly string[],
	maxDrops: number,
): string[] {
	if (maxDrops <= 0 || proposedIds.length === 0) return [];
	const active = new Set(activeIds);
	const selected: string[] = [];
	const seen = new Set<string>();
	for (const id of proposedIds) {
		if (selected.length >= maxDrops) break;
		if (!active.has(id) || seen.has(id)) continue;
		seen.add(id);
		selected.push(id);
	}
	return selected;
}

export function parseDropIds(raw: unknown, activeIds: readonly string[], maxDrops: number): DropperResult {
	const record = asRecord(raw);
	const ids = asArray(record?.ids).filter((id): id is string => typeof id === "string");
	return { ids: selectDropCandidates(ids, activeIds, maxDrops), requested: ids.length };
}

export async function runDropper(invoker: WorkerInvoker, input: DropperInput): Promise<DropperResult> {
	if (input.maxDrops <= 0) return { ids: [], requested: 0 };
	const { system, user } = buildDropperPrompt(input);
	const response = await invoker.call({
		system,
		user,
		label: input.label ?? "dropper",
		signal: input.signal,
		sessionID: input.sessionID,
		validate: (text) => {
			extractJsonObject(text);
		},
	});
	const parsed = extractJsonObject(response.text);
	return parseDropIds(parsed, input.allowedObservationIds, input.maxDrops);
}

/** Rendered dropper payload with reflection-coverage evidence per observation. */
export function renderDropperLines(observations: readonly Observation[], reflections: readonly Reflection[]): string[] {
	const coverage = reflectionCoverageMap(observations, reflections);
	return observations.map((observation) => observationToDropperLine(observation, coverage.get(observation.id) ?? "none"));
}
