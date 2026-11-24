#!/usr/bin/env node
// check-counts.mjs — every suite count the docs quote must match the suite
// real output ("N/M passed"). Counts rotted in every PR before this gate.
// CI runs it on every push; scripts/check-docs.mjs keeps the step honest.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const problems = [];
const problem = (rule, detail) => problems.push("PROBLEM " + rule + ": " + detail);

const docs = { "README.md": read("README.md"), "DESIGN.md": read("DESIGN.md") };
const suites = ["test-worker.mjs", "test-compile.mjs", "test-lifecycle-core.mjs", "test-format.mjs"];

const actual = {};
for (const suite of suites) {
	const out = execFileSync("node", [suite], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
	const m = out.match(/(\d+)\/(\d+) passed/);
	if (!m) problem("check-counts", suite + " did not print an \"N/M passed\" line");
	else actual[suite] = Number(m[1]);
}

// A suite is quoted as a backticked name followed by a number within a few
// characters ("(41 checks)"), or as "<suite>  # 41 checks" in Development.
// \x60 is a backtick, spelled out so this file needs none.
const patterns = suites.map((s) => ({
	suite: s,
	res: [
		new RegExp("\\x60?" + s.replace(/\./g, "\\.") + "\\x60?[^0-9\\n]{0,24}(\\d+)", "g"),
		new RegExp(s.replace(/\./g, "\\.") + "\\s+#\\s*(\\d+)", "g"),
	],
}));

for (const [doc, text] of Object.entries(docs)) {
	for (const { suite, res } of patterns) {
		const a = actual[suite];
		if (a === undefined) continue;
		for (const re of res) {
			re.lastIndex = 0;
			for (const m of text.matchAll(re)) {
				if (Number(m[1]) !== a) {
					problem("check-counts", doc + " claims " + suite + " has " + m[1] + " checks; the suite reports " + a);
				}
			}
		}
	}
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	console.error("check-counts: " + problems.length + " problem" + (problems.length === 1 ? "" : "s"));
	process.exit(1);
}
console.log("check-counts: 0 problems");