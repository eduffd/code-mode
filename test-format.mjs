// test-format.mjs — unit checks for format.ts.
import { formatResult, formatResultContent, truncateOutput } from "./format.ts";
import { readFileSync } from "node:fs";

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

// Image output items ride through as labeled image blocks after the text section.
let c = formatResultContent({ ok: true, value: "made", output: [item("done")] });
check(
	"content without images: one text block, text only",
	c.length === 1 && c[0].type === "text" && c[0].text === "done\n=> made",
	JSON.stringify(c),
);

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
c = formatResultContent({ ok: true, value: "made", output: [{ type: "image", data: png, mimeType: "image/png" }] });
const pngBytes = Buffer.from(png, "base64").length;
check(
	"image item: label names index, total, mime, decoded byte size",
	c.length === 3 && c[1].type === "text" && c[1].text === `[Image 1/1 (image/png, ${pngBytes} bytes)]`,
	JSON.stringify(c[1]),
);
check(
	"image item: block carries the data and mimeType unchanged",
	c[2].type === "image" && c[2].data === png && c[2].mimeType === "image/png",
	JSON.stringify(c[2]),
);

c = formatResultContent({
	ok: true,
	value: "ok",
	output: [{ type: "image", data: png, mimeType: "image/png" }, item("between"), { type: "image", data: png, mimeType: "image/png" }],
});
check(
	"two image items: numbered in order, images after the text section",
	c.length === 5 && c[1].text === `[Image 1/2 (image/png, ${pngBytes} bytes)]` && c[3].text === `[Image 2/2 (image/png, ${pngBytes} bytes)]`,
	JSON.stringify(c.map((b) => b.type === "text" ? b.text : b.type)),
);

const oversizedWithImage = [item("x".repeat(30_000)), { type: "image", data: png, mimeType: "image/png" }];
c = formatResultContent({ ok: true, output: oversizedWithImage });
check(
	"truncated text with an image: text budget applies, image still rides",
	c[0].text.includes("head-and-tail omitted") && c.some((b) => b.type === "image"),
	`blocks=${c.length} imageAt=${c.findIndex((b) => b.type === "image")}`,
);

// Boot failure in only mode: the result tells the model direct tools remain callable.
const bootFailed = { ok: false, error: { name: "SandboxError", message: "code_mode worker exited during boot" }, output: [], stateLost: true, bootFailed: true };
r = formatResult(bootFailed, "only");
check(
	"bootFailed + only: guidance line after the stateLost note",
	r.endsWith("(REPL state was lost)\nThe worker never booted; direct session tools remain callable by name (the code_mode tool description lists them)."),
	JSON.stringify(r),
);
r = formatResult(bootFailed, "on");
check("bootFailed + on: no guidance line", !r.includes("callable by name"), JSON.stringify(r));
r = formatResult(bootFailed);
check("bootFailed + no mode: no guidance line", !r.includes("callable by name"), JSON.stringify(r));
r = formatResult({ ok: false, error: { name: "TimeoutError", message: "late" }, output: [], stateLost: true }, "only");
check("non-bootFailed failure + only: no guidance line", !r.includes("callable by name"), JSON.stringify(r));

// Restore reporting: what came back, and what the model must re-declare.
r = formatResult({ ok: true, output: [], stateRestored: { restored: ["alpha", "beta"], skipped: ["fn1"], oversized: [] } });
check(
	"stateRestored: restored bindings and non-restorable names in one line",
	r === "(REPL state restored: restored 2 bindings: alpha, beta; not restorable: fn1 (re-declare them))",
	JSON.stringify(r),
);
r = formatResult({ ok: true, output: [], stateRestored: { restored: [], skipped: ["fn1"], oversized: ["big"] } });
check(
	"stateRestored with nothing restored: honest not-restored line",
	r === "(REPL state was not restored: not restorable: fn1, big (re-declare them))",
	JSON.stringify(r),
);
r = formatResult({ ok: true, output: [], stateRestored: { restored: [], skipped: [], oversized: [] } });
check("empty restore report: no line", !r.includes("REPL state"), JSON.stringify(r));

const sources = ["format.ts", "index.ts", "gating.ts", "compile.ts", "protocol.ts", "lifecycle.ts", "worker-host.ts"]
	.map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));
const markerSites = sources.filter((s) => s.includes("head-and-tail omitted")).length;
check("truncation marker built in exactly one source file", markerSites === 1, `${markerSites} files`);

console.log(`\n${results.filter((x) => x.pass).length}/${results.length} passed`);
process.exit(results.every((x) => x.pass) ? 0 : 1);
