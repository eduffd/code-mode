// test-worker-host.mjs — drives the real effect interpreter (worker-host.ts)
// with the real step() core and a real forked worker that dies before its
// ready handshake. Encodes the cross-module routing claim: a pre-boot death
// surfaces as bootFailed (with the plain retry), never as workerDied — the
// exit->workerDied listener only exists after ready.
import { step } from "./lifecycle.ts";
import { createWorkerHost } from "./worker-host.ts";

const results = [];
const check = (name, cond, detail = "") => {
	results.push({ name, pass: !!cond });
	console.log((cond ? "PASS  " : "FAIL  ") + name + (detail ? " — " + detail : ""));
};

process.env.CM_EXIT_BEFORE_READY = "1";

const events = [];
const allEvents = [];
const host = createWorkerHost({ onEvent: (e) => { allEvents.push(e); events.push(e); }, workerPath: new URL("./.claude/skills/exec-lifecycle/fake-worker.mjs", import.meta.url).pathname });

const mkExec = (id) => ({ id, code: "x(" + id + ");", tools: [], timeoutMs: 1000 });
let state = { kind: "idle" };
const settled = [];
const deadline = Date.now() + 5000;

// Push the exec in; interpret every effect; feed every host event back to the core.
const r0 = step(state, { type: "execRequested", exec: mkExec(1) });
state = r0.state;
for (const fx of r0.effects) host.interpret(fx);

while (state.kind !== "idle" && Date.now() < deadline) {
	if (events.length === 0) {
		await new Promise((r) => setTimeout(r, 10));
		continue;
	}
	const ev = events.shift();
	const r = step(state, ev);
	state = r.state;
	for (const fx of r.effects) host.interpret(fx);
	settled.push(...r.settled);
}

delete process.env.CM_EXIT_BEFORE_READY;

const bootFails = allEvents.filter((e) => e.type === "bootFailed");
const died = allEvents.filter((e) => e.type === "workerDied");
const booted = allEvents.filter((e) => e.type === "booted");
check("pre-boot exit never emits workerDied", died.length === 0, JSON.stringify(allEvents.map((e) => e.type)));
check("pre-boot exit never emits booted", booted.length === 0, JSON.stringify(allEvents.map((e) => e.type)));
check("pre-boot exit routes to bootFailed twice (attempt 1, then the plain retry)", bootFails.length === 2, JSON.stringify(allEvents.map((e) => e.type)));
check("the queued exec settles with a failed outcome", settled.length === 1 && settled[0].id === 1 && settled[0].outcome.ok === false, JSON.stringify(settled));
check("the core returns to idle after the boot failure", state.kind === "idle", state.kind);

const failed = results.filter((x) => !x.pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
process.exit(failed === 0 ? 0 : 1);
