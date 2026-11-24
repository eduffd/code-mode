// worker-host.ts — the effect interpreter for the code_mode exec lifecycle.
// The pure core (lifecycle.ts) decides what happens; this module is the only
// place that touches node:child_process, timers, or the worker pidfile, and
// the only place raw worker messages cross in (isWorkerOutMessage guard).
//
// Loaded through jiti from index.ts; the explicit "./protocol.ts" and
// "./lifecycle.ts" specifiers also keep it loadable from plain Node type
// stripping.

import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { isWorkerOutMessage, type WorkerInMessage, type WorkerOutMessage } from "./protocol.ts";
import type { Effect, LifecycleEvent, SpawnFlags, WorkerHandle } from "./lifecycle.ts";

const defaultWorkerPath = fileURLToPath(new URL("./repl-worker.js", import.meta.url));
const packageDir = path.dirname(defaultWorkerPath);
const pidFile = path.join(packageDir, ".code-mode-worker.pid");

/** Per-project REPL state file: the last completed exec's snapshot, restored on respawn or restart. */
const defaultStatePath = (): string =>
	path.join(packageDir, `.code-mode-repl-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12)}.state`);

const BOOT_TIMEOUT_MS = 5_000;
const STDERR_LINES = 20;

/** The hardened spawn flags: no fs/cli access except the given directory (worker source + acorn live there). */
export const permissionArgv = (dir: string): string[] => ["--permission", `--allow-fs-read=${dir}`];

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isTextItem = (item: unknown): item is { type: "text"; text: string } =>
	typeof item === "object" &&
	item !== null &&
	"type" in item &&
	item.type === "text" &&
	"text" in item &&
	typeof item.text === "string";

const contentText = (content: unknown): string =>
	Array.isArray(content)
		? content
				.map((item) => (isTextItem(item) ? item.text : ""))
				.filter((s) => s.length > 0)
				.join("\n")
		: "";

export interface ToolContextLike {
	executeTool(name: string, args: unknown): Promise<{
		isError?: boolean;
		result?: { content?: unknown; structuredContent?: unknown };
	}>;
}

export interface WorkerHost {
	/** Slot the active execute() context in; nested tool calls answer through it. */
	setToolContext(ctx: ToolContextLike | undefined): void;
	interpret(effect: Effect): void;
	/** Drop the in-memory and on-disk REPL snapshot; a deliberate stop means fresh state. */
	discardSnapshot(): void;
}

export const createWorkerHost = (opts: {
	onEvent: (event: LifecycleEvent) => void;
	workerPath?: string;
	/** Override or disable (null) the per-project snapshot file; defaults to the computed path. */
	statePath?: string | null;
}): WorkerHost => {
	const { onEvent } = opts;
	const workerPath = opts.workerPath ?? defaultWorkerPath;
	const statePath = opts.statePath === undefined ? defaultStatePath() : opts.statePath;
	const children = new Map<WorkerHandle, ChildProcess>();
	const bootTimers = new Map<WorkerHandle, NodeJS.Timeout>();
	const timers = new Map<number, NodeJS.Timeout>();
	let toolContext: ToolContextLike | undefined;

	// ---- REPL snapshot: the last completed exec's serialized sandbox, restored
	// onto the next worker (respawn after crash/timeout, or a Pi restart). A
	// deliberate stop discards it; the adapter calls discardSnapshot for those.

	let latestSnapshot: Buffer | null = null;
	const restoredHandles = new Set<number>();
	if (statePath) {
		try {
			const disk = readFileSync(statePath);
			if (disk.length > 0) latestSnapshot = disk;
		} catch {}
	}
	const writeStateFile = (blob: Buffer): void => {
		if (!statePath) return;
		try {
			writeFileSync(statePath, blob);
		} catch {}
	};

	// ---- pidfile: a best-effort breadcrumb (parent + child pid) for cleanup
	// scoped to recorded pids instead of process names.
	// scripts/worker-cleanup.mjs is the official consumer.

	const writePidFile = (proc: ChildProcess): void => {
		try {
			writeFileSync(pidFile, `${JSON.stringify({ parent: process.pid, child: proc.pid })}\n`);
		} catch {}
	};

	const removePidFile = (): void => {
		try {
			unlinkSync(pidFile);
		} catch {}
	};

	const flagsToArgv = (flags: SpawnFlags): string[] => (flags === "permission" ? permissionArgv(packageDir) : []);

	const interpretSpawn = (handle: WorkerHandle, flags: SpawnFlags): void => {
		let proc: ChildProcess;
		try {
			proc = fork(workerPath, [], { cwd: packageDir, execArgv: flagsToArgv(flags), stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
		} catch (err) {
			onEvent({ type: "bootFailed", handle, message: `code_mode worker failed to spawn: ${errorMessage(err)}` });
			return;
		}
		children.set(handle, proc);
		// A send to a dead child's channel raises an async 'error' event (EPIPE),
		// not a synchronous throw interpretSend's catch could handle; swallow it —
		// the exit path settles whatever the send was for.
		proc.on("error", () => {});
		const stderr: string[] = [];
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < STDERR_LINES) stderr.push(chunk.toString());
		});
		let booted = false;
		const fail = (message: string): void => {
			if (booted) return;
			booted = true;
			clearTimeout(bootTimer);
			bootTimers.delete(handle);
			proc.removeAllListeners();
			proc.kill();
			children.delete(handle);
			onEvent({ type: "bootFailed", handle, message: `${message}${stderr.length > 0 ? `: ${stderr.join("")}` : ""}` });
		};
		const bootTimer = setTimeout(() => fail("code_mode worker did not start"), BOOT_TIMEOUT_MS);
		bootTimers.set(handle, bootTimer);
		proc.once("message", (msg: unknown) => {
			if (booted || !isWorkerOutMessage(msg) || msg.type !== "ready") return;
			booted = true;
			clearTimeout(bootTimer);
			bootTimers.delete(handle);
			writePidFile(proc);
			proc.on("message", (m: unknown) => {
				if (!isWorkerOutMessage(m)) return;
				if (m.type === "end" && m.state !== undefined) {
					latestSnapshot = Buffer.from(m.state);
					writeStateFile(latestSnapshot);
					const { state: _state, ...rest } = m;
					onEvent({ type: "workerMessage", handle, message: rest as WorkerOutMessage });
					return;
				}
				onEvent({ type: "workerMessage", handle, message: m });
			});
			proc.once("exit", () => {
				children.delete(handle);
				removePidFile();
				onEvent({ type: "workerDied", handle });
			});
			onEvent({ type: "booted", handle });
		});
		proc.once("error", (err: Error) => fail(`code_mode worker failed to spawn: ${err.message}`));
		proc.once("exit", () => fail("code_mode worker exited during boot"));
	};

	const interpretKill = (handle: WorkerHandle): void => {
		const proc = children.get(handle);
		if (!proc) return;
		children.delete(handle);
		const bootTimer = bootTimers.get(handle);
		if (bootTimer !== undefined) {
			clearTimeout(bootTimer);
			bootTimers.delete(handle);
		}
		removePidFile();
		// Detach listeners so the death of a killed worker raises no events.
		proc.removeAllListeners();
		proc.on("error", () => {}); // the strip removed the spawn-time guard; a late send to this channel must not crash the host
		proc.kill();
	};

	const interpretSend = (handle: WorkerHandle, message: WorkerInMessage): void => {
		const proc = children.get(handle);
		if (!proc) return;
		let outgoing: WorkerInMessage = message;
		// The first exec a fresh worker receives carries the snapshot to restore;
		// its outcome reports what came back, so the model is never misled.
		if (message.type === "exec" && !restoredHandles.has(handle.seq) && latestSnapshot) {
			restoredHandles.add(handle.seq);
			outgoing = { ...message, restore: latestSnapshot };
		}
		try {
			proc.send(outgoing);
		} catch {
			// channel closing: the child's exit event settles whatever was pending
		}
	};

	const interpretSetTimer = (id: number, durationMs: number): void => {
		const existing = timers.get(id);
		if (existing !== undefined) clearTimeout(existing);
		timers.set(
			id,
			setTimeout(() => {
				timers.delete(id);
				onEvent({ type: "timeoutFired", id });
			}, durationMs),
		);
	};

	const interpretClearTimer = (id: number): void => {
		const timer = timers.get(id);
		if (timer === undefined) return;
		clearTimeout(timer);
		timers.delete(id);
	};

	const interpretAnswerTool = async (handle: WorkerHandle, execId: number, callId: number, name: string, args: unknown): Promise<void> => {
		let answer: { ok: true; value?: unknown } | { ok: false; error?: string };
		if (!toolContext) {
			answer = { ok: false, error: "no active code_mode context" };
		} else {
			try {
				const outcome = await toolContext.executeTool(name, args);
				const result = outcome.result;
				if (outcome.isError) answer = { ok: false, error: contentText(result?.content) || "tool call failed" };
				else if (result?.structuredContent !== undefined) answer = { ok: true, value: result.structuredContent };
				else answer = { ok: true, value: contentText(result?.content) };
			} catch (err) {
				answer = { ok: false, error: errorMessage(err) };
			}
		}
		onEvent({
			type: "toolAnswered",
			handle,
			execId,
			callId,
			name,
			ok: answer.ok,
			value: answer.ok ? answer.value : undefined,
			error: answer.ok ? undefined : answer.error,
		});
	};

	const interpret = (effect: Effect): void => {
		switch (effect.type) {
			case "spawn":
				return interpretSpawn(effect.handle, effect.flags);
			case "send":
				return interpretSend(effect.handle, effect.message);
			case "kill":
				return interpretKill(effect.handle);
			case "setTimer":
				return interpretSetTimer(effect.id, effect.durationMs);
			case "clearTimer":
				return interpretClearTimer(effect.id);
			case "answerTool":
				void interpretAnswerTool(effect.handle, effect.execId, effect.callId, effect.name, effect.args);
				return;
		}
	};

	return {
		setToolContext: (ctx) => {
			toolContext = ctx;
		},
		interpret,
		discardSnapshot: () => {
			latestSnapshot = null;
			if (statePath) {
				try {
					unlinkSync(statePath);
				} catch {}
			}
		},
	};
};
