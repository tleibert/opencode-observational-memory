/**
 * Core memory types.
 *
 * Ported from pi-observational-memory's session ledger (V3 memory model) with
 * the host-shaped `Entry` type replaced by OpenCode's message ids: coverage
 * markers reference OpenCode message ids instead of Pi branch entry ids.
 */

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export type Observation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	/** OpenCode message ids that directly support this observation. */
	sourceEntryIds: string[];
	tokenCount: number;
};

export type Reflection = {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
};

export type CompactionRecord = {
	/** OpenCode message id of the compaction marker, when available. */
	id: string | null;
	at: number;
	observations: number;
	reflections: number;
	fullFold: boolean;
};

export type MemoryStats = {
	observerRuns: number;
	reflectorRuns: number;
	dropperRuns: number;
	failures: number;
	inputTokens: number;
	outputTokens: number;
};

export type MemoryState = {
	version: 1;
	sessionID: string;
	createdAt: number;
	updatedAt: number;
	observations: Observation[];
	reflections: Reflection[];
	/** Observation ids removed from active memory (kept for audit). */
	droppedObservationIds: string[];
	/** Coverage marker: last message id the observer has processed. */
	observedThrough: string | null;
	/** Coverage marker: last message id the reflector has reviewed. */
	reflectedThrough: string | null;
	/** Coverage marker: last message id the dropper has reviewed. */
	droppedThrough: string | null;
	/**
	 * Newest source entry id at the moment the last memory summary was written.
	 * OpenCode owns the compaction retention boundary, so this stands in for
	 * Pi's `firstKeptEntryId`: it measures "source since the last compaction".
	 */
	compactedThroughId: string | null;
	compactions: CompactionRecord[];
	stats: MemoryStats;
};

export function emptyMemoryState(sessionID: string): MemoryState {
	const now = Date.now();
	return {
		version: 1,
		sessionID,
		createdAt: now,
		updatedAt: now,
		observations: [],
		reflections: [],
		droppedObservationIds: [],
		observedThrough: null,
		reflectedThrough: null,
		droppedThrough: null,
		compactedThroughId: null,
		compactions: [],
		stats: { observerRuns: 0, reflectorRuns: 0, dropperRuns: 0, failures: 0, inputTokens: 0, outputTokens: 0 },
	};
}

export function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.timestamp) &&
		isRelevance(value.relevance) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isReflection(value: unknown): value is Reflection {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isNonEmptyStringArray(value.supportingObservationIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isMemoryState(value: unknown): value is MemoryState {
	if (!isPlainRecord(value)) return false;
	return (
		value.version === 1 &&
		isNonEmptyString(value.sessionID) &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection) &&
		Array.isArray(value.droppedObservationIds) &&
		value.droppedObservationIds.every(isNonEmptyString) &&
		(value.observedThrough === null || isNonEmptyString(value.observedThrough)) &&
		(value.reflectedThrough === null || isNonEmptyString(value.reflectedThrough)) &&
		(value.droppedThrough === null || isNonEmptyString(value.droppedThrough))
	);
}
