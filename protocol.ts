// protocol.ts — the fork-IPC contract between index.ts (host) and
// repl-worker.js. Single source for every message shape, guard, and discovery
// name that crosses the fork; consumers import from here instead of
// re-encoding the shapes.
//
// Loadable from both sides of the fork:
// - the host imports it through jiti (extensionless `./protocol`);
// - the worker and the .mjs drivers import it directly under Node's type
//   stripping with an explicit `./protocol.ts` specifier.
//
// So: keep this file free of imports and of non-erasable TypeScript (no
// enums, no namespaces) — type stripping must be able to load it from plain
// JavaScript.

/** One captured output item of a finished script. The worker's `image()`
 * helper also emits `{type:"image", data, mimeType}` items, which this type
 * does not model — the host formats only text items today. */
export interface OutputItem {
	type: "text";
	text: string;
	console?: true;
}

/** A session tool as declared to the worker; callable as `tools.<name>(args)`. */
export interface ToolDecl {
	name: string;
	description: string;
	/** JSON schema of the tool's parameters, when the host has one; surfaced by `describeTool`. */
	inputSchema?: unknown;
}

export interface WorkerError {
	name: string;
	message: string;
	stack?: string;
}

/** Host -> worker messages. */
export type WorkerInMessage =
	| { type: "exec"; id: number; code: string; tools: ToolDecl[] }
	| { type: "toolResult"; callId: number; ok: boolean; value?: unknown; error?: string }
	| { type: "ping" };

/** Worker -> host messages. */
export type WorkerOutMessage =
	| { type: "ready" }
	| { type: "toolCall"; callId: number; name: string; args: unknown }
	| { type: "end"; id: number; ok: boolean; value?: string; error?: WorkerError; output: OutputItem[] };

/** One answered nested tool call, journaled per exec for interrupted-run reporting. */
export interface ToolCallRecord {
	name: string;
	ok: boolean;
}

/** What the host reports back to the model for one `code_mode` call. */
export interface ExecOutcome {
	ok: boolean;
	value?: string;
	error?: WorkerError;
	output: OutputItem[];
	/** True when the worker died or was killed around this call: earlier REPL state is gone. */
	stateLost: boolean;
	/** Tool calls answered before the run was interrupted; on worker-stopped/timeout outcomes when any landed. */
	journal?: readonly ToolCallRecord[];
}

/** Guard for the messages a worker may send to the host. */
export const isWorkerOutMessage = (m: unknown): m is WorkerOutMessage => {
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

/** Guard for the messages a host may send to the worker. */
export const isWorkerInMessage = (m: unknown): m is WorkerInMessage => {
	if (typeof m !== "object" || m === null) return false;
	const t = (m as { type?: unknown }).type;
	if (t === "exec") {
		const x = m as { id?: unknown; code?: unknown; tools?: unknown };
		return typeof x.id === "number" && typeof x.code === "string" && Array.isArray(x.tools);
	}
	if (t === "toolResult") {
		const x = m as { callId?: unknown; ok?: unknown };
		return typeof x.callId === "number" && typeof x.ok === "boolean";
	}
	return t === "ping";
};

/**
 * The identifier form of a tool name (`web.search` -> `web_search`): the form
 * scripts call on the `tools` proxy. Both the extension's tool descriptions
 * and the worker's bridge derive it from this one function, so the name a
 * script calls is the name the bridge resolves.
 */
export const toIdentifier = (name: string): string => name.replace(/[^A-Za-z0-9_$]/g, "_");

/**
 * The globals the worker injects for tool discovery. The host steers on the
 * same names (`reachesTools`, tool descriptions), so both sides derive from
 * this one list.
 */
export const DISCOVERY_TOOL_NAMES = ["ALL_TOOLS", "searchTools", "describeTool", "describeNamespace"] as const;

/** Host-side regex matching any discovery global in user code. */
export const DISCOVERY_GLOBALS = new RegExp(`\\b(${DISCOVERY_TOOL_NAMES.join("|")})\\b`);

const DISCOVERY_SIGNATURES: Record<(typeof DISCOVERY_TOOL_NAMES)[number], string> = {
	ALL_TOOLS: "ALL_TOOLS",
	searchTools: "searchTools(query)",
	describeTool: "describeTool(name)",
	describeNamespace: "describeNamespace(name)",
};

/** "`ALL_TOOLS`, `searchTools(query)`, ..." — the discovery line in tool descriptions. */
export const DISCOVERY_LISTING = DISCOVERY_TOOL_NAMES.map((n) => `\`${DISCOVERY_SIGNATURES[n]}\``).join(", ");
