# code-mode

Pi extension bringing Claude Code's [code-mode](https://code.claude.com/docs/en/code-mode) to Pi, with two capabilities the built-in `codemode` tool lacks:

1. **Persistent REPL** — the `code_mode` tool runs the model's JavaScript in a long-lived worker whose `node:vm` context survives across calls. Top-level `const`/`let`/`var`/function/class declarations persist via `globalThis` capture. Redeclaring a persisted name throws `Identifier 'x' has already been declared — reassign without const instead`; assignment is the reassign channel.
2. **Session-level tool gating** — `/code-mode only` hides direct tool declarations from the model for this session (they stay callable from scripts), steering all work through the REPL. `/code-mode on|off|only|status`; without an override the `codemode.mode` setting applies.

Session tools are callable as `await tools.<name>(args)`; `ALL_TOOLS`, `searchTools(query)`, `describeTool(name)`, `describeNamespace(name)` for discovery; `text(s)`, `image(data, mimeType)`, `exit(value)` output helpers; `console.*` is captured. Scripts run through full tool validation/permission hooks via `ctx.executeTool`.

## Install

```sh
pi install /Users/edufd/code/code-mode   # or copy/symlink into ~/.pi/agent/extensions/
```

Requires Node ≥ 23.6 (type stripping for the worker; permission-model flags used best-effort with automatic fallback).

## Files

- `index.ts` — extension: tool registration, `prepareLoadout` gating, `/code-mode` command
- `compile.ts` — the one compile path: acorn parse, async-IIFE rewrite, `globalThis` capture, redeclare detection
- `repl-worker.js` — forked worker: persistent vm context, validating tool bridge over fork IPC, disconnect self-exit
- `output.ts` — output budget (head/tail truncation)
- `test-worker.mjs` — standalone protocol harness (`node test-worker.mjs`, 30 checks)
- `test-compile.mjs` — compile drift tests against compile.ts without forking a worker (`node test-compile.mjs`, 32 checks)
- `test-lifecycle-core.mjs` — step-table suite for the lifecycle core (`node test-lifecycle-core.mjs`, 56 checks)
- `DESIGN.md` — design doc: research findings, architecture, risks, verification plan

## Limits

- REPL state lives in the worker process: lost on Pi restart, session switch, script timeout (worker killed + respawned, model told explicitly), or crash.
- Scripts that compute without awaiting are stopped only by the timeout (default 120 s, per-call `timeout_ms`).
