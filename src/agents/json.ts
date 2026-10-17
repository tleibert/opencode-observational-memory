/**
 * JSON-mode worker output parsing.
 *
 * Pi's workers returned records through tools; this port asks for one JSON
 * object per call. Models still occasionally wrap it in prose or code fences,
 * so extraction is explicit and then every record is validated structurally
 * before it is trusted (see the individual agent modules).
 */
export function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	const direct = tryParse(trimmed);
	if (direct !== undefined) return direct;

	// Fenced block: ```json { ... } ```
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		const parsed = tryParse(fenced[1].trim());
		if (parsed !== undefined) return parsed;
	}

	// First balanced object in the text.
	const start = trimmed.indexOf("{");
	if (start >= 0) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < trimmed.length; i++) {
			const char = trimmed[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') {
				inString = true;
				continue;
			}
			if (char === "{") depth++;
			else if (char === "}") {
				depth--;
				if (depth === 0) {
					const parsed = tryParse(trimmed.slice(start, i + 1));
					if (parsed !== undefined) return parsed;
					break;
				}
			}
		}
	}

	throw new WorkerOutputError("worker did not return a JSON object");
}

export class WorkerOutputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerOutputError";
	}
}

function tryParse(text: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Normalize a model-produced string: collapse whitespace, trim, bound length. */
export function normalizeContent(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}… [truncated]`;
}
