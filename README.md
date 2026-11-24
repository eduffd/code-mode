# code-mode

Pi extension bringing Claude Code's [code-mode](https://code.claude.com/docs/en/code-mode) to Pi, with two capabilities the built-in `codemode` tool lacks:

1. **Persistent REPL** — the `code_mode` tool runs the model's JavaScript in a long-lived worker whose `node:vm` context survives across calls. Top-level `const`/`let`/`var`/function/class declarations persist via `globalThis` capture. Redeclaring a persisted name throws `Identifier 'x' has already been declared — reassign without const instead`; assignment is the reassign channel.
2. **Session-level tool gating** — `/code-mode only` hides direct tool declarations from the model for this session (they stay callable from scripts), steering all work through the REPL. `/code-mode on|off|only|status`; without an override the nested `codemode.mode` setting applies.

Session tools are callable as `await tools.<name>(args)`; `ALL_TOOLS`, `searchTools(query)`, `describeTool(name)`, `describeNamespace(name)` for discovery; `text(s)`, `image(data, mimeType)`, `exit(value)` output helpers; `console.*` is captured. Scripts run through full tool validation/permission hooks via `ctx.executeTool`.

## Use

```sh
pi install /Users/edufd/code/code-mode   # or copy/symlink into ~/.pi/agent/extensions/
```

Requires Node ≥ 23.6 (type stripping for the worker; permission-model flags used best-effort with automatic fallback). A fresh checkout needs `npm install` once — `compile.ts` imports acorn, and nothing resolves it until then.

Settings are read once per session at the nested key the parser accepts:

```json
{ "codemode": { "mode": "only" } }
```

A flat `codemode.mode` key is ignored loudly: mode falls back to `on` and the session start prints a warning naming the nested shape.

## Files

- `index.ts` — extension adapter: registers the `code_mode` tool, the `/code-mode` command, and the session hooks; forwards events; maps settled outcomes to the result shape
- `protocol.ts` — the fork-IPC contract: message shapes, runtime guards (`isWorkerInMessage`, `isWorkerOutMessage`), tool-name identifiers (`toIdentifier`), discovery names
- `lifecycle.ts` — pure exec-lifecycle core: the `step()` transition table over `idle`/`booting`/`ready`/`running`; resolve-only settlement (an exec always settles exactly once, there is no reject channel)
- `worker-host.ts` — the one place touching `node:child_process` and timers: spawn (permission flags with per-boot plain retry, boot timeout, stderr capture, pidfile breadcrumb), kill, send, exec timers, tool answering
- `compile.ts` — the one compile path: acorn parse, async-IIFE rewrite, `globalThis` capture, redeclare detection
- `gating.ts` — mode owner: settings parse at one boundary (nested key accepted, flat keys warned), session override, loadout builders, the pure `/code-mode` decision
- `format.ts` — result formatting: output budget (head-and-tail truncation with the honest `... [head-and-tail omitted N bytes] ...` marker, N the true omitted byte count), value/error sections, interrupted-run journal, the stateLost note
- `repl-worker.js` — forked worker: persistent vm context, validating tool bridge over fork IPC, disconnect self-exit
- `test-worker.mjs` — standalone protocol harness (`node test-worker.mjs`, 41 checks)
- `test-compile.mjs` — compile drift tests against compile.ts in-process (`node test-compile.mjs`, 50 checks)
- `test-lifecycle-core.mjs` — step-table suite for the lifecycle core (`node test-lifecycle-core.mjs`, 58 checks)
- `test-format.mjs` — unit checks for format.ts (`node test-format.mjs`, 19 checks)
- `test-worker-host.mjs` — drives the real effect interpreter + core with a worker that dies pre-boot: bootFailed routing, never workerDied (`node test-worker-host.mjs`)
- `test-worker-cleanup.mjs` — proves the cleanup script's safety contract on real processes (`node test-worker-cleanup.mjs`)
- `scripts/check-docs.mjs` — asserts this README and DESIGN.md against the repository; fails on a planted lie (`node scripts/check-docs.mjs`)
- `scripts/check-structure.mjs` — structural gates: one compile path, module boundaries (only `worker-host.ts` spawns; `protocol.ts` stays erasable), the tsc-gate wiring, skill-file integrity (`node scripts/check-structure.mjs`)
- `scripts/check-counts.mjs` — every suite count quoted in these docs must match the suite's real output (`node scripts/check-counts.mjs`)
- `AGENTS.md` — the rule-to-enforcement table: every rule paired with the gate that makes its mistake impossible
- `tsconfig.json` — the strict-tsc gate config (`strict`, `noUncheckedIndexedAccess`); `evidence/tsc.txt` records the passing run
- `scripts/worker-cleanup.mjs` — kills only the child pids of a given pid (`node scripts/worker-cleanup.mjs --pid <pid> [--dry-run]`); the consumer for the worker-host pidfile when a session died
- `.github/workflows/ci.yml` — runs the eleven gates on every push and pull request
- `.pi/settings.json` — the workspace mode preference, in the nested shape

## Limits

- REPL state lives in the worker process: lost on Pi restart, session switch, script timeout (worker killed + respawned, model told explicitly), or crash.
- Scripts that compute without awaiting are stopped only by the timeout (default 120 s, per-call `timeout_ms`).
- Output is truncated in memory at 20 000 characters (14 000 head + 5 000 tail) with the honest `... [head-and-tail omitted N bytes] ...` marker. No file is ever written anywhere in this path.
- The `image()` helper captures an image item in the worker's output list; image items ride through to the result as image content blocks, each preceded by a label naming its index, mime type, and decoded byte size. The text output budget applies to text only.
- Deep imports of internal modules are blocked by the package `exports` map; the extension is loaded by path (the entry resolves as `code-mode`).

## Development

```sh
npm install                      # once, for acorn
node test-worker.mjs             # 41 checks
node test-compile.mjs            # 50 checks
node test-lifecycle-core.mjs     # 58 checks
node test-format.mjs             # 19 checks
node scripts/check-docs.mjs      # docs match the repository
```

CI (`.github/workflows/ci.yml`) runs eleven gates on every push and pull request: the strict-tsc gate (`./node_modules/.bin/tsc --noEmit`), the six suites above, the lifecycle interleaving checker (`.claude/skills/exec-lifecycle/check-exec-lifecycle.mjs`, 85 scenarios plus replay probes; jiti is a devDependency), and the assertion gates `scripts/check-docs.mjs`, `scripts/check-structure.mjs`, and `scripts/check-counts.mjs`. `.claude/skills/verify/` holds the driver skill and feature recipes for proving user-facing behavior end to end. `AGENTS.md` pairs every rule with the gate that enforces it.
