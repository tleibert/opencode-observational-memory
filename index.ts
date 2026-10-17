/**
 * Plugin entrypoint.
 *
 * OpenCode resolves path-based plugins by looking for `server` or `index` in the
 * plugin directory (it does not read `package.json` `exports` for path targets),
 * while published packages resolve through `exports`. This root module keeps both
 * install styles working.
 */
import { createPlugin } from "./src/plugin.js";

export default createPlugin();
