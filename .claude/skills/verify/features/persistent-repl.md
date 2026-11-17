# Persistent REPL

User JavaScript runs in a long-lived worker whose vm context survives across `code_mode` calls: declarations made in one call are readable in the next, which is what makes the REPL persistent rather than a stateless eval.

## Sub-features

- native-persist: `var`/`function`/`let`/`const` declared in one call readable in the next (worker's shared lexical scope + globalThis capture).
- redeclare-throws: redeclaring the same binding throws an honest REPL error ("already declared"); the user reassigns without `const`.
- tla-capture: top-level `await` scripts get their `const`/`let`/function declarations captured into `globalThis` so later calls see them; TLA redeclare throws the taught reassign message (changed intentionally in PR4: one redeclare rule on every path).
- top-level-return: `return` works in both paths; declarations before the `return` are still captured.

## How to get to it (user POV)

- The only entry point is the `code_mode` tool: a model (or this harness) sends JavaScript; the result text shows the final value after `=>`, captured console lines, or an `Error:` section.
- Real-session form: any pi chat where the model calls `code_mode` twice and the second call uses the first call's bindings.

## Driving it with the worker driver (helpers/driver-worker.mjs)

Preconditions: doctor green; evidence dir created.

- Declare then read across steps:
  ```json
  {"steps":[
    {"name":"declare","code":"var a = 1; function inc() { return ++a; } inc()"},
    {"name":"read-var","code":"a"},
    {"name":"let-persists","code":"let counter = 10; counter"},
    {"name":"let-read","code":"counter + 1"}
  ]}
  ```
  Expect step 1 `value` "2" (`inc()` already incremented `a`), step 2 `value` "2", step 4 `value` "11".
- Redeclare throws: step `{"name":"redeclare","code":"let counter = 99;"}` — expect `ok:false` with `error.message` matching /already/.
- TLA capture across calls:
  ```json
  {"steps":[
    {"name":"tla-declare","code":"const out = await Promise.resolve('kept'); out"},
    {"name":"tla-read","code":"out"},
    {"name":"tla-redeclare","code":"const out = 'replaced'; out"},
    {"name":"tla-read-2","code":"out"}
  ]}
  ```
  Expect "kept", "kept", then the redeclare step fails with the taught reassign message and the fourth step still reads "kept" (redeclare throws since PR4).
- Top-level return with pre-return capture: `{"code":"const keep = 'pre'; return keep;"}` then `{"code":"keep"}` — expect "pre" both times.

## Gotchas

- A fresh worker run starts empty: do not assume state from a previous evidence run; every persistence proof needs declare + read inside ONE run.
- TLA and native paths have different redeclare semantics — asserting the wrong one either way is a false failure.
- `error.name` for redeclare is not `SyntaxError`; match on the message, not the name.
