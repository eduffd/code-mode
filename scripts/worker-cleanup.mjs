#!/usr/bin/env node
// worker-cleanup.mjs — kill the code_mode workers a crashed session left behind.
//
// Usage: node scripts/worker-cleanup.mjs --pid <pid> [--dry-run]
//
// Scoped kill only: the target's children (pgrep -P <pid>) are the entire
// candidate set. Nothing is ever matched by process name, and the target pid
// itself is never killed — a wrong --pid then costs nothing.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pidIndex = args.indexOf("--pid");
const pid = Number(pidIndex !== -1 ? args[pidIndex + 1] : NaN);

if (!Number.isInteger(pid) || pid <= 0) {
	console.error("usage: node scripts/worker-cleanup.mjs --pid <pid> [--dry-run]");
	process.exit(2);
}

const alive = (p) => {
	try {
		process.kill(p, 0);
		return true;
	} catch {
		return false;
	}
};

if (!alive(pid)) {
	console.log(JSON.stringify({ pid, children: [], killed: [], failed: [], note: "pid not alive; nothing to do" }));
	process.exit(0);
}

let children;
try {
	const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
	// Number("") is 0 and process.kill(0) would signal the caller's whole
	// process group — the exact unscoped kill this script exists to prevent.
	// Keep positive integers only.
	children = out
		.split("\n")
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0);
} catch {
	// pgrep exits 1 when the pid has no children.
	children = [];
}

const killed = [];
const failed = [];
for (const child of children) {
	if (dryRun) {
		killed.push(child);
		continue;
	}
	try {
		process.kill(child, "SIGKILL");
		killed.push(child);
	} catch (e) {
		failed.push({ pid: child, error: e.code ?? String(e) });
	}
}

console.log(JSON.stringify({ pid, children, killed, failed, dryRun }));
process.exit(failed.length === 0 ? 0 : 1);
