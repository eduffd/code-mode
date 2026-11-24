// test-lifecycle-core.mjs — step-table tests for the pure lifecycle core.
// Run from the repo root: node test-lifecycle-core.mjs
//
// Covers every state x event pair of lifecycle.ts:
//   - totality: step returns { state, effects, settled } for every pair;
//   - no-exec-vanishes: an open exec either stays open in the next state or
//     appears in settled — exactly once, never both, never neither (the
//     resolve-only settlement invariant that makes the wedge unwritable);
//   - timer pairing: settling the active exec always emits clearTimer for it,
//     activation always emits setTimer + send;
//   - honest outcomes per transition (end / timeout / worker-stopped / boot
//     failure), journal attachment, FIFO drain order, stale-handle drops;
//   - no reject channel exists in the core's or adapter's code.

import { readFileSync } from "node:fs";
import { step } from "./lifecycle.ts";

const results = [];
const check = (name, cond, detail = "") => {
	results.push({ name, pass: !!cond });
	if (!cond) console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};

let seqCounter = 0;
const mkHandle = () => ({ seq: ++seqCounter });
const mkExec = (id, timeoutMs = 1000) => ({ id, code: `script(${id});`, tools: [{ name: "bash", description: "Bash" }], timeoutMs });

const h1 = mkHandle();
const h2 = mkHandle(); // never current in any fixture: the stale handle

const idle = () => ({ kind: "idle" });
const booting1 = () => ({ kind: "booting", attempt: 1, handle: h1, queued: [mkExec(1)] });
const booting2 = () => ({ kind: "booting", attempt: 2, handle: h1, queued: [mkExec(1)] });
const ready = () => ({ kind: "ready", handle: h1 });
const running = () => ({ kind: "running", handle: h1, active: { exec: mkExec(1), journal: [] }, queued: [] });
const runningQueue = () => ({ kind: "running", handle: h1, active: { exec: mkExec(1), journal: [] }, queued: [mkExec(2), mkExec(3)] });
const runningJournaled = () => ({ kind: "running", handle: h1, active: { exec: mkExec(1), journal: [{ name: "read", ok: true }] }, queued: [] });

const STATES = {
	idle,
	booting1,
	booting2,
	ready,
	running,
	runningQueue,
	runningJournaled,
};

const EVENTS = {
	execRequested: { type: "execRequested", exec: mkExec(9) },
	booted: { type: "booted", handle: h1 },
	bootedStale: { type: "booted", handle: h2 },
	bootFailed: { type: "bootFailed", handle: h1, message: "code_mode worker did not start: boom" },
	bootFailedStale: { type: "bootFailed", handle: h2, message: "stale" },
	endActive: { type: "workerMessage", handle: h1, message: { type: "end", id: 1, ok: true, value: "7", output: [{ type: "text", text: "ran" }] } },
	endUnknown: { type: "workerMessage", handle: h1, message: { type: "end", id: 99, ok: true, value: "7", output: [] } },
	endStale: { type: "workerMessage", handle: h2, message: { type: "end", id: 1, ok: true, value: "7", output: [] } },
	readyMessage: { type: "workerMessage", handle: h1, message: { type: "ready" } },
	toolCall: { type: "workerMessage", handle: h1, message: { type: "toolCall", execId: 1, callId: 5, name: "bash", args: { cmd: "x" } } },
	toolCallStale: { type: "workerMessage", handle: h2, message: { type: "toolCall", execId: 1, callId: 5, name: "bash", args: {} } },
	workerDied: { type: "workerDied", handle: h1 },
	workerDiedStale: { type: "workerDied", handle: h2 },
	stopRequested: { type: "stopRequested" },
	timeoutFired: { type: "timeoutFired", id: 1 },
	timeoutFiredUnknown: { type: "timeoutFired", id: 99 },
	toolAnswered: { type: "toolAnswered", handle: h1, execId: 1, callId: 5, name: "bash", ok: true, value: "ok" },
	toolAnsweredError: { type: "toolAnswered", handle: h1, execId: 1, callId: 6, name: "read", ok: false, error: "nope" },
	toolAnsweredStale: { type: "toolAnswered", handle: h2, execId: 1, callId: 5, name: "bash", ok: true, value: "ok" },
	toolAnsweredOldExec: { type: "toolAnswered", handle: h1, execId: 99, callId: 5, name: "bash", ok: true, value: "ok" },
};

// ---------------------------------------------------------------- invariant sweep: every state x event pair

const openIds = (state) => {
	switch (state.kind) {
		case "booting":
			return state.queued.map((e) => e.id);
		case "running":
			return [state.active.exec.id, ...state.queued.map((e) => e.id)];
		default:
			return [];
	}
};

let pairs = 0;
let sweepFailures = 0;
for (const [stateName, mkState] of Object.entries(STATES)) {
	for (const [eventName, event] of Object.entries(EVENTS)) {
		pairs += 1;
		const state = mkState();
		let result;
		try {
			result = step(state, event);
		} catch (err) {
			sweepFailures += 1;
			check(`total: ${stateName} x ${eventName}`, false, `step threw: ${err}`);
			continue;
		}
		const shapeOk =
			result && typeof result === "object" &&
			result.state && typeof result.state.kind === "string" &&
			Array.isArray(result.effects) &&
			Array.isArray(result.settled);
		if (!shapeOk) {
			sweepFailures += 1;
			check(`shape: ${stateName} x ${eventName}`, false, JSON.stringify(result)?.slice(0, 120));
			continue;
		}
		const before = openIds(state);
		const after = new Set(openIds(result.state));
		const settledIds = result.settled.map((s) => s.id);
		for (const id of before) {
			const stays = after.has(id);
			const settles = settledIds.includes(id);
			if (stays === settles) {
				sweepFailures += 1;
				check(`no-exec-vanishes: ${stateName} x ${eventName}`, false, `exec ${id} stays=${stays} settles=${settles}`);
			}
		}
		for (const s of result.settled) {
			if (!before.includes(s.id)) {
				sweepFailures += 1;
				check(`no-invented-settlement: ${stateName} x ${eventName}`, false, `settled ${s.id} was not open`);
			}
			if (typeof s.outcome?.ok !== "boolean" || typeof s.outcome?.stateLost !== "boolean" || !Array.isArray(s.outcome.output)) {
				sweepFailures += 1;
				check(`outcome-shape: ${stateName} x ${eventName}`, false, JSON.stringify(s.outcome)?.slice(0, 120));
			}
		}
	}
}
check(`invariant sweep over ${pairs} state x event pairs: no exec vanishes, outcomes shaped, step total`, sweepFailures === 0, `${sweepFailures} failures`);

// ---------------------------------------------------------------- transition table: named arms

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const outcomeNames = (settled) => settled.map((s) => `${s.id}:${s.outcome.ok ? "ok" : s.outcome.error?.name ?? "err"}`);
const effectTypes = (result) => result.effects.map((e) => e.type);

{
	const r = step(idle(), EVENTS.execRequested);
	check("idle + execRequested -> booting attempt 1", r.state.kind === "booting" && r.state.attempt === 1, JSON.stringify(r.state));
	check("idle + execRequested spawns with permission flags", r.effects.length === 1 && r.effects[0].type === "spawn" && r.effects[0].flags === "permission", JSON.stringify(r.effects));
	check("idle + execRequested keeps the trigger exec queued (open, not settled)", openIds(r.state).includes(9) && r.settled.length === 0);
	check("idle + stopRequested stays idle (no worker to kill)", step(idle(), EVENTS.stopRequested).state.kind === "idle" && step(idle(), EVENTS.stopRequested).effects.length === 0);
	check("idle + workerDied stays idle", step(idle(), EVENTS.workerDied).state.kind === "idle");
	check("idle + booted stays idle", step(idle(), EVENTS.booted).state.kind === "idle");
	check("idle + bootFailed stays idle", step(idle(), EVENTS.bootFailed).state.kind === "idle");
}

{
	const r = step(booting1(), EVENTS.bootFailed);
	check("booting(1) + bootFailed -> retry booting attempt 2", r.state.kind === "booting" && r.state.attempt === 2, JSON.stringify(r.state));
	check("booting(1) + bootFailed spawns plain (no flags)", r.effects[0]?.type === "spawn" && r.effects[0]?.flags === "plain", JSON.stringify(r.effects));
	check("booting(1) + bootFailed mints a fresh handle", r.state.handle !== h1);
	check("booting(1) + bootFailed keeps queued execs open, settles nothing", openIds(r.state).includes(1) && r.settled.length === 0);

	const r2 = step(booting2(), EVENTS.bootFailed);
	check("booting(2) + bootFailed -> idle with every queued exec settled", r2.state.kind === "idle" && same(outcomeNames(r2.settled), ["1:SandboxError"]), JSON.stringify(r2.settled));
	check("booting(2) + bootFailed outcome is honest (ok:false stateLost:true, message preserved)", r2.settled[0]?.outcome.ok === false && r2.settled[0]?.outcome.stateLost === true && r2.settled[0]?.outcome.error?.message.includes("boom"), JSON.stringify(r2.settled[0]?.outcome));

	check("booting(1) + workerDied also retries (a died spawn is a failed boot)", step(booting1(), EVENTS.workerDied).state.attempt === 2);
	const r3 = step(booting2(), EVENTS.workerDied);
	check("booting(2) + workerDied settles as boot exit", r3.state.kind === "idle" && r3.settled[0]?.outcome.error?.name === "SandboxError" && r3.settled[0]?.outcome.error?.message.includes("exited during boot"));

	const r4 = step(booting1(), EVENTS.stopRequested);
	check("booting + stopRequested -> idle, kills the in-flight spawn, settles queued execs as worker-stopped", r4.state.kind === "idle" && effectTypes(r4).includes("kill") && same(outcomeNames(r4.settled), ["1:WorkerError"]), JSON.stringify(r4));

	const r5 = step(booting1(), EVENTS.booted);
	check("booting + booted -> running, activates first queued exec (send + setTimer)", r5.state.kind === "running" && r5.state.active.exec.id === 1 && same(effectTypes(r5), ["send", "setTimer"]), JSON.stringify(r5.effects));
	check("booting + execRequested grows the queue with no effects", (() => { const r = step(booting1(), EVENTS.execRequested); return r.state.queued.length === 2 && r.effects.length === 0 && r.settled.length === 0; })());
	check("booting + stale bootFailed is dropped", step(booting1(), EVENTS.bootFailedStale).state.kind === "booting" && step(booting1(), EVENTS.bootFailedStale).state.attempt === 1);
	check("booting ignores worker messages, timeouts, tool answers", (() => { const s = booting1(); return step(s, EVENTS.toolCall).state === s && step(s, EVENTS.timeoutFired).state === s && step(s, EVENTS.toolAnswered).state === s; })());
}

{
	const r = step(ready(), EVENTS.execRequested);
	check("ready + execRequested -> running with send + setTimer", r.state.kind === "running" && r.state.active.exec.id === 9 && same(effectTypes(r), ["send", "setTimer"]), JSON.stringify(r.effects));
	check("ready + execRequested arms the timer with the exec's own timeout", r.effects.find((e) => e.type === "setTimer")?.durationMs === 1000);

	const r2 = step(ready(), EVENTS.stopRequested);
	check("ready + stopRequested -> idle and kills the worker", r2.state.kind === "idle" && same(effectTypes(r2), ["kill"]));
	const r3 = step(ready(), EVENTS.workerDied);
	check("ready + workerDied -> idle without a kill effect (child already dead)", r3.state.kind === "idle" && r3.effects.length === 0 && r3.settled.length === 0);
	check("ready + end for a nonexistent exec is ignored", step(ready(), EVENTS.endActive).state.kind === "ready");
	check("ready + toolCall is dropped (no active exec)", step(ready(), EVENTS.toolCall).effects.length === 0);
}

{
	const r = step(running(), EVENTS.endActive);
	check("running + end(active) -> ready, settles ok with stateLost:false", r.state.kind === "ready" && same(outcomeNames(r.settled), ["1:ok"]) && r.settled[0].outcome.stateLost === false, JSON.stringify(r.settled));
	check("running + end(active) clears the timer in the same transition", same(effectTypes(r), ["clearTimer"]));
	check("end outcome carries the worker's value and output, no journal", r.settled[0].outcome.value === "7" && r.settled[0].outcome.output.length === 1 && r.settled[0].outcome.journal === undefined);

	check("running + end(unknown id) is ignored (P4 hygiene)", step(running(), EVENTS.endUnknown).state.kind === "running" && step(running(), EVENTS.endUnknown).settled.length === 0);
	check("running + stale-handle end is dropped even with a matching id", step(running(), EVENTS.endStale).state.kind === "running" && step(running(), EVENTS.endStale).settled.length === 0);
	check("running + duplicate ready message is ignored", step(running(), EVENTS.readyMessage).state.kind === "running");

	const r2 = step(running(), EVENTS.toolCall);
	check("running + toolCall -> answerTool effect with call identity, state unchanged", same(effectTypes(r2), ["answerTool"]) && r2.effects[0].callId === 5 && r2.effects[0].name === "bash" && r2.state.kind === "running", JSON.stringify(r2.effects));
	check("running + stale-handle toolCall is dropped", step(running(), EVENTS.toolCallStale).effects.length === 0);

	const r3 = step(runningJournaled(), EVENTS.toolAnswered);
	check("running + toolAnswered appends to the active exec's journal", r3.state.active.journal.length === 2 && same(r3.state.active.journal, [{ name: "read", ok: true }, { name: "bash", ok: true }]), JSON.stringify(r3.state.active.journal));
	check("running + toolAnswered sends the toolResult back", r3.effects.length === 1 && r3.effects[0].type === "send" && r3.effects[0].message.type === "toolResult" && r3.effects[0].message.ok === true, JSON.stringify(r3.effects));
	const r3err = step(running(), EVENTS.toolAnsweredError);
	check("running + failed toolAnswered journals ok:false and sends the error", r3err.state.active.journal[0].ok === false && r3err.effects[0].message.ok === false && r3err.effects[0].message.error === "nope", JSON.stringify(r3err.effects[0].message));
	check("running + stale-handle toolAnswered sends nothing", step(running(), EVENTS.toolAnsweredStale).effects.length === 0);
	const rStale = step(running(), EVENTS.toolAnsweredOldExec);
	check(
		"running + toolAnswered for a finished exec is ignored entirely",
		rStale.effects.length === 0 && rStale.settled.length === 0 && rStale.state.active.journal.length === 0,
		JSON.stringify(rStale.state.active?.journal),
	);

	const r4 = step(running(), EVENTS.workerDied);
	check("running + workerDied -> idle, active exec settles worker-stopped with journal, timer cleared", r4.state.kind === "idle" && same(outcomeNames(r4.settled), ["1:WorkerError"]) && same(effectTypes(r4), ["clearTimer"]), JSON.stringify(r4));
	check("worker-stopped outcome is honest (ok:false stateLost:true); empty journal is omitted", r4.settled[0].outcome.stateLost === true && r4.settled[0].outcome.journal === undefined, JSON.stringify(r4.settled[0].outcome));
	const r4j = step(runningJournaled(), EVENTS.workerDied);
	check("worker-stopped outcome carries the answered calls", same(r4j.settled[0].outcome.journal, [{ name: "read", ok: true }]));

	const r5 = step(running(), EVENTS.stopRequested);
	check("running + stopRequested -> idle, kill + clearTimer, settles worker-stopped", r5.state.kind === "idle" && same(effectTypes(r5), ["clearTimer", "kill"]) && same(outcomeNames(r5.settled), ["1:WorkerError"]), JSON.stringify(r5));

	const r6 = step(running(), EVENTS.timeoutFired);
	check("running + timeoutFired(active) -> idle, settles TimeoutError stateLost:true, clears timer + kills", r6.state.kind === "idle" && same(outcomeNames(r6.settled), ["1:TimeoutError"]) && same(effectTypes(r6), ["clearTimer", "kill"]), JSON.stringify(r6));
	check("timeout outcome is honest and carries the journal", r6.settled[0].outcome.stateLost === true && r6.settled[0].outcome.error?.message.includes("exceeded 1000 ms") && r6.settled[0].outcome.journal === undefined);
	const r6j = step(runningJournaled(), EVENTS.timeoutFired);
	check("timeout outcome lists the tool calls that landed", same(r6j.settled[0].outcome.journal, [{ name: "read", ok: true }]));
	check("running + timeoutFired(unknown id) is ignored", step(running(), EVENTS.timeoutFiredUnknown).state.kind === "running");

	check("running + booted/bootFailed cannot act on a live worker", step(running(), EVENTS.booted).state.kind === "running" && step(running(), EVENTS.bootFailed).state.kind === "running");
}

{
	let s = runningQueue();
	const order = [];
	for (let i = 0; i < 3; i++) {
		const r = step(s, EVENTS.endActive.id !== undefined && s.active.exec.id === 1 ? EVENTS.endActive : { type: "workerMessage", handle: h1, message: { type: "end", id: s.active.exec.id, ok: true, value: String(s.active.exec.id), output: [] } });
		order.push(r.settled[0]?.id);
		s = r.state;
	}
	check("queued execs drain FIFO 1->2->3 with no promise chain", same(order, [1, 2, 3]) && s.kind === "ready", JSON.stringify({ order, kind: s.kind }));

	const r = step(runningQueue(), EVENTS.endActive);
	check("end(active) promotes the first queued exec (send + setTimer) and keeps the rest", r.state.kind === "running" && r.state.active.exec.id === 2 && r.state.queued.map((e) => e.id).join() === "3" && same(effectTypes(r), ["clearTimer", "send", "setTimer"]), JSON.stringify(r));

	const r2 = step(runningQueue(), EVENTS.stopRequested);
	check("stop with queued execs settles active AND queued, in order", same(outcomeNames(r2.settled), ["1:WorkerError", "2:WorkerError", "3:WorkerError"]), JSON.stringify(r2.settled));
	check("queued execs settle without a journal (they never ran)", r2.settled[1].outcome.journal === undefined && r2.settled[2].outcome.journal === undefined);

	const r3 = step(runningQueue(), EVENTS.timeoutFired);
	check("timeout with queued execs: active settles TimeoutError, queued settle worker-stopped", same(outcomeNames(r3.settled), ["1:TimeoutError", "2:WorkerError", "3:WorkerError"]), JSON.stringify(r3.settled));
	const r4 = step(runningQueue(), EVENTS.workerDied);
	check("worker death with queued execs settles all three", same(outcomeNames(r4.settled), ["1:WorkerError", "2:WorkerError", "3:WorkerError"]) && r4.state.kind === "idle", JSON.stringify(r4.settled));
}

// ---------------------------------------------------------------- structural: no reject channel exists

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
for (const file of ["lifecycle.ts", "index.ts"]) {
	const src = stripComments(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
	check(`${file}: no reject channel in code (wedge class unwritable)`, !/\breject\b/.test(src), src.match(/.{0,40}\breject\b.{0,40}/)?.[0]);
}

const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
