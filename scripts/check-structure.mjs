#!/usr/bin/env node
// check-structure.mjs — structural gates for claims the code makes about
// itself. Each rule encodes a constraint that was once only prose (or only
// true by luck); breaking it fails CI with an error that names the fix.
//
//   one-compile-path   only compile.ts parses; no other module compiles
//   module-boundary    only worker-host.ts touches child processes / pidfile;
//                      index.ts wires, it does not re-implement
//   protocol-erasable  protocol.ts stays import-free, enum-free, namespace-free
//   tsc-gate           ci.yml runs the strict-tsc gate; the recorded run exists
//   skill-integrity    skill files obey the same phantom-path and dead-claim
//                      rules as DESIGN.md and README.md
//
// CI runs it on every push (see ci.yml); scripts/check-docs.mjs asserts that.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const problems = [];
const problem = (rule, detail) => problems.push(`PROBLEM ${rule}: ${detail}`);

let tracked;
try {
	tracked = new Set(execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
} catch (e) {
	console.error(`check-structure: git ls-files failed: ${e.message}`);
	process.exit(1);
}

const rootCode = [...tracked].filter((f) => /^[^/]+\.(ts|js|mjs)$/.test(f));

// ---- rule: one-compile-path
for (const f of rootCode) {
	if (f === "compile.ts") continue;
	const src = read(f);
	if (/\bvm\.Script\b|\bnew Function\(/.test(src)) {
		problem("one-compile-path", `${f} compiles scripts outside compile.ts (vm.Script/new Function) — move it into compile.ts`);
	}
	if (/from ["']acorn["']|require\(["']acorn["']\)/.test(src)) {
		problem("one-compile-path", `${f} imports acorn directly — only compile.ts may parse`);
	}
}

// ---- rule: module-boundary
for (const f of rootCode) {
	if (f === "worker-host.ts" || f.startsWith("test-")) continue;
	const src = read(f);
	if (src.includes("node:child_process") || src.includes(".code-mode-worker.pid")) {
		problem("module-boundary", `${f} touches child processes or the worker pidfile — only worker-host.ts may`);
	}
}
const indexSrc = read("index.ts");
for (const name of ["formatResult", "buildLoadout", "handleCommand", "step"]) {
	if (new RegExp("\\b(function|const|let)\\s+" + name + "\\b").test(indexSrc)) {
		problem("module-boundary", `index.ts defines ${name} itself — import it from the owning module instead`);
	}
}

// ---- rule: protocol-erasable
const protoSrc = read("protocol.ts");
if (/^import /m.test(protoSrc)) problem("protocol-erasable", "protocol.ts gained an import — type stripping must be able to load it");
if (/\benum\s+[A-Za-z_$]|\bnamespace\s+[A-Za-z_$]/.test(protoSrc)) problem("protocol-erasable", "protocol.ts gained an enum or namespace — not erasable by type stripping");

// ---- rule: tsc-gate
const workflow = read(join(".github", "workflows", "ci.yml"));
if (!workflow.includes("./node_modules/.bin/tsc --noEmit")) problem("tsc-gate", "ci.yml does not run ./node_modules/.bin/tsc --noEmit");
try {
	const tscEvidence = read(join("evidence", "tsc.txt"));
	if (!tscEvidence.includes("./node_modules/.bin/tsc --noEmit")) problem("tsc-gate", "evidence/tsc.txt does not record the gate command");
} catch {
	problem("tsc-gate", "evidence/tsc.txt is missing — the recorded gate run is gone");
}

// ---- rule: skill-integrity
const CODE_EXT = /\.(ts|js|mjs|cjs|json|yml)$/;
const backtickTokens = (text) => [...text.matchAll(/\`([^\`\n]+)\`/g)].map((m) => m[1]);
// <cwd>/-style placeholders are idioms, not paths.
const pathlike = (token) => !/\s/.test(token) && !/^(~|\/|http)/.test(token) && !token.endsWith("/") && !token.includes("<") && CODE_EXT.test(token);
const trackedList = [...tracked];
// Skills reference files by basename or path relative to themselves
// (helpers/driver-worker.mjs); a token resolves when any tracked path ends with it.
const resolves = (token) => tracked.has(token) || trackedList.some((p) => p.endsWith("/" + token));
const DEAD_CLAIMS = ["output.ts", "writeoutputfile", "spill", "rewritetoplevel"];
const skills = [".claude/skills/exec-lifecycle/SKILL.md", ".claude/skills/verify/SKILL.md"];
for (const doc of skills) {
	if (!tracked.has(doc)) continue; // an untracked skill is check-docs' problem, not ours
	const text = read(doc);
	for (const token of backtickTokens(text)) {
		if (pathlike(token) && !resolves(token)) problem("skill-integrity", `${doc} names \`${token}\` which is not tracked in git`);
	}
	const lower = text.toLowerCase();
	for (const claim of DEAD_CLAIMS) {
		if (lower.includes(claim)) problem("skill-integrity", `${doc} still makes the dead claim \`${claim}\``);
	}
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	console.error(`check-structure: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
	process.exit(1);
}
console.log("check-structure: 0 problems");
