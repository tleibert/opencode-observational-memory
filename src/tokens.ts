import type { Observation } from "./types.js";

export function estimateStringTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Estimate the rendered footprint of an observation line as it appears in
 * summaries / pool listings: "[id] YYYY-MM-DD HH:MM [relevance] content".
 * Pool budgets that only count bare content undercount every line's metadata
 * overhead (id + timestamp + relevance tags).
 */
export function observationLineTokenCount(observation: {
	id: string;
	timestamp: string;
	relevance: string;
	content: string;
}): number {
	return estimateStringTokens(
		`[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
	);
}

export function reflectionLineTokenCount(reflection: { id: string; content: string }): number {
	return estimateStringTokens(`[${reflection.id}] ${reflection.content}`);
}

export function observationTokenSum(observations: readonly Observation[]): number {
	return observations.reduce((sum, observation) => sum + observationLineTokenCount(observation), 0);
}
