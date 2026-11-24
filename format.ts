// format.ts — every result section the model sees from a code_mode call.

import type { ExecOutcome, OutputItem } from "./protocol.ts";

const MAX_TOTAL_CHARS = 20_000;
const HEAD_CHARS = 14_000;
const TAIL_CHARS = 5_000;

/** Cap a script's output for the model. */
export function truncateOutput(items: OutputItem[]): string {
	const parts = items.filter((item) => item.type === "text").map((item) => item.text);
	const full = parts.join("\n");
	if (full.length <= MAX_TOTAL_CHARS) return full;

	const omitted = full.slice(HEAD_CHARS, full.length - TAIL_CHARS);
	const marker = `\n... [head-and-tail omitted ${Buffer.byteLength(omitted)} bytes] ...\n`;
	return full.slice(0, HEAD_CHARS) + marker + full.slice(full.length - TAIL_CHARS);
}

/** The full result text for one settled exec. */
export function formatResult(outcome: ExecOutcome, mode?: "on" | "off" | "only"): string {
	const sections: string[] = [];
	const text = truncateOutput(outcome.output);
	if (text.length > 0) sections.push(text);
	if (outcome.ok) {
		if (outcome.value !== undefined) sections.push(`=> ${outcome.value}`);
	} else {
		const e = outcome.error;
		sections.push(`Error: ${e ? `${e.name}: ${e.message}` : "script failed"}`);
		if (e?.stack) sections.push(e.stack);
		if (outcome.journal && outcome.journal.length > 0) {
			const landed = outcome.journal.map((c) => `${c.name} ${c.ok ? "ok" : "error"}`).join(", ");
			sections.push(`(completed before interruption: ${landed})`);
		}
	}
	if (outcome.stateLost) sections.push("(REPL state was lost)");
	if (outcome.bootFailed && mode === "only") {
		sections.push("The worker never booted; direct session tools remain callable by name (the code_mode tool description lists them).");
	}
	return sections.join("\n") || "(no output; script returned undefined)";
}

type ResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Every image item in a script's output, in script order, each preceded by a label text block. */
function imageBlocks(output: OutputItem[]): ResultBlock[] {
	const images = output.filter((item): item is Extract<OutputItem, { type: "image" }> => item.type === "image");
	const blocks: ResultBlock[] = [];
	images.forEach((item, i) => {
		const bytes = Buffer.from(item.data, "base64").length;
		blocks.push({ type: "text", text: `[Image ${i + 1}/${images.length} (${item.mimeType}, ${bytes} bytes)]` });
		blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
	});
	return blocks;
}

/** The full result content for one settled exec: the text section, then image blocks. */
export function formatResultContent(outcome: ExecOutcome, mode?: "on" | "off" | "only"): ResultBlock[] {
	return [{ type: "text", text: formatResult(outcome, mode) }, ...imageBlocks(outcome.output)];
}
