// gating.ts — the one owner of code_mode session mode.
//
// Settings are external data and are parsed here, at one boundary: the nested
// `codemode.mode` key is the accepted shape; the two observed flat spellings
// ("codemode.mode", "code-mode.mode") produce a loud warning naming the
// nested shape instead of a silent no-op. The mode owner holds the session
// override; buildLoadout turns the resolved mode into what pi renders;
// handleCommand is the pure decision for /code-mode (the adapter applies its
// side effects, so /code-mode off still stops the worker there).
//
// Loaded through jiti from index.ts; the explicit "./protocol.ts" specifier
// also keeps it loadable from plain Node type stripping.

import { DISCOVERY_LISTING, toIdentifier } from "./protocol.ts";

/** The tool the modes steer through. */
export const CODE_MODE_TOOL = "code_mode";

export type CodeMode = "on" | "off" | "only";

/** How the effective mode was decided — what /code-mode status reports. */
export interface ModeResolution {
	readonly mode: CodeMode;
	readonly source: string;
	/** Present when settings carry a flat mode key; the adapter surfaces it loudly. */
	readonly warning?: string;
}

const FLAT_MODE_KEYS = ["codemode.mode", "code-mode.mode"] as const;
const MODES: readonly CodeMode[] = ["on", "off", "only"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The one settings boundary for the mode: nested `codemode.mode` wins; a flat
 * dotted key is ignored loudly (mode falls back to "on") with a warning that
 * names the nested shape. Any other value falls back to "on", as before.
 */
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

/** Effective mode: the session override wins, else the parsed settings. */
export const resolveMode = (override: CodeMode | null, settings: unknown): ModeResolution => {
	const parsed = parseModeSetting(settings);
	if (override !== null) return { mode: override, source: "session override", warning: parsed.warning };
	return parsed;
};

/** Holds the session-scoped override. */
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

/** The slice of a session loadout the mode logic reads. */
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

	// "only": hide direct declarations (they stay active and callable from scripts)
	// and list every callable tool in the code_mode description.
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

/** What the adapter must do for one /code-mode invocation. */
export interface CommandDecision {
	notify: string;
	level: "info" | "warning" | "error";
	/** When set, the adapter applies it as the session override. */
	override?: CodeMode;
	/** When true, the adapter stops the worker (mode went off). */
	stopWorker?: boolean;
}

/** Pure decision for /code-mode on | off | only | status; the adapter side-effects it. */
export const handleCommand = (args: string, current: ModeResolution): CommandDecision => {
	const arg = args.trim().toLowerCase();
	if (arg === "" || arg === "status") {
		return { notify: `code_mode mode: ${current.mode} (${current.source})`, level: "info" };
	}
	if (arg === "on" || arg === "off" || arg === "only") {
		return { notify: `code_mode mode: ${arg}`, level: "info", override: arg, stopWorker: arg === "off" };
	}
	return { notify: `Unknown mode "${args.trim()}". Use: on | off | only | status`, level: "error" };
};
