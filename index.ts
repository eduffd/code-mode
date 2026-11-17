// code-mode — Pi extension: persistent REPL + session-level tool gating.
//
// - `code_mode` tool: the model writes JavaScript; it runs in a long-lived
//   worker whose vm context persists top-level bindings across calls.
//   Session tools are callable as `tools.<name>(args)`; output is distilled.
// - `/code-mode` command: on | off | only | status — "only" hides direct tool
//   declarations from the model (they stay callable from scripts), steering
//   work through the REPL.
//
// This file is the adapter, and only that: register the tool, the command,
// and the session hooks on pi, forward events, and map settled outcomes to
// the public result shape. Mode ownership (resolution, the settings boundary
// with its flat-key warning, loadout building, the /code-mode decision) lives
// in gating.ts; result formatting lives in format.ts; the exec lifecycle
// lives in lifecycle.ts (pure core) and worker-host.ts (effects). Exec
// futures are resolve-only — the core settles every accepted exec exactly
// once, so there is no reject path here. See DESIGN.md.

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildLoadout, createModeOwner, handleCommand, CODE_MODE_TOOL } from "./gating";
import { formatResult } from "./format";
import { DISCOVERY_GLOBALS, DISCOVERY_LISTING, type ExecOutcome, type ToolDecl } from "./protocol";
import { step, type AcceptedExec, type LifecycleEvent, type LifecycleState } from "./lifecycle";
import { createWorkerHost } from "./worker-host";

const DEFAULT_TIMEOUT_MS = 120_000;

export default function codeModeExtension(pi: ExtensionAPI) {
	// The mode owner: session override first, else the settings boundary in gating.ts.
	const mode = createModeOwner(() => pi.getSettings());

	// A flat mode key would otherwise be a silent no-op: surface the warning
	// once, loudly, when the session starts.
	pi.on("session_start", (_event, ctx) => {
		const warning = mode.resolve().warning;
		if (warning) ctx.ui.notify(warning, "warning");
	});

	let state: LifecycleState = { kind: "idle" };
	let execSeq = 0;
	const waiters = new Map<number, (outcome: ExecOutcome) => void>();

	const host = createWorkerHost({ onEvent: dispatch });

	function dispatch(event: LifecycleEvent): void {
		const next = step(state, event);
		state = next.state;
		for (const settled of next.settled) {
			const resolve = waiters.get(settled.id);
			waiters.delete(settled.id);
			resolve?.(settled.outcome);
		}
		for (const effect of next.effects) host.interpret(effect);
	}

	function toolDeclarations(ctx: ExtensionToolContext): ToolDecl[] {
		return ctx.tools
			.filter((t) => t.name !== CODE_MODE_TOOL)
			.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.parameters }));
	}

	/** The only place a caller future is created: resolve-only, the core settles it. */
	function runScript(code: string, timeoutMs: number, ctx: ExtensionToolContext): Promise<ExecOutcome> {
		const exec: AcceptedExec = { id: ++execSeq, code, tools: toolDeclarations(ctx), timeoutMs };
		return new Promise<ExecOutcome>((resolve) => {
			waiters.set(exec.id, resolve);
			dispatch({ type: "execRequested", exec });
		});
	}

	// ---- tool definition

	pi.registerTool({
		name: CODE_MODE_TOOL,
		label: "Code mode REPL",
		description: [
			"Run JavaScript as a persistent REPL. Session tools are callable as `await tools.<name>(args)`;",
			"results resolve to the tool's output text (or structured content when available).",
			"Top-level declarations persist across calls (`const x = ...` in one call is readable in the next;",
			"redeclaring the same name throws — reassign without `const` instead).",
			"Output helpers: `text(s)`, `image(data, mimeType)`, `exit(value)`; `console.log` is captured.",
			`Discovery: ${DISCOVERY_LISTING}.`,
			"Only distilled output enters the conversation; return or `text()` what matters.",
			"Long scripts are killed at the timeout and the REPL state is lost.",
		].join(" "),
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript to run. `return` and top-level `await` work." }),
			timeout_ms: Type.Optional(
				Type.Number({ description: `Execution timeout in ms. Default ${DEFAULT_TIMEOUT_MS}.` }),
			),
		}),
		executionMode: "sequential",
		reachesTools: (input: Record<string, unknown>) => {
			const code = typeof input.code === "string" ? input.code : "";
			if (code === "") return [];
			return DISCOVERY_GLOBALS.test(code) ? ("all" as const) : (code.match(/\w+/g) ?? []);
		},
		execute: async (_toolCallId, params: { code: string; timeout_ms?: number }, _signal, _onUpdate, ctx) => {
			host.setToolContext(ctx);
			const outcome = await runScript(
				params.code,
				typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : DEFAULT_TIMEOUT_MS,
				ctx,
			);
			host.setToolContext(undefined);
			return {
				content: [{ type: "text" as const, text: formatResult(outcome) }],
				details: { ok: outcome.ok, stateLost: outcome.stateLost },
				isError: !outcome.ok,
			};
		},
		prepareLoadout: (loadout) => buildLoadout(mode.resolve().mode, loadout),
	});

	// ---- /code-mode command: gating.ts decides, this applies the side effects.

	pi.registerCommand("code-mode", {
		description: "code_mode session mode: on | off | only | status",
		handler: async (args, ctx) => {
			const decision = handleCommand(args, mode.resolve());
			if (decision.override !== undefined) {
				mode.setOverride(decision.override);
				if (decision.stopWorker) dispatch({ type: "stopRequested" });
			}
			ctx.ui.notify(decision.notify, decision.level);
		},
	});

	// REPL state is per-process and per-session: reset on switches and shutdown.
	pi.on("session_before_switch", () => dispatch({ type: "stopRequested" }));
	pi.on("session_before_fork", () => dispatch({ type: "stopRequested" }));
	pi.on("session_shutdown", () => dispatch({ type: "stopRequested" }));
}
