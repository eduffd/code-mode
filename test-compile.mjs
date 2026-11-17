// test-compile.mjs — drift tests for the ONE compile path (compile.ts).
// Run from the repo root: node test-compile.mjs
//
// These run the real compileScript against a real vm context in-process —
// no worker fork — so a compile-semantics fix is proven here first and the
// worker only re-proves the protocol layer. The run() helper below mirrors
// repl-worker.js's exec loop exactly (compile -> vm.runInContext -> await ->
// record landed captures), so drift between this suite and the worker means
// the worker loop changed shape.

import vm from "node:vm";
import { compileScript } from "./compile.ts";

const results = [];
const check = (name, cond, detail = "") => {
	results.push({ name, pass: !!cond });
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? ` — ${detail}` : ""}`);
};

// One fresh REPL, mirroring the worker's per-worker state.
const sandbox = Object.create(null);
const ctx = vm.createContext(sandbox);
const persisted = new Set();

async function run(code) {
	const compiled = compileScript(code, { persistedNames: persisted });
	const value = await vm.runInContext(compiled.source, ctx, { filename: "drift.js", breakOnSigint: true });
	for (const n of compiled.capturedNames) if (n in sandbox) persisted.add(n);
	return { value, compiled };
}

// ---- bare return and completion value

let r = await run("return 5;");
check("drift: bare top-level return returns", r.value === 5, JSON.stringify(r.value));

r = await run("1 + 1");
check("drift: last expression is the completion value", r.value === 2, JSON.stringify(r.value));

r = await run("const q = await Promise.resolve(1); return q + 1;");
check("drift: return after top-level await", r.value === 2, JSON.stringify(r.value));

r = await run("const keep = 'pre';\nreturn keep;");
check("drift: capture still emitted before return", r.value === "pre", JSON.stringify(r.value));
r = await run("keep");
check("drift: captured var persists after return", r.value === "pre", JSON.stringify(r.value));

// ---- TLA forms

r = await run("let sum = 0; for await (const n of [1,2,3]) { sum += n; } sum");
check("drift: for-await at top level", r.value === 6, JSON.stringify(r.value));

r = await run("async function helper(v) { return v * 2; }\nconst doubled = await helper(21); doubled");
check("drift: function decl + same-script call", r.value === 42, JSON.stringify(r.value));
r = await run("await helper(5)");
check("drift: function persists across execs", r.value === 10, JSON.stringify(r.value));

// ---- declaration capture

r = await run("var v = 1; function f() { return 9; } class C {}");
check(
	"drift: var/function/class captured",
	r.value === undefined &&
		r.compiled.capturedNames.join(",") === "v,f,C" &&
		sandbox.v === 1 &&
		sandbox.f() === 9 &&
		typeof sandbox.C === "function",
	JSON.stringify({ names: r.compiled.capturedNames, v: sandbox.v }),
);

r = await run("const { x, y } = await Promise.resolve({ x: 4, y: 9 }); x + y");
check("drift: destructured const captured", r.value === 13, JSON.stringify(r.value));
r = await run("x * y");
check("drift: destructured bindings persist", r.value === 36, JSON.stringify(r.value));

r = await run("const { 'a-b': ab } = { 'a-b': 5 }; ab");
check("drift: destructuring rename binds the identifier", sandbox.ab === 5, JSON.stringify(sandbox.ab));

// ---- declaration journal (snapshot/restore material)

r = await run("let journaled = 7; const { j2 } = { j2: 8 };");
const journal = r.compiled.declarations;
check(
	"drift: journal names match captured names",
	journal.map((d) => d.name).join(",") === r.compiled.capturedNames.join(","),
	JSON.stringify(journal),
);
check(
	"drift: journal kinds and sources are per-declaration",
	journal.length === 2 &&
		journal[0].kind === "let" &&
		journal[0].source === "let journaled = 7;" &&
		journal[1].kind === "const",
	JSON.stringify(journal),
);
check(
	"drift: every journaled name is a context key after the run",
	journal.every((d) => d.name in sandbox),
	JSON.stringify(Object.keys(sandbox)),
);

// ---- redeclare semantics: one rule for every kind

await run("let counter = 10;");
check("drift: setup persisted counter", sandbox.counter === 10, JSON.stringify(sandbox.counter));

const redeclare = (code) => {
	try {
		compileScript(code, { persistedNames: persisted });
		return null;
	} catch (e) {
		return e;
	}
};

let e = redeclare("let counter = 99;");
check("drift: redeclaring a persisted let throws", e instanceof SyntaxError, JSON.stringify(e?.message));
check(
	"drift: taught reassign message",
	e !== null && /already been declared/.test(e.message) && /reassign without const/.test(e.message),
	e?.message,
);

e = redeclare("const counter = 1;");
check("drift: redeclaring a persisted const throws", e instanceof SyntaxError, JSON.stringify(e?.message));
e = redeclare("var counter = 1;");
check("drift: redeclaring a persisted var throws", e !== null, JSON.stringify(e?.message));
e = redeclare("function counter() {}");
check("drift: redeclaring a persisted function throws", e !== null, JSON.stringify(e?.message));
e = redeclare("class counter {}");
check("drift: redeclaring a persisted class throws", e !== null, JSON.stringify(e?.message));

// The throw happens at compile time: nothing runs, nothing is captured.
const sandboxKeysBefore = Object.keys(sandbox).length;
let compileThrew = false;
try {
	compileScript("counter = 999; var counter = 1;", { persistedNames: persisted });
} catch {
	compileThrew = true;
}
check(
	"drift: redeclare throws before any code runs",
	compileThrew && Object.keys(sandbox).length === sandboxKeysBefore,
	JSON.stringify(Object.keys(sandbox)),
);

// Fresh names still compile; assignment is the reassignment channel.
r = await run("const fresh = 'ok'; fresh");
check("drift: fresh name compiles while persisted set is non-empty", r.value === "ok", JSON.stringify(r.value));
r = await run("counter = 77; counter");
check("drift: plain assignment reassigns a persisted name", r.value === 77, JSON.stringify(r.value));
r = await run("counter");
check("drift: assignment persists across execs", r.value === 77, JSON.stringify(r.value));

// Same-script duplicate declarations stay acorn's honest error.
let dup = null;
try {
	compileScript("let x = 1; let x = 2;");
} catch (err) {
	dup = err;
}
check("drift: same-script duplicate declaration is a SyntaxError", dup instanceof SyntaxError, JSON.stringify(dup?.message));

// ---- syntax errors stay honest

let syntax = null;
try {
	compileScript("const = 5");
} catch (err) {
	syntax = err;
}
check("drift: invalid code throws SyntaxError", syntax instanceof SyntaxError, JSON.stringify(syntax?.message));

// ---- edges: one form per script shape

r = await run("");
check("drift: empty script runs, returns undefined", r.value === undefined && r.compiled.capturedNames.length === 0, JSON.stringify(r));

r = await run("foo: 1");
check("drift: labeled statement is not turned into a return", r.value === undefined, JSON.stringify(r.value));

r = await run("{ 1 }");
check("drift: block statement is not turned into a return", r.value === undefined, JSON.stringify(r.value));

r = await run("const obj = { m() { return 'method'; } }; obj.m()");
check("drift: object literal with method shorthand", r.value === "method", JSON.stringify(r.value));

console.log(`\n${results.filter((x) => x.pass).length}/${results.length} passed`);
process.exit(results.every((x) => x.pass) ? 0 : 1);
