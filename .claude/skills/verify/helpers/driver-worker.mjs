#!/usr/bin/env node
// driver-worker.mjs — protocol harness for repl-worker.js (the code_mode REPL).
//
// Usage: node driver-worker.mjs <plan.json> [out.json]
//   plan.json: { "steps": [ { "name": "...", "code": "...", "toolValues": { tool: value } } ] }
// Forks repl-worker.js from the package root, waits for the ready handshake,
// runs the steps sequentially over fork IPC, writes one JSON file recording
// every exec outcome (the evidence), and always kills the child it forked.
//
// Exit code: 0 if every step ended ok, 1 otherwise (a step that EXPECTS an
// error still records ok:false — judge results from the JSON, not the exit code).

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const packageRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const workerPath = path.join(packageRoot, "repl-worker.js");

const [planPath, outArg] = process.argv.slice(2);
if (!planPath) {
  console.error("usage: node driver-worker.mjs <plan.json> [out.json]");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const outPath = outArg ?? null;

const proc = fork(workerPath, [], {
  cwd: packageRoot,
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
const childPid = proc.pid;

let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
const waiters = new Map();
const toolAnswers = new Map();
let seq = 0;
const recorded = [];

proc.on("message", (msg) => {
  if (msg.type === "ready") return readyResolve();
  if (msg.type === "toolCall") {
    const value = toolAnswers.get(msg.name);
    proc.send({ type: "toolResult", callId: msg.callId, ok: true, value });
    return;
  }
  if (msg.type === "end") {
    const w = waiters.get(msg.id);
    waiters.delete(msg.id);
    w(msg);
  }
});
proc.stderr?.on("data", (c) => process.stderr.write(c));

const overallTimer = setTimeout(() => {
  console.error(JSON.stringify({ fatal: "driver timeout", recorded, childPid }));
  proc.kill();
  process.exit(1);
}, 120_000);

await ready;

for (const step of plan.steps ?? []) {
  seq += 1;
  const id = seq;
  for (const [k, v] of Object.entries(step.toolValues ?? {})) toolAnswers.set(k, v);
  const result = await new Promise((resolve) => {
    waiters.set(id, resolve);
    proc.send({ type: "exec", id, code: step.code, tools: plan.tools ?? [] });
  });
  recorded.push({ name: step.name, ...result });
}

clearTimeout(overallTimer);
proc.kill();
const json = JSON.stringify({ childPid, steps: recorded }, null, 2);
if (outPath) writeFileSync(outPath, json + "\n");
else console.log(json);
process.exit(recorded.every((s) => s.ok) ? 0 : 1);
