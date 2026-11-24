// test-worker-cleanup.mjs — proves scripts/worker-cleanup.mjs's safety
// contract on real processes: only pgrep -P children of the target are
// candidates, the target itself is never killed, --dry-run kills nothing,
// and a target with no children is a no-op.
import { execFileSync, spawn } from "node:child_process";

const results = [];
const check = (name, cond, detail = "") => {
	results.push({ name, pass: !!cond });
	console.log((cond ? "PASS  " : "FAIL  ") + name + (detail ? " — " + detail : ""));
};
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Decoy: a node parent that spawns a node child and reports the child's pid.
const decoy = spawn("node", ["-e", "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write('CHILD ' + c.pid + '\\n'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"] });
let childPid = null;
const line = await new Promise((resolve) => {
	let buf = "";
	const t = setTimeout(() => resolve(null), 3000);
	decoy.stdout.on("data", (d) => {
		buf += d.toString();
		const m = buf.match(/CHILD (\d+)/);
		if (m) {
			clearTimeout(t);
			resolve(Number(m[1]));
		}
	});
});
childPid = line;
check("decoy parent and child are alive", decoy.pid > 0 && childPid > 0 && alive(decoy.pid) && alive(childPid), "parent=" + decoy.pid + " child=" + childPid);
await sleep(200);

const run = (args) => JSON.parse(execFileSync("node", ["scripts/worker-cleanup.mjs", ...args], { encoding: "utf8" }));

const dry = run(["--pid", String(decoy.pid), "--dry-run"]);
check("dry-run lists exactly the pgrep children and kills nothing", dry.killed.length === 0 && dry.children.length === 1 && dry.children[0] === childPid, JSON.stringify(dry));
check("dry-run left the child alive", alive(childPid));

const real = run(["--pid", String(decoy.pid)]);
check("real run kills exactly the child", real.killed.length === 1 && real.killed[0] === childPid, JSON.stringify(real));
await sleep(100);
check("the child is dead after the real run", !alive(childPid));
check("the target itself is never killed", alive(decoy.pid));

// No children: a no-op that costs nothing.
const childless = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
await sleep(200);
const noop = run(["--pid", String(childless.pid)]);
check("a target with no children is a clean no-op", noop.children.length === 0 && noop.killed.length === 0 && noop.failed.length === 0, JSON.stringify(noop));
check("the childless target is still alive", alive(childless.pid));

decoy.kill("SIGKILL");
childless.kill("SIGKILL");

const failed = results.filter((x) => !x.pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
process.exit(failed === 0 ? 0 : 1);
