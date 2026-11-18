# Persistent REPL

User JavaScript runs in a long-lived worker whose vm context survives across `code_mode` calls: declarations made in one call are readable in the next, which is what makes the REPL persistent rather than a stateless eval.

## Sub-features

- native-persist: `var`/`function`/`let`/`const` declared in one call readable in the next (each executed top-level declaration installs a live accessor on `globalThis`, closed over the declaring call's binding).
- reassign-persists: reassigning a captured name in a later call — via the bare name or via `globalThis.<name>`, either direction — updates the same binding and every later call sees it; a function declared in an earlier call keeps mutating its captured binding, and those mutations are visible to reads in any call.
- redeclare-throws: redeclaring the same binding throws an honest REPL error ("already declared"); the user reassigns without `const`.
- tla-capture: top-level `await` scripts get their `const`/`let`/function declarations captured live into `globalThis` so later calls see them; TLA redeclare throws the taught reassign message (changed intentionally in PR4: one redeclare rule on every path).
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
- Reassign persists across calls (the acceptance regression for live capture):
  ```json
  {"steps":[
    {"name":"declare-a-inc","code":"var a = 1; function inc() { a += 1; return a; } inc()"},
    {"name":"read-a","code":"a"},
    {"name":"inc-again","code":"inc(); inc(); a"},
    {"name":"reassign","code":"a = 40; a"},
    {"name":"read-after-reassign","code":"a"},
    {"name":"sym-via-global","code":"globalThis.a = 41; a"},
    {"name":"redeclare-a","code":"let a = 1;"}
  ]}
  ```
  Expect "2", "2", "4", "40", "40", "41", then the redeclare step fails with the taught reassign message (the journal sees the live accessor). A stale capture reads "1" at read-a and falls behind at inc-again — that is exactly what the 20261117 acceptance drive caught.
- Redeclare throws: step {"name":"redeclare","code":"let counter = 99;"} — expect ok:false with error.message matching /already/.
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
- Top-level return with pre-return capture: {"code":"const keep = 'pre'; return keep;"} then {"code":"keep"} — expect "pre" both times.

## Gotchas

- A fresh worker run starts empty: do not assume state from a previous evidence run; every persistence proof needs declare + read inside ONE run.
- One compile path since PR4: the same redeclare and reassign semantics on every script shape; asserting per-path differences is a false failure.
- Redeclare errors are `SyntaxError` carrying the taught message; match the message (/already/ — it is the stable part), and record `error.name` alongside it.
