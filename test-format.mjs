// Unit checks for format.ts: stateLost note exactly once, an honest
// truncation marker whose byte count matches reality, and the empty-result
// fallback. Runs on plain Node type stripping — no worker, no fork.
import { formatResult, truncateOutput } from "./format.ts";

const results = [];
function check(name, cond, detail = "") {
	results.push({ name, pass: !!cond, detail: String(detail).slice(0, 300) });
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
	if (!cond) process.exitCode = 1;
}

const item = (text, captured) => (captured ? { type: "text", text, console: true } : { type: "text", text });

let r = formatResult({ ok: true, output: [] });
check("empty result falls back to the no-output note", r === "(no output; script returned undefined)", r);

r = formatResult({ ok: true, value: "42", output: [item("hello")] });
check("ok with output and value: both sections in order", r === "hello\n=> 42", JSON.stringify(r));

r = formatResult({ ok: false, error: { name: "TypeError", message: "boom", stack: "TypeError: boom\n  at x" }, output: [] });
check(
	"error outcome: Error line then stack, no stateLost note",
	r === "Error: TypeError: boom\nTypeError: boom\n  at x",
	JSON.stringify(r),
);

r = formatResult({
	ok: false,
	error: { name: "WorkerError", message: "worker stopped" },
	output: [item("partial")],
	stateLost: true,
	journal: [{ name: "bash", ok: true }, { name: "read", ok: false }],
});
const note = "(REPL state was lost)";
check(
	"stateLost: note exactly once with journal present",
	r.split(note).length === 2 && r.includes("(completed before interruption: bash ok, read error)"),
	JSON.stringify(r),
);

r = formatResult({ ok: true, value: "1", output: [], stateLost: true });
check("stateLost: note exactly once on ok outcome", r === "=> 1\n(REPL state was lost)", JSON.stringify(r));

r = formatResult({ ok: true, value: "1", output: [] });
check("clean outcome: no stateLost note", !r.includes(note), JSON.stringify(r));

const small = [item("a".repeat(1000)), item("b".repeat(1000), true)];
r = truncateOutput(small);
check(
	"under budget: joined items, console items included, no marker",
	r === `${"a".repeat(1000)}\n${"b".repeat(1000)}` && !r.includes("..."),
	`len ${r.length}`,
);

const HEAD_CHARS = 14_000;
const TAIL_CHARS = 5_000;
const oversized = [item("x".repeat(30_000))];
r = truncateOutput(oversized);
const marker = r.match(/\n\.\.\. \[(.+)\] \.\.\.\n/);
const expectedOmitted = "x".repeat(30_000 - HEAD_CHARS - TAIL_CHARS);
check(
	"oversized: head-and-tail marker present",
	marker !== null && marker[1].startsWith("head-and-tail omitted ") && marker[1].endsWith(" bytes"),
	marker?.[1],
);
check(
	"oversized: marker byte count matches the truly omitted middle",
	marker !== null && Number(marker[1].replace(/\D/g, "")) === Buffer.byteLength(expectedOmitted),
	marker?.[1],
);
check(
	"oversized: kept head+tail bracket the marker",
	r.startsWith("x".repeat(HEAD_CHARS)) && r.endsWith("x".repeat(TAIL_CHARS)),
	`head ok=${r.startsWith("x".repeat(HEAD_CHARS))} tail ok=${r.endsWith("x".repeat(TAIL_CHARS))}`,
);

const multi = [item("m".repeat(20_000)), item("n".repeat(20_000))];
r = truncateOutput(multi);
const full = "m".repeat(20_000) + "\n" + "n".repeat(20_000);
const m2 = r.match(/\n\.\.\. \[head-and-tail omitted (\d+) bytes\] \.\.\.\n/);
const expectedMiddle = full.slice(HEAD_CHARS, full.length - TAIL_CHARS);
check(
	"oversized multi-item: byte count equals the omitted middle slice",
	m2 !== null && Number(m2[1]) === Buffer.byteLength(expectedMiddle),
	`marker=${m2?.[1]} expected=${Buffer.byteLength(expectedMiddle)}`,
);
check(
	"oversized multi-item: head+tail reconstruct the kept text exactly",
	m2 !== null && r === full.slice(0, HEAD_CHARS) + `\n... [head-and-tail omitted ${m2[1]} bytes] ...\n` + full.slice(full.length - TAIL_CHARS),
	"reconstruction",
);

r = truncateOutput([item("z".repeat(20_000))]);
check("at-budget output is not truncated", !r.includes("..."), `len ${r.length}`);

import { readFileSync } from "node:fs";
const sources = ["format.ts", "index.ts", "gating.ts", "compile.ts", "protocol.ts", "lifecycle.ts", "worker-host.ts"]
	.map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));
const markerSites = sources.filter((s) => s.includes("head-and-tail omitted")).length;
check("truncation marker built in exactly one source file", markerSites === 1, `${markerSites} files`);

console.log(`\n${results.filter((x) => x.pass).length}/${results.length} passed`);
process.exit(results.every((x) => x.pass) ? 0 : 1);
