#!/usr/bin/env node
// driver-gating.mjs — drives the extension's tool gating (/code-mode modes)
// by loading index.ts against a stubbed ExtensionAPI — the production boundary
// index.ts only speaks through — so the stub exercises the real registration
// and loadout code.
//
// Usage: node driver-gating.mjs [out.json]   (run with cwd = the package root)
// Writes JSON results and exits non-zero if any assertion fails.

import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";

// index.ts imports "./gating" extensionless; type-stripping needs the hook.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".")) return next(specifier + ".ts", context);
      throw err;
    }
  },
});

const packageRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const { default: extension } = await import(path.join(packageRoot, "index.ts"));

const registrations = { tools: [], commands: [] };
let settings = { codemode: undefined };
const notifications = [];
const pi = {
  registerTool: (t) => registrations.tools.push(t),
  registerCommand: (name, c) => registrations.commands.push({ name, ...c }),
  getSettings: () => settings,
  on: () => undefined,
};
extension(pi);

const tool = registrations.tools.find((t) => t.name === "code_mode");
const command = registrations.commands.find((c) => c.name === "code-mode");
if (!tool || !command) fail("extension did not register code_mode tool/command");

const declared = [
  { name: "read", description: "Reads a file" },
  { name: "bash", description: "Runs a bash command" },
  { name: "code_mode", description: "Run JavaScript" },
];
const callable = declared;
const loadout = () => ({ declared, callable });
const uiCtx = { ui: { notify: (m, level) => notifications.push({ m, level }) } };

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: !!cond, detail: JSON.stringify(detail).slice(0, 300) });
  if (!cond) process.exitCode = 1;
}
function fail(msg) {
  console.error("fatal: " + msg);
  process.exit(2);
}

let load = tool.prepareLoadout(loadout());
check("on: no hidden declarations", load && !load.hiddenDeclarations, load?.hiddenDeclarations);
check(
  "on: bash description gains codemode hint",
  load?.descriptions?.bash?.includes("Codemode: prefer running this via code_mode"),
  load?.descriptions?.bash,
);
check("on: code_mode itself not annotated", load?.descriptions?.code_mode === undefined, load?.descriptions);

await command.handler("only", uiCtx);
load = tool.prepareLoadout(loadout());
check("only: read+bash hidden", JSON.stringify(load?.hiddenDeclarations) === JSON.stringify(["read", "bash"]), load?.hiddenDeclarations);
check("only: description lists tools.bash", load?.descriptions?.code_mode?.includes("tools.bash(args)"), load?.descriptions?.code_mode);
check("only: description lists tools.read", load?.descriptions?.code_mode?.includes("tools.read(args)"), load?.descriptions?.code_mode);

await command.handler("status", uiCtx);
check("status: reports session override", notifications.at(-1)?.m === "code_mode mode: only (session override)", notifications.at(-1));

await command.handler("off", uiCtx);
check("off: prepareLoadout returns undefined", tool.prepareLoadout(loadout()) === undefined, tool.prepareLoadout(loadout()));

await command.handler("bogus", uiCtx);
check("bogus: error notification", notifications.at(-1)?.m.includes('Unknown mode "bogus"'), notifications.at(-1));

const json = JSON.stringify({ results }, null, 2);
const outPath = process.argv[2];
if (outPath) writeFileSync(outPath, json + "\n");
else console.log(json);
for (const r of results) console.log((r.pass ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? " — " + r.detail : ""));
console.log(results.filter((r) => r.pass).length + "/" + results.length + " passed");
