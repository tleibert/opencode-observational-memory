# Changelog

## 0.2.0

Everything here came out of running the plugin against a live OpenCode session rather than
against the docs, so each entry is a bug that was observed happening.

- **`om_recall` was unreachable.** Plugin tools default into the code-mode sandbox, so the tool
  existed only as `tools.om_recall(...)` inside `execute`; a direct call answered "No tool named
  om_recall is currently available". Registered with `codemode: false` (12 tools visible to the
  model before, 13 after).
- **A superseded plugin instance degraded silently.** After a hot reload, the replaced instance's
  worker sessions were disposed and worker calls fell back to plugin-issued generation, which the
  host refuses for gated models — a live reflector died with a free-tier error 121 ms in while the
  observer on the same model worked. Teardown now aborts in-flight work and says so.
- **Workers could answer the transcript instead of the contract.** A session model replied with the
  user's prompt text it had been asked to record where JSON was required. Answers are now validated
  before they count, so an unusable reply moves to the next candidate model.
- **Nothing showed the workers were alive.** Successful observe/reflect/drop stages post one line
  into the session (`🧠 memory: +14 observations`), suppressible with `notifyMemoryUpdates` and
  filtered out of the transcript so memory never observes its own notices.
- `/om:status` and friends report failures instead of returning silently, and `/om:status` now
  includes the plugin version.

## 0.1.0

Port of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) to the
OpenCode V2 plugin API: observer/reflector/dropper workers, coverage-tracked ledger in plugin
storage, compaction hook, memory injection, `om_recall`, `/om:status`, `/om:view`, `/om:reset`.
