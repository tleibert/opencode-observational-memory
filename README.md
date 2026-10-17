# opencode-observational-memory

> **Make OpenCode sessions feel endless.**

Observational memory for [OpenCode](https://opencode.ai): a direct port of
[`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) (MIT) to the
OpenCode V2 plugin API.

OpenCode compresses long sessions by summarizing them. Summaries of summaries lose the things that
matter: why a decision was made, what was already rejected, which constraint still applies. This
plugin keeps a durable, structured memory of the session — **observations** (timestamped, rated
events) and **reflections** (long-lived facts) — observing continuously in the background so that
compaction has almost nothing left to do when it arrives.

```
session turns ──▶ observer ──▶ observations ──▶ reflector ──▶ reflections
                     ▲                              │
                     │                              ▼
             thresholds (tokens)              dropper (pool budget)
                     └─────────── compaction: summary from memory ◀───┘
```

## Install

Add the plugin to the project's `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/opencode-observational-memory"
  ]
}
```

Published packages work the same way by name:

```jsonc
{
  "plugins": [
    { "package": "opencode-observational-memory", "options": { "model": "anthropic/claude-sonnet-4-5" } }
  ]
}
```

Add the same block to `~/.config/opencode/opencode.jsonc` to enable it for every project (that is
how this repo's author runs it), or drop it in `.opencode/plugins/observational-memory/` to load it
without config.

### Worker model

Memory work (observing, reflecting, pruning) runs on a model of its own. By default the plugin
walks a candidate list and settles on the first model that answers:

1. `model` from the options — explicit choice always wins
2. `fallbackModel` from the options
3. the model the **session** is running
4. any **free** model the host knows about
5. the cheapest **paid** model — only when `allowPaidWorkerModel` is on

```jsonc
{
  "plugins": [
    {
      "package": "opencode-observational-memory",
      "options": {
        "model": "anthropic/claude-haiku-4-5",
        "fallbackModel": "openai/gpt-5.1"
      }
    }
  ]
}
```

**Free-tier session models.** A session can run on a gated free model while plugin-issued
generation is refused for it, because the host treats background calls differently:

```
Generate.UnavailableError: OpenCode's free tier can only be used from within OpenCode.
```

That is server-side policy and no header or client hint changes it (see the note below). The plugin
handles it by learning the refusal, skipping the rest of that provider's free tier, and moving to a
model that does work — usually another free model, so memory keeps running at zero cost. Refusals
and transient failures are cached (permanent for gated models, 60s cooldown for timeouts), and the
model that answered is remembered for the session, so the search is only paid once.

`allowPaidWorkerModel` is **off** by default: if only paid models remain, memory stages log a clear
failure and skip rather than spending money you did not ask for.

> If every candidate fails, `/om:status` shows the resolved worker model and the last failure reason.

## What it does

| Hook | Behaviour |
| --- | --- |
| `prompt` | Cancels in-flight memory work so workers yield to the session. |
| `context` | Injects the rendered memory block (reflections + observations) into the system prompt. |
| `compaction` | Observes the uncovered gap synchronously, then **supplies the summary itself**, skipping the summarizer model call. Declines ownership when it cannot cover the gap. |
| `session.idle`, `session.execution.succeeded` | Background consolidation: observe → reflect → drop. |

Commands (no model turn spent):

- `/om:status` — pool size, coverage markers, worker runs, model, failures.
- `/om:view` — active observations and reflections.
- `/om:reset` — clear this session's memory.

Tool:

- `om_recall` — search active memory, or fetch one record by id. The system prompt told the agent to
  use it when a memory id needs exact context.

## Configuration

Set via plugin `options` or `OM_*` environment variables (environment wins).

| Option | Env | Default | Purpose |
| --- | --- | --- | --- |
| `observeAfterTokens` | `OM_OBSERVE_AFTER_TOKENS` | `10000` | Uncovered source tokens that make an observation run due. |
| `reflectAfterTokens` | `OM_REFLECT_AFTER_TOKENS` | `20000` | Observed tokens since the reflector marker before reflection is due. |
| `compactAfterTokens` | `OM_COMPACT_AFTER_TOKENS` | `81000` | Observed source tokens since the last compaction before compaction is requested. |
| `compactAfterTokensMode` | `OM_COMPACT_AFTER_TOKENS_MODE` | `calibrated` | `calibrated` scales the threshold by context window; `fixed` uses the raw value. |
| `compactAfterTokensRatio` | `OM_COMPACT_AFTER_TOKENS_RATIO` | `0.68` | Ratio used in `calibrated` mode. |
| `observationsPoolMaxTokens` | `OM_OBSERVATIONS_POOL_MAX_TOKENS` | `20000` | Hard cap for the active observation pool. |
| `observationsPoolTargetTokens` | `OM_OBSERVATIONS_POOL_TARGET_TOKENS` | half of max | Target the dropper prunes toward. |
| `compactionSummaryMaxTokens` | `OM_COMPACTION_SUMMARY_MAX_TOKENS` | 12.5% of window | Budget for the rendered compaction summary. |
| `compactionMaxRetainedTokens` | `OM_COMPACTION_MAX_RETAINED_TOKENS` | 50% of window | Unobserved gap above which the plugin declines ownership of compaction. |
| `compactionCatchUpMaxChunks` | `OM_COMPACTION_CATCH_UP_MAX_CHUNKS` | `2` | Observer chunks run synchronously inside compaction. |
| `workerMemoryMaxTokens` | `OM_WORKER_MEMORY_MAX_TOKENS` | 25% of window | Budget for the injected memory block. |
| `agentMaxTokens` | `OM_AGENT_MAX_TOKENS` | `32000` | Worker output budget hint. |
| `model` | `OM_MODEL` | session model | Worker model as `provider/model[#variant]`. |
| `fallbackModel` | `OM_FALLBACK_MODEL` | – | Tried before the session model when the primary worker model fails. |
| `allowPaidWorkerModel` | `OM_ALLOW_PAID_WORKER_MODEL` | `false` | Allow falling back to a paid worker model when no free model works. |
| `consolidateWhenIdle` | `OM_CONSOLIDATE_WHEN_IDLE` | `true` | Background consolidation on settled turns. |
| `observeBeforeRequest` | `OM_OBSERVE_BEFORE_REQUEST` | `false` | Observe synchronously before each agent request (deterministic; for headless/scripted runs). |
| `injectMemory` | `OM_INJECT_MEMORY` | `true` | Inject memory into the system prompt. |
| `passive` | `OM_PASSIVE` | `false` | Observe only: never write compaction summaries, never inject. |
| `debugLog` | `OM_DEBUG_LOG` | `false` | Write a debug log. |
| `debugLogPath` | `OM_DEBUG_LOG_PATH` | `~/.local/share/opencode/om-debug.log` | Log location. |

## How it differs from the Pi original

This is a port, not a copy. The memory model (observation validation, coverage tiers, pool budgets,
summary budgeting, compaction ownership) is carried over; the host boundary is new.

- **JSON-mode workers.** Pi runs workers as agent loops with `record_observations` /
  `record_reflections` / `drop_observations` tools. OpenCode's generate API is a one-shot text call,
  so workers return one JSON object per call, validated locally with the same rules (unknown source
  ids rejected, duplicates skipped by content hash, single-line reflections, capped drop counts).
- **Ledger storage.** Pi stores memory as custom session entries. OpenCode exposes plugin-scoped
  storage instead, so the ledger lives under `memory/<sessionID>` and coverage markers name OpenCode
  message ids.
- **Compaction retention.** Pi can move `firstKeptEntryId` back to retain unobserved source.
  OpenCode does not expose a retention boundary to plugins, so the hook replaces it with: synchronous
  catch-up observation → decline ownership when the unobserved gap exceeds `compactionMaxRetainedTokens`
  (OpenCode's native summarizer then covers raw source) → otherwise supply a summary built from memory.
- **Not ported:** the TUI view (`/om:view` prints into the session instead), pi-specific worker
  streaming/auth plumbing, and thinking-level/output-token knobs the generate API does not expose.

### Fixed behaviours carried over

These are the semantics of the current upstream version, deliberately not the older, buggier
behaviour:

- Coverage markers are positional claims: a worker that advances one must have read every source
  entry after the previous marker, and catch-up always walks from the global frontier — not from the
  gap start — so unread source can never be silently marked observed.
- Compaction never discards unobserved context: catch up, retain, or delegate to the native
  summarizer.
- An empty memory renders no summary; OpenCode's own summarizer runs instead.
- Worker failures retry once (optionally against `fallbackModel`), are recorded, log, and back off
  for a minute instead of re-firing every settled turn.
- Workers are cancelled as soon as the user sends a new prompt.
- Reflections are rejected if they are not a single line, and no reflection may cite an observation
  id it did not receive.

## Development

```bash
npm install
npm run typecheck
npm test
```

Layout:

```
index.ts                 plugin entrypoint (OpenCode resolves path plugins by `index`/`server`)
src/plugin.ts            host wiring: hooks, events, tool, commands
src/hooks/compaction.ts  compaction ownership decision
src/memory.ts            orchestration: coverage clocks, stages, budgets, rendering
src/agents/*             observer / reflector / dropper prompts + validation
src/prompts/*            system prompts (ported from pi-observational-memory)
src/types.ts             ledger types and validators
src/transcript.ts        OpenCode messages → source entries
src/transport.ts         memory worker calls (retry + fallback model)
```

To see what the plugin is doing, enable `debugLog` — it records worker responses, chunk records,
coverage markers, injections, and compaction outcomes.

## Attribution

The memory design, prompts, and validation rules come from
[`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) by elpapi42 and
contributors (MIT). This port keeps the MIT license and the upstream design intent; bugs introduced
here are this repository's own.

## License

MIT — see [LICENSE](./LICENSE).
