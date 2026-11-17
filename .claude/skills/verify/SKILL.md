---
name: verify
description: Drive the code-mode Pi extension (persistent REPL + /code-mode tool gating) end to end and prove user-facing behavior with captured evidence. Use when verifying code-mode changes, before claiming a fix works, or when a task asks to run/prove/test the extension.
---

# Verify code-mode

code-mode is a Pi extension, not a server. A user touches it two ways: the `code_mode` tool inside a live Pi session (their JavaScript runs in a persistent worker), and the `/code-mode` slash command (session tool gating). This skill proves both without ever double-driving a real user session.

## Surfaces and harnesses

1. **Worker protocol** (primary, deterministic): `repl-worker.js` is the process that actually runs user JavaScript. It speaks fork IPC: in `{type:"exec", id, code, tools}`, out `{type:"ready"}`, `{type:"toolCall", callId, name, args}` (answer with `{type:"toolResult", callId, ok, value}`), and `{type:"end", id, ok, value?, error?, output}`. Drive it with `helpers/driver-worker.mjs` — no model, no network, answers to script tool calls come from the plan file.
2. **Gating logic** (`index.ts` `prepareLoadout` + command handler): the TUI slash command cannot be scripted, but the pi extension API is the production boundary — `helpers/driver-gating.mjs` loads `index.ts` against a stubbed `pi` object and drives the real registered code.
3. **Real Pi session** (end to end, costs one small model run): the extension is installed in pi (visible in `pi list` as `../../code/code-mode`). A `pi -p` run with a pointed prompt makes the model actually call `code_mode` — this is the only harness that exercises registration, `ctx.executeTool` permission hooks, and result formatting in one shot. Run it with `--no-session` (or `--session-dir` under the evidence dir) and `--no-extensions -e` pointed at this checkout so the user's installed extension state cannot interfere:

   ```sh
   pi -p --no-session --no-extensions --approve -e "$REPO/index.ts" \
     "Use the code_mode tool: run 'const q = await tools.bash({command: 'echo proof-42'}); q.output.trim()' and report the final value exactly."
   ```

   `--approve` matters in print mode: without project trust, pi skips project
   settings (`<cwd>/.pi/settings.json`), so a settings-sourced mode
   (`codemode.mode`) silently does not apply. `--approve` grants trust for
   this one run from a scratch cwd. `-na` is not a valid flag pair here: it
   parses as `-n a` (session name), not `--approve`.

   Non-determinism is inherent (the model chooses the tool); if it answers without calling the tool, retry once with a more pointed prompt, then record the failure as a finding, not a pass.

## Launch

There is no server to keep alive; launch means making a worker run:

- **Worker protocol / gating:** nothing to start. Each driver forks its own worker (`driver-worker.mjs`) or imports the extension in-process (`driver-gating.mjs`). The worker handshake is `{type:"ready"}` within 5 s; `driver-worker.mjs` and `doctor.mjs` already wait for it.
- **Real Pi session:** the command above. Ready = the run prints the model's final answer and exits. Use a cheap/fast model; expect ~1 tool call. Run from a scratch directory (`mktemp -d`), never the user's cwd, and never with `--continue`/`--resume` — that would drive the user's session.
- Teardown is per-drive: drivers kill the child they forked (captured pid, never a name-based `pkill`); `pi -p` exits on its own. A run that hangs is killed with the pid the driver recorded in its evidence JSON.

## Doctor

Run `node .claude/skills/verify/helpers/doctor.mjs` first whenever anything looks off. It checks, read-only: Node >= 23.6 (type stripping the worker needs), the `repl-worker.js` ready handshake within 5 s, and that `pi list` shows the extension registered. Any failure means "do not drive; fix the base first."

## Drive

Recipes live in `features/` — read `features/README.md`, then the feature file for what you are proving. Conventions:

- Write a plan JSON to the evidence dir and run `node .claude/skills/verify/helpers/driver-worker.mjs <plan> <out.json>`. Steps run in order in one worker; state from earlier steps is visible to later ones (that is the point).
- Prefer stable handles over positions: assert on the `end` message's `ok`/`value`/`error.name` and the `output` items' `text` prefixes (`[log]`, `[error]`). Tool answers are keyed by tool name in `toolValues`.
- `driver-gating.mjs` prints PASS/FAIL per assertion and exits non-zero on any failure; its JSON is the evidence.
- For the real-session harness, capture stdout/stderr/exit code plus the session file if `--session-dir` was used.
- Exercise the real user path: scripts that read like what a model would write (top-level `await tools.*`, `const` capture, `return`), not internal setters. For anything that claims to skip work (timeouts, gating), verify the skip by observing state, not by trusting the name.

## Evidence

Everything a proof needs goes in `.claude/skills/verify/evidence/<run-id>/` (create `<run-id>` per run, e.g. `$(date +%Y%m%d-%H%M%S)-<feature>`):

- The driver plan JSON and the driver result JSON (both sides of every exec).
- The gating result JSON when gating is in scope.
- For real-session runs: stdout/stderr, exit code, and the session file path.
- Proof standards: capture the action and the resulting state — for persistence that means the declaring exec AND the later exec that reads the value; for errors, the exact `error.name`/`message`; for gating, the hidden-declarations array, not just "it passed". Evidence survives cleanup; cleanup must never delete this directory.

## Cleanup

- Drivers kill only the child pid they forked and report it in their JSON. Never `pkill -f node` or kill by process name — the user's own pi sessions are also node processes.
- Scratch: plan JSONs may live in the evidence dir (they are part of the proof); temp dirs from `mktemp -d` for real-session runs are removed after their evidence is copied out.
- A killed/failed run still runs cleanup: kill the recorded child pid, remove scratch dirs, keep evidence.

## Helpers

- `helpers/doctor.mjs` — read-only preflight (node version, worker handshake, pi registration).
- `helpers/driver-worker.mjs <plan.json> [out.json]` — forks `repl-worker.js`, executes plan steps over fork IPC, writes the result JSON. Exit 0 only if every step ended ok.
- `helpers/driver-gating.mjs [out.json]` — loads `index.ts` on a stubbed ExtensionAPI (run with cwd = repo root) and asserts on/off/only/status gating plus command handling.
