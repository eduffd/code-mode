// repl-worker.js — long-lived REPL worker for the code-mode Pi extension.
//
// Spawned via child_process.fork. Holds ONE node:vm context for the worker's
// whole life; every script runs against that same context, so top-level
// bindings (var/function via globalThis, let/const/class via the realm's
// shared global lexical scope) persist across execs.

import vm from "node:vm";
import { format, inspect } from "node:util";
import { isWorkerInMessage } from "./protocol.ts";
import { compileScript } from "./compile.ts";

const EXIT = Symbol("code_mode.exit");

// ---------------------------------------------------------------- state

const sandbox = Object.create(null);
const ctx = vm.createContext(sandbox);

let out = []; // output items for the running exec
let callSeq = 0;
const pendingCalls = new Map(); // callId -> { resolve, reject }
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

function callTool(name, args) {
	const callId = ++callSeq;
	return new Promise((resolve, reject) => {
		pendingCalls.set(callId, { resolve, reject });
		process.send({ type: "toolCall", callId, name, args: args ?? {} });
	});
}

const tools = new Proxy(Object.create(null), {
	get(_t, prop) {
		// `then` guard: awaiting the proxy itself must not deadlock.
		if (prop === "then" || typeof prop === "symbol") return undefined;
		return (args) => callTool(String(prop), args);
	},
});

Object.assign(sandbox, { tools, text, image, exit });

// ---------------------------------------------------------------- discovery globals

function setSearchGlobals(toolDecls) {
	sandbox.ALL_TOOLS = Object.freeze(toolDecls.map((t) => t.name));
	sandbox.searchTools = (query) => {
		const q = String(query).toLowerCase();
		return toolDecls
			.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q))
			.map((t) => ({ name: t.name, description: t.description ?? "" }));
	};
	sandbox.describeTool = (name) => {
		const t = toolDecls.find((d) => d.name === String(name));
		return t ? { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema } : undefined;
	};
	sandbox.describeNamespace = (name) => {
		// Namespaces: MCP tools are `mcp__<server>__<tool>`; group by that prefix.
		const prefix = String(name);
		const members = toolDecls.filter((t) => t.name.startsWith(`${prefix}__`));
		if (members.length === 0) return undefined;
		return { name: prefix, tools: members.map((t) => ({ name: t.name, description: t.description ?? "" })) };
	};
}

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
	sandbox.console = makeConsole();
	setSearchGlobals(msg.tools ?? []);
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

process.send({ type: "ready" });
