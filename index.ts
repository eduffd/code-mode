// code-mode — Pi extension: persistent REPL + session-level tool gating.
//
// - `code_mode` tool: the model writes JavaScript; it runs in a long-lived
//   worker whose vm context persists top-level bindings across calls.
//   Session tools are callable as `tools.<name>(args)`; output is distilled.
// - `/code-mode` command: on | off | only | status — "only" hides direct tool
//   declarations from the model (they stay callable from scripts), steering
//   work through the REPL. Mirrors the built-in codemode "only" mode but is
//   session-scoped instead of a global setting.
//
// See DESIGN.md.

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateOutput, type OutputItem } from "./output";

// ---------------------------------------------------------------- protocol types

interface ToolDecl {
	name: string;
	description: string;
}

interface WorkerError {
	name: string;
	message: string;
	stack?: string;
}

type WorkerOutMessage =
	| { type: "ready" }
	| { type: "toolCall"; callId: number; name: string; args: unknown }
	| {
			type: "end";
			id: number;
			ok: boolean;
			value?: string;
			error?: WorkerError;
			output: OutputItem[];
	  };

const isWorkerOutMessage = (m: unknown): m is WorkerOutMessage => {
	if (typeof m !== "object" || m === null) return false;
	const t = (m as { type?: unknown }).type;
	if (t === "ready") return true;
	if (t === "toolCall") {
		const x = m as { callId?: unknown; name?: unknown };
		return typeof x.callId === "number" && typeof x.name === "string";
	}
	if (t === "end") {
		const x = m as { id?: unknown; ok?: unknown; output?: unknown };
		return typeof x.id === "number" && typeof x.ok === "boolean" && Array.isArray(x.output);
	}
	return false;
};

interface ExecOutcome {
	ok: boolean;
	value?: string;
	error?: WorkerError;
	output: OutputItem[];
	/** True when the worker died or was killed around this call: earlier REPL state is gone. */
	stateLost: boolean;
}

interface ExecWaiter {
	resolve: (outcome: Omit<ExecOutcome, "stateLost">) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------- constants

const DEFAULT_TIMEOUT_MS = 120_000;
const DISCOVERY_GLOBALS = /\b(searchTools|describeTool|describeNamespace|ALL_TOOLS)\b/;
const CODE_MODE_TOOL = "code_mode";

const workerPath = fileURLToPath(new URL("./repl-worker.js", import.meta.url));
const packageDir = path.dirname(workerPath);

// ---------------------------------------------------------------- helpers

const toIdentifier = (name: string): string => name.replace(/[^A-Za-z0-9_$]/g, "_");

interface ContentItem {
	type?: unknown;
	text?: unknown;
}

/** Join the text items of a tool result's content array; "" when none. */
const contentText = (content: unknown): string =>
	Array.isArray(content)
		? (content as ContentItem[])
				.map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
				.filter((s) => s.length > 0)
				.join("\n")
		: "";

// ---------------------------------------------------------------- extension

export default function codeModeExtension(pi: ExtensionAPI) {
	// Session-scoped mode override; null = follow settings (codemode.mode, default "on").
	let modeOverride: "on" | "off" | "only" | null = null;
	let permissionFlagsSupported = true;

	let worker: ChildProcess | null = null;
	let workerReady = false;
	let execSeq = 0;
	const pendingExecs = new Map<number, ExecWaiter>();
	/** The execute() context, valid while one script runs; nested tool calls need it. */
	let activeToolCtx: ExtensionToolContext | undefined;
	let execQueue: Promise<void> = Promise.resolve();

	const resolveMode = (): "on" | "off" | "only" => {
		if (modeOverride !== null) return modeOverride;
		const setting = pi.getSettings().codemode?.mode;
		return setting === "only" ? "only" : setting === "off" ? "off" : "on";
	};

	// ---- worker lifecycle

	function killWorker(): void {
		const proc = worker;
		worker = null;
		workerReady = false;
		if (proc) {
			proc.removeAllListeners();
			proc.kill();
		}
		for (const [, waiter] of pendingExecs) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("code_mode worker stopped; REPL state was lost"));
		}
		pendingExecs.clear();
	}

	function spawnWorker(): Promise<void> {
		return new Promise((resolve, reject) => {
			// Best-effort hardening: the worker gets no fs/cli access except this
			// package dir (worker source + acorn dependency live there).
			const flags = permissionFlagsSupported ? ["--permission", `--allow-fs-read=${packageDir}`] : [];
			const proc = fork(workerPath, [], {
				cwd: packageDir,
				execArgv: flags,
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			const stderr: string[] = [];
			proc.stderr?.on("data", (chunk: Buffer) => {
				if (stderr.length < 20) stderr.push(chunk.toString());
			});
			const fail = (message: string) => {
				clearTimeout(bootTimer);
				proc.removeAllListeners();
				proc.kill();
				reject(new Error(`${message}${stderr.length > 0 ? `: ${stderr.join("")}` : ""}`));
			};
			const bootTimer = setTimeout(() => fail("code_mode worker did not start"), 5_000);
			proc.once("message", (msg: unknown) => {
				if (isWorkerOutMessage(msg) && msg.type === "ready") {
					clearTimeout(bootTimer);
					worker = proc;
					workerReady = true;
					proc.on("message", onWorkerMessage);
					proc.once("exit", () => {
						if (worker === proc) killWorker();
					});
					resolve();
				}
			});
			proc.once("error", (err: Error) => fail(`code_mode worker failed to spawn: ${err.message}`));
			proc.once("exit", () => fail("code_mode worker exited during boot"));
		});
	}

	async function ensureWorker(): Promise<void> {
		if (worker !== null && workerReady) return;
		killWorker();
		try {
			await spawnWorker();
		} catch (err) {
			if (!permissionFlagsSupported) throw err;
			// Permission flags may be unsupported or broken on this Node build — retry plain.
			permissionFlagsSupported = false;
			await spawnWorker();
		}
	}

	function onWorkerMessage(msg: unknown): void {
		if (!isWorkerOutMessage(msg)) return;
		if (msg.type === "toolCall") {
			void answerToolCall(msg.callId, msg.name, msg.args);
			return;
		}
		if (msg.type === "end") {
			const waiter = pendingExecs.get(msg.id);
			if (!waiter) return;
			pendingExecs.delete(msg.id);
			clearTimeout(waiter.timer);
			waiter.resolve({ ok: msg.ok, value: msg.value, error: msg.error, output: msg.output });
		}
	}

	async function answerToolCall(callId: number, name: string, args: unknown): Promise<void> {
		const proc = worker;
		if (!proc) return;
		let payload: { ok: true; value: unknown } | { ok: false; error: string };
		try {
			if (!activeToolCtx) throw new Error("no active code_mode context");
			const outcome = await activeToolCtx.executeTool(name, args);
			const result = outcome.result;
			if (outcome.isError) {
				payload = { ok: false, error: contentText(result?.content) || "tool call failed" };
			} else if (result?.structuredContent !== undefined) {
				payload = { ok: true, value: result.structuredContent };
			} else {
				payload = { ok: true, value: contentText(result?.content) };
			}
		} catch (err) {
			payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		if (worker === proc) proc.send({ type: "toolResult", callId, ...payload });
	}

	// ---- script execution

	function toolDeclarations(): ToolDecl[] {
		return (activeToolCtx?.tools ?? [])
			.filter((t) => t.name !== CODE_MODE_TOOL)
			.map((t) => ({ name: t.name, description: t.description ?? "" }));
	}

	async function runScript(code: string, timeoutMs: number): Promise<ExecOutcome> {
		const run = execQueue.then(async (): Promise<Omit<ExecOutcome, "stateLost">> => {
			try {
				await ensureWorker();
			} catch (err) {
				return {
					ok: false,
					error: { name: "SandboxError", message: err instanceof Error ? err.message : String(err) },
					output: [],
				};
			}
			const proc = worker;
			if (!proc) {
				return {
					ok: false,
					error: { name: "SandboxError", message: "code_mode worker unavailable" },
					output: [],
				};
			}
			const id = ++execSeq;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pendingExecs.delete(id);
					// Hard timeout: kill the worker; a spinning script cannot be interrupted otherwise.
					killWorker();
					resolve({
						ok: false,
						error: {
							name: "TimeoutError",
							message: `script exceeded ${timeoutMs} ms and the worker was killed; REPL state was lost — re-set any variables you still need`,
						},
						output: [],
					});
				}, timeoutMs);
				pendingExecs.set(id, { resolve, reject, timer });
				proc.send({ type: "exec", id, code, tools: toolDeclarations() });
			});
		});
		execQueue = run.then(
			() => undefined,
			() => undefined,
		);
		try {
			return { ...(await run), stateLost: worker === null };
		} catch (err) {
			return {
				ok: false,
				error: { name: "WorkerError", message: err instanceof Error ? err.message : String(err) },
				output: [],
				stateLost: true,
			};
		}
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
		}
		if (outcome.stateLost) {
			sections.push(
				outcome.ok
					? "(note: the REPL worker restarted before this call; state from earlier calls is gone)"
					: "(REPL state was lost)",
			);
		}
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
			"Discovery: `ALL_TOOLS`, `searchTools(query)`, `describeTool(name)`, `describeNamespace(name)`.",
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
			activeToolCtx = ctx;
			const outcome = await runScript(
				params.code,
				typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : DEFAULT_TIMEOUT_MS,
			);
			activeToolCtx = undefined;
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
				"- `ALL_TOOLS`, `searchTools(query)`, `describeTool(name)`, `describeNamespace(name)` for discovery.",
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
				const setting = pi.getSettings().codemode?.mode;
				const source =
					modeOverride !== null
						? "session override"
						: setting === undefined
							? "settings default"
							: `settings: ${setting}`;
				ctx.ui.notify(`code_mode mode: ${resolveMode()} (${source})`);
				return;
			}
			if (arg === "on" || arg === "off" || arg === "only") {
				modeOverride = arg;
				if (arg === "off") killWorker();
				ctx.ui.notify(`code_mode mode: ${arg}`);
				return;
			}
			ctx.ui.notify(`Unknown mode "${args.trim()}". Use: on | off | only | status`, "error");
		},
	});

	// REPL state is per-process and per-session: reset on switches and shutdown.
	pi.on("session_before_switch", () => killWorker());
	pi.on("session_before_fork", () => killWorker());
	pi.on("session_shutdown", () => killWorker());
}
