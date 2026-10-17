import { MEMORY_NOTICE_PREFIX } from "./memory.js";
import { estimateStringTokens } from "./tokens.js";

/**
 * Transcript adaptation.
 *
 * Pi works on branch entries; OpenCode exposes a flat message list. A
 * `SourceEntry` is this port's equivalent of a Pi source entry: it carries the
 * OpenCode message id that workers must cite as `sourceEntryIds`, the rendered
 * text, and a token estimate.
 *
 * Two message shapes reach this module:
 *  - `ctx.session.context()` returns `SessionMessageInfo[]` (persisted session messages)
 *  - the compaction hook receives the model-facing transcript (`@opencode/ai` messages)
 */

export type SourceEntry = {
	/** Stable OpenCode message id used as `sourceEntryIds` evidence. */
	id: string;
	role: string;
	text: string;
	timestampMs: number;
	tokens: number;
	/** Source entries only: system-ish records are skipped entirely. */
	kind: "user" | "assistant" | "tool" | "system";
};

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
	return typeof value === "object" && value !== null;
}

function textFromParts(parts: unknown): string {
	if (typeof parts === "string") return parts;
	if (!Array.isArray(parts)) return "";
	const out: string[] = [];
	for (const part of parts) {
		if (!isRecord(part)) {
			if (typeof part === "string") out.push(part);
			continue;
		}
		const type = typeof part.type === "string" ? part.type : "";
		if (type === "text" || type === "reasoning") {
			if (typeof part.text === "string") out.push(part.text);
			continue;
		}
		if (type === "tool" || type === "tool-call" || type === "tool-result" || type === "tool_use" || type === "tool_result") {
			const name = typeof part.name === "string" ? part.name : typeof part.toolName === "string" ? part.toolName : "tool";
			const detail =
				typeof part.output === "string"
					? part.output
					: typeof part.text === "string"
						? part.text
						: part.state !== undefined
							? stateText(part.state)
							: part.input !== undefined
								? safeJson(part.input)
								: "";
			out.push(`[Tool ${name}]${detail ? ` ${detail}` : ""}`);
		}
	}
	return out.join("\n");
}

function stateText(state: unknown): string {
	if (!isRecord(state)) return "";
	if (typeof state.output === "string") return state.output;
	if (typeof state.input === "object" && state.input !== null) return safeJson(state.input);
	if (typeof state.error === "string") return `error: ${state.error}`;
	return "";
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function tokenCountFor(text: string, tokens: unknown): number {
	if (isRecord(tokens)) {
		const input = typeof tokens.input === "number" ? tokens.input : 0;
		const output = typeof tokens.output === "number" ? tokens.output : 0;
		const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
		const read = cache && typeof cache.read === "number" ? cache.read : 0;
		const write = cache && typeof cache.write === "number" ? cache.write : 0;
		const total = input + output + read + write;
		if (total > 0) return total;
	}
	return estimateStringTokens(text);
}

/**
 * Persisted session messages (`SessionMessageInfo`). Assistant messages can
 * carry provider-reported usage; that value measures the real context size and
 * is preferred over the estimate for calibration.
 */
export function entriesFromSessionMessages(messages: readonly unknown[]): { entries: SourceEntry[]; contextTokens?: number } {
	const entries: SourceEntry[] = [];
	let contextTokens: number | undefined;

	for (const message of messages) {
		if (!isRecord(message)) continue;
		const id = typeof message.id === "string" ? message.id : undefined;
		const type = typeof message.type === "string" ? message.type : "";
		const time = isRecord(message.time) ? message.time : undefined;
		const timestampMs = time && typeof time.created === "number" ? time.created : Date.now();

		if (type === "user") {
			if (!id) continue;
			const text = typeof message.text === "string" ? message.text : "";
			entries.push({ id, role: "user", text, timestampMs, tokens: tokenCountFor(text, undefined), kind: "user" });
			continue;
		}
		if (type === "assistant") {
			if (!id) continue;
			const text = textFromParts(message.content);
			// The entry's own footprint is an estimate of its rendered text.
			// Provider usage on the message describes the WHOLE request context
			// (system prompt + tools + every prior turn), so using it here would
			// inflate the transcript by an order of magnitude; it is reported
			// separately for context calibration instead.
			const tokens = tokenCountFor(text, undefined);
			if (typeof message.tokens === "object" && message.tokens !== null) {
				const reported = tokenCountFor("", message.tokens);
				if (reported > 0) contextTokens = reported;
			}
			if (message.finish === "error") continue;
			entries.push({ id, role: "assistant", text, timestampMs, tokens, kind: "assistant" });
			continue;
		}
		if (type === "system" || type === "synthetic") {
			if (!id) continue;
			const text = typeof message.text === "string" ? message.text : "";
			// Our own "memory: ..." notices are bookkeeping, not conversation; letting
			// them through would make memory observe its own activity.
			if (text.startsWith(MEMORY_NOTICE_PREFIX)) continue;
			entries.push({ id, role: "system", text, timestampMs, tokens: estimateStringTokens(text), kind: "system" });
			continue;
		}
		// idle / agent-switched / model-switched / compaction markers are not memory sources.
	}

	return { entries, contextTokens };
}

/**
 * Model-facing transcript (the compaction hook's `event.messages`).
 * These messages are not persisted with stable OpenCode ids, so ids are
 * synthesized positionally; they are only used for a single catch-up pass.
 */
export function entriesFromAiMessages(messages: readonly unknown[]): SourceEntry[] {
	const entries: SourceEntry[] = [];
	messages.forEach((message, index) => {
		if (!isRecord(message)) return;
		const role = typeof message.role === "string" ? message.role : "unknown";
		if (role === "system") return;
		const text = textFromParts(message.content ?? message.text);
		if (!text.trim()) return;
		const id = typeof message.id === "string" ? message.id : `msg-${index}`;
		entries.push({
			id,
			role,
			text,
			timestampMs: Date.now(),
			tokens: estimateStringTokens(text),
			kind: role === "user" ? "user" : role === "tool" ? "tool" : "assistant",
		});
	});
	return entries;
}

/**
 * Render entries for the observer. Every entry carries a `[Source entry id: …]`
 * label because observation validation rejects any id the worker did not see.
 */
export function renderChunk(entries: readonly SourceEntry[]): string {
	return entries
		.map((entry) => `[Source entry id: ${entry.id}] ${formatTimestamp(entry.timestampMs)} ${entry.role}:\n${entry.text}`)
		.join("\n\n");
}

export function renderEntryLine(entry: SourceEntry): string {
	return `[${entry.id}] ${formatTimestamp(entry.timestampMs)} ${entry.role}: ${truncate(entry.text, 400)}`;
}

export function formatTimestamp(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}`
	);
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

export type ChunkSlice = {
	entries: SourceEntry[];
	firstId?: string;
	lastId?: string;
	tokens: number;
};

/**
 * Take a token-bounded slice of entries starting at `startIndex`, always
 * including at least one entry so a single oversized entry cannot stall
 * observation forever.
 */
export function sliceEntries(entries: readonly SourceEntry[], startIndex: number, maxTokens: number): ChunkSlice {
	const slice: SourceEntry[] = [];
	let tokens = 0;
	for (let i = startIndex; i < entries.length; i++) {
		const entry = entries[i];
		// Defensive: an entry without a numeric estimate must not defeat the bound.
		const cost = typeof entry.tokens === "number" && Number.isFinite(entry.tokens) ? entry.tokens : estimateStringTokens(entry.text ?? "");
		if (slice.length > 0 && tokens + cost > maxTokens) break;
		slice.push(entry);
		tokens += cost;
	}
	return {
		entries: slice,
		firstId: slice[0]?.id,
		lastId: slice[slice.length - 1]?.id,
		tokens,
	};
}

export function indexOfEntry(entries: readonly SourceEntry[], id: string | null | undefined): number {
	if (!id) return -1;
	return entries.findIndex((entry) => entry.id === id);
}

export function tokensAfter(entries: readonly SourceEntry[], index: number): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) total += entries[i].tokens;
	return total;
}

export function tokensBetween(entries: readonly SourceEntry[], fromExclusive: number, toInclusive: number): number {
	let total = 0;
	for (let i = Math.max(0, fromExclusive + 1); i <= toInclusive && i < entries.length; i++) total += entries[i].tokens;
	return total;
}
