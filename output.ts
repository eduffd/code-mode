// output.ts — output budget for code_mode script results.

export interface OutputItem {
	type: "text";
	text: string;
	console?: true;
}

const MAX_TOTAL_CHARS = 20_000;
const HEAD_CHARS = 14_000;
const TAIL_CHARS = 5_000;

/**
 * Cap a script's output for the model: join items, head+tail truncate with an
 * elision marker. Returns the display text.
 */
export function truncateOutput(items: OutputItem[]): string {
	const parts = items.map((item) => item.text);
	const full = parts.join("\n");
	if (full.length <= MAX_TOTAL_CHARS) return full;

	const marker = `\n... [${full.length - HEAD_CHARS - TAIL_CHARS} chars truncated; full output spilled to file] ...\n`;
	const head = full.slice(0, HEAD_CHARS);
	const tail = full.slice(full.length - TAIL_CHARS);
	return head + marker + tail;
}
