# AGENTS.md — rules and what enforces them

Each rule pairs with the gate that makes its mistake impossible. When the
operator corrects you, fix the mistake and add the rule here. Drop a rule
when its mistake can no longer happen.

| Rule | Enforced by |
|---|---|
| A code_mode call always settles, and its outcome says what happened | `.claude/skills/exec-lifecycle/check-exec-lifecycle.mjs` — 85 bounded interleavings + replay probes, in CI |
| Tool answers route by the exec that made the call, never by worker handle alone | `toolCall`/`toolAnswered` carry mandatory `execId` (protocol guard); probe `late-tool-answer` |
| No reject channel exists in the exec lifecycle | `test-lifecycle-core.mjs` structural grep |
| The lifecycle core stays pure (no node imports, no time, no process) | `test-lifecycle-core.mjs` purity check |
| One compile path: only `compile.ts` parses | `scripts/check-structure.mjs` one-compile-path |
| Only `worker-host.ts` spawns processes or touches the pidfile; `index.ts` imports, not re-implements | `scripts/check-structure.mjs` module-boundary |
| `protocol.ts` stays loadable by type stripping (no imports, enum, namespace) | `scripts/check-structure.mjs` protocol-erasable |
| Strict tsc passes | `./node_modules/.bin/tsc --noEmit` in CI; recorded in `evidence/tsc.txt` |
| Docs and skills make no phantom-path or dead claims | `scripts/check-docs.mjs` + `scripts/check-structure.mjs` skill-integrity |
| Doc-quoted suite counts match suite reality | `scripts/check-counts.mjs` |
| `worker-cleanup.mjs` stays scoped: only pgrep children, target never killed, dry-run honest | `test-worker-cleanup.mjs` |
| The hardened worker still boots under permission flags | `test-worker.mjs` 18c via the shared `permissionArgv` |
| Comments carry only facts a reader cannot derive from code, tests, or gates | review convention (PR #10 sweep); the drift class itself is gated by skill-integrity + check-counts |
| CI actually runs every gate the docs name | `scripts/check-docs.mjs` workflow-steps rule |
