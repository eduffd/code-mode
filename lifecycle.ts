// lifecycle.ts — the pure exec-lifecycle core for code_mode.
//
// One total function: step(state, event) -> { state, effects, settled }.
// It owns the whole worker lifecycle as a reviewable transition table:
//
//   idle ──execRequested──▶ booting{attempt,handle,queued} ──booted──▶ ready{handle}
//   booting ──bootFailed──▶ booting{attempt:2} (plain-flag retry) or idle (settled)
//   ready ──execRequested──▶ running{handle,active,queued} ──end──▶ ready / next queued
//   running ──stopRequested│workerDied│timeoutFired──▶ idle, every open exec settled
//
// Load-bearing invariant: an accepted exec's future must settle exactly once.
// Open execs live only on the holding states (booting, running); every
// transition that leaves a holding state returns one settled outcome per open
// exec — there is no other way to leave, and no state a dropped exec could
// hide in. Exec futures are resolve-only: this module's types have no reject
// channel and no promise, so the phantom-reject wedge class cannot be written.
//
// Pure: no node imports, no I/O, no time reads. All effects (spawn, send,
// kill, timers, tool answering) are returned for worker-host.ts to interpret.
// Worker identity is an opaque handle minted here; events carrying a stale
// handle are dropped.

import type { ExecOutcome, ToolCallRecord, ToolDecl, WorkerInMessage, WorkerOutMessage } from "./protocol.ts";

/** Opaque identity of one spawned worker attempt; the host maps it to a child process. */
export interface WorkerHandle {
	readonly seq: number;
}

/** An accepted exec whose caller future is open; the core must settle it exactly once. */
export interface AcceptedExec {
	readonly id: number;
	readonly code: string;
	readonly tools: readonly ToolDecl[];
	readonly timeoutMs: number;
}

/** The one exec in flight on a running worker, with its answered-tool-call journal. */
export interface ActiveExec {
	readonly exec: AcceptedExec;
	readonly journal: readonly ToolCallRecord[];
}

export interface BootingState {
	readonly kind: "booting";
	/** 1 = first spawn (permission flags), 2 = plain retry after a failed first boot. */
	readonly attempt: 1 | 2;
	readonly handle: WorkerHandle;
	readonly queued: readonly AcceptedExec[];
}

export interface ReadyState {
	readonly kind: "ready";
	readonly handle: WorkerHandle;
}

export interface RunningState {
	readonly kind: "running";
	readonly handle: WorkerHandle;
	readonly active: ActiveExec;
	readonly queued: readonly AcceptedExec[];
}

export type LifecycleState = { readonly kind: "idle" } | BootingState | ReadyState | RunningState;

/** Which hardening flags a spawn asks for; the host maps this to node execArgv. */
export type SpawnFlags = "permission" | "plain";

export type Effect =
	| { readonly type: "spawn"; readonly handle: WorkerHandle; readonly flags: SpawnFlags }
	| { readonly type: "send"; readonly handle: WorkerHandle; readonly message: WorkerInMessage }
	| { readonly type: "kill"; readonly handle: WorkerHandle }
	| { readonly type: "setTimer"; readonly id: number; readonly durationMs: number }
	| { readonly type: "clearTimer"; readonly id: number }
	| { readonly type: "answerTool"; readonly handle: WorkerHandle; readonly callId: number; readonly name: string; readonly args: unknown };

/** One exec settled by a transition; the adapter resolves its caller future with the outcome. */
export interface SettledExec {
	readonly id: number;
	readonly outcome: ExecOutcome;
}

export interface StepResult {
	readonly state: LifecycleState;
	readonly effects: readonly Effect[];
	readonly settled: readonly SettledExec[];
}

export type LifecycleEvent =
	| { readonly type: "execRequested"; readonly exec: AcceptedExec }
	| { readonly type: "booted"; readonly handle: WorkerHandle }
	| { readonly type: "bootFailed"; readonly handle: WorkerHandle; readonly message: string }
	| { readonly type: "workerMessage"; readonly handle: WorkerHandle; readonly message: WorkerOutMessage }
	| { readonly type: "workerDied"; readonly handle: WorkerHandle }
	/** The one stop event: /code-mode off, session switch/fork/shutdown, or a boot-time stop. */
	| { readonly type: "stopRequested" }
	| { readonly type: "timeoutFired"; readonly id: number }
	| { readonly type: "toolAnswered"; readonly handle: WorkerHandle; readonly callId: number; readonly name: string; readonly ok: boolean; readonly value?: unknown; readonly error?: string };

const WORKER_STOPPED_MESSAGE = "code_mode worker stopped; REPL state was lost";
const BOOT_EXIT_MESSAGE = "code_mode worker exited during boot";

const withJournal = (outcome: ExecOutcome, journal: readonly ToolCallRecord[]): ExecOutcome => {
	if (journal.length === 0) return outcome;
	return { ...outcome, journal };
};

const endOutcome = (msg: Extract<WorkerOutMessage, { type: "end" }>): ExecOutcome => ({
	ok: msg.ok,
	value: msg.value,
	error: msg.error,
	output: msg.output,
	stateLost: false,
});

const workerStoppedOutcome = (journal: readonly ToolCallRecord[] = []): ExecOutcome =>
	withJournal(
		{
			ok: false,
			error: { name: "WorkerError", message: WORKER_STOPPED_MESSAGE },
			output: [],
			stateLost: true,
		},
		journal,
	);

const timeoutOutcome = (active: ActiveExec): ExecOutcome =>
	withJournal(
		{
			ok: false,
			error: {
				name: "TimeoutError",
				message: `script exceeded ${active.exec.timeoutMs} ms and the worker was killed; REPL state was lost — re-set any variables you still need`,
			},
			output: [],
			stateLost: true,
		},
		active.journal,
	);

const bootFailedOutcome = (message: string): ExecOutcome => ({
	ok: false,
	error: { name: "SandboxError", message },
	output: [],
	stateLost: true,
});

const IDLE: LifecycleState = { kind: "idle" };

let handleSeq = 0;
const mintHandle = (): WorkerHandle => {
	handleSeq += 1;
	return { seq: handleSeq };
};

const stay = (state: LifecycleState): StepResult => ({ state, effects: [], settled: [] });

const killEffect = (handle: WorkerHandle): Effect => ({ type: "kill", handle });

const execSend = (handle: WorkerHandle, exec: AcceptedExec): Effect => ({
	type: "send",
	handle,
	message: { type: "exec", id: exec.id, code: exec.code, tools: [...exec.tools] },
});

const timerEffect = (exec: AcceptedExec): Effect => ({ type: "setTimer", id: exec.id, durationMs: exec.timeoutMs });

const drain = (handle: WorkerHandle, queued: readonly AcceptedExec[]): StepResult => {
	if (queued.length === 0) return { state: { kind: "ready", handle }, effects: [], settled: [] };
	const [next, ...rest] = queued;
	const state: LifecycleState = { kind: "running", handle, active: { exec: next, journal: [] }, queued: rest };
	return { state, effects: [execSend(handle, next), timerEffect(next)], settled: [] };
};

const stopRunning = (state: RunningState): SettledExec[] => [
	{ id: state.active.exec.id, outcome: workerStoppedOutcome(state.active.journal) },
	...state.queued.map((exec) => ({ id: exec.id, outcome: workerStoppedOutcome() })),
];

const settleBootFailure = (queued: readonly AcceptedExec[], message: string): StepResult => ({
	state: IDLE,
	effects: [],
	settled: queued.map((exec) => ({ id: exec.id, outcome: bootFailedOutcome(message) })),
});

const retryBoot = (state: BootingState): StepResult => {
	const handle = mintHandle();
	return {
		state: { kind: "booting", attempt: 2, handle, queued: state.queued },
		effects: [{ type: "spawn", handle, flags: "plain" }],
		settled: [],
	};
};

// ---- idle: no worker, no open execs

const stepIdle = (event: LifecycleEvent): StepResult => {
	switch (event.type) {
		case "execRequested": {
			const handle = mintHandle();
			return {
				state: { kind: "booting", attempt: 1, handle, queued: [event.exec] },
				effects: [{ type: "spawn", handle, flags: "permission" }],
				settled: [],
			};
		}
		case "booted":
		case "bootFailed":
		case "workerMessage":
		case "workerDied":
		case "stopRequested":
		case "timeoutFired":
		case "toolAnswered":
			return stay(IDLE);
	}
};

// ---- booting: spawn in flight; accepted execs wait in the queue

const stepBooting = (state: BootingState, event: LifecycleEvent): StepResult => {
	switch (event.type) {
		case "execRequested":
			return stay({ ...state, queued: [...state.queued, event.exec] });
		case "booted":
			return event.handle !== state.handle ? stay(state) : drain(state.handle, state.queued);
		case "bootFailed":
			if (event.handle !== state.handle) return stay(state);
			return state.attempt === 1 ? retryBoot(state) : settleBootFailure(state.queued, event.message);
		case "workerDied":
			// Defensive: the host routes boot failures to bootFailed and emits
			// workerDied only after boot, so this arm should never fire — it keeps
			// the table total and treats a died spawn as a failed boot anyway.
			if (event.handle !== state.handle) return stay(state);
			return state.attempt === 1 ? retryBoot(state) : settleBootFailure(state.queued, BOOT_EXIT_MESSAGE);
		case "stopRequested": {
			const settled = state.queued.map((exec) => ({ id: exec.id, outcome: workerStoppedOutcome() }));
			return { state: IDLE, effects: [killEffect(state.handle)], settled };
		}
		case "workerMessage":
		case "timeoutFired":
		case "toolAnswered":
			return stay(state);
	}
};

// ---- ready: live worker, nothing running

const stepReady = (state: ReadyState, event: LifecycleEvent): StepResult => {
	switch (event.type) {
		case "execRequested": {
			const running: LifecycleState = {
				kind: "running",
				handle: state.handle,
				active: { exec: event.exec, journal: [] },
				queued: [],
			};
			return { state: running, effects: [execSend(state.handle, event.exec), timerEffect(event.exec)], settled: [] };
		}
		case "workerDied":
			// The child is already gone and the host reaped it; nothing to settle or kill.
			return { state: IDLE, effects: [], settled: [] };
		case "stopRequested":
			return { state: IDLE, effects: [killEffect(state.handle)], settled: [] };
		case "booted":
		case "bootFailed":
		case "workerMessage":
		case "timeoutFired":
		case "toolAnswered":
			return stay(state);
	}
};

// ---- running: one active exec, optionally queued behind it

const stepRunning = (state: RunningState, event: LifecycleEvent): StepResult => {
	switch (event.type) {
		case "execRequested":
			return stay({ ...state, queued: [...state.queued, event.exec] });
		case "workerMessage": {
			if (event.handle !== state.handle) return stay(state);
			const msg = event.message;
			if (msg.type === "end") {
				// A late or unknown end is ignored (P4 hygiene); only the active exec's end settles.
				if (msg.id !== state.active.exec.id) return stay(state);
				const drained = drain(state.handle, state.queued);
				return {
					state: drained.state,
					effects: [{ type: "clearTimer", id: msg.id }, ...drained.effects],
					settled: [{ id: msg.id, outcome: endOutcome(msg) }],
				};
			}
			if (msg.type === "toolCall") {
				return {
					state,
					effects: [{ type: "answerTool", handle: state.handle, callId: msg.callId, name: msg.name, args: msg.args }],
					settled: [],
				};
			}
			return stay(state);
		}
		case "toolAnswered": {
			if (event.handle !== state.handle) return stay(state);
			const active: ActiveExec = {
				...state.active,
				journal: [...state.active.journal, { name: event.name, ok: event.ok }],
			};
			const message: WorkerInMessage = event.ok
				? { type: "toolResult", callId: event.callId, ok: true, value: event.value }
				: { type: "toolResult", callId: event.callId, ok: false, error: event.error };
			return { state: { ...state, active }, effects: [{ type: "send", handle: state.handle, message }], settled: [] };
		}
		case "workerDied":
			if (event.handle !== state.handle) return stay(state);
			return {
				state: IDLE,
				effects: [{ type: "clearTimer", id: state.active.exec.id }],
				settled: stopRunning(state),
			};
		case "stopRequested":
			return {
				state: IDLE,
				effects: [{ type: "clearTimer", id: state.active.exec.id }, killEffect(state.handle)],
				settled: stopRunning(state),
			};
		case "timeoutFired": {
			if (event.id !== state.active.exec.id) return stay(state);
			const settled: SettledExec[] = [
				{ id: state.active.exec.id, outcome: timeoutOutcome(state.active) },
				...state.queued.map((exec) => ({ id: exec.id, outcome: workerStoppedOutcome() })),
			];
			return {
				state: IDLE,
				effects: [{ type: "clearTimer", id: state.active.exec.id }, killEffect(state.handle)],
				settled,
			};
		}
		case "booted":
		case "bootFailed":
			return stay(state);
	}
};

/** The total transition table: every state x event pair has exactly one arm. */
export const step = (state: LifecycleState, event: LifecycleEvent): StepResult => {
	switch (state.kind) {
		case "idle":
			return stepIdle(event);
		case "booting":
			return stepBooting(state, event);
		case "ready":
			return stepReady(state, event);
		case "running":
			return stepRunning(state, event);
	}
};
