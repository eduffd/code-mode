#!/usr/bin/env node
// check-docs.mjs — assert DESIGN.md and README.md against the repository.
//
// Docs drift killed trust once (a deleted module stayed documented for four
// PRs). This script makes the docs assertable: every rule below fails the
// suite when the docs lie about the repo, and CI runs it on every push.
//
// Rules:
//   phantom-paths    every code-extension path the docs name is tracked in git
//   files-coverage   every shipped source file is named in README "## Files"
//   exports-map      package.json exports exactly the entry, nothing deep
//   settings-shape   .pi/settings.json is the nested codemode.mode shape
//   workflow-steps   ci.yml runs all five gate suites on push + pull_request
//   marker-strings   quoted literals exist in the code; known dead claims
//                    (output.ts, spill files, rewriteTopLevel) stay dead
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
let tracked;
try {
	tracked = new Set(
		execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean),
	);
} catch (e) {
	console.error(`check-docs: git ls-files failed: ${e.message}`);
	process.exit(1);
}

// ---- docs under check
const docs = { "README.md": read("README.md"), "DESIGN.md": read("DESIGN.md") };

// ---- rule: phantom-paths
// Backticked tokens that look like repo files must be tracked. Tokens with
// whitespace are commands, not paths; ~, / and http are outside the repo.
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
// Everything shipped at the top level (sources, tests, scripts, workflow,
// settings) must appear in README's "## Files" section.
const filesSection = (() => {
	const m = docs["README.md"].match(/^## Files\n(.*?)(?=^## )/ms);
	return m ? m[1] : "";
})();
if (!filesSection) problem("files-coverage", 'README has no "## Files" section');

const COVERAGE_EXCLUDE = new Set(["package-lock.json", ".gitignore"]);
const coverageSet = [...tracked].filter((f) => {
	if (COVERAGE_EXCLUDE.has(f)) return false;
	if (/^[^/]+\.(ts|js|mjs)$/.test(f)) return true; // sources and suites at the root
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
	"node scripts/check-docs.mjs",
]) {
	if (!workflow.includes(step)) problem("workflow-steps", `ci.yml does not run \`${step}\``);
}
if (!workflow.includes("pull_request:")) problem("workflow-steps", 'ci.yml does not trigger on "pull_request:"');

// ---- rule: marker-strings
// Literals the docs quote must exist in the code that owns them...
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

// ...and the claims the rearchitecture killed must stay dead.
const DEAD_CLAIMS = ["output.ts", "writeoutputfile", "spill", "rewritetoplevel"];
for (const [doc, text] of Object.entries(docs)) {
	const lower = text.toLowerCase();
	for (const claim of DEAD_CLAIMS) {
		if (lower.includes(claim)) problem("marker-strings", `${doc} still makes the dead claim \`${claim}\``);
	}
}

// ---- verdict
if (problems.length > 0) {
	console.error(problems.join("\n"));
	console.error(`check-docs: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
	process.exit(1);
}
console.log("check-docs: 0 problems");
