# Tool gating

The `/code-mode` command steers the session between direct tool declarations and REPL-only work: `on` (default) keeps tools declared but annotates their descriptions with a codemode hint, `only` hides direct declarations entirely (they stay callable from scripts) and lists them inside the `code_mode` description, `off` unregisters the REPL, `status` reports the current mode and where it came from.

## Sub-features

- on-hints: with mode `on`, every declared-and-callable tool's description gains "Codemode: prefer running this via code_mode: tools.<id>(args)"; `code_mode` itself is never annotated.
- only-hides: with mode `only`, `hiddenDeclarations` lists every declared non-code_mode tool, and the code_mode description lists each as `tools.<id>(args)`.
- off-unregisters: with mode `off`, `prepareLoadout` returns undefined (the tool disappears for the session).
- status-source: `status` reports session override vs settings default.
- odd-name-mapping: tool names that are not identifiers are mapped (`mcp__docs__search` → `mcp__docs__search` via underscore replacement) in the listing.

## How to get to it (user POV)

- TUI: type `/code-mode only` (or on/off/status) in any pi session with the extension loaded; the notification confirms the mode.
- Settings: `codemode.mode` in pi settings sets the default; a session override wins.
- Observable effect: after `only`, the model no longer sees direct tool declarations but can still do tool work through code_mode scripts.

## Driving it with the gating driver (helpers/driver-gating.mjs)

Preconditions: doctor green; run from the repo root so peer deps resolve.

```sh
node .claude/skills/verify/helpers/driver-gating.mjs <evidence>/gating.json
```

The driver asserts, against the real registered code on a stubbed ExtensionAPI: on-mode descriptions carry the hint and skip `code_mode`; `only` hides read+bash and lists both in the description; `status` reports "only (session override)"; `off` returns undefined from `prepareLoadout`; unknown modes are rejected with an error notification. All nine assertions must PASS.

Real-session cross-check (optional, one cheap run): start pi with settings default `only` and ask the model to create a file; the proof is the file existing on disk plus the session showing the work went through `code_mode` — do not mutate the user's real pi settings; do this only with a scratch settings environment if one is available, else record as not covered.

## Gotchas

- The TUI slash command cannot be scripted; the gating driver's stubbed ExtensionAPI is the production boundary (index.ts speaks only through it), but the UI notification text itself is only proven at the stub level.
- `prepareLoadout` returning undefined for `off` is the contract "tool unregisters" — do not interpret undefined as an error.
- The mode override is session-scoped state inside the extension instance; each `driver-gating.mjs` run is a fresh instance, so ordering within one run matters (the driver's assertions are order-dependent by design).
