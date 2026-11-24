// index.ts — the adapter: tool, command, session hooks.

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildLoadout, createModeOwner, handleCommand, CODE_MODE_TOOL } from "./gating.ts";
import { formatResultContent } from "./format.ts";
import { DISCOVERY_GLOBALS, DISCOVERY_LISTING, type ExecOutcome, type ToolDecl } from "./protocol.ts";
import { step, type AcceptedExec, type LifecycleEvent, type LifecycleState } from "./lifecycle.ts";
import { createWorkerHost } from "./worker-host.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

export default function codeModeExtension(pi: ExtensionAPI) {
	const mode = createModeOwner(() => pi.getSettings());

	pi.on("session_start", (_event, ctx) => {
		const warning = mode.resolve().warning;
		if (!warning) return;
		ctx.ui.notify(warning, "warning");
		if (!ctx.hasUI) console.warn(warning);
	});

	let state: LifecycleState = { kind: "idle" };
	let execSeq = 0;
	let lastReplNames: readonly string[] | undefined;
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
			if (outcome.replNames) lastReplNames = outcome.replNames;
			return {
				content: formatResultContent(outcome, mode.resolve().mode),
				details: { ok: outcome.ok, stateLost: outcome.stateLost },
				isError: !outcome.ok,
			};
		},
		prepareLoadout: (loadout) => buildLoadout(mode.resolve().mode, loadout),
	});

	// ---- /code-mode command: gating.ts decides, this applies the side effects.

/** Display form of the worker's persisted REPL names; long lists stay bounded. */
function replStateSummary(names: readonly string[]): string {
	const shown = names.length > 12 ? [...names.slice(0, 12), `+${names.length - 12} more`] : [...names];
	return `${names.length} binding${names.length === 1 ? "" : "s"}: ${shown.join(", ")}`;
}

	pi.registerCommand("code-mode", {
		description: "code_mode session mode: on | off | only | status",
		handler: async (args, ctx) => {
			const decision = handleCommand(args, mode.resolve());
			if (decision.override !== undefined) {
				mode.setOverride(decision.override);
				if (decision.stopWorker) dispatch({ type: "stopRequested" });
			}
			let notify = decision.notify;
			if (decision.reportReplState) {
				const names = lastReplNames;
				const state = names === undefined ? "no completed script yet" : names.length === 0 ? "0 bindings" : replStateSummary(names);
				notify = `${notify}; REPL state: ${state}`;
			}
			ctx.ui.notify(notify, decision.level);
		},
	});

	pi.on("session_before_switch", () => dispatch({ type: "stopRequested" }));
	pi.on("session_before_fork", () => dispatch({ type: "stopRequested" }));
	pi.on("session_shutdown", () => dispatch({ type: "stopRequested" }));
}
