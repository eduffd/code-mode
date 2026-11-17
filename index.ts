// code-mode — Pi extension: persistent REPL + session-level tool gating.
//
// - `code_mode` tool: the model writes JavaScript; it runs in a long-lived
//   worker whose vm context persists top-level bindings across calls.
//   Session tools are callable as `tools.<name>(args)`; output is distilled.
// - `/code-mode` command: on | off | only | status — "only" hides direct tool
//   declarations from the model (they stay callable from scripts), steering
//   work through the REPL.
//
// The exec lifecycle lives in lifecycle.ts as a pure step(state, event) core;
// worker-host.ts interprets its effects. This file is the adapter: register
// the tool/command/session hooks, forward events, map settled outcomes to the
// public result shape. Exec futures are resolve-only — the core settles every
// accepted exec exactly once, so there is no reject path here. See DESIGN.md.

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateOutput } from "./output";
import { DISCOVERY_GLOBALS, DISCOVERY_LISTING, toIdentifier, type ExecOutcome, type ToolDecl } from "./protocol";
import { step, type AcceptedExec, type LifecycleEvent, type LifecycleState } from "./lifecycle";
import { createWorkerHost } from "./worker-host";

// ---------------------------------------------------------------- constants

const DEFAULT_TIMEOUT_MS = 120_000;
const CODE_MODE_TOOL = "code_mode";

// ---------------------------------------------------------------- extension

export default function codeModeExtension(pi: ExtensionAPI) {
	// Session-scoped mode override; null = follow settings (codemode.mode, default "on").
	let modeOverride: "on" | "off" | "only" | null = null;

	function resolveMode(): "on" | "off" | "only" {
		if (modeOverride !== null) return modeOverride;
		// Settings are external data: the declared schema lacks "off", but user
		// JSON can carry any mode string, so read the value as unknown.
		const setting: unknown = pi.getSettings().codemode?.mode;
		return setting === "only" ? "only" : setting === "off" ? "off" : "on";
	}

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

	// ---- result formatting

	function formatResult(outcome: ExecOutcome): string {
		const sections: string[] = [];
		const text = truncateOutput(outcome.output);
		if (text.length > 0) sections.push(text);
		if (outcome.ok) {
			if (outcome.value !== undefined) sections.push(`=> ${outcome.value}`);
		} else {
			const e = outcome.error;
			sections.push(`Error: ${e ? `${e.name}: ${e.message}` : "script failed"}`);
			if (e?.stack) sections.push(e.stack);
			if (outcome.journal && outcome.journal.length > 0) {
				const landed = outcome.journal.map((c) => `${c.name} ${c.ok ? "ok" : "error"}`).join(", ");
				sections.push(`(completed before interruption: ${landed})`);
			}
		}
		if (outcome.stateLost) sections.push("(REPL state was lost)");
		return sections.join("\n") || "(no output; script returned undefined)";
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
		prepareLoadout: (loadout) => {
			const mode = resolveMode();
			if (mode === "off") return undefined;
			const callable = loadout.callable.filter((t) => t.name !== CODE_MODE_TOOL);
			const callableNames = new Set(callable.map((t) => t.name));

			if (mode === "on") {
				const descriptions: Record<string, string> = {};
				for (const tool of loadout.declared) {
					if (tool.name !== CODE_MODE_TOOL && callableNames.has(tool.name)) {
						descriptions[tool.name] =
							`${tool.description.trim()}\n\n` +
							`Codemode: prefer running this via code_mode: \`tools.${toIdentifier(tool.name)}(args)\`.`;
					}
				}
				return { descriptions };
			}

			// "only": hide direct declarations (they stay active and callable from scripts)
			// and list every callable tool in the code_mode description.
			const hiddenDeclarations = loadout.declared
				.filter((t) => t.name !== CODE_MODE_TOOL && callableNames.has(t.name))
				.map((t) => t.name);
			const listing = callable
				.map((t) => `- \`tools.${toIdentifier(t.name)}(args)\`: ${t.description.trim()}`)
				.join("\n");
			const description = [
				"Run JavaScript as a persistent REPL. This session is in code mode: other tools are not declared",
				"to you directly, but every session tool is callable from your script as `await tools.<name>(args)`.",
				"Prefer doing all work here, in one or few scripts, instead of many one-off calls.",
				"",
				"Available tools:",
				listing,
				"",
				"- Top-level declarations persist across calls (declare once; reassign without `const` afterwards).",
				"- `text(s)`, `image(data, mimeType)`, `exit(value)`, captured `console.*`.",
				`- ${DISCOVERY_LISTING} for discovery.`,
				"- Only distilled output enters the conversation; return or `text()` what matters.",
			].join("\n");
			return { descriptions: { [CODE_MODE_TOOL]: description }, hiddenDeclarations };
		},
	});

	// ---- /code-mode command

	pi.registerCommand("code-mode", {
		description: "code_mode session mode: on | off | only | status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "" || arg === "status") {
				const setting: unknown = pi.getSettings().codemode?.mode;
				const source =
					modeOverride !== null
						? "session override"
						: setting === undefined
							? "settings default"
							: `settings: ${String(setting)}`;
				ctx.ui.notify(`code_mode mode: ${resolveMode()} (${source})`);
				return;
			}
			if (arg === "on" || arg === "off" || arg === "only") {
				modeOverride = arg;
				if (arg === "off") dispatch({ type: "stopRequested" });
				ctx.ui.notify(`code_mode mode: ${arg}`);
				return;
			}
			ctx.ui.notify(`Unknown mode "${args.trim()}". Use: on | off | only | status`, "error");
		},
	});

	// REPL state is per-process and per-session: reset on switches and shutdown.
	pi.on("session_before_switch", () => dispatch({ type: "stopRequested" }));
	pi.on("session_before_fork", () => dispatch({ type: "stopRequested" }));
	pi.on("session_shutdown", () => dispatch({ type: "stopRequested" }));
}
