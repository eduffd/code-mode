// Standalone test harness: forks repl-worker.js and exercises the protocol.
import { fork } from "node:child_process";
import path from "node:path";
import { isWorkerOutMessage } from "./protocol.ts";

const workerPath = path.resolve("repl-worker.js");
const proc = fork(workerPath, [], { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit", "ipc"] });

let seq = 0;
const execWaiters = new Map();
const toolAnswers = new Map(); // callId -> value
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));

proc.on("message", (msg) => {
	if (!isWorkerOutMessage(msg)) return;
	if (msg.type === "ready") return readyResolve();
	if (msg.type === "toolCall") {
		const value = toolAnswers.get(msg.name);
		proc.send({ type: "toolResult", callId: msg.callId, ok: true, value });
		return;
	}
	if (msg.type === "end") {
		const w = execWaiters.get(msg.id);
		execWaiters.delete(msg.id);
		w(msg);
	}
});

const DEFAULT_TOOLS = [
	{ name: "bash", description: "Runs a bash command" },
	{ name: "read", description: "Reads a file" },
	{ name: "mcp__docs__search", description: "Search docs" },
];

function exec(code, toolValues = {}, tools = DEFAULT_TOOLS) {
	return new Promise((resolve) => {
		const id = ++seq;
		execWaiters.set(id, resolve);
		for (const [k, v] of Object.entries(toolValues)) toolAnswers.set(k, v);
		proc.send({ type: "exec", id, code, tools });
	});
}

const results = [];
function check(name, cond, detail = "") {
	results.push({ name, pass: cond, detail });
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

await ready;
console.log("worker ready\n");

// 1. Native path persistence: var/function
let r = await exec("var a = 1; function inc() { return ++a; } inc()");
check("native: var+function persist, exec returns value", r.ok && r.value === "2", JSON.stringify(r.value));

// 2. Native path: let/const persist via lexical scope
await exec("let counter = 10; const label = 'L';");
r = await exec("counter + 1");
check("native: let persists", r.ok && r.value === "11", JSON.stringify(r.value));
r = await exec("`label=${label}`");
check("native: const persists", r.ok && r.value === "label=L", JSON.stringify(r.value));

// 3. Redeclare throws
r = await exec("let counter = 99;");
check("native: redeclare let throws", !r.ok && /already/.test(r.error?.message ?? ""), r.error?.message);

// 4. TLA path: await + tool call + const capture across calls
r = await exec("const out = await tools.bash({ cmd: 'ls' }); out.length", { bash: "file1\nfile2\nfile3" });
check("tla: tool call resolves", r.ok && r.value === "17", JSON.stringify(r));
r = await exec("out.split('\\n').length");
check("tla: const persists across calls", r.ok && r.value === "3", JSON.stringify(r.value));

// 5. Single-path redeclare semantics: redeclaring a persisted name throws the
// taught message (used to shadow-and-update on the old TLA path); plain
// assignment is the reassignment channel.
r = await exec("const out = 'replaced'; out");
check(
	"single-path: redeclare of a persisted const throws taught message",
	!r.ok && /already been declared/.test(r.error?.message ?? "") && /reassign without const/.test(r.error?.message ?? ""),
	r.error?.message,
);
r = await exec("out = 'replaced'");
check("single-path: assignment reassigns the persisted name", r.ok && r.value === "replaced", JSON.stringify(r.value));
r = await exec("out");
check("single-path: reassign visible in later call", r.ok && r.value === "replaced", JSON.stringify(r.value));

// 6. Destructured const with TLA
r = await exec("const { x, y } = await Promise.resolve({ x: 4, y: 9 }); x + y");
check("tla: destructured const captured", r.ok && r.value === "13", JSON.stringify(r.value));
r = await exec("x * y");
check("tla: destructured bindings persist", r.ok && r.value === "36", JSON.stringify(r.value));

// 7. console capture + text()
r = await exec("console.log('hello', { a: 1 }); console.error('oops'); text('kept');");
check(
	"output: console + text captured in order",
	r.ok && r.output.length === 3 && r.output[0].text === "[log] hello { a: 1 }" && r.output[2].text === "kept",
	JSON.stringify(r.output),
);

// 8. exit(value)
r = await exec("exit({ done: true }); text('unreachable');");
check("exit: ends script with value", r.ok && JSON.parse(r.value).done === true && r.output.length === 0, JSON.stringify(r.value));

// 9. Syntax error propagates
r = await exec("const = 5");
check("syntax error reported", !r.ok && r.error.name === "SyntaxError", JSON.stringify(r.error));

// 10. Runtime error propagates
r = await exec("null.foo");
check("runtime error reported", !r.ok && r.error.name === "TypeError", r.error?.message);

// 11. Discovery globals
r = await exec("ALL_TOOLS.join(',') + '|' + searchTools('docs').length + '|' + describeNamespace('mcp__docs').tools.length");
check(
	"discovery: ALL_TOOLS/searchTools/describeNamespace",
	r.ok && r.value === "bash,read,mcp__docs__search|1|1",
	JSON.stringify(r.value),
);

// 12. Identifier mapping for odd names
r = await exec("(await tools['mcp__docs__search']({ q: 'x' })) ?? 'called'", { "mcp__docs__search": { hits: 3 } });
check("tools proxy: raw name callable", r.ok && JSON.parse(r.value).hits === 3, JSON.stringify(r.value));

// 13. for-await at top level (TLA detection)
r = await exec("let sum = 0; for await (const n of [1,2,3]) { sum += n; } sum");
check("single-path: for-await runs on the one path", r.ok && r.value === "6", JSON.stringify(r));

// 14. top-level function declaration with TLA + persistence
r = await exec("async function helper(v) { return v * 2; }\nconst doubled = await helper(21); doubled");
check("tla: function decl + call in same script", r.ok && r.value === "42", JSON.stringify(r));
r = await exec("await helper(5)");
check("tla: function persists", r.ok && r.value === "10", JSON.stringify(r.value));


// 15. top-level return works in both paths
r = await exec("return 5;");
check("return: bare top-level return on the one path", r.ok && r.value === "5", JSON.stringify(r));
r = await exec("const q = await Promise.resolve(1); return q + 1;");
check("return: TLA path", r.ok && r.value === "2", JSON.stringify(r));
r = await exec("const keep = 'pre';\nreturn keep;");
check("return: declaration capture still runs before return", r.ok && r.value === "pre", JSON.stringify(r));
r = await exec("keep");
check("return: captured var persists after return", r.ok && r.value === "pre", JSON.stringify(r.value));

// 16. Tool bridge: unknown names are loud, with the closest real names.
r = await exec("await tools.bsh({ cmd: 'x' })");
check(
	"bridge: unknown tool name error suggests the closest real tool",
	!r.ok && /Unknown tool "bsh"/.test(r.error?.message ?? "") && /"bash"/.test(r.error?.message ?? "") && /searchTools\(\)/.test(r.error?.message ?? ""),
	r.error?.message,
);
r = await exec("await tools.zzzqqq({})");
check(
	"bridge: unknown tool without a close match lists available tools",
	!r.ok && /searchTools\(\)/.test(r.error?.message ?? "") && /Available: bash/.test(r.error?.message ?? ""),
	r.error?.message,
);

// 17. Parameter-key warnings: additive output next to the tool result; the
// call itself is never blocked.
const SCHEMA_TOOLS = [
	{
		name: "sleep",
		description: "Waits",
		inputSchema: { type: "object", properties: { timeout: { type: "number" } }, required: ["timeout"] },
	},
];
r = await exec("await tools.sleep({ timeout_secs: 5 })", { sleep: "slept" }, SCHEMA_TOOLS);
check(
	"bridge: wrong parameter key warns and names the real key",
	r.ok &&
		r.value === "slept" &&
		r.output.some((i) => i.text.includes("timeout_secs") && i.text.includes('did you mean "timeout"')),
	JSON.stringify(r.output),
);
r = await exec("await tools.sleep({ bogus: 1 })", { sleep: "slept-2" }, SCHEMA_TOOLS);
check(
	"bridge: unknown parameter without a close match still warns",
	r.ok && r.value === "slept-2" && r.output.some((i) => i.text.includes('unknown parameter "bogus"') && i.text.includes("timeout")),
	JSON.stringify(r.output),
);
r = await exec("await tools.bash({ weird_key: 1 })", { bash: "ok" });
check(
	"bridge: no param warning when the tool has no inputSchema",
	r.ok && r.value === "ok" && !r.output.some((i) => i.text.startsWith("[codemode]")),
	JSON.stringify(r.output),
);

// 18. Disconnect self-exit: closing the channel ends the worker (no orphan);
// fallback kills the recorded pid only.
const childPid = proc.pid;
const exited = new Promise((resolve) => proc.once("exit", (code) => resolve({ code })));
proc.disconnect();
const exitOutcome = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
let selfExited = exitOutcome !== null;
if (!selfExited) {
	try {
		process.kill(childPid, "SIGKILL");
	} catch {}
}
check("worker: channel disconnect self-exits", selfExited, exitOutcome ? `exit code ${exitOutcome.code}` : "no exit within 3 s; killed recorded pid");

console.log(`\n${results.filter((x) => x.pass).length}/${results.length} passed`);
process.exit(results.every((x) => x.pass) ? 0 : 1);
