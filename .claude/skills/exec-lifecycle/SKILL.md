---
name: exec-lifecycle
description: Formal check of the code_mode exec lifecycle (pure core in lifecycle.ts, adapter in index.ts) — a code_mode call must always settle (never wedge), with honest ok/stateLost outcomes, even when the worker is killed, crashes, or /code-mode off runs mid-exec. Use whenever a change touches the step() transition table or state/event types in lifecycle.ts, the effect interpreter in worker-host.ts, the adapter dispatch in index.ts, or the worker IPC protocol in repl-worker.js. Run after every such change.
---

# exec-lifecycle — bounded exhaustive check of the code_mode exec lifecycle

## The property

**A `code_mode` call always returns to the model, and its outcome honestly says what happened.**

In one sentence: whatever happens to the worker while a script runs (it finishes, hangs until timeout, is killed by `/code-mode off`, crashes, or the session switches), the pending exec settles and every later `code_mode` call still settles.

Verified by `.claude/skills/exec-lifecycle/check-exec-lifecycle.mjs` — a bounded exhaustive interleaving check that loads the **real** `index.ts` (via jiti, with a stubbed `pi` API) and drives real forked worker processes. Because it only touches the public surface (tool `execute`, the `/code-mode` command, session events), it exercises the pure core, the effect interpreter, and the adapter together. `fake-worker.mjs` stands in for `repl-worker.js` with the same fork-IPC protocol; `--real` adds a probe against the actual `repl-worker.js`. The pure core additionally has a step-table suite, `test-lifecycle-core.mjs` at the repo root, which sweeps every state x event pair.

## Run it

```sh
cd /Users/edufd/code/code-mode && node .claude/skills/exec-lifecycle/check-exec-lifecycle.mjs
```

Add `--real` to also SIGKILL a real `repl-worker.js` mid-exec and prove on a real process that the killed exec settles and the queue survives. Budget ~50 s (85 scenarios + 5 probes, each scenario a fresh jiti load + real forks). Exit code: `0` = all green; `1` = any violation (new bug or modeling drift).

## How to read a result

- **`0 violations, 0 unexpected`** — the code's behavior matches the property. Nothing to debug.
- **Any `[UNEXPECTED]` row, `violations` above 0, or `probe ... failed`** — either a new bug or modeling drift (the harness's picture of the lifecycle no longer matches the code). Read the scenario row: it names the event sequence (`[crash,off,end]` = worker crash, then `/code-mode off`, then a late `end` message) and the violated property.
- **`WEDGED`** — the exec (P1) or the whole exec queue (P2) never settled within 300 ms. This is the harm the check exists to catch; since the PR1 fix it is always a failure.
- Properties: **P1** first exec settles; **P2** a follow-up exec still settles (queue alive); **P3** honest outcome — `end` delivered → `ok:true stateLost:false`, plain timeout → `ok:false TimeoutError stateLost:true`, worker stop settled the exec → `ok:false stateLost:true`; **P4** a late `end` for a settled exec is ignored (probe `late-end-after-timeout`).
- All probes must pass: `session-switch-mid-exec`, `boot-crash-retry`, `off-when-idle`, `late-end-after-timeout`; with `--real`, `real-worker-sigkill` must report "no wedge".

## Resolved finding (fixed at PR1 merge fdb25ce0262b3b8dee56c17b3df36c487ed796b7)

**A worker stop while an exec is unsettled used to wedge the exec queue forever.** In pre-PR3 `index.ts`, `killWorker()` cleared each pending waiter's timer (which also cancelled the hard-timeout backstop) and called `waiter.reject(...)` — but `runScript` registered exec waiters with `reject: () => undefined`, so the exec's promise never settled. `execQueue` chained on that promise, so every later `code_mode` call queued behind it and never ran. Affected: worker crash mid-exec, `/code-mode off` mid-exec, `session_before_switch` / `session_before_fork` / `session_shutdown` mid-exec. At the pre-fix sync commit b15c4b2, 42 of 85 interleaving scenarios wedged (all sequences starting with crash/off) and the `--real` probe reproduced the wedge on a real worker process.

**Fix (two tokens — both in PR1 merge fdb25ce0262b3b8dee56c17b3df36c487ed796b7):** in `runScript`, declare the executor's reject parameter (`new Promise((resolve, reject) => {`) and register the real `reject` (`pendingExecs.set(id, { resolve, reject, timer })`). Passing `reject` without declaring it throws `ReferenceError: reject is not defined` on **every** exec — it must be both or neither. A worker stop now settles the exec as `ok:false WorkerError stateLost:true`, and the queue stays alive: 85/85 scenarios pass and `--real` reports "no wedge: killed exec settled with err:WorkerError stateLost=true, follow-up call ok". (Historical: those function names died in the PR3 lifecycle-core refactor; the paragraph describes pre-PR3 index.ts.)

**Made unwritable at PR3 (lifecycle core):** exec futures are now resolve-only — the core's types have no reject channel, and every transition leaving a holding state (booting/running) returns one settled outcome per open exec, so a dropped settlement has no representation. `test-lifecycle-core.mjs` proves the invariant per state x event pair, and this checker keeps gating the behavior end to end.

If you change the lifecycle, run this check and only move the **Sync commit** line forward after you have read the diff and confirmed this skill still describes the code at the new commit (module names, event sources, state variants, bound).

**Sync commit: 453d2d1 (final program merge; lifecycle core with resolve-only settlement)** — re-synced after reading the diff across PR3-PR6: the checker drives the unchanged public surface, the scenario set is unchanged (alphabet `{end, crash, off, tick}`, max length 3, 85 scenarios), and the property wording still matches the code.

## Covered code

- `lifecycle.ts`: the whole `step()` transition table — `idle`/`booting`/`ready`/`running` states over `execRequested`, `booted`, `bootFailed`, `workerMessage` (`end`/`toolCall`), `workerDied`, `stopRequested`, `timeoutFired`, `toolAnswered` events. One settled outcome per open exec on every exit from a holding state; stale-handle events dropped in one rule; timers cleared by the same transition that settles; FIFO drain of queued execs. Swept per state x event pair by `test-lifecycle-core.mjs` (repo root).
- `worker-host.ts`: effect interpretation — spawn (permission flags with per-boot plain retry, boot timeout, stderr capture, pidfile), kill, send, exec timers, tool answering.
- `index.ts`: the adapter — `runScript()` (the resolve-only waiter map), `dispatch()`, `execute()` (`details.{ok,stateLost}`), the `/code-mode` command handler, and the `session_before_switch` handler registration.
- `repl-worker.js` only through its IPC protocol (ready/exec/end/toolCall), mirrored by `fake-worker.mjs`; with `--real`, also as a real process.
- Not covered: `compileScript`/compile logic, output truncation (`format.ts`), tool gating modes (`on`/`only`), multiple concurrent execs beyond the P2 follow-up (the core models queued execs; this checker drives one at a time), and timings beyond the stated bound.

**Bound:** event sequences over `{end, crash, off, tick}` up to length 3 from "exec accepted, worker booted, script running" — 85 scenarios, each ending in a settlement deadline of 300 ms and a follow-up-call probe. Exhaustive within the bound; not beyond it.

## Hazards learned the hard way

- **Never clean up by process name** (`pkill -f repl-worker.js`, `kill` by observed pid): this repo's extension runs inside live pi sessions, and an unscoped kill murders the session's own `code_mode` worker mid-call. Scope any cleanup to children of a known pid (`pgrep -P <pid>`).
- Keep `fsCache: false` in the harness's jiti options — on-disk transpile caching misbehaves with the per-run typebox stub alias.
- The harness installs `exit`/`SIGINT`/`SIGTERM` handlers that kill every worker it forked. Keep them: leaked idle workers pile up and grind the machine down.
- While any wedge exists (a regression reintroduces one), a killed or crashing run can leave workers behind; check `ps aux | grep repl-worker` if the machine slows down.
