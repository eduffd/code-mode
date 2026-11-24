# Trace: original DESIGN (b15c4b2) → shipped code (15247a1)

Classification: **built** / **deliberate** (redesigned, documented in as-built DESIGN) / **GAP** (promised, absent, undocumented) / **scope** (named out-of-scope, operator-approved follow-up).

| # | Original claim (§) | Evidence today | Verdict |
|---|---|---|---|
| 1 | Persistent REPL state across code_mode calls (intro) | worker holds one vm context; compile captures declarations onto globalThis | built |
| 2 | Session-level tool gating: on/off/only + settings + session override (§2.4) | gating.ts parseModeSetting/resolveMode/buildLoadout/handleCommand | built |
| 3 | Hybrid exec: native no-TLA path + acorn TLA path (§2.1) | compile.ts: ONE path, always async IIFE; as-built §5 documents | deliberate |
| 4 | Worker keeps knownNames "so /code-mode and tool output can report REPL state size/names" (§2.1) | worker tracks `persisted` set but never reports; /code-mode status shows mode only | **GAP G3** |
| 5 | tools proxy + __cm_callTool IPC bridge, keyed per exec (§2.2) | protocol.ts toolCall/toolResult with mandatory execId | built |
| 6 | Discovery globals ALL_TOOLS/searchTools/describeTool/describeNamespace (§2.2) | repl-worker.js + DISCOVERY_* in protocol | built |
| 7 | reachesTools word-scan; reachable tools per exec (§2.2) | index.ts reachesTools (pi permission surface); exec.tools carries session tools | built (verify ctx.tools filtering during impl) |
| 8 | Per-exec options.timeoutMs; kill+respawn; honest state-lost messaging (§2.3) | timeout_ms tool param → AcceptedExec.timeoutMs → timer effect; "(REPL state was lost)" markers | built |
| 9 | only-mode hiddenDeclarations + code_mode description lists callable tools (§2.4) | gating.ts buildLoadout "only" branch | built |
| 10 | off mode keeps code_mode registered (§2.4) | buildLoadout "off" returns undefined → tool unregisters; as-built §6 documents | deliberate |
| 11 | Output caps, head+tail truncation, elision marker (§2.5) | format.ts, marker "head-and-tail omitted" (doc-gated) | built |
| 12 | Oversized text spilled to temp file (§2.5) | removed; honest-limits states no file is written; docs ban the dead claim | deliberate |
| 13 | Images pass through as image() items (§2.5) | worker emits {type:"image"} output items; format.ts has 0 image refs — dropped silently | **GAP G1** |
| 14 | Spawn failure: report + in only mode tell model to call tools directly by name (§4) | bootFailed → SandboxError report built; no only-mode guidance anywhere | **GAP G2** |
| 15 | Timeout/crash → honest state-lost messaging (§4) | format.ts/lifecycle "(REPL state was lost)" (doc-gated markers) | built |
| 16 | Redeclare surprise: documented + taught error (§4) | compile.ts "has already been declared"; tool description carries the rule | built |
| 17 | State lost on Pi restart — "out of scope to persist" (§4) | honest-limits §8 | scope → C2 (operator-approved) |
| 18 | State snapshot/restore after crash — "possible follow-up" (§2.3) | not built | scope → C1 (operator-approved) |
| 19 | Verification plan steps 1–5 (§5) | .claude/skills/verify feature recipes + evidence | built |
| 20 | Background/poll execution out of scope v1 (§1) | not built | C3: evaluate — see recommendation |
| 21 | Subagent spawning, plugin packaging out of scope | not built | out per operator |

## Gap implementation queue (operator-approved scope)

- B1 = G1: image output items reach the tool result as content blocks, each labeled (mime, size); text truncation unchanged; no fs writes (honest-limits stance).
- B2 = G2: boot-failed outcome carries bootFailed marker; result text in only mode appends "session tools remain callable directly by name".
- B3 = G3: worker end messages carry replNames (sorted persisted set); outcome carries them; /code-mode status reports REPL state names/count.
- C1 = crash/timeout restore: worker snapshots serializable globals after each successful exec (v8.serialize, per-prop skip for functions/oversized with reported names); host holds latest snapshot; first exec to a fresh worker carries restore payload; that exec's outcome reports restored/skipped names. Lifecycle step table unchanged.
- C2 = restart persistence: host additionally persists the snapshot to a per-project file under packageDir; loads at host creation. Worker never touches fs.
- C3 = background/poll exec: recommendation only — concurrent scripts race on the shared global context (breaks the persistence invariant the tool promises), original explicitly deferred it, no demand signal. Recommend not building.

Reference implementation for G1: pi built-in codemode execute.js formatOutput/saveImages — image content blocks with a label text before each; truncation applies to text only.

## Final verdicts (post-implementation)

- G1 closed (d9be0c1): image items ride as labeled content blocks; proven pre (content=text-only) and post (text,label,image) on the real extension.
- G2 closed (bd51391): bootFailed marker + only-mode guidance; proven end-to-end on a broken-worker copy in only mode.
- G3 closed (aa2b79a): replNames through end message, outcome, and /code-mode status; proven on the real worker + adapter.
- C1+C2 closed (b5aa52c): per-exec snapshot, host memory + per-project file, restore rides the first exec to a fresh worker, honest restored/not-restorable report; proven across timeout respawn and a real process restart. Deliberate stops (off/session switch/fork/shutdown) discard memory and file.
- C3: recommendation only — do not build background/poll exec (shared-context race, explicit original deferral, no demand signal).
- Claim 7 resolved: reachesTools ships as the permission surface; the exec message carries all declared session tools and enforcement happens at the bridge (ctx.executeTool). Functionally equivalent; noted as an evolution, not a gap.

All gates green at final state: tsc, 46/46 worker, 50/50 compile, 58/58 lifecycle-core, 26/26 format, 5/5 worker-host, 8/8 cleanup, check-docs/check-structure/check-counts 0 problems, interleaving checker 85/85 + real-worker probe.
