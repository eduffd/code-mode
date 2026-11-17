# code-mode verification map

This directory is the maintained source for verifying the user-facing behavior of the code-mode Pi extension. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Repo root: `/Users/edufd/code/code-mode`. Node >= 23.6 required (type stripping).
- Run `node .claude/skills/verify/helpers/doctor.mjs` and require all checks green before driving.
- Every harness run gets its own evidence dir: `.claude/skills/verify/evidence/<run-id>/`.
- Never drive a live pi session that this run did not start; real-session runs use `--no-extensions -e <repo>/index.ts --approve` from a scratch cwd (print mode skips project settings without project trust; `--approve` grants it for the one run).

## Driving conventions

- Worker-level proofs go through `helpers/driver-worker.mjs`; gating proofs through `helpers/driver-gating.mjs`; end-to-end through `pi -p` per SKILL.md.
- Assert on the protocol's observable fields: `ok`, `value`, `error.name`, `error.message`, `output[].text`.
- Steps within one worker run share REPL state; a fresh run is the only clean slate.
- Treat the protocol messages as literal shapes: exec in, `{type:"end", id, ok, value?, error?, output}` out; answer `toolCall` with `toolResult`.

## Proof and skip reporting

- Capture both sides of each proof: the declaring action and the later exec (or fresh call) that observes its effect.
- Error proofs record `error.name` AND `message`; timeout proofs record the state-lost note and the respawn behavior.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition; never report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with ...`, `Gotchas`.

## Features

- [Persistent REPL](./persistent-repl.md) — declarations surviving across calls, redeclare semantics, top-level await/return.
- [Tool bridge](./tool-bridge.md) — calling session tools from scripts, odd names, error propagation.
- [Output distillation](./output-distillation.md) — console capture, text/exit helpers, truncation budget.
- [Tool gating](./tool-gating.md) — /code-mode on|off|only|status, hidden declarations, description rewriting.
- [Timeout and state loss](./timeout-state-lost.md) — hard timeout kills the worker, honest state-lost reporting, respawn.
