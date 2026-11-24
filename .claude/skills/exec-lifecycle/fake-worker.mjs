// fake-worker.mjs — scripted stand-in for repl-worker.js used by
// check-exec-lifecycle.mjs. Speaks the same fork-IPC protocol (ready / exec /
// end) but emulates a long-running script (never completes on its own) and
// takes its event script from __cm_* control messages sent over IPC:
//   { type: "__cm_deliverEnd" } — reply with a successful end for the last exec
//   { type: "__cm_deliverEndId", id } — reply with a successful end claiming the
//     given exec id (proves a late/unknown end is dropped by the core)
//   { type: "__cm_crash" }      — die immediately (real exit event, code 137)
// Every exec is acknowledged with { type: "__cm_execReceived" } so the harness
// knows the exec is in flight (the extension ignores unknown message types).
// CM_FAKE_BOOT_CRASH=1 models a broken first boot with permission flags:
// the flagged spawn dies (execArgv carries --permission); the plain retry
// spawned without flags boots normally. No runtime fs access: the only file
// read is the protocol.ts import at module load.

import { isWorkerOutMessage } from "../../../protocol.ts";

let lastExecId = null;

const sendProtocol = (msg) => {
	if (!isWorkerOutMessage(msg)) throw new Error(`fake-worker produced a non-protocol message: ${JSON.stringify(msg)}`);
	process.send(msg);
};

process.on("message", (msg) => {
	if (!msg || typeof msg !== "object") return;
	switch (msg.type) {
		case "__cm_crash":
			process.exit(137);
			break;
		case "__cm_deliverEnd":
			sendProtocol({ type: "end", id: lastExecId, ok: true, value: JSON.stringify("ok"), output: [{ type: "text", text: "ran" }] });
			break;
		case "__cm_toolCallThenEnd":
			// P5 replay: the exec makes a tool call, then ends without awaiting
			// the answer. execId is ignored by pre-execId protocol guards and
			// required once toolCall carries it, so this works across the fix.
			sendProtocol({ type: "toolCall", execId: lastExecId, callId: 1, name: "bash", args: {} });
			sendProtocol({ type: "end", id: lastExecId, ok: true, value: JSON.stringify("ok"), output: [{ type: "text", text: "ran" }] });
			break;
		case "__cm_deliverEndId":
			sendProtocol({ type: "end", id: msg.id, ok: true, value: JSON.stringify("ok"), output: [{ type: "text", text: "ran" }] });
			break;
		case "exec":
			lastExecId = msg.id;
			process.send({ type: "__cm_execReceived", fake: true });
			break;
	}
});

if (process.env.CM_FAKE_BOOT_CRASH === "1" && process.execArgv.includes("--permission")) {
	process.exit(1);
}

if (process.env.CM_EXIT_BEFORE_READY === "1") {
	// Dies before the handshake: the host must route this to bootFailed (with
	// its plain retry), never to workerDied — the exit->workerDied listener
	// only exists after ready.
	process.exit(7);
}

sendProtocol({ type: "ready" });
