# design-gaps todo — audit original DESIGN (b15c4b2) vs shipped code, close true gaps

Scope agreed with operator: implement confirmed gaps; build snapshot/restore, restart persistence,
and background exec where audit evidence supports them; subagent spawning + plugin packaging OUT.

## Phase A — audit (investigation precedes code change)
- [x] A1. Trace every normative claim in original DESIGN to today's code; classify built / deliberate cut / true gap; deliver table
- [x] A2. Read exec-lifecycle skill fully before any lifecycle/worker-host/index/repl-worker change
- [x] A3. Prove each true gap on the running extension (verify skill) before fixing

## Phase B — confirmed gap fixes (one commit each, gates green)
- [x] B1. Image output items in distilled result (if confirmed)
- [x] B2. Only-mode spawn-failure fallback guidance (if confirmed)
- [x] B3. Any other confirmed gaps from the trace table

## Phase C — follow-ups (each evidence-gated, architect shape first)
- [x] C1. Snapshot/restore after worker crash (if evidence supports)
- [x] C2. Restart persistence (if evidence supports)
- [x] C3. Background/poll exec (if evidence supports)

## Phase D — close
- [x] D1. Full gate run: tsc, 4 suites, check-docs, check-structure, check-counts, exec-lifecycle checks
- [ ] D2. Final report with trace table, fixes, recommendations, verify evidence
- [x] D3. Decision-log audit against transcript (show-me-your-work)
