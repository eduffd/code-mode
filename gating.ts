// gating.ts — the one owner of code_mode session mode.

import { DISCOVERY_LISTING, toIdentifier } from "./protocol.ts";

export const CODE_MODE_TOOL = "code_mode";

export type CodeMode = "on" | "off" | "only";

export interface ModeResolution {
	readonly mode: CodeMode;
	readonly source: string;
	/** Present when settings carry a flat mode key; the adapter surfaces it loudly. */
	readonly warning?: string;
}

const FLAT_MODE_KEYS = ["codemode.mode", "code-mode.mode"] as const;
const MODES: readonly CodeMode[] = ["on", "off", "only"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const parseModeSetting = (settings: unknown): ModeResolution => {
	const record = isRecord(settings) ? settings : {};
	for (const key of FLAT_MODE_KEYS) {
		if (key in record) {
			return {
				mode: "on",
				source: `settings: ${String(record[key])} (flat key ignored)`,
				warning:
					`code_mode: settings has a flat "${key}" key, which is ignored. ` +
					`Write the nested shape instead: {"codemode": {"mode": "on" | "off" | "only"}}.`,
			};
		}
	}
	const setting: unknown = isRecord(record.codemode) ? record.codemode.mode : undefined;
	const mode = MODES.find((m) => m === setting);
	return {
		mode: mode ?? "on",
		source: setting === undefined ? "settings default" : `settings: ${String(setting)}`,
	};
};

export const resolveMode = (override: CodeMode | null, settings: unknown): ModeResolution => {
	const parsed = parseModeSetting(settings);
	if (override !== null) return { mode: override, source: "session override", warning: parsed.warning };
	return parsed;
};

export interface ModeOwner {
	resolve(): ModeResolution;
	/** null clears the override: follow settings again. */
	setOverride(mode: CodeMode | null): void;
}

export const createModeOwner = (getSettings: () => unknown): ModeOwner => {
	let override: CodeMode | null = null;
	return {
		resolve: () => resolveMode(override, getSettings()),
		setOverride: (mode) => {
			override = mode;
		},
	};
};

// ---------------------------------------------------------------- loadout builders

export interface SessionLoadout {
	declared: readonly { name: string; description: string }[];
	callable: readonly { name: string; description: string }[];
}

/** What pi's ToolLoadoutChanges accepts. */
export type LoadoutChanges = { descriptions: Record<string, string>; hiddenDeclarations?: string[] } | undefined;

/** Mode → loadout changes. "off" yields undefined: no annotations, pi keeps every declaration as registered. */
export const buildLoadout = (mode: CodeMode, loadout: SessionLoadout): LoadoutChanges => {
	if (mode === "off") return undefined;
	const callable = loadout.callable.filter((t) => t.name !== CODE_MODE_TOOL);
	const callableNames = new Set(callable.map((t) => t.name));

	if (mode === "on") {
		const descriptions: Record<string, string> = {};
		for (const tool of loadout.declared) {
			if (tool.name !== CODE_MODE_TOOL && callableNames.has(tool.name)) {
				descriptions[tool.name] =
					`${tool.description.trim()}\n\n` +
					`Codemode: prefer running this via code_mode: \`tools.${toIdentifier(tool.name)}(args)\`.`;
			}
		}
		return { descriptions };
	}

	const hiddenDeclarations = loadout.declared
		.filter((t) => t.name !== CODE_MODE_TOOL && callableNames.has(t.name))
		.map((t) => t.name);
	const listing = callable
		.map((t) => `- \`tools.${toIdentifier(t.name)}(args)\`: ${t.description.trim()}`)
		.join("\n");
	const description = [
		"Run JavaScript as a persistent REPL. This session is in code mode: other tools are not declared",
		"to you directly, but every session tool is callable from your script as `await tools.<name>(args)`.",
		"Prefer doing all work here, in one or few scripts, instead of many one-off calls.",
		"",
		"Available tools:",
		listing,
		"",
		"- Top-level declarations persist across calls (declare once; reassign without `const` afterwards).",
		"- `text(s)`, `image(data, mimeType)`, `exit(value)`, captured `console.*`.",
		`- ${DISCOVERY_LISTING} for discovery.`,
		"- Only distilled output enters the conversation; return or `text()` what matters.",
	].join("\n");
	return { descriptions: { [CODE_MODE_TOOL]: description }, hiddenDeclarations };
};

// ---------------------------------------------------------------- /code-mode decision

export interface CommandDecision {
	notify: string;
	level: "info" | "warning" | "error";
	override?: CodeMode;
	stopWorker?: boolean;
	/** status only: the adapter may append what it knows about the worker's REPL state. */
	reportReplState?: true;
}

export const handleCommand = (args: string, current: ModeResolution): CommandDecision => {
	const arg = args.trim().toLowerCase();
	if (arg === "" || arg === "status") {
		return { notify: `code_mode mode: ${current.mode} (${current.source})`, level: "info", reportReplState: true };
	}
	if (arg === "on" || arg === "off" || arg === "only") {
		return { notify: `code_mode mode: ${arg}`, level: "info", override: arg, stopWorker: arg === "off" };
	}
	return { notify: `Unknown mode "${args.trim()}". Use: on | off | only | status`, level: "error" };
};
