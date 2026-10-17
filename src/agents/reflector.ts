import { hashId, truncateRecordContent } from "../ids.js";
import { REFLECTOR_SYSTEM } from "../prompts/reflector.js";
import { reflectionLineTokenCount } from "../tokens.js";
import type { Observation, Reflection } from "../types.js";
import type { WorkerInvoker } from "../transport.js";
import { asArray, asRecord, extractJsonObject, normalizeContent, WorkerOutputError } from "./json.js";

export const MAX_REFLECTIONS_PER_RUN = 50;
const MAX_CONTENT_CHARS = 10_000;

export type ReflectorInput = {
	/** Rendered existing reflections ("[id] content"). */
	reflections: string[];
	/** Rendered observation lines including the coverage tier. */
	observations: string[];
	allowedObservationIds: string[];
	knownIds?: ReadonlySet<string>;
	signal?: AbortSignal;
	label?: string;
	sessionID?: string;
};

export type ReflectorResult = {
	reflections: Reflection[];
	rejected: number;
	duplicates: number;
};

function joinOrEmpty(items: readonly string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function buildReflectorPrompt(input: Pick<ReflectorInput, "reflections" | "observations">): { system: string; user: string } {
	const user = `CURRENT REFLECTIONS:
${joinOrEmpty(input.reflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(input.observations)}

Review the current observations and return only new durable reflections as JSON. Most runs should return zero reflections.`;
	return { system: REFLECTOR_SYSTEM, user };
}

export function normalizeSupportingObservationIds(
	ids: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	const allowed = new Set(allowedObservationIds);
	const seen = new Set<string>();
	for (const id of ids) {
		if (!allowed.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen);
}

/**
 * Pi rejects reflections whose content is not a single line: a multi-line
 * reflection renders as several lines in summaries and breaks the ledger's
 * line-oriented format. The newline check must run before whitespace is
 * collapsed, otherwise a multi-line body would silently become single-line.
 */
function normalizeReflectionContent(content: unknown): string | undefined {
	if (typeof content !== "string") return undefined;
	if (/\r|\n/.test(content.trim())) return undefined;
	const normalized = normalizeContent(content, MAX_CONTENT_CHARS);
	if (!normalized) return undefined;
	return truncateRecordContent(normalized);
}

export function parseReflections(
	raw: unknown,
	allowedObservationIds: readonly string[],
	knownIds: ReadonlySet<string> = new Set(),
): ReflectorResult {
	const record = asRecord(raw);
	const items = asArray(record?.reflections);
	const reflections: Reflection[] = [];
	const seen = new Set(knownIds);
	const allowed = new Set(allowedObservationIds);
	let rejected = 0;
	let duplicates = 0;

	for (const item of items) {
		if (reflections.length >= MAX_REFLECTIONS_PER_RUN) break;
		const entry = asRecord(item);
		const content = normalizeReflectionContent(entry?.content);
		if (!entry || !content) {
			rejected++;
			continue;
		}
		const proposed = asArray(entry.supportingObservationIds).filter((id): id is string => typeof id === "string");
		const supportingObservationIds = normalizeSupportingObservationIds(proposed, allowedObservationIds);
		if (!supportingObservationIds) {
			rejected++;
			continue;
		}
		const id = hashId(content);
		if (seen.has(id)) {
			duplicates++;
			continue;
		}
		seen.add(id);
		reflections.push({
			id,
			content,
			supportingObservationIds,
			tokenCount: reflectionLineTokenCount({ id, content }),
		});
	}

	return { reflections, rejected, duplicates };
}

export async function runReflector(invoker: WorkerInvoker, input: ReflectorInput): Promise<ReflectorResult> {
	if (input.observations.length === 0) return { reflections: [], rejected: 0, duplicates: 0 };
	const { system, user } = buildReflectorPrompt(input);
	const response = await invoker.call({
		system,
		user,
		label: input.label ?? "reflector",
		signal: input.signal,
		sessionID: input.sessionID,
		validate: (text) => {
			extractJsonObject(text);
		},
	});
	const parsed = extractJsonObject(response.text);
	const result = parseReflections(parsed, input.allowedObservationIds, input.knownIds);
	if (result.reflections.length === 0 && result.rejected > 0 && result.duplicates === 0) {
		throw new WorkerOutputError(`reflector rejected all ${result.rejected} proposed reflections (invalid support ids)`);
	}
	return result;
}

export function observationLineForReflector(observation: Observation, coverage: string): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}
