import type { Plugin } from "@opencode/plugin";

/**
 * The promise-plugin setup context, derived from the package's own type so the
 * port does not depend on internal module paths.
 */
export type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];
