#!/usr/bin/env node
// check-exec-lifecycle.mjs — bounded exhaustive interleaving check for the
// code_mode exec lifecycle: the pure step(state, event) core in lifecycle.ts,
// driven through the real index.ts adapter and a real forked worker process.
// The checker only touches the public surface (tool execute, /code-mode
// command, session events), so it exercises core + effect interpreter +
// adapter together.
//
// Properties (spec = a code_mode call always returns to the model):
//   P1 settle       — the first exec settles within DEADLINE_MS in every interleaving
//   P2 queue-alive  — a follow-up exec still settles afterwards (queue not wedged)
//   P3 honest outcome — settled outcomes match the interleaving:
//       end delivered while running  -> ok:true,  stateLost:false
//       no end, no worker stop       -> TimeoutError, stateLost:true
//       worker stop settled the exec -> ok:false, stateLost:true
//   P4 late-end hygiene — an end message for an already-settled exec is ignored
//   P5 late-tool-answer — a tool answer for a finished exec journals nothing on
//       the next exec and sends the worker nothing
//
// Exit 0 = all green. Exit 1 = any violation (new bug or modeling drift).
// See SKILL.md for how to read results.

import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const INDEX_TS = join(REPO, "index.ts");
const FAKE_WORKER = join(HERE, "fake-worker.mjs");

// ---- bound of the check
const ALPHABET = ["end", "crash", "off", "tick"];
const MAX_LEN = 3;
const EXEC_TIMEOUT_MS = 25; // timeout_ms passed to every exec
const TICK_MS = EXEC_TIMEOUT_MS * 2 + 10; // always past the exec timeout
const DEADLINE_MS = EXEC_TIMEOUT_MS * 12; // settle-or-wedged threshold for a probe
const EXEC_IN_FLIGHT_GRACE_MS = 400; // roundtrip proven fast before this elapses; the exec is in the worker

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pump = () => sleep(3);

// ---------------------------------------------------------------- fork wrapper + current scenario

const require_ = createRequire(import.meta.url);
const realFork = require_("node:child_process").fork;
const tmp = mkdtempSync(join(tmpdir(), "cm-exec-lifecycle-"));

let fakeArmed = false;
/** @type {{ proc: import("node:child_process").ChildProcess | null, spawned: import("node:child_process").ChildProcess[], execReceived: boolean, exec1Settled: boolean, endBeforeSettle: boolean, stopBeforeSettle: boolean, markerSeq: number } | null} */
let current = null;

const allSpawned = new Set();
require_("node:child_process").fork = (...args) => {
	const a = [...args];
	if (fakeArmed) a[0] = FAKE_WORKER;
	const p = realFork(...a);
	// A send to a dead child's channel raises an async 'error' event (EPIPE),
	// not a synchronous throw safeSend can catch; without this handler the
	// harness crashes instead of recording the violation (CI, run 45394606792).
	p.on("error", () => {});
	allSpawned.add(p);
	if (current) {
		current.proc = p;
		current.spawned.push(p);
		p.on("message", (m) => {
			if (m && m.type === "__cm_execReceived") current.execReceived = true;
		});
	}
	return p;
};

// Never leak workers, even when the run itself dies: leaked forks pile up and
// grind the machine down (each idle worker sits on an IPC channel). Also never
// clean up by process name on this machine — this repo's extension runs inside
// live pi sessions, and an unscoped pkill kills those too.
const cleanupAll = () => {
	for (const p of allSpawned) {
		try {
			p.kill();
		} catch {}
	}
};
process.on("exit", cleanupAll);
process.on("SIGINT", () => {
	cleanupAll();
	process.exit(130);
});
process.on("SIGTERM", () => {
	cleanupAll();
	process.exit(143);
});

function newScenarioState() {
	current = { proc: null, spawned: [], execReceived: false, exec1Settled: false, endBeforeSettle: false, stopBeforeSettle: false };
	return current;
}

function cleanupCurrent() {
	for (const p of current.spawned) {
		try {
			p.kill();
		} catch {}
	}
}

// ---------------------------------------------------------------- load real extension

const { createJiti } = await import("jiti"); // devDependency; runs in CI and locally
const stubPath = join(tmp, "typebox-stub.mjs");
writeFileSync(
	stubPath,
	"export const Type = { Object: () => ({}), String: () => ({}), Number: () => ({}), Boolean: () => ({}), Optional: (x) => x, Any: () => ({}) };\n",
);
const jiti = createJiti(import.meta.url, { alias: { typebox: stubPath }, moduleCache: false, fsCache: false });

async function loadFreshExtension() {
	// Fork wrapper identity never changes; only the armed flag does.
	const captured = { handlers: [] };
	const pi = {
		registerTool: (cfg) => (captured.tool = cfg),
		registerCommand: (_name, cfg) => (captured.cmd = cfg),
		getSettings: () => ({}),
		on: (event, fn) => captured.handlers.push({ event, fn }),
	};
	const mod = await jiti.import(INDEX_TS);
	mod.default(pi);
	if (!captured.tool || !captured.cmd) throw new Error("extension did not register tool/command");
	return captured;
}

function fakeCtx() {
	return {
		tools: [{ name: "bash", description: "Bash" }],
		executeTool: async () => ({ result: { content: [{ type: "text", text: "ok" }] }, isError: false }),
	};
}

// ---------------------------------------------------------------- scenario machinery

function withDeadline(p, ms) {
	return Promise.race([
		p.then(
			(v) => ({ settled: true, result: v }),
			(e) => ({ settled: true, result: { thrown: e } }),
		),
		sleep(ms).then(() => ({ settled: false, result: null })),
	]);
}

async function waitForExecSent(capMs = 2000) {
	const t0 = Date.now();
	while (!current.execReceived && Date.now() - t0 < capMs) await pump();
	return current.execReceived;
}

function outcomeShape(r) {
	if (r === null || r === undefined) return "WEDGED";
	if (r.thrown) return "THREW:" + (r.thrown?.name ?? "Error");
	const d = r.details ?? {};
	const m = typeof r.content?.[0]?.text === "string" ? r.content[0].text.match(/Error: (\w+)/) : null;
	return `${d.ok ? "ok" : "err"}${m ? ":" + m[1] : ""} stateLost=${d.stateLost}`;
}

function safeSend(cur, msg) {
	// A closed channel means the worker is already gone: the event simply cannot
	// be delivered (same as a message arriving after a real crash).
	if (!cur.proc || !cur.proc.connected) return false;
	try {
		cur.proc.send(msg);
		return true;
	} catch {
		return false;
	}
}

async function applyAction(cur, ext, action) {
	switch (action) {
		case "end":
			if (!cur.exec1Settled) cur.endBeforeSettle = true;
			safeSend(cur, { type: "__cm_deliverEnd" });
			await pump();
			break;
		case "crash":
			if (!cur.exec1Settled) cur.stopBeforeSettle = true;
			safeSend(cur, { type: "__cm_crash" }); // real exit event, like a killed worker
			await pump();
			break;
		case "off":
			if (!cur.exec1Settled) cur.stopBeforeSettle = true;
			await ext.cmd.handler("off", { ui: { notify() {} } });
			await pump();
			break;
		case "tick":
			await sleep(TICK_MS);
			break;
	}
}

function* sequences() {
	yield [];
	let prev = [[]];
	for (let len = 1; len <= MAX_LEN; len++) {
		const next = [];
		for (const seq of prev) for (const a of ALPHABET) next.push([...seq, a]);
		yield* next;
		prev = next;
	}
}

async function runScenario(actions) {
	fakeArmed = true;
	const ext = await loadFreshExtension();
	const cur = newScenarioState();
	try {
		const p1 = ext.tool.execute("t1", { code: "longRunning();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, fakeCtx());
		p1.then(() => (cur.exec1Settled = true), () => (cur.exec1Settled = true));

		if (!(await waitForExecSent())) return { actions, bootFailure: true, violations: [], r1: "BOOT-FAIL", r2: "-" };

		for (const a of actions) await applyAction(cur, ext, a);
		const r1 = await withDeadline(p1, DEADLINE_MS);
		const r1s = r1.settled ? r1.result : null;

		const p2 = ext.tool.execute("t2", { code: "next();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, fakeCtx());
		const r2 = await withDeadline(p2, DEADLINE_MS);

		const violations = [];
		if (!r1.settled) violations.push("P1 exec1 wedged");
		if (!r2.settled) violations.push("P2 queue wedged (follow-up call never returns)");
		if (r1s !== null && !r1s.thrown) {
			const d = r1s.details ?? {};
			const txt = typeof r1s.content?.[0]?.text === "string" ? r1s.content[0].text : "";
			const errName = (txt.match(/Error: (\w+)/) || [])[1];
			if (cur.endBeforeSettle && !(d.ok === true && d.stateLost === false))
				violations.push("P3 end-delivered run should be ok:true stateLost:false");
			if (!cur.endBeforeSettle && !cur.stopBeforeSettle) {
				if (!(d.ok === false && d.stateLost === true && errName === "TimeoutError"))
					violations.push("P3 plain timeout should be ok:false TimeoutError stateLost:true");
			}
			if (cur.stopBeforeSettle && !(d.ok === false && d.stateLost === true))
				violations.push("P3 worker-stop outcome should be ok:false stateLost:true");
		}
		return { actions, r1: outcomeShape(r1s), r2: outcomeShape(r2.settled ? r2.result : null), violations };
	} finally {
		cleanupCurrent();
	}
}

// ---------------------------------------------------------------- probes

async function probeBootCrashRetry() {
	fakeArmed = true;
	const ext = await loadFreshExtension();
	const cur = newScenarioState();
	process.env.CM_FAKE_BOOT_CRASH = "1";
	try {
		const p = ext.tool.execute("t1", { code: "x();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, fakeCtx());
		const r = await withDeadline(p, 2000);
		return { name: "boot-crash-retry", pass: r.settled, detail: outcomeShape(r.settled ? r.result : null) };
	} finally {
		delete process.env.CM_FAKE_BOOT_CRASH;
		cleanupCurrent();
	}
}

async function probeOffWhenIdle() {
	fakeArmed = true;
	const ext = await loadFreshExtension();
	newScenarioState();
	await ext.cmd.handler("off", { ui: { notify() {} } });
	const p = ext.tool.execute("t1", { code: "x();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, fakeCtx());
	const r = await withDeadline(p, DEADLINE_MS);
	cleanupCurrent();
	return { name: "off-when-idle", pass: r.settled, detail: outcomeShape(r.settled ? r.result : null) };
}

async function probeLateEndAfterTimeout() {
	fakeArmed = true;
	const ext = await loadFreshExtension();
	const cur = newScenarioState();
	const p1 = ext.tool.execute("t1", { code: "x();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, fakeCtx());
	await withDeadline(p1, DEADLINE_MS);
	cur.exec1Settled = true;
	cur.proc.send({ type: "__cm_deliverEnd" });
	await pump();
	const p2 = ext.tool.execute("t2", { code: "y();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, fakeCtx());
	const r2 = await withDeadline(p2, DEADLINE_MS);
	cleanupCurrent();
	return { name: "late-end-after-timeout", pass: r2.settled, detail: outcomeShape(r2.settled ? r2.result : null) };
}

async function probeSessionSwitchMidExec() {
	fakeArmed = true;
	const ext = await loadFreshExtension();
	const cur = newScenarioState();
	const p1 = ext.tool.execute("t1", { code: "x();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, fakeCtx());
	await waitForExecSent();
	const sw = ext.handlers.find((h) => h.event === "session_before_switch");
	if (!sw) {
		cleanupCurrent();
		return { name: "session-switch-mid-exec", pass: false, detail: "handler not registered" };
	}
	sw.fn();
	await pump();
	const r1 = await withDeadline(p1, DEADLINE_MS);
	const p2 = ext.tool.execute("t2", { code: "y();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, fakeCtx());
	const r2 = await withDeadline(p2, DEADLINE_MS);
	cleanupCurrent();
	return {
		name: "session-switch-mid-exec",
		pass: r1.settled && r2.settled,
		detail: `exec1=${outcomeShape(r1.settled ? r1.result : null)} exec2=${outcomeShape(r2.settled ? r2.result : null)}`,
	};
}

async function probeRealWorkerSigkill() {
	const { execSync } = await import("node:child_process");
	fakeArmed = false; // the extension forks the REAL repl-worker.js
	const ext = await loadFreshExtension();
	const cur = newScenarioState();
	const ctx = fakeCtx();
	const pFast = ext.tool.execute("r1", { code: "1+1", timeout_ms: 30_000 }, undefined, undefined, ctx);
	const rFast = await withDeadline(pFast, 10_000);
	if (!rFast.settled || !rFast.result?.details?.ok) {
		cleanupCurrent();
		return { name: "real-worker-sigkill", pass: false, detail: "worker did not boot/roundtrip: " + outcomeShape(rFast.settled ? rFast.result : null) };
	}
	const pHang = ext.tool.execute("r2", { code: "await new Promise(() => {})", timeout_ms: 30_000 }, undefined, undefined, ctx);
	await sleep(EXEC_IN_FLIGHT_GRACE_MS);
	let pid = null;
	try {
		pid = execSync(`pgrep -P ${process.pid} -f repl-worker.js`).toString().trim().split("\n")[0];
	} catch {}
	if (!pid) {
		cleanupCurrent();
		return { name: "real-worker-sigkill", pass: false, detail: "could not find worker child pid" };
	}
	try {
		process.kill(Number(pid), "SIGKILL");
	} catch {}
	await pump();
	const rHang = await withDeadline(pHang, DEADLINE_MS);
	const pNext = ext.tool.execute("r3", { code: "2+2", timeout_ms: 30_000 }, undefined, undefined, ctx);
	const rNext = await withDeadline(pNext, 10_000);
	cleanupCurrent();
	const wedged = !rHang.settled;
	const nextOk = rNext.settled && rNext.result?.details?.ok === true;
	return {
		name: "real-worker-sigkill",
		pass: !wedged && nextOk,
		detail: wedged
			? nextOk
				? "WEDGE on real worker: killed exec never settles AND follow-up call settles"
				: "WEDGE on real worker: killed exec AND follow-up call both never settle"
			: nextOk
				? "no wedge: killed exec settled with " + outcomeShape(rHang.result) + ", follow-up call ok"
				: "killed exec settled with " + outcomeShape(rHang.result) + " but follow-up call failed",
		wedged,
	};
}

// P5 — late-tool-answer: a tool answer that lands after its exec ended must
// neither pollute the next exec's journal nor reach the worker. Replays the
// live bug found 2026-11-24: toolAnswered was keyed on the handle alone, so
// exec 2's timeout journal claimed a tool call exec 2 never made.
async function probeLateToolAnswer() {
	fakeArmed = true;
	const ext = await loadFreshExtension();
	const cur = newScenarioState();
	let releaseAnswer;
	const deferredCtx = {
		tools: [{ name: "bash", description: "Bash" }],
		executeTool: () =>
			new Promise((res) => {
				releaseAnswer = () => res({ result: { content: [{ type: "text", text: "late" }] }, isError: false });
			}),
	};
	const p1 = ext.tool.execute("t1", { code: "tools.bash({});", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, deferredCtx);
	await waitForExecSent();
	safeSend(cur, { type: "__cm_toolCallThenEnd" });
	await pump();
	const r1 = await withDeadline(p1, DEADLINE_MS);
	if (!r1.settled || !r1.result?.details?.ok) {
		cleanupCurrent();
		return { name: "late-tool-answer", pass: false, detail: "exec1 did not settle ok: " + outcomeShape(r1.settled ? r1.result : null) };
	}
	const p2 = ext.tool.execute("t2", { code: "next();", timeout_ms: EXEC_TIMEOUT_MS }, undefined, undefined, deferredCtx);
	await waitForExecSent();
	releaseAnswer();
	await pump();
	const r2 = await withDeadline(p2, DEADLINE_MS);
	cleanupCurrent();
	const txt = typeof r2.result?.content?.[0]?.text === "string" ? r2.result.content[0].text : "";
	const polluted = /completed before interruption/.test(txt);
	return {
		name: "late-tool-answer",
		pass: r2.settled && !polluted,
		detail: polluted
			? "exec2 journal claims a call exec2 never made: " + txt
			: "exec2 settled, journal clean: " + outcomeShape(r2.settled ? r2.result : null),
	};
}

// ---------------------------------------------------------------- main

const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const fmtSeq = (seq) => "[" + seq.join(",") + "]";

const results = [];
for (const seq of sequences()) results.push(await runScenario(seq));

const unexpected = [];
let violationCount = 0;
for (const r of results) {
	if (r.bootFailure) {
		unexpected.push(`${fmtSeq(r.actions)}: boot never sent exec`);
		continue;
	}
	if (r.violations.length === 0) continue;
	violationCount += r.violations.length;
	unexpected.push(`${fmtSeq(r.actions)}: ${r.violations.join("; ")}`);
}

console.log("== bounded exhaustive interleaving check: code_mode exec lifecycle (index.ts) ==");
console.log(`alphabet=${JSON.stringify(ALPHABET)} maxLen=${MAX_LEN} scenarios=${results.length}`);
console.log("");
let shown = 0;
for (const r of results) {
	const status = r.violations.length === 0 ? "PASS" : "FAIL";
	if (status === "FAIL" || shown <= 120) {
		if (status === "PASS") {
			console.log(`  ${pad(fmtSeq(r.actions), 18)} ${status}  exec1=${pad(r.r1, 26)} exec2=${r.r2}`);
		} else {
			console.log(`  ${pad(fmtSeq(r.actions), 18)} ${status} [UNEXPECTED] exec1=${pad(r.r1, 26)} exec2=${r.r2}  ${r.violations.join("; ")}`);
		}
	}
	shown++;
}
if (shown > 121) console.log(`  ... (${results.length - shown} more passing scenarios)`);

console.log("");
console.log("== probes ==");
const probes = [await probeBootCrashRetry(), await probeOffWhenIdle(), await probeLateEndAfterTimeout(), await probeSessionSwitchMidExec(), await probeLateToolAnswer()];
if (process.argv.includes("--real")) probes.push(await probeRealWorkerSigkill());
for (const pr of probes) {
	console.log(`  ${pad(pr.name, 26)} ${pr.pass ? "PASS" : "FAIL"}  ${pr.detail}`);
	if (!pr.pass) unexpected.push(`probe ${pr.name} failed: ${pr.detail}`);
}

console.log("");
console.log("== summary ==");
console.log(`scenarios: ${results.length}, violations: ${violationCount}, unexpected: ${unexpected.length}`);
for (const u of unexpected) console.log(`  UNEXPECTED: ${u}`);
process.exit(unexpected.length > 0 ? 1 : 0);
