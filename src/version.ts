import { readFileSync } from "node:fs";

/**
 * Version of the package this plugin was loaded from.
 *
 * The plugin ships as TypeScript source and is loaded either from a path in the
 * plugins array or as an npm package, so the only reliable answer lives in
 * package.json next to the entrypoint. It is reported in the startup log line
 * and by /om:status, which makes "which build is my OpenCode actually running"
 * a question you can answer without guessing.
 */
export function pluginVersion(): string {
	try {
		const url = new URL("../package.json", import.meta.url);
		const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "unknown";
	} catch {
		return "unknown";
	}
}

export const PLUGIN_VERSION = pluginVersion();
