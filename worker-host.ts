// worker-host.ts — child-process mechanics for the code_mode REPL worker:
// the fork + boot handshake, kill, and the tool-answer payload mapping.
// Lifecycle policy (boot retry, queueing, settlement) stays in index.ts; this
// module only moves children and messages.
//
// Loaded through jiti from index.ts; the explicit "./protocol.ts" specifier
// also keeps it loadable from plain Node type stripping.

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isWorkerOutMessage } from "./protocol.ts";

const workerPath = fileURLToPath(new URL("./repl-worker.js", import.meta.url));
const packageDir = path.dirname(workerPath);

const BOOT_TIMEOUT_MS = 5_000;

/** One captured output item of a tool result's content array. */
interface ContentItem {
	type?: unknown;
	text?: unknown;
}

const isTextItem = (item: unknown): item is { type: "text"; text: string } =>
	typeof item === "object" &&
	item !== null &&
	"type" in item &&
	item.type === "text" &&
	"text" in item &&
	typeof item.text === "string";

/** Join the text items of a tool result's content array; "" when none. */
export const contentText = (content: unknown): string =>
	Array.isArray(content)
		? content
				.map((item) => (isTextItem(item) ? item.text : ""))
				.filter((s) => s.length > 0)
				.join("\n")
		: "";

/** The slice of an ExtensionToolContext executeTool outcome the bridge reads. */
interface ToolOutcomeLike {
	isError?: boolean;
	result?: { content?: unknown; structuredContent?: unknown };
}

/** Map an executeTool outcome to the payload the worker expects in toolResult. */
export const toolAnswerFrom = (
	outcome: ToolOutcomeLike,
): { ok: true; value: unknown } | { ok: false; error: string } => {
	const result = outcome.result;
	if (outcome.isError) return { ok: false, error: contentText(result?.content) || "tool call failed" };
	if (result?.structuredContent !== undefined) return { ok: true, value: result.structuredContent };
	return { ok: true, value: contentText(result?.content) };
};

/**
 * Fork a worker child and resolve once it reports ready. `onReady` runs
 * synchronously inside the ready handler so the caller can adopt the child
 * before any later worker message is processed. Rejects on spawn error, exit
 * during boot, or the boot timeout, appending captured stderr when present.
 */
export const spawnWorker = (opts: {
	permissionFlags: boolean;
	onReady: (proc: ChildProcess) => void;
}): Promise<void> =>
	new Promise((resolve, reject) => {
		// Best-effort hardening: the worker gets no fs/cli access except this
		// package dir (worker source + acorn dependency live there).
		const flags = opts.permissionFlags ? ["--permission", `--allow-fs-read=${packageDir}`] : [];
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
		const bootTimer = setTimeout(() => fail("code_mode worker did not start"), BOOT_TIMEOUT_MS);
		proc.once("message", (msg: unknown) => {
			if (isWorkerOutMessage(msg) && msg.type === "ready") {
				clearTimeout(bootTimer);
				opts.onReady(proc);
				resolve();
			}
		});
		proc.once("error", (err: Error) => fail(`code_mode worker failed to spawn: ${err.message}`));
		proc.once("exit", () => fail("code_mode worker exited during boot"));
	});

/** Best-effort stop of a worker child: detach listeners so no late events fire, then kill. */
export const killChild = (proc: ChildProcess): void => {
	proc.removeAllListeners();
	proc.kill();
};
