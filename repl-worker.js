// repl-worker.js — long-lived REPL worker for the code-mode Pi extension.
//
// Spawned via child_process.fork. Holds ONE node:vm context for the worker's
// whole life; every script runs against that same context, so top-level
// bindings (var/function via globalThis, let/const/class via the realm's
// shared global lexical scope) persist across execs.
//
// The fork-IPC protocol (in: exec/toolResult/ping, out: ready/toolCall/end)
// lives in protocol.ts — both sides import it from there.

import vm from "node:vm";
import { format, inspect } from "node:util";
import { parse } from "acorn";
import { isWorkerInMessage } from "./protocol.ts";

const EXIT = Symbol("code_mode.exit");

// ---------------------------------------------------------------- state

const sandbox = Object.create(null);
const ctx = vm.createContext(sandbox);

let out = []; // output items for the running exec
let callSeq = 0;
const pendingCalls = new Map(); // callId -> { resolve, reject }

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

// ---------------------------------------------------------------- compilation

// Try the direct path first: a plain vm.Script compiles when the code has no
// top-level await, and then native semantics apply (let/const persist via the
// realm's lexical scope; redeclaring throws honest REPL errors).
// If the failure is precisely a top-level await, rewrite top-level
// declarations into globalThis assignments and run inside an async IIFE.
function compile(code) {
	try {
		new vm.Script(code);
		return { kind: "script", source: code };
	} catch (scriptError) {
		// Any Script failure may be a top-level await (plain `await ...` says "await is
		// only valid in async", `for await` says "Unexpected reserved word") or a top-level
		// `return` ("Illegal return statement"). Acorn with allowAwaitOutsideFunction and
		// allowReturnOutsideFunction parses both; if it agrees the code is valid, take the
		// rewrite path (the async IIFE supports return). Otherwise the Script error is the
		// honest one — rethrow it.
		try {
			parse(code, { ecmaVersion: "latest", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
		} catch {
			throw scriptError;
		}
		return { kind: "async", source: `(async () => {\n${rewriteTopLevel(code)}\n})()` };
	}
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function patternNames(node, acc = []) {
	if (!node) return acc;
	switch (node.type) {
		case "Identifier":
			acc.push(node.name);
			break;
		case "ObjectPattern":
			for (const prop of node.properties) patternNames(prop.type === "Property" ? prop.value : prop.argument, acc);
			break;
		case "ArrayPattern":
			for (const el of node.elements) patternNames(el, acc);
			break;
		case "AssignmentPattern":
			patternNames(node.left, acc);
			break;
		case "RestElement":
			patternNames(node.argument, acc);
			break;
		// MemberExpression and anything else: not a binding — skip.
	}
	return acc;
}

function capturedNames(stmt) {
	switch (stmt.type) {
		case "VariableDeclaration":
			return stmt.declarations.flatMap((d) => patternNames(d.id));
		case "FunctionDeclaration":
		case "ClassDeclaration":
			return stmt.id ? [stmt.id.name] : [];
		default:
			return [];
	}
}

// Splice `globalThis.<name> = <name>;` after each top-level declaration.
// The original declaration stays as-is (it works inside the IIFE); the
// appended lines copy the bindings into persistent globalThis storage.
// The last top-level expression statement becomes an explicit `return` so the
// async IIFE reproduces the native Script completion-value semantics.
function rewriteTopLevel(code) {
	const ast = parse(code, { ecmaVersion: "latest", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
	const statements = ast.body;
	const lastStatement = statements[statements.length - 1];
	let result = "";
	let pos = 0;
	for (const stmt of statements) {
		const names = capturedNames(stmt);
		const isReturned = stmt === lastStatement && stmt.type === "ExpressionStatement";
		result += isReturned ? `${code.slice(pos, stmt.start)}return ${code.slice(stmt.start, stmt.end)};` : code.slice(pos, stmt.end);
		if (names.length > 0) {
			result +=
				"\n" +
				names
					.map((n) => (IDENT_RE.test(n) ? `globalThis.${n} = ${n};` : `globalThis[${JSON.stringify(n)}] = ${n};`))
					.join("\n");
		}
		pos = stmt.end;
	}
	result += code.slice(pos);
	return result;
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
		const compiled = compile(String(msg.code ?? ""));
		const raw = vm.runInContext(compiled.source, ctx, {
			filename: "code_mode.js",
			breakOnSigint: true,
		});
		value = compiled.kind === "async" ? await raw : raw;
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
