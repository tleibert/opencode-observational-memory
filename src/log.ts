import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";

export type Logger = {
	debug(message: string, detail?: unknown): void;
	warn(message: string, detail?: unknown): void;
	error(message: string, detail?: unknown): void;
	/** Most recent lines, newest last (used by `/om status`). */
	recent(limit?: number): string[];
	path?: string;
};

const MAX_RECENT = 200;

export function defaultLogPath(): string {
	const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return join(dataHome, "opencode", "om-debug.log");
}

export function createLogger(config: Config): Logger {
	const path = config.debugLog ? (config.debugLogPath ?? defaultLogPath()) : undefined;
	const recent: string[] = [];
	if (path) {
		try {
			mkdirSync(dirname(path), { recursive: true });
		} catch {
			// Logging must never break a session.
		}
	}

	const write = (level: string, message: string, detail?: unknown) => {
		const line = `${new Date().toISOString()} [${level}] ${message}${detail === undefined ? "" : ` ${safeStringify(detail)}`}`;
		recent.push(line);
		if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
		if (level !== "debug") console.error(`[observational-memory] ${message}`);
		if (!path) return;
		try {
			appendFileSync(path, `${line}\n`);
		} catch {
			// ignore
		}
	};

	return {
		debug: (message, detail) => write("debug", message, detail),
		warn: (message, detail) => write("warn", message, detail),
		error: (message, detail) => write("error", message, detail),
		recent: (limit = 20) => recent.slice(-limit),
		path,
	};
}

function safeStringify(value: unknown): string {
	try {
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Human-readable error text for logs and status output. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}
