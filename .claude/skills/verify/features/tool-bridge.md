# Tool bridge

Scripts call session tools as `await tools.<name>(args)`; the worker forwards the call over IPC, the host (or the harness, standing in for it) answers, and the resolved value lands back in the script. This is how the REPL does real work — file access, shell commands, everything the session tools offer.

## Sub-features

- named-call: `tools.bash({...})` resolves to the answered value.
- odd-names: tools with non-identifier names (`mcp__docs__search`) are callable via `tools['mcp__docs__search']`.
- discovery: `ALL_TOOLS`, `searchTools(query)`, `describeNamespace(name)` reflect the tool list passed with the exec.

## How to get to it (user POV)

- Real session: the model writes a script containing `await tools.bash({command: ...})`; the tool result text shows what the script returned. The user sees real side effects (files created, commands run) — the proof must observe those side effects, not just the script's return value.
- Harness: the driver answers every `toolCall` from the plan's `toolValues`; no real side effects occur at this level, so side-effect proofs belong to the real-session harness.

## Driving it with the worker driver (helpers/driver-worker.mjs)

Preconditions: doctor green; plan includes a `tools` array so discovery has something to list, e.g. `["bash","read","mcp__docs__search"]` mapped to `{name, description}` objects (see `test-worker.mjs` for the exact shape).

- Tool call resolves: `{"name":"toolcall","code":"const out = await tools.bash({ command: 'ls' }); out","toolValues":{"bash":"file1\nfile2\nfile3"}}` — expect `value` "file1\nfile2\nfile3".
- Odd raw name: `{"name":"raw-name","code":"(await tools['mcp__docs__search']({ q: 'x' })) ?? 'called'","toolValues":{"mcp__docs__search":{"hits":3}}}` — expect `value` the JSON of `{"hits":3}` (values are JSON-stringified over IPC).
- Discovery globals: `{"name":"discovery","code":"ALL_TOOLS.join(',') + '|' + searchTools('docs').length"}` — expect `"bash,read,mcp__docs__search|1"` with the tools above.

## Gotchas

- `toolValues` keys are exact tool names; a typo silently answers with `undefined` and the script proceeds — an "undefined" result means the answer key did not match, not that the bridge failed.
- Values cross IPC JSON-stringified: objects come back as strings; parse in the script if you need structure.
- Discovery only sees the `tools` array sent with the exec — a plan without it makes `ALL_TOOLS` empty, which is a plan bug, not a product bug.
