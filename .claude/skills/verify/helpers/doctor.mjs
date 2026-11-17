#!/usr/bin/env node
// doctor.mjs — read-only health check: run this first whenever a verification
// run looks off. Checks (1) Node can type-strip (>= 23.6), (2) repl-worker.js
// boots and completes the ready handshake, (3) the extension is registered in pi.
// Usage: node doctor.mjs   — prints JSON, exits non-zero on any failure.

import { fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail });

const nodeMajor = Number(process.versions.node.split(".")[0]);
check("node >= 23.6 (type stripping)", nodeMajor >= 23, process.versions.node);

const boot = await new Promise((resolve) => {
  const proc = fork(path.join(packageRoot, "repl-worker.js"), [], {
    cwd: packageRoot,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const timer = setTimeout(() => {
    proc.kill();
    resolve(false);
  }, 5000);
  proc.once("message", (msg) => {
    if (msg?.type === "ready") {
      clearTimeout(timer);
      proc.kill();
      resolve(true);
    }
  });
  proc.once("error", () => {
    clearTimeout(timer);
    resolve(false);
  });
  proc.once("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0 && code !== null) resolve(false);
  });
});
check("repl-worker.js ready handshake", boot);

try {
  const list = execFileSync("pi", ["list"], { encoding: "utf8", timeout: 15_000 });
  check("extension registered in pi (pi list)", /code-mode/.test(list), list.split("\n").filter((l) => l.includes("code-mode")).join(" | "));
} catch (err) {
  check("extension registered in pi (pi list)", false, String(err.message).slice(0, 200));
}

console.log(JSON.stringify({ checks }, null, 2));
process.exit(checks.every((c) => c.pass) ? 0 : 1);
