# code-mode: persistent REPL + tool gating for Pi

As-built design for the shipped extension. A Pi extension replicating Claude Code's [code-mode](https://code.claude.com/docs/en/code-mode): the model writes JavaScript into a single REPL tool, session tools become script functions, only distilled output enters the context window — with two capabilities Pi's built-in `codemode` tool lacks: a worker whose REPL state persists across calls, and session-level steering of which tools the model sees directly. This document describes the code that ships; `scripts/check-docs.mjs` asserts it against the repository on every push, so a stale claim fails the suite instead of waiting for a reviewer to notice.

## 1. Surfaces

A user touches the extension two ways:

- **The `code_mode` tool.** The model writes JavaScript; it runs in a long-lived worker process. Session tools are callable as `await tools.<name>(args)`; the discovery globals `ALL_TOOLS`, `searchTools(query)`, `describeTool(name)`, `describeNamespace(name)` list and explain what is callable; `text(s)`, `image(data, mimeType)`, `exit(value)` shape the returned distillate; captured `console.*` rides along as output items.
- **The `/code-mode` command.** `on` (default) keeps every tool declared but annotates descriptions with a codemode hint; `only` hides direct declarations (they stay callable from scripts) and lists them inside the `code_mode` description; `off` unregisters the REPL; `status` reports the mode and where it came from. Without a session override the mode comes from settings, read at one boundary in `gating.ts`: the nested `codemode.mode` key is the accepted shape, and the two observed flat spellings (`codemode.mode`, `code-mode.mode`) are ignored loudly with a warning naming the nested shape.

## 2. Modules and ownership

Each module owns one concern; the boundaries are load-bearing, not decorative:

- `index.ts` — the adapter, and only that: register the tool, the command, the session hooks; forward events; map settled outcomes to the public result shape. Mode, formatting, and lifecycle logic live elsewhere.
- `protocol.ts` — the fork-IPC contract as the single source: every message shape crossing the fork, the runtime guards both sides use (`isWorkerInMessage`, `isWorkerOutMessage`), the tool-name identifier mapping (`toIdentifier`), and the discovery names. Import-free and free of non-erasable TypeScript so plain Node type stripping loads it from either side of the fork.
- `lifecycle.ts` — the pure exec-lifecycle core: a `step()` transition table over the states `idle`, `booting`, `ready`, `running` and the events `execRequested`, `booted`, `bootFailed`, `workerMessage` (`end`/`toolCall`), `workerDied`, `stopRequested`, `timeoutFired`, `toolAnswered`. Exec futures are resolve-only: every accepted exec settles exactly once, and a dropped settlement has no representation.
- `worker-host.ts` — the effect interpreter and the only place that touches `node:child_process` or timers: spawn (permission-model flags best-effort with a per-boot plain retry, boot timeout, stderr capture, a gitignored pidfile breadcrumb of parent + child pid), kill, send, exec timers, tool answering.
- `compile.ts` — the one compile path: acorn parse, async-IIFE rewrite so top-level `await` works, `globalThis` capture of new declarations, and redeclare detection that throws `Identifier 'x' has already been declared — reassign without const instead`.
- `gating.ts` — the one owner of session mode: `parseModeSetting` (the settings boundary), `resolveMode` and the mode-owner state, the loadout builders pi renders, and `handleCommand`, the pure `/code-mode` decision the adapter side-effects (so `off` still stops the worker there).
- `format.ts` — every result section the model sees: output budget, value or error section, interrupted-run journal, stateLost note.
- `repl-worker.js` — the forked worker: persistent `node:vm` context, a tool bridge that validates every message against the protocol, disconnect self-exit.

## 3. The fork-IPC protocol

`protocol.ts` is the contract; both sides derive from it and the guards run on every message.

- Host → worker: `{type:"exec", id, code, tools}` starts one script; `{type:"toolResult", callId, ok, value?, error?}` answers one nested tool call; `{type:"ping"}` is the liveness probe.
- Worker → host: `{type:"ready"}` after boot; `{type:"toolCall", callId, name, args}` requests a session tool; `{type:"end", id, ok, value?, error?, output}` settles the exec with the distilled output.
- Output items are `{type:"text", text, console?}` or `{type:"image", data, mimeType}` (the worker's `image()` helper emits the image variant); the protocol type models both, and format.ts filters for text items when rendering.
- Tool names that are not identifiers map through `toIdentifier` (`mcp__docs__search` style), so the name a script calls is the name the bridge resolves.

## 4. The lifecycle property

**A `code_mode` call always returns to the model, and its outcome honestly says what happened.** Whatever happens to the worker while a script runs — it finishes, hangs until timeout, is killed by `/code-mode off`, crashes, or the session switches — the pending exec settles and every later call still settles. The outcome says which world: an `end` delivery is `ok:true stateLost:false`; a timeout or worker stop is `ok:false stateLost:true`; a late `end` for a settled exec is dropped.

Two assets keep the property true rather than remembered:

- `test-lifecycle-core.mjs` sweeps every state × event pair of `step()` (totality, no-exec-vanishes, timer pairing, honest outcomes, FIFO drain).
- `.claude/skills/exec-lifecycle/check-exec-lifecycle.mjs` interleaves the real adapter (loaded through jiti with a stubbed pi API) with real forked workers over 85 bounded scenarios, plus a `--real` probe that SIGKILLs an actual `repl-worker.js` mid-exec. It runs locally; it needs a local pi installation for jiti, so CI does not carry it.

`worker-host.ts` writes the pidfile breadcrumb for exactly one consumer: `scripts/worker-cleanup.mjs`, which kills only the child pids of a given pid and never matches by process name.

## 5. Compile path

Every script, in the worker and in the drift tests, goes through the same `compileScript`: acorn parses once, new declarations are captured onto `globalThis`, the body is rewritten as an async IIFE so top-level `await` and `return` work, and redeclaring a persisted name throws the taught SyntaxError. `test-compile.mjs` runs the real compiler against a real vm in-process — a compile-semantics fix is proven there first, and the worker only re-proves the protocol layer.

## 6. Gating

`gating.ts` owns everything the modes do:

- `parseModeSetting` is the single settings boundary: nested `codemode.mode` wins; a flat dotted key returns mode `on` with a `warning` naming the nested shape (surfaced at session start through `ui.notify`, stderr when there is no UI); any other value falls back to `on`.
- The session override (`/code-mode on|off|only`) wins over settings; `/code-mode status` reports both the mode and its source.
- Loadout builders turn the resolved mode into what pi renders: `on` annotates descriptions (never `code_mode` itself); `only` returns `hiddenDeclarations` plus a `code_mode` description listing every callable tool as `tools.<id>(args)`; `off` returns undefined, which unregisters the tool.
- `handleCommand` is the pure decision; the adapter applies its side effects, which is why `off` still stops the worker.

## 7. Output distillation

`format.ts` caps a script's output for the model at 20 000 characters: past the budget it keeps a 14 000-character head and a 5 000-character tail and marks the elision with `... [head-and-tail omitted N bytes] ...`, where N is the true byte count of the omitted slice. The marker claims nothing else: no file is written anywhere in this path. The stateLost note `(REPL state was lost)` appears exactly once whatever else the outcome carries, and a non-empty interrupted-run journal lists the tool calls that landed before the interruption.

## 8. Honest limits

- REPL state lives in the worker: lost on Pi restart, session switch, timeout (worker killed and respawned), or crash. The model is told explicitly each time.
- Only text output items are formatted today; `image()` items ride in the output list without a formatted section.
- Deep imports of internal modules are blocked by the `exports` map; the entry still resolves.
- The interleaving checker needs a local pi installation (jiti path), so it gates changes locally and at merge time, not in hosted CI.

## 9. Gates

CI runs five suites on every push and pull request: `test-worker.mjs` (30), `test-compile.mjs` (32), `test-lifecycle-core.mjs` (56), `test-format.mjs` (14), and `scripts/check-docs.mjs`. Locally, `.claude/skills/exec-lifecycle/check-exec-lifecycle.mjs` adds the 85-scenario interleaving check, and `.claude/skills/verify/` holds the driver skill, feature recipes, and helpers for proving user-facing behavior end to end on a real session. `scripts/check-docs.mjs` keeps this document and the README assertable: named paths must be tracked, every shipped file must be listed, quoted literals must exist in the code, and the claims the rearchitecture killed must stay dead.
