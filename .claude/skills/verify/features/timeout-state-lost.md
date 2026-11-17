# Timeout and state loss

A script that never finishes is killed hard: the worker dies, the call reports `TimeoutError` with the timeout and an explicit "REPL state was lost" warning, and the next call transparently respawns a fresh worker. Because REPL state lives in the worker, everything declared before the timeout is gone — the user must be told, not left to debug silent resets.

## Sub-features

- hard-timeout: a spinning script (no await) is stopped only by the timeout; result is `ok:false` with `error.name` "TimeoutError" and the ms in the message.
- state-lost-note: the result carries the "REPL state was lost" warning so the model re-sets variables.
- respawn-fresh: the next call works and sees a FRESH context — previously declared bindings are undefined.

## How to get to it (user POV)

- Real session: the model sends a script with an accidental infinite loop and `timeout_ms: 1000`; the tool result text shows the TimeoutError and the state-lost note; the model's next script re-declares what it needs and succeeds.
- Harness: the timeout lives in the HOST (`index.ts` `runScript`), not the worker, so the worker driver alone cannot kill its own worker mid-script. Drive the timeout through the real-session harness or a direct `index.ts` load; see Gotchas.

## Driving it

Preconditions: doctor green.

- Host-level timeout (recommended): load the extension on a stubbed ExtensionAPI in a small throwaway driver (same resolve-hook pattern as `helpers/driver-gating.mjs`, but call `tool.execute` with a stub `ctx` whose `executeTool` answers nothing), call `execute(id, { code: "while(true){}", timeout_ms: 500 }, ...)` and expect an `isError` result whose text contains "TimeoutError" and "REPL state was lost". Then a second `execute` with `{"code":"typeof counter"}` succeeds and reports "undefined" — proving respawn with fresh state. Save stdout + result text as evidence.
- Real-session harness: same story end to end; point the model at a spinning script with a short `timeout_ms` and capture both tool results (failed then successful) in the session transcript.
- Do NOT drive the timeout with `helpers/driver-worker.mjs`: the driver has no host timeout, so a spinning script wedges the run until the driver's own 120 s cap kills everything — that proves the driver cap, not the feature.

## Gotchas

- The timeout is host-side (`DEFAULT_TIMEOUT_MS` 120 000; per-call `timeout_ms` only via the tool's parameters). The worker itself has no timer.
- After a timeout the worker pid changes; if evidence records the child pid, expect a different pid after respawn.
- The state-lost warning is part of the RESULT TEXT (formatResult), not the protocol message — capture the formatted text, not just the `end` message.
