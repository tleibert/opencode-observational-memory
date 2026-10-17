import { formatLocalTimestamp, hashId, nowTimestamp, truncateRecordContent } from "../ids.js";
import { OBSERVER_SYSTEM } from "../prompts/observer.js";
import { observationLineTokenCount } from "../tokens.js";
import type { Observation, Relevance } from "../types.js";
import { isRelevance } from "../types.js";
import type { WorkerInvoker } from "../transport.js";
import { asArray, asRecord, extractJsonObject, normalizeContent, WorkerOutputError } from "./json.js";

export const OBSERVATION_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$/;
export const MAX_OBSERVATIONS_PER_RUN = 200;
const MAX_CONTENT_CHARS = 10_000;

export type ObserverInput = {
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	/** Ids printed in the chunk; observations citing anything else are rejected. */
	allowedSourceEntryIds: string[];
	/** Already-known memory ids, to keep re-observations out of the ledger. */
	knownIds?: ReadonlySet<string>;
	signal?: AbortSignal;
	label?: string;
	sessionID?: string;
};

export type ObserverResult = {
	observations: Observation[];
	rejected: number;
	duplicates: number;
};

function joinOrEmpty(items: readonly string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function buildObserverPrompt(input: Pick<ObserverInput, "priorReflections" | "priorObservations" | "chunk">): {
	system: string;
	user: string;
} {
	const now = nowTimestamp();
	const user = `Current local time: ${now}

CURRENT REFLECTIONS:
${joinOrEmpty(input.priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(input.priorObservations)}

Compress the following new conversation chunk into observations. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Cover the whole chunk in a single JSON response.

NEW CONVERSATION CHUNK:
${input.chunk}`;
	return { system: OBSERVER_SYSTEM, user };
}

export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);

	const seen = new Set<string>();
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

function observationTimestamp(value: unknown): string {
	if (typeof value === "string" && OBSERVATION_TIMESTAMP_PATTERN.test(value)) return value;
	if (typeof value === "number" && Number.isFinite(value)) return formatLocalTimestamp(new Date(value));
	return nowTimestamp();
}

/**
 * Validate a batch produced by the observer. Mirrors pi-observational-memory's
 * `record_observations` tool semantics: unparseable or unsupported records are
 * rejected rather than repaired, duplicates are skipped by content hash, and
 * accepted observations are ordered by their supporting source entries.
 */
export function parseObservations(
	raw: unknown,
	allowedSourceEntryIds: readonly string[],
	knownIds: ReadonlySet<string> = new Set(),
): ObserverResult {
	const record = asRecord(raw);
	const items = asArray(record?.observations);
	const observations: Observation[] = [];
	const seen = new Set(knownIds);
	let rejected = 0;
	let duplicates = 0;
	const order = new Map(allowedSourceEntryIds.map((id, index) => [id, index]));

	for (const item of items) {
		if (observations.length >= MAX_OBSERVATIONS_PER_RUN) break;
		const entry = asRecord(item);
		const content = normalizeContent(entry?.content, MAX_CONTENT_CHARS);
		if (!entry || !content) {
			rejected++;
			continue;
		}
		const sourceEntryIds = normalizeSourceEntryIds(asArray(entry.sourceEntryIds).filter((id): id is string => typeof id === "string"), allowedSourceEntryIds);
		if (!sourceEntryIds) {
			rejected++;
			continue;
		}
		const relevance = isRelevance(entry.relevance) ? (entry.relevance as Relevance) : "medium";
		const timestamp = observationTimestamp(entry.timestamp);
		const id = hashId(content);
		if (seen.has(id)) {
			duplicates++;
			continue;
		}
		seen.add(id);
		const bounded = truncateRecordContent(content);
		observations.push({
			id,
			content: bounded,
			timestamp,
			relevance,
			sourceEntryIds,
			tokenCount: observationLineTokenCount({ id, timestamp, relevance, content: bounded }),
		});
	}

	observations.sort((a, b) => {
		const first = order.get(a.sourceEntryIds[0]) ?? 0;
		const second = order.get(b.sourceEntryIds[0]) ?? 0;
		return first - second;
	});
	return { observations, rejected, duplicates };
}

export async function runObserver(invoker: WorkerInvoker, input: ObserverInput): Promise<ObserverResult> {
	if (!input.chunk.trim()) return { observations: [], rejected: 0, duplicates: 0 };
	const { system, user } = buildObserverPrompt(input);
	const response = await invoker.call({ system, user, label: input.label ?? "observer", signal: input.signal, sessionID: input.sessionID });
	const parsed = extractJsonObject(response.text);
	const result = parseObservations(parsed, input.allowedSourceEntryIds, input.knownIds);
	if (result.observations.length === 0 && result.rejected > 0 && result.duplicates === 0) {
		throw new WorkerOutputError(`observer rejected all ${result.rejected} proposed observations (invalid source ids)`);
	}
	return result;
}
