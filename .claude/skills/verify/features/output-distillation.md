# Output distillation

Only distilled output reaches the model: captured `console.*` lines in order, the `text()` helper, and `exit(value)` short-circuit, all budgeted by `output.ts` (20k chars total, head+tail truncation with an elision marker when exceeded).

## Sub-features

- console-capture: `console.log`/`console.error` appear as `[log]`/`[error]` text items, in order, interleaved with `text()`.
- exit-value: `exit(v)` ends the script immediately with `value` set to JSON of v; code after it never runs.
- truncation: output over 20 000 chars is head(14k)+marker+tail(5k), with the marker naming the omitted char count.

## How to get to it (user POV)

- Real session: the model prints via `console.log` or `text()`; the tool result text is what enters the conversation. A huge `console.log` dump arrives truncated with the `... [N chars truncated ...]` marker.
- Harness: the driver records the full `output` array and `value` of each `end` message — this is the only harness that sees items before formatting.

## Driving it with the worker driver (helpers/driver-worker.mjs)

Preconditions: doctor green.

- Capture order: `{"name":"capture","code":"console.log('hello', { a: 1 }); console.error('oops'); text('kept');"}` — expect `output` of 3 items: `[log] hello { a: 1 }`, `[error] oops`, `kept` (the third item has no `console` flag).
- Exit short-circuit: `{"name":"exit","code":"exit({ done: true }); text('unreachable');"}` — expect `ok:true`, `value` `"{\"done\":true}"`, `output` empty.
- Truncation: `{"name":"truncate","code":"text('x'.repeat(25000));"}` — expect the joined output to contain the marker `chars truncated` and to be well under 25 000 chars. (Truncation formatting lives in `output.ts`; the marker text is the stable handle.)

## Gotchas

- `exit()` value arrives JSON-stringified; `{done:true}` is not an object on the driver side.
- The truncation marker's number changes with input size — assert on `chars truncated`, not on a literal count.
- Console output is captured per-exec; state (variables) and output are separate channels — a later exec cannot read an earlier exec's console lines.
