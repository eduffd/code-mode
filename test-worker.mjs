// Standalone test harness: forks repl-worker.js and exercises the protocol.
import { fork } from "node:child_process";
import path from "node:path";
import { isWorkerOutMessage } from "./protocol.ts";
import { permissionArgv } from "./worker-host.ts";

const workerPath = path.resolve("repl-worker.js");
// The host forks with serialization:"advanced" (snapshot payloads ride as Buffers);
// this harness mirrors that so it sees the same messages the host sees.
const proc = fork(workerPath, [], { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit", "ipc"], serialization: "advanced" });

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

// 5. Single-path redeclare semantics
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

// 13. for-await at top level
r = await exec("let sum = 0; for await (const n of [1,2,3]) { sum += n; } sum");
check("single-path: for-await runs on the one path", r.ok && r.value === "6", JSON.stringify(r));

// 14. top-level function declaration with TLA + persistence
r = await exec("async function helper(v) { return v * 2; }\nconst doubled = await helper(21); doubled");
check("tla: function decl + call in same script", r.ok && r.value === "42", JSON.stringify(r));
r = await exec("await helper(5)");
check("tla: function persists", r.ok && r.value === "10", JSON.stringify(r.value));


// 15. top-level return works on the one path
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

// 18. Live capture regression.
r = await exec("var acc = 1; function tick() { acc += 1; return acc; } tick()");
check("live-capture: var+function mutation returns the updated value", r.ok && r.value === "2", JSON.stringify(r.value));
r = await exec("acc");
check("live-capture: mutated binding is what a later exec reads", r.ok && r.value === "2", JSON.stringify(r.value));
r = await exec("tick(); tick(); acc");
check("live-capture: closure keeps mutating the original binding across execs", r.ok && r.value === "4", JSON.stringify(r.value));
r = await exec("acc = 40; acc");
check("live-capture: cross-exec reassignment persists (setter channel)", r.ok && r.value === "40", JSON.stringify(r.value));
r = await exec("acc");
check("live-capture: reassigned value survives to the next exec", r.ok && r.value === "40", JSON.stringify(r.value));
r = await exec("globalThis.acc = 41; acc");
check("live-capture: globalThis write is visible via the bare name", r.ok && r.value === "41", JSON.stringify(r.value));
r = await exec("let acc = 1;");
check(
	"live-capture: redeclaring a live-captured name still throws the taught message",
	!r.ok && /already been declared/.test(r.error?.message ?? "") && /reassign without const/.test(r.error?.message ?? ""),
	r.error?.message,
);

// 18a. Tool-name collision: when a raw name and an identifier map to the same
// bridge slot, the raw name wins (resolveToolName checks toolByRaw first).
{
	const r1 = await exec("await tools.web_search({})", { web_search: "raw" }, [
		{ name: "web.search", description: "Dotted alias" },
		{ name: "web_search", description: "Raw" },
	]);
	check("collision: raw name wins over the identifier mapping", r1.ok === true && r1.value === "raw", JSON.stringify(r1).slice(0, 160));
}

// 18b. Late tool answer: exec 1 fires a tool call and ends without awaiting it
// (fire-and-forget). The late answer must not pollute exec 2 or break its own
// tool calls (P5; replays the journal-pollution bug at the protocol layer).
{
	const r1 = await exec("tools.bash({}); 1 + 1", { bash: "late" }, [{ name: "bash", description: "Bash" }]);
	check("exec1 with a fire-and-forget tool call settles ok", r1.ok === true && r1.value === "2", JSON.stringify(r1).slice(0, 200));
	const r2 = await exec("await tools.read({})", { read: "second" }, [{ name: "read", description: "Read" }]);
	check("exec2 after the fire-and-forget call gets its own tool answer", r2.ok === true && r2.value === "second", JSON.stringify(r2).slice(0, 200));
}

// REPL snapshot/restore: state captured from one worker restores into a fresh one.
{
	const withState = await exec("const snapA = 41; const snapB = [1, 2]; function snapFn() { return 1; }");
	const state = withState.state;
	check(
		"end message carries a snapshot payload",
		withState.ok && state instanceof Uint8Array && state.length > 0,
		`bytes=${state?.length}`,
	);
	const fresh = fork(workerPath, [], { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit", "ipc"], serialization: "advanced" });
	await new Promise((resolve) => fresh.once("message", (m) => (m.type === "ready" ? resolve(true) : undefined)));
	const freshEnd = (id) =>
		new Promise((resolve) => {
			const h = (m) => {
				if (m.type === "end" && m.id === id) {
					fresh.off("message", h);
					resolve(m);
				}
			};
			fresh.on("message", h);
		});
	fresh.send({ type: "exec", id: 1, code: "1", tools: [], restore: state });
	const rmsg = await freshEnd(1);
	check(
		"restore exec reports restored bindings and the skipped function by name",
		rmsg.stateRestored?.restored?.includes("snapA") && rmsg.stateRestored?.restored?.includes("snapB") && rmsg.stateRestored?.skipped?.includes("snapFn"),
		JSON.stringify(rmsg.stateRestored),
	);
	fresh.send({ type: "exec", id: 2, code: "snapA + 1", tools: [] });
	const r2 = await freshEnd(2);
	check("restored values are live in the fresh worker", r2.ok && r2.value === "42", JSON.stringify(r2.value));
	fresh.kill();
}

// REPL state names: the end message reports the worker's persisted top-level names.
{
	const first = await exec("const zeta = 26;");
	check(
		"end message carries sorted replNames including the new declaration",
		first.ok && Array.isArray(first.replNames) && first.replNames.includes("zeta") && JSON.stringify(first.replNames) === JSON.stringify([...first.replNames].sort()),
		JSON.stringify(first.replNames),
	);
	const second = await exec("const ypsilon = 25;");
	check(
		"replNames grows with the next declaration and keeps sorting",
		second.ok && second.replNames.includes("ypsilon") && second.replNames.length === first.replNames.length + 1,
		JSON.stringify(second.replNames),
	);
}

// 18c. Permission-flags boot: the hardened spawn worker-host uses must still
// reach ready — the worker needs no fs access beyond this repo.
{
	const repoRoot = path.resolve(".");
	const permProc = fork(workerPath, [], {
		cwd: repoRoot,
		execArgv: permissionArgv(path.dirname(workerPath)),
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	const booted = await new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), 5000);
		permProc.once("message", (m) => {
			if (m && m.type === "ready") {
				clearTimeout(t);
				resolve(true);
			}
		});
	});
	permProc.kill();
	check("worker boots under permission flags (no fs access beyond this repo)", booted, booted ? "" : "no ready handshake within 5s");
}

// 19. Disconnect self-exit: closing the channel ends the worker (no orphan);
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
