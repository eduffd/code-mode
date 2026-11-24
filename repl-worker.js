// repl-worker.js — long-lived REPL worker for the code-mode Pi extension.
//
// Spawned via child_process.fork. Holds ONE node:vm context for the worker's
// whole life; every script runs against that same context, so top-level
// bindings (var/function via globalThis, let/const/class via the realm's
// shared global lexical scope) persist across execs.

import vm from "node:vm";
import { format, inspect } from "node:util";
import { isWorkerInMessage, toIdentifier } from "./protocol.ts";
import { compileScript } from "./compile.ts";

const EXIT = Symbol("code_mode.exit");

// ---------------------------------------------------------------- state

const sandbox = Object.create(null);
const ctx = vm.createContext(sandbox);

let out = []; // output items for the running exec
let callSeq = 0;
const pendingCalls = new Map(); // callId -> { resolve, reject }
let currentExecId = null; // the exec whose tool calls are in flight; null between execs
const persisted = new Set(); // top-level names earlier execs captured to globalThis

// ---------------------------------------------------------------- output helpers

function makeConsole() {
	const push = (level, args) => {
		out.push({ type: "text", text: `[${level}] ${format(...args)}`, console: true });
	};
	return {
		log: (...a) => push("log", a),
		info: (...a) => push("info", a),
		warn: (...a) => push("warn", a),
		error: (...a) => push("error", a),
		debug: (...a) => push("debug", a),
	};
}

function text(s) {
	out.push({ type: "text", text: typeof s === "string" ? s : inspect(s, { depth: 6 }) });
}

function image(data, mimeType = "image/png") {
	out.push({ type: "image", data: String(data), mimeType: String(mimeType) });
}

function exit(value) {
	const err = new Error("exit");
	err[EXIT] = true;
	err.value = value;
	throw err;
}

// ---------------------------------------------------------------- tool bridge

// Per-exec tool registry: the raw ToolDecl list, plus the identifier form
// (`web.search` -> `web_search`) derived from it. Both forms resolve; on a
// collision the raw name wins.
const toolByRaw = new Map();
const rawByIdentifier = new Map();

const installTools = (decls) => {
	toolByRaw.clear();
	rawByIdentifier.clear();
	for (const t of decls) {
		toolByRaw.set(t.name, t);
		const id = toIdentifier(t.name);
		if (!rawByIdentifier.has(id)) rawByIdentifier.set(id, t.name);
	}
	sandbox.ALL_TOOLS = Object.freeze(decls.map((t) => t.name));
	sandbox.searchTools = (query) => {
		const q = String(query).toLowerCase();
		return decls
			.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q))
			.map((t) => ({ name: t.name, description: t.description ?? "" }));
	};
	sandbox.describeTool = (name) => {
		const t = toolByRaw.get(String(name));
		return t ? { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema } : undefined;
	};
	sandbox.describeNamespace = (name) => {
		// Namespaces: MCP tools are `mcp__<server>__<tool>`; group by that prefix.
		const prefix = String(name);
		const members = decls.filter((t) => t.name.startsWith(`${prefix}__`));
		if (members.length === 0) return undefined;
		return { name: prefix, tools: members.map((t) => ({ name: t.name, description: t.description ?? "" })) };
	};
};

// ---- suggestions: bounded Levenshtein, dependency-free

const editDistance = (a, b, cap) => {
	if (Math.abs(a.length - b.length) > cap) return cap + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i += 1) {
		let diag = prev[0];
		prev[0] = i;
		const cur = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j += 1) {
			const d = Math.min(prev[j] + 1, cur[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = prev[j];
			cur[j] = d;
			if (d < rowMin) rowMin = d;
		}
		if (rowMin > cap) return cap + 1;
		prev = cur;
	}
	return prev[b.length];
};

const SUGGEST_LIMIT = 3;

/** Candidates within a tolerance that shrinks for short names; a prefix relation ("timeout_secs" -> "timeout") always counts. */
const closestNames = (target, candidates) => {
	const cap = Math.max(2, Math.ceil(target.length / 2));
	const scored = [];
	for (const c of candidates) {
		if (c === target) continue;
		const related = c.startsWith(target) || target.startsWith(c);
		const d = related ? Math.min(editDistance(target, c, cap), 2) : editDistance(target, c, cap);
		if (d <= cap) scored.push({ c, d });
	}
	scored.sort((x, y) => x.d - y.d || x.c.length - y.c.length);
	return scored.slice(0, SUGGEST_LIMIT).map((s) => s.c);
};

const unknownToolError = (prop) => {
	const suggestions = closestNames(prop, toolByRaw.keys());
	if (suggestions.length > 0) {
		return new Error(
			`Unknown tool "${prop}". Did you mean ${suggestions.map((s) => `"${s}"`).join(", ")}? Use searchTools() to list tools.`,
		);
	}
	const available = [...toolByRaw.keys()];
	const shown = available.slice(0, 6).join(", ") + (available.length > 6 ? ", …" : "");
	return new Error(`Unknown tool "${prop}". Use searchTools() to list tools.${shown ? ` Available: ${shown}` : ""}`);
};

const resolveToolName = (prop) => {
	if (toolByRaw.has(prop)) return prop;
	const mapped = rawByIdentifier.get(prop);
	if (mapped !== undefined) return mapped;
	throw unknownToolError(prop);
};

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Additive warnings for argument keys the tool's inputSchema does not know. Never blocks the call. */
const paramWarnings = (decl, args) => {
	const schema = decl?.inputSchema;
	if (!isPlainObject(schema) || !isPlainObject(schema.properties) || !isPlainObject(args)) return [];
	const known = Object.keys(schema.properties);
	const warnings = [];
	for (const key of Object.keys(args)) {
		if (known.includes(key)) continue;
		const [suggestion] = closestNames(key, known);
		warnings.push(
			suggestion
				? `unknown parameter "${key}" for tool "${decl.name}" — did you mean "${suggestion}"?`
				: `unknown parameter "${key}" for tool "${decl.name}" (known: ${known.join(", ") || "none"})`,
		);
	}
	return warnings;
};

function callTool(name, args) {
	for (const w of paramWarnings(toolByRaw.get(name), args)) {
		out.push({ type: "text", text: `[codemode] ${w}` });
	}
	const callId = ++callSeq;
	return new Promise((resolve, reject) => {
		pendingCalls.set(callId, { resolve, reject });
		process.send({ type: "toolCall", execId: currentExecId, callId, name, args: args ?? {} });
	});
}

const tools = new Proxy(Object.create(null), {
	get(_t, prop) {
		// `then` guard: awaiting the proxy itself must not deadlock.
		if (prop === "then" || typeof prop === "symbol") return undefined;
		// Loud surface: an unknown name throws with the closest real names —
		// a guessed API must not silently no-op.
		const name = resolveToolName(String(prop));
		return (args) => callTool(name, args);
	},
});

Object.assign(sandbox, { tools, text, image, exit });

// ---------------------------------------------------------------- exec runner

function serializeValue(v) {
	if (v === undefined) return undefined;
	if (typeof v === "string") return v;
	try {
		const json = JSON.stringify(v, null, 2);
		return json === undefined ? inspect(v, { depth: 6 }) : json;
	} catch {
		return inspect(v, { depth: 6 });
	}
}

function serializeError(e) {
	return {
		name: e?.name ?? "Error",
		message: e?.message ?? String(e),
		stack: typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 8).join("\n") : undefined,
	};
}

async function runExec(msg) {
	out = [];
	currentExecId = msg.id;
	sandbox.console = makeConsole();
	installTools(msg.tools ?? []);
	let ok = true;
	let value;
	let error;
	try {
		// ONE compile path: every script goes through the acorn rewrite
		// (compile.ts), so compile semantics are identical for every shape.
		const compiled = compileScript(String(msg.code ?? ""), { persistedNames: persisted });
		try {
			value = await vm.runInContext(compiled.source, ctx, {
				filename: "code_mode.js",
				breakOnSigint: true,
			});
		} finally {
			// Record captures that actually landed (a script that threw midway
			// may still have captured earlier declarations — native semantics).
			for (const name of compiled.capturedNames) if (name in sandbox) persisted.add(name);
		}
	} catch (e) {
		if (e && e[EXIT]) {
			value = e.value;
		} else {
			ok = false;
			error = serializeError(e);
		}
	}
	process.send({ type: "end", id: msg.id, ok, value: serializeValue(value), error, output: out });
	// A fire-and-forget tool call must not outlive its exec: its entry would
	// resolve a promise nobody awaits and leak; the core drops the late answer.
	pendingCalls.clear();
	currentExecId = null;
	out = [];
}

// ---------------------------------------------------------------- message loop

process.on("message", (msg) => {
	if (!isWorkerInMessage(msg)) return;
	switch (msg.type) {
		case "exec":
			runExec(msg).catch((e) => {
				process.send({
					type: "end",
					id: msg.id,
					ok: false,
					error: { name: "SandboxError", message: `worker failed: ${e?.message ?? e}` },
					output: out,
				});
				out = [];
			});
			break;
		case "toolResult": {
			const pending = pendingCalls.get(msg.callId);
			if (!pending) break;
			pendingCalls.delete(msg.callId);
			if (msg.ok) pending.resolve(msg.value);
			else pending.reject(new Error(msg.error ?? "tool call failed"));
			break;
		}
		case "ping":
			process.send({ type: "ready" });
			break;
	}
});

process.on("uncaughtException", (e) => {
	// Keep the worker alive; report on stderr for the extension's spawn logs.
	process.stderr.write(`code-mode worker uncaught: ${e?.stack ?? e}\n`);
});
process.on("unhandledRejection", (e) => {
	process.stderr.write(`code-mode worker unhandled rejection: ${e?.stack ?? e}\n`);
});

// The host owns our channel; when it drops (host crash, channel close, kill),
// self-exit so no orphan worker lingers. Safe since the lifecycle core
// settles every pending exec when the worker dies.
process.on("disconnect", () => process.exit(0));

// JIT warmup: the first execs pay for V8 JIT-ing acorn and the vm run
// machinery (~1.2 ms on exec 1, tens of µs for the next few hundred). Pre-run
// the one compile path at boot so exec 1 costs what exec 1000 costs — the
// 20-exec round-trip budget cannot absorb the ramp. Unique sources defeat
// V8's compilation cache (that is the point: warm the parser, not the cache);
// expression-only scripts capture nothing, so the sandbox stays clean.
// ~2000 parses ≈ single-digit ms of boot, against a 5 s handshake.
for (let i = 0; i < 2000; i += 1) compileScript(`${i} + 1`, { persistedNames: new Set() });
for (let i = 0; i < 25; i += 1) {
	const warm = compileScript(`${i} + 1`, { persistedNames: new Set() });
	vm.runInContext(warm.source, ctx, { filename: "code_mode.js", breakOnSigint: true });
}

process.send({ type: "ready" });
