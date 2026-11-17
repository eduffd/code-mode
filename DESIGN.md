# code-mode: persistent REPL + tool gating for Pi

Design for a Pi extension replicating Claude Code's [code-mode](https://code.claude.com/docs/en/code-mode): the model writes JavaScript into a single REPL tool, session tools become script functions, only distilled output enters the context window — with two capabilities Pi's built-in `codemode` tool lacks:

1. **Persistent REPL state** — variables survive across REPL calls within a session (built-in: fresh sandbox per call; only `store()`/`load()` survives, JSON-only, 256 KB per value).
2. **Session-level tool gating** — a `/code-mode` command switches the session into a mode where direct tools are hidden from the model, steering work through the REPL (built-in `codemode.mode: only` is a global settings toggle, not session-controllable).

**Scope (agreed):** core only — persistence + gating. Out of scope for v1: background/poll execution, subagent spawning from scripts. Extension first; plugin packaging later if needed for distribution.

## 1. Research findings

| Question | Finding |
|---|---|
| Can `CodemodeSandbox` be reused across calls? | **No.** Its own docs: "Each `execute()` gets its own VM; the sandbox only holds the tool table and defaults." Prelude is not exported; VM torn down per call. |
| Sanctioned escape hatch? | **Yes.** `docs/extensions.md` §Tool Exposure: *"codemode uses only this hook, `exposure`, `reachesTools`, and `ctx.executeTool()`, so another tool can implement the same behavior under a different name."* |
| Does hiding a tool break script calls to it? | **No.** Hidden direct tools stay active + callable; only declarations are omitted from model requests. Script calls go through `ctx.executeTool` → full pipeline (validation, hooks, permissions, MCP). |
| Reuse `createCodemodeExtension`? | **No.** It registers the fresh-per-call `codemode` tool; nesting two codemode tools is explicitly unsupported. New tool under a new name (`code_mode`). |
| Gating mechanism | `prepareLoadout(loadout)` → return `hiddenDeclarations` (mirrors built-in `prepareCodemodeLoadout` "only" mode). Hidden tools' prompt guidelines become the `code_mode` tool description's responsibility. |
| `ctx.executeTool` semantics | Never rejects for tool failures (result with `isError: true`); nested calls validated, hooked, permission-checked; don't appear in transcript (bounded `nestedCalls` record). |
| Node version | v26.3.0 — permission model (`node --permission`) available. |

## 2. Architecture

```
Pi agent (extension API, in-process)
│
├── registerTool("code_mode")            ← the REPL tool the model calls
│     execute({ code }) →
│        1. reach logic on code (same word-scan as built-in) → reachable tools
│        2. ensureWorker(): fork long-lived repl-worker.js (persistent Node vm context)
│        3. send { id, code, tools } → worker evaluates in its persistent context
│        4. worker requests tool calls over fork IPC → extension runs
│           ctx.executeTool(name, args) → posts result back → worker's awaiting promise resolves
│        5. output items (text/console/image) → truncation → distilled result to model
│
├── prepareLoadout hook on code_mode     ← gating (mirrors built-in "only" mode)
│     mode "only" → hiddenDeclarations for direct tools (stay active+callable)
│     mode "on"   → rewrite callable tool descriptions: "prefer calling via code_mode"
│
└── registerCommand("/code-mode", ...)   ← session-level mode: on | off | only | status
```

### 2.1 Persistent worker — the core gap

**Rejected:** reuse of `CodemodeSandbox` (one VM per execute, verified) and warm-QuickJS re-entry (prelude not exported).

**Chosen:** a long-lived Node **child process** (`child_process.fork` of `repl-worker.js`, fork IPC for messages). User code runs in the worker inside a **`node:vm` context created once at boot**; every script runs against that same context.

Sandboxing of the worker process: `node --permission --allow-fs-read=<ext-dir>` (no cli/fs/write by default). Best-effort hardening, not the security boundary — Pi extensions already run in-process with full OS permissions; the worker's trust level equals the built-in codemode worker's.

**Persistence mechanics (verified empirically):**

- Top-level `var`/`function` declarations in `vm.runInContext` attach to `globalThis` → persist.
- Top-level `let`/`const`/`class` live in the realm's **global lexical environment**, shared by all scripts in the same context → persist across calls. Verified: `const x = 42` in call 1 is readable in call 2.
- Redeclaring (`const x` again) throws SyntaxError — correct REPL semantics; the model reassigns (`x = 9`).
- **Top-level `await` does not compile in a `vm.Script`** — and the model will write `const r = await tools.read(...)` constantly.

**One compile path (compile.ts):**

Every script takes the same path, with or without top-level `await`: compile.ts parses it once with acorn (`allowAwaitOutsideFunction`, `allowReturnOutsideFunction`) and rewrites it into `(async () => { … })()` with `globalThis` capture.

- `const x = E` / `let x = E` / `var x = E`: the declaration stays, then `globalThis.x = x;` follows it. Bare `x` references resolve to `globalThis.x`, in this script and in later ones.
- `function f() {}` → `globalThis.f = f;` after the declaration, preserving intra-script hoisting; `class C {}` captured in place.
- Destructured declarators (`const { a, b } = …`, `const [a] = …`) → per-binding capture via a small binding-name extractor.
- Nested/block-scoped declarations (`for (const…)`, inside blocks/functions) are **not** rewritten — only direct children of Program.
- The last top-level expression statement becomes an explicit `return`, so completion values behave like a REPL.
- The worker keeps the captured names (`persisted`); redeclaring one in a later exec throws the taught `SyntaxError` ("… has already been declared — reassign without const instead") before the script runs. Plain assignment reassigns.
- An acorn `SyntaxError` for invalid code reaches the model unchanged.

The worker JIT-warms this path at boot (2000 unique-source parses plus 25 full runs, ~50 ms, bounded by constants) so the first exec costs what the thousandth costs. The warmup calls `compileScript`, so it adds no second path.

Result capture: the worker awaits the script's promise; resolved value (or `undefined`) + thrown errors go back over IPC.

### 2.2 Tool calls from scripts

Injected into the context at boot:

```js
// worker-side bridge, host code inside the worker process
globalThis.tools = new Proxy({}, { get: (_, name) => (args) => __cm_callTool(name, args) });
```

- Script calls `await tools.read({ path })`.
- `__cm_callTool` posts `{ type: "toolCall", callId, name, args }` over fork IPC and returns a promise stored in a pending map.
- Extension side: `ctx.executeTool(name, args)` (validation, permissions, hooks — same as built-in). On result: `{ type: "toolResult", callId, ok, text/structured }` → worker resolves the pending promise.
- Discovery globals (like built-in): `ALL_TOOLS`, `searchTools(query)`, `describeTool(name)`, `describeNamespace(name)` — implemented against the tool list sent with each exec.
- `text()`, `image()` output helpers and `console.*` capture: buffered per script, returned in the result message.

Reachability (`reachesTools`): same rule as built-in — script words naming tools/namespaces, `ALL_TOOLS`/`searchTools` → `"all"`.

### 2.3 Protocol (extension ↔ worker, fork IPC)

Extension → worker:
- `{ type: "exec", id, code, tools: ToolDecl[], options: { timeoutMs } }`
- `{ type: "toolResult", callId, ok, result }`

Worker → extension:
- `{ type: "ready" }`
- `{ type: "toolCall", callId, name, args }`
- `{ type: "end", id, ok, value?, error?, output: OutputItem[] }`

Timeout: per-exec timer on the extension side; on expiry `worker.kill()` + respawn → REPL state lost; the tool result tells the model explicitly. Worker crash (`exit` event): respawn on next call, same messaging. (State snapshot/restore after crash is a possible follow-up, out of scope v1.)

### 2.4 Tool gating

`code_mode` registers with a `prepareLoadout` hook; mode resolution: `/code-mode` session override (in-memory, extension module state) → else settings `codemode.mode` → else `"on"`.

- **`off`** — hook no-ops. `code_mode` still registered (cheap; model may ignore it).
- **`on`** (default) — no hiding; descriptions of callable tools note "prefer code_mode".
- **`only`** — `hiddenDeclarations` = all direct tools (stay active + callable; scripts reach them via `ctx.executeTool`). `code_mode`'s description lists every callable tool's signature + prompt guidelines (responsibility transfers from the system prompt, same as built-in "only" mode).

`/code-mode` command: `on | off | only | status`; prints confirmation via `ctx.ui`.

### 2.5 Output handling

Mirror built-in codemode: cap output chars/items; head+tail truncation with an elision marker; oversized text spilled to a temp file whose path is returned (built-in uses `writeOutputFile("pi-codemode", …)` — replicate with `os.tmpdir()`-based spill). Images passed through as `image()` items.

## 3. Files

```
/Users/edufd/code/code-mode/
├── package.json          ← name: code-mode, deps: acorn; main: index.ts
├── index.ts              ← extension adapter: registerTool + registerCommand + forwarding
├── repl-worker.ts        ← child process: persistent vm context, TLA rewrite, tool bridge
├── protocol.ts           ← shared message types
├── gating.ts             ← mode owner: settings boundary (flat-key warning), override, loadout builders, /code-mode decision
├── format.ts             ← result formatting: output budget (honest truncation marker), result sections, stateLost note
└── DESIGN.md             ← this document
```

Loaded via `.pi/extensions` symlink or `pi -e`. TypeScript loaded by Pi's jiti (no build step).

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Worker spawn failure (permission flags unsupported) | Catch spawn error → tool result reports it; in `only` mode tell the model to call tools directly by name (they're still callable) |
| Script hangs (infinite loop, no await) | Per-exec timeout → kill + respawn; result says state was lost |
| Worker crash | Respawn on next exec; result notes state loss |
| acorn parse failure on odd syntax | Report raw SyntaxError to model (it can rephrase); Script-path scripts unaffected |
| `only` mode hides tools but model still calls them by name | Same as built-in: hidden ≠ blocked; acceptable |
| Output flood | Char/item caps + head/tail truncation + file spill (§2.5) |
| REPL redeclare SyntaxErrors surprise the model | Document in tool description: "declare once; reassign without `const` afterwards" |
| State lost on Pi restart | Documented; out of scope to persist |

## 5. Verification plan (step 4 gate)

1. Load extension in a live Pi session (`pi -e`).
2. Two consecutive `code_mode` calls: call 1 sets `const files = await tools.bash("ls")`; call 2 uses `files.length` — must see the persisted value.
3. Gated run: `/code-mode only` → inspect outgoing request (or model behavior) — direct tool declarations absent; a script calling `tools.read` still executes.
4. `/code-mode off` → direct tools visible again.
5. Timeout path: script with `while(true){}` → killed, respawned, state loss reported.
