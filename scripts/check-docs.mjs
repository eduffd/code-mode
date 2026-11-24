#!/usr/bin/env node
// check-docs.mjs — assert DESIGN.md and README.md against the repository
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const problems = [];
const problem = (rule, detail) => problems.push(`PROBLEM ${rule}: ${detail}`);

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- tracked files
let tracked;try {
	tracked = new Set(
		execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean),
	);
} catch (e) {
	console.error(`check-docs: git ls-files failed: ${e.message}`);
	process.exit(1);
}

const docs = { "README.md": read("README.md"), "DESIGN.md": read("DESIGN.md") };

// ---- rule: phantom-paths
const CODE_EXT = /\.(ts|js|mjs|cjs|json|yml)$/;
const backtickTokens = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const pathlike = (token) =>
	!/\s/.test(token) && !/^(~|\/|http)/.test(token) && !token.endsWith("/") && CODE_EXT.test(token);

for (const [doc, text] of Object.entries(docs)) {
	for (const token of backtickTokens(text)) {
		if (pathlike(token) && !tracked.has(token)) {
			problem("phantom-paths", `${doc} names \`${token}\` which is not tracked in git`);
		}
	}
}

// ---- rule: files-coverage
const filesSection = (() => {
	const m = docs["README.md"].match(/^## Files\n(.*?)(?=^## )/ms);
	return m ? m[1] : "";
})();
if (!filesSection) problem("files-coverage", 'README has no "## Files" section');

const COVERAGE_EXCLUDE = new Set(["package-lock.json", ".gitignore"]);
const coverageSet = [...tracked].filter((f) => {
	if (COVERAGE_EXCLUDE.has(f)) return false;
	if (/^[^/]+\.(ts|js|mjs)$/.test(f)) return true;
	if (/^scripts\/[^/]+\.mjs$/.test(f)) return true;
	if (/^\.github\/workflows\/[^/]+\.yml$/.test(f)) return true;
	return f === ".pi/settings.json";
});
const filesTokens = new Set(backtickTokens(filesSection));
for (const f of coverageSet) {
	if (!filesTokens.has(f)) problem("files-coverage", `README "## Files" does not list \`${f}\``);
}

// ---- rule: exports-map
const pkg = JSON.parse(read("package.json"));
if (!deepEqual(pkg.exports, { ".": "./index.ts" })) {
	problem("exports-map", `package.json exports is ${JSON.stringify(pkg.exports)}, expected {".":"./index.ts"}`);
}

// ---- rule: settings-shape
const SETTINGS = { codemode: { mode: "only" } };
let settings;
try {
	settings = JSON.parse(read(join(".pi", "settings.json")));
} catch {
	problem("settings-shape", ".pi/settings.json is missing or not valid JSON");
	settings = null;
}
if (settings && !deepEqual(settings, SETTINGS)) {
	problem("settings-shape", `.pi/settings.json is ${JSON.stringify(settings)}, expected ${JSON.stringify(SETTINGS)}`);
}

// ---- rule: workflow-steps
const workflow = read(join(".github", "workflows", "ci.yml"));
for (const step of [
	"node test-worker.mjs",
	"node test-compile.mjs",
	"node test-lifecycle-core.mjs",
	"node test-format.mjs",
	"node test-worker-host.mjs",
	"node test-worker-cleanup.mjs",
	"node .claude/skills/exec-lifecycle/check-exec-lifecycle.mjs",
	"node scripts/check-docs.mjs",
	"node scripts/check-structure.mjs",
]) {
	if (!workflow.includes(step)) problem("workflow-steps", `ci.yml does not run \`${step}\``);
}
if (!workflow.includes("pull_request:")) problem("workflow-steps", 'ci.yml does not trigger on "pull_request:"');

// ---- rule: marker-strings
const MARKERS_IN_CODE = [
	["format.ts", "head-and-tail omitted"],
	["format.ts", "(REPL state was lost)"],
	["compile.ts", "has already been declared"],
	["gating.ts", '{"codemode": {"mode":'],
	["lifecycle.ts", "REPL state was lost"],
];
for (const [file, needle] of MARKERS_IN_CODE) {
	if (!read(file).includes(needle)) problem("marker-strings", `\`${needle}\` no longer in ${file}; docs quoting it are now wrong`);
}
const readme = docs["README.md"];
const design = docs["DESIGN.md"];
for (const needle of ["head-and-tail omitted", "has already been declared"]) {
	if (!readme.includes(needle)) problem("marker-strings", `README no longer quotes \`${needle}\``);
}
if (!design.includes("head-and-tail omitted")) problem("marker-strings", 'DESIGN no longer quotes `head-and-tail omitted`');

const DEAD_CLAIMS = ["output.ts", "writeoutputfile", "spill", "rewritetoplevel"];
for (const [doc, text] of Object.entries(docs)) {
	const lower = text.toLowerCase();
	for (const claim of DEAD_CLAIMS) {
		if (lower.includes(claim)) problem("marker-strings", `${doc} still makes the dead claim \`${claim}\``);
	}
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	console.error(`check-docs: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
	process.exit(1);
}
console.log("check-docs: 0 problems");
